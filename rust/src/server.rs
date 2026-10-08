//! The MCP server: `initialize`, `tools/list` and `tools/call` over rmcp. It only wires: each
//! tool is in `tools/`, and what they share is in `tool.rs`.
//!
//! Tools are listed by hand rather than with rmcp's `#[tool]` macros, so every byte of a tool's
//! definition is ours to match against the TypeScript snapshot (ADR-0016, ADR-0025 Decision 2).

use std::sync::{Arc, LazyLock};

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListResourceTemplatesResult, ListResourcesResult,
    ListToolsResult, PaginatedRequestParams, ReadResourceRequestParams, ReadResourceResponse, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde_json::Value;

use crate::client::LogseqClient;
use crate::resources;
use crate::tool::{error_result, into_result};
use crate::tools;

/// The server name the TypeScript server reports (`src/index.ts`).
pub const SERVER_NAME: &str = "logseq-mcp-server";

/// `version` from the repo's package.json, as `src/version.ts` reads it, so both servers report one version.
pub static SERVER_VERSION: LazyLock<String> = LazyLock::new(|| {
    let package: Value = serde_json::from_str(include_str!("../../package.json")).expect("package.json is JSON");
    package["version"].as_str().expect("package.json has a version").to_owned()
});

/// Server `instructions`. A placeholder until more tools land: the TypeScript text
/// (`src/instructions.ts`) names tools this server doesn't have yet.
pub const SERVER_INSTRUCTIONS: &str = "Rust spike of the LogSeq MCP server (read-only). Available tools: logseq_get_graph_info (which graph is open), logseq_list_pages (page names), logseq_search_blocks (keyword search) and logseq_get_page_outline (a page's top-level blocks).";

#[derive(Clone)]
pub struct LogseqServer {
    client: Arc<LogseqClient>,
    /// Whether results carry next-step tips (`LOGSEQ_MCP_TIPS` over the config file's `tips`)
    tips_enabled: bool,
}

impl LogseqServer {
    pub fn new(client: LogseqClient, tips_enabled: bool) -> Self {
        LogseqServer { client: Arc::new(client), tips_enabled }
    }

    async fn dispatch(&self, request: CallToolRequestParams) -> CallToolResult {
        match tools::call(request.name.as_ref(), &self.client, self.tips_enabled, request.arguments).await {
            Some(outcome) => into_result(outcome),
            None => error_result(&format!("Unknown tool: {}", request.name)),
        }
    }
}

impl ServerHandler for LogseqServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_resources().build())
            .with_server_info(Implementation::new(SERVER_NAME, SERVER_VERSION.as_str()))
            .with_instructions(SERVER_INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(tools::list()))
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        Ok(ListResourcesResult::with_all_items(resources::list()))
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        Ok(ListResourceTemplatesResult::with_all_items(resources::templates()))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        Ok(resources::read(&self.client, &request.uri).await?.into())
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        Ok(self.dispatch(request).await.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::tools::get_page_outline;
    use rmcp::ServiceExt;
    use serde_json::json;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[test]
    fn the_version_is_package_json_s() {
        assert!(SERVER_VERSION.split('.').count() == 3, "{}", *SERVER_VERSION);
    }

    /// Runs the server over an in-memory pipe and sends it raw JSON-RPC lines, so the test sees
    /// what a client sees on stdio. `api_url` should be [`closed_port_url`]: nothing reaches LogSeq.
    async fn exchange(api_url: &str, requests: &[Value]) -> Vec<Value> {
        let client = LogseqClient::new(&Config {
            api_url: api_url.into(),
            auth_token: "unused".into(),
            timeout_ms: Some(2000.0),
            tips: None,
        });
        let (server_io, client_io) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server_io);
        let running = tokio::spawn(async move {
            let service = LogseqServer::new(client, true).serve((server_read, server_write)).await.unwrap();
            let _ = service.waiting().await;
        });
        let (client_read, mut client_write) = tokio::io::split(client_io);
        let mut lines = BufReader::new(client_read).lines();
        let mut responses = Vec::new();
        for request in requests {
            client_write.write_all(format!("{request}\n").as_bytes()).await.unwrap();
            if request.get("id").is_some() {
                let line = lines.next_line().await.unwrap().expect("a response line");
                responses.push(serde_json::from_str(&line).unwrap());
            }
        }
        running.abort();
        responses
    }

    /// A local URL nothing listens on: bound to get a free port, then closed.
    async fn closed_port_url() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    }

    fn initialize() -> Value {
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "0"}
        }})
    }

    const INITIALIZED: &str = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;

    #[tokio::test]
    async fn initialize_reports_the_name_version_and_instructions() {
        let responses = exchange(&closed_port_url().await, &[initialize()]).await;
        let result = &responses[0]["result"];
        assert_eq!(result["serverInfo"]["name"], SERVER_NAME);
        assert_eq!(result["serverInfo"]["version"], SERVER_VERSION.as_str());
        assert_eq!(result["instructions"], SERVER_INSTRUCTIONS);
        assert_eq!(result["protocolVersion"], "2025-06-18");
        assert!(result["capabilities"]["tools"].is_object());
    }

    #[tokio::test]
    async fn tools_list_returns_every_tool_read_only() {
        let responses = exchange(&closed_port_url().await, &[
            initialize(),
            serde_json::from_str(INITIALIZED).unwrap(),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        ])
        .await;
        let tools = responses[1]["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), tools::list().len());
        let outline = tools.iter().find(|tool| tool["name"] == get_page_outline::NAME).expect("the outline tool is listed");
        let ours = tools::list().into_iter().find(|tool| tool.name == get_page_outline::NAME).unwrap();
        assert_eq!(outline["inputSchema"], serde_json::to_value(&ours).unwrap()["inputSchema"]);
        for tool in tools {
            assert_eq!(tool["annotations"]["readOnlyHint"], true, "{}", tool["name"]);
        }
    }

    #[tokio::test]
    async fn a_failed_call_is_an_error_result_not_a_protocol_error() {
        let api_url = closed_port_url().await;
        let responses = exchange(&api_url, &[
            initialize(),
            serde_json::from_str(INITIALIZED).unwrap(),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": get_page_outline::NAME, "arguments": {"page_name": "Alice"}}}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "logseq_nope", "arguments": {}}}),
        ])
        .await;
        let outline = &responses[1]["result"];
        assert_eq!(outline["isError"], true);
        let text: Value = serde_json::from_str(outline["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(text["error"].as_str().unwrap().starts_with(&format!("Cannot connect to LogSeq at {api_url}")), "{text}");
        let unknown = &responses[2]["result"];
        assert_eq!(unknown["isError"], true);
        assert_eq!(unknown["content"][0]["text"], r#"{"error":"Unknown tool: logseq_nope"}"#);
    }
}
