pub mod config;
mod orders;
mod routes;

use axum::{
    Json,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::sync::Arc;
use utoipa::ToSchema;

pub use routes::{openapi, router};
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Disabled,
    Test,
    Live,
}
#[derive(Clone)]
pub struct Payments {
    pub pool: PgPool,
    pub config: Option<Arc<crate::robokassa::Config>>,
}
impl Payments {
    pub fn new(pool: PgPool, config: Option<crate::robokassa::Config>) -> Self {
        Self {
            pool,
            config: config.map(Arc::new),
        }
    }
    pub fn mode(&self) -> Mode {
        self.config.as_ref().map_or(Mode::Disabled, |c| c.mode)
    }
    async fn allowed(&self, user: &str) -> Result<bool, Error> {
        let Some(config) = &self.config else {
            return Ok(false);
        };
        if config.mode == Mode::Live {
            return Ok(true);
        }
        let username: String = sqlx::query_scalar("SELECT username FROM users WHERE id=$1::uuid")
            .bind(user)
            .fetch_one(&self.pool)
            .await?;
        Ok(config.test_users.contains(&username))
    }
}
#[derive(Debug, Serialize, ToSchema)]
pub struct Error {
    pub code: &'static str,
    pub message: &'static str,
    #[serde(skip)]
    status: StatusCode,
}
impl Error {
    fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }
    fn invalid() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "invalid_payment_request",
            "Некорректные параметры платежа.",
        )
    }
    fn disabled() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "payments_unavailable",
            "Оплата пока недоступна.",
        )
    }
    fn missing() -> Self {
        Self::new(StatusCode::NOT_FOUND, "order_not_found", "Заказ не найден.")
    }
    fn conflict(code: &'static str, message: &'static str) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }
}
impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        let code = error.as_database_error().and_then(|error| error.code());
        tracing::error!(
            sqlstate = code.as_deref(),
            "Payment database operation failed"
        );
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "payments_unavailable",
            "Не удалось обработать платёж. Попробуйте позже.",
        )
    }
}
impl From<crate::auth::Error> for Error {
    fn from(e: crate::auth::Error) -> Self {
        Self::new(e.status, e.code, e.message)
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let mut response = (self.status, Json(&self)).into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        response
    }
}
