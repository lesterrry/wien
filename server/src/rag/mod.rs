mod arguments;

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tonic::{
    Request,
    metadata::MetadataValue,
    transport::{Channel, ClientTlsConfig, Endpoint},
};

use crate::assistant::tools::ToolError;

pub mod pb {
    tonic::include_proto!("strudel.rag.v1");
}

/// Clone the channel per call: concurrent assistant requests do not share a mutex.
#[derive(Clone)]
pub struct RagClient {
    client: pb::strudel_rag_client::StrudelRagClient<Channel>,
    bearer: Option<MetadataValue<tonic::metadata::Ascii>>,
    timeout: Duration,
}

impl RagClient {
    pub fn from_env() -> Result<Self, ToolError> {
        let endpoint = std::env::var("STRUDEL_RAG_ENDPOINT")
            .unwrap_or_else(|_| "http://127.0.0.1:50051".into());
        let token = std::env::var("STRUDEL_RAG_BEARER_TOKEN")
            .ok()
            .filter(|v| !v.is_empty());
        Self::new(&endpoint, token.as_deref(), Duration::from_secs(15))
    }

    pub fn new(uri: &str, token: Option<&str>, timeout: Duration) -> Result<Self, ToolError> {
        if timeout.is_zero() || !(uri.starts_with("http://") || uri.starts_with("https://")) {
            return Err(ToolError::Configuration);
        }
        let mut endpoint = Endpoint::from_shared(uri.to_owned())
            .map_err(|_| ToolError::Configuration)?
            .connect_timeout(Duration::from_secs(3))
            .timeout(timeout);
        if uri.starts_with("https://") {
            endpoint = endpoint
                .tls_config(ClientTlsConfig::new().with_native_roots())
                .map_err(|_| ToolError::Configuration)?;
        }
        let bearer = token
            .map(|token| {
                let mut value = MetadataValue::try_from(format!("Bearer {token}"))
                    .map_err(|_| ToolError::Configuration)?;
                value.set_sensitive(true);
                Ok(value)
            })
            .transpose()?;
        let client = pb::strudel_rag_client::StrudelRagClient::new(endpoint.connect_lazy())
            .max_decoding_message_size(16 * 1024 * 1024)
            .max_encoding_message_size(64 * 1024);
        Ok(Self {
            client,
            bearer,
            timeout,
        })
    }

    fn request<T>(&self, message: T) -> Request<T> {
        let mut request = Request::new(message);
        request.set_timeout(self.timeout);
        if let Some(bearer) = &self.bearer {
            request
                .metadata_mut()
                .insert("authorization", bearer.clone());
        }
        request
    }

    pub async fn call(&self, name: &str, arguments: Value) -> Result<Value, ToolError> {
        let mut client = self.client.clone();
        let result = async {
            match name {
                "strudel_rag_search" => {
                    let query = arguments::search(arguments)?;
                    let result = client
                        .search(self.request(query))
                        .await
                        .map_err(status)?
                        .into_inner();
                    encode(result)
                }
                "strudel_rag_get_document" => {
                    let query = arguments::document(arguments)?;
                    let result = client
                        .get_document(self.request(query))
                        .await
                        .map_err(status)?
                        .into_inner();
                    encode(result)
                }
                "strudel_rag_get_corpus_info" => {
                    if arguments != serde_json::json!({}) {
                        return Err(ToolError::InvalidArguments);
                    }
                    let result = client
                        .get_corpus_info(self.request(pb::GetCorpusInfoRequest {}))
                        .await
                        .map_err(status)?
                        .into_inner();
                    encode(result)
                }
                _ => Err(ToolError::UnknownTool),
            }
        };
        tokio::time::timeout(self.timeout, result)
            .await
            .map_err(|_| ToolError::Timeout)?
    }
}

fn encode(value: impl Serialize) -> Result<Value, ToolError> {
    let mut value = serde_json::to_value(value).map_err(|_| ToolError::Unavailable)?;
    // Protobuf encodes enums as numbers; expose meaningful evidence labels to the model.
    fn labels(value: &mut Value) {
        match value {
            Value::Array(items) => items.iter_mut().for_each(labels),
            Value::Object(object) => {
                if let Some(kind) = object.get_mut("kind") {
                    *kind = Value::String(
                        match kind.as_i64() {
                            Some(1) => "api",
                            Some(2) => "theory",
                            Some(3) => "example",
                            _ => "unknown",
                        }
                        .into(),
                    );
                }
                if let Some(status) = object.get_mut("verification_status") {
                    *status = Value::String(
                        match status.as_i64() {
                            Some(1) => "source_only",
                            Some(2) => "statically_checked",
                            Some(3) => "executed",
                            _ => "unknown",
                        }
                        .into(),
                    );
                }
                object.values_mut().for_each(labels);
            }
            _ => {}
        }
    }
    labels(&mut value);
    Ok(value)
}

fn status(error: tonic::Status) -> ToolError {
    use tonic::Code;
    // Never propagate remote error text: it may contain credentials or source content.
    match error.code() {
        Code::InvalidArgument | Code::OutOfRange => ToolError::InvalidArguments,
        Code::NotFound => ToolError::NotFound,
        Code::FailedPrecondition => ToolError::NotReady,
        Code::Unauthenticated | Code::PermissionDenied => ToolError::Unauthorized,
        Code::DeadlineExceeded | Code::Cancelled => ToolError::Timeout,
        _ => ToolError::Unavailable,
    }
}
