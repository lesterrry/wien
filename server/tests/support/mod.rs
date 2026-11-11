use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Arc;
use wien_server::{
    api,
    assistant::{
        AssistantConfig,
        tools::{AssistantTools, ToolError},
    },
    providers::Provider,
};

pub struct ReadyTools;
#[async_trait]
impl AssistantTools for ReadyTools {
    async fn call(&self, name: &str, _: Value) -> Result<Value, ToolError> {
        assert_eq!(name, "strudel_rag_get_corpus_info");
        Ok(json!({"ready":true, "fixture":true}))
    }
}
pub fn router(provider: Arc<dyn Provider>, config: AssistantConfig) -> axum::Router {
    api::router(provider, config, Arc::new(ReadyTools))
}
