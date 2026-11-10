use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use utoipa::ToSchema;

use crate::providers::{ModelOptions, Provider, ProviderError, ReasoningEffort};

const MAX_CODE_BYTES: usize = 128 * 1024;
pub const MASTER_PROMPT: &str = include_str!("../prompts/assistant.md");

#[derive(Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AssistantConfig {
    pub model: String,
}

impl Default for AssistantConfig {
    fn default() -> Self {
        Self {
            model: "gpt-6.1-sol".into(),
        }
    }
}

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

pub async fn send(
    provider: &dyn Provider,
    config: &AssistantConfig,
    request: &AssistRequest,
) -> Result<AssistResponse, ProviderError> {
    let options = ModelOptions {
        model: config.model.clone(),
        reasoning_effort: Some(ReasoningEffort::Low),
        instructions: Some(MASTER_PROMPT.into()),
    };
    let text = model_context(request)
        .ok_or(ProviderError::InvalidResponse)?
        .to_string();
    let response = provider.send(&text, &options).await?;
    let result: AssistResponse =
        serde_json::from_str(&response.text).map_err(|_| ProviderError::InvalidResponse)?;
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
