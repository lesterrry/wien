use strudel_rag_core::Error;
use tonic::{Code, Status};

// Never send provider bodies, filesystem paths, or configured secrets over the wire.
pub(crate) fn to_status(error: Error) -> Status {
    match error {
        Error::Config(_) => Status::failed_precondition("server configuration is incompatible"),
        Error::InvalidArgument(_) => Status::invalid_argument("invalid request parameters"),
        Error::NotReady(_) => {
            Status::failed_precondition("retrieval index is not ready or is incompatible")
        }
        Error::NotFound(_) => Status::not_found("document or chunk was not found"),
        Error::Provider(_) => Status::unavailable("embedding provider is unavailable"),
        Error::Corrupt(_) | Error::Io(_) | Error::Json(_) | Error::Other(_) => {
            Status::internal("retrieval operation failed")
        }
    }
}

pub(crate) fn from_status(status: Status) -> Error {
    // A remote server is not trusted to send safe error text. Preserve only the code.
    match status.code() {
        Code::InvalidArgument | Code::OutOfRange => {
            Error::InvalidArgument("remote request was rejected".into())
        }
        Code::FailedPrecondition => {
            Error::NotReady("remote retrieval index is not ready or is incompatible".into())
        }
        Code::NotFound => Error::NotFound("remote document or chunk was not found".into()),
        Code::Unauthenticated | Code::PermissionDenied => {
            Error::Config("remote authentication failed; check bearer token environment".into())
        }
        Code::ResourceExhausted => Error::Other("remote resource limit exceeded".into()),
        Code::DeadlineExceeded | Code::Cancelled => {
            Error::Provider("remote request deadline elapsed or request was cancelled".into())
        }
        Code::Unavailable => Error::Provider("remote service is unavailable".into()),
        _ => Error::Other("remote service returned an internal error".into()),
    }
}
