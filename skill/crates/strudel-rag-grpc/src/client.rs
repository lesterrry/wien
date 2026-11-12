use crate::conversions::{ConvertFrom, TryConvertFrom, TryConvertInto};
use crate::{pb, status::from_status};
use std::time::Duration;
use strudel_rag_core::{
    ClientConfig, CorpusInfo, DocumentReference, DocumentResponse, Error, Result, SearchRequest,
    SearchResponse,
};
use tonic::{
    Request,
    metadata::{Ascii, MetadataValue},
    transport::{Channel, ClientTlsConfig, Endpoint},
};

/// A true network client. Connecting and invoking it never opens local indexes,
/// imports sources, or constructs an embedding provider.
/// Intentionally not Debug: authorization metadata is secret.
pub struct RemoteClient {
    rag: pb::strudel_rag_client::StrudelRagClient<Channel>,
    health: tonic_health::pb::health_client::HealthClient<Channel>,
    bearer: Option<MetadataValue<Ascii>>,
    timeout: Duration,
}
impl RemoteClient {
    pub async fn connect(config: &ClientConfig) -> Result<Self> {
        if config.timeout_secs == 0 || config.connect_timeout_secs == 0 {
            return Err(Error::Config("client timeouts must be positive".into()));
        }
        if !(config.endpoint.starts_with("http://") || config.endpoint.starts_with("https://")) {
            return Err(Error::Config(
                "remote endpoint must use HTTP or HTTPS".into(),
            ));
        }
        let timeout = Duration::from_secs(config.timeout_secs);
        let mut endpoint = Endpoint::from_shared(config.endpoint.clone())
            .map_err(|_| Error::Config("invalid remote endpoint".into()))?
            .connect_timeout(Duration::from_secs(config.connect_timeout_secs))
            .timeout(timeout);
        if config.endpoint.starts_with("https://") {
            endpoint = endpoint
                .tls_config(ClientTlsConfig::new().with_native_roots())
                .map_err(|_| {
                    Error::Config("cannot initialize trusted-root TLS for remote endpoint".into())
                })?;
        }
        let bearer = config
            .bearer_token()
            .map(|token| {
                MetadataValue::try_from(format!("Bearer {token}")).map_err(|_| {
                    Error::Config("bearer token contains invalid metadata characters".into())
                })
            })
            .transpose()?;
        let channel = endpoint
            .connect()
            .await
            .map_err(|_| Error::Provider("cannot connect to remote gRPC endpoint".into()))?;
        Ok(Self {
            rag: pb::strudel_rag_client::StrudelRagClient::new(channel.clone())
                .max_decoding_message_size(16 * 1024 * 1024)
                .max_encoding_message_size(64 * 1024),
            health: tonic_health::pb::health_client::HealthClient::new(channel)
                .max_decoding_message_size(16 * 1024 * 1024)
                .max_encoding_message_size(64 * 1024),
            bearer,
            timeout,
        })
    }
    fn request<T>(&self, value: T) -> Request<T> {
        let mut request = Request::new(value);
        request.set_timeout(self.timeout);
        if let Some(bearer) = &self.bearer {
            request
                .metadata_mut()
                .insert("authorization", bearer.clone());
        }
        request
    }
    pub async fn search(&mut self, request: SearchRequest) -> Result<SearchResponse> {
        let request = self.request(pb::SearchRequest::try_convert_from(request)?);
        self.rag
            .search(request)
            .await
            .map_err(from_status)?
            .into_inner()
            .try_convert_into()
    }
    pub async fn get_document(
        &mut self,
        reference: DocumentReference,
        parent_context: bool,
    ) -> Result<DocumentResponse> {
        let request = self.request(pb::GetDocumentRequest::convert_from((
            reference,
            parent_context,
        )));
        self.rag
            .get_document(request)
            .await
            .map_err(from_status)?
            .into_inner()
            .try_convert_into()
    }
    pub async fn corpus_info(&mut self) -> Result<CorpusInfo> {
        let request = self.request(pb::GetCorpusInfoRequest {});
        self.rag
            .get_corpus_info(request)
            .await
            .map_err(from_status)?
            .into_inner()
            .try_convert_into()
    }
    pub async fn health(&mut self) -> Result<bool> {
        let request = self.request(tonic_health::pb::HealthCheckRequest {
            service: "strudel.rag.v1.StrudelRag".into(),
        });
        let status = self
            .health
            .check(request)
            .await
            .map_err(from_status)?
            .into_inner()
            .status;
        Ok(status == tonic_health::pb::health_check_response::ServingStatus::Serving as i32)
    }
}
