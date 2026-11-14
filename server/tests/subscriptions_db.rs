mod common;
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
    auth::{self},
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
    async fn audio(&self, prompt: &str, _: &str) -> Result<String, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.add_permits(1);
        if self.block.load(Ordering::SeqCst) {
            self.release.acquire().await.unwrap().forget();
        }
        if prompt.contains("Previous reconstruction") {
            if self.fail.load(Ordering::SeqCst) {
                return Err(ProviderError::Timeout);
            }
            Ok(json!({"message":"Audio ready", "code":"note('a4').s('sine')"}).to_string())
        } else {
            Ok(json!({"bpm":120,"notes":[],"code":"note('a4')"}).to_string())
        }
    }

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
    .merge(auth::router(common::auth(pool.clone()).await))
}
fn context() -> Value {
    json!({"prompt":"Softer bass", "file":{"path":"bass.strudel","content":"note('a1')","cursor":{"anchor":0,"head":0}}})
}
async fn request(
    app: &Router,
    method: &str,
    path: &str,
    mut body: Value,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if path == "/auth/register" {
        body["turnstile_token"] = json!("test-token");
        req = req
            .header("host", "wien.aydar.media")
            .header("origin", "https://wien.aydar.media")
            .header("x-wien-session", "cookie");
    }
    if let Some(token) = token {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let registration_token = response
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .and_then(|v| v.split_once('='))
        .map(|(_, v)| v.to_owned());
    let status = response.status();
    let body = to_bytes(response.into_body(), 8192).await.unwrap();
    let mut result: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    if let Some(token) = registration_token {
        result["token"] = json!(token);
    }
    (status, result)
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
async fn paid_tiers_ignore_free_allowance_and_keep_usage_counts(pool: PgPool) {
    let model = Model::new();
    let app = app(&pool, model.clone()).await;
    let user = register(&app).await;
    let token = user["token"].as_str().unwrap();
    let mut used = 0_i64;
    for tier in ["plus", "pro", "ultra"] {
        for allowance in [0, 2] {
            sqlx::query("UPDATE subscriptions SET tier=$1,assist_requests_remaining=$2")
                .bind(tier)
                .bind(allowance)
                .execute(&pool)
                .await
                .unwrap();
            let (status, body) = request(&app, "POST", "/v1/assist", context(), Some(token)).await;
            assert_eq!(status, StatusCode::OK, "{tier}: {body}");
            used += 1;
            assert_eq!(remaining(&pool).await, allowance);
            let counts: (i64, i64) = sqlx::query_as(
                "SELECT assist_requests_used,audio_requests_used FROM subscriptions",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(counts, (used, 0));
        }
    }
    sqlx::query("UPDATE subscriptions SET tier='free',assist_requests_remaining=0")
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = request(&app, "POST", "/v1/assist", context(), Some(token)).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    assert_eq!(body["code"], "assist_quota_exhausted");
    assert_eq!(model.calls.load(Ordering::SeqCst), used as usize);
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

fn audio_context() -> Value {
    use base64::Engine;
    let mut bytes = std::io::Cursor::new(Vec::new());
    {
        let mut wav = hound::WavWriter::new(
            &mut bytes,
            hound::WavSpec {
                channels: 1,
                sample_rate: 24000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for i in 0..240000 {
            wav.write_sample(((i as f32 * 0.1).sin() * 1000.0) as i16)
                .unwrap();
        }
        wav.finalize().unwrap();
    }
    let mut body = context();
    body["prompt"] = json!(""); // Attachment alone is sufficient.
    body["audio"] =
        json!({"wav_base64":base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())});
    body
}
async fn audio_used(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT audio_requests_used FROM subscriptions")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn audio_has_separate_usage_and_two_passes_count_once(pool: PgPool) {
    let model = Model::new();
    let app = app(&pool, model.clone()).await;
    let user = register(&app).await;
    let token = user["token"].as_str().unwrap();
    assert_eq!(user["user"]["audio_requests_used"], 0);
    let (status, body) = request(&app, "POST", "/v1/assist", audio_context(), Some(token)).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    assert_eq!(body["code"], "audio_requires_plan");
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
    sqlx::query("UPDATE subscriptions SET tier='plus',assist_requests_remaining=0")
        .execute(&pool)
        .await
        .unwrap();
    let mut turbo = audio_context();
    turbo["turbo"] = json!(true);
    assert_eq!(
        request(&app, "POST", "/v1/assist", turbo, Some(token))
            .await
            .1["code"],
        "audio_turbo_unavailable"
    );
    let mut invalid = audio_context();
    invalid["audio"]["wav_base64"] = json!("invalid");
    assert_eq!(
        request(&app, "POST", "/v1/assist", invalid, Some(token))
            .await
            .1["code"],
        "invalid_audio"
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
    model.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        request(&app, "POST", "/v1/assist", audio_context(), Some(token))
            .await
            .0,
        StatusCode::GATEWAY_TIMEOUT
    );
    assert_eq!(audio_used(&pool).await, 0);
    model.fail.store(false, Ordering::SeqCst);
    for expected in [1, 2] {
        let before = model.calls.load(Ordering::SeqCst);
        let (status, body) =
            request(&app, "POST", "/v1/assist", audio_context(), Some(token)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(model.calls.load(Ordering::SeqCst) - before, 2);
        assert_eq!(audio_used(&pool).await, expected);
        assert_eq!(remaining(&pool).await, 0);
    }
    sqlx::query("UPDATE subscriptions SET assist_requests_remaining=1")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(&app, "POST", "/v1/assist", context(), Some(token))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(audio_used(&pool).await, 2);
    assert_eq!(remaining(&pool).await, 1);
    let text_used: i64 = sqlx::query_scalar("SELECT assist_requests_used FROM subscriptions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(text_used, 1);
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn catalog_is_public_ordered_and_uses_live_database_values(pool: PgPool) {
    let app = app(&pool, Model::new()).await;
    let (status, catalog) = request(&app, "GET", "/v1/plans", Value::Null, None).await;
    assert_eq!(status, StatusCode::OK);
    let plans = catalog.as_array().unwrap();
    assert_eq!(
        plans
            .iter()
            .map(|p| p["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["free", "plus", "pro", "ultra"]
    );
    assert_eq!(plans[1]["price_minor"], 19900);
    assert_eq!(plans[1]["currency"], "RUB");
    assert_eq!(plans[1]["initial_assist_requests"], Value::Null);
    sqlx::query("UPDATE plans SET visible=false WHERE id='plus'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE plans SET name='Studio',description='Updated description',price_minor=12345,currency='USD',billing_period='year',display_order=-1 WHERE id='pro'").execute(&pool).await.unwrap();
    let (_, catalog) = request(&app, "GET", "/v1/plans", Value::Null, None).await;
    assert_eq!(catalog.as_array().unwrap().len(), 3);
    assert_eq!(catalog[0]["name"], "Studio");
    assert_eq!(catalog[0]["description"], "Updated description");
    assert_eq!(catalog[0]["price_minor"], 12345);
    assert_eq!(catalog[0]["currency"], "USD");
    assert_eq!(catalog[0]["billing_period"], "year");
    assert!(catalog[0].get("visible").is_none());
    let user = register(&app).await;
    sqlx::query("UPDATE subscriptions SET tier='plus'")
        .execute(&pool)
        .await
        .unwrap();
    let (_, profile) = request(
        &app,
        "GET",
        "/users/me",
        Value::Null,
        user["token"].as_str(),
    )
    .await;
    assert_eq!(
        profile["plan"]["id"], "plus",
        "Hidden plans still resolve for existing subscribers"
    );
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn custom_plan_controls_registration_and_access_without_code_changes(pool: PgPool) {
    sqlx::query("UPDATE plans SET is_default=false WHERE is_default")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO plans (id,name,description,price_minor,currency,billing_period,initial_assist_requests,audio_enabled,is_default) VALUES ('trial','Trial','Custom default',0,'EUR','none',2,true,true)").execute(&pool).await.unwrap();
    let user_id: String = sqlx::query_scalar("INSERT INTO users (username,password_hash) VALUES ('custom_user','unused') RETURNING id::text").fetch_one(&pool).await.unwrap();
    let subscription = wien_server::subscriptions::get(&pool, &user_id)
        .await
        .unwrap();
    assert_eq!(subscription.tier, "trial");
    assert_eq!(subscription.assist_requests_remaining, 2);
    Reservation::begin_request(&pool, &user_id, true)
        .await
        .unwrap()
        .commit()
        .await
        .unwrap();
    assert_eq!(remaining(&pool).await, 2);
    for _ in 0..2 {
        Reservation::begin(&pool, &user_id)
            .await
            .unwrap()
            .commit()
            .await
            .unwrap();
    }
    assert!(matches!(
        Reservation::begin(&pool, &user_id).await,
        Err(ReserveError::Exhausted)
    ));
    sqlx::query(
        "UPDATE plans SET initial_assist_requests=NULL,audio_enabled=false WHERE id='trial'",
    )
    .execute(&pool)
    .await
    .unwrap();
    Reservation::begin(&pool, &user_id)
        .await
        .unwrap()
        .commit()
        .await
        .unwrap();
    assert!(matches!(
        Reservation::begin_request(&pool, &user_id, true).await,
        Err(ReserveError::AudioRequiresPlan)
    ));
    assert!(
        sqlx::query("UPDATE subscriptions SET tier='missing'")
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE plans SET is_default=true WHERE id='free'")
            .execute(&pool)
            .await
            .is_err()
    );
}

#[sqlx::test(migrations = false)]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn catalog_migration_preserves_existing_tiers_balances_and_usage(pool: PgPool) {
    for migration in [
        include_str!("../migrations/202611120001_accounts.sql"),
        include_str!("../migrations/202611120002_subscriptions.sql"),
        include_str!("../migrations/202611140001_audio_requests.sql"),
    ] {
        sqlx::raw_sql(migration).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO users (username,password_hash) VALUES ('existing_user','unused')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE subscriptions SET tier='pro',assist_requests_remaining=3,assist_requests_used=7,audio_requests_used=2").execute(&pool).await.unwrap();
    sqlx::raw_sql(include_str!("../migrations/202611150001_plan_catalog.sql"))
        .execute(&pool)
        .await
        .unwrap();
    let before: (String,i32,i64,i64) = sqlx::query_as("SELECT tier,assist_requests_remaining,assist_requests_used,audio_requests_used FROM subscriptions").fetch_one(&pool).await.unwrap();
    assert_eq!(before, ("pro".into(), 3, 7, 2));
    sqlx::query("UPDATE plans SET initial_assist_requests=25 WHERE is_default")
        .execute(&pool)
        .await
        .unwrap();
    let id: String = sqlx::query_scalar("INSERT INTO users (username,password_hash) VALUES ('new_user','unused') RETURNING id::text").fetch_one(&pool).await.unwrap();
    let subscription = wien_server::subscriptions::get(&pool, &id).await.unwrap();
    assert_eq!(subscription.tier, "free");
    assert_eq!(subscription.assist_requests_remaining, 25);
}
