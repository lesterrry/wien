use super::{tests::*, *};
use crate::{
    api,
    assistant::tools::Tools,
    rag::{RagClient, pb},
};
use axum::{
    body::{Body, to_bytes},
    http::Request as HttpRequest,
};
use std::sync::{Arc, Mutex};
use tonic::{Request, Response, Status};
use tower::ServiceExt;
use wiremock::{Mock, MockServer, matchers::method};

#[derive(Clone)]
struct Corpus {
    calls: Arc<Mutex<Vec<&'static str>>>,
    ready: bool,
    reject_auth: bool,
}
impl Corpus {
    fn authorize<T>(&self, request: &Request<T>) -> Result<(), Status> {
        if self.reject_auth
            || request
                .metadata()
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                != Some("Bearer test-rag-token")
        {
            return Err(Status::unauthenticated("test-only-secret-must-not-leak"));
        }
        Ok(())
    }
}
#[tonic::async_trait]
impl pb::strudel_rag_server::StrudelRag for Corpus {
    async fn get_corpus_info(
        &self,
        request: Request<pb::GetCorpusInfoRequest>,
    ) -> Result<Response<pb::GetCorpusInfoResponse>, Status> {
        self.authorize(&request)?;
        self.calls.lock().unwrap().push("info");
        Ok(Response::new(pb::GetCorpusInfoResponse {
            ready: self.ready,
            fixture: true,
            ..Default::default()
        }))
    }
    async fn search(
        &self,
        request: Request<pb::SearchRequest>,
    ) -> Result<Response<pb::SearchResponse>, Status> {
        self.authorize(&request)?;
        let query = request.into_inner();
        assert_eq!(query.query, "slow cycles");
        assert_eq!(query.intent, 1);
        assert_eq!(query.filters.unwrap().kinds, vec![1]);
        self.calls.lock().unwrap().push("search");
        Ok(Response::new(pb::SearchResponse {
            results: vec![pb::SearchHit {
                record: Some(record("chunk evidence")),
                ..Default::default()
            }],
            diagnostics: Some(pb::SearchDiagnostics {
                fixture: true,
                ..Default::default()
            }),
        }))
    }
    async fn get_document(
        &self,
        request: Request<pb::GetDocumentRequest>,
    ) -> Result<Response<pb::GetDocumentResponse>, Status> {
        self.authorize(&request)?;
        let query = request.into_inner();
        assert!(query.parent_context);
        assert_eq!(
            query.reference,
            Some(pb::get_document_request::Reference::ChunkId(
                "chunk-1".into()
            ))
        );
        self.calls.lock().unwrap().push("document");
        Ok(Response::new(pb::GetDocumentResponse {
            record: Some(record("complete parent evidence")),
            index_version: "test-index".into(),
        }))
    }
}
fn record(content: &str) -> pb::Record {
    pb::Record {
        document_id: "doc-1".into(),
        chunk_id: Some("chunk-1".into()),
        kind: 1,
        verification_status: 1,
        content: content.into(),
        source: Some(pb::SourceRef {
            source_url: Some("https://example.test/slow".into()),
            source_revision: Some("test-revision".into()),
            ..Default::default()
        }),
        ..Default::default()
    }
}
async fn rag_service(
    ready: bool,
    reject_auth: bool,
) -> (
    Tools,
    Arc<Mutex<Vec<&'static str>>>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let calls = Arc::new(Mutex::new(vec![]));
    let service = Corpus {
        calls: calls.clone(),
        ready,
        reject_auth,
    };
    let task = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(pb::strudel_rag_server::StrudelRagServer::new(service))
            .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener))
            .await
            .unwrap();
    });
    let client = RagClient::new(
        &format!("http://{address}"),
        Some("test-rag-token"),
        Duration::from_secs(2),
    )
    .unwrap();
    (Tools(client), calls, task)
}
fn assist_request() -> HttpRequest<Body> {
    HttpRequest::post("/v1/assist").header("host", "127.0.0.1:3001").header("content-type", "application/json")
        .body(Body::from(json!({"prompt":"Объясни slow для techno", "file":{"path":"beat.strudel", "content":"s('bd').slow(2)", "cursor":{"anchor":0,"head":0}}}).to_string())).unwrap()
}
fn event(output: Value) -> Value {
    json!({"type":"response.completed","response":{"id":"test-response", "model":"test-model", "status":"completed", "output":output}})
}
fn tool_step(index: usize, name: &str, args: Value) -> Value {
    event(json!([
        {"type":"reasoning", "id":format!("reason-{index}"), "summary":[], "encrypted_content":format!("encrypted-{index}")},
        {"type":"function_call", "id":format!("fc-{index}"), "call_id":format!("call-{index}"), "name":name,"arguments":args.to_string(),"status":"completed"}
    ]))
}

#[tokio::test]
async fn assist_runs_codex_tool_loop_over_real_grpc_and_preserves_evidence_and_reasoning() {
    let upstream = MockServer::start().await;
    let (_dir, provider) = fixture(&upstream, TIMEOUT).await;
    let (tools, calls, task) = rag_service(true, false).await;
    Mock::given(method("POST")).respond_with(|request: &wiremock::Request| {
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["store"], false);
        assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
        assert_eq!(body["tools"].as_array().unwrap().len(), 4);
        let prompt = body["instructions"].as_str().unwrap();
        assert!(prompt.contains("Wien music composition skill"));
        assert!(prompt.contains("harness adapter"));
        let input = body["input"].as_array().unwrap();
        let context: Value = serde_json::from_str(input[0]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(context["rag_corpus"]["fixture"], true);
        let outputs: Vec<Value> = input.iter().filter(|item| item["type"] == "function_call_output")
            .map(|item| serde_json::from_str(item["output"].as_str().unwrap()).unwrap()).collect();
        for index in 0..outputs.len() {
            assert!(input.iter().any(|item| item["encrypted_content"] == format!("encrypted-{index}")));
        }
        let response = match outputs.len() {
            0 => tool_step(0, "get_genre_guide", json!({"genre":"techno"})),
            1 => {
                assert!(outputs[0]["content"].as_str().unwrap().contains("Techno"));
                tool_step(1, "strudel_rag_search", json!({"query":"slow cycles","intent":"api","top_k":3,"filters":{"kinds":["api"]}}))
            }
            2 => {
                assert_eq!(outputs[1]["results"][0]["record"]["verification_status"], "source_only");
                tool_step(2, "strudel_rag_get_document", json!({"chunk_id":"chunk-1","parent_context":true}))
            }
            3 => {
                assert_eq!(outputs[2]["record"]["content"], "complete parent evidence");
                assert_eq!(outputs[2]["record"]["source"]["source_revision"], "test-revision");
                event(json!([{"type":"message","content":[{"type":"output_text","text":json!({"message":"Ответ по test-revision", "code":null}).to_string()}]}]))
            }
            _ => panic!("unexpected inference step"),
        };
        sse(&[response])
    }).expect(4).mount(&upstream).await;
    let response = api::router(Arc::new(provider), Default::default(), Arc::new(tools))
        .oneshot(assist_request())
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(
        body,
        json!({"message":"Ответ по test-revision", "code":null})
    );
    assert_eq!(*calls.lock().unwrap(), vec!["info", "search", "document"]);
    task.abort();
}

#[tokio::test]
async fn unavailable_corpus_or_rejected_auth_stops_before_model_and_hides_remote_errors() {
    for (ready, rejected, expected) in [
        (false, false, "rag_not_ready"),
        (true, true, "rag_unauthorized"),
    ] {
        let upstream = MockServer::start().await;
        let (_dir, provider) = fixture(&upstream, TIMEOUT).await;
        let (tools, _, task) = rag_service(ready, rejected).await;
        let response = api::router(Arc::new(provider), Default::default(), Arc::new(tools))
            .oneshot(assist_request())
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        );
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], expected);
        assert!(!String::from_utf8_lossy(&bytes).contains("test-only-secret"));
        assert!(upstream.received_requests().await.unwrap().is_empty());
        task.abort();
    }
}
