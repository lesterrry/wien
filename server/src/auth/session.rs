use super::Error;
use crate::users::User;
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool};

pub fn digest(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub async fn create(connection: &mut PgConnection, user_id: &str) -> Result<String, Error> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| Error::internal())?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    sqlx::query("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2::uuid,now()+interval '30 days')")
        .bind(digest(&token)).bind(user_id).execute(connection).await?;
    Ok(token)
}

pub async fn user(pool: &PgPool, token: &str) -> Result<User, Error> {
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::unauthorized());
    }
    sqlx::query_as("SELECT u.id::text,u.username,u.password_hash,u.created_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()")
        .bind(digest(token)).fetch_optional(pool).await?.ok_or_else(Error::unauthorized)
}
