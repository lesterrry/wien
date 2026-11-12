use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub data_dir: PathBuf,
    pub sources_manifest: PathBuf,
    pub embedding: EmbeddingConfig,
    pub chunking: ChunkConfig,
    pub retrieval: RetrievalConfig,
    pub server: ServerConfig,
    pub client: ClientConfig,
    #[serde(skip)]
    pub allow_fixture: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct EmbeddingConfig {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub dimensions: Option<usize>,
    pub api_key_env: String,
    pub batch_size: usize,
    pub timeout_secs: u64,
    pub max_retries: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ChunkConfig {
    pub target_tokens_approx: usize,
    pub max_tokens_approx: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RetrievalConfig {
    pub candidate_k: usize,
    pub top_k: usize,
    pub max_top_k: usize,
    pub rrf_k: f64,
    pub min_cosine: f32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    pub bind: SocketAddr,
    pub bearer_token_env: String,
    pub timeout_secs: u64,
    pub max_request_bytes: usize,
    pub max_response_bytes: usize,
    pub max_concurrent_searches: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ClientConfig {
    pub endpoint: String,
    pub bearer_token_env: String,
    pub timeout_secs: u64,
    pub connect_timeout_secs: u64,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            data_dir: "./data".into(),
            sources_manifest: "./corpus/sources.toml".into(),
            embedding: Default::default(),
            chunking: Default::default(),
            retrieval: Default::default(),
            server: Default::default(),
            client: Default::default(),
            allow_fixture: false,
        }
    }
}
impl Default for EmbeddingConfig {
    fn default() -> Self {
        Self {
            provider: "http".into(),
            base_url: "https://api.openai.com/v1".into(),
            model: "text-embedding-3-small".into(),
            dimensions: None,
            api_key_env: "OPENAI_API_KEY".into(),
            batch_size: 32,
            timeout_secs: 30,
            max_retries: 3,
        }
    }
}
impl Default for ChunkConfig {
    fn default() -> Self {
        Self {
            target_tokens_approx: 500,
            max_tokens_approx: 800,
        }
    }
}
impl Default for RetrievalConfig {
    fn default() -> Self {
        Self {
            candidate_k: 20,
            top_k: 8,
            max_top_k: 50,
            rrf_k: 60.0,
            min_cosine: 0.3,
        }
    }
}
impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: SocketAddr::from(([127, 0, 0, 1], 50051)),
            bearer_token_env: "STRUDEL_RAG_BEARER_TOKEN".into(),
            timeout_secs: 30,
            max_request_bytes: 65536,
            max_response_bytes: 16777216,
            max_concurrent_searches: 8,
        }
    }
}
impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            endpoint: "http://127.0.0.1:50051".into(),
            bearer_token_env: "STRUDEL_RAG_BEARER_TOKEN".into(),
            timeout_secs: 30,
            connect_timeout_secs: 5,
        }
    }
}
impl EmbeddingConfig {
    pub fn api_key(&self) -> Option<String> {
        secret("STRUDEL_RAG_EMBEDDING_API_KEY").or_else(|| secret(&self.api_key_env))
    }
}
impl ServerConfig {
    pub fn bearer_token(&self) -> Option<String> {
        secret(&self.bearer_token_env)
    }
}
impl ClientConfig {
    pub fn bearer_token(&self) -> Option<String> {
        secret(&self.bearer_token_env)
    }
}
fn secret(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}
impl Config {
    pub fn load(path: Option<&Path>) -> Result<Self> {
        let from_env = std::env::var_os("STRUDEL_RAG_CONFIG").map(PathBuf::from);
        let file = path
            .map(PathBuf::from)
            .or(from_env)
            .unwrap_or_else(|| "skill/config.toml".into());
        let source = std::fs::read_to_string(&file).map_err(|_| {
            Error::Config("cannot read RAG config; set --config or STRUDEL_RAG_CONFIG".into())
        })?;
        let mut c = toml::from_str::<Self>(&source).map_err(|_| {
            Error::Config("invalid RAG TOML config; unknown fields are not allowed".into())
        })?;
        if file.exists() {
            let base = file.parent().unwrap_or(Path::new("."));
            if c.data_dir.is_relative() {
                c.data_dir = base.join(&c.data_dir)
            }
            if c.sources_manifest.is_relative() {
                c.sources_manifest = base.join(&c.sources_manifest)
            }
        }
        macro_rules! text {
            ($name:literal,$field:expr) => {
                if let Ok(v) = std::env::var(concat!("STRUDEL_RAG_", $name)) {
                    $field = v;
                }
            };
        }
        macro_rules! number {
            ($name:literal,$field:expr) => {
                if let Ok(v) = std::env::var(concat!("STRUDEL_RAG_", $name)) {
                    $field = v.parse().map_err(|_| {
                        Error::Config(concat!("invalid STRUDEL_RAG_", $name).into())
                    })?;
                }
            };
        }
        if let Some(v) = std::env::var_os("STRUDEL_RAG_DATA_DIR") {
            c.data_dir = v.into()
        }
        if let Some(v) = std::env::var_os("STRUDEL_RAG_SOURCES_MANIFEST") {
            c.sources_manifest = v.into()
        }
        text!("EMBEDDING_PROVIDER", c.embedding.provider);
        text!("EMBEDDING_BASE_URL", c.embedding.base_url);
        text!("EMBEDDING_MODEL", c.embedding.model);
        if let Ok(v) = std::env::var("STRUDEL_RAG_EMBEDDING_DIMENSIONS") {
            c.embedding.dimensions = Some(
                v.parse()
                    .map_err(|_| Error::Config("invalid embedding dimensions".into()))?,
            )
        }
        number!("EMBEDDING_BATCH_SIZE", c.embedding.batch_size);
        number!("EMBEDDING_TIMEOUT_SECS", c.embedding.timeout_secs);
        number!("EMBEDDING_MAX_RETRIES", c.embedding.max_retries);
        number!("BIND", c.server.bind);
        text!("ENDPOINT", c.client.endpoint);
        if let Ok(v) = std::env::var("STRUDEL_RAG_TIMEOUT_SECS") {
            let n = v
                .parse()
                .map_err(|_| Error::Config("invalid timeout".into()))?;
            c.server.timeout_secs = n;
            c.client.timeout_secs = n;
        }
        c.validate()?;
        Ok(c)
    }
    pub fn validate(&self) -> Result<()> {
        let e = &self.embedding;
        let r = &self.retrieval;
        let s = &self.server;
        if !matches!(e.provider.as_str(), "http" | "mock") {
            return Err(Error::Config(
                "embedding provider must be http or mock".into(),
            ));
        }
        if e.model.trim().is_empty()
            || e.batch_size == 0
            || e.timeout_secs == 0
            || e.dimensions == Some(0)
        {
            return Err(Error::Config(
                "embedding model, batch size, dimensions and timeout must be positive/nonempty"
                    .into(),
            ));
        }
        if e.provider == "http" {
            let u = url::Url::parse(&e.base_url)
                .map_err(|_| Error::Config("invalid embedding base URL".into()))?;
            if !matches!(u.scheme(), "https" | "http")
                || u.host_str().is_none()
                || !u.username().is_empty()
                || u.password().is_some()
            {
                return Err(Error::Config(
                    "embedding URL must be HTTP(S) without credentials".into(),
                ));
            }
        }
        let u = url::Url::parse(&self.client.endpoint)
            .map_err(|_| Error::Config("invalid client endpoint".into()))?;
        if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none() {
            return Err(Error::Config("client endpoint must be HTTP(S)".into()));
        }
        if self.chunking.target_tokens_approx == 0
            || self.chunking.max_tokens_approx < self.chunking.target_tokens_approx
        {
            return Err(Error::Config(
                "chunk maximum must be at least positive target".into(),
            ));
        }
        if r.candidate_k == 0
            || r.candidate_k > 1000
            || r.top_k == 0
            || r.top_k > r.max_top_k
            || r.max_top_k > 50
            || !r.rrf_k.is_finite()
            || r.rrf_k <= 0.0
            || !r.min_cosine.is_finite()
            || !(-1.0..=1.0).contains(&r.min_cosine)
        {
            return Err(Error::Config(
                "invalid retrieval limits or score thresholds".into(),
            ));
        }
        if s.timeout_secs == 0
            || s.max_request_bytes == 0
            || s.max_response_bytes == 0
            || s.max_concurrent_searches == 0
            || self.client.timeout_secs == 0
            || self.client.connect_timeout_secs == 0
        {
            return Err(Error::Config(
                "server/client sizes, timeouts, concurrency must be positive".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_requires_file_rejects_unknown_fields_and_hides_contents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        assert!(Config::load(Some(&path)).is_err());
        for source in [
            "secret = 'test-only-secret'",
            "[embedding]\nsecret = 'test-only-secret'",
            "[server]\nsecret = 'test-only-secret'",
            "[client]\nsecret = 'test-only-secret'",
            "[chunking]\nsecret = 'test-only-secret'",
            "[retrieval]\nsecret = 'test-only-secret'",
            "model = 'test-only-secret",
        ] {
            std::fs::write(&path, source).unwrap();
            let error = Config::load(Some(&path)).unwrap_err();
            assert!(!format!("{error:?} {error}").contains("test-only-secret"));
        }
        std::fs::write(
            &path,
            "data_dir = './data'\nsources_manifest = './sources.toml'",
        )
        .unwrap();
        let config = Config::load(Some(&path)).unwrap();
        assert_eq!(config.data_dir, dir.path().join("./data"));
        assert_eq!(config.sources_manifest, dir.path().join("./sources.toml"));
    }
}
