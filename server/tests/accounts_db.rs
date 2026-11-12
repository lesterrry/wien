use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use wien_server::auth::{self, Auth};

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 8192).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn register(app: &Router, name: &str) -> Value {
    let (status, body) = request(
        app,
        "POST",
        "/auth/register",
        json!({"username":name,"password":"initial secure password"}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn lifecycle_and_password_rotation(pool: PgPool) {
    let app = auth::router(Auth::new(pool.clone()).await.unwrap());
    let first = register(&app, "music_maker").await;
    let token = first["token"].as_str().unwrap();
    assert!(first["user"].get("password_hash").is_none());
    let hash: String =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE username='music_maker'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(hash.starts_with("$argon2id$"));
    let stored: Vec<u8> = sqlx::query_scalar("SELECT token_hash FROM sessions LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_ne!(stored, token.as_bytes());
    assert_eq!(stored.len(), 32);
    let (_, profile) = request(&app, "GET", "/users/me", Value::Null, Some(token)).await;
    assert_eq!(profile, first["user"]);
    assert_eq!(
        request(&app, "GET", "/users/me", Value::Null, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&app, "GET", "/users/me", Value::Null, Some(&"0".repeat(64)))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (_, second) = request(
        &app,
        "POST",
        "/auth/login",
        json!({"username":"music_maker","password":"initial secure password"}),
        None,
    )
    .await;
    let (status,changed)=request(&app,"POST","/users/me/password",json!({"current_password":"initial secure password","new_password":"replacement secure password"}),Some(token)).await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    for old in [token, second["token"].as_str().unwrap()] {
        assert_eq!(
            request(&app, "GET", "/users/me", Value::Null, Some(old))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        request(
            &app,
            "POST",
            "/auth/login",
            json!({"username":"music_maker","password":"initial secure password"}),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let new_token = changed["token"].as_str().unwrap();
    assert_eq!(
        request(&app, "GET", "/users/me", Value::Null, Some(new_token))
            .await
            .0,
        StatusCode::OK
    );
    let other = register(&app, "another_user").await;
    assert_ne!(other["user"]["id"], profile["id"]);
    assert_eq!(
        request(&app, "POST", "/auth/logout", Value::Null, Some(new_token))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&app, "GET", "/users/me", Value::Null, Some(new_token))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/users/me",
            Value::Null,
            Some(other["token"].as_str().unwrap())
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, fresh) = request(
        &app,
        "POST",
        "/auth/login",
        json!({"username":"music_maker","password":"replacement secure password"}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    sqlx::query("UPDATE sessions SET expires_at=now()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            "GET",
            "/users/me",
            Value::Null,
            Some(fresh["token"].as_str().unwrap())
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn validation_conflicts_and_brute_force_limit(pool: PgPool) {
    let app = auth::router(Auth::new(pool.clone()).await.unwrap());
    for username in ["UPPERCASE", "has space", "кириллица", "ab", &"a".repeat(33)] {
        assert_eq!(
            request(
                &app,
                "POST",
                "/auth/register",
                json!({"username":username,"password":"initial secure password"}),
                None
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        request(
            &app,
            "POST",
            "/auth/register",
            json!({"username":"test_user","password":"short"}),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let first = register(&app, "test_user").await;
    assert_eq!(
        request(
            &app,
            "POST",
            "/auth/register",
            json!({"username":"test_user","password":"initial secure password"}),
            None
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let failed=request(&app,"POST","/users/me/password",json!({"current_password":"incorrect password","new_password":"replacement secure password"}),Some(first["token"].as_str().unwrap())).await;
    assert_eq!(failed.0, StatusCode::UNAUTHORIZED);
    assert_eq!(
        request(
            &app,
            "GET",
            "/users/me",
            Value::Null,
            Some(first["token"].as_str().unwrap())
        )
        .await
        .0,
        StatusCode::OK
    );
    for _ in 0..10 {
        let (status, body) = request(
            &app,
            "POST",
            "/auth/login",
            json!({"username":"test_user","password":"incorrect password"}),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    }
    // The counter persists across API instances/restarts and also limits valid attempts.
    let restarted = auth::router(Auth::new(pool).await.unwrap());
    assert_eq!(
        request(
            &restarted,
            "POST",
            "/auth/login",
            json!({"username":"test_user","password":"initial secure password"}),
            None
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn concurrent_registration_has_one_owner(pool: PgPool) {
    let app = auth::router(Auth::new(pool.clone()).await.unwrap());
    let data = json!({"username":"unique_owner","password":"initial secure password"});
    let (a, b) = tokio::join!(
        request(&app, "POST", "/auth/register", data.clone(), None),
        request(&app, "POST", "/auth/register", data, None)
    );
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [201, 409]);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
