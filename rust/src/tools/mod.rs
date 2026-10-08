//! The tools, one directory each. A tool's directory holds its entry points (`NAME`,
//! `definition`, `call`) and everything only it uses: its queries, the LogSeq answers it reads,
//! its tips and its tests. What several tools share is outside `tools/`: the client, the page
//! resolver, `ResultMeta`, the errors and the helpers in `tool.rs`. This file registers them.

use rmcp::model::{CallToolResult, JsonObject, Tool};

use crate::client::LogseqClient;
use crate::dates::Clock;
use crate::errors::ToolError;

pub mod build_context;
pub mod check_links;
pub mod get_backlinks;
pub mod get_block;
pub mod get_context_for_query;
pub mod get_current_context;
pub mod get_graph_info;
pub mod get_page;
pub mod get_page_outline;
pub mod list_pages;
pub mod query_by_date_range;
pub mod query_by_property;
pub mod search_blocks;
pub mod search_by_relationship;

/// Every tool, as `tools/list` shows them.
pub fn list() -> Vec<Tool> {
    vec![
        build_context::definition(),
        check_links::definition(),
        get_backlinks::definition(),
        get_block::definition(),
        get_context_for_query::definition(),
        get_current_context::definition(),
        get_graph_info::definition(),
        get_page::definition(),
        get_page_outline::definition(),
        list_pages::definition(),
        query_by_date_range::definition(),
        query_by_property::definition(),
        search_blocks::definition(),
        search_by_relationship::definition(),
    ]
}

/// Run the tool called `name`, or `None` when there is none.
pub async fn call(
    name: &str,
    client: &LogseqClient,
    tips_enabled: bool,
    clock: Clock,
    arguments: Option<JsonObject>,
) -> Option<Result<CallToolResult, ToolError>> {
    match name {
        build_context::NAME => Some(build_context::call(client, tips_enabled, arguments).await),
        check_links::NAME => Some(check_links::call(client, tips_enabled, arguments).await),
        get_backlinks::NAME => Some(get_backlinks::call(client, tips_enabled, arguments).await),
        get_block::NAME => Some(get_block::call(client, tips_enabled, arguments).await),
        get_context_for_query::NAME => Some(get_context_for_query::call(client, tips_enabled, arguments).await),
        get_current_context::NAME => Some(get_current_context::call(client, tips_enabled, arguments).await),
        get_graph_info::NAME => Some(get_graph_info::call(client, tips_enabled, arguments).await),
        get_page::NAME => Some(get_page::call(client, tips_enabled, arguments).await),
        get_page_outline::NAME => Some(get_page_outline::call(client, tips_enabled, arguments).await),
        list_pages::NAME => Some(list_pages::call(client, tips_enabled, arguments).await),
        query_by_date_range::NAME => Some(query_by_date_range::call(client, tips_enabled, clock, arguments).await),
        query_by_property::NAME => Some(query_by_property::call(client, tips_enabled, arguments).await),
        search_blocks::NAME => Some(search_blocks::call(client, tips_enabled, arguments).await),
        search_by_relationship::NAME => Some(search_by_relationship::call(client, tips_enabled, arguments).await),
        _ => None,
    }
}
