//! Retrieval-only evaluation. Fixture metrics are not evidence of live embedding quality.
use crate::{
    Config, DocumentReference, Error, RagEngine, Result, SearchFilters, SearchIntent,
    SearchRequest, document_id, sha256,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelevantSelector {
    pub source_id: String,
    pub source_path: String,
    pub extraction_key: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvalCase {
    pub id: String,
    pub query: String,
    pub language: String,
    pub intent: SearchIntent,
    pub relevant: Vec<RelevantSelector>,
    pub rationale: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalCaseResult {
    pub id: String,
    pub language: String,
    pub intent: SearchIntent,
    pub relevant_document_ids: Vec<String>,
    pub retrieved_document_ids: Vec<String>,
    pub recall_at_k: f64,
    pub reciprocal_rank_at_k: f64,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EvalMetrics {
    pub cases: usize,
    pub recall_at_k: f64,
    pub mrr_at_k: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalReport {
    pub dataset: String,
    pub dataset_digest: String,
    pub corpus_digest: String,
    pub index_version: String,
    pub model: String,
    pub dimension: usize,
    pub k: usize,
    pub fixture: bool,
    pub metrics: EvalMetrics,
    pub by_language: BTreeMap<String, EvalMetrics>,
    pub by_intent: BTreeMap<String, EvalMetrics>,
    pub cases: Vec<EvalCaseResult>,
}

pub async fn evaluate(
    config: &Config,
    engine: &RagEngine,
    path: &Path,
    k: usize,
) -> Result<EvalReport> {
    if k == 0 || k > config.retrieval.max_top_k {
        return Err(Error::InvalidArgument(format!(
            "eval k must be in 1..={}",
            config.retrieval.max_top_k
        )));
    }
    let info = engine.corpus_info();
    if !info.ready {
        return Err(Error::NotReady(
            info.readiness_reason
                .unwrap_or_else(|| "index is not ready".into()),
        ));
    }
    let bytes = fs::read(path)?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|e| Error::InvalidArgument(format!("evaluation dataset is not UTF-8: {e}")))?;
    let mut ids = BTreeSet::new();
    let mut dataset = Vec::new();
    for (line_number, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let case: EvalCase = serde_json::from_str(line).map_err(|e| {
            Error::InvalidArgument(format!("invalid evaluation line {}: {e}", line_number + 1))
        })?;
        if case.id.trim().is_empty() || !ids.insert(case.id.clone()) {
            return Err(Error::InvalidArgument(format!(
                "empty/duplicate evaluation id at line {}",
                line_number + 1
            )));
        }
        if case.language.trim().is_empty()
            || case.rationale.trim().is_empty()
            || case.relevant.is_empty()
        {
            return Err(Error::InvalidArgument(format!(
                "evaluation {} needs language, rationale, and at least one relevant selector",
                case.id
            )));
        }
        dataset.push(case);
    }
    if dataset.is_empty() {
        return Err(Error::InvalidArgument("evaluation dataset is empty".into()));
    }
    // Resolve every label before any paid embedding requests. Exact IDs cannot silently
    // match an unrelated path/name or be skipped when a real source was not imported.
    let mut resolved = Vec::new();
    for case in &dataset {
        let mut relevant = BTreeSet::new();
        for selector in &case.relevant {
            let id = document_id(
                &selector.source_id,
                &selector.source_path,
                &selector.extraction_key,
            );
            if !relevant.insert(id.clone()) {
                return Err(Error::InvalidArgument(format!(
                    "duplicate/ambiguous relevant selector in {}",
                    case.id
                )));
            }
            let record = engine.get_document(DocumentReference::DocumentId(id.clone()),false).map_err(|_| Error::InvalidArgument(format!("evaluation {}: missing label source={} path={} extraction_key={}; import the actual labeled source and rebuild the index",case.id,selector.source_id,selector.source_path,selector.extraction_key)))?.record;
            if record.source.source_id != selector.source_id {
                return Err(Error::Corrupt(
                    "evaluation label provenance mismatch".into(),
                ));
            }
        }
        resolved.push(relevant);
    }
    let mut cases = Vec::new();
    for (case, relevant) in dataset.into_iter().zip(resolved) {
        // Ask for the complete permitted candidate page, then deduplicate documents
        // before taking k, so several chunks of one document cannot consume all k.
        let response = engine
            .search(SearchRequest {
                query: case.query,
                intent: case.intent,
                top_k: Some(config.retrieval.max_top_k),
                filters: SearchFilters::default(),
            })
            .await?;
        let mut seen = BTreeSet::new();
        let retrieved = response
            .results
            .into_iter()
            .map(|hit| hit.record.document_id)
            .filter(|id| seen.insert(id.clone()))
            .take(k)
            .collect::<Vec<_>>();
        let (recall, rr) = calculate_metrics(&retrieved, &relevant);
        cases.push(EvalCaseResult {
            id: case.id,
            language: case.language,
            intent: case.intent,
            relevant_document_ids: relevant.into_iter().collect(),
            retrieved_document_ids: retrieved,
            recall_at_k: recall,
            reciprocal_rank_at_k: rr,
        });
    }
    let metrics = aggregate(cases.iter());
    let mut language_groups: BTreeMap<String, Vec<&EvalCaseResult>> = BTreeMap::new();
    let mut intent_groups: BTreeMap<String, Vec<&EvalCaseResult>> = BTreeMap::new();
    for case in &cases {
        language_groups
            .entry(case.language.clone())
            .or_default()
            .push(case);
        let intent = match case.intent {
            SearchIntent::Api => "api",
            SearchIntent::Musical => "musical",
            SearchIntent::Example => "example",
            SearchIntent::Mixed => "mixed",
        };
        intent_groups.entry(intent.into()).or_default().push(case);
    }
    // Bind the report to the full immutable generation manifest, not only labels.
    let generation = info
        .index_version
        .ok_or_else(|| Error::Corrupt("ready index has no version".into()))?;
    let manifest_path = config
        .data_dir
        .join("indexes")
        .join(&generation)
        .join("manifest.json");
    let manifest: serde_json::Value = serde_json::from_slice(&fs::read(manifest_path)?)?;
    let corpus_digest = manifest
        .get("corpus_digest")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| Error::Corrupt("index manifest has no corpus digest".into()))?
        .to_owned();
    Ok(EvalReport {
        dataset: path.to_string_lossy().into_owned(),
        dataset_digest: sha256(bytes),
        corpus_digest,
        index_version: generation,
        model: info
            .model
            .ok_or_else(|| Error::Corrupt("ready index has no model".into()))?,
        dimension: info
            .dimension
            .ok_or_else(|| Error::Corrupt("ready index has no dimension".into()))?,
        k,
        fixture: info.fixture,
        metrics,
        by_language: language_groups
            .into_iter()
            .map(|(key, values)| (key, aggregate(values.into_iter())))
            .collect(),
        by_intent: intent_groups
            .into_iter()
            .map(|(key, values)| (key, aggregate(values.into_iter())))
            .collect(),
        cases,
    })
}
fn calculate_metrics(retrieved: &[String], relevant: &BTreeSet<String>) -> (f64, f64) {
    let found = retrieved.iter().filter(|id| relevant.contains(*id)).count();
    let rr = retrieved
        .iter()
        .position(|id| relevant.contains(id))
        .map_or(0.0, |rank| 1.0 / (rank + 1) as f64);
    (found as f64 / relevant.len() as f64, rr)
}
fn aggregate<'a>(cases: impl Iterator<Item = &'a EvalCaseResult>) -> EvalMetrics {
    let mut metrics = EvalMetrics::default();
    for case in cases {
        metrics.cases += 1;
        metrics.recall_at_k += case.recall_at_k;
        metrics.mrr_at_k += case.reciprocal_rank_at_k;
    }
    if metrics.cases > 0 {
        metrics.recall_at_k /= metrics.cases as f64;
        metrics.mrr_at_k /= metrics.cases as f64;
    }
    metrics
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metrics_use_all_relevant_labels_and_first_relevant_rank() {
        let relevant = BTreeSet::from(["a".to_owned(), "b".to_owned()]);
        let (recall, mrr) = calculate_metrics(&["x".into(), "b".into()], &relevant);
        assert_eq!(recall, 0.5);
        assert_eq!(mrr, 0.5);
        assert_eq!(calculate_metrics(&[], &relevant), (0.0, 0.0));
    }
}
