use async_trait::async_trait;
use std::sync::Arc;
use strudel_rag_core::*;
struct SelectiveProvider;
#[async_trait]
impl EmbeddingProvider for SelectiveProvider {
    fn identity(&self) -> EmbeddingIdentity {
        EmbeddingIdentity {
            base_url: "fixture://selective".into(),
            model: "selective".into(),
            dimensions: Some(2),
            embedding_text_version: 1,
        }
    }
    async fn embed(&self, inputs: &[String]) -> Result<EmbeddingBatch> {
        Ok(EmbeddingBatch {
            model: "selective".into(),
            vectors: inputs
                .iter()
                .map(|s| {
                    if s.contains("offtopic") {
                        vec![0.0, 1.0]
                    } else {
                        vec![1.0, 0.0]
                    }
                })
                .collect(),
        })
    }
}
fn doc(id: &str, kind: DocumentKind, content: &str) -> Document {
    Document {
        document_id: document_id(id, "fixture.md", ""),
        kind,
        title: "Relevant fixture".into(),
        heading_path: vec![],
        source: SourceRef {
            source_id: id.into(),
            source_path: Some("fixture.md".into()),
            ..Default::default()
        },
        language: Some("en".into()),
        content: content.into(),
        code_blocks: vec![],
        tags: vec!["required".into()],
        parent_document_id: None,
        content_hash: content_hash(content),
        verification_status: VerificationStatus::SourceOnly,
        verification_evidence: None,
        example_metadata: None,
    }
}
fn publish(c: &Config, d: Document) {
    let _lock = WriterLock::acquire(&c.data_dir).unwrap();
    publish_source(
        c,
        &SourceSnapshot {
            source_id: d.source.source_id.clone(),
            documents: vec![d],
            fixture: true,
            ..Default::default()
        },
    )
    .unwrap();
}
#[tokio::test]
async fn mixed_never_promotes_an_excluded_kind_and_failed_index_keeps_current() {
    let temp = tempfile::tempdir().unwrap();
    let config = Config {
        data_dir: temp.path().join("data"),
        ..Default::default()
    };
    publish(&config, doc("api", DocumentKind::Api, "pulse timing"));
    publish(&config, doc("theory", DocumentKind::Theory, "pulse meter"));
    publish(
        &config,
        doc("example", DocumentKind::Example, "offtopic forest"),
    );
    let p: Arc<dyn EmbeddingProvider> = Arc::new(SelectiveProvider);
    let report = build_index(&config, p.clone(), false).await.unwrap();
    let engine = RagEngine::open(&config, p.clone()).unwrap();
    let response = engine
        .search(SearchRequest {
            query: "pulse".into(),
            top_k: Some(8),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(response.results.len(), 2);
    assert!(
        response
            .results
            .iter()
            .all(|h| h.record.kind != DocumentKind::Example)
    );
    assert!(
        response
            .results
            .iter()
            .any(|h| h.record.kind == DocumentKind::Api)
    );
    assert!(
        response
            .results
            .iter()
            .any(|h| h.record.kind == DocumentKind::Theory)
    );
    let filtered = engine
        .search(SearchRequest {
            query: "pulse".into(),
            filters: SearchFilters {
                tags: vec!["required".into(), "missing".into()],
                ..Default::default()
            },
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(filtered.results.is_empty());
    let mut broken = doc("api", DocumentKind::Api, "new pulse content");
    broken.parent_document_id = Some("doc_missing_parent".into());
    publish(&config, broken);
    assert!(build_index(&config, p.clone(), false).await.is_err());
    let still = RagEngine::open(&config, p).unwrap();
    assert_eq!(still.corpus_info().index_version, Some(report.generation));
}
#[tokio::test]
async fn cache_rejects_inconsistent_reported_models() {
    let temp = tempfile::tempdir().unwrap();
    let config = Config {
        data_dir: temp.path().join("data"),
        ..Default::default()
    };
    let p = SelectiveProvider;
    let inputs = vec!["pulse".into(), "offtopic".into()];
    cached_embeddings(&config, &p, &inputs).await.unwrap();
    let path = config
        .data_dir
        .join("embedding-cache")
        .join(p.identity().fingerprint())
        .join(format!("{}.json", sha256("offtopic")));
    let mut cache: CachedEmbedding = read_json(&path).unwrap();
    cache.model = "different-model".into();
    write_json(&path, &cache).unwrap();
    assert!(cached_embeddings(&config, &p, &inputs).await.is_err());
}
#[test]
fn unclosed_fences_and_frontmatter_only_are_handled() {
    let d = doc(
        "fixture",
        DocumentKind::Api,
        "# API\nIntro\n\n```js\ns('bd')\n# nested heading stays code",
    );
    let chunks = chunk_document(&d, &ChunkConfig::default()).unwrap();
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].content, d.content);
    assert_eq!(chunks[0].heading_path, vec!["API"]);
    let empty = doc(
        "fixture",
        DocumentKind::Api,
        "---\ntitle: only metadata\n---",
    );
    assert!(
        chunk_document(&empty, &ChunkConfig::default())
            .unwrap()
            .is_empty()
    );
}
