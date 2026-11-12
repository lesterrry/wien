//! Shared wire types; no dependency on the retrieval engine.
tonic::include_proto!("strudel.rag.v1");
pub const FILE_DESCRIPTOR_SET: &[u8] = tonic::include_file_descriptor_set!("rag_descriptor");
