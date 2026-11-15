use sqlx::{FromRow, PgPool, Postgres, Transaction};

#[derive(FromRow)]
pub struct Subscription {
    pub tier: String,
    pub assist_requests_remaining: i32,
    pub audio_requests_used: i64,
    pub assist_requests_used: i64,
}

pub async fn get(pool: &PgPool, user_id: &str) -> Result<Subscription, sqlx::Error> {
    sqlx::query_as(
        "SELECT tier,CASE WHEN period_ends_at <= now() THEN 0 ELSE assist_requests_remaining END AS assist_requests_remaining,audio_requests_used,assist_requests_used FROM subscriptions WHERE user_id=$1::uuid",
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
        let (remaining, allowance, audio_enabled, expired): (i32, Option<i32>, bool, bool) = sqlx::query_as(
            "SELECT s.assist_requests_remaining,COALESCE(s.period_request_limit,p.initial_assist_requests),COALESCE(s.period_audio_enabled,p.audio_enabled),COALESCE(s.period_ends_at <= now(), false) FROM subscriptions s JOIN plans p ON p.id=s.tier WHERE s.user_id=$1::uuid FOR UPDATE OF s NOWAIT",
        ).bind(user_id).fetch_one(&mut *tx).await?;
        if audio && !audio_enabled {
            // A rejected request must release its lock before the caller can retry.
            // Transaction::drop only queues rollback and can cause a spurious Busy.
            tx.rollback().await?;
            return Err(ReserveError::AudioRequiresPlan);
        }
        if expired || (allowance.is_some() && remaining <= 0) {
            tx.rollback().await?;
            return Err(ReserveError::Exhausted);
        }
        sqlx::query("UPDATE subscriptions SET assist_requests_remaining=CASE WHEN $2 THEN assist_requests_remaining-1 ELSE assist_requests_remaining END, assist_requests_used=assist_requests_used+1, audio_requests_used=audio_requests_used+CASE WHEN $3 THEN 1 ELSE 0 END WHERE user_id=$1::uuid")
            .bind(user_id).bind(allowance.is_some()).bind(audio).execute(&mut *tx).await?;
        Ok(Self(tx))
    }

    pub async fn commit(self) -> Result<(), sqlx::Error> {
        self.0.commit().await
    }
}
