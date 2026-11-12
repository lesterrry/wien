use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use tokio::sync::Semaphore;
use utoipa::ToSchema;
use utoipa::openapi::{Info, OpenApi, Server};
use utoipa_axum::{router::OpenApiRouter, routes};
use utoipa_swagger_ui::SwaggerUi;

use crate::assistant::{
    self, AssistRequest, AssistResponse, error::AssistError, tools::AssistantTools,
};
use crate::config::GenerationConfig;
use crate::providers::{Provider, ProviderError};

const MAX_ACTIVE_ASSISTS: usize = 4;

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

impl From<crate::auth::Error> for ApiError {
    fn from(error: crate::auth::Error) -> Self {
        Self::new(error.status, error.code, error.message)
    }
}
impl From<crate::subscriptions::ReserveError> for ApiError {
    fn from(error: crate::subscriptions::ReserveError) -> Self {
        use crate::subscriptions::ReserveError;
        match error {
            ReserveError::Exhausted => Self::new(
                StatusCode::PAYMENT_REQUIRED,
                "assist_quota_exhausted",
                "You have used all your assist requests. Explore subscription plans.",
            ),
            ReserveError::Busy => Self::new(
                StatusCode::TOO_MANY_REQUESTS,
                "assistant_busy",
                "An assistant request is already running for this account.",
            ),
            ReserveError::Database(_) => Self::database(),
        }
    }
}
impl ApiError {
    fn database() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "accounts_unavailable",
            "Accounts are temporarily unavailable.",
        )
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

impl From<AssistError> for ApiError {
    fn from(error: AssistError) -> Self {
        match error {
            AssistError::Provider(error) => error.into(),
            AssistError::Tool(error) => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                error.code(),
                error.message(),
            ),
            AssistError::Limit => Self::new(
                StatusCode::BAD_GATEWAY,
                "assistant_limit",
                "Assistant tool or context budget exceeded. Try a narrower request.",
            ),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let busy = self.code == "assistant_busy";
        let mut response = (self.status, Json(self)).into_response();
        if busy {
            response.headers_mut().insert(
                axum::http::header::RETRY_AFTER,
                axum::http::HeaderValue::from_static("2"),
            );
        }
        response
    }
}

#[derive(Clone)]
struct AppState {
    provider: Arc<dyn Provider>,
    generation: Arc<GenerationConfig>,
    tools: Arc<dyn AssistantTools>,
    assist_slots: Arc<Semaphore>,
    database: Option<sqlx::PgPool>,
}

fn documented_routes() -> (Router<AppState>, OpenApi) {
    let (router, mut spec) = OpenApiRouter::new()
        .routes(routes!(assist))
        .routes(routes!(health))
        .routes(routes!(ready))
        .split_for_parts();
    spec.merge(crate::auth::openapi());
    spec.info = Info::new("Wien AI server", env!("CARGO_PKG_VERSION"));
    spec.servers = Some(vec![Server::new("/")]);
    (router, spec)
}

/// The same contract as /openapi.json, without config, credentials, or a listening server.
pub fn openapi() -> OpenApi {
    documented_routes().1
}

pub fn router(
    provider: Arc<dyn Provider>,
    generation: GenerationConfig,
    tools: Arc<dyn AssistantTools>,
) -> Router {
    router_with_database(provider, generation, tools, None)
}

pub fn router_with_database(
    provider: Arc<dyn Provider>,
    generation: GenerationConfig,
    tools: Arc<dyn AssistantTools>,
    database: Option<sqlx::PgPool>,
) -> Router {
    let (router, spec) = documented_routes();
    router
        .merge(SwaggerUi::new("/docs").url("/openapi.json", spec))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .with_state(AppState {
            provider,
            tools,
            database,
            generation: Arc::new(generation),
            assist_slots: Arc::new(Semaphore::new(MAX_ACTIVE_ASSISTS)),
        })
}

/// Check server health without calling the model.
#[utoipa::path(get, path = "/health", responses((status = 200, description = "Server is running; does not probe model authentication", body = String, content_type = "text/plain")))]
async fn health() -> &'static str {
    "ok"
}

#[derive(Serialize, ToSchema)]
pub struct Readiness {
    ready: bool,
}

/// Dependency readiness without a paid model or embedding request.
#[utoipa::path(get, path = "/ready", responses(
    (status = 200, description = "PostgreSQL and RAG corpus ready; external APIs are not probed", body = Readiness),
    (status = 503, description = "PostgreSQL or RAG unavailable, or corpus not ready", body = ApiError)
))]
async fn ready(State(state): State<AppState>) -> Result<Json<Readiness>, ApiError> {
    if let Some(database) = &state.database {
        sqlx::query("SELECT 1")
            .execute(database)
            .await
            .map_err(|_| {
                ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "database_unavailable",
                    "PostgreSQL is unavailable.",
                )
            })?;
    }
    let corpus = state
        .tools
        .call("strudel_rag_get_corpus_info", serde_json::json!({}))
        .await
        .map_err(AssistError::from)?;
    if corpus["ready"] != true {
        return Err(AssistError::from(assistant::tools::ToolError::NotReady).into());
    }
    Ok(Json(Readiness { ready: true }))
}

fn check_local(headers: &HeaderMap) -> Result<(), ApiError> {
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
    Ok(())
}

fn parse_body<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    body.map(|Json(request)| request).map_err(|error| {
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
                "Expected application/json matching the request schema.",
            )
        }
    })
}

/// Ask the editor assistant; selection is context, edits replace the entire current file.
#[utoipa::path(
    post, path = "/v1/assist",
    security(("session"=[])),
    request_body(content = AssistRequest, example = json!({
        "prompt": "Make the bass softer. Reply briefly.",
        "file": {"path": "first-light.strudel", "content": "note(\"a1\").s(\"sawtooth\").gain(0.2)", "cursor": {"anchor": 0, "head": 10}}
    })),
    responses(
        (status = 200, description = "Short answer and optional complete replacement code", body = AssistResponse),
        (status = 400, description = "Invalid prompt, file or cursor offsets", body = ApiError),
        (status = 401, description = "Sign in required", body = ApiError),
        (status = 402, description = "Assist allowance exhausted", body = ApiError),
        (status = 413, description = "Request body too large", body = ApiError),
        (status = 429, description = "Assistant busy (assistant_busy, Retry-After: 2) or provider usage limit", body = ApiError),
        (status = 502, description = "Invalid or incomplete model response", body = ApiError),
        (status = 503, description = "Codex login or RAG unavailable; retrieval index may not be ready", body = ApiError),
        (status = 504, description = "Provider timeout", body = ApiError)
    )
)]
async fn assist(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<AssistRequest>, JsonRejection>,
) -> Result<Json<AssistResponse>, ApiError> {
    let user_id = if let Some(database) = &state.database {
        Some(crate::auth::authenticate(database, &headers).await?)
    } else {
        // The database-free router is only used by isolated provider tests.
        check_local(&headers)?;
        None
    };
    let request = parse_body(body)?;
    if !request.is_valid() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Expected a prompt up to 16 KiB, file content up to 128 KiB, and valid UTF-16 cursor offsets.",
        ));
    }
    // Reject before any RAG/model work, so only this error is safe to retry.
    // The permit is released on success, failure, timeout, or handler cancellation.
    let _permit = state.assist_slots.try_acquire().map_err(|_| {
        ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "assistant_busy",
            "The assistant is busy. Try again shortly.",
        )
    })?;
    let reservation = match (&state.database, user_id.as_deref()) {
        (Some(database), Some(user_id)) => {
            Some(crate::subscriptions::Reservation::begin(database, user_id).await?)
        }
        _ => None,
    };
    let response = assistant::send(
        state.provider.as_ref(),
        &state.generation,
        state.tools.as_ref(),
        &request,
    )
    .await?;
    if let Some(reservation) = reservation {
        reservation
            .commit()
            .await
            .map_err(|_| ApiError::database())?;
    }
    Ok(Json(response))
}
