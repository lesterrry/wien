use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};
use utoipa_swagger_ui::SwaggerUi;

use crate::providers::{ModelOptions, ModelResponse, Provider, ProviderError};

const MAX_TEXT_BYTES: usize = 128 * 1024;

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct GenerateRequest {
    pub text: String,
    pub options: ModelOptions,
}

#[derive(Serialize, ToSchema)]
pub struct ApiError {
    pub code: &'static str,
    pub message: &'static str,
    #[serde(skip)]
    status: StatusCode,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }
}

impl From<ProviderError> for ApiError {
    fn from(error: ProviderError) -> Self {
        let status = match error {
            ProviderError::AuthRequired => StatusCode::SERVICE_UNAVAILABLE,
            ProviderError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            ProviderError::Timeout => StatusCode::GATEWAY_TIMEOUT,
            _ => StatusCode::BAD_GATEWAY,
        };
        Self::new(status, error.code(), error.message())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self)).into_response()
    }
}

pub fn router(provider: Arc<dyn Provider>) -> Router {
    let (router, mut spec) = OpenApiRouter::new()
        .routes(routes!(generate))
        .routes(routes!(health))
        .split_for_parts();
    spec.info.title = "Wien local AI server".into();
    spec.info.version = env!("CARGO_PKG_VERSION").into();
    router
        .merge(SwaggerUi::new("/docs").url("/openapi.json", spec))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .with_state(provider)
}

#[utoipa::path(get, path = "/health", responses((status = 200, description = "Server is running; does not probe model authentication", body = String)))]
async fn health() -> &'static str {
    "ok"
}

#[utoipa::path(
    post, path = "/v1/generate", request_body = GenerateRequest,
    responses(
        (status = 200, description = "Completed model response", body = ModelResponse),
        (status = 400, description = "Invalid JSON, text, model, or options", body = ApiError),
        (status = 403, description = "Non-local browser origin", body = ApiError),
        (status = 413, description = "Request body too large", body = ApiError),
        (status = 429, description = "Provider usage limit", body = ApiError),
        (status = 502, description = "Upstream error or incomplete response", body = ApiError),
        (status = 503, description = "Local Codex login required", body = ApiError),
        (status = 504, description = "Provider timeout", body = ApiError)
    )
)]
async fn generate(
    State(provider): State<Arc<dyn Provider>>,
    headers: HeaderMap,
    body: Result<Json<GenerateRequest>, JsonRejection>,
) -> Result<Json<ModelResponse>, ApiError> {
    // No CORS allowance. Also reject DNS-rebinding hosts and cross-origin browser requests.
    let host = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let host_name = host.split(':').next().unwrap_or_default();
    let origin_ok = headers.get("origin").is_none_or(|origin| {
        origin
            .to_str()
            .ok()
            .is_some_and(|origin| origin == format!("http://{host}"))
    });
    if !matches!(host_name, "localhost" | "127.0.0.1") || !origin_ok {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "local_requests_only",
            "Only local requests are accepted.",
        ));
    }
    let Json(request) = body.map_err(|error| {
        if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_too_large",
                "The JSON body exceeds 256 KiB.",
            )
        } else {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Expected application/json with text and supported model options.",
            )
        }
    })?;
    if request.text.trim().is_empty()
        || request.text.len() > MAX_TEXT_BYTES
        || request.options.model.trim().is_empty()
        || request.options.model.len() > 200
        || request
            .options
            .instructions
            .as_ref()
            .is_some_and(|value| value.len() > MAX_TEXT_BYTES)
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Text must be nonempty and at most 128 KiB; model must be 1–200 bytes; instructions at most 128 KiB.",
        ));
    }
    let response = provider.send(&request.text, &request.options).await?;
    Ok(Json(response))
}
