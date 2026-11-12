use serde::Serialize;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use utoipa::ToSchema;

#[derive(Clone, Copy, Debug, Serialize, ToSchema, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "text", rename_all = "lowercase")]
pub enum Tier {
    Free,
    Plus,
    Pro,
    Ultra,
}

#[derive(FromRow)]
pub struct Subscription {
    pub tier: Tier,
    pub assist_requests_remaining: i32,
}

pub async fn get(pool: &PgPool, user_id: &str) -> Result<Subscription, sqlx::Error> {
    sqlx::query_as(
        "SELECT tier,assist_requests_remaining FROM subscriptions WHERE user_id=$1::uuid",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
}

#[derive(Debug)]
pub enum ReserveError {
    Exhausted,
    Busy,
    Database(sqlx::Error),
}
impl From<sqlx::Error> for ReserveError {
    fn from(error: sqlx::Error) -> Self {
        if error
            .as_database_error()
            .is_some_and(|e| e.code().as_deref() == Some("55P03"))
        {
            Self::Busy
        } else {
            Self::Database(error)
        }
    }
}

/// Keep one credit reserved until the model finishes. Dropping the transaction
/// rolls back failures, cancelled handlers and server crashes. The separate row
/// avoids blocking profile reads or password changes while the model runs.
pub struct Reservation(Transaction<'static, Postgres>);
impl Reservation {
    pub async fn begin(pool: &PgPool, user_id: &str) -> Result<Self, ReserveError> {
        let mut tx = pool.begin().await?;
        let remaining: i32 = sqlx::query_scalar(
            "SELECT assist_requests_remaining FROM subscriptions WHERE user_id=$1::uuid FOR UPDATE NOWAIT",
        ).bind(user_id).fetch_one(&mut *tx).await?;
        if remaining <= 0 {
            return Err(ReserveError::Exhausted);
        }
        sqlx::query("UPDATE subscriptions SET assist_requests_remaining=assist_requests_remaining-1 WHERE user_id=$1::uuid")
            .bind(user_id).execute(&mut *tx).await?;
        Ok(Self(tx))
    }

    pub async fn commit(self) -> Result<(), sqlx::Error> {
        self.0.commit().await
    }
}
