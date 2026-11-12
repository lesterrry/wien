use std::{fmt, path::Path};

use serde::Deserialize;

use crate::providers::ProviderKind;
use crate::providers::{ModelOptions, ReasoningEffort};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub provider: ProviderKind,
    #[serde(default)]
    pub generation: GenerationConfig,
}

/// Model settings shared by generation and the editor assistant.
#[derive(Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GenerationConfig {
    pub model: String,
    pub reasoning_effort: ReasoningEffort,
    /// Optional system instructions for /v1/generate; the assistant uses its master prompt.
    pub instructions: Option<String>,
}

impl Default for GenerationConfig {
    fn default() -> Self {
        Self {
            model: "gpt-6-luna".into(),
            reasoning_effort: ReasoningEffort::Low,
            instructions: None,
        }
    }
}

impl GenerationConfig {
    pub fn options(&self) -> ModelOptions {
        ModelOptions {
            model: self.model.clone(),
            reasoning_effort: Some(self.reasoning_effort.clone()),
            instructions: self.instructions.clone(),
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let source = std::fs::read_to_string(path).map_err(|_| ConfigError::Read)?;
        // Do not expose TOML snippets: an accidentally pasted credential must not reach logs.
        let config: Self = toml::from_str(&source).map_err(|_| ConfigError::Invalid)?;
        if config.generation.model.trim().is_empty() || config.generation.model.len() > 200 {
            return Err(ConfigError::Invalid);
        }
        if config
            .generation
            .instructions
            .as_ref()
            .is_some_and(|value| value.len() > 128 * 1024)
        {
            return Err(ConfigError::Invalid);
        }
        Ok(config)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ConfigError {
    Read,
    Invalid,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Read => {
                "Cannot read server config. Check server/config.toml or WIEN_SERVER_CONFIG."
            }
            Self::Invalid => {
                "Invalid server TOML config. Expected provider = \"aitunnel\" or \"codex\", an optional generation section, and no unknown fields."
            }
        })
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_checked_in_provider_config() {
        let config =
            Config::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("config.toml")).unwrap();
        assert_eq!(config.provider, ProviderKind::Aitunnel);
        assert_eq!(config.generation.reasoning_effort, ReasoningEffort::Low);
    }

    #[test]
    fn loads_generation_settings_from_toml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "provider = 'aitunnel'\n[generation]\nmodel = 'configured-model'\nreasoning_effort = 'high'\ninstructions = 'Be concise'").unwrap();
        let config = Config::load(&path).unwrap();
        assert_eq!(config.generation.model, "configured-model");
        assert_eq!(config.generation.reasoning_effort, ReasoningEffort::High);
        assert_eq!(
            config.generation.instructions.as_deref(),
            Some("Be concise")
        );
    }

    #[test]
    fn invalid_or_missing_config_fails_without_fallback_or_content_leaks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        assert_eq!(Config::load(&path).unwrap_err(), ConfigError::Read);
        for source in [
            "",
            "provider = 'unknown'",
            "provider = 42",
            "provider = 'aitunnel'\n[generation]\nmodel = ''",
            "provider = 'aitunnel'\n[generation]\nreasoning_effort = 'invalid'",
            "provider = 'aitunnel'\n[assistant]\nmodel = 'old-setting'",
            "provider = 'codex'\nsecret = 'test-only-secret'",
            "provider = 'test-only-secret",
        ] {
            std::fs::write(&path, source).unwrap();
            let error = Config::load(&path).unwrap_err();
            assert_eq!(error, ConfigError::Invalid);
            assert!(!format!("{error:?} {error}").contains("test-only-secret"));
        }
    }
}
