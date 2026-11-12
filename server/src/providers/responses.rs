use serde::Deserialize;
use serde_json::Value;

use super::{
    ModelResponse, ProviderError, Usage,
    turn::{ToolCall, TurnResponse},
};

#[derive(Deserialize)]
struct CompletedResponse {
    id: String,
    model: String,
    status: String,
    output: Vec<Output>,
    usage: Option<Usage>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Output {
    Message {
        content: Vec<Content>,
    },
    Reasoning,
    FunctionCall {
        call_id: String,
        name: String,
        arguments: String,
    },
    #[serde(other)]
    Unsupported,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Content {
    OutputText {
        text: String,
    },
    Refusal {
        refusal: String,
    },
    #[serde(other)]
    Unsupported,
}

pub(super) fn completed_turn(value: &Value) -> Result<TurnResponse, ProviderError> {
    let response: CompletedResponse =
        serde_json::from_value(value.clone()).map_err(|_| ProviderError::InvalidResponse)?;
    if response.status != "completed" {
        return Err(ProviderError::Incomplete);
    }
    let mut parts = Vec::new();
    let mut calls = Vec::new();
    for item in response.output {
        match item {
            Output::Message { content } => {
                for item in content {
                    match item {
                        Content::OutputText { text } => parts.push(text),
                        Content::Refusal { refusal } => parts.push(refusal),
                        Content::Unsupported => return Err(ProviderError::InvalidResponse),
                    }
                }
            }
            Output::FunctionCall {
                call_id,
                name,
                arguments,
            } => {
                if call_id.is_empty()
                    || call_id.len() > 200
                    || name.is_empty()
                    || name.len() > 100
                    || arguments.len() > 16 * 1024
                    || calls.len() >= 12
                    || calls.iter().any(|call: &ToolCall| call.call_id == call_id)
                {
                    return Err(ProviderError::InvalidResponse);
                }
                calls.push(ToolCall {
                    call_id,
                    name,
                    arguments,
                });
            }
            Output::Reasoning => {}
            Output::Unsupported => return Err(ProviderError::InvalidResponse),
        }
    }
    if parts.is_empty() && calls.is_empty() {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(TurnResponse {
        output: value["output"]
            .as_array()
            .ok_or(ProviderError::InvalidResponse)?
            .clone(),
        calls,
        response: ModelResponse {
            id: response.id,
            model: response.model,
            text: parts.join("\n"),
            usage: response.usage,
        },
    })
}
