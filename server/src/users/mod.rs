use serde::Serialize;
use sqlx::{FromRow, PgPool};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use utoipa::ToSchema;

#[derive(Serialize, ToSchema)]
pub struct Profile {
    pub id: String,
    pub username: String,
    pub created_at: String,
    pub tier: crate::subscriptions::Tier,
    pub assist_requests_remaining: i32,
}

#[derive(FromRow)]
pub(crate) struct User {
    pub id: String,
    pub username: String,
    pub password_hash: String,
    pub created_at: OffsetDateTime,
}

impl User {
    pub async fn profile(&self, pool: &PgPool) -> Result<Profile, sqlx::Error> {
        let subscription = crate::subscriptions::get(pool, &self.id).await?;
        Ok(Profile {
            tier: subscription.tier,
            assist_requests_remaining: subscription.assist_requests_remaining,
            id: self.id.clone(),
            username: self.username.clone(),
            created_at: self
                .created_at
                .format(&Rfc3339)
                .expect("valid database timestamp"),
        })
    }
}

pub(crate) async fn by_username(
    pool: &PgPool,
    username: &str,
) -> Result<Option<User>, sqlx::Error> {
    sqlx::query_as(
        "SELECT id::text, username, password_hash, created_at FROM users WHERE username=$1",
    )
    .bind(username)
    .fetch_optional(pool)
    .await
}

pub fn valid_username(value: &str) -> bool {
    (3..=32).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}
