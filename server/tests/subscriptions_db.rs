use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::sync::Semaphore;
use tower::ServiceExt;
use wien_server::{
    api,
    assistant::tools::{AssistantTools, ToolError},
    auth::{self, Auth},
    config::GenerationConfig,
    providers::{
        ModelOptions, ModelResponse, Provider, ProviderError,
        turn::{TurnRequest, TurnResponse},
    },
    subscriptions::{Reservation, ReserveError},
};

struct ReadyTools;
#[async_trait]
impl AssistantTools for ReadyTools {
    async fn call(&self, name: &str, _: Value) -> Result<Value, ToolError> {
        assert_eq!(name, "strudel_rag_get_corpus_info");
        Ok(json!({"ready": true}))
    }
}

struct Model {
    calls: AtomicUsize,
    fail: AtomicBool,
    block: AtomicBool,
    entered: Semaphore,
    release: Semaphore,
}
impl Model {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            fail: AtomicBool::new(false),
            block: AtomicBool::new(false),
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
        })
    }
}
#[async_trait]
impl Provider for Model {
    async fn send(&self, _: &str, _: &ModelOptions) -> Result<ModelResponse, ProviderError> {
        unreachable!()
    }
    async fn turn(&self, request: &TurnRequest) -> Result<TurnResponse, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.add_permits(1);
        if self.block.load(Ordering::SeqCst) {
            self.release.acquire().await.unwrap().forget();
        }
        if self.fail.load(Ordering::SeqCst) {
            return Err(ProviderError::Timeout);
        }
        Ok(TurnResponse {
            response: ModelResponse {
                id: "test".into(),
                model: request.options.model.clone(),
                text: json!({"message":"Done.","code":null}).to_string(),
                usage: None,
            },
            output: vec![],
            calls: vec![],
        })
    }
}
async fn app(pool: &PgPool, model: Arc<Model>) -> Router {
    api::router_with_database(
        model,
        GenerationConfig::default(),
        Arc::new(ReadyTools),
        Some(pool.clone()),
    )
    .merge(auth::router(Auth::new(pool.clone()).await.unwrap()))
}
fn context() -> Value {
    json!({"prompt":"Softer bass", "file":{"path":"bass.strudel","content":"note('a1')","cursor":{"anchor":0,"head":0}}})
}
async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "wien.aydar.media")
        .header("content-type", "application/json");
    if let Some(token) = token {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 8192).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}
async fn register(app: &Router) -> Value {
    let (status, body) = request(
        app,
        "POST",
        "/auth/register",
        json!({"username":"music_maker","password":"initial secure password"}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["user"]["tier"], "free");
    assert_eq!(body["user"]["assist_requests_remaining"], 10);
    body
}
async fn remaining(pool: &PgPool) -> i32 {
    sqlx::query_scalar("SELECT assist_requests_remaining FROM subscriptions")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn ten_successes_then_upgrade_and_failures_are_free(pool: PgPool) {
    let model = Model::new();
    let app = app(&pool, model.clone()).await;
    let user = register(&app).await;
    let token = user["token"].as_str().unwrap();
    for token in [
        None,
        Some("bad-token"),
        Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ] {
        assert_eq!(
            request(&app, "POST", "/v1/assist", context(), token)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        request(&app, "POST", "/v1/assist", json!({}), Some(token))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(remaining(&pool).await, 10);
    model.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        request(&app, "POST", "/v1/assist", context(), Some(token))
            .await
            .0,
        StatusCode::GATEWAY_TIMEOUT
    );
    assert_eq!(remaining(&pool).await, 10);
    model.fail.store(false, Ordering::SeqCst);
    for expected in (0..10).rev() {
        let (status, body) = request(&app, "POST", "/v1/assist", context(), Some(token)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(remaining(&pool).await, expected);
    }
    let calls = model.calls.load(Ordering::SeqCst);
    let (status, body) = request(&app, "POST", "/v1/assist", context(), Some(token)).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    assert_eq!(body["code"], "assist_quota_exhausted");
    assert_eq!(model.calls.load(Ordering::SeqCst), calls);
    let (_, profile) = request(&app, "GET", "/users/me", Value::Null, Some(token)).await;
    assert_eq!(profile["assist_requests_remaining"], 0);
    assert_eq!(profile["tier"], "free");
    // Clients cannot grant themselves a different plan or allowance.
    assert_eq!(
        request(
            &app,
            "PATCH",
            "/users/me",
            json!({"tier":"ultra","assist_requests_remaining":999}),
            Some(token)
        )
        .await
        .0,
        StatusCode::METHOD_NOT_ALLOWED
    );
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn last_credit_is_shared_between_instances(pool: PgPool) {
    let model = Model::new();
    let first_app = app(&pool, model.clone()).await;
    let second_app = app(&pool, model.clone()).await;
    let user = register(&first_app).await;
    let token = user["token"].as_str().unwrap().to_owned();
    sqlx::query("UPDATE subscriptions SET assist_requests_remaining=1")
        .execute(&pool)
        .await
        .unwrap();
    model.block.store(true, Ordering::SeqCst);
    let first_token = token.clone();
    let pending = tokio::spawn(async move {
        request(
            &first_app,
            "POST",
            "/v1/assist",
            context(),
            Some(&first_token),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), model.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let (status, body) = request(&second_app, "POST", "/v1/assist", context(), Some(&token)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["code"], "assistant_busy");
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    model.release.add_permits(1);
    assert_eq!(pending.await.unwrap().0, StatusCode::OK);
    assert_eq!(remaining(&pool).await, 0);
    assert_eq!(
        request(&second_app, "POST", "/v1/assist", context(), Some(&token))
            .await
            .0,
        StatusCode::PAYMENT_REQUIRED
    );
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn disconnected_request_releases_credit(pool: PgPool) {
    let model = Model::new();
    let app = app(&pool, model.clone()).await;
    let user = register(&app).await;
    let token = user["token"].as_str().unwrap().to_owned();
    let user_id = user["user"]["id"].as_str().unwrap();
    model.block.store(true, Ordering::SeqCst);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let pending = tokio::spawn(async move {
        reqwest::Client::new()
            .post(format!("http://{address}/v1/assist"))
            .bearer_auth(token)
            .json(&context())
            .send()
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), model.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    pending.abort();
    let _ = pending.await;
    let released = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            match Reservation::begin(&pool, user_id).await {
                Ok(reservation) => {
                    drop(reservation);
                    break;
                }
                Err(ReserveError::Busy) => {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await
                }
                Err(error) => panic!("Unexpected reservation error: {error:?}"),
            }
        }
    })
    .await;
    server.abort();
    assert!(
        released.is_ok(),
        "Disconnect did not cancel the model handler"
    );
    assert_eq!(remaining(&pool).await, 10);
}

#[sqlx::test(migrations = false)]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn existing_accounts_receive_allowance_once(pool: PgPool) {
    sqlx::raw_sql(include_str!("../migrations/202611120001_accounts.sql"))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO users (username,password_hash) VALUES ('existing_user','unused hash')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!("../migrations/202611120002_subscriptions.sql"))
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(remaining(&pool).await, 10);
    let tier: String = sqlx::query_scalar("SELECT tier FROM subscriptions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(tier, "free");
    // An older server can still register users after a rollback.
    sqlx::query("INSERT INTO users (username,password_hash) VALUES ('registered_after_rollback','unused hash')").execute(&pool).await.unwrap();
    let grants: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM subscriptions WHERE tier='free' AND assist_requests_remaining=10",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(grants, 2);
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn cookie_assist_enforces_origin_and_consumes_one_credit(pool: PgPool) {
    let model = Model::new();
    let app = app(&pool, model.clone()).await;
    let user = register(&app).await;
    let token = user["token"].as_str().unwrap();
    for (origin, expected) in [
        ("https://other.aydar.media", StatusCode::FORBIDDEN),
        ("https://wien.aydar.media", StatusCode::OK),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/assist")
                    .header("host", "wien.aydar.media")
                    .header("origin", origin)
                    .header("x-wien-session", "cookie")
                    .header("cookie", format!("__Host-wien_session={token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(context().to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        // Consume the body so completion accounting is exercised.
        to_bytes(response.into_body(), 8192).await.unwrap();
    }
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    assert_eq!(remaining(&pool).await, 9);
}
