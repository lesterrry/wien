mod common;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tower::ServiceExt;
use wien_server::{
    auth,
    payments::{self, Payments},
    robokassa::Config,
    subscriptions::Reservation,
};
const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PASSWORD2: &str = "local-test-second-password";
async fn setup(pool: &PgPool, enabled: bool) -> Router {
    for (username, token) in [("payment_tester", TOKEN), ("other_user", OTHER)] {
        let id: String = sqlx::query_scalar(
            "INSERT INTO users(username,password_hash) VALUES($1,'unused') RETURNING id::text",
        )
        .bind(username)
        .fetch_one(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2::uuid,now()+interval '1 day')").bind(Sha256::digest(token).to_vec()).bind(id).execute(pool).await.unwrap();
    }
    let config = enabled.then(|| {
        Config::new(
            wien_server::payments::Mode::Test,
            "WienTest".into(),
            "local-test-first-password".into(),
            PASSWORD2.into(),
            ["payment_tester".to_owned()].into(),
        )
        .unwrap()
    });
    payments::router(Payments::new(pool.clone(), config))
        .merge(auth::router(common::auth(pool.clone()).await))
}
async fn send(app: &Router, request: Request<Body>) -> (StatusCode, String) {
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
    let status = response.status();
    let text = String::from_utf8(
        to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    (status, text)
}
async fn api(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    token: &str,
) -> (StatusCode, Value) {
    let (status, text) = send(
        app,
        Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::from(body.to_string()))
            .unwrap(),
    )
    .await;
    (status, serde_json::from_str(&text).unwrap())
}
async fn purchase(pool: &PgPool, n: u32) -> Value {
    let version: String = sqlx::query_scalar("SELECT document_version FROM storefront")
        .fetch_one(pool)
        .await
        .unwrap();
    json!({"request_id":format!("00000000-0000-4000-8000-{n:012}"),"plan_id":"plus","document_version":version,"price_minor":39900,"request_limit":500,"accepted":true})
}
async fn create(app: &Router, pool: &PgPool, n: u32) -> Value {
    let (status, order) = api(
        app,
        "POST",
        "/v1/payments/orders",
        purchase(pool, n).await,
        TOKEN,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{order}");
    order
}
fn form(order: &Value, amount: &str, password: &str) -> String {
    let id = order["id"].as_str().unwrap();
    let invoice = order["invoice_id"].as_str().unwrap();
    let mode = if order["is_test"] == true {
        "test"
    } else {
        "live"
    };
    let signature = format!(
        "{:x}",
        Sha256::digest(format!(
            "{amount}:{invoice}:{password}:Shp_mode={mode}:Shp_order={id}"
        ))
    );
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("OutSum", amount),
            ("InvId", invoice),
            ("Shp_mode", mode),
            ("Shp_order", id),
            ("SignatureValue", &signature),
        ])
        .finish()
}
async fn notify(app: &Router, body: String) -> (StatusCode, String) {
    send(
        app,
        Request::post("/v1/payments/robokassa/result")
            .header("content-type", "application/x-www-form-urlencoded")
            .body(Body::from(body))
            .unwrap(),
    )
    .await
}
async fn quota(pool: &PgPool) -> i32 {
    sqlx::query_scalar("SELECT assist_requests_remaining FROM subscriptions JOIN users ON users.id=user_id WHERE username='payment_tester'").fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn disabled_and_ownership_and_cookie_origin_are_enforced(pool: PgPool) {
    let app = setup(&pool, false).await;
    assert_eq!(
        api(
            &app,
            "POST",
            "/v1/payments/orders",
            purchase(&pool, 1).await,
            TOKEN
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        api(&app, "GET", "/v1/payments/orders", Value::Null, "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        notify(&app, "".into()).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let config = Config::new(
        wien_server::payments::Mode::Test,
        "WienTest".into(),
        "local-test-first-password".into(),
        PASSWORD2.into(),
        ["payment_tester".to_owned()].into(),
    )
    .unwrap();
    let app = payments::router(Payments::new(pool.clone(), Some(config)));
    assert_eq!(
        api(
            &app,
            "POST",
            "/v1/payments/orders",
            purchase(&pool, 1).await,
            OTHER
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let order = create(&app, &pool, 1).await;
    let path = format!("/v1/payments/orders/{}", order["id"].as_str().unwrap());
    assert_eq!(
        api(&app, "GET", &path, Value::Null, OTHER).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        api(&app, "POST", &format!("{path}/cancel"), Value::Null, OTHER)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        api(&app, "GET", "/v1/payments/orders", Value::Null, OTHER)
            .await
            .1,
        json!([])
    );
    let (status, _) = send(
        &app,
        Request::post(format!("{path}/cancel"))
            .header("host", "wien.example")
            .header("origin", "https://evil.example")
            .header("x-wien-session", "cookie")
            .header("cookie", format!("__Host-wien_session={TOKEN}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, cookie_order) = send(
        &app,
        Request::get(&path)
            .header("host", "wien.example")
            .header("sec-fetch-site", "same-origin")
            .header("x-wien-session", "cookie")
            .header("cookie", format!("__Host-wien_session={TOKEN}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(
        serde_json::from_str::<Value>(&cookie_order).unwrap()["id"],
        order["id"]
    );
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn stale_terms_idempotency_and_concurrent_orders(pool: PgPool) {
    let app = setup(&pool, true).await;
    for (key, value, status) in [
        ("price_minor", json!(1), StatusCode::CONFLICT),
        ("request_limit", json!(1), StatusCode::CONFLICT),
        ("document_version", json!("old"), StatusCode::CONFLICT),
        ("request_id", json!("bad"), StatusCode::BAD_REQUEST),
        ("is_test", json!(false), StatusCode::BAD_REQUEST),
        ("plan_id", json!("free"), StatusCode::BAD_REQUEST),
    ] {
        let mut body = purchase(&pool, 1).await;
        body[key] = value;
        assert_eq!(
            api(&app, "POST", "/v1/payments/orders", body, TOKEN)
                .await
                .0,
            status,
            "{key}"
        );
    }
    let body = purchase(&pool, 1).await;
    let (a, b) = tokio::join!(
        api(&app, "POST", "/v1/payments/orders", body.clone(), TOKEN),
        api(&app, "POST", "/v1/payments/orders", body.clone(), TOKEN)
    );
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(a, b);
    let mut changed = body;
    changed["price_minor"] = json!(123);
    assert_eq!(
        api(&app, "POST", "/v1/payments/orders", changed, TOKEN)
            .await
            .1["code"],
        "order_request_conflict"
    );
    assert_eq!(
        api(
            &app,
            "POST",
            "/v1/payments/orders",
            purchase(&pool, 2).await,
            TOKEN
        )
        .await
        .1["code"],
        "order_pending"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM payment_orders")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let purchased: (i64, i32, bool, String) = sqlx::query_as(
        "SELECT price_minor,request_limit,audio_enabled,document_version FROM payment_orders",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        purchased,
        (
            39900,
            500,
            true,
            a.1["document_version"].as_str().unwrap().to_owned()
        )
    );
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn order_returns_payment_url_without_client_consent(pool: PgPool) {
    let app = setup(&pool, true).await;
    let mut request = purchase(&pool, 90).await;
    request.as_object_mut().unwrap().remove("accepted");
    let (status, order) = api(&app, "POST", "/v1/payments/orders", request.clone(), TOKEN).await;
    assert_eq!(status, StatusCode::OK);
    assert!(order["checkout_url"].as_str().unwrap().contains("IsTest=1"));
    assert_eq!(order["status"], "pending");
    assert_eq!(quota(&pool).await, 10);
    // Older clients can still submit the field; its value does not affect the order.
    request["accepted"] = json!(false);
    let (_, again) = api(&app, "POST", "/v1/payments/orders", request, TOKEN).await;
    assert_eq!(again["id"], order["id"]);
    assert_eq!(
        notify(&app, form(&order, "399.00", PASSWORD2)).await.0,
        StatusCode::OK
    );
    assert_eq!(quota(&pool).await, 500);
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn callbacks_require_proof_and_grant_purchased_allowance_exactly_once(pool: PgPool) {
    let app = setup(&pool, true).await;
    let order = create(&app, &pool, 1).await;
    for body in [
        form(&order, "399.00", "wrong-secret"),
        form(&order, "1.00", PASSWORD2),
        format!("{}&OutSum=399.00", form(&order, "399.00", PASSWORD2)),
        form(&order, "399.001", PASSWORD2),
        form(&order, "399.00", PASSWORD2).replace("Shp_mode=test", "Shp_mode=live"),
    ] {
        assert_eq!(notify(&app, body).await.0, StatusCode::BAD_REQUEST);
    }
    for route in ["success", "fail"] {
        let response = app
            .clone()
            .oneshot(
                Request::get(format!(
                    "/v1/payments/robokassa/{route}?Shp_order={}",
                    order["id"].as_str().unwrap()
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            response.headers()["location"],
            format!("/?payment={}", order["id"].as_str().unwrap())
        );
    }
    assert_eq!(quota(&pool).await, 10);
    sqlx::query("UPDATE plans SET price_minor=99900,initial_assist_requests=1,audio_enabled=false,visible=false WHERE id='plus'").execute(&pool).await.unwrap();
    let body = form(&order, "399.000000", PASSWORD2);
    let (a, b) = tokio::join!(notify(&app, body.clone()), notify(&app, body.clone()));
    assert_eq!(
        a,
        (
            StatusCode::OK,
            format!("OK{}", order["invoice_id"].as_str().unwrap())
        )
    );
    assert_eq!(a, b);
    assert_eq!(quota(&pool).await, 500);
    let id: String =
        sqlx::query_scalar("SELECT id::text FROM users WHERE username='payment_tester'")
            .fetch_one(&pool)
            .await
            .unwrap();
    Reservation::begin_request(&pool, &id, true)
        .await
        .unwrap()
        .commit()
        .await
        .unwrap();
    assert_eq!(quota(&pool).await, 499);
    let (_, profile) = api(&app, "GET", "/users/me", Value::Null, TOKEN).await;
    assert_eq!(profile["plan"]["initial_assist_requests"], 500);
    assert_eq!(profile["plan"]["audio_enabled"], true);
    assert!(profile["subscription_expires_at"].is_string());
    let paid = api(
        &app,
        "GET",
        &format!("/v1/payments/orders/{}", order["id"].as_str().unwrap()),
        Value::Null,
        TOKEN,
    )
    .await
    .1;
    assert_eq!(paid["status"], "paid");
    assert_eq!(paid["checkout_url"], Value::Null);
    assert_eq!(notify(&app, body).await.0, StatusCode::OK);
    assert_eq!(quota(&pool).await, 499);
    let again = api(
        &app,
        "POST",
        &format!(
            "/v1/payments/orders/{}/cancel",
            order["id"].as_str().unwrap()
        ),
        Value::Null,
        TOKEN,
    )
    .await
    .1;
    assert_eq!(again, paid);
    assert_eq!(
        api(
            &app,
            "POST",
            "/v1/payments/orders",
            purchase(&pool, 2).await,
            TOKEN
        )
        .await
        .1["code"],
        "subscription_active"
    );
    sqlx::query(
        "UPDATE subscriptions SET period_ends_at=now()-interval '1 second' WHERE user_id=$1::uuid",
    )
    .bind(&id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE plans SET price_minor=39900,initial_assist_requests=500,visible=true WHERE id='plus'").execute(&pool).await.unwrap();
    assert_ne!(create(&app, &pool, 2).await["id"], order["id"]);
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn cancelled_late_payments_are_recorded_without_overwriting_access(pool: PgPool) {
    let app = setup(&pool, true).await;
    let old = create(&app, &pool, 1).await;
    let path = format!("/v1/payments/orders/{}/cancel", old["id"].as_str().unwrap());
    assert_eq!(
        api(&app, "POST", &path, Value::Null, TOKEN).await.1["status"],
        "cancelled"
    );
    let current = create(&app, &pool, 2).await;
    assert_eq!(
        notify(&app, form(&old, "399.00", PASSWORD2)).await.0,
        StatusCode::OK
    );
    assert_eq!(quota(&pool).await, 10);
    assert_eq!(
        api(&app, "POST", &path, Value::Null, TOKEN).await.1["status"],
        "paid_review"
    );
    assert_eq!(
        notify(&app, form(&current, "399.00", PASSWORD2)).await.0,
        StatusCode::OK
    );
    sqlx::query("UPDATE subscriptions SET assist_requests_remaining=42 WHERE tier='plus'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        notify(&app, form(&old, "399.00", PASSWORD2)).await.0,
        StatusCode::OK
    );
    assert_eq!(quota(&pool).await, 42);
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn failed_fulfillment_rolls_back_and_callback_can_retry(pool: PgPool) {
    let app = setup(&pool, true).await;
    let order = create(&app, &pool, 1).await;
    sqlx::raw_sql("CREATE FUNCTION reject_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER reject_activation BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION reject_activation();").execute(&pool).await.unwrap();
    assert_eq!(
        notify(&app, form(&order, "399.00", PASSWORD2)).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(quota(&pool).await, 10);
    let status: String = sqlx::query_scalar("SELECT status FROM payment_orders")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "pending");
    sqlx::query("DROP TRIGGER reject_activation ON subscriptions")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        notify(&app, form(&order, "399.00", PASSWORD2)).await.0,
        StatusCode::OK
    );
    assert_eq!(quota(&pool).await, 500);
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn abandoned_order_creation_is_bounded(pool: PgPool) {
    let app = setup(&pool, true).await;
    for n in 1..=10 {
        let order = create(&app, &pool, n).await;
        assert_eq!(
            api(
                &app,
                "POST",
                &format!(
                    "/v1/payments/orders/{}/cancel",
                    order["id"].as_str().unwrap()
                ),
                Value::Null,
                TOKEN
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        api(
            &app,
            "POST",
            "/v1/payments/orders",
            purchase(&pool, 11).await,
            TOKEN
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[sqlx::test(migrations = false)]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn migration_preserves_existing_manually_granted_periods(pool: PgPool) {
    for migration in [
        include_str!("../migrations/202611120001_accounts.sql"),
        include_str!("../migrations/202611120002_subscriptions.sql"),
        include_str!("../migrations/202611140001_audio_requests.sql"),
        include_str!("../migrations/202611150001_plan_catalog.sql"),
        include_str!("../migrations/202611150002_storefront.sql"),
        include_str!("../migrations/202611150003_request_limits.sql"),
    ] {
        sqlx::raw_sql(migration).execute(&pool).await.unwrap();
    }
    let id: String = sqlx::query_scalar("INSERT INTO users(username,password_hash) VALUES('existing_paid','unused') RETURNING id::text").fetch_one(&pool).await.unwrap();
    sqlx::query("SELECT activate_subscription($1::uuid,'plus')")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE subscriptions SET assist_requests_remaining=123,assist_requests_used=377")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../migrations/202611150004_payment_orders.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE plans SET initial_assist_requests=1,audio_enabled=false WHERE id='plus'")
        .execute(&pool)
        .await
        .unwrap();
    let before:(i32,i32,bool,i64)=sqlx::query_as("SELECT assist_requests_remaining,period_request_limit,period_audio_enabled,assist_requests_used FROM subscriptions").fetch_one(&pool).await.unwrap();
    assert_eq!(before, (123, 500, true, 377));
    Reservation::begin_request(&pool, &id, true)
        .await
        .unwrap()
        .commit()
        .await
        .unwrap();
    sqlx::query("SELECT activate_subscription($1::uuid,'plus')")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    let next:(i32,i32,bool)=sqlx::query_as("SELECT assist_requests_remaining,period_request_limit,period_audio_enabled FROM subscriptions").fetch_one(&pool).await.unwrap();
    assert_eq!(next, (1, 1, false));
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires PostgreSQL in DATABASE_URL; CI runs this explicitly"]
async fn live_orders_allow_all_accounts_and_isolate_historical_test_orders(pool: PgPool) {
    let test_app = setup(&pool, true).await;
    let old = create(&test_app, &pool, 1).await;
    let config = Config::new(
        payments::Mode::Live,
        "WienTest".into(),
        "local-live-first-password".into(),
        "local-live-second-password".into(),
        Default::default(),
    )
    .unwrap();
    let state = Payments::new(pool.clone(), Some(config));
    assert_eq!(state.mode(), payments::Mode::Live);
    let app = payments::router(state);
    let (_, history) = api(&app, "GET", "/v1/payments/orders", Value::Null, TOKEN).await;
    assert_eq!(history[0]["is_test"], true);
    assert_eq!(history[0]["checkout_url"], Value::Null);
    assert_eq!(
        notify(&app, form(&old, "399.000000", PASSWORD2)).await.0,
        StatusCode::BAD_REQUEST
    );
    // Even a correctly signed live notification cannot pay a historical test order.
    let mut forged = old.clone();
    forged["is_test"] = json!(false);
    assert_eq!(
        notify(
            &app,
            form(&forged, "399.000000", "local-live-second-password")
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(quota(&pool).await, 10);
    api(
        &app,
        "POST",
        &format!("/v1/payments/orders/{}/cancel", old["id"].as_str().unwrap()),
        Value::Null,
        TOKEN,
    )
    .await;
    let order = create(&app, &pool, 2).await;
    assert_eq!(order["is_test"], false);
    assert!(!order["checkout_url"].as_str().unwrap().contains("IsTest"));
    assert!(order["checkout_url"].as_str().unwrap().contains("Receipt="));
    // The account excluded from the test allowlist can buy in live mode.
    let (status, other) = api(
        &app,
        "POST",
        "/v1/payments/orders",
        purchase(&pool, 3).await,
        OTHER,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{other}");
    assert_eq!(other["is_test"], false);
    for body in [
        form(&order, "399.000000", PASSWORD2),
        form(&order, "1.00", "local-live-second-password"),
    ] {
        assert_eq!(notify(&app, body).await.0, StatusCode::BAD_REQUEST);
    }
    let body = form(&order, "399.000000", "local-live-second-password");
    let (a, b) = tokio::join!(notify(&app, body.clone()), notify(&app, body.clone()));
    assert_eq!(
        a,
        (
            StatusCode::OK,
            format!("OK{}", order["invoice_id"].as_str().unwrap())
        )
    );
    assert_eq!(a, b);
    assert_eq!(quota(&pool).await, 500);
    sqlx::query(
        "UPDATE subscriptions SET assist_requests_remaining=499 WHERE payment_order_id=$1::uuid",
    )
    .bind(order["id"].as_str().unwrap())
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(notify(&app, body).await.0, StatusCode::OK);
    assert_eq!(quota(&pool).await, 499);
    assert_eq!(
        notify(
            &test_app,
            form(&order, "399.000000", "local-live-second-password")
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}
