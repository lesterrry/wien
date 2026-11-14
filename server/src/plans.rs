use serde::Serialize;
use sqlx::{FromRow, PgPool};
use utoipa::ToSchema;

/// Public catalog and access policy. Prices use the currency's minor units.
#[derive(Clone, Serialize, FromRow, ToSchema)]
pub struct Plan {
    pub id: String,
    pub name: String,
    pub description: String,
    pub features: Vec<String>,
    pub price_minor: i64,
    pub currency: String,
    pub currency_minor_units: i16,
    pub billing_period: String,
    /// Requests granted at registration (free) or activation of a paid period. Null means unlimited.
    pub initial_assist_requests: Option<i32>,
    pub audio_enabled: bool,
    pub is_default: bool,
    pub ai_usage_multiplier: Option<i32>,
    pub name_ru: Option<String>,
    pub description_ru: Option<String>,
    pub features_ru: Option<Vec<String>>,
}

pub async fn list(pool: &PgPool) -> Result<Vec<Plan>, sqlx::Error> {
    sqlx::query_as("SELECT * FROM plans WHERE visible ORDER BY display_order, id")
        .fetch_all(pool)
        .await
}

pub async fn get(pool: &PgPool, id: &str) -> Result<Plan, sqlx::Error> {
    // Hidden plans remain available to their existing subscribers.
    sqlx::query_as("SELECT * FROM plans WHERE id=$1")
        .bind(id)
        .fetch_one(pool)
        .await
}
