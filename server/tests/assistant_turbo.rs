use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use async_trait::async_trait;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tower::ServiceExt;
use wien_server::{
    api,
    assistant::{
        MASTER_PROMPT,
        tools::{AssistantTools, ToolError},
    },
    providers::{
        ModelOptions, ModelResponse, Provider, ProviderError,
        turn::{ToolCall, TurnRequest, TurnResponse},
    },
};

struct UnavailableTools(AtomicUsize);

#[async_trait]
impl AssistantTools for UnavailableTools {
    async fn call(&self, _: &str, _: Value) -> Result<Value, ToolError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(ToolError::Unavailable)
    }
}

struct DirectModel {
    calls: AtomicUsize,
    output: String,
    unexpected_tool: Option<&'static str>,
}

#[async_trait]
impl Provider for DirectModel {
    async fn send(&self, _: &str, _: &ModelOptions) -> Result<ModelResponse, ProviderError> {
        panic!("assist must use turn")
    }

    async fn turn(&self, request: &TurnRequest) -> Result<TurnResponse, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(request.tools.is_empty());
        let instructions = request.options.instructions.as_deref().unwrap();
        assert!(instructions.contains(MASTER_PROMPT));
        assert!(!instructions.contains("strudel_rag_search"));
        assert!(!instructions.contains("Genre index:"));
        let context: Value =
            serde_json::from_str(request.input[0]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(context.get("rag_corpus").is_none());
        assert_eq!(context["prompt"], "Make this softer");
        assert_eq!(context["file"]["content"], "note('c4')");
        assert_eq!(context["editor_context"]["selection"]["text"], "note");
        Ok(TurnResponse {
            response: ModelResponse {
                id: "turbo-test".into(),
                model: request.options.model.clone(),
                text: self.output.clone(),
                usage: None,
            },
            output: vec![],
            calls: self
                .unexpected_tool
                .map(|name| ToolCall {
                    call_id: "unexpected".into(),
                    name: name.into(),
                    arguments: "{}".into(),
                })
                .into_iter()
                .collect(),
        })
    }
}

fn request(turbo: Option<bool>) -> Request<Body> {
    let mut body = json!({"prompt":"Make this softer", "file":{"path":"keys.strudel", "content":"note('c4')", "cursor":{"anchor":0,"head":4}}});
    if let Some(turbo) = turbo {
        body["turbo"] = json!(turbo);
    }
    Request::post("/v1/assist")
        .header("host", "127.0.0.1:3001")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn turbo_answers_and_edits_in_one_turn_without_contacting_unavailable_rag() {
    for code in [Value::Null, json!("note('c4').gain(0.1)"), json!("")] {
        let expected = json!({"message":"Softer keys.", "code":code});
        let provider = Arc::new(DirectModel {
            calls: AtomicUsize::new(0),
            output: expected.to_string(),
            unexpected_tool: None,
        });
        let tools = Arc::new(UnavailableTools(AtomicUsize::new(0)));
        let response = api::router(provider.clone(), Default::default(), tools.clone())
            .oneshot(request(Some(true)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body, expected);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        assert_eq!(tools.0.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn absent_or_disabled_turbo_keeps_the_existing_rag_path() {
    for turbo in [None, Some(false)] {
        let provider = Arc::new(DirectModel {
            calls: AtomicUsize::new(0),
            output: String::new(),
            unexpected_tool: None,
        });
        let tools = Arc::new(UnavailableTools(AtomicUsize::new(0)));
        let response = api::router(provider.clone(), Default::default(), tools.clone())
            .oneshot(request(turbo))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
        assert_eq!(tools.0.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn turbo_rejects_unexpected_tool_calls_without_executing_them() {
    for tool in ["strudel_rag_search", "get_genre_guide"] {
        let provider = Arc::new(DirectModel {
            calls: AtomicUsize::new(0),
            output: String::new(),
            unexpected_tool: Some(tool),
        });
        let tools = Arc::new(UnavailableTools(AtomicUsize::new(0)));
        let response = api::router(provider.clone(), Default::default(), tools.clone())
            .oneshot(request(Some(true)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        assert_eq!(tools.0.load(Ordering::SeqCst), 0);
    }
}
