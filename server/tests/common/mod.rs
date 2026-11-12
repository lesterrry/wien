use async_trait::async_trait;
use sqlx::PgPool;
use std::sync::Arc;
use wien_server::auth::{Auth, Error, turnstile::RegistrationChallenge};

struct TestChallenge;
#[async_trait]
impl RegistrationChallenge for TestChallenge {
    fn sitekey(&self) -> &str {
        "test-sitekey"
    }
    async fn verify(&self, token: &str) -> Result<(), Error> {
        assert_eq!(token, "test-token");
        Ok(())
    }
}
pub async fn auth(pool: PgPool) -> Auth {
    Auth::new(pool)
        .await
        .unwrap()
        .with_registration(Arc::new(TestChallenge))
}
