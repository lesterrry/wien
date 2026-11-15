use super::Mode;
use crate::robokassa::TestConfig;
use serde::Deserialize;

/// Public payment settings live in TOML. Only provider passwords come from the environment.
#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub mode: Mode,
    pub merchant_login: String,
    pub test_users: Vec<String>,
}
impl Config {
    pub fn build(&self) -> Result<Option<TestConfig>, &'static str> {
        self.build_with(|key| {
            std::env::var(key).map_err(|_| "Missing Robokassa test passwords in environment.")
        })
    }

    fn build_with(
        &self,
        secret: impl Fn(&str) -> Result<String, &'static str>,
    ) -> Result<Option<TestConfig>, &'static str> {
        match self.mode {
            Mode::Disabled => Ok(None),
            Mode::Test => Ok(Some(TestConfig::new(
                self.merchant_login.clone(),
                secret("ROBOKASSA_TEST_PASSWORD1")?,
                secret("ROBOKASSA_TEST_PASSWORD2")?,
                self.test_users.iter().cloned().collect(),
            )?)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_never_requires_secrets() {
        assert!(
            Config::default()
                .build_with(|_| panic!("must not read secrets"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn test_mode_uses_toml_users_and_only_test_passwords() {
        let config: Config = toml::from_str("mode='test'\nmerchant_login='wien'\ntest_users=['tester_one','tester_two','tester_one']").unwrap();
        let built = config
            .build_with(|key| match key {
                "ROBOKASSA_TEST_PASSWORD1" => Ok("first-test-secret".into()),
                "ROBOKASSA_TEST_PASSWORD2" => Ok("second-test-secret".into()),
                _ => panic!("unexpected secret lookup"),
            })
            .unwrap()
            .unwrap();
        assert_eq!(built.merchant_login, "wien");
        assert_eq!(built.test_users.len(), 2);
        assert!(built.test_users.contains("tester_one"));
        assert!(built.test_users.contains("tester_two"));
        assert!(config.build_with(|_| Err("missing test password")).is_err());
    }

    #[test]
    fn test_mode_rejects_missing_or_invalid_user_list() {
        for users in [vec![], vec!["invalid user".into()]] {
            let config = Config {
                mode: Mode::Test,
                merchant_login: "wien".into(),
                test_users: users,
            };
            assert!(
                config
                    .build_with(|key| Ok(format!("test-secret-{key}")))
                    .is_err()
            );
        }
    }
}
