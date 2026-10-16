//! The MCP server: `initialize`, `tools/list` and `tools/call` over rmcp. It only wires: each
//! tool is in `tools/`, and what they share is in `tool.rs`.
//!
//! Tools are listed by hand rather than with rmcp's `#[tool]` macros, so every byte of a tool's
//! definition is ours to match against the recorded `tool-list` golden (ADR-0016, ADR-0034 Decision 3).

use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, GetPromptRequestParams, GetPromptResponse, Implementation,
    CacheScope, ListPromptsResult, ListResourceTemplatesResult, ListResourcesResult, ListToolsResult, PaginatedRequestParams, ProtocolVersion, ReadResourceRequestParams, ReadResourceResponse, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde_json::Value;

use crate::client::LogseqClient;
use crate::dates::Clock;
use crate::instructions::SERVER_INSTRUCTIONS;
use crate::prompts;
use crate::resources;
use crate::snapshots::Snapshots;
use crate::tool::{error_result, into_result};
use crate::tools;

/// How long a client may keep the lists the process never changes (`tools/list`, `prompts/list`, `resources/list`):
/// an hour. They are fixed at build time, so only a restart changes them (SEP-2549, #589).
pub const STATIC_LIST_TTL_MS: u64 = 3_600_000;
/// The static lists hold no graph data, so any client or intermediary may share them.
pub const STATIC_LIST_CACHE_SCOPE: CacheScope = CacheScope::Public;
/// `resources/read` of a page changes as LogSeq is edited, so it is never fresh.
pub const RESOURCE_READ_TTL_MS: u64 = 0;
/// A read page is the person's own graph data.
pub const RESOURCE_READ_CACHE_SCOPE: CacheScope = CacheScope::Private;

/// Whether the client negotiated 2026-07-28 or later, the versions that carry `ttlMs` and `cacheScope`. An older
/// client gets the results it always did, with neither field (rmcp fills them in for newer clients only).
fn carries_cache_hints(context: &RequestContext<RoleServer>) -> bool {
    // ISO `YYYY-MM-DD` versions compare lexically the same as chronologically
    context.protocol_version().is_some_and(|v| v.as_str() >= ProtocolVersion::V_2026_07_28.as_str())
}

/// The server name `serverInfo` reports.
pub const SERVER_NAME: &str = "logseq-mcp-server";

/// The package's `version` in `Cargo.toml`. Cargo owns it; `tests/rust-guards/version.test.ts` keeps it equal to
/// package.json and the plugin manifest.
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone)]
pub struct LogseqServer {
    client: Arc<LogseqClient>,
    /// Whether results carry next-step tips (`LOGSEQ_MCP_TIPS` over the config file's `tips`)
    tips_enabled: bool,
    /// Where the tools read "now" from: the system, or the instant `LOGSEQ_MCP_NOW` fixes
    clock: Clock,
    /// The lists the cursor tools kept for their later pages (ADR-0038): one owner, shared by every clone of the server
    snapshots: Arc<Snapshots>,
}

impl LogseqServer {
    pub fn new(client: LogseqClient, tips_enabled: bool) -> Self {
        // The start time is half of every snapshot key, so it is the system's, never a fixed clock's: a restarted
        // server must not hand out a key a client still holds
        let started = Clock::System.now_ms().max(0) as u64;
        LogseqServer { client: Arc::new(client), tips_enabled, clock: Clock::System, snapshots: Arc::new(Snapshots::new(started)) }
    }

    /// The same server reading "now" from `clock`.
    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    async fn dispatch(&self, request: CallToolRequestParams) -> CallToolResult {
        match tools::call(request.name.as_ref(), &self.client, self.tips_enabled, self.clock, &self.snapshots, request.arguments).await {
            Some(outcome) => into_result(outcome),
            None => error_result(&format!("Unknown tool: {}", request.name)),
        }
    }
}

impl ServerHandler for LogseqServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_prompts().enable_resources().build())
            .with_server_info(Implementation::new(SERVER_NAME, SERVER_VERSION))
            .with_instructions(SERVER_INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let result = ListToolsResult::with_all_items(tools::list());
        Ok(if carries_cache_hints(&context) {
            result.with_ttl_ms(STATIC_LIST_TTL_MS).with_cache_scope(STATIC_LIST_CACHE_SCOPE)
        } else {
            result
        })
    }

    async fn list_prompts(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, ErrorData> {
        let result = ListPromptsResult::with_all_items(prompts::list());
        Ok(if carries_cache_hints(&context) {
            result.with_ttl_ms(STATIC_LIST_TTL_MS).with_cache_scope(STATIC_LIST_CACHE_SCOPE)
        } else {
            result
        })
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, ErrorData> {
        Ok(prompts::get(&request.name, request.arguments.as_ref(), self.clock.today())?.into())
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        let result = ListResourcesResult::with_all_items(resources::list());
        Ok(if carries_cache_hints(&context) {
            result.with_ttl_ms(STATIC_LIST_TTL_MS).with_cache_scope(STATIC_LIST_CACHE_SCOPE)
        } else {
            result
        })
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
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        let result = resources::read(&self.client, &request.uri).await?;
        Ok(if carries_cache_hints(&context) {
            result.with_ttl_ms(RESOURCE_READ_TTL_MS).with_cache_scope(RESOURCE_READ_CACHE_SCOPE).into()
        } else {
            result.into()
        })
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
    use crate::tools::get_page;
    use rmcp::ServiceExt;
    use serde_json::json;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[test]
    fn the_version_is_the_cargo_packages() {
        assert!(SERVER_VERSION.split('.').count() == 3, "{SERVER_VERSION}");
    }

    /// Runs the server over an in-memory pipe and sends it raw JSON-RPC lines, so the test sees
    /// what a client sees on stdio. `api_url` should be [`closed_port_url`]: nothing reaches LogSeq.
    async fn exchange(api_url: &str, requests: &[Value]) -> Vec<Value> {
        let client = LogseqClient::new(&Config {
            api_url: api_url.into(),
            auth_token: "unused".into(),
            timeout_ms: Some(2000),
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

    /// A local URL nothing listens on: port 1 is privileged and never bound, so a call is refused. A port freed by
    /// dropping a listener could be handed to a parallel test that binds `127.0.0.1:0` (#450).
    fn closed_port_url() -> String {
        "http://127.0.0.1:1".to_owned()
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
        let responses = exchange(&closed_port_url(), &[initialize()]).await;
        let result = &responses[0]["result"];
        assert_eq!(result["serverInfo"]["name"], SERVER_NAME);
        assert_eq!(result["serverInfo"]["version"], SERVER_VERSION);
        assert_eq!(result["instructions"], SERVER_INSTRUCTIONS);
        assert_eq!(result["protocolVersion"], "2025-06-18");
        assert!(result["capabilities"]["tools"].is_object());
        assert!(result["capabilities"]["prompts"].is_object());
        assert!(result["capabilities"]["resources"].is_object());
    }

    #[tokio::test]
    async fn prompts_are_listed_and_got_and_a_bad_request_is_invalid_params() {
        let responses = exchange(&closed_port_url(), &[
            initialize(),
            serde_json::from_str(INITIALIZED).unwrap(),
            json!({"jsonrpc": "2.0", "id": 2, "method": "prompts/list"}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "prompts/get", "params": {"name": "continue_on", "arguments": {"topic": "project atlas"}}}),
            json!({"jsonrpc": "2.0", "id": 4, "method": "prompts/get", "params": {"name": "continue_on"}}),
            json!({"jsonrpc": "2.0", "id": 5, "method": "prompts/get", "params": {"name": "continue_on", "arguments": {"topic": 5}}}),
        ])
        .await;
        let names: Vec<&str> = responses[1]["result"]["prompts"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["weekly_summary", "monthly_summary", "continue_on", "what_do_i_know", "prioritize_tasks"]);
        let got = &responses[2]["result"];
        assert_eq!(got["messages"][0]["role"], "user");
        assert!(got["messages"][0]["content"]["text"].as_str().unwrap().starts_with("Help me continue where I left off on \"project atlas\""));
        assert!(got.get("resultType").is_none(), "the result carries no resultType field: {got}");
        assert_eq!(responses[3]["error"]["code"], -32602);
        assert_eq!(responses[3]["error"]["message"], r#"Prompt "continue_on" needs a non-empty "topic" argument."#);
        assert_eq!(responses[4]["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn the_guide_is_listed_and_read() {
        let responses = exchange(&closed_port_url(), &[
            initialize(),
            serde_json::from_str(INITIALIZED).unwrap(),
            json!({"jsonrpc": "2.0", "id": 2, "method": "resources/list"}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "resources/read", "params": {"uri": "logseq://guide"}}),
            json!({"jsonrpc": "2.0", "id": 4, "method": "resources/read", "params": {"uri": "logseq://nope"}}),
        ])
        .await;
        assert_eq!(responses[1]["result"]["resources"][0]["uri"], "logseq://guide");
        let guide = &responses[2]["result"]["contents"][0];
        assert_eq!((guide["uri"].as_str(), guide["mimeType"].as_str()), (Some("logseq://guide"), Some("text/markdown")));
        assert!(guide["text"].as_str().unwrap().starts_with("# LogSeq MCP guide\n\nRead-only access to a LogSeq graph."));
        assert_eq!(
            responses[3]["error"]["message"],
            r#"Unknown resource "logseq://nope". Available: logseq://guide, logseq://page/{name}."#
        );
        assert_eq!(responses[3]["error"]["data"], serde_json::json!({ "uri": "logseq://nope" }));
    }

    #[tokio::test]
    async fn tools_list_returns_every_tool_read_only() {
        let responses = exchange(&closed_port_url(), &[
            initialize(),
            serde_json::from_str(INITIALIZED).unwrap(),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        ])
        .await;
        let tools = responses[1]["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), tools::list().len());
        let page = tools.iter().find(|tool| tool["name"] == get_page::NAME).expect("the page tool is listed");
        let ours = tools::list().into_iter().find(|tool| tool.name == get_page::NAME).unwrap();
        assert_eq!(page["inputSchema"], serde_json::to_value(&ours).unwrap()["inputSchema"]);
        for tool in tools {
            let name = tool["name"].as_str().unwrap();
            let annotations = &tool["annotations"];
            // BR-0002: every tool is read-only, titled, non-destructive and closed-world; all but the tool that reads
            // what the person has open in LogSeq (its answer changes between calls) are idempotent
            assert_eq!(annotations["readOnlyHint"], true, "{name}");
            assert_eq!(annotations["destructiveHint"], false, "{name}");
            assert_eq!(annotations["openWorldHint"], false, "{name}");
            assert_eq!(annotations["idempotentHint"], name != "logseq_get_current", "{name}");
            assert!(tool["title"].as_str().is_some_and(|title| !title.is_empty()), "{name} has a title");
            assert_eq!(tool["title"], annotations["title"], "{name}: the title and the annotation's title agree");
        }
    }

    #[tokio::test]
    async fn a_failed_call_is_an_error_result_not_a_protocol_error() {
        let api_url = closed_port_url();
        let responses = exchange(&api_url, &[
            initialize(),
            serde_json::from_str(INITIALIZED).unwrap(),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": get_page::NAME, "arguments": {"page": "Alice"}}}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "logseq_nope", "arguments": {}}}),
        ])
        .await;
        let failed = &responses[1]["result"];
        assert_eq!(failed["isError"], true);
        let text: Value = serde_json::from_str(failed["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(text["error"].as_str().unwrap().starts_with(&format!("Cannot connect to LogSeq at {api_url}")), "{text}");
        let unknown = &responses[2]["result"];
        assert_eq!(unknown["isError"], true);
        assert_eq!(unknown["content"][0]["text"], r#"{"error":"Unknown tool: logseq_nope"}"#);
    }

    /// A request that negotiates 2026-07-28 inline, in its own `_meta`, with no `initialize`.
    fn inline_2026(id: u64, method: &str, params: Value) -> Value {
        let mut params = params;
        params["_meta"] = json!({
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {"name": "test", "version": "0"},
            "io.modelcontextprotocol/clientCapabilities": {}
        });
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
    }

    /// The cache hints of the five cacheable results (SEP-2549, #589), as a 2026-07-28 client sees them.
    #[tokio::test]
    async fn a_2026_client_gets_the_cache_hints_pinned_here() {
        let responses = exchange(&closed_port_url(), &[
            inline_2026(1, "tools/list", json!({})),
            inline_2026(2, "prompts/list", json!({})),
            inline_2026(3, "resources/list", json!({})),
            inline_2026(4, "resources/templates/list", json!({})),
            inline_2026(5, "resources/read", json!({"uri": "logseq://guide"})),
        ])
        .await;
        let hints = |i: usize| (responses[i]["result"]["ttlMs"].clone(), responses[i]["result"]["cacheScope"].clone());
        for i in 0..3 {
            assert_eq!(hints(i), (json!(STATIC_LIST_TTL_MS), json!("public")), "{}", responses[i]);
        }
        assert!(STATIC_LIST_TTL_MS > 0);
        assert_eq!(STATIC_LIST_CACHE_SCOPE, CacheScope::Public);
        // the templates list stays at rmcp's defaults: not in #589's decision, so not cached
        assert_eq!(hints(3), (json!(0), json!("private")), "{}", responses[3]);
        assert_eq!(hints(4), (json!(RESOURCE_READ_TTL_MS), json!("private")), "{}", responses[4]);
        assert_eq!(RESOURCE_READ_TTL_MS, 0);
        assert_eq!(RESOURCE_READ_CACHE_SCOPE, CacheScope::Private);
    }

    /// A client that negotiated an older version gets the results it always did: no cache fields.
    #[tokio::test]
    async fn an_older_client_sees_no_cache_hints() {
        let responses = exchange(&closed_port_url(), &[
            initialize(),
            serde_json::from_str(INITIALIZED).unwrap(),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "prompts/list"}),
            json!({"jsonrpc": "2.0", "id": 4, "method": "resources/list"}),
            json!({"jsonrpc": "2.0", "id": 5, "method": "resources/read", "params": {"uri": "logseq://guide"}}),
        ])
        .await;
        for response in &responses[1..] {
            let result = response["result"].as_object().unwrap();
            assert!(!result.contains_key("ttlMs") && !result.contains_key("cacheScope"), "{response}");
        }
    }
}
