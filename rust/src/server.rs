//! The MCP server: `initialize`, `tools/list` and `tools/call` over rmcp.
//!
//! Tools are listed by hand rather than with rmcp's `#[tool]` macros, so every byte of a tool's
//! definition is ours to match against the TypeScript snapshot (ADR-0016, ADR-0025 Decision 2).
//! The spike has one stub tool, a connectivity check; the first real port is #125.

use std::sync::{Arc, LazyLock};

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation, JsonObject,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool, ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler};
use schemars::JsonSchema;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::client::{LogseqClient, LogseqError};

/// The server name the TypeScript server reports (`src/index.ts`).
pub const SERVER_NAME: &str = "logseq-mcp-server";

/// `version` from the repo's package.json, as `src/version.ts` reads it, so both servers report one version.
pub static SERVER_VERSION: LazyLock<String> = LazyLock::new(|| {
    let package: Value = serde_json::from_str(include_str!("../../package.json")).expect("package.json is JSON");
    package["version"].as_str().expect("package.json has a version").to_owned()
});

/// Server `instructions`. A placeholder until a real tool lands: the TypeScript text
/// (`src/instructions.ts`) names tools this server doesn't have yet.
pub const SERVER_INSTRUCTIONS: &str =
    "Rust spike of the LogSeq MCP server (read-only). Only logseq_spike_ping is available: it checks that LogSeq answers.";

pub const PING_TOOL: &str = "logseq_spike_ping";

const PING_DESCRIPTION: &str = "Check that LogSeq's HTTP API answers with this server's token. Returns {\"connected\":true}.\n\n\
**Use when:** debugging the connection.\n\
**Can't find:** anything in the graph. This spike has no other tools yet.";

/// The stub's arguments: none. Unknown fields are ignored, as every TypeScript tool ignores them.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct PingArgs {}

/// Hints shared by every tool: each only reads from one known local LogSeq (BR-0002).
fn read_only_annotations(title: &str) -> ToolAnnotations {
    ToolAnnotations::with_title(title).read_only(true).destructive(false).idempotent(true).open_world(false)
}

/// A tool's `inputSchema`, generated from the type its arguments are parsed into, so the two
/// can't drift apart (ADR-0019). It has the TypeScript server's shape (`toInputSchema` in
/// `src/utils/parse-args.ts`, as the ADR-0016 snapshot shows it): no `$schema`, `title` or
/// `description` at the top, `required` always present, and no `additionalProperties`, because
/// unknown fields are ignored.
///
/// Each property is then rewritten into zod's shape (see [`zod_shaped_property`]). What the
/// argument type must do itself: numbers are `f64`, as zod's `z.number()` accepts `2.5` and the
/// tools clamp or floor them. An integer type would advertise `"type": "integer"` and reject
/// `2.5`, which TypeScript accepts, so this panics on one.
pub fn input_schema<T: JsonSchema>() -> Arc<JsonObject> {
    let generator = schemars::generate::SchemaSettings::draft2020_12().into_generator();
    let Value::Object(mut schema) = serde_json::to_value(generator.into_root_schema_for::<T>()).expect("a schema serializes")
    else {
        panic!("a tool's argument type must produce an object schema");
    };
    for key in ["$schema", "title", "description"] {
        schema.remove(key);
    }
    assert_eq!(schema.get("type"), Some(&json!("object")), "a tool's arguments must be an object");
    assert!(!schema.contains_key("additionalProperties"), "a tool's arguments must ignore unknown fields");
    let defs = match schema.remove("$defs") {
        Some(Value::Object(defs)) => defs,
        _ => JsonObject::new(),
    };
    let properties = match schema.remove("properties") {
        Some(Value::Object(properties)) => properties
            .into_iter()
            .map(|(name, property)| {
                let property = zod_shaped_property(property, &defs);
                (name, property)
            })
            .collect(),
        _ => JsonObject::new(),
    };
    schema.insert("properties".into(), Value::Object(properties));
    schema.entry("required").or_insert_with(|| json!([]));
    Arc::new(schema)
}

/// One property as zod's `toJSONSchema` writes it, from what schemars writes:
/// - An `Option` is optional through `required`, and zod doesn't add `null` to its type, so the
///   `null` alternative goes: `"type": ["number", "null"]` becomes `"number"`, `null` leaves an
///   `enum`, and `anyOf: [{...}, {"type": "null"}]` becomes the one schema.
/// - A string enum is inlined from `$defs` (zod has no `$ref`), keeping the property's own
///   `description` and `default` rather than the enum type's doc comment.
/// - schemars' `format` (`"double"`) goes; zod writes none.
fn zod_shaped_property(property: Value, defs: &JsonObject) -> Value {
    let Value::Object(mut property) = property else { panic!("a property schema must be an object") };
    if let Some(Value::Array(alternatives)) = property.remove("anyOf") {
        let mut rest = alternatives.into_iter().filter(|alt| alt != &json!({"type": "null"}));
        let (Some(Value::Object(only)), None) = (rest.next(), rest.next()) else {
            panic!("only Option<T> may produce anyOf in a tool's arguments");
        };
        for (key, value) in only {
            property.entry(key).or_insert(value);
        }
    }
    if let Some(Value::String(reference)) = property.remove("$ref") {
        let name = reference.strip_prefix("#/$defs/").expect("refs point into $defs");
        let Some(Value::Object(def)) = defs.get(name) else { panic!("$defs has no {name}") };
        for (key, value) in def {
            if key != "description" && key != "title" {
                property.entry(key.clone()).or_insert(value.clone());
            }
        }
    }
    if let Some(Value::Array(types)) = property.get("type") {
        let types: Vec<&Value> = types.iter().filter(|t| *t != "null").collect();
        let [only] = types[..] else { panic!("a property must have one type besides null") };
        property.insert("type".into(), only.clone());
    }
    if let Some(Value::Array(values)) = property.get_mut("enum") {
        values.retain(|value| !value.is_null());
    }
    // A whole-number f64 default (`50.0`) is written as JSON.stringify writes it (`50`).
    if let Some(Value::Number(n)) = property.get("default") {
        if let Some(x) = n.as_f64().filter(|x| n.is_f64() && x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0) {
            property.insert("default".into(), Value::from(x as i64));
        }
    }
    property.remove("format");
    assert_ne!(property.get("type"), Some(&json!("integer")), "use f64 for numbers: zod's z.number() accepts 2.5");
    Value::Object(property)
}

/// Parse a tool's arguments at the boundary (ADR-0019). As in `parseArgs`: unknown fields are
/// ignored and nothing is coerced (`"5"` is not `5`). `null` means absent because this drops
/// every `null` before serde sees it, so a defaulted non-`Option` field (`#[serde(default)]
/// bool`) takes its default for `null` too. serde alone would reject that `null`: keep the
/// filter in every tool.
pub fn parse_args<T: DeserializeOwned>(arguments: Option<JsonObject>) -> Result<T, String> {
    let present: JsonObject = arguments.unwrap_or_default().into_iter().filter(|(_, v)| !v.is_null()).collect();
    serde_json::from_value(Value::Object(present)).map_err(|error| format!("Invalid parameter: {error}"))
}

pub fn tools() -> Vec<Tool> {
    vec![
        Tool::new(PING_TOOL, PING_DESCRIPTION, input_schema::<PingArgs>())
            .with_title("Spike Ping")
            .with_annotations(read_only_annotations("Spike Ping")),
    ]
}

/// A tool result: one text block holding minified JSON (ADR-0009).
fn json_result(value: &Value) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(value.to_string())])
}

/// A failed call, as `{"error": message}` with `isError`, the TypeScript server's shape.
fn error_result(message: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(json!({ "error": message }).to_string())])
}

#[derive(Clone)]
pub struct LogseqServer {
    client: Arc<LogseqClient>,
}

impl LogseqServer {
    pub fn new(client: LogseqClient) -> Self {
        LogseqServer { client: Arc::new(client) }
    }

    async fn ping(&self, _args: PingArgs) -> Result<Value, LogseqError> {
        // The answer names the open graph; it isn't returned (BR-0001), only that one came.
        self.client.call_api("logseq.App.getCurrentGraph", &[]).await?;
        Ok(json!({ "connected": true }))
    }

    async fn dispatch(&self, request: CallToolRequestParams) -> CallToolResult {
        match request.name.as_ref() {
            PING_TOOL => match parse_args::<PingArgs>(request.arguments) {
                Ok(args) => match self.ping(args).await {
                    Ok(value) => json_result(&value),
                    Err(error) => error_result(&error.to_string()),
                },
                Err(message) => error_result(&message),
            },
            other => error_result(&format!("Unknown tool: {other}")),
        }
    }
}

impl ServerHandler for LogseqServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(SERVER_NAME, SERVER_VERSION.as_str()))
            .with_instructions(SERVER_INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(tools()))
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
    use rmcp::ServiceExt;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    /// `format` as the TypeScript tools take it. The doc comment is the type's, not the property's.
    #[derive(Debug, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "lowercase")]
    enum Format {
        Json,
        Markdown,
    }

    fn default_max_nodes() -> f64 {
        50.0
    }

    /// One field of each kind the TypeScript tools take, modelled on the ADR-0016 snapshot
    /// (`logseq_get_page`, `logseq_list_pages`, `logseq_get_concept_network`).
    #[derive(Debug, Deserialize, JsonSchema, PartialEq)]
    struct SampleArgs {
        /// The page to read.
        page_name: String,
        /// Include child blocks
        #[serde(default)]
        include_children: bool,
        /// json (default), or markdown text
        format: Option<Format>,
        /// Most names to return
        limit: Option<f64>,
        /// Maximum pages in the network (default: 50, max: 500)
        #[serde(default = "default_max_nodes")]
        max_nodes: f64,
    }

    #[test]
    fn the_stub_schema_is_an_empty_object_with_required() {
        assert_eq!(Value::Object((*input_schema::<PingArgs>()).clone()), json!({"type": "object", "properties": {}, "required": []}));
    }

    #[test]
    fn the_schema_comes_from_the_type_that_parses_the_arguments_in_zod_s_shape() {
        // Each property is what the TypeScript snapshot has for a field of that kind.
        assert_eq!(
            Value::Object((*input_schema::<SampleArgs>()).clone()),
            json!({
                "type": "object",
                "properties": {
                    "page_name": {"type": "string", "description": "The page to read."},
                    "include_children": {"type": "boolean", "default": false, "description": "Include child blocks"},
                    "format": {"type": "string", "enum": ["json", "markdown"], "description": "json (default), or markdown text"},
                    "limit": {"type": "number", "description": "Most names to return"},
                    "max_nodes": {"type": "number", "default": 50, "description": "Maximum pages in the network (default: 50, max: 500)"},
                },
                "required": ["page_name"],
            })
        );
    }

    #[test]
    fn an_integral_default_is_written_as_json_stringify_writes_it() {
        // serde_json writes 50.0_f64 as `50.0`; JSON.stringify writes `50`.
        let schema = input_schema::<SampleArgs>();
        assert_eq!(serde_json::to_string(&schema["properties"]["max_nodes"]["default"]).unwrap(), "50");
    }

    #[derive(Deserialize, JsonSchema)]
    #[allow(dead_code)]
    struct IntegerArgs {
        max_depth: Option<u32>,
    }

    #[test]
    #[should_panic(expected = "use f64 for numbers")]
    fn an_integer_field_is_refused_as_zod_accepts_fractions() {
        input_schema::<IntegerArgs>();
    }

    fn args(value: Value) -> Option<JsonObject> {
        value.as_object().cloned()
    }

    #[test]
    fn parsing_ignores_unknown_fields_treats_null_as_absent_and_never_coerces() {
        let parsed: SampleArgs = parse_args(args(json!({
            "page_name": "my page", "limit": null, "include_children": null, "max_nodes": null, "format": "markdown", "extra": 1
        })))
        .unwrap();
        assert_eq!(
            parsed,
            SampleArgs {
                page_name: "my page".into(),
                include_children: false,
                format: Some(Format::Markdown),
                limit: None,
                max_nodes: 50.0
            }
        );
        // zod's z.number() takes a fraction; the tool clamps or floors it.
        let parsed: SampleArgs = parse_args(args(json!({"page_name": "x", "max_nodes": 2.5}))).unwrap();
        assert_eq!(parsed.max_nodes, 2.5);
        assert!(parse_args::<SampleArgs>(args(json!({"page_name": "x", "limit": "5"}))).is_err());
        assert!(parse_args::<SampleArgs>(args(json!({"page_name": "x", "include_children": "true"}))).is_err());
        assert!(parse_args::<SampleArgs>(args(json!({"page_name": "x", "format": "html"}))).is_err());
        assert!(parse_args::<SampleArgs>(args(json!({"page_name": null}))).unwrap_err().contains("page_name"));
        assert!(parse_args::<SampleArgs>(None).is_err());
        assert!(parse_args::<PingArgs>(None).is_ok());
        // Without the null filter serde rejects a null for a defaulted bool: the filter does that work.
        assert!(serde_json::from_value::<SampleArgs>(json!({"page_name": "x", "include_children": null})).is_err());
    }

    #[test]
    fn results_keep_key_order_as_json_stringify_does() {
        // A pulled LogSeq entity is passed through as it came; sorting its keys would break
        // byte-for-byte parity with the TypeScript server (ADR-0025 Decision 2).
        let entity: Value = serde_json::from_str(r#"{"uuid":"u","content":"c","id":1}"#).unwrap();
        let result = json_result(&json!({"warnings": [], "block": entity}));
        assert_eq!(
            serde_json::to_value(&result.content[0]).unwrap()["text"],
            r#"{"warnings":[],"block":{"uuid":"u","content":"c","id":1}}"#
        );
    }

    #[test]
    fn the_stub_is_read_only() {
        let [tool] = tools().try_into().unwrap();
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Spike Ping", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }

    #[test]
    fn the_version_is_package_json_s() {
        assert!(SERVER_VERSION.split('.').count() == 3, "{}", *SERVER_VERSION);
    }

    /// Runs the server over an in-memory pipe and sends it raw JSON-RPC lines, so the test sees
    /// what a client sees on stdio. The API URL points at a closed port: nothing reaches LogSeq.
    async fn exchange(requests: &[Value]) -> Vec<Value> {
        let client = LogseqClient::new(&Config {
            api_url: "http://127.0.0.1:9".into(),
            auth_token: "unused".into(),
            timeout_ms: Some(2000.0),
            tips: None,
        });
        let (server_io, client_io) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server_io);
        let running = tokio::spawn(async move {
            let service = LogseqServer::new(client).serve((server_read, server_write)).await.unwrap();
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
        let responses = exchange(&[initialize()]).await;
        let result = &responses[0]["result"];
        assert_eq!(result["serverInfo"]["name"], SERVER_NAME);
        assert_eq!(result["serverInfo"]["version"], SERVER_VERSION.as_str());
        assert_eq!(result["instructions"], SERVER_INSTRUCTIONS);
        assert_eq!(result["protocolVersion"], "2025-06-18");
        assert!(result["capabilities"]["tools"].is_object());
    }

    #[tokio::test]
    async fn tools_list_returns_the_one_stub_tool() {
        let responses = exchange(&[
            initialize(),
            serde_json::from_str(INITIALIZED).unwrap(),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        ])
        .await;
        let tools = responses[1]["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], PING_TOOL);
        assert_eq!(tools[0]["inputSchema"], json!({"type": "object", "properties": {}, "required": []}));
        assert_eq!(tools[0]["annotations"]["readOnlyHint"], true);
    }

    #[tokio::test]
    async fn a_failed_call_is_an_error_result_not_a_protocol_error() {
        let responses = exchange(&[
            initialize(),
            serde_json::from_str(INITIALIZED).unwrap(),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": PING_TOOL, "arguments": {}}}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "logseq_nope", "arguments": {}}}),
        ])
        .await;
        let ping = &responses[1]["result"];
        assert_eq!(ping["isError"], true);
        let text: Value = serde_json::from_str(ping["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(text["error"].as_str().unwrap().starts_with("Cannot connect to LogSeq at http://127.0.0.1:9"), "{text}");
        let unknown = &responses[2]["result"];
        assert_eq!(unknown["isError"], true);
        assert_eq!(unknown["content"][0]["text"], r#"{"error":"Unknown tool: logseq_nope"}"#);
    }
}
