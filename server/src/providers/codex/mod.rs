mod auth;

use std::{path::PathBuf, time::Duration};

use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures_util::{StreamExt, TryStreamExt};
use reqwest::{Client, StatusCode, header};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{ModelOptions, ModelResponse, Provider, ProviderError, Usage};

const RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// Development adapter for the direct Codex HTTP protocol; does not launch the Codex agent.
/// The internal endpoint can change independently of Wien. Credentials remain owned by Codex.
pub struct Codex {
    client: Client,
    auth_file: PathBuf,
    endpoint: String,
    timeout: Duration,
}

impl Codex {
    pub fn local() -> Result<Self, ProviderError> {
        Self::new(auth::default_auth_file()?, RESPONSES_URL.into(), TIMEOUT)
    }

    fn new(auth_file: PathBuf, endpoint: String, timeout: Duration) -> Result<Self, ProviderError> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(timeout)
            .user_agent(concat!("wien-server/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| ProviderError::Unavailable)?;
        Ok(Self {
            client,
            auth_file,
            endpoint,
            timeout,
        })
    }

    async fn request(
        &self,
        text: &str,
        options: &ModelOptions,
    ) -> Result<ModelResponse, ProviderError> {
        // Re-read on each request: Codex owns refresh/login and can replace the file at any time.
        let credentials = auth::load(&self.auth_file).await?;
        let mut body = json!({
            "model": options.model,
            "instructions": options.instructions.as_deref().unwrap_or("You are a helpful assistant."),
            "input": [{"role": "user", "content": [{"type": "input_text", "text": text}]}],
            "tools": [],
            "tool_choice": "none",
            "parallel_tool_calls": false,
            "store": false,
            "stream": true
        });
        if let Some(effort) = &options.reasoning_effort {
            body["reasoning"] = json!({ "effort": effort });
        }
        let response = self
            .client
            .post(&self.endpoint)
            .header(header::AUTHORIZATION, credentials.authorization)
            .header("ChatGPT-Account-Id", credentials.account_id)
            .header(header::ACCEPT, "text/event-stream")
            .json(&body)
            .send()
            .await
            .map_err(transport_error)?;
        if !response.status().is_success() {
            // Never deserialize, log, or expose an upstream error body.
            return Err(match response.status() {
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ProviderError::AuthRequired,
                StatusCode::TOO_MANY_REQUESTS => ProviderError::RateLimited,
                status if status.is_client_error() => ProviderError::Rejected,
                _ => ProviderError::Unavailable,
            });
        }
        // Codex can omit Content-Type even when the body is SSE. Still reject an
        // explicitly different format; the SSE parser and terminal event validate the body.
        if response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|value| {
                !value.to_str().ok().is_some_and(|value| {
                    value
                        .split(';')
                        .next()
                        .unwrap_or_default()
                        .trim()
                        .eq_ignore_ascii_case("text/event-stream")
                })
            })
        {
            return Err(ProviderError::InvalidResponse);
        }

        let mut received = 0_usize;
        let chunks = response
            .bytes_stream()
            .map_err(transport_error)
            .and_then(move |chunk| {
                received = received.saturating_add(chunk.len());
                std::future::ready(if received > MAX_RESPONSE_BYTES {
                    Err(ProviderError::ResponseTooLarge)
                } else {
                    Ok(chunk)
                })
            });
        let mut events = chunks.eventsource();
        while let Some(event) = events.next().await {
            let event = event.map_err(|error| match error {
                eventsource_stream::EventStreamError::Transport(error) => error,
                _ => ProviderError::InvalidResponse,
            })?;
            if event.data == "[DONE]" {
                break;
            }
            let data: Value =
                serde_json::from_str(&event.data).map_err(|_| ProviderError::InvalidResponse)?;
            match data["type"].as_str() {
                Some("response.completed") => return completed(&data["response"]),
                Some("response.failed" | "error") => {
                    let code = data
                        .pointer("/response/error/code")
                        .or_else(|| data.pointer("/error/code"))
                        .or_else(|| data.get("code"))
                        .and_then(Value::as_str);
                    return Err(match code {
                        Some(
                            "rate_limit_exceeded"
                            | "usage_limit_reached"
                            | "insufficient_quota"
                            | "subscription_sharing_usage_limit_exceeded",
                        ) => ProviderError::RateLimited,
                        _ => ProviderError::Unavailable,
                    });
                }
                Some("response.incomplete") => return Err(ProviderError::Incomplete),
                _ => {} // Deltas are not final results; wait for a successful terminal event.
            }
        }
        Err(ProviderError::Incomplete)
    }
}

#[async_trait]
impl Provider for Codex {
    async fn send(
        &self,
        text: &str,
        options: &ModelOptions,
    ) -> Result<ModelResponse, ProviderError> {
        tokio::time::timeout(self.timeout, self.request(text, options))
            .await
            .map_err(|_| ProviderError::Timeout)?
    }
}

fn transport_error(error: reqwest::Error) -> ProviderError {
    if error.is_timeout() {
        ProviderError::Timeout
    } else {
        ProviderError::Unavailable
    }
}

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

fn completed(value: &Value) -> Result<ModelResponse, ProviderError> {
    let response: CompletedResponse =
        serde_json::from_value(value.clone()).map_err(|_| ProviderError::InvalidResponse)?;
    if response.status != "completed" {
        return Err(ProviderError::Incomplete);
    }
    let mut parts = Vec::new();
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
            Output::Reasoning => {}
            Output::Unsupported => return Err(ProviderError::InvalidResponse),
        }
    }
    if parts.is_empty() {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(ModelResponse {
        id: response.id,
        model: response.model,
        text: parts.join("\n"),
        usage: response.usage,
    })
}

#[cfg(test)]
mod tests;
