//! The tools, one directory each. A tool's directory holds its entry points (`NAME`,
//! `definition`, `call`) and everything only it uses: its queries, the LogSeq answers it reads,
//! its tips and its tests. What several tools share is outside `tools/`: the client, the page
//! resolver, `ResultMeta`, the errors and the helpers in `tool.rs`. This file registers them.

use rmcp::model::{CallToolResult, JsonObject, Tool};

use crate::client::LogseqClient;
use crate::dates::Clock;
use crate::errors::ToolError;

pub mod check_links;
pub mod explore_context;
pub mod find_blocks;
pub mod find_pages;
pub mod get_backlinks;
pub mod get_block;
pub mod get_concept_evolution;
pub mod get_concept_network;
pub mod get_current;
pub mod get_graph;
pub mod get_page;
pub mod query_by_date_range;
pub mod search_by_relationship;

/// Every tool, as `tools/list` shows them.
pub fn list() -> Vec<Tool> {
    vec![
        check_links::definition(),
        explore_context::definition(),
        find_blocks::definition(),
        find_pages::definition(),
        get_backlinks::definition(),
        get_block::definition(),
        get_concept_evolution::definition(),
        get_concept_network::definition(),
        get_current::definition(),
        get_graph::definition(),
        get_page::definition(),
        query_by_date_range::definition(),
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
        check_links::NAME => Some(check_links::call(client, tips_enabled, arguments).await),
        explore_context::NAME => Some(explore_context::call(client, tips_enabled, arguments).await),
        find_blocks::NAME => Some(find_blocks::call(client, tips_enabled, clock, arguments).await),
        find_pages::NAME => Some(find_pages::call(client, tips_enabled, arguments).await),
        get_backlinks::NAME => Some(get_backlinks::call(client, tips_enabled, arguments).await),
        get_block::NAME => Some(get_block::call(client, tips_enabled, arguments).await),
        get_concept_evolution::NAME => Some(get_concept_evolution::call(client, tips_enabled, arguments).await),
        get_concept_network::NAME => Some(get_concept_network::call(client, tips_enabled, arguments).await),
        get_current::NAME => Some(get_current::call(client, tips_enabled, arguments).await),
        get_graph::NAME => Some(get_graph::call(client, tips_enabled, arguments).await),
        get_page::NAME => Some(get_page::call(client, tips_enabled, arguments).await),
        query_by_date_range::NAME => Some(query_by_date_range::call(client, tips_enabled, clock, arguments).await),
        search_by_relationship::NAME => Some(search_by_relationship::call(client, tips_enabled, arguments).await),
        _ => None,
    }
}
