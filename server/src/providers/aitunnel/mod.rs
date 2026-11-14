use std::time::Duration;

use async_trait::async_trait;
use eventsource_stream::Eventsource;
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
    async fn audio(&self, prompt: &str, wav_base64: &str) -> Result<String, ProviderError> {
        let endpoint = self
            .endpoint
            .strip_suffix("/responses")
            .ok_or(ProviderError::Rejected)?;
        let response = self
            .client
            .post(format!("{endpoint}/chat/completions"))
            .header(header::AUTHORIZATION, self.authorization.clone())
            .header("X-AITunnel-Log", "off")
            .json(&json!({
                "model": "gemini-4-argon",
                "messages": [{"role":"user", "content":[
                    {"type":"text", "text":prompt},
                    {"type":"input_audio", "input_audio":{"data":wav_base64,"format":"wav"}}
                ]}],
                "max_tokens": 4096, "tools":[], "tool_choice":"none",
                "stream": true, "stream_options":{"include_usage":true}
            }))
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
        // Bound the raw stream before the SSE parser, including unterminated events.
        let mut size = 0usize;
        let stream = response.bytes_stream().map(move |chunk| {
            let chunk = chunk.map_err(transport_error)?;
            size = size.saturating_add(chunk.len());
            if size > MAX_RESPONSE_BYTES {
                return Err(ProviderError::ResponseTooLarge);
            }
            Ok(chunk)
        });
        let mut events = stream.eventsource();
        let mut text = String::new();
        let mut stopped = false;
        while let Some(event) = events.next().await {
            let event = event.map_err(|_| ProviderError::Incomplete)?;
            if event.data == "[DONE]" {
                return if stopped && !text.trim().is_empty() {
                    Ok(text)
                } else {
                    Err(ProviderError::Incomplete)
                };
            }
            let value: Value =
                serde_json::from_str(&event.data).map_err(|_| ProviderError::InvalidResponse)?;
            if value.get("error").is_some() {
                return Err(ProviderError::Incomplete);
            }
            if let Some(choices) = value["choices"].as_array() {
                for choice in choices {
                    if choice["index"] != 0
                        || choice["delta"].get("tool_calls").is_some()
                        || choice["delta"].get("function_call").is_some()
                    {
                        return Err(ProviderError::InvalidResponse);
                    }
                    if let Some(content) = choice["delta"]["content"].as_str() {
                        text.push_str(content);
                    }
                    if text.len() > 160 * 1024 {
                        return Err(ProviderError::ResponseTooLarge);
                    }
                    if let Some(reason) = choice["finish_reason"].as_str() {
                        if reason != "stop" {
                            return Err(ProviderError::Incomplete);
                        }
                        stopped = true;
                    }
                }
            }
        }
        Err(ProviderError::Incomplete)
    }

    async fn send(
        &self,
        text: &str,
        options: &ModelOptions,
    ) -> Result<ModelResponse, ProviderError> {
        let result = self
            .turn(&TurnRequest {
                input: vec![user_input(text)],
                tools: vec![],
                output_format: None,
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
        if let Some(format) = &request.output_format {
            body["text"] = json!({"format": format});
        }
        if let Some(effort) = &options.reasoning_effort {
            body["reasoning"] = json!({"effort": effort});
        }
        // No automatic retries: a lost response can still be a billed inference.
        let response = self
            .client
            .post(&self.endpoint)
            .header(header::AUTHORIZATION, self.authorization.clone())
            .header("X-AITunnel-Log", "off")
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
