use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use async_trait::async_trait;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tower::ServiceExt;
use wien_server::{
    api,
    assistant::tools::{AssistantTools, ToolError},
    providers::{
        ModelOptions, ModelResponse, Provider, ProviderError,
        turn::{TurnRequest, TurnResponse},
    },
};

struct BlockingProvider(mpsc::UnboundedSender<oneshot::Sender<()>>);
#[async_trait]
impl Provider for BlockingProvider {
    async fn send(&self, _: &str, _: &ModelOptions) -> Result<ModelResponse, ProviderError> {
        unreachable!()
    }
    async fn turn(&self, request: &TurnRequest) -> Result<TurnResponse, ProviderError> {
        let (release, wait) = oneshot::channel();
        self.0.send(release).unwrap();
        wait.await.unwrap();
        let context: Value =
            serde_json::from_str(request.input[0]["content"][0]["text"].as_str().unwrap()).unwrap();
        if context["prompt"] == "fail" {
            return Err(ProviderError::RateLimited);
        }
        Ok(TurnResponse {
            response: ModelResponse {
                id: "test".into(),
                model: "test".into(),
                text: json!({"message":"ok", "code":null}).to_string(),
                usage: None,
            },
            output: vec![],
            calls: vec![],
        })
    }
}
struct CountingTools(AtomicUsize);
#[async_trait]
impl AssistantTools for CountingTools {
    async fn call(&self, _: &str, _: Value) -> Result<Value, ToolError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"ready":true}))
    }
}
fn request(prompt: &str) -> Request<Body> {
    Request::post("/v1/assist").header("host", "127.0.0.1:3001").header("content-type", "application/json")
        .body(Body::from(json!({"prompt":prompt,"file":{"path":"test.strudel","content":"", "cursor":{"anchor":0,"head":0}}}).to_string())).unwrap()
}

#[tokio::test]
async fn limits_work_before_rag_and_releases_slots_on_success_error_and_cancellation() {
    // A deadline makes a broken admission/release fail instead of hanging the suite.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let (started, mut starts) = mpsc::unbounded_channel();
        let tools = Arc::new(CountingTools(AtomicUsize::new(0)));
        let app = api::router(
            Arc::new(BlockingProvider(started)),
            Default::default(),
            tools.clone(),
        );
        let mut jobs = vec![];
        let mut releases = vec![];
        for prompt in ["fail", "ok", "ok", "ok"] {
            jobs.push(tokio::spawn(app.clone().oneshot(request(prompt))));
            releases.push(starts.recv().await.unwrap());
        }
        let busy = app.clone().oneshot(request("fifth")).await.unwrap();
        assert_eq!(busy.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(busy.headers()["retry-after"], "2");
        let body: Value =
            serde_json::from_slice(&to_bytes(busy.into_body(), 1024).await.unwrap()).unwrap();
        assert_eq!(body["code"], "assistant_busy");
        assert_eq!(tools.0.load(Ordering::SeqCst), 4);
        assert_eq!(
            app.clone().oneshot(request(" ")).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            app.clone()
                .oneshot(Request::get("/health").body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );

        // Upstream errors release capacity and do not advertise safe retries.
        releases.remove(0).send(()).unwrap();
        let failed = jobs.remove(0).await.unwrap().unwrap();
        assert_eq!(failed.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(failed.headers().get("retry-after").is_none());
        let replacement = tokio::spawn(app.clone().oneshot(request("replacement")));
        starts.recv().await.unwrap().send(()).unwrap();
        assert_eq!(replacement.await.unwrap().unwrap().status(), StatusCode::OK);

        // A dropped handler also releases capacity; it doesn't leave detached work.
        let cancelled = jobs.remove(0);
        cancelled.abort();
        assert!(cancelled.await.unwrap_err().is_cancelled());
        releases.remove(0);
        let a = tokio::spawn(app.clone().oneshot(request("after success")));
        let release_a = starts.recv().await.unwrap();
        let b = tokio::spawn(app.clone().oneshot(request("after cancellation")));
        let release_b = starts.recv().await.unwrap();
        release_a.send(()).unwrap();
        release_b.send(()).unwrap();
        assert_eq!(a.await.unwrap().unwrap().status(), StatusCode::OK);
        assert_eq!(b.await.unwrap().unwrap().status(), StatusCode::OK);
        for release in releases {
            release.send(()).unwrap();
        }
        for job in jobs {
            assert_eq!(job.await.unwrap().unwrap().status(), StatusCode::OK);
        }
    })
    .await
    .unwrap();
}
