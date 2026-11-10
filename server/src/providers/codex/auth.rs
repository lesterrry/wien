use std::path::PathBuf;

use reqwest::header::HeaderValue;
use serde::Deserialize;
use tokio::io::AsyncReadExt;

use crate::providers::ProviderError;

// No Debug or Serialize implementations on credentials.
pub(super) struct Credentials {
    pub authorization: HeaderValue,
    pub account_id: HeaderValue,
}

#[derive(Deserialize)]
struct AuthFile {
    auth_mode: Option<String>,
    tokens: Tokens,
}

#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    account_id: String,
}

pub fn default_auth_file() -> Result<PathBuf, ProviderError> {
    if let Some(path) = std::env::var_os("WIEN_CODEX_AUTH_FILE") {
        return Ok(PathBuf::from(path));
    }
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
        .ok_or(ProviderError::AuthRequired)?;
    Ok(home.join("auth.json"))
}

pub(super) async fn load(path: &std::path::Path) -> Result<Credentials, ProviderError> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| ProviderError::AuthRequired)?;
    let mut bytes = Vec::new();
    file.take(65_537)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| ProviderError::AuthRequired)?;
    if bytes.len() > 65_536 {
        return Err(ProviderError::AuthRequired);
    }
    let auth: AuthFile = serde_json::from_slice(&bytes).map_err(|_| ProviderError::AuthRequired)?;
    if auth
        .auth_mode
        .as_deref()
        .is_some_and(|mode| mode != "chatgpt")
        || auth.tokens.access_token.trim().is_empty()
        || auth.tokens.account_id.trim().is_empty()
    {
        return Err(ProviderError::AuthRequired);
    }
    let mut authorization = HeaderValue::from_str(&format!("Bearer {}", auth.tokens.access_token))
        .map_err(|_| ProviderError::AuthRequired)?;
    let mut account_id =
        HeaderValue::from_str(&auth.tokens.account_id).map_err(|_| ProviderError::AuthRequired)?;
    authorization.set_sensitive(true);
    account_id.set_sensitive(true);
    Ok(Credentials {
        authorization,
        account_id,
    })
}
