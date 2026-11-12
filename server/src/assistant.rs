pub mod error;
pub mod tools;

use crate::{
    genres,
    providers::turn::{TurnRequest, user_input},
};
use error::AssistError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashSet, time::Duration};
use tools::{AssistantTools, ToolError};
use utoipa::ToSchema;

use crate::{
    config::GenerationConfig,
    providers::{Provider, ProviderError},
};

const MAX_CODE_BYTES: usize = 128 * 1024;
pub const MASTER_PROMPT: &str = include_str!("../prompts/assistant.md");

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    /// Zero-based UTF-16 offset. Different anchor/head values indicate a selection.
    pub anchor: usize,
    /// Zero-based UTF-16 offset of the active end of the selection (caret).
    pub head: usize,
}

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct FileContext {
    /// Project-relative path; context only, never used for filesystem access.
    pub path: String,
    pub content: String,
    pub cursor: Cursor,
}

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AssistRequest {
    pub prompt: String,
    pub file: FileContext,
}

impl AssistRequest {
    pub fn is_valid(&self) -> bool {
        !self.prompt.trim().is_empty()
            && self.prompt.len() <= 16 * 1024
            && !self.file.path.trim().is_empty()
            && self.file.path.len() <= 4096
            && self.file.content.len() <= MAX_CODE_BYTES
            && position(&self.file.content, self.file.cursor.anchor).is_some()
            && position(&self.file.content, self.file.cursor.head).is_some()
    }
}

#[derive(Serialize)]
struct Position {
    offset: usize,
    line: usize,
    column: usize,
}

// JavaScript offsets count UTF-16 units; Rust string slices use UTF-8 bytes.
// Reject positions inside surrogate pairs instead of shifting the selection.
fn position(content: &str, target: usize) -> Option<(usize, Position)> {
    let mut location = Position {
        offset: 0,
        line: 1,
        column: 1,
    };
    for (byte, character) in content.char_indices() {
        if location.offset == target {
            return Some((byte, location));
        }
        location.offset += character.len_utf16();
        if character == '\n' {
            location.line += 1;
            location.column = 1;
        } else {
            location.column += character.len_utf16();
        }
    }
    (location.offset == target).then_some((content.len(), location))
}

fn model_context(request: &AssistRequest) -> Option<Value> {
    let content = &request.file.content;
    let (anchor_byte, anchor) = position(content, request.file.cursor.anchor)?;
    let (head_byte, head) = position(content, request.file.cursor.head)?;
    let line_start = content[..head_byte]
        .rfind('\n')
        .map_or(0, |index| index + 1);
    let line_end = content[head_byte..]
        .find('\n')
        .map_or(content.len(), |index| head_byte + index);
    let cursor = json!({
        "position": head,
        "line_text": content[line_start..line_end].trim_end_matches('\r'),
    });
    let selection = if anchor_byte == head_byte {
        Value::Null
    } else {
        let ((from_byte, from), (to_byte, to)) = if anchor_byte < head_byte {
            ((anchor_byte, anchor), (head_byte, head))
        } else {
            ((head_byte, head), (anchor_byte, anchor))
        };
        json!({ "text": &content[from_byte..to_byte], "from": from, "to": to })
    };
    Some(json!({
        "prompt": request.prompt,
        "file": request.file,
        "editor_context": { "cursor": cursor, "selection": selection },
    }))
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AssistResponse {
    pub message: String,
    /// Entire replacement file, or null for an answer without an edit.
    pub code: Option<String>,
}

pub fn instructions() -> String {
    format!(
        "{}\n\nGenre index:\n{}\n\n{}\n\n{}",
        genres::SKILL,
        genres::INDEX,
        MASTER_PROMPT,
        include_str!("../prompts/rag.md")
    )
}

pub async fn send(
    provider: &dyn Provider,
    config: &GenerationConfig,
    tools: &dyn AssistantTools,
    request: &AssistRequest,
) -> Result<AssistResponse, AssistError> {
    tokio::time::timeout(
        Duration::from_secs(120),
        run(provider, config, tools, request),
    )
    .await
    .map_err(|_| AssistError::Provider(ProviderError::Timeout))?
}

async fn run(
    provider: &dyn Provider,
    config: &GenerationConfig,
    tools: &dyn AssistantTools,
    request: &AssistRequest,
) -> Result<AssistResponse, AssistError> {
    let mut options = config.options();
    options.instructions = Some(instructions());
    let mut context = model_context(request).ok_or(ProviderError::InvalidResponse)?;
    let corpus = tools.call("strudel_rag_get_corpus_info", json!({})).await?;
    if corpus["ready"] != true {
        return Err(ToolError::NotReady.into());
    }
    if corpus.to_string().len() > 64 * 1024 {
        return Err(ToolError::ResultTooLarge.into());
    }
    context["rag_corpus"] = corpus;
    let mut turn = TurnRequest {
        input: vec![user_input(&context.to_string())],
        tools: tools::definitions(),
        options,
    };
    let mut call_ids = HashSet::new();
    for _ in 0..8 {
        if serde_json::to_vec(&turn.input)
            .map_err(|_| ProviderError::InvalidResponse)?
            .len()
            > 512 * 1024
        {
            return Err(AssistError::Limit);
        }
        let response = provider.turn(&turn).await?;
        if response.calls.is_empty() {
            return parse_response(&response.response.text).map_err(Into::into);
        }
        if call_ids.len() + response.calls.len() > 12 {
            return Err(AssistError::Limit);
        }
        turn.input.extend(response.output);
        for call in response.calls {
            if !call_ids.insert(call.call_id.clone()) {
                return Err(ProviderError::InvalidResponse.into());
            }
            let result = match serde_json::from_str::<Value>(&call.arguments) {
                Ok(arguments) => tools.call(&call.name, arguments).await,
                Err(_) => Err(ToolError::InvalidArguments),
            };
            let result = result.and_then(|value| {
                if value.to_string().len() > 64 * 1024 {
                    Err(ToolError::ResultTooLarge)
                } else {
                    Ok(value)
                }
            });
            let output = match result {
                Ok(value) => value,
                Err(error) if error.recoverable() => {
                    json!({"error":{"code":error.code(), "message":error.message()}})
                }
                Err(error) => return Err(error.into()),
            };
            turn.input.push(json!({"type":"function_call_output", "call_id":call.call_id, "output":output.to_string()}));
        }
    }
    Err(AssistError::Limit)
}

fn parse_response(text: &str) -> Result<AssistResponse, ProviderError> {
    let result: AssistResponse =
        serde_json::from_str(text).map_err(|_| ProviderError::InvalidResponse)?;
    if result.message.trim().is_empty()
        || result.message.chars().count() > 2000
        || result
            .code
            .as_ref()
            .is_some_and(|code| code.len() > MAX_CODE_BYTES)
    {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(result)
}
