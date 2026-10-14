//! The tools, one directory each. A tool's directory holds its entry points (`NAME`,
//! `definition`, `call`) and everything only it uses: its queries, the LogSeq answers it reads,
//! its tips and its tests. What several tools share is outside `tools/`: the client, the page
//! resolver, `ResultMeta`, the errors and the helpers in `tool.rs`. This file registers them.

use rmcp::model::{CallToolResult, JsonObject, Tool};

use crate::client::LogseqClient;
use crate::dates::Clock;
use crate::errors::ToolError;
use crate::snapshots::Snapshots;

pub mod check_links;
pub mod explore_context;
pub mod explore_network;
pub mod explore_timeline;
pub mod find_blocks;
pub mod find_pages;
pub mod get_block;
pub mod get_current;
pub mod get_graph;
pub mod get_page;

/// Every tool, as `tools/list` shows them.
pub fn list() -> Vec<Tool> {
    vec![
        check_links::definition(),
        explore_context::definition(),
        explore_network::definition(),
        explore_timeline::definition(),
        find_blocks::definition(),
        find_pages::definition(),
        get_block::definition(),
        get_current::definition(),
        get_graph::definition(),
        get_page::definition(),
    ]
}

/// Run the tool called `name`, or `None` when there is none.
pub async fn call(
    name: &str,
    client: &LogseqClient,
    tips_enabled: bool,
    clock: Clock,
    snapshots: &Snapshots,
    arguments: Option<JsonObject>,
) -> Option<Result<CallToolResult, ToolError>> {
    match name {
        check_links::NAME => Some(check_links::call(client, tips_enabled, arguments).await),
        explore_context::NAME => Some(explore_context::call(client, tips_enabled, snapshots, arguments).await),
        explore_network::NAME => Some(explore_network::call(client, tips_enabled, arguments).await),
        explore_timeline::NAME => Some(explore_timeline::call(client, tips_enabled, clock, arguments).await),
        find_blocks::NAME => Some(find_blocks::call(client, tips_enabled, clock, snapshots, arguments).await),
        find_pages::NAME => Some(find_pages::call(client, tips_enabled, snapshots, arguments).await),
        get_block::NAME => Some(get_block::call(client, tips_enabled, snapshots, arguments).await),
        get_current::NAME => Some(get_current::call(client, tips_enabled, arguments).await),
        get_graph::NAME => Some(get_graph::call(client, tips_enabled, arguments).await),
        get_page::NAME => Some(get_page::call(client, tips_enabled, snapshots, arguments).await),
        _ => None,
    }
}
