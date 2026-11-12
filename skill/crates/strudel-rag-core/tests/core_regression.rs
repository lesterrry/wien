use async_trait::async_trait;
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use strudel_rag_core::*;
fn document(source: &str, kind: DocumentKind, content: &str) -> Document {
    Document {
        document_id: document_id(source, "fixture.md", ""),
        kind,
        title: "Fixture slow euclid".into(),
        heading_path: vec![],
        source: SourceRef {
            source_id: source.into(),
            source_path: Some("fixture.md".into()),
            ..Default::default()
        },
        language: Some("en".into()),
        content: content.replace("\r\n", "\n"),
        code_blocks: code_blocks(content),
        tags: vec![],
        parent_document_id: None,
        content_hash: content_hash(content),
        verification_status: VerificationStatus::SourceOnly,
        verification_evidence: None,
        example_metadata: None,
    }
}
fn config(temp: &tempfile::TempDir) -> Config {
    Config {
        data_dir: temp.path().join("data"),
        allow_fixture: true,
        ..Default::default()
    }
}
fn snapshot(documents: Vec<Document>) -> SourceSnapshot {
    SourceSnapshot {
        source_id: documents[0].source.source_id.clone(),
        revision: Some("fixture-revision".into()),
        documents,
        fixture: true,
        coverage_gaps: vec![],
        raw_hashes: BTreeMap::new(),
    }
}
#[test]
fn chunking_preserves_fences_and_oversized_blocks() {
    let code = "```js\n// # not a heading\ns(\"bd [hh hh]\").slow(2)\n```";
    let text = format!(
        "---\ntitle: ignored\n---\n# API\r\n\r\nIntro.\r\n\r\n{}\r\n\r\n## Other\r\nText",
        code.replace('\n', "\r\n")
    );
    let doc = document("fixture", DocumentKind::Api, &text);
    let chunks = chunk_document(
        &doc,
        &ChunkConfig {
            target_tokens_approx: 3,
            max_tokens_approx: 10,
        },
    )
    .unwrap();
    assert!(chunks.iter().any(|c| c.content.contains(code)));
    assert!(chunks.iter().all(|c| !c.content.contains("title: ignored")));
    assert!(
        chunks
            .iter()
            .all(|c| !c.heading_path.iter().any(|h| h == "not a heading"))
    );
    let big = document(
        "fixture",
        DocumentKind::Example,
        &format!("```js\n{}\n```", "s('bd');\n".repeat(1000)),
    );
    let chunks = chunk_document(&big, &ChunkConfig::default()).unwrap();
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].content, big.content);
}
#[test]
fn stable_ids_ignore_revision_but_chunks_follow_content() {
    let mut d = document("fixture", DocumentKind::Api, "# slow\nSlower pattern.");
    let before = chunk_document(&d, &ChunkConfig::default()).unwrap();
    d.source.source_revision = Some("other".into());
    assert_eq!(
        before[0].chunk_id,
        chunk_document(&d, &ChunkConfig::default()).unwrap()[0].chunk_id
    );
    d.content.push_str(" Updated.");
    assert_ne!(
        before[0].chunk_id,
        chunk_document(&d, &ChunkConfig::default()).unwrap()[0].chunk_id
    );
    assert_ne!(document_id("a", "x", ""), document_id("b", "x", ""));
    assert_eq!(content_hash("a\r\nb"), content_hash("a\nb"));
}
#[test]
fn rrf_reference_formula() {
    let a = rrf_score(Some(1), None, 60.0);
    let b = rrf_score(Some(2), Some(1), 60.0);
    let c = rrf_score(None, Some(2), 60.0);
    assert!(b > a && b > c);
    assert_eq!(b, 1.0 / 62.0 + 1.0 / 61.0);
}
#[test]
fn vector_validation_rejects_bad_values() {
    for mut vector in [
        vec![0.0, 0.0],
        vec![f32::NAN, 1.0],
        vec![f32::INFINITY, 1.0],
    ] {
        assert!(normalize_vector(&mut vector, Some(2)).is_err())
    }
    assert!(normalize_vector(&mut [1.0, 2.0], Some(3)).is_err());
}
#[test]
fn source_publication_keeps_last_good_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let c = config(&temp);
    let _lock = WriterLock::acquire(&c.data_dir).unwrap();
    let source = snapshot(vec![document("fixture", DocumentKind::Api, "slow")]);
    assert!(publish_source(&c, &source).unwrap());
    assert!(!publish_source(&c, &source).unwrap());
    let root = c.data_dir.join("normalized/fixture");
    let previous = std::fs::read(root.join("CURRENT")).unwrap();
    let interrupted = root.join("snapshots/.interrupted");
    std::fs::create_dir_all(interrupted).unwrap();
    assert_eq!(
        load_sources(&c).unwrap()[0].documents[0],
        source.documents[0]
    );
    let mut bad = source.clone();
    bad.documents[0].source.source_id = "other".into();
    assert!(publish_source(&c, &bad).is_err());
    assert_eq!(std::fs::read(root.join("CURRENT")).unwrap(), previous);
}
struct CountingProvider(AtomicUsize);
#[async_trait]
impl EmbeddingProvider for CountingProvider {
    fn identity(&self) -> EmbeddingIdentity {
        EmbeddingIdentity {
            base_url: "fixture://counting".into(),
            model: "counting".into(),
            dimensions: Some(2),
            embedding_text_version: 1,
        }
    }
    async fn embed(&self, inputs: &[String]) -> Result<EmbeddingBatch> {
        self.0.fetch_add(inputs.len(), Ordering::SeqCst);
        Ok(EmbeddingBatch {
            model: "counting".into(),
            vectors: inputs.iter().map(|_| vec![1.0, 0.0]).collect(),
        })
    }
}
#[tokio::test]
async fn cache_reuses_text_and_rejects_corruption() {
    let temp = tempfile::tempdir().unwrap();
    let c = config(&temp);
    let p = CountingProvider(AtomicUsize::new(0));
    let texts = vec!["slow".into()];
    assert_eq!(cached_embeddings(&c, &p, &texts).await.unwrap().2, 1);
    assert_eq!(cached_embeddings(&c, &p, &texts).await.unwrap().1, 1);
    assert_eq!(p.0.load(Ordering::SeqCst), 1);
    let path = c
        .data_dir
        .join("embedding-cache")
        .join(p.identity().fingerprint())
        .join(format!("{}.json", sha256("slow")));
    let mut entry: CachedEmbedding = read_json(&path).unwrap();
    entry.dimension = 3;
    write_json(&path, &entry).unwrap();
    assert!(cached_embeddings(&c, &p, &texts).await.is_err());
}
#[tokio::test]
async fn hybrid_filters_dedup_parents_and_generation_are_real() {
    let temp = tempfile::tempdir().unwrap();
    let mut c = config(&temp);
    c.retrieval.candidate_k = 1;
    c.retrieval.min_cosine = 0.3;
    let p: Arc<dyn EmbeddingProvider> = Arc::new(CountingProvider(AtomicUsize::new(0)));
    let mut a = document(
        "a",
        DocumentKind::Api,
        "# slow\nUse slow to stretch cycles.",
    );
    a.tags = vec!["selected".into()];
    let mut b = document("b", DocumentKind::Api, &a.content);
    b.tags = a.tags.clone();
    {
        let _lock = WriterLock::acquire(&c.data_dir).unwrap();
        publish_source(&c, &snapshot(vec![a.clone()])).unwrap();
        publish_source(&c, &snapshot(vec![b])).unwrap();
    }
    let first = build_index(&c, p.clone(), false).await.unwrap();
    let engine = RagEngine::open(&c, p.clone()).unwrap();
    let response = engine
        .search(SearchRequest {
            query: "slow cycles".into(),
            top_k: Some(5),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(response.results.len(), 1);
    assert_eq!(response.results[0].alternate_sources.len(), 1);
    let hit = &response.results[0];
    let parent = engine
        .get_document(
            DocumentReference::ChunkId(hit.record.chunk_id.clone().unwrap()),
            true,
        )
        .unwrap();
    assert_eq!(parent.record.content, a.content);
    assert!(parent.record.chunk_id.is_none());
    assert!(matches!(
        engine.get_document(DocumentReference::DocumentId("missing".into()), false),
        Err(Error::NotFound(_))
    ));
    let filtered = engine
        .search(SearchRequest {
            query: "slow".into(),
            filters: SearchFilters {
                source_ids: vec!["b".into()],
                ..Default::default()
            },
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(filtered.results[0].record.source.source_id, "b");
    let empty = engine
        .search(SearchRequest {
            query: "slow".into(),
            intent: SearchIntent::Musical,
            filters: SearchFilters {
                kinds: vec![DocumentKind::Api],
                ..Default::default()
            },
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(empty.results.is_empty());
    let second = build_index(&c, p, false).await.unwrap();
    assert_eq!(first.generation, second.generation);
    assert!(second.no_op);
    assert_eq!(second.cache_misses, 0);
    std::fs::create_dir_all(c.data_dir.join("indexes/.interrupted")).unwrap();
    assert_eq!(
        RagEngine::open(&c, Arc::new(CountingProvider(AtomicUsize::new(0))))
            .unwrap()
            .corpus_info()
            .index_version,
        Some(first.generation)
    );
}
#[cfg(feature = "test-support")]
#[tokio::test]
async fn http_reorders_indices_and_rejects_nonretryable_and_zero() {
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{header, method, path},
    };
    let server = MockServer::start().await;
    Mock::given(method("POST")).and(path("/v1/embeddings")).and(header("authorization", "Bearer test-key")).respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"model":"reported","data":[{"index":1,"embedding":[0.0,2.0]},{"index":0,"embedding":[3.0,0.0]}]}))).expect(1).mount(&server).await;
    let config = EmbeddingConfig {
        dimensions: Some(2),
        ..Default::default()
    };
    let p =
        AitunnelEmbeddingProvider::for_test(&config, format!("{}/v1", server.uri()), "test-key")
            .unwrap();
    let batch = p.embed(&["a".into(), "b".into()]).await.unwrap();
    assert_eq!(batch.vectors, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
    server.reset().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(401))
        .expect(1)
        .mount(&server)
        .await;
    assert!(p.embed(&["a".into()]).await.is_err());
    server.reset().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"model":"reported","data":[{"index":0,"embedding":[0.0,0.0]}]}),
        ))
        .expect(1)
        .mount(&server)
        .await;
    assert!(p.embed(&["a".into()]).await.is_err());
}
#[cfg(feature = "test-support")]
#[tokio::test]
async fn http_retries_only_retryable_failures() {
    use wiremock::{Mock, MockServer, ResponseTemplate, matchers::method};
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .expect(2)
        .mount(&server)
        .await;
    let p = AitunnelEmbeddingProvider::for_test(
        &EmbeddingConfig {
            max_retries: 1,
            timeout_secs: 3,
            ..Default::default()
        },
        server.uri(),
        "test-key",
    )
    .unwrap();
    assert!(p.embed(&["a".into()]).await.is_err());
}
#[tokio::test]
async fn duplicate_embedding_inputs_share_one_provider_call() {
    let temp = tempfile::tempdir().unwrap();
    let c = config(&temp);
    let p = CountingProvider(AtomicUsize::new(0));
    let inputs = vec!["same input".into(), "same input".into()];
    let (batch, hits, misses) = cached_embeddings(&c, &p, &inputs).await.unwrap();
    assert_eq!(hits, 1);
    assert_eq!(misses, 1);
    assert_eq!(p.0.load(Ordering::SeqCst), 1);
    assert_eq!(batch.vectors[0], batch.vectors[1]);
}

#[tokio::test]
async fn mdx_resolves_imported_jsdoc_before_or_without_api_reingestion() {
    let temp = tempfile::tempdir().unwrap();
    let mut c = config(&temp);
    c.sources_manifest = temp.path().join("sources.toml");
    std::fs::create_dir(temp.path().join("docs")).unwrap();
    std::fs::create_dir(temp.path().join("api")).unwrap();
    std::fs::write(
        temp.path().join("docs/guide.mdx"),
        "# Guide\n<JsDoc name=\"slow\" />\n<JsDoc name=\"Pattern.slow\" />\n<JsDoc name=\"missing\" />\n",
    )
    .unwrap();
    std::fs::write(
        temp.path().join("api/pattern.mjs"),
        "/** Slow down a pattern.\n * @memberof Pattern\n * @name slow\n * @param {number} factor time\n */\nconst implementation = 'not documentation';\n",
    )
    .unwrap();
    // Deliberately list MDX first: fresh imports must not depend on manifest order.
    std::fs::write(
        &c.sources_manifest,
        r#"
[[sources]]
source_id = "docs"
type = "local_directory"
extractor = "strudel_mdx"
root = "docs"
fixture = true

[[sources]]
source_id = "api"
type = "local_directory"
extractor = "strudel_jsdoc"
root = "api"
revision = "api-revision"
base_url = "https://example.org/{path}"
fixture = true
[sources.license]
name = "MIT"
"#,
    )
    .unwrap();
    for selected in [vec![], vec!["docs".to_owned()]] {
        let report = ingest(&c, &selected).await.unwrap();
        let docs_report = report
            .sources
            .iter()
            .find(|s| s.source_id == "docs")
            .unwrap();
        assert_eq!(
            docs_report.coverage_gaps,
            ["unresolved JsDoc reference missing: guide.mdx"]
        );
        let sources = load_sources(&c).unwrap();
        let docs = sources.iter().find(|s| s.source_id == "docs").unwrap();
        let guide = docs
            .documents
            .iter()
            .find(|d| d.parent_document_id.is_none())
            .unwrap();
        assert_eq!(guide.content.matches("Slow down a pattern.").count(), 2);
        assert!(!guide.content.contains("not documentation"));
        assert_eq!(guide.source.source_path.as_deref(), Some("guide.mdx"));
        let api_notice = guide
            .source
            .notices
            .iter()
            .find(|notice| notice.starts_with("API source for Pattern.slow:"))
            .unwrap();
        assert!(api_notice.contains("https://example.org/pattern.mjs#L1"));
        assert!(api_notice.contains("revision: api-revision"));
        assert!(api_notice.contains("license: MIT"));
    }
}
