//! The tools, one directory each. A tool's directory holds its entry points (`NAME`,
//! `definition`, `call`) and everything only it uses: its queries, the LogSeq answers it reads,
//! its tips and its tests. What several tools share is outside `tools/`: the client, the page
//! resolver, `ResultMeta`, the errors and the helpers in `tool.rs`. This file registers them.

use rmcp::model::{CallToolResult, JsonObject, Tool};

use crate::client::LogseqClient;
use crate::errors::ToolError;

pub mod get_backlinks;
pub mod get_current_context;
pub mod get_graph_info;
pub mod get_page_outline;
pub mod list_pages;
pub mod query_by_property;
pub mod search_blocks;

/// Every tool, as `tools/list` shows them.
pub fn list() -> Vec<Tool> {
    vec![
        get_backlinks::definition(),
        get_current_context::definition(),
        get_graph_info::definition(),
        get_page_outline::definition(),
        list_pages::definition(),
        query_by_property::definition(),
        search_blocks::definition(),
    ]
}

/// Run the tool called `name`, or `None` when there is none.
pub async fn call(
    name: &str,
    client: &LogseqClient,
    tips_enabled: bool,
    arguments: Option<JsonObject>,
) -> Option<Result<CallToolResult, ToolError>> {
    match name {
        get_backlinks::NAME => Some(get_backlinks::call(client, tips_enabled, arguments).await),
        get_current_context::NAME => Some(get_current_context::call(client, tips_enabled, arguments).await),
        get_graph_info::NAME => Some(get_graph_info::call(client, tips_enabled, arguments).await),
        get_page_outline::NAME => Some(get_page_outline::call(client, tips_enabled, arguments).await),
        list_pages::NAME => Some(list_pages::call(client, tips_enabled, arguments).await),
        query_by_property::NAME => Some(query_by_property::call(client, tips_enabled, arguments).await),
        search_blocks::NAME => Some(search_blocks::call(client, tips_enabled, arguments).await),
        _ => None,
    }
}
