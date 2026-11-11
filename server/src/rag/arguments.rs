use serde::Deserialize;
use serde_json::Value;

use super::pb;
use crate::assistant::tools::ToolError;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Search {
    query: String,
    intent: Intent,
    #[serde(default = "default_top_k")]
    top_k: u32,
    #[serde(default)]
    filters: Filters,
}
fn default_top_k() -> u32 {
    5
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Intent {
    Api,
    Musical,
    Example,
    Mixed,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Filters {
    kinds: Vec<Kind>,
    source_ids: Vec<String>,
    tags: Vec<String>,
    languages: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Api,
    Theory,
    Example,
}

pub fn search(value: Value) -> Result<pb::SearchRequest, ToolError> {
    let args: Search = serde_json::from_value(value).map_err(|_| ToolError::InvalidArguments)?;
    if args.query.trim().is_empty()
        || args.query.len() > 4096
        || !(1..=10).contains(&args.top_k)
        || args.filters.kinds.len() > 3
        || [
            &args.filters.source_ids,
            &args.filters.tags,
            &args.filters.languages,
        ]
        .iter()
        .any(|items| items.len() > 20 || items.iter().any(|s| s.is_empty() || s.len() > 200))
    {
        return Err(ToolError::InvalidArguments);
    }
    Ok(pb::SearchRequest {
        query: args.query,
        intent: match args.intent {
            Intent::Api => 1,
            Intent::Musical => 2,
            Intent::Example => 3,
            Intent::Mixed => 4,
        },
        top_k: Some(args.top_k),
        filters: Some(pb::SearchFilters {
            kinds: args
                .filters
                .kinds
                .into_iter()
                .map(|k| match k {
                    Kind::Api => 1,
                    Kind::Theory => 2,
                    Kind::Example => 3,
                })
                .collect(),
            source_ids: args.filters.source_ids,
            tags: args.filters.tags,
            languages: args.filters.languages,
        }),
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    document_id: Option<String>,
    chunk_id: Option<String>,
    #[serde(default)]
    parent_context: bool,
}

pub fn document(value: Value) -> Result<pb::GetDocumentRequest, ToolError> {
    let args: Document = serde_json::from_value(value).map_err(|_| ToolError::InvalidArguments)?;
    use pb::get_document_request::Reference;
    let reference = match (args.document_id, args.chunk_id) {
        (Some(id), None) if !id.is_empty() && id.len() <= 200 => Reference::DocumentId(id),
        (None, Some(id)) if !id.is_empty() && id.len() <= 200 => Reference::ChunkId(id),
        _ => return Err(ToolError::InvalidArguments),
    };
    Ok(pb::GetDocumentRequest {
        reference: Some(reference),
        parent_context: args.parent_context,
    })
}
