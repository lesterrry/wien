mod common;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use wien_server::auth::{self};

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn registration_requires_browser_captcha_and_configured_verifier(pool: PgPool) {
    for (browser, configured, captcha, expected) in [
        (false, true, true, StatusCode::FORBIDDEN),
        (true, true, false, StatusCode::BAD_REQUEST),
        (true, false, true, StatusCode::SERVICE_UNAVAILABLE),
    ] {
        let auth = if configured {
            common::auth(pool.clone()).await
        } else {
            auth::Auth::new(pool.clone()).await.unwrap()
        };
        let app = auth::router(auth);
        let mut data = json!({"username":"guarded_user","password":"initial secure password"});
        if captcha {
            data["turnstile_token"] = json!("test-token");
        }
        let mut request = Request::builder()
            .method("POST")
            .uri("/auth/register")
            .header("content-type", "application/json");
        if browser {
            request = request
                .header("host", "wien.aydar.media")
                .header("origin", "https://wien.aydar.media")
                .header("x-wien-session", "cookie");
        }
        let response = app
            .oneshot(request.body(Body::from(data.to_string())).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    mut body: Value,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if path == "/auth/register" {
        body["turnstile_token"] = json!("test-token");
        builder = builder
            .header("host", "wien.aydar.media")
            .header("origin", "https://wien.aydar.media")
            .header("x-wien-session", "cookie");
    }
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let registration_token = response
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .and_then(|v| v.split_once('='))
        .map(|(_, v)| v.to_owned());
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 8192).await.unwrap();
    let mut result: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if let Some(token) = registration_token {
        result["token"] = json!(token);
    }
    (status, result)
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
    let app = auth::router(common::auth(pool.clone()).await);
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
    let app = auth::router(common::auth(pool.clone()).await);
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
    let restarted = auth::router(common::auth(pool).await);
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
    let app = auth::router(common::auth(pool.clone()).await);
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

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn browser_cookie_lifecycle_and_cross_origin_rejection(pool: PgPool) {
    let app = auth::router(common::auth(pool.clone()).await);
    async fn web(
        app: &Router,
        method: &str,
        path: &str,
        mut body: Value,
        cookie: &str,
        origin: &str,
    ) -> (StatusCode, String, Value) {
        if path == "/auth/register" {
            body["turnstile_token"] = json!("test-token");
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("host", "wien.aydar.media")
                    .header("origin", origin)
                    .header("x-wien-session", "cookie")
                    .header("content-type", "application/json")
                    .header("cookie", cookie)
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let cookie = response
            .headers()
            .get("set-cookie")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let bytes = to_bytes(response.into_body(), 8192).await.unwrap();
        (
            status,
            cookie,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    let origin = "https://wien.aydar.media";
    let credentials = json!({"username":"browser_user","password":"initial secure password"});
    let (status, _, _) = web(
        &app,
        "POST",
        "/auth/register",
        credentials.clone(),
        "",
        "https://other.aydar.media",
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, cookie, body) = web(
        &app,
        "POST",
        "/auth/register",
        credentials.clone(),
        "",
        origin,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert!(body.get("token").is_none());
    for attr in [
        "__Host-wien_session=",
        "HttpOnly",
        "Secure",
        "SameSite=Strict",
        "Path=/",
        "Max-Age=2592000",
    ] {
        assert!(cookie.contains(attr), "{cookie}");
    }
    let cookie = cookie.split(';').next().unwrap();
    assert_eq!(
        web(&app, "GET", "/users/me", Value::Null, cookie, origin)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        web(
            &app,
            "GET",
            "/users/me",
            Value::Null,
            cookie,
            "https://other.aydar.media"
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, rotated, _) = web(&app,"POST","/users/me/password",json!({"current_password":"initial secure password","new_password":"another secure password"}),cookie,origin).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        web(&app, "GET", "/users/me", Value::Null, cookie, origin)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let rotated = rotated.split(';').next().unwrap();
    assert_eq!(
        web(&app, "GET", "/users/me", Value::Null, rotated, origin)
            .await
            .0,
        StatusCode::OK
    );
    let (status, cleared, _) =
        web(&app, "POST", "/auth/logout", Value::Null, rotated, origin).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(cleared.contains("Max-Age=0"));
    assert_eq!(
        web(&app, "GET", "/users/me", Value::Null, rotated, origin)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (_, cookie, body) = web(
        &app,
        "POST",
        "/auth/login",
        json!({"username":"browser_user","password":"another secure password"}),
        "",
        origin,
    )
    .await;
    assert!(body.get("token").is_none());
    let cookie = cookie.split(';').next().unwrap();
    // Expired cookies cannot restore a browser session.
    sqlx::query("UPDATE sessions SET expires_at=now()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        web(&app, "GET", "/users/me", Value::Null, cookie, origin)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}
