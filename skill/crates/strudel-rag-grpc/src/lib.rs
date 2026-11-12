//! Typed gRPC transport for the local Strudel retrieval engine.
//! Source records remain untrusted data; this transport never executes their content.

pub use rag_protocol as pb;

mod auth;
pub mod client;
pub mod conversions;
pub mod server;
mod status;

pub use client::RemoteClient;
pub use server::serve;
