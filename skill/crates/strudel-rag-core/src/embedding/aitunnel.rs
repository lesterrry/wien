use super::{EmbeddingBatch, EmbeddingIdentity, EmbeddingProvider, normalize_vector};
use crate::{EmbeddingConfig, Error, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::time::Duration;

#[derive(Clone)]
pub struct AitunnelEmbeddingProvider {
    config: EmbeddingConfig,
    client: reqwest::Client,
    base_url: String,
    authorization: reqwest::header::HeaderValue,
}
impl AitunnelEmbeddingProvider {
    pub fn new(config: &EmbeddingConfig) -> Result<Self> {
        let key = std::env::var("AITUNNEL_KEY")
            .map_err(|_| Error::Config("AITUNNEL_KEY is required for embeddings".into()))?;
        Self::with_endpoint(config, "https://api.aitunnel.ru/v1".into(), &key)
    }

    #[cfg(feature = "test-support")]
    pub fn for_test(config: &EmbeddingConfig, base_url: String, key: &str) -> Result<Self> {
        Self::with_endpoint(config, base_url, key)
    }

    fn with_endpoint(config: &EmbeddingConfig, base_url: String, key: &str) -> Result<Self> {
        if key.trim().is_empty() {
            return Err(Error::Config(
                "AITUNNEL_KEY is required for embeddings".into(),
            ));
        }
        let mut authorization = reqwest::header::HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| Error::Config("invalid AITUNNEL_KEY".into()))?;
        authorization.set_sensitive(true);
        Ok(Self {
            config: config.clone(),
            base_url,
            authorization,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(config.timeout_secs))
                .build()
                .map_err(|_| Error::Config("could not construct HTTP embedding client".into()))?,
        })
    }
}
#[derive(Deserialize)]
struct HttpResponse {
    model: String,
    data: Vec<HttpVector>,
}
#[derive(Deserialize)]
struct HttpVector {
    index: usize,
    embedding: Vec<f32>,
}
#[async_trait]
impl EmbeddingProvider for AitunnelEmbeddingProvider {
    fn identity(&self) -> EmbeddingIdentity {
        EmbeddingIdentity {
            base_url: self.base_url.trim_end_matches('/').into(),
            model: self.config.model.clone(),
            dimensions: self.config.dimensions,
            embedding_text_version: 1,
        }
    }
    async fn embed(&self, inputs: &[String]) -> Result<EmbeddingBatch> {
        let mut result = EmbeddingBatch {
            model: String::new(),
            vectors: Vec::with_capacity(inputs.len()),
        };
        let mut dimension = self.config.dimensions;
        for batch in inputs.chunks(self.config.batch_size) {
            let deadline =
                tokio::time::Instant::now() + Duration::from_secs(self.config.timeout_secs);
            let mut attempt = 0;
            let response = loop {
                let mut body = serde_json::json!({"model":self.config.model,"input":batch,"encoding_format":"float"});
                if let Some(d) = self.config.dimensions {
                    body["dimensions"] = d.into()
                }
                let request = self
                    .client
                    .post(format!(
                        "{}/embeddings",
                        self.base_url.trim_end_matches('/')
                    ))
                    .header(reqwest::header::AUTHORIZATION, self.authorization.clone())
                    .json(&body);
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    return Err(Error::Provider("embedding deadline exceeded".into()));
                }
                let response = request.timeout(remaining).send().await;
                let mut retry_after = None;
                let retry = match &response {
                    Err(e) => e.is_timeout() || e.is_connect(),
                    Ok(r) => {
                        retry_after = r
                            .headers()
                            .get(reqwest::header::RETRY_AFTER)
                            .and_then(|h| h.to_str().ok())
                            .and_then(|s| {
                                s.parse::<u64>().ok().map(Duration::from_secs).or_else(|| {
                                    httpdate::parse_http_date(s).ok().map(|t| {
                                        t.duration_since(std::time::SystemTime::now())
                                            .unwrap_or_default()
                                    })
                                })
                            });
                        matches!(r.status().as_u16(), 408 | 429 | 500 | 502 | 503 | 504)
                    }
                };
                if retry && attempt < self.config.max_retries {
                    let backoff =
                        Duration::from_millis(250u64.saturating_mul(1u64 << attempt.min(10)))
                            .min(Duration::from_secs(4));
                    let delay = retry_after.unwrap_or(backoff).max(backoff);
                    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                    if delay >= remaining {
                        return Err(Error::Provider("embedding retry deadline exceeded".into()));
                    }
                    tokio::time::sleep(delay).await;
                    attempt += 1;
                    continue;
                }
                let r =
                    response.map_err(|_| Error::Provider("embedding transport failure".into()))?;
                if !r.status().is_success() {
                    return Err(Error::Provider(format!(
                        "embedding endpoint returned HTTP {}",
                        r.status().as_u16()
                    )));
                }
                break tokio::time::timeout_at(deadline, r.json::<HttpResponse>())
                    .await
                    .map_err(|_| Error::Provider("embedding response deadline exceeded".into()))?
                    .map_err(|_| Error::Provider("invalid embedding response JSON".into()))?;
            };
            if response.model.trim().is_empty()
                || (!result.model.is_empty() && response.model != result.model)
            {
                return Err(Error::Provider(
                    "inconsistent reported embedding model".into(),
                ));
            }
            result.model = response.model;
            if response.data.len() != batch.len() {
                return Err(Error::Provider("embedding count mismatch".into()));
            }
            let mut ordered: Vec<Option<Vec<f32>>> = vec![None; batch.len()];
            for row in response.data {
                if row.index >= ordered.len() || ordered[row.index].is_some() {
                    return Err(Error::Provider(
                        "embedding indices must be a unique complete permutation".into(),
                    ));
                }
                let mut vector = row.embedding;
                let d = normalize_vector(&mut vector, dimension)?;
                dimension = Some(d);
                ordered[row.index] = Some(vector);
            }
            for vector in ordered {
                result.vectors.push(
                    vector.ok_or_else(|| {
                        Error::Provider("missing embedding response index".into())
                    })?,
                )
            }
        }
        Ok(result)
    }
}
