use serde::Serialize;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use utoipa::ToSchema;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema, sqlx::Type)]
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
    pub audio_requests_used: i64,
    pub assist_requests_used: i64,
}

pub async fn get(pool: &PgPool, user_id: &str) -> Result<Subscription, sqlx::Error> {
    sqlx::query_as(
        "SELECT tier,assist_requests_remaining,audio_requests_used,assist_requests_used FROM subscriptions WHERE user_id=$1::uuid",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
}

#[derive(Debug)]
pub enum ReserveError {
    Exhausted,
    AudioRequiresPlan,
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

/// Keep usage accounting uncommitted until the model finishes. Dropping the transaction
/// rolls back failures, cancelled handlers and server crashes. The separate row
/// avoids blocking profile reads or password changes while the model runs.
pub struct Reservation(Transaction<'static, Postgres>);
impl Reservation {
    pub async fn begin(pool: &PgPool, user_id: &str) -> Result<Self, ReserveError> {
        Self::begin_request(pool, user_id, false).await
    }

    pub async fn begin_request(
        pool: &PgPool,
        user_id: &str,
        audio: bool,
    ) -> Result<Self, ReserveError> {
        let mut tx = pool.begin().await?;
        let subscription: Subscription = sqlx::query_as(
            "SELECT tier,assist_requests_remaining,audio_requests_used,assist_requests_used FROM subscriptions WHERE user_id=$1::uuid FOR UPDATE NOWAIT",
        ).bind(user_id).fetch_one(&mut *tx).await?;
        if audio && subscription.tier == Tier::Free {
            return Err(ReserveError::AudioRequiresPlan);
        }
        if !audio && subscription.tier == Tier::Free && subscription.assist_requests_remaining <= 0
        {
            return Err(ReserveError::Exhausted);
        }
        let update = if audio {
            "UPDATE subscriptions SET audio_requests_used=audio_requests_used+1 WHERE user_id=$1::uuid"
        } else if subscription.tier == Tier::Free {
            "UPDATE subscriptions SET assist_requests_remaining=assist_requests_remaining-1,assist_requests_used=assist_requests_used+1 WHERE user_id=$1::uuid"
        } else {
            "UPDATE subscriptions SET assist_requests_used=assist_requests_used+1 WHERE user_id=$1::uuid"
        };
        sqlx::query(update).bind(user_id).execute(&mut *tx).await?;
        Ok(Self(tx))
    }

    pub async fn commit(self) -> Result<(), sqlx::Error> {
        self.0.commit().await
    }
}
