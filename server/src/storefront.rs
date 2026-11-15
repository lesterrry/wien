use serde::Serialize;
use sqlx::{FromRow, PgPool};
use utoipa::ToSchema;

/// One public response for the subscription dialog. Never includes payment credentials.
#[derive(Serialize, ToSchema)]
pub struct Storefront {
    pub plans: Vec<crate::plans::Plan>,
    pub seller: Seller,
    pub terms: Terms,
    pub payments: PaymentSettings,
}
#[derive(Serialize, ToSchema)]
pub struct Seller {
    pub name: String,
    pub inn: String,
    pub city: String,
    pub support_email: String,
    pub support_phone: Option<String>,
}
#[derive(Serialize, ToSchema)]
pub struct Terms {
    pub accounts_location: String,
    pub document_version: String,
    pub documents_published: bool,
    pub renewal_mode: String,
    pub ai_usage_policy: String,
}
#[derive(Serialize, ToSchema)]
pub struct PaymentSettings {
    pub mode: crate::payments::Mode,
}
#[derive(FromRow)]
struct Details {
    seller_name: String,
    seller_inn: String,
    seller_city: String,
    support_email: String,
    support_phone: Option<String>,
    accounts_location: String,
    document_version: String,
    documents_published: bool,
    renewal_mode: String,
    ai_usage_policy: String,
}
pub async fn get(pool: &PgPool, mode: crate::payments::Mode) -> Result<Storefront, sqlx::Error> {
    let mut tx = pool.begin().await?;
    // Both tables must describe the same database snapshot during a catalog update.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    let plans = crate::plans::list(&mut *tx).await?;
    let details = sqlx::query_as::<_, Details>("SELECT * FROM storefront WHERE singleton")
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Storefront {
        plans,
        seller: Seller {
            name: details.seller_name,
            inn: details.seller_inn,
            city: details.seller_city,
            support_email: details.support_email,
            support_phone: details.support_phone,
        },
        terms: Terms {
            accounts_location: details.accounts_location,
            document_version: details.document_version,
            documents_published: details.documents_published,
            renewal_mode: details.renewal_mode,
            ai_usage_policy: details.ai_usage_policy,
        },
        payments: PaymentSettings { mode },
    })
}
