use super::*;
use tempfile::TempDir;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_partial_json, header, method, path},
};

const FAKE_TOKEN: &str = "test-only-not-a-real-token";

fn options() -> ModelOptions {
    ModelOptions {
        model: "test-model".into(),
        reasoning_effort: Some(super::super::ReasoningEffort::Low),
        instructions: Some("test instructions".into()),
    }
}

async fn fixture(server: &MockServer, timeout: Duration) -> (TempDir, Codex) {
    let dir = tempfile::tempdir().unwrap();
    let auth_file = dir.path().join("auth.json");
    write_auth(&auth_file, FAKE_TOKEN).await;
    let provider = Codex::new(auth_file, format!("{}/responses", server.uri()), timeout).unwrap();
    (dir, provider)
}

async fn write_auth(path: &std::path::Path, token: &str) {
    tokio::fs::write(
        path,
        json!({"auth_mode":"chatgpt", "tokens":{"access_token":token,"account_id":"test-account"}})
            .to_string(),
    )
    .await
    .unwrap();
}

fn completed_event() -> Value {
    json!({"type":"response.completed","response":{
        "id":"test-response","model":"test-model","status":"completed",
        "output":[{"type":"reasoning"},{"type":"message","content":[{"type":"output_text","text":"Привет 🎶"}]}],
        "usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14}
    }})
}

fn sse(events: &[Value]) -> ResponseTemplate {
    let body = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    ResponseTemplate::new(200).set_body_raw(body, "text/event-stream; charset=utf-8")
}

#[tokio::test]
async fn sends_direct_request_and_returns_only_completed_text_and_usage() {
    let server = MockServer::start().await;
    let (_dir, provider) = fixture(&server, TIMEOUT).await;
    Mock::given(method("POST"))
        .and(path("/responses"))
        .and(header("authorization", format!("Bearer {FAKE_TOKEN}")))
        .and(header("chatgpt-account-id", "test-account"))
        .and(body_partial_json(json!({
            "model":"test-model", "instructions":"test instructions",
            "input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}],
            "store":false,"stream":true,"tools":[],"tool_choice":"none",
            "reasoning":{"effort":"low"}
        })))
        .respond_with(sse(&[
            json!({"type":"response.output_text.delta","delta":"Not the final text"}),
            completed_event(),
        ]))
        .expect(1)
        .mount(&server)
        .await;
    let response = provider.send("hello", &options()).await.unwrap();
    assert_eq!(response.text, "Привет 🎶");
    assert_eq!(response.model, "test-model");
    assert_eq!(response.usage.unwrap().total_tokens, 14);
}

#[tokio::test]
async fn accepts_codex_sse_without_content_type_header() {
    let server = MockServer::start().await;
    let (_dir, provider) = fixture(&server, TIMEOUT).await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(format!("data: {}\n\n", completed_event()), ""),
        )
        .mount(&server)
        .await;
    assert_eq!(
        provider.send("hello", &options()).await.unwrap().text,
        "Привет 🎶"
    );
}

#[tokio::test]
async fn reads_rotated_credentials_without_restart_and_never_writes_them() {
    let server = MockServer::start().await;
    let (_dir, provider) = fixture(&server, TIMEOUT).await;
    Mock::given(header("authorization", format!("Bearer {FAKE_TOKEN}")))
        .respond_with(sse(&[completed_event()]))
        .expect(1)
        .mount(&server)
        .await;
    provider.send("hello", &options()).await.unwrap();
    write_auth(&provider.auth_file, "test-rotated-token").await;
    let before = tokio::fs::read(&provider.auth_file).await.unwrap();
    Mock::given(header("authorization", "Bearer test-rotated-token"))
        .respond_with(sse(&[completed_event()]))
        .expect(1)
        .mount(&server)
        .await;
    provider.send("hello", &options()).await.unwrap();
    assert_eq!(tokio::fs::read(&provider.auth_file).await.unwrap(), before);
}

#[tokio::test]
async fn missing_or_invalid_login_never_contacts_upstream_or_exposes_contents() {
    let server = MockServer::start().await;
    let (_dir, provider) = fixture(&server, TIMEOUT).await;
    tokio::fs::remove_file(&provider.auth_file).await.unwrap();
    assert_eq!(
        provider.send("hello", &options()).await.unwrap_err(),
        ProviderError::AuthRequired
    );
    for value in [
        FAKE_TOKEN.to_string(),
        json!({"auth_mode":"apikey","tokens":{"access_token":FAKE_TOKEN,"account_id":"test"}})
            .to_string(),
        json!({"tokens":{"access_token":"test\r\ninjected: value","account_id":"test"}})
            .to_string(),
        json!({"tokens":{"access_token":"","account_id":"test"}}).to_string(),
    ] {
        tokio::fs::write(&provider.auth_file, value).await.unwrap();
        let error = provider.send("hello", &options()).await.unwrap_err();
        assert_eq!(error, ProviderError::AuthRequired);
        assert!(!format!("{error:?} {error}").contains(FAKE_TOKEN));
    }
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn maps_http_errors_without_exposing_upstream_body() {
    let server = MockServer::start().await;
    let (_dir, provider) = fixture(&server, TIMEOUT).await;
    for (status, expected) in [
        (401, ProviderError::AuthRequired),
        (403, ProviderError::AuthRequired),
        (429, ProviderError::RateLimited),
        (400, ProviderError::Rejected),
        (500, ProviderError::Unavailable),
    ] {
        server.reset().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(status).set_body_string(FAKE_TOKEN))
            .mount(&server)
            .await;
        let error = provider.send("hello", &options()).await.unwrap_err();
        assert_eq!(error, expected);
        assert!(!error.to_string().contains(FAKE_TOKEN));
    }
}

#[tokio::test]
async fn never_follows_redirects_with_credentials() {
    let server = MockServer::start().await;
    let destination = MockServer::start().await;
    let (_dir, provider) = fixture(&server, TIMEOUT).await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(307).insert_header("location", destination.uri()))
        .mount(&server)
        .await;
    assert_eq!(
        provider.send("hello", &options()).await.unwrap_err(),
        ProviderError::Unavailable
    );
    assert!(destination.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn fails_on_incomplete_failed_malformed_or_non_stream_responses() {
    let server = MockServer::start().await;
    let (_dir, provider) = fixture(&server, TIMEOUT).await;
    let cases = [
        (
            sse(&[json!({"type":"response.output_text.delta","delta":"partial"})]),
            ProviderError::Incomplete,
        ),
        (
            sse(&[json!({"type":"response.incomplete"})]),
            ProviderError::Incomplete,
        ),
        (
            sse(&[
                json!({"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","message":FAKE_TOKEN}}}),
            ]),
            ProviderError::RateLimited,
        ),
        (
            sse(&[json!({"type":"error","message":FAKE_TOKEN})]),
            ProviderError::Unavailable,
        ),
        (
            ResponseTemplate::new(200).set_body_raw("data: not-json\n\n", "text/event-stream"),
            ProviderError::InvalidResponse,
        ),
        (
            ResponseTemplate::new(200).set_body_string(FAKE_TOKEN),
            ProviderError::InvalidResponse,
        ),
    ];
    for (response, expected) in cases {
        server.reset().await;
        Mock::given(method("POST"))
            .respond_with(response)
            .mount(&server)
            .await;
        assert_eq!(
            provider.send("hello", &options()).await.unwrap_err(),
            expected
        );
    }
}

#[tokio::test]
async fn bounds_request_time_and_response_size() {
    let server = MockServer::start().await;
    let (_dir, provider) = fixture(&server, Duration::from_millis(40)).await;
    Mock::given(method("POST"))
        .respond_with(sse(&[completed_event()]).set_delay(Duration::from_millis(200)))
        .mount(&server)
        .await;
    assert_eq!(
        provider.send("hello", &options()).await.unwrap_err(),
        ProviderError::Timeout
    );

    server.reset().await;
    let (_dir, provider) = fixture(&server, TIMEOUT).await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            format!("data: {}", "x".repeat(MAX_RESPONSE_BYTES)),
            "text/event-stream",
        ))
        .mount(&server)
        .await;
    assert_eq!(
        provider.send("hello", &options()).await.unwrap_err(),
        ProviderError::ResponseTooLarge
    );
}

#[test]
fn accepts_refusals_but_rejects_tool_calls_or_missing_final_text() {
    let mut event = completed_event();
    event["response"]["output"] =
        json!([{"type":"message","content":[{"type":"refusal","refusal":"Cannot help."}]}]);
    assert_eq!(completed(&event["response"]).unwrap().text, "Cannot help.");
    event["response"]["output"] = json!([{"type":"function_call","name":"shell"}]);
    assert_eq!(
        completed(&event["response"]).unwrap_err(),
        ProviderError::InvalidResponse
    );
    event["response"]["output"] = json!([]);
    assert_eq!(
        completed(&event["response"]).unwrap_err(),
        ProviderError::InvalidResponse
    );
    event["response"]["status"] = json!("incomplete");
    assert_eq!(
        completed(&event["response"]).unwrap_err(),
        ProviderError::Incomplete
    );
}
