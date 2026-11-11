use super::*;
use crate::RemoteClient;
use async_trait::async_trait;
use strudel_rag_core::{self as core, EmbeddingBatch, EmbeddingIdentity, EmbeddingProvider};
use tokio::sync::oneshot;
use tonic::{Code, transport::Channel};

const PAGE: &str = "# Fixture slow API\n\nThis is an authored test fixture, not official Strudel documentation.\n\nslow stretches a pattern over more cycles. The factor controls pattern speed.\n\n```js\ns(\"bd sd\").slow(2)\n```\n\n## Context\n\nA factor of two takes twice as many cycles.\n";
const EXAMPLE: &str = "# Fixture example\n\n```js\ns(\"bd sd\").slow(2)\n```\n";

struct Fixture {
    _directory: tempfile::TempDir,
    config: Config,
    page_id: String,
    example_id: String,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let mut config = Config {
            data_dir: directory.path().join("data"),
            allow_fixture: true,
            ..Default::default()
        };
        config.embedding.provider = "mock".into();
        config.embedding.model = "deterministic-sha256-64".into();
        config.server.bind = "127.0.0.1:0".parse().unwrap();
        config.client.bearer_token_env = "STRUDEL_RAG_TEST_UNUSED_TOKEN_ENV".into();
        config.retrieval.min_cosine = -1.0;
        let page_id = core::document_id("transport-fixture", "slow.md", "");
        let example_id = core::document_id("transport-fixture", "slow.md", "example:fixture");
        let source = core::SourceRef {
            source_id: "transport-fixture".into(),
            source_path: Some("slow.md".into()),
            source_revision: Some("fixture-revision-1".into()),
            notices: vec!["Authored test fixture, not official documentation".into()],
            ..Default::default()
        };
        let page = core::Document {
            document_id: page_id.clone(),
            kind: core::DocumentKind::Api,
            title: "Fixture slow API".into(),
            heading_path: vec![],
            source: source.clone(),
            language: Some("en".into()),
            content: PAGE.into(),
            code_blocks: vec![core::CodeBlock {
                language: Some("js".into()),
                code: "s(\"bd sd\").slow(2)\n".into(),
            }],
            tags: vec!["fixture".into()],
            parent_document_id: None,
            content_hash: core::content_hash(PAGE),
            verification_status: core::VerificationStatus::SourceOnly,
            verification_evidence: None,
            example_metadata: None,
        };
        let example = core::Document {
            document_id: example_id.clone(),
            kind: core::DocumentKind::Example,
            title: "Fixture example".into(),
            heading_path: vec![],
            source,
            language: Some("en".into()),
            content: EXAMPLE.into(),
            code_blocks: page.code_blocks.clone(),
            tags: vec!["fixture".into()],
            parent_document_id: Some(page_id.clone()),
            content_hash: core::content_hash(EXAMPLE),
            verification_status: core::VerificationStatus::SourceOnly,
            verification_evidence: None,
            example_metadata: None,
        };
        {
            let _lock = core::WriterLock::acquire(&config.data_dir).unwrap();
            core::publish_source(
                &config,
                &core::SourceSnapshot {
                    source_id: "transport-fixture".into(),
                    revision: Some("fixture-revision-1".into()),
                    documents: vec![page, example],
                    fixture: true,
                    ..Default::default()
                },
            )
            .unwrap();
        }
        core::build_index(&config, Arc::new(core::DeterministicMockProvider), false)
            .await
            .unwrap();
        Self {
            _directory: directory,
            config,
            page_id,
            example_id,
        }
    }
    fn engine(&self, provider: Arc<dyn EmbeddingProvider>) -> Arc<RagEngine> {
        Arc::new(RagEngine::open(&self.config, provider).unwrap())
    }
}
struct RunningServer {
    endpoint: String,
    channel: Channel,
    shutdown: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<Result<()>>,
}
impl RunningServer {
    async fn start(config: &Config, engine: Option<Arc<RagEngine>>, bearer: Option<&str>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let (shutdown, stopped) = oneshot::channel();
        let config = config.clone();
        let bearer = bearer.map(str::to_owned);
        let task = tokio::spawn(async move {
            serve_with_bearer(&config, engine, listener, bearer, async {
                let _ = stopped.await;
            })
            .await
        });
        let channel = tonic::transport::Endpoint::from_shared(endpoint.clone())
            .unwrap()
            .connect()
            .await
            .unwrap();
        Self {
            endpoint,
            channel,
            shutdown,
            task,
        }
    }
    async fn stop(self) {
        self.shutdown.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(3), self.task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
    fn rag(&self) -> pb::strudel_rag_client::StrudelRagClient<Channel> {
        pb::strudel_rag_client::StrudelRagClient::new(self.channel.clone())
    }
}
fn search() -> pb::SearchRequest {
    pb::SearchRequest {
        query: "slow pattern cycles".into(),
        intent: pb::SearchIntent::Api as i32,
        top_k: Some(3),
        filters: None,
    }
}
fn authorized<T>(value: T, token: Option<&str>) -> Request<T> {
    let mut request = Request::new(value);
    if let Some(token) = token {
        request
            .metadata_mut()
            .insert("authorization", format!("Bearer {token}").parse().unwrap());
    }
    request
}

#[tokio::test]
async fn real_search_get_parent_info_and_remote_domain_client() {
    let fixture = Fixture::new().await;
    let engine = fixture.engine(Arc::new(core::DeterministicMockProvider));
    let expected = engine
        .search(core::SearchRequest::try_from(search()).unwrap())
        .await
        .unwrap();
    let server = RunningServer::start(&fixture.config, Some(engine), None).await;
    let mut client = server.rag();
    let response = client.search(search()).await.unwrap().into_inner();
    let first = response.results.first().unwrap();
    let record = first.record.as_ref().unwrap();
    assert_eq!(record.document_id, fixture.page_id);
    assert_eq!(
        record.verification_status,
        pb::VerificationStatus::SourceOnly as i32
    );
    assert!(first.lexical_rank.is_some());
    assert!(first.vector_rank.is_some());
    assert!(first.fusion_score > 0.0);
    let chunk_id = record.chunk_id.clone().unwrap();
    let chunk = client
        .get_document(pb::GetDocumentRequest {
            reference: Some(pb::get_document_request::Reference::ChunkId(
                chunk_id.clone(),
            )),
            parent_context: false,
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(chunk.record.as_ref().unwrap().content, record.content);
    for reference in [
        pb::get_document_request::Reference::ChunkId(chunk_id),
        pb::get_document_request::Reference::DocumentId(fixture.page_id.clone()),
        pb::get_document_request::Reference::DocumentId(fixture.example_id.clone()),
    ] {
        let parent = client
            .get_document(pb::GetDocumentRequest {
                reference: Some(reference),
                parent_context: true,
            })
            .await
            .unwrap()
            .into_inner();
        let parent = parent.record.unwrap();
        assert_eq!(parent.content, PAGE);
        assert_eq!(parent.document_id, fixture.page_id);
        assert!(parent.chunk_id.is_none());
    }
    let own = client
        .get_document(pb::GetDocumentRequest {
            reference: Some(pb::get_document_request::Reference::DocumentId(
                fixture.example_id.clone(),
            )),
            parent_context: false,
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(own.record.unwrap().content, EXAMPLE);
    let info = client
        .get_corpus_info(pb::GetCorpusInfoRequest {})
        .await
        .unwrap()
        .into_inner();
    assert!(info.ready && info.fixture);
    assert_eq!(info.documents, 2);
    assert!(info.chunks >= 2);
    assert_eq!(info.model.as_deref(), Some("deterministic-sha256-64"));
    assert_eq!(info.dimension, Some(64));
    assert_eq!(
        info.sources[0].revision.as_deref(),
        Some("fixture-revision-1")
    );
    let config = core::ClientConfig {
        endpoint: server.endpoint.clone(),
        bearer_token_env: fixture.config.client.bearer_token_env.clone(),
        ..Default::default()
    };
    let mut remote = RemoteClient::connect(&config).await.unwrap();
    assert!(remote.health().await.unwrap());
    let actual = remote
        .search(core::SearchRequest::try_from(search()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
    assert_eq!(
        remote
            .get_document(
                core::DocumentReference::DocumentId(fixture.page_id.clone()),
                true
            )
            .await
            .unwrap()
            .record
            .content,
        PAGE
    );
    assert!(remote.corpus_info().await.unwrap().ready);
    server.stop().await;
}

#[tokio::test]
async fn bearer_auth_covers_rag_health_and_both_reflection_versions() {
    let fixture = Fixture::new().await;
    let server = RunningServer::start(
        &fixture.config,
        Some(fixture.engine(Arc::new(core::DeterministicMockProvider))),
        Some("test-token-not-a-real-secret"),
    )
    .await;
    for token in [None, Some("wrong"), Some("test-token-not-a-real-secret")] {
        let allowed = token == Some("test-token-not-a-real-secret");
        let result = server
            .rag()
            .get_corpus_info(authorized(pb::GetCorpusInfoRequest {}, token))
            .await;
        if allowed {
            assert!(result.unwrap().into_inner().ready);
        } else {
            assert_eq!(result.unwrap_err().code(), Code::Unauthenticated);
        }
        let result = server.rag().search(authorized(search(), token)).await;
        if allowed {
            assert!(!result.unwrap().into_inner().results.is_empty());
        } else {
            assert_eq!(result.unwrap_err().code(), Code::Unauthenticated);
        }
        let result = server
            .rag()
            .get_document(authorized(
                pb::GetDocumentRequest {
                    reference: Some(pb::get_document_request::Reference::DocumentId(
                        fixture.page_id.clone(),
                    )),
                    parent_context: false,
                },
                token,
            ))
            .await;
        if allowed {
            assert_eq!(result.unwrap().into_inner().record.unwrap().content, PAGE);
        } else {
            assert_eq!(result.unwrap_err().code(), Code::Unauthenticated);
        }
        let mut health = tonic_health::pb::health_client::HealthClient::new(server.channel.clone());
        let result = health
            .check(authorized(
                tonic_health::pb::HealthCheckRequest {
                    service: "strudel.rag.v1.StrudelRag".into(),
                },
                token,
            ))
            .await;
        if allowed {
            assert_eq!(result.unwrap().into_inner().status, 1);
        } else {
            assert_eq!(result.unwrap_err().code(), Code::Unauthenticated);
        }
        let mut reflection =
            tonic_reflection::pb::v1::server_reflection_client::ServerReflectionClient::new(
                server.channel.clone(),
            );
        let result = reflection.server_reflection_info(authorized(tokio_stream::iter([tonic_reflection::pb::v1::ServerReflectionRequest { host:String::new(),message_request:Some(tonic_reflection::pb::v1::server_reflection_request::MessageRequest::ListServices(String::new())) }]),token)).await;
        if allowed {
            let response = result
                .unwrap()
                .into_inner()
                .message()
                .await
                .unwrap()
                .unwrap();
            let Some(tonic_reflection::pb::v1::server_reflection_response::MessageResponse::ListServicesResponse(services)) = response.message_response else { panic!("missing reflection services"); };
            assert!(
                services
                    .service
                    .iter()
                    .any(|s| s.name == "strudel.rag.v1.StrudelRag")
            );
        } else {
            assert_eq!(result.unwrap_err().code(), Code::Unauthenticated);
        }
        let mut reflection =
            tonic_reflection::pb::v1alpha::server_reflection_client::ServerReflectionClient::new(
                server.channel.clone(),
            );
        let result = reflection.server_reflection_info(authorized(tokio_stream::iter([tonic_reflection::pb::v1alpha::ServerReflectionRequest { host:String::new(),message_request:Some(tonic_reflection::pb::v1alpha::server_reflection_request::MessageRequest::FileContainingSymbol("strudel.rag.v1.StrudelRag".into())) }]),token)).await;
        if allowed {
            let response = result
                .unwrap()
                .into_inner()
                .message()
                .await
                .unwrap()
                .unwrap();
            let Some(tonic_reflection::pb::v1alpha::server_reflection_response::MessageResponse::FileDescriptorResponse(files)) = response.message_response else { panic!("missing reflection descriptor"); };
            assert!(!files.file_descriptor_proto.is_empty());
        } else {
            assert_eq!(result.unwrap_err().code(), Code::Unauthenticated);
        }
    }
    server.stop().await;
}

#[tokio::test]
async fn invalid_requests_not_found_and_transport_size_limits() {
    let fixture = Fixture::new().await;
    let engine = fixture.engine(Arc::new(core::DeterministicMockProvider));
    let server = RunningServer::start(&fixture.config, Some(engine.clone()), None).await;
    let mut client = server.rag();
    for request in [
        pb::SearchRequest {
            top_k: Some(0),
            ..search()
        },
        pb::SearchRequest {
            top_k: Some(51),
            ..search()
        },
        pb::SearchRequest {
            query: " \t\n".into(),
            ..search()
        },
        pb::SearchRequest {
            query: "é".repeat(2049),
            ..search()
        },
        pb::SearchRequest {
            intent: 99,
            ..search()
        },
        pb::SearchRequest {
            filters: Some(pb::SearchFilters {
                kinds: vec![0],
                ..Default::default()
            }),
            ..search()
        },
    ] {
        assert_eq!(
            client.search(request).await.unwrap_err().code(),
            Code::InvalidArgument
        );
    }
    assert_eq!(
        client
            .get_document(pb::GetDocumentRequest::default())
            .await
            .unwrap_err()
            .code(),
        Code::InvalidArgument
    );
    for reference in [
        pb::get_document_request::Reference::DocumentId("doc_missing".into()),
        pb::get_document_request::Reference::ChunkId("chk_missing".into()),
    ] {
        assert_eq!(
            client
                .get_document(pb::GetDocumentRequest {
                    reference: Some(reference),
                    parent_context: false
                })
                .await
                .unwrap_err()
                .code(),
            Code::NotFound
        );
    }
    let oversized = pb::SearchRequest {
        filters: Some(pb::SearchFilters {
            tags: vec!["x".repeat(70_000)],
            ..Default::default()
        }),
        ..search()
    };
    assert_eq!(
        client.search(oversized).await.unwrap_err().code(),
        Code::ResourceExhausted
    );
    server.stop().await;
    let mut limited = fixture.config.clone();
    limited.server.max_response_bytes = 64;
    let server = RunningServer::start(&limited, Some(engine), None).await;
    assert_eq!(
        server
            .rag()
            .get_corpus_info(pb::GetCorpusInfoRequest {})
            .await
            .unwrap_err()
            .code(),
        Code::ResourceExhausted
    );
    server.stop().await;
}

#[tokio::test]
async fn missing_index_is_not_ready_but_health_info_and_reflection_exist() {
    let config = Config::default();
    let server = RunningServer::start(&config, None, None).await;
    let info = server
        .rag()
        .get_corpus_info(pb::GetCorpusInfoRequest {})
        .await
        .unwrap()
        .into_inner();
    assert!(!info.ready);
    assert!(info.readiness_reason.is_some());
    assert_eq!(
        server.rag().search(search()).await.unwrap_err().code(),
        Code::FailedPrecondition
    );
    assert_eq!(
        server
            .rag()
            .get_document(pb::GetDocumentRequest {
                reference: Some(pb::get_document_request::Reference::DocumentId(
                    "doc_missing".into()
                )),
                parent_context: false
            })
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );
    let mut health = tonic_health::pb::health_client::HealthClient::new(server.channel.clone());
    assert_eq!(
        health
            .check(tonic_health::pb::HealthCheckRequest {
                service: "strudel.rag.v1.StrudelRag".into()
            })
            .await
            .unwrap()
            .into_inner()
            .status,
        2
    );
    server.stop().await;
}

struct QueryProvider {
    delay: Duration,
    mismatch: bool,
    started: Option<Arc<tokio::sync::Notify>>,
}
#[async_trait]
impl EmbeddingProvider for QueryProvider {
    fn identity(&self) -> EmbeddingIdentity {
        core::DeterministicMockProvider.identity()
    }
    async fn embed(&self, inputs: &[String]) -> core::Result<EmbeddingBatch> {
        if let Some(started) = &self.started {
            started.notify_one();
        }
        tokio::time::sleep(self.delay).await;
        let mut batch = core::DeterministicMockProvider.embed(inputs).await?;
        if self.mismatch {
            batch.model = "different-reported-model".into();
        }
        Ok(batch)
    }
}

#[tokio::test]
async fn query_model_mismatch_fails_precondition_without_fallback() {
    let fixture = Fixture::new().await;
    let engine = fixture.engine(Arc::new(QueryProvider {
        delay: Duration::ZERO,
        mismatch: true,
        started: None,
    }));
    assert!(engine.corpus_info().ready); // no live embedding call at startup
    let server = RunningServer::start(&fixture.config, Some(engine), None).await;
    assert_eq!(
        server.rag().search(search()).await.unwrap_err().code(),
        Code::FailedPrecondition
    );
    server.stop().await;
}

#[tokio::test]
async fn short_request_deadline_and_concurrency_limit_are_enforced() {
    let fixture = Fixture::new().await;
    let started = Arc::new(tokio::sync::Notify::new());
    let provider = Arc::new(QueryProvider {
        delay: Duration::from_millis(250),
        mismatch: false,
        started: Some(started.clone()),
    });
    let engine = fixture.engine(provider);
    let mut config = fixture.config.clone();
    config.server.max_concurrent_searches = 1;
    let server = RunningServer::start(&config, Some(engine), None).await;
    let mut first_client = server.rag();
    let first = tokio::spawn(async move { first_client.search(search()).await });
    tokio::time::timeout(Duration::from_secs(2), started.notified())
        .await
        .unwrap();
    assert_eq!(
        server.rag().search(search()).await.unwrap_err().code(),
        Code::ResourceExhausted
    );
    first.await.unwrap().unwrap();
    let mut short = Request::new(search());
    short.set_timeout(Duration::from_millis(20));
    let now = tokio::time::Instant::now();
    let error = server.rag().search(short).await.unwrap_err();
    assert!(matches!(
        error.code(),
        Code::DeadlineExceeded | Code::Cancelled
    ));
    assert!(now.elapsed() < Duration::from_millis(200));
    server.stop().await;
}

#[test]
fn nonloopback_requires_bearer_and_fixtures_are_loopback_only() {
    let mut config = Config::default();
    config.server.bind = "0.0.0.0:50051".parse().unwrap();
    assert!(validate_server(&config, None, false).is_err());
    assert!(validate_server(&config, None, true).is_ok());
    config.embedding.provider = "mock".into();
    config.allow_fixture = true;
    assert!(validate_server(&config, None, true).is_err());
}
