use serde::Serialize;
use sqlx::{FromRow, PgPool};
use utoipa::ToSchema;

/// Public seller details and purchase terms. Payment credentials are never exposed.
#[derive(Serialize, FromRow, ToSchema)]
pub struct Storefront {
    pub seller_name: String,
    pub seller_inn: String,
    pub seller_city: String,
    pub support_email: String,
    pub support_phone: Option<String>,
    pub accounts_location: String,
    pub document_version: String,
    pub documents_published: bool,
    pub renewal_mode: String,
    pub ai_usage_policy: String,
}

pub async fn get(pool: &PgPool) -> Result<Storefront, sqlx::Error> {
    sqlx::query_as("SELECT seller_name,seller_inn,seller_city,support_email,support_phone,accounts_location,document_version,documents_published,renewal_mode,ai_usage_policy FROM storefront WHERE singleton")
        .fetch_one(pool)
        .await
}
