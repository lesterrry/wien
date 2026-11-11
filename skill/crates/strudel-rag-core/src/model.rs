use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum DocumentKind {
    Api,
    Theory,
    Example,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    SourceOnly,
    StaticallyChecked,
    Executed,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct LicenseInfo {
    pub name: Option<String>,
    pub url: Option<String>,
    pub attribution: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceRef {
    pub source_id: String,
    pub source_url: Option<String>,
    pub source_path: Option<String>,
    pub source_revision: Option<String>,
    pub license: Option<LicenseInfo>,
    pub fetched_at: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    #[serde(default)]
    pub notices: Vec<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ExampleMetadata {
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub roles: Vec<String>,
    pub bpm: Option<f64>,
    pub key: Option<String>,
    #[serde(default)]
    pub required_samples: Vec<String>,
    #[serde(default)]
    pub related_api: Vec<String>,
    #[serde(default)]
    pub musical_concepts: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CodeBlock {
    pub language: Option<String>,
    pub code: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Document {
    pub document_id: String,
    pub kind: DocumentKind,
    pub title: String,
    #[serde(default)]
    pub heading_path: Vec<String>,
    pub source: SourceRef,
    pub language: Option<String>,
    pub content: String,
    #[serde(default)]
    pub code_blocks: Vec<CodeBlock>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub parent_document_id: Option<String>,
    pub content_hash: String,
    pub verification_status: VerificationStatus,
    pub verification_evidence: Option<String>,
    pub example_metadata: Option<ExampleMetadata>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Chunk {
    pub chunk_id: String,
    pub document_id: String,
    pub kind: DocumentKind,
    pub title: String,
    pub heading_path: Vec<String>,
    pub source: SourceRef,
    pub language: Option<String>,
    pub content: String,
    pub code_blocks: Vec<CodeBlock>,
    pub tags: Vec<String>,
    pub parent_document_id: Option<String>,
    pub content_hash: String,
    pub verification_status: VerificationStatus,
    pub verification_evidence: Option<String>,
    pub example_metadata: Option<ExampleMetadata>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Record {
    pub document_id: String,
    pub kind: DocumentKind,
    pub title: String,
    pub heading_path: Vec<String>,
    pub source: SourceRef,
    pub language: Option<String>,
    pub content: String,
    pub code_blocks: Vec<CodeBlock>,
    pub tags: Vec<String>,
    pub parent_document_id: Option<String>,
    pub content_hash: String,
    pub verification_status: VerificationStatus,
    pub verification_evidence: Option<String>,
    pub example_metadata: Option<ExampleMetadata>,
    pub chunk_id: Option<String>,
}
impl From<&Document> for Record {
    fn from(d: &Document) -> Self {
        Self {
            document_id: d.document_id.clone(),
            kind: d.kind,
            title: d.title.clone(),
            heading_path: d.heading_path.clone(),
            source: d.source.clone(),
            language: d.language.clone(),
            content: d.content.clone(),
            code_blocks: d.code_blocks.clone(),
            tags: d.tags.clone(),
            parent_document_id: d.parent_document_id.clone(),
            content_hash: d.content_hash.clone(),
            verification_status: d.verification_status,
            verification_evidence: d.verification_evidence.clone(),
            example_metadata: d.example_metadata.clone(),
            chunk_id: None,
        }
    }
}
impl From<&Chunk> for Record {
    fn from(d: &Chunk) -> Self {
        Self {
            document_id: d.document_id.clone(),
            kind: d.kind,
            title: d.title.clone(),
            heading_path: d.heading_path.clone(),
            source: d.source.clone(),
            language: d.language.clone(),
            content: d.content.clone(),
            code_blocks: d.code_blocks.clone(),
            tags: d.tags.clone(),
            parent_document_id: d.parent_document_id.clone(),
            content_hash: d.content_hash.clone(),
            verification_status: d.verification_status,
            verification_evidence: d.verification_evidence.clone(),
            example_metadata: d.example_metadata.clone(),
            chunk_id: Some(d.chunk_id.clone()),
        }
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SourceSnapshot {
    pub source_id: String,
    pub revision: Option<String>,
    pub documents: Vec<Document>,
    pub fixture: bool,
    #[serde(default)]
    pub coverage_gaps: Vec<String>,
    #[serde(default)]
    pub raw_hashes: BTreeMap<String, String>,
}
pub fn sha256(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
pub fn content_hash(text: &str) -> String {
    sha256(text.replace("\r\n", "\n"))
}
pub fn document_id(source_id: &str, path: &str, extraction_key: &str) -> String {
    format!(
        "doc_{}",
        sha256(
            serde_json::to_vec(&(source_id, path, extraction_key))
                .expect("string tuple serialization")
        )
    )
}
pub fn chunk_id(document_id: &str, heading_path: &[String], hash: &str, ordinal: usize) -> String {
    format!(
        "chk_{}",
        sha256(
            serde_json::to_vec(&(document_id, heading_path, hash, ordinal))
                .expect("string tuple serialization")
        )
    )
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SearchIntent {
    Api,
    Musical,
    Example,
    #[default]
    Mixed,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SearchFilters {
    #[serde(default)]
    pub kinds: Vec<DocumentKind>,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub languages: Vec<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    #[serde(default)]
    pub intent: SearchIntent,
    pub top_k: Option<usize>,
    #[serde(default)]
    pub filters: SearchFilters,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub record: Record,
    pub lexical_rank: Option<usize>,
    pub lexical_score: Option<f32>,
    pub vector_rank: Option<usize>,
    pub vector_score: Option<f32>,
    pub fusion_score: f64,
    pub alternate_sources: Vec<SourceRef>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchDiagnostics {
    pub generation: String,
    pub model: String,
    pub dimension: usize,
    pub lexical_candidates: usize,
    pub vector_candidates: usize,
    pub diversity_applied: bool,
    pub fixture: bool,
    pub scores_are_probabilities: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    pub results: Vec<SearchHit>,
    pub diagnostics: SearchDiagnostics,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentReference {
    DocumentId(String),
    ChunkId(String),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentResponse {
    pub record: Record,
    pub index_version: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KindCount {
    pub kind: DocumentKind,
    pub documents: usize,
    pub chunks: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceInfo {
    pub source_id: String,
    pub revision: Option<String>,
    pub license: Option<LicenseInfo>,
    pub coverage_gaps: Vec<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CorpusInfo {
    pub ready: bool,
    pub readiness_reason: Option<String>,
    pub documents: usize,
    pub chunks: usize,
    pub counts_by_kind: Vec<KindCount>,
    pub sources: Vec<SourceInfo>,
    pub model: Option<String>,
    pub dimension: Option<usize>,
    pub fingerprint: Option<String>,
    pub index_version: Option<String>,
    pub built_at: Option<String>,
    pub fixture: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexReport {
    pub generation: String,
    pub documents: usize,
    pub chunks: usize,
    pub cache_hits: usize,
    pub cache_misses: usize,
    pub no_op: bool,
    pub fixture: bool,
}
