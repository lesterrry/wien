mod support;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tower::ServiceExt;
use wien_server::{
    api,
    config::GenerationConfig,
    providers::{ModelOptions, ModelResponse, Provider, ProviderError, ReasoningEffort},
};

struct TestProvider {
    calls: Arc<AtomicUsize>,
    error: Option<ProviderError>,
}

#[async_trait]
impl Provider for TestProvider {
    async fn send(
        &self,
        text: &str,
        options: &ModelOptions,
    ) -> Result<ModelResponse, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(options.model, "configured-model");
        assert_eq!(options.reasoning_effort, Some(ReasoningEffort::High));
        assert_eq!(
            options.instructions.as_deref(),
            Some("Configured instructions")
        );
        if let Some(error) = self.error {
            return Err(error);
        }
        Ok(ModelResponse {
            id: "test-id".into(),
            text: text.into(),
            model: options.model.clone(),
            usage: None,
        })
    }
}

fn app(error: Option<ProviderError>) -> (Router, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let provider: Arc<dyn Provider> = Arc::new(TestProvider {
        calls: calls.clone(),
        error,
    });
    (
        support::router(
            provider,
            GenerationConfig {
                model: "configured-model".into(),
                reasoning_effort: ReasoningEffort::High,
                instructions: Some("Configured instructions".into()),
            },
        ),
        calls,
    )
}

fn request(body: Value) -> Request<Body> {
    Request::post("/v1/generate")
        .header("host", "127.0.0.1:3001")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

async fn json_body(response: axum::response::Response) -> Value {
    serde_json::from_slice(
        &to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn routes_through_provider_and_returns_json() {
    let (app, calls) = app(None);
    let response = app.oneshot(request(json!({"text":"hello"}))).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        json_body(response).await,
        json!({"id":"test-id", "model":"configured-model", "text":"hello", "usage":null})
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn rejects_invalid_requests_before_spending_any_model_calls() {
    let (app, calls) = app(None);
    for (body, status) in [
        (
            json!({"text":"hello","provider":"codex"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"text":"hello","model":"override"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"text":"hello","reasoning_effort":"low"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"text":"hello","options":{"model":"override","reasoning_effort":"low"}}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"text":"hello","instructions":"override"}),
            StatusCode::BAD_REQUEST,
        ),
        (json!({"text":" "}), StatusCode::BAD_REQUEST),
        (
            json!({"text":"hello","token":"test-only-secret"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"text":"x".repeat(128 * 1024 + 1)}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"text":"x".repeat(256 * 1024)}),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
    ] {
        let response = app.clone().oneshot(request(body)).await.unwrap();
        assert_eq!(response.status(), status);
        assert!(
            !json_body(response)
                .await
                .to_string()
                .contains("test-only-secret")
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn rejects_malformed_json_and_cross_origin_or_rebinding_requests() {
    let (app, calls) = app(None);
    let body = json!({"text":"hello"});
    let mut cross_origin = request(body.clone());
    cross_origin
        .headers_mut()
        .insert("origin", "https://untrusted.example".parse().unwrap());
    let mut rebinding = request(body.clone());
    rebinding
        .headers_mut()
        .insert("host", "untrusted.example:3001".parse().unwrap());
    for request in [cross_origin, rebinding] {
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    let malformed = Request::post("/v1/generate")
        .header("host", "localhost:3001")
        .header("content-type", "application/json")
        .body(Body::from("{test-only-secret"))
        .unwrap();
    let response = app.clone().oneshot(malformed).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(
        !json_body(response)
            .await
            .to_string()
            .contains("test-only-secret")
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let mut docs = request(body);
    docs.headers_mut()
        .insert("origin", "http://127.0.0.1:3001".parse().unwrap());
    assert_eq!(app.oneshot(docs).await.unwrap().status(), StatusCode::OK);
}

#[tokio::test]
async fn returns_stable_error_codes_and_http_statuses() {
    for (error, status) in [
        (ProviderError::AuthRequired, StatusCode::SERVICE_UNAVAILABLE),
        (ProviderError::RateLimited, StatusCode::TOO_MANY_REQUESTS),
        (ProviderError::Timeout, StatusCode::GATEWAY_TIMEOUT),
        (ProviderError::Incomplete, StatusCode::BAD_GATEWAY),
    ] {
        let (app, _) = app(Some(error));
        let response = app.oneshot(request(json!({"text":"hello"}))).await.unwrap();
        assert_eq!(response.status(), status);
        assert_eq!(json_body(response).await["code"], error.code());
    }
}

#[tokio::test]
async fn serves_openapi_and_offline_swagger_without_credentials() {
    let (app, calls) = app(None);
    let response = app
        .clone()
        .oneshot(Request::get("/openapi.json").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let spec = json_body(response).await;
    assert_eq!(spec, serde_json::to_value(api::openapi()).unwrap());
    assert!(spec["paths"]["/v1/generate"]["post"]["responses"]["200"].is_object());

    let schemas = spec["components"]["schemas"].as_object().unwrap();
    for name in ["GenerateRequest", "ModelResponse"] {
        assert!(
            !schemas[name]["properties"]
                .as_object()
                .unwrap()
                .contains_key("provider")
        );
    }
    for name in [
        "ProviderKind",
        "ModelOptions",
        "ReasoningEffort",
        "GenerationConfig",
    ] {
        assert!(!schemas.contains_key(name));
    }
    let properties = schemas["GenerateRequest"]["properties"]
        .as_object()
        .unwrap();
    assert_eq!(properties.len(), 1);
    assert!(properties.contains_key("text"));
    assert!(
        spec["paths"]["/v1/generate"]["post"]["responses"]
            .get("404")
            .is_none()
    );
    for uri in ["/health", "/docs/", "/docs/swagger-ui-bundle.js"] {
        let response = app
            .clone()
            .oneshot(Request::get(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{uri}");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn generated_http_body_matches_openapi_example_and_is_accepted() {
    let spec = serde_json::to_value(api::openapi()).unwrap();
    let example = spec["paths"]["/v1/generate"]["post"]["requestBody"]["content"]["application/json"]["example"].clone();
    assert_eq!(example, json!({"text":"Hello!"}));
    let http = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/http/PostGenerate.http"
    ))
    .unwrap();
    assert!(http.contains("POST {{baseUrl}}/v1/generate"));
    let (_, body) = http.split_once("\n{").unwrap();
    let generated: Value = serde_json::from_str(&format!("{{{body}")).unwrap();
    assert_eq!(generated, example);
    let (app, calls) = app(None);
    assert_eq!(
        app.oneshot(request(generated)).await.unwrap().status(),
        StatusCode::OK
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn readiness_checks_corpus_without_calling_model_and_keeps_liveness_separate() {
    use wien_server::assistant::tools::{AssistantTools, ToolError};
    struct Corpus(bool);
    #[async_trait]
    impl AssistantTools for Corpus {
        async fn call(&self, name: &str, _: Value) -> Result<Value, ToolError> {
            assert_eq!(name, "strudel_rag_get_corpus_info");
            Ok(json!({"ready":self.0}))
        }
    }
    for ready in [false, true] {
        let calls = Arc::new(AtomicUsize::new(0));
        let app = api::router(
            Arc::new(TestProvider {
                calls: calls.clone(),
                error: None,
            }),
            Default::default(),
            Arc::new(Corpus(ready)),
        );
        let response = app
            .clone()
            .oneshot(Request::get("/ready").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            if ready {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            }
        );
        let body = json_body(response).await;
        if ready {
            assert_eq!(body, json!({"ready":true}));
        } else {
            assert_eq!(body["code"], "rag_not_ready");
        }
        assert_eq!(
            app.oneshot(Request::get("/health").body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}
