mod limits;
mod password;
mod session;

use crate::users::{self, Profile, User};
use axum::{
    Json, Router,
    extract::Request,
    extract::{DefaultBodyLimit, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

#[derive(Clone)]
pub struct Auth {
    pool: PgPool,
    slots: Arc<Semaphore>,
    dummy_hash: Arc<String>,
}

impl Auth {
    pub async fn new(pool: PgPool) -> Result<Self, Error> {
        let dummy_hash =
            tokio::task::spawn_blocking(|| password::hash("unused dummy password for timing"))
                .await
                .map_err(|_| Error::internal())??;
        Ok(Self {
            pool,
            slots: Arc::new(Semaphore::new(2)),
            dummy_hash: Arc::new(dummy_hash),
        })
    }

    async fn admit(&self) -> Result<tokio::sync::OwnedSemaphorePermit, Error> {
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::limited())?;
        limits::check(&self.pool, "global", "auth", 240).await?;
        Ok(permit)
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct Error {
    pub code: &'static str,
    pub message: &'static str,
    #[serde(skip)]
    pub(crate) status: StatusCode,
}
impl Error {
    fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }
    fn internal() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "accounts_unavailable",
            "Accounts are temporarily unavailable.",
        )
    }
    fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "authentication_required",
            "Please sign in again.",
        )
    }
    fn invalid_login() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "Incorrect username or password.",
        )
    }
    fn invalid() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "invalid_account_request",
            "Use a username of 3–32 lowercase letters, digits or underscores and a password of 12–128 characters.",
        )
    }
    fn limited() -> Self {
        Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            "auth_rate_limited",
            "Too many attempts. Try again in 15 minutes.",
        )
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for Error {}
impl From<sqlx::Error> for Error {
    fn from(_: sqlx::Error) -> Self {
        Self::internal()
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let limited = self.status == StatusCode::TOO_MANY_REQUESTS;
        let mut response = (self.status, Json(self)).into_response();
        if limited {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, "900".parse().unwrap());
        }
        response
    }
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ChangePassword {
    pub current_password: String,
    pub new_password: String,
}
#[derive(Serialize, ToSchema)]
pub struct SignedIn {
    pub user: Profile,
    pub token: String,
}

fn token(headers: &HeaderMap) -> Result<&str, Error> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| !v.is_empty())
        .ok_or_else(Error::unauthorized)
}
pub(crate) async fn authenticate(pool: &PgPool, headers: &HeaderMap) -> Result<String, Error> {
    Ok(session::user(pool, token(headers)?).await?.id)
}

fn body<T>(value: Result<Json<T>, JsonRejection>) -> Result<T, Error> {
    value.map(|Json(v)| v).map_err(|e| {
        if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
            Error::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_too_large",
                "Account request is too large.",
            )
        } else {
            Error::invalid()
        }
    })
}

fn routes() -> (Router<Auth>, utoipa::openapi::OpenApi) {
    OpenApiRouter::new()
        .routes(routes!(register))
        .routes(routes!(login))
        .routes(routes!(logout))
        .routes(routes!(profile))
        .routes(routes!(change_password))
        .split_for_parts()
}
pub fn openapi() -> utoipa::openapi::OpenApi {
    let mut spec = routes().1;
    spec.components
        .get_or_insert_with(Default::default)
        .add_security_scheme(
            "session",
            utoipa::openapi::security::SecurityScheme::Http(utoipa::openapi::security::Http::new(
                utoipa::openapi::security::HttpAuthScheme::Bearer,
            )),
        );
    spec
}
pub fn router(auth: Auth) -> Router {
    routes()
        .0
        .layer(DefaultBodyLimit::max(4096))
        .layer(middleware::from_fn(no_store))
        .with_state(auth)
}
async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

/// Create an account; username is exact and is never silently normalized.
#[utoipa::path(post, path="/auth/register", request_body(content=Credentials, example=json!({"username":"music_maker","password":"choose a long password"})), responses((status=201,body=SignedIn),(status=400,body=Error),(status=409,body=Error),(status=429,body=Error),(status=503,body=Error)))]
async fn register(
    State(auth): State<Auth>,
    request: Result<Json<Credentials>, JsonRejection>,
) -> Result<(StatusCode, Json<SignedIn>), Error> {
    let request = body(request)?;
    if !users::valid_username(&request.username) || !password::valid(&request.password) {
        return Err(Error::invalid());
    }
    let permit = auth.admit().await?;
    limits::check(&auth.pool, "register", "global", 20).await?;
    let hash = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        password::hash(&request.password)
    })
    .await
    .map_err(|_| Error::internal())??;
    let mut tx = auth.pool.begin().await?;
    let user: User = sqlx::query_as("INSERT INTO users (username,password_hash) VALUES ($1,$2) RETURNING id::text,username,password_hash,created_at")
        .bind(request.username).bind(hash).fetch_one(&mut *tx).await.map_err(|error| {
            if error.as_database_error().is_some_and(|e| e.is_unique_violation()) { Error::new(StatusCode::CONFLICT, "username_taken", "This username is already taken.") }
            else { error.into() }
        })?;
    let token = session::create(&mut tx, &user.id).await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(SignedIn {
            user: user.profile(&auth.pool).await?,
            token,
        }),
    ))
}

#[utoipa::path(post, path="/auth/login", request_body(content=Credentials, example=json!({"username":"music_maker","password":"choose a long password"})), responses((status=200,body=SignedIn),(status=401,body=Error),(status=429,body=Error),(status=503,body=Error)))]
async fn login(
    State(auth): State<Auth>,
    request: Result<Json<Credentials>, JsonRejection>,
) -> Result<Json<SignedIn>, Error> {
    let request = body(request)?;
    if !users::valid_username(&request.username) || !password::valid(&request.password) {
        return Err(Error::invalid_login());
    }
    let permit = auth.admit().await?;
    limits::check(&auth.pool, "login", &request.username, 10).await?;
    let user = users::by_username(&auth.pool, &request.username).await?;
    let hash = user
        .as_ref()
        .map(|u| u.password_hash.clone())
        .unwrap_or_else(|| auth.dummy_hash.to_string());
    let valid = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        password::verify(&request.password, &hash)
    })
    .await
    .map_err(|_| Error::internal())?;
    let user = user.filter(|_| valid).ok_or_else(Error::invalid_login)?;
    let mut tx = auth.pool.begin().await?;
    // Serialize session creation against password changes, including a concurrent verification.
    let current: Option<String> = sqlx::query_scalar(
        "SELECT id::text FROM users WHERE id=$1::uuid AND password_hash=$2 FOR UPDATE",
    )
    .bind(&user.id)
    .bind(&user.password_hash)
    .fetch_optional(&mut *tx)
    .await?;
    if current.is_none() {
        return Err(Error::invalid_login());
    }
    let token = session::create(&mut tx, &user.id).await?;
    tx.commit().await?;
    Ok(Json(SignedIn {
        user: user.profile(&auth.pool).await?,
        token,
    }))
}

#[utoipa::path(get, path="/users/me", security(("session"=[])), responses((status=200,body=Profile),(status=401,body=Error),(status=503,body=Error)))]
async fn profile(State(auth): State<Auth>, headers: HeaderMap) -> Result<Json<Profile>, Error> {
    Ok(Json(
        session::user(&auth.pool, token(&headers)?)
            .await?
            .profile(&auth.pool)
            .await?,
    ))
}

#[utoipa::path(post, path="/auth/logout", security(("session"=[])), responses((status=204,description="Session revoked"),(status=401,body=Error),(status=503,body=Error)))]
async fn logout(State(auth): State<Auth>, headers: HeaderMap) -> Result<StatusCode, Error> {
    sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
        .bind(session::digest(token(&headers)?))
        .execute(&auth.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Revoke all previous sessions and return a replacement for the current device.
#[utoipa::path(post, path="/users/me/password", security(("session"=[])), request_body(content=ChangePassword, example=json!({"current_password":"choose a long password","new_password":"choose another long password"})), responses((status=200,body=SignedIn),(status=400,body=Error),(status=401,body=Error),(status=429,body=Error),(status=503,body=Error)))]
async fn change_password(
    State(auth): State<Auth>,
    headers: HeaderMap,
    request: Result<Json<ChangePassword>, JsonRejection>,
) -> Result<Json<SignedIn>, Error> {
    let request = body(request)?;
    if !password::valid(&request.current_password) || !password::valid(&request.new_password) {
        return Err(Error::invalid());
    }
    let user = session::user(&auth.pool, token(&headers)?).await?;
    let permit = auth.admit().await?;
    limits::check(&auth.pool, "password", &user.id, 10).await?;
    let original_hash = user.password_hash.clone();
    let hash = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if !password::verify(&request.current_password, &original_hash) {
            return Err(Error::invalid_login());
        }
        password::hash(&request.new_password)
    })
    .await
    .map_err(|_| Error::internal())??;
    let mut tx = auth.pool.begin().await?;
    let current: Option<String> = sqlx::query_scalar(
        "SELECT id::text FROM users WHERE id=$1::uuid AND password_hash=$2 FOR UPDATE",
    )
    .bind(&user.id)
    .bind(&user.password_hash)
    .fetch_optional(&mut *tx)
    .await?;
    if current.is_none() {
        return Err(Error::unauthorized());
    }
    let active: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND expires_at>now())",
    )
    .bind(session::digest(token(&headers)?))
    .fetch_one(&mut *tx)
    .await?;
    if !active {
        return Err(Error::unauthorized());
    }
    sqlx::query("UPDATE users SET password_hash=$1 WHERE id=$2::uuid")
        .bind(hash)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id=$1::uuid")
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    let token = session::create(&mut tx, &user.id).await?;
    tx.commit().await?;
    Ok(Json(SignedIn {
        user: user.profile(&auth.pool).await?,
        token,
    }))
}

pub fn start_cleanup(pool: PgPool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3600));
        loop {
            interval.tick().await;
            for statement in [
                "DELETE FROM sessions WHERE expires_at<=now()",
                "DELETE FROM auth_limits WHERE expires_at<=now()",
            ] {
                if sqlx::query(statement).execute(&pool).await.is_err() {
                    tracing::warn!("Account cleanup failed");
                }
            }
        }
    })
}
