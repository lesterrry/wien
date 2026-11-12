use super::Error;
use sha2::{Digest, Sha256};
use sqlx::PgPool;

pub async fn check(pool: &PgPool, scope: &str, value: &str, maximum: i32) -> Result<(), Error> {
    let key = format!("{scope}:{:x}", Sha256::digest(value.as_bytes()));
    let attempts: i32 = sqlx::query_scalar("INSERT INTO auth_limits (key,attempts,expires_at) VALUES ($1,1,now()+interval '15 minutes') ON CONFLICT (key) DO UPDATE SET attempts=CASE WHEN auth_limits.expires_at<=now() THEN 1 ELSE auth_limits.attempts+1 END, expires_at=CASE WHEN auth_limits.expires_at<=now() THEN now()+interval '15 minutes' ELSE auth_limits.expires_at END RETURNING attempts")
        .bind(key).fetch_one(pool).await?;
    if attempts > maximum {
        return Err(Error::limited());
    }
    Ok(())
}
