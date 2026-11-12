use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::{Client, StatusCode, header};
use serde_json::{Value, json};

use super::responses::completed_turn;
use super::turn::{TurnRequest, TurnResponse, user_input};
use super::{ModelOptions, ModelResponse, Provider, ProviderError};

const ENDPOINT: &str = "https://api.aitunnel.ru/v1/responses";
const TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_OUTPUT_TOKENS: usize = 4096;

/// AI Tunnel owns model routing; the adapter never falls back to another service.
pub struct Aitunnel {
    client: Client,
    authorization: header::HeaderValue,
    endpoint: String,
}

impl Aitunnel {
    pub fn from_env() -> Result<Self, ProviderError> {
        let key = std::env::var("AITUNNEL_KEY").map_err(|_| ProviderError::AuthRequired)?;
        Self::new(&key, ENDPOINT.into(), TIMEOUT)
    }

    fn new(key: &str, endpoint: String, timeout: Duration) -> Result<Self, ProviderError> {
        if key.trim().is_empty() {
            return Err(ProviderError::AuthRequired);
        }
        let mut authorization = header::HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| ProviderError::AuthRequired)?;
        authorization.set_sensitive(true);
        Ok(Self {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(timeout)
                .user_agent(concat!("wien-server/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|_| ProviderError::Unavailable)?,
            authorization,
            endpoint,
        })
    }
}

#[async_trait]
impl Provider for Aitunnel {
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
        let options = &request.options;
        let mut body = json!({
            "model": options.model,
            "instructions": options.instructions.as_deref().unwrap_or("You are a helpful assistant."),
            "input": request.input,
            "tools": request.tools,
            "tool_choice": if request.tools.is_empty() { "none" } else { "auto" },
            "parallel_tool_calls": false,
            "max_output_tokens": MAX_OUTPUT_TOKENS,
            "store": false,
            "stream": false
        });
        if !request.tools.is_empty() {
            body["include"] = json!(["reasoning.encrypted_content"]);
        }
        if let Some(effort) = &options.reasoning_effort {
            body["reasoning"] = json!({"effort": effort});
        }
        // No automatic retries: a lost response can still be a billed inference.
        let response = self
            .client
            .post(&self.endpoint)
            .header(header::AUTHORIZATION, self.authorization.clone())
            .json(&body)
            .send()
            .await
            .map_err(transport_error)?;
        if !response.status().is_success() {
            return Err(match response.status() {
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ProviderError::AuthRequired,
                StatusCode::PAYMENT_REQUIRED | StatusCode::TOO_MANY_REQUESTS => {
                    ProviderError::RateLimited
                }
                StatusCode::REQUEST_TIMEOUT | StatusCode::GATEWAY_TIMEOUT => ProviderError::Timeout,
                status if status.is_client_error() => ProviderError::Rejected,
                _ => ProviderError::Unavailable,
            });
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
        {
            return Err(ProviderError::ResponseTooLarge);
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(transport_error)?;
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(ProviderError::ResponseTooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| ProviderError::InvalidResponse)?;
        completed_turn(&value)
    }
}

fn transport_error(error: reqwest::Error) -> ProviderError {
    if error.is_timeout() {
        ProviderError::Timeout
    } else {
        ProviderError::Unavailable
    }
}

#[cfg(test)]
mod tests;
