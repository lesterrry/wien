use crate::{Config, EmbeddingConfig, Error, Result, sha256, store};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmbeddingIdentity {
    pub base_url: String,
    pub model: String,
    pub dimensions: Option<usize>,
    pub embedding_text_version: u32,
}
impl EmbeddingIdentity {
    pub fn fingerprint(&self) -> String {
        sha256(serde_json::to_vec(self).expect("identity serialization"))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingBatch {
    pub model: String,
    pub vectors: Vec<Vec<f32>>,
}
#[async_trait]
pub trait EmbeddingProvider: Send + Sync {
    fn identity(&self) -> EmbeddingIdentity;
    async fn embed(&self, inputs: &[String]) -> Result<EmbeddingBatch>;
}
pub fn provider_from_config(config: &Config) -> Result<Arc<dyn EmbeddingProvider>> {
    config.validate()?;
    match config.embedding.provider.as_str() {
        "http" => Ok(Arc::new(HttpEmbeddingProvider::new(&config.embedding)?)),
        "mock" => {
            if !config.allow_fixture {
                return Err(Error::Config(
                    "mock provider requires --allow-fixture".into(),
                ));
            }
            #[cfg(feature = "test-support")]
            {
                Ok(Arc::new(DeterministicMockProvider))
            }
            #[cfg(not(feature = "test-support"))]
            {
                Err(Error::Config(
                    "mock provider requires the fixture-provider feature".into(),
                ))
            }
        }
        _ => Err(Error::Config("unknown embedding provider".into())),
    }
}
#[derive(Clone)]
pub struct HttpEmbeddingProvider {
    config: EmbeddingConfig,
    client: reqwest::Client,
}
impl HttpEmbeddingProvider {
    pub fn new(config: &EmbeddingConfig) -> Result<Self> {
        Ok(Self {
            config: config.clone(),
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
impl EmbeddingProvider for HttpEmbeddingProvider {
    fn identity(&self) -> EmbeddingIdentity {
        EmbeddingIdentity {
            base_url: self.config.base_url.trim_end_matches('/').into(),
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
                let mut request = self
                    .client
                    .post(format!(
                        "{}/embeddings",
                        self.config.base_url.trim_end_matches('/')
                    ))
                    .json(&body);
                if let Some(key) = self.config.api_key() {
                    request = request.bearer_auth(key)
                }
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
pub fn normalize_vector(vector: &mut [f32], dimension: Option<usize>) -> Result<usize> {
    if vector.is_empty()
        || dimension.is_some_and(|d| d != vector.len())
        || vector.iter().any(|x| !x.is_finite())
    {
        return Err(Error::Provider(
            "invalid embedding dimension or non-finite vector".into(),
        ));
    }
    let norm = vector
        .iter()
        .map(|&x| (x as f64) * (x as f64))
        .sum::<f64>()
        .sqrt();
    if norm == 0.0 || !norm.is_finite() {
        return Err(Error::Provider(
            "embedding vector has zero or invalid norm".into(),
        ));
    }
    if (norm - 1.0).abs() > 1e-6 {
        for x in vector.iter_mut() {
            *x = (*x as f64 / norm) as f32;
        }
    }
    Ok(vector.len())
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedEmbedding {
    pub fingerprint: String,
    pub text_hash: String,
    pub model: String,
    pub dimension: usize,
    pub vector: Vec<f32>,
}
fn validate_cached(entry: &CachedEmbedding, fingerprint: &str, hash: &str) -> Result<()> {
    if entry.fingerprint != fingerprint
        || entry.text_hash != hash
        || entry.model.is_empty()
        || entry.dimension != entry.vector.len()
        || entry.vector.is_empty()
        || entry.vector.iter().any(|v| !v.is_finite())
    {
        return Err(Error::Corrupt(
            "invalid embedding cache identity/dimension".into(),
        ));
    }
    let norm = entry
        .vector
        .iter()
        .map(|&v| (v as f64).powi(2))
        .sum::<f64>();
    if (norm - 1.0).abs() > 0.001 {
        return Err(Error::Corrupt(
            "embedding cache vector is not normalized".into(),
        ));
    }
    Ok(())
}
pub async fn cached_embeddings(
    config: &Config,
    provider: &dyn EmbeddingProvider,
    inputs: &[String],
) -> Result<(EmbeddingBatch, usize, usize)> {
    let identity = provider.identity();
    let fp = identity.fingerprint();
    let dir = config.data_dir.join("embedding-cache").join(&fp);
    let mut vectors: Vec<Option<Vec<f32>>> = vec![None; inputs.len()];
    let mut model = None;
    let mut dimension = identity.dimensions;
    let mut missing = Vec::new();
    let mut hits = 0;
    let mut first = std::collections::HashMap::new();
    let mut duplicates = Vec::new();
    for (i, text) in inputs.iter().enumerate() {
        let hash = sha256(text);
        if let Some(&original) = first.get(&hash) {
            duplicates.push((i, original));
            hits += 1;
            continue;
        }
        first.insert(hash.clone(), i);
        let path = dir.join(format!("{hash}.json"));
        if path.exists() {
            let entry: CachedEmbedding = store::read_json(&path)?;
            validate_cached(&entry, &fp, &hash)?;
            if dimension.is_some_and(|d| d != entry.dimension)
                || model.as_ref().is_some_and(|m| m != &entry.model)
            {
                return Err(Error::Corrupt(
                    "embedding cache model/dimension mismatch".into(),
                ));
            }
            dimension = Some(entry.dimension);
            model = Some(entry.model);
            vectors[i] = Some(entry.vector);
            hits += 1;
        } else {
            missing.push(i)
        }
    }
    for indices in missing.chunks(config.embedding.batch_size) {
        let texts = indices
            .iter()
            .map(|&i| inputs[i].clone())
            .collect::<Vec<_>>();
        let batch = provider.embed(&texts).await?;
        if batch.vectors.len() != indices.len()
            || batch.model.is_empty()
            || model.as_ref().is_some_and(|m| m != &batch.model)
        {
            return Err(Error::Provider(
                "embedding batch model/count mismatch".into(),
            ));
        }
        model = Some(batch.model.clone());
        for (&i, mut vector) in indices.iter().zip(batch.vectors) {
            let d = normalize_vector(&mut vector, dimension)?;
            dimension = Some(d);
            let hash = sha256(&inputs[i]);
            let entry = CachedEmbedding {
                fingerprint: fp.clone(),
                text_hash: hash.clone(),
                model: batch.model.clone(),
                dimension: d,
                vector,
            };
            store::write_json(&dir.join(format!("{hash}.json")), &entry)?;
            vectors[i] = Some(entry.vector);
        }
    }
    for (i, original) in duplicates {
        vectors[i] = vectors[original].clone();
    }
    Ok((
        EmbeddingBatch {
            model: model.unwrap_or_default(),
            vectors: vectors
                .into_iter()
                .map(|v| v.expect("all cache positions filled"))
                .collect(),
        },
        hits,
        missing.len(),
    ))
}
#[cfg(feature = "test-support")]
#[derive(Debug, Default)]
pub struct DeterministicMockProvider;
#[cfg(feature = "test-support")]
#[async_trait]
impl EmbeddingProvider for DeterministicMockProvider {
    fn identity(&self) -> EmbeddingIdentity {
        EmbeddingIdentity {
            base_url: "fixture://deterministic".into(),
            model: "deterministic-sha256-64".into(),
            dimensions: Some(64),
            embedding_text_version: 1,
        }
    }
    async fn embed(&self, inputs: &[String]) -> Result<EmbeddingBatch> {
        use sha2::{Digest, Sha256};
        let mut vectors = Vec::with_capacity(inputs.len());
        for text in inputs {
            let mut vector = vec![0f32; 64];
            for word in text
                .to_lowercase()
                .split(|c: char| !c.is_alphanumeric())
                .filter(|w| !w.is_empty())
            {
                let hash = Sha256::digest(word.as_bytes());
                vector[hash[0] as usize % 64] += if hash[1] & 1 == 0 { 1.0 } else { -1.0 };
            }
            if vector.iter().all(|v| *v == 0.0) {
                vector[0] = 1.0
            }
            normalize_vector(&mut vector, Some(64))?;
            vectors.push(vector)
        }
        Ok(EmbeddingBatch {
            model: self.identity().model,
            vectors,
        })
    }
}
