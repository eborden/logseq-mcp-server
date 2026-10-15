//! A JSON-RPC error answering a prompt or resource request, shared by the resources and the prompts.

use rmcp::ErrorData;
use rmcp::model::ErrorCode;

/// A JSON-RPC error with the code and the message as written, and no `data`.
pub fn mcp_error(code: ErrorCode, message: &str) -> ErrorData {
    ErrorData::new(code, message.to_owned(), None)
}

/// A resource-not-found error. Its `data` is `{ "uri": uri }`, naming the resource that was asked for.
pub fn resource_not_found(message: &str, uri: &str) -> ErrorData {
    ErrorData::new(ErrorCode::RESOURCE_NOT_FOUND, message.to_owned(), Some(serde_json::json!({ "uri": uri })))
}
