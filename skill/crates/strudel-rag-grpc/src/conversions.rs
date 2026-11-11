//! Explicit domain/protobuf conversions. Unknown enum discriminants are rejected.
use crate::pb;
use strudel_rag_core as core;

fn invalid(message: &str) -> core::Error {
    core::Error::InvalidArgument(message.into())
}
fn required<T>(value: Option<T>, name: &str) -> core::Result<T> {
    value.ok_or_else(|| invalid(name))
}
fn wire_count(value: usize) -> core::Result<u32> {
    u32::try_from(value)
        .map_err(|_| core::Error::Other("response count exceeds protocol range".into()))
}
fn domain_count(value: u64) -> core::Result<usize> {
    usize::try_from(value).map_err(|_| invalid("count exceeds platform range"))
}

impl From<core::DocumentKind> for pb::DocumentKind {
    fn from(value: core::DocumentKind) -> Self {
        match value {
            core::DocumentKind::Api => Self::Api,
            core::DocumentKind::Theory => Self::Theory,
            core::DocumentKind::Example => Self::Example,
        }
    }
}
fn document_kind(value: i32) -> core::Result<core::DocumentKind> {
    match pb::DocumentKind::try_from(value) {
        Ok(pb::DocumentKind::Api) => Ok(core::DocumentKind::Api),
        Ok(pb::DocumentKind::Theory) => Ok(core::DocumentKind::Theory),
        Ok(pb::DocumentKind::Example) => Ok(core::DocumentKind::Example),
        _ => Err(invalid("unknown or unspecified document kind")),
    }
}
impl From<core::VerificationStatus> for pb::VerificationStatus {
    fn from(value: core::VerificationStatus) -> Self {
        match value {
            core::VerificationStatus::SourceOnly => Self::SourceOnly,
            core::VerificationStatus::StaticallyChecked => Self::StaticallyChecked,
            core::VerificationStatus::Executed => Self::Executed,
        }
    }
}
fn verification_status(value: i32) -> core::Result<core::VerificationStatus> {
    match pb::VerificationStatus::try_from(value) {
        Ok(pb::VerificationStatus::SourceOnly) => Ok(core::VerificationStatus::SourceOnly),
        Ok(pb::VerificationStatus::StaticallyChecked) => {
            Ok(core::VerificationStatus::StaticallyChecked)
        }
        Ok(pb::VerificationStatus::Executed) => Ok(core::VerificationStatus::Executed),
        _ => Err(invalid("unknown or unspecified verification status")),
    }
}
macro_rules! identical {
    ($name:ident { $($field:ident),* $(,)? }) => {
        impl From<core::$name> for pb::$name { fn from(v: core::$name) -> Self { Self { $($field: v.$field),* } } }
        impl From<pb::$name> for core::$name { fn from(v: pb::$name) -> Self { Self { $($field: v.$field),* } } }
    }
}
identical!(LicenseInfo {
    name,
    url,
    attribution
});
identical!(CodeBlock { language, code });
identical!(ExampleMetadata {
    genres,
    roles,
    bpm,
    key,
    required_samples,
    related_api,
    musical_concepts
});
impl From<core::SourceRef> for pb::SourceRef {
    fn from(v: core::SourceRef) -> Self {
        Self {
            source_id: v.source_id,
            source_url: v.source_url,
            source_path: v.source_path,
            source_revision: v.source_revision,
            license: v.license.map(Into::into),
            fetched_at: v.fetched_at,
            etag: v.etag,
            last_modified: v.last_modified,
            notices: v.notices,
        }
    }
}
impl From<pb::SourceRef> for core::SourceRef {
    fn from(v: pb::SourceRef) -> Self {
        Self {
            source_id: v.source_id,
            source_url: v.source_url,
            source_path: v.source_path,
            source_revision: v.source_revision,
            license: v.license.map(Into::into),
            fetched_at: v.fetched_at,
            etag: v.etag,
            last_modified: v.last_modified,
            notices: v.notices,
        }
    }
}
impl From<core::Record> for pb::Record {
    fn from(v: core::Record) -> Self {
        Self {
            document_id: v.document_id,
            kind: pb::DocumentKind::from(v.kind) as i32,
            title: v.title,
            heading_path: v.heading_path,
            source: Some(v.source.into()),
            language: v.language,
            content: v.content,
            code_blocks: v.code_blocks.into_iter().map(Into::into).collect(),
            tags: v.tags,
            parent_document_id: v.parent_document_id,
            content_hash: v.content_hash,
            verification_status: pb::VerificationStatus::from(v.verification_status) as i32,
            verification_evidence: v.verification_evidence,
            example_metadata: v.example_metadata.map(Into::into),
            chunk_id: v.chunk_id,
        }
    }
}
impl TryFrom<pb::Record> for core::Record {
    type Error = core::Error;
    fn try_from(v: pb::Record) -> core::Result<Self> {
        if v.example_metadata
            .as_ref()
            .and_then(|m| m.bpm)
            .is_some_and(|b| !b.is_finite())
        {
            return Err(invalid("nonfinite example bpm"));
        }
        Ok(Self {
            document_id: v.document_id,
            kind: document_kind(v.kind)?,
            title: v.title,
            heading_path: v.heading_path,
            source: required(v.source, "missing record source")?.into(),
            language: v.language,
            content: v.content,
            code_blocks: v.code_blocks.into_iter().map(Into::into).collect(),
            tags: v.tags,
            parent_document_id: v.parent_document_id,
            content_hash: v.content_hash,
            verification_status: verification_status(v.verification_status)?,
            verification_evidence: v.verification_evidence,
            example_metadata: v.example_metadata.map(Into::into),
            chunk_id: v.chunk_id,
        })
    }
}
impl TryFrom<core::SearchRequest> for pb::SearchRequest {
    type Error = core::Error;
    fn try_from(v: core::SearchRequest) -> core::Result<Self> {
        Ok(Self {
            query: v.query,
            intent: match v.intent {
                core::SearchIntent::Api => pb::SearchIntent::Api,
                core::SearchIntent::Musical => pb::SearchIntent::Musical,
                core::SearchIntent::Example => pb::SearchIntent::Example,
                core::SearchIntent::Mixed => pb::SearchIntent::Mixed,
            } as i32,
            top_k: v.top_k.map(wire_count).transpose()?,
            filters: Some(pb::SearchFilters {
                kinds: v
                    .filters
                    .kinds
                    .into_iter()
                    .map(|v| pb::DocumentKind::from(v) as i32)
                    .collect(),
                source_ids: v.filters.source_ids,
                tags: v.filters.tags,
                languages: v.filters.languages,
            }),
        })
    }
}
impl TryFrom<pb::SearchRequest> for core::SearchRequest {
    type Error = core::Error;
    fn try_from(v: pb::SearchRequest) -> core::Result<Self> {
        let intent = match pb::SearchIntent::try_from(v.intent) {
            Ok(pb::SearchIntent::Unspecified | pb::SearchIntent::Mixed) => {
                core::SearchIntent::Mixed
            }
            Ok(pb::SearchIntent::Api) => core::SearchIntent::Api,
            Ok(pb::SearchIntent::Musical) => core::SearchIntent::Musical,
            Ok(pb::SearchIntent::Example) => core::SearchIntent::Example,
            Err(_) => return Err(invalid("unknown search intent")),
        };
        let filters = v.filters.unwrap_or_default();
        if v.query.trim().is_empty() || v.query.len() > 4096 {
            return Err(invalid(
                "query must contain text and be at most 4096 UTF-8 bytes",
            ));
        }
        if v.top_k.is_some_and(|k| k == 0 || k > 50) {
            return Err(invalid("top_k must be between 1 and 50"));
        }
        Ok(Self {
            query: v.query,
            intent,
            top_k: v.top_k.map(|v| v as usize),
            filters: core::SearchFilters {
                kinds: filters
                    .kinds
                    .into_iter()
                    .map(document_kind)
                    .collect::<core::Result<_>>()?,
                source_ids: filters.source_ids,
                tags: filters.tags,
                languages: filters.languages,
            },
        })
    }
}
impl TryFrom<core::SearchHit> for pb::SearchHit {
    type Error = core::Error;
    fn try_from(v: core::SearchHit) -> core::Result<Self> {
        Ok(Self {
            record: Some(v.record.into()),
            lexical_rank: v.lexical_rank.map(wire_count).transpose()?,
            lexical_score: v.lexical_score,
            vector_rank: v.vector_rank.map(wire_count).transpose()?,
            vector_score: v.vector_score,
            fusion_score: v.fusion_score,
            alternate_sources: v.alternate_sources.into_iter().map(Into::into).collect(),
        })
    }
}
impl TryFrom<pb::SearchHit> for core::SearchHit {
    type Error = core::Error;
    fn try_from(v: pb::SearchHit) -> core::Result<Self> {
        if !v.fusion_score.is_finite()
            || v.lexical_score.is_some_and(|x| !x.is_finite())
            || v.vector_score.is_some_and(|x| !x.is_finite())
        {
            return Err(invalid("nonfinite retrieval score"));
        }
        Ok(Self {
            record: required(v.record, "missing hit record")?.try_into()?,
            lexical_rank: v.lexical_rank.map(|v| v as usize),
            lexical_score: v.lexical_score,
            vector_rank: v.vector_rank.map(|v| v as usize),
            vector_score: v.vector_score,
            fusion_score: v.fusion_score,
            alternate_sources: v.alternate_sources.into_iter().map(Into::into).collect(),
        })
    }
}
impl TryFrom<core::SearchResponse> for pb::SearchResponse {
    type Error = core::Error;
    fn try_from(v: core::SearchResponse) -> core::Result<Self> {
        let d = v.diagnostics;
        Ok(Self {
            results: v
                .results
                .into_iter()
                .map(TryInto::try_into)
                .collect::<core::Result<_>>()?,
            diagnostics: Some(pb::SearchDiagnostics {
                generation: d.generation,
                model: d.model,
                dimension: wire_count(d.dimension)?,
                lexical_candidates: wire_count(d.lexical_candidates)?,
                vector_candidates: wire_count(d.vector_candidates)?,
                diversity_applied: d.diversity_applied,
                fixture: d.fixture,
                scores_are_probabilities: d.scores_are_probabilities,
            }),
        })
    }
}
impl TryFrom<pb::SearchResponse> for core::SearchResponse {
    type Error = core::Error;
    fn try_from(v: pb::SearchResponse) -> core::Result<Self> {
        let d = required(v.diagnostics, "missing search diagnostics")?;
        Ok(Self {
            results: v
                .results
                .into_iter()
                .map(TryInto::try_into)
                .collect::<core::Result<_>>()?,
            diagnostics: core::SearchDiagnostics {
                generation: d.generation,
                model: d.model,
                dimension: d.dimension as usize,
                lexical_candidates: d.lexical_candidates as usize,
                vector_candidates: d.vector_candidates as usize,
                diversity_applied: d.diversity_applied,
                fixture: d.fixture,
                scores_are_probabilities: d.scores_are_probabilities,
            },
        })
    }
}
impl From<(core::DocumentReference, bool)> for pb::GetDocumentRequest {
    fn from((reference, parent_context): (core::DocumentReference, bool)) -> Self {
        Self {
            reference: Some(match reference {
                core::DocumentReference::DocumentId(id) => {
                    pb::get_document_request::Reference::DocumentId(id)
                }
                core::DocumentReference::ChunkId(id) => {
                    pb::get_document_request::Reference::ChunkId(id)
                }
            }),
            parent_context,
        }
    }
}
impl TryFrom<pb::GetDocumentRequest> for (core::DocumentReference, bool) {
    type Error = core::Error;
    fn try_from(v: pb::GetDocumentRequest) -> core::Result<Self> {
        let reference = match required(v.reference, "missing document or chunk reference")? {
            pb::get_document_request::Reference::DocumentId(id) if !id.is_empty() => {
                core::DocumentReference::DocumentId(id)
            }
            pb::get_document_request::Reference::ChunkId(id) if !id.is_empty() => {
                core::DocumentReference::ChunkId(id)
            }
            _ => return Err(invalid("empty document or chunk reference")),
        };
        Ok((reference, v.parent_context))
    }
}
impl From<core::DocumentResponse> for pb::GetDocumentResponse {
    fn from(v: core::DocumentResponse) -> Self {
        Self {
            record: Some(v.record.into()),
            index_version: v.index_version,
        }
    }
}
impl TryFrom<pb::GetDocumentResponse> for core::DocumentResponse {
    type Error = core::Error;
    fn try_from(v: pb::GetDocumentResponse) -> core::Result<Self> {
        Ok(Self {
            record: required(v.record, "missing document record")?.try_into()?,
            index_version: v.index_version,
        })
    }
}
impl TryFrom<core::CorpusInfo> for pb::GetCorpusInfoResponse {
    type Error = core::Error;
    fn try_from(v: core::CorpusInfo) -> core::Result<Self> {
        Ok(Self {
            ready: v.ready,
            readiness_reason: v.readiness_reason,
            documents: v.documents as u64,
            chunks: v.chunks as u64,
            counts_by_kind: v
                .counts_by_kind
                .into_iter()
                .map(|k| pb::KindCount {
                    kind: pb::DocumentKind::from(k.kind) as i32,
                    documents: k.documents as u64,
                    chunks: k.chunks as u64,
                })
                .collect(),
            sources: v
                .sources
                .into_iter()
                .map(|s| pb::SourceInfo {
                    source_id: s.source_id,
                    revision: s.revision,
                    license: s.license.map(Into::into),
                    coverage_gaps: s.coverage_gaps,
                })
                .collect(),
            model: v.model,
            dimension: v.dimension.map(wire_count).transpose()?,
            fingerprint: v.fingerprint,
            index_version: v.index_version,
            built_at: v.built_at,
            fixture: v.fixture,
        })
    }
}
impl TryFrom<pb::GetCorpusInfoResponse> for core::CorpusInfo {
    type Error = core::Error;
    fn try_from(v: pb::GetCorpusInfoResponse) -> core::Result<Self> {
        Ok(Self {
            ready: v.ready,
            readiness_reason: v.readiness_reason,
            documents: domain_count(v.documents)?,
            chunks: domain_count(v.chunks)?,
            counts_by_kind: v
                .counts_by_kind
                .into_iter()
                .map(|k| {
                    Ok(core::KindCount {
                        kind: document_kind(k.kind)?,
                        documents: domain_count(k.documents)?,
                        chunks: domain_count(k.chunks)?,
                    })
                })
                .collect::<core::Result<_>>()?,
            sources: v
                .sources
                .into_iter()
                .map(|s| core::SourceInfo {
                    source_id: s.source_id,
                    revision: s.revision,
                    license: s.license.map(Into::into),
                    coverage_gaps: s.coverage_gaps,
                })
                .collect(),
            model: v.model,
            dimension: v.dimension.map(|v| v as usize),
            fingerprint: v.fingerprint,
            index_version: v.index_version,
            built_at: v.built_at,
            fixture: v.fixture,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unknown_enums_and_invalid_requests() {
        assert!(document_kind(0).is_err());
        assert!(document_kind(99).is_err());
        assert!(verification_status(0).is_err());
        for (query, top_k, intent) in [
            ("", Some(1), 0),
            ("ok", Some(0), 0),
            ("ok", Some(51), 0),
            ("ok", Some(1), 99),
        ] {
            assert!(
                core::SearchRequest::try_from(pb::SearchRequest {
                    query: query.into(),
                    top_k,
                    intent,
                    filters: None
                })
                .is_err()
            );
        }
        assert!(
            <(core::DocumentReference, bool)>::try_from(pb::GetDocumentRequest::default()).is_err()
        );
    }
    #[test]
    fn unspecified_intent_is_mixed() {
        let request = core::SearchRequest::try_from(pb::SearchRequest {
            query: "slow".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(request.intent, core::SearchIntent::Mixed);
    }
}
