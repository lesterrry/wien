use super::tools::ToolError;
use crate::providers::ProviderError;

#[derive(Debug)]
pub enum AssistError {
    Provider(ProviderError),
    Tool(ToolError),
    Limit,
}
impl From<ProviderError> for AssistError {
    fn from(error: ProviderError) -> Self {
        Self::Provider(error)
    }
}
impl From<ToolError> for AssistError {
    fn from(error: ToolError) -> Self {
        Self::Tool(error)
    }
}
