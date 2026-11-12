pub mod aitunnel;
pub use aitunnel::AitunnelEmbeddingProvider;

use crate::{Config, Error, Result, sha256, store};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
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
        "aitunnel" => Ok(Arc::new(AitunnelEmbeddingProvider::new(&config.embedding)?)),
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
                    "mock provider is only available in test-support builds".into(),
                ))
            }
        }
        _ => Err(Error::Config("unknown embedding provider".into())),
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
