use crate::{store, *};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, sync::Arc};
use tantivy::{
    Index, doc,
    schema::{STORED, STRING, Schema, TEXT},
    tokenizer::{LowerCaser, SimpleTokenizer, TextAnalyzer},
};
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexManifest {
    pub schema_version: u32,
    pub generation: String,
    pub built_at: String,
    pub corpus_digest: String,
    pub config_digest: String,
    pub sources: Vec<SourceInfo>,
    pub documents: usize,
    pub chunks: usize,
    pub fingerprint: String,
    pub model: String,
    pub dimension: usize,
    pub fixture: bool,
}
pub struct IndexSnapshot {
    pub manifest: IndexManifest,
    pub documents: Vec<Document>,
    pub chunks: Vec<Chunk>,
    pub vectors: Vec<Vec<f32>>,
    pub lexical: Index,
}
pub fn register_tokenizer(index: &Index) {
    index.tokenizers().register(
        "default",
        TextAnalyzer::builder(SimpleTokenizer::default())
            .filter(LowerCaser)
            .build(),
    );
}
fn make_lexical(path: &Path, chunks: &[Chunk]) -> Result<()> {
    let mut b = Schema::builder();
    let id = b.add_text_field("chunk_id", STRING | STORED);
    let kind = b.add_text_field("kind", STRING);
    let source = b.add_text_field("source_id", STRING);
    let language = b.add_text_field("language", STRING);
    let tags = b.add_text_field("tags", STRING);
    let title = b.add_text_field("title", TEXT);
    let heading = b.add_text_field("heading_path", TEXT);
    let content = b.add_text_field("content", TEXT);
    let schema = b.build();
    fs::create_dir_all(path)?;
    let index = Index::create_in_dir(path, schema)?;
    register_tokenizer(&index);
    let mut writer = index.writer(50_000_000)?;
    for c in chunks {
        let mut d = doc!(id=>c.chunk_id.clone(),kind=>kind_name(c.kind),source=>c.source.source_id.clone(),title=>c.title.clone(),heading=>c.heading_path.join(" "),content=>c.content.clone());
        if let Some(l) = &c.language {
            d.add_text(language, l)
        }
        for tag in &c.tags {
            d.add_text(tags, tag)
        }
        writer.add_document(d)?;
    }
    writer.commit()?;
    writer.wait_merging_threads()?;
    Ok(())
}
pub fn kind_name(kind: DocumentKind) -> &'static str {
    match kind {
        DocumentKind::Api => "api",
        DocumentKind::Theory => "theory",
        DocumentKind::Example => "example",
    }
}
pub fn open_index(config: &Config) -> Result<Option<IndexSnapshot>> {
    let root = config.data_dir.join("indexes");
    let Some(path) = store::current_dir(&root)? else {
        return Ok(None);
    };
    Ok(Some(load_index_directory(&path)?))
}
fn load_index_directory(path: &Path) -> Result<IndexSnapshot> {
    let manifest: IndexManifest = store::read_json(&path.join("manifest.json"))?;
    if manifest.schema_version != 1 || manifest.dimension == 0 || manifest.model.is_empty() {
        return Err(Error::Corrupt(
            "unsupported or invalid index manifest".into(),
        ));
    }
    let documents: Vec<Document> = store::read_jsonl(&path.join("documents.jsonl"))?;
    let chunks: Vec<Chunk> = store::read_jsonl(&path.join("chunks.jsonl"))?;
    let vectors: Vec<Vec<f32>> = store::read_json(&path.join("vectors.json"))?;
    if documents.len() != manifest.documents
        || chunks.len() != manifest.chunks
        || vectors.len() != chunks.len()
        || chunks.is_empty()
    {
        return Err(Error::Corrupt("index record counts mismatch".into()));
    }
    let doc_ids = documents
        .iter()
        .map(|d| d.document_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    if doc_ids.len() != documents.len()
        || documents.iter().any(|d| {
            d.content_hash != content_hash(&d.content)
                || d.parent_document_id
                    .as_ref()
                    .is_some_and(|id| !doc_ids.contains(id.as_str()))
        })
    {
        return Err(Error::Corrupt(
            "invalid document content hash, ID or parent".into(),
        ));
    }
    let mut chunk_ids = std::collections::HashSet::new();
    for c in &chunks {
        if !doc_ids.contains(c.document_id.as_str())
            || !chunk_ids.insert(&c.chunk_id)
            || c.content_hash != content_hash(&c.content)
            || c.parent_document_id
                .as_ref()
                .is_some_and(|id| !doc_ids.contains(id.as_str()))
        {
            return Err(Error::Corrupt(
                "invalid chunk references, content hash or duplicate IDs".into(),
            ));
        }
    }
    for v in &vectors {
        let norm = v.iter().map(|&x| (x as f64).powi(2)).sum::<f64>();
        if v.len() != manifest.dimension
            || v.iter().any(|x| !x.is_finite())
            || (norm - 1.0).abs() > 0.001
        {
            return Err(Error::Corrupt("invalid stored vector".into()));
        }
    }
    let lexical = Index::open_in_dir(path.join("tantivy"))?;
    register_tokenizer(&lexical);
    let reader = lexical.reader()?;
    if reader.searcher().num_docs() != chunks.len() as u64 {
        return Err(Error::Corrupt("lexical index record count mismatch".into()));
    }
    Ok(IndexSnapshot {
        manifest,
        documents,
        chunks,
        vectors,
        lexical,
    })
}
pub async fn build_index(
    config: &Config,
    provider: Arc<dyn EmbeddingProvider>,
    rebuild: bool,
) -> Result<IndexReport> {
    config.validate()?;
    let _lock = WriterLock::acquire(&config.data_dir)?;
    let sources = load_sources(config)?;
    let fixture = sources.iter().any(|s| s.fixture);
    if config.embedding.provider == "mock"
        && (!config.allow_fixture || !fixture || sources.iter().any(|s| !s.fixture))
    {
        return Err(Error::Config(
            "mock indexing requires explicitly allowed all-fixture corpus".into(),
        ));
    }
    let mut documents = sources
        .iter()
        .flat_map(|s| s.documents.clone())
        .collect::<Vec<_>>();
    documents.sort_by(|a, b| a.document_id.cmp(&b.document_id));
    if documents.is_empty() {
        return Err(Error::NotReady(
            "normalized corpus is empty; ingest sources first".into(),
        ));
    }
    if documents
        .windows(2)
        .any(|w| w[0].document_id == w[1].document_id)
    {
        return Err(Error::Corrupt("duplicate document identity".into()));
    }
    let corpus_digest = sha256(serde_json::to_vec(&sources)?);
    let fingerprint = provider.identity().fingerprint();
    let config_digest = sha256(serde_json::to_vec(&(&config.chunking, &fingerprint))?);
    if let Some(old) = open_index(config)? {
        if old.manifest.fingerprint != fingerprint && !rebuild {
            return Err(Error::Config(
                "embedding identity changed: index --rebuild required".into(),
            ));
        }
        if !rebuild
            && old.manifest.corpus_digest == corpus_digest
            && old.manifest.config_digest == config_digest
        {
            return Ok(IndexReport {
                generation: old.manifest.generation,
                documents: old.documents.len(),
                chunks: old.chunks.len(),
                cache_hits: old.chunks.len(),
                cache_misses: 0,
                no_op: true,
                fixture,
            });
        }
    }
    let mut chunks = Vec::new();
    for d in &documents {
        chunks.extend(chunk_document(d, &config.chunking)?)
    }
    if chunks.is_empty() {
        return Err(Error::NotReady("corpus has no nonempty chunks".into()));
    }
    chunks.sort_by(|a, b| a.chunk_id.cmp(&b.chunk_id));
    let inputs = chunks.iter().map(embedding_text).collect::<Vec<_>>();
    let (batch, cache_hits, cache_misses) =
        cached_embeddings(config, provider.as_ref(), &inputs).await?;
    let dimension = batch
        .vectors
        .first()
        .map(Vec::len)
        .ok_or_else(|| Error::Provider("no embeddings returned".into()))?;
    let generation = sha256(serde_json::to_vec(&(
        &corpus_digest,
        &config_digest,
        &batch.model,
        dimension,
    ))?);
    let root = config.data_dir.join("indexes");
    fs::create_dir_all(&root)?;
    let target = root.join(&generation);
    let manifest = IndexManifest {
        schema_version: 1,
        generation: generation.clone(),
        built_at: time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|e| Error::Other(e.to_string()))?,
        corpus_digest,
        config_digest,
        sources: sources
            .iter()
            .map(|s| SourceInfo {
                source_id: s.source_id.clone(),
                revision: s.revision.clone(),
                license: s.documents.iter().find_map(|d| d.source.license.clone()),
                coverage_gaps: s.coverage_gaps.clone(),
            })
            .collect(),
        documents: documents.len(),
        chunks: chunks.len(),
        fingerprint,
        model: batch.model,
        dimension,
        fixture,
    };
    if !target.exists() {
        let tmp = tempfile::Builder::new()
            .prefix(".generation-")
            .tempdir_in(&root)?;
        store::write_json(&tmp.path().join("manifest.json"), &manifest)?;
        store::write_jsonl(&tmp.path().join("documents.jsonl"), &documents)?;
        store::write_jsonl(&tmp.path().join("chunks.jsonl"), &chunks)?;
        store::write_json(&tmp.path().join("vectors.json"), &batch.vectors)?;
        make_lexical(&tmp.path().join("tantivy"), &chunks)?;
        load_index_directory(tmp.path())?;
        fs::rename(tmp.path(), &target)?;
    } else {
        load_index_directory(&target)?;
    }
    store::atomic_write(&root.join("CURRENT"), generation.as_bytes())?;
    Ok(IndexReport {
        generation,
        documents: documents.len(),
        chunks: chunks.len(),
        cache_hits,
        cache_misses,
        no_op: false,
        fixture,
    })
}
