use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use wien_server::{
    assistant::{
        self, AssistRequest,
        error::AssistError,
        tools::{AssistantTools, ToolError},
    },
    providers::{
        ModelOptions, ModelResponse, Provider, ProviderError,
        turn::{ToolCall, TurnRequest, TurnResponse},
    },
};

struct Script {
    steps: Mutex<usize>,
    name: &'static str,
    arguments: &'static str,
    expected_error: Option<&'static str>,
    repeat: bool,
}
#[async_trait]
impl Provider for Script {
    async fn send(&self, _: &str, _: &ModelOptions) -> Result<ModelResponse, ProviderError> {
        panic!("assist must use turn")
    }
    async fn turn(&self, request: &TurnRequest) -> Result<TurnResponse, ProviderError> {
        let mut step = self.steps.lock().unwrap();
        let index = *step;
        *step += 1;
        let mut result = TurnResponse {
            response: ModelResponse {
                id: "test".into(),
                model: "test".into(),
                usage: None,
                text: json!({"message":"ok","code":null}).to_string(),
            },
            output: vec![],
            calls: vec![],
        };
        if index == 0 || self.repeat {
            let call_id = format!("call-{index}");
            result.output = vec![
                json!({"type":"function_call","call_id":call_id,"name":self.name,"arguments":self.arguments}),
            ];
            result.calls = vec![ToolCall {
                call_id,
                name: self.name.into(),
                arguments: self.arguments.into(),
            }];
        } else if let Some(expected) = self.expected_error {
            let output: Value =
                serde_json::from_str(request.input.last().unwrap()["output"].as_str().unwrap())
                    .unwrap();
            assert_eq!(output["error"]["code"], expected);
        }
        Ok(result)
    }
}
struct Tools {
    calls: Mutex<Vec<String>>,
    result: Result<Value, ToolError>,
}
#[async_trait]
impl AssistantTools for Tools {
    async fn call(&self, name: &str, _: Value) -> Result<Value, ToolError> {
        self.calls.lock().unwrap().push(name.into());
        if name == "strudel_rag_get_corpus_info" {
            Ok(json!({"ready":true}))
        } else {
            self.result.clone()
        }
    }
}
fn request() -> AssistRequest {
    serde_json::from_value(json!({"prompt":"explain","file":{"path":"a.strudel","content":"s('bd')","cursor":{"anchor":0,"head":0}}})).unwrap()
}

#[tokio::test]
async fn malformed_arguments_and_large_results_are_explicit_tool_errors() {
    for (arguments, result, expected, executed) in [
        ("not json", Ok(json!({})), "invalid_tool_arguments", false),
        (
            "{}",
            Ok(json!({"content":"x".repeat(65537)})),
            "tool_result_too_large",
            true,
        ),
        ("{}", Err(ToolError::NotFound), "document_not_found", true),
    ] {
        let provider = Script {
            steps: Mutex::new(0),
            name: "strudel_rag_get_document",
            arguments,
            expected_error: Some(expected),
            repeat: false,
        };
        let tools = Tools {
            calls: Mutex::new(vec![]),
            result,
        };
        let response = assistant::send(&provider, &Default::default(), &tools, &request())
            .await
            .unwrap();
        assert_eq!(response.message, "ok");
        assert_eq!(
            tools.calls.lock().unwrap().len(),
            if executed { 2 } else { 1 }
        );
    }
}

#[tokio::test]
async fn repeated_calls_stop_at_step_budget_and_service_failures_never_return_an_edit() {
    let provider = Script {
        steps: Mutex::new(0),
        name: "strudel_rag_search",
        arguments: "{}",
        expected_error: None,
        repeat: true,
    };
    let tools = Tools {
        calls: Mutex::new(vec![]),
        result: Ok(json!({"results":[]})),
    };
    assert!(matches!(
        assistant::send(&provider, &Default::default(), &tools, &request()).await,
        Err(AssistError::Limit)
    ));
    assert_eq!(*provider.steps.lock().unwrap(), 8);
    let provider = Script {
        steps: Mutex::new(0),
        repeat: false,
        ..provider
    };
    let tools = Tools {
        calls: Mutex::new(vec![]),
        result: Err(ToolError::Unavailable),
    };
    assert!(matches!(
        assistant::send(&provider, &Default::default(), &tools, &request()).await,
        Err(AssistError::Tool(ToolError::Unavailable))
    ));
    assert_eq!(*provider.steps.lock().unwrap(), 1);
}

#[tokio::test]
async fn tool_registry_rejects_unknown_tools_paths_and_invalid_search_before_network() {
    use wien_server::{assistant::tools::Tools as RealTools, rag::RagClient};
    let tools = Arc::new(RealTools(
        RagClient::new(
            "http://127.0.0.1:1",
            None,
            std::time::Duration::from_millis(50),
        )
        .unwrap(),
    ));
    for (name, args, expected) in [
        (
            "shell",
            json!({"command":"anything"}),
            ToolError::UnknownTool,
        ),
        (
            "get_genre_guide",
            json!({"genre":"../../auth.json"}),
            ToolError::NotFound,
        ),
        (
            "get_genre_guide",
            json!({"genre":"techno","path":"anything"}),
            ToolError::InvalidArguments,
        ),
        (
            "strudel_rag_search",
            json!({"query":"slow","intent":"invalid"}),
            ToolError::InvalidArguments,
        ),
        (
            "strudel_rag_search",
            json!({"query":"slow","intent":"api","top_k":11}),
            ToolError::InvalidArguments,
        ),
        (
            "strudel_rag_get_document",
            json!({"document_id":"a","chunk_id":"b"}),
            ToolError::InvalidArguments,
        ),
    ] {
        assert_eq!(tools.call(name, args).await.unwrap_err(), expected);
    }
    for genre in wien_server::genres::NAMES {
        let value = tools
            .call("get_genre_guide", json!({"genre":genre}))
            .await
            .unwrap();
        assert!(!value["content"].as_str().unwrap().is_empty());
    }
    assert_eq!(
        tools
            .call("strudel_rag_get_corpus_info", json!({}))
            .await
            .unwrap_err(),
        ToolError::Unavailable
    );
}
