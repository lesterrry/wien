//! Typed gRPC transport for the local Strudel retrieval engine.
//! Source records remain untrusted data; this transport never executes their content.

pub mod pb {
    tonic::include_proto!("strudel.rag.v1");
    pub const FILE_DESCRIPTOR_SET: &[u8] = tonic::include_file_descriptor_set!("rag_descriptor");
}

mod auth;
pub mod client;
pub mod conversions;
pub mod server;
mod status;

pub use client::RemoteClient;
pub use server::serve;
