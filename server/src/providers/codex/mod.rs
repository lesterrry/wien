mod auth;

use std::{path::PathBuf, time::Duration};

use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures_util::{StreamExt, TryStreamExt};
use reqwest::{Client, StatusCode, header};
use serde_json::{Value, json};

use super::responses::completed_turn;
use super::turn::{TurnRequest, TurnResponse, user_input};
use super::{ModelOptions, ModelResponse, Provider, ProviderError};

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

    async fn request(&self, request: &TurnRequest) -> Result<TurnResponse, ProviderError> {
        let options = &request.options;
        // Re-read on each request: Codex owns refresh/login and can replace the file at any time.
        let credentials = auth::load(&self.auth_file).await?;
        let mut body = json!({
            "model": options.model,
            "instructions": options.instructions.as_deref().unwrap_or("You are a helpful assistant."),
            "input": request.input,
            "tools": request.tools,
            "tool_choice": if request.tools.is_empty() { "none" } else { "auto" },
            "parallel_tool_calls": false,
            "store": false,
            "stream": true
        });
        if !request.tools.is_empty() {
            body["include"] = json!(["reasoning.encrypted_content"]);
        }
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
            tracing::warn!(
                status = response.status().as_u16(),
                "Model provider rejected HTTP request"
            );
            // Never deserialize, log, or expose an upstream error body.
            return Err(match response.status() {
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ProviderError::AuthRequired,
                StatusCode::TOO_MANY_REQUESTS => ProviderError::RateLimited,
                status if status.is_client_error() => ProviderError::Rejected,
                _ => ProviderError::Unavailable,
            });
        }
        // Codex can omit Content-Type or label SSE as text/plain. The SSE parser
        // and successful terminal event still validate the body in all cases.
        if response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|value| {
                !value.to_str().ok().is_some_and(|value| {
                    let media_type = value.split(';').next().unwrap_or_default().trim();
                    media_type.eq_ignore_ascii_case("text/event-stream")
                        || media_type.eq_ignore_ascii_case("text/plain")
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
                Some("response.completed") => return completed_turn(&data["response"]),
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
        let result = self
            .turn(&TurnRequest {
                input: vec![user_input(text)],
                tools: vec![],
                options: options.clone(),
            })
            .await?;
        if !result.calls.is_empty() || result.response.text.trim().is_empty() {
            return Err(ProviderError::InvalidResponse);
        }
        Ok(result.response)
    }

    async fn turn(&self, request: &TurnRequest) -> Result<TurnResponse, ProviderError> {
        tokio::time::timeout(self.timeout, self.request(request))
            .await
            .map_err(|_| ProviderError::Timeout)?
    }
}

fn transport_error(error: reqwest::Error) -> ProviderError {
    // Do not log the raw error: it can carry request URLs or sensitive context.
    tracing::warn!(
        timeout = error.is_timeout(),
        connect = error.is_connect(),
        "Model provider transport failed; check network and TLS trust"
    );
    if error.is_timeout() {
        ProviderError::Timeout
    } else {
        ProviderError::Unavailable
    }
}

#[cfg(test)]
fn completed(value: &Value) -> Result<ModelResponse, ProviderError> {
    let turn = completed_turn(value)?;
    if !turn.calls.is_empty() || turn.response.text.trim().is_empty() {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(turn.response)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod rag_tests;
