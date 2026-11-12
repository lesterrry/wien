use super::Error;
use async_trait::async_trait;
use axum::http::StatusCode;
use serde::Deserialize;
use std::time::Duration;

#[async_trait]
pub trait RegistrationChallenge: Send + Sync {
    fn sitekey(&self) -> &str;
    async fn verify(&self, token: &str) -> Result<(), Error>;
}

pub struct Turnstile {
    sitekey: String,
    secret: String,
    hostnames: Vec<String>,
    client: reqwest::Client,
}

impl Turnstile {
    pub fn from_env() -> Result<Option<Self>, Error> {
        let sitekey = std::env::var("TURNSTILE_SITE_KEY").unwrap_or_default();
        let secret = std::env::var("TURNSTILE_SECRET_KEY").unwrap_or_default();
        let hostnames = std::env::var("TURNSTILE_HOSTNAMES").unwrap_or_default();
        if sitekey.is_empty() && secret.is_empty() && hostnames.is_empty() {
            return Ok(None);
        }
        let hostnames: Vec<String> = hostnames
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .collect();
        if sitekey.trim().is_empty() || secret.trim().is_empty() || hostnames.is_empty() {
            return Err(unavailable());
        }
        Ok(Some(Self {
            sitekey,
            secret,
            hostnames,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| unavailable())?,
        }))
    }

    async fn verify_at(&self, token: &str, endpoint: &str) -> Result<(), Error> {
        if token.is_empty() || token.len() > 2048 {
            return Err(rejected());
        }
        let response = self
            .client
            .post(endpoint)
            .json(&serde_json::json!({"secret":self.secret,"response":token}))
            .send()
            .await
            .map_err(|_| unavailable())?
            .error_for_status()
            .map_err(|_| unavailable())?
            .json::<Verification>()
            .await
            .map_err(|_| unavailable())?;
        if !response.success
            || response.action.as_deref() != Some("register")
            || !response
                .hostname
                .is_some_and(|h| self.hostnames.contains(&h))
        {
            return Err(rejected());
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct Verification {
    success: bool,
    hostname: Option<String>,
    action: Option<String>,
}

#[async_trait]
impl RegistrationChallenge for Turnstile {
    fn sitekey(&self) -> &str {
        &self.sitekey
    }
    async fn verify(&self, token: &str) -> Result<(), Error> {
        self.verify_at(
            token,
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        )
        .await
    }
}

pub(super) fn unavailable() -> Error {
    Error::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "registration_unavailable",
        "Registration verification is unavailable. Try again later.",
    )
}
fn rejected() -> Error {
    Error::new(
        StatusCode::BAD_REQUEST,
        "captcha_failed",
        "Complete the verification again.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_json, method},
    };

    #[tokio::test]
    async fn validates_provider_result_hostname_action_and_rejects_replay() {
        let server = MockServer::start().await;
        let verifier = Turnstile {
            sitekey: "public".into(),
            secret: "private-test-key".into(),
            hostnames: vec!["wien.example".into()],
            client: reqwest::Client::new(),
        };
        assert!(verifier.verify_at("", &server.uri()).await.is_err());
        assert!(
            verifier
                .verify_at(&"x".repeat(2049), &server.uri())
                .await
                .is_err()
        );
        for (result, valid) in [
            (
                serde_json::json!({"success":true,"hostname":"wien.example","action":"register"}),
                true,
            ),
            (
                serde_json::json!({"success":true,"hostname":"evil.example","action":"register"}),
                false,
            ),
            (
                serde_json::json!({"success":true,"hostname":"wien.example","action":"login"}),
                false,
            ),
            (
                serde_json::json!({"success":false,"error-codes":["timeout-or-duplicate"]}),
                false,
            ),
        ] {
            server.reset().await;
            Mock::given(method("POST"))
                .and(body_json(
                    serde_json::json!({"secret":"private-test-key","response":"test-token"}),
                ))
                .respond_with(ResponseTemplate::new(200).set_body_json(result))
                .expect(1)
                .mount(&server)
                .await;
            assert_eq!(
                verifier
                    .verify_at("test-token", &server.uri())
                    .await
                    .is_ok(),
                valid
            );
        }
        server.reset().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        assert_eq!(
            verifier
                .verify_at("test-token", &server.uri())
                .await
                .unwrap_err()
                .code,
            "registration_unavailable"
        );
    }
}
