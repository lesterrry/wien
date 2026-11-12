use super::*;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_partial_json, header, method, path},
};

fn options() -> ModelOptions {
    ModelOptions {
        model: "test-model".into(),
        reasoning_effort: Some(super::super::ReasoningEffort::Low),
        instructions: Some("test instructions".into()),
    }
}

fn response(output: Value) -> Value {
    json!({"id":"test-response","model":"test-model","status":"completed","output":output,
        "usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14,"cost_rub":0.01}})
}

#[tokio::test]
async fn sends_bounded_stateless_request_and_preserves_tool_history() {
    let server = MockServer::start().await;
    let provider =
        Aitunnel::new("test-key", format!("{}/responses", server.uri()), TIMEOUT).unwrap();
    let output = json!([
        {"type":"reasoning","id":"reasoning-1","encrypted_content":"opaque-state"},
        {"type":"function_call","call_id":"call-1","name":"lookup","arguments":"{}"}
    ]);
    let tool = json!({"type":"function","name":"lookup","parameters":{"type":"object"}});
    Mock::given(method("POST"))
        .and(path("/responses"))
        .and(header("authorization", "Bearer test-key"))
        .and(body_partial_json(
            json!({"model":"test-model","store":false,"stream":false,
            "max_output_tokens":4096,"parallel_tool_calls":false,"reasoning":{"effort":"low"},
            "tools":[tool.clone()],"include":["reasoning.encrypted_content"]}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(response(output.clone())))
        .expect(1)
        .mount(&server)
        .await;
    let mut request = TurnRequest {
        input: vec![user_input("look up gain")],
        tools: vec![tool],
        options: options(),
    };
    let turn = provider.turn(&request).await.unwrap();
    assert_eq!(turn.output, output.as_array().unwrap().clone());
    assert_eq!(turn.calls[0].call_id, "call-1");
    assert_eq!(turn.response.usage.unwrap().total_tokens, 14);
    request.input.extend(turn.output);
    request
        .input
        .push(json!({"type":"function_call_output","call_id":"call-1","output":"documentation"}));
    server.reset().await;
    Mock::given(method("POST"))
        .and(body_partial_json(
            json!({"input": request.input, "tools":request.tools}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(response(json!([
            {"type":"message","content":[{"type":"output_text","text":"done"}]}
        ]))))
        .expect(1)
        .mount(&server)
        .await;
    assert_eq!(provider.turn(&request).await.unwrap().response.text, "done");
}

#[tokio::test]
async fn maps_errors_without_leaking_upstream_bodies_or_retrying() {
    let server = MockServer::start().await;
    let provider = Aitunnel::new("test-key", server.uri(), TIMEOUT).unwrap();
    for (status, expected) in [
        (401, ProviderError::AuthRequired),
        (403, ProviderError::AuthRequired),
        (402, ProviderError::RateLimited),
        (429, ProviderError::RateLimited),
        (400, ProviderError::Rejected),
        (500, ProviderError::Unavailable),
        (504, ProviderError::Timeout),
        (302, ProviderError::Unavailable),
    ] {
        server.reset().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(status).set_body_string("private upstream content"))
            .expect(1)
            .mount(&server)
            .await;
        let error = provider.send("hello", &options()).await.unwrap_err();
        assert_eq!(error, expected);
        assert!(!error.to_string().contains("private upstream"));
    }
}

#[tokio::test]
async fn rejects_incomplete_malformed_and_oversized_responses() {
    let server = MockServer::start().await;
    let provider = Aitunnel::new("test-key", server.uri(), TIMEOUT).unwrap();
    for (body, expected) in [
        (
            json!({"id":"r","model":"m","status":"incomplete","output":[]}).to_string(),
            ProviderError::Incomplete,
        ),
        ("not json".into(), ProviderError::InvalidResponse),
        (
            response(json!([])).to_string(),
            ProviderError::InvalidResponse,
        ),
        (
            "x".repeat(MAX_RESPONSE_BYTES + 1),
            ProviderError::ResponseTooLarge,
        ),
    ] {
        server.reset().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .expect(1)
            .mount(&server)
            .await;
        assert_eq!(
            provider.send("hello", &options()).await.unwrap_err(),
            expected
        );
    }
}

#[tokio::test]
async fn timeout_and_missing_credentials_are_explicit() {
    for key in ["", "  ", "bad\nkey"] {
        assert!(matches!(
            Aitunnel::new(key, ENDPOINT.into(), TIMEOUT),
            Err(ProviderError::AuthRequired)
        ));
    }
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(100)))
        .mount(&server)
        .await;
    let provider = Aitunnel::new("test-key", server.uri(), Duration::from_millis(10)).unwrap();
    assert_eq!(
        provider.send("hello", &options()).await.unwrap_err(),
        ProviderError::Timeout
    );
}
