//! A JSON-RPC error as the TypeScript server sends an `McpError`, shared by the resources and the prompts.

use rmcp::ErrorData;
use rmcp::model::ErrorCode;

// PARITY(#299): the TypeScript SDK's `McpError` writes "MCP error <code>: " before its message, so that is
// what goes on the wire, and the SDK sends no `data` (the `{ uri }` the resource code builds never leaves
// the server; suspected TS bug) — drop if Rust becomes the only server.
/// A JSON-RPC error as the TypeScript server sends an `McpError`.
pub fn mcp_error(code: ErrorCode, message: &str) -> ErrorData {
    ErrorData::new(code, format!("MCP error {}: {message}", code.0), None)
}
