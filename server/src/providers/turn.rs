use serde_json::{Value, json};

use super::{ModelOptions, ModelResponse};

pub struct TurnRequest {
    pub input: Vec<Value>,
    pub tools: Vec<Value>,
    pub options: ModelOptions,
}

#[derive(Debug)]
pub struct ToolCall {
    pub call_id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug)]
pub struct TurnResponse {
    pub response: ModelResponse,
    /// Preserve completed reasoning (including encrypted content) and function calls.
    pub output: Vec<Value>,
    pub calls: Vec<ToolCall>,
}

pub fn user_input(text: &str) -> Value {
    json!({"role":"user", "content":[{"type":"input_text", "text":text}]})
}
