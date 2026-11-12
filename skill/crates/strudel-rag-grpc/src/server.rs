use crate::conversions::{ConvertInto, TryConvertInto};
use crate::{auth::BearerAuth, pb, status::to_status};
use http_body_util::BodyExt;
use prost::Message;
use std::{future::Future, sync::Arc, time::Duration};
use strudel_rag_core::{Config, CorpusInfo, Error, RagEngine, Result};
use tokio::{net::TcpListener, sync::Semaphore};
use tonic::{Request, Response, Status, service::interceptor::InterceptedService};
use tower::util::MapResponseLayer;

#[derive(Clone)]
struct RagService {
    engine: Option<Arc<RagEngine>>,
    searches: Arc<Semaphore>,
    max_response_bytes: usize,
}
impl RagService {
    fn engine(&self) -> std::result::Result<Arc<RagEngine>, Status> {
        self.engine
            .clone()
            .filter(|e| e.corpus_info().ready)
            .ok_or_else(|| {
                Status::failed_precondition("retrieval index is not ready or is incompatible")
            })
    }
    fn response<T: Message>(&self, value: T) -> std::result::Result<Response<T>, Status> {
        if value.encoded_len() > self.max_response_bytes {
            return Err(Status::resource_exhausted(
                "response exceeds configured message limit",
            ));
        }
        Ok(Response::new(value))
    }
}
#[tonic::async_trait]
impl pb::strudel_rag_server::StrudelRag for RagService {
    async fn search(
        &self,
        request: Request<pb::SearchRequest>,
    ) -> std::result::Result<Response<pb::SearchResponse>, Status> {
        let request = request.into_inner().try_convert_into().map_err(to_status)?;
        let engine = self.engine()?;
        let _permit = self
            .searches
            .clone()
            .try_acquire_owned()
            .map_err(|_| Status::resource_exhausted("concurrent search limit reached"))?;
        let result = engine.search(request).await.map_err(to_status)?;
        self.response(result.try_convert_into().map_err(to_status)?)
    }
    async fn get_document(
        &self,
        request: Request<pb::GetDocumentRequest>,
    ) -> std::result::Result<Response<pb::GetDocumentResponse>, Status> {
        let (reference, parent) = request.into_inner().try_convert_into().map_err(to_status)?;
        let engine = self.engine()?;
        let document = tokio::task::spawn_blocking(move || engine.get_document(reference, parent))
            .await
            .map_err(|_| Status::internal("document retrieval worker failed"))?
            .map_err(to_status)?;
        self.response(document.convert_into())
    }
    async fn get_corpus_info(
        &self,
        _request: Request<pb::GetCorpusInfoRequest>,
    ) -> std::result::Result<Response<pb::GetCorpusInfoResponse>, Status> {
        let mut info = self
            .engine
            .as_ref()
            .map(|e| e.corpus_info())
            .unwrap_or_else(|| CorpusInfo {
                readiness_reason: Some("retrieval index is not ready".into()),
                ..Default::default()
            });
        if !info.ready {
            // The underlying diagnostic may include personal filesystem paths.
            info.readiness_reason = Some(
                "retrieval index is absent, incompatible, or corrupt; run local doctor".into(),
            );
        }
        self.response(info.try_convert_into().map_err(to_status)?)
    }
}

// tonic's codec reports an oversized decoded message as OUT_OF_RANGE. The public
// API classifies all transport size overflows as RESOURCE_EXHAUSTED instead.
// Stream trailers are covered as well as unary status headers.
fn resource_limits(
    mut response: http::Response<tonic::body::Body>,
) -> http::Response<tonic::body::Body> {
    fn map_status(headers: &mut http::HeaderMap) {
        if headers
            .get("grpc-status")
            .is_some_and(|value| value == "11")
        {
            headers.insert("grpc-status", http::HeaderValue::from_static("8"));
        }
    }
    map_status(response.headers_mut());
    response.map(|body| {
        tonic::body::Body::new(body.map_frame(|frame| match frame.into_trailers() {
            Ok(mut trailers) => {
                map_status(&mut trailers);
                http_body::Frame::trailers(trailers)
            }
            Err(frame) => frame,
        }))
    })
}

/// Serve the immutable opened generation. Missing/corrupt indexes still expose
/// authenticated health, reflection, and a not-ready CorpusInfo response.
pub async fn serve<F>(config: &Config, engine: Option<Arc<RagEngine>>, shutdown: F) -> Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    let bearer = config.server.bearer_token();
    validate_server(config, engine.as_ref(), bearer.is_some())?;
    let listener = TcpListener::bind(config.server.bind).await?;
    serve_with_bearer(config, engine, listener, bearer, shutdown).await
}

fn validate_server(
    config: &Config,
    engine: Option<&Arc<RagEngine>>,
    has_bearer: bool,
) -> Result<()> {
    config.validate()?;
    if !config.server.bind.ip().is_loopback() && !has_bearer {
        return Err(Error::Config(
            "non-loopback gRPC binding requires the configured bearer token environment variable"
                .into(),
        ));
    }
    if (config.embedding.provider == "mock" || engine.is_some_and(|e| e.corpus_info().fixture))
        && !config.server.bind.ip().is_loopback()
    {
        return Err(Error::Config(
            "fixture providers and corpora may only be served on loopback".into(),
        ));
    }
    Ok(())
}

/// Listener-based entry point for embedders and ephemeral-port integration tests.
/// The actual listener address, not just the configured bind, is validated.
pub async fn serve_with_listener<F>(
    config: &Config,
    engine: Option<Arc<RagEngine>>,
    listener: TcpListener,
    shutdown: F,
) -> Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    serve_with_bearer(
        config,
        engine,
        listener,
        config.server.bearer_token(),
        shutdown,
    )
    .await
}

async fn serve_with_bearer<F>(
    config: &Config,
    engine: Option<Arc<RagEngine>>,
    listener: TcpListener,
    bearer: Option<String>,
    shutdown: F,
) -> Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    let mut checked = config.clone();
    checked.server.bind = listener.local_addr()?;
    validate_server(&checked, engine.as_ref(), bearer.is_some())?;
    let service = RagService {
        engine: engine.clone(),
        searches: Arc::new(Semaphore::new(config.server.max_concurrent_searches)),
        max_response_bytes: config.server.max_response_bytes,
    };
    let auth = BearerAuth::new(bearer.as_deref());
    let rag = pb::strudel_rag_server::StrudelRagServer::new(service)
        .max_decoding_message_size(config.server.max_request_bytes)
        .max_encoding_message_size(config.server.max_response_bytes);
    let (health_reporter, health) = tonic_health::server::health_reporter();
    let serving = engine.as_ref().is_some_and(|e| e.corpus_info().ready);
    let status = if serving {
        tonic_health::ServingStatus::Serving
    } else {
        tonic_health::ServingStatus::NotServing
    };
    health_reporter.set_service_status("", status).await;
    health_reporter
        .set_service_status("strudel.rag.v1.StrudelRag", status)
        .await;
    let health = health
        .max_decoding_message_size(config.server.max_request_bytes)
        .max_encoding_message_size(config.server.max_response_bytes);
    let reflection_v1 = tonic_reflection::server::Builder::configure()
        .register_encoded_file_descriptor_set(pb::FILE_DESCRIPTOR_SET)
        .register_encoded_file_descriptor_set(tonic_health::pb::FILE_DESCRIPTOR_SET)
        .build_v1()
        .map_err(|_| Error::Other("cannot construct gRPC reflection service".into()))?
        .max_decoding_message_size(config.server.max_request_bytes)
        .max_encoding_message_size(config.server.max_response_bytes);
    let reflection_v1alpha = tonic_reflection::server::Builder::configure()
        .register_encoded_file_descriptor_set(pb::FILE_DESCRIPTOR_SET)
        .register_encoded_file_descriptor_set(tonic_health::pb::FILE_DESCRIPTOR_SET)
        .build_v1alpha()
        .map_err(|_| Error::Other("cannot construct gRPC reflection service".into()))?
        .max_decoding_message_size(config.server.max_request_bytes)
        .max_encoding_message_size(config.server.max_response_bytes);
    let shutdown = async move {
        shutdown.await;
        health_reporter
            .set_service_status("", tonic_health::ServingStatus::NotServing)
            .await;
        health_reporter
            .set_service_status(
                "strudel.rag.v1.StrudelRag",
                tonic_health::ServingStatus::NotServing,
            )
            .await;
    };
    tonic::transport::Server::builder()
        .timeout(Duration::from_secs(config.server.timeout_secs))
        .layer(MapResponseLayer::new(resource_limits))
        .add_service(InterceptedService::new(rag, auth.clone()))
        .add_service(InterceptedService::new(health, auth.clone()))
        .add_service(InterceptedService::new(reflection_v1, auth.clone()))
        .add_service(InterceptedService::new(reflection_v1alpha, auth))
        .serve_with_incoming_shutdown(
            tokio_stream::wrappers::TcpListenerStream::new(listener),
            shutdown,
        )
        .await
        .map_err(|_| Error::Other("gRPC server transport failed".into()))
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
