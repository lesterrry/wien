pub mod aitunnel;
pub mod codex;
mod responses;
pub mod turn;

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Explicitly supported model settings. Unknown settings are rejected, not ignored.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelOptions {
    /// Model slug available to your account; no implicit model substitution.
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ModelResponse {
    pub id: String,
    pub model: String,
    pub text: String,
    pub usage: Option<Usage>,
}

/// Providers implement inference only: no agent loop, filesystem tools, or conversation store.
#[async_trait]
pub trait Provider: Send + Sync {
    async fn send(
        &self,
        text: &str,
        options: &ModelOptions,
    ) -> Result<ModelResponse, ProviderError>;

    /// One inference step. Tool execution and request history belong to the assistant.
    async fn turn(
        &self,
        _request: &turn::TurnRequest,
    ) -> Result<turn::TurnResponse, ProviderError> {
        Err(ProviderError::Rejected)
    }
}

/// Server configuration only; deliberately not part of the HTTP/OpenAPI schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Aitunnel,
    Codex,
}

impl ProviderKind {
    pub fn build(self) -> Result<Arc<dyn Provider>, ProviderError> {
        match self {
            Self::Aitunnel => Ok(Arc::new(aitunnel::Aitunnel::from_env()?)),
            Self::Codex => Ok(Arc::new(codex::Codex::local()?)),
        }
    }
}

/// Deliberately carries no upstream body, prompt, credential, or request headers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderError {
    AuthRequired,
    RateLimited,
    Rejected,
    Timeout,
    Unavailable,
    InvalidResponse,
    Incomplete,
    ResponseTooLarge,
}

impl ProviderError {
    pub fn code(self) -> &'static str {
        match self {
            Self::AuthRequired => "provider_auth_required",
            Self::RateLimited => "provider_rate_limited",
            Self::Rejected => "provider_rejected_request",
            Self::Timeout => "provider_timeout",
            Self::Unavailable => "provider_unavailable",
            Self::InvalidResponse => "provider_invalid_response",
            Self::Incomplete => "provider_incomplete_response",
            Self::ResponseTooLarge => "provider_response_too_large",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::AuthRequired => {
                "Provider credentials are missing, invalid or expired. Check the server configuration."
            }
            Self::RateLimited => {
                "The provider's balance, usage or rate limit was reached. Check the account before retrying."
            }
            Self::Rejected => {
                "The provider rejected the request. Check model access and supported options."
            }
            Self::Timeout => "The model did not finish before the request timeout.",
            Self::Unavailable => "The model provider is unavailable.",
            Self::InvalidResponse => "The provider returned an unexpected response.",
            Self::Incomplete => {
                "The provider did not complete the response. No partial result was returned."
            }
            Self::ResponseTooLarge => "The provider response exceeded the size limit.",
        }
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for ProviderError {}
