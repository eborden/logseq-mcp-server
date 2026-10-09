//! `logseq_get_graph_info`: which graph LogSeq has
//! open, as it says so itself.
//!
//! Calls: 1 (`logseq.App.getCurrentGraph`). The answer is the result as it came, so a key LogSeq
//! adds shows up. `null` is not a graph (BR-0011): it is an error, not an empty result.

mod wire;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::client::LogseqClient;
use crate::errors::ToolError;
use crate::tool::{input_schema, read_only_annotations, success_result};

pub const NAME: &str = "logseq_get_graph_info";

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Get the connected graph's name and filesystem path.\n\n\
**Use when:** confirming which graph is attached or debugging paths.\n\
**Can't find:** anything about content. See logseq_list_pages and logseq_build_context.";

/// The tool takes no arguments, and whatever is sent is ignored.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct Args {}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Get Graph Info")
        .with_annotations(read_only_annotations("Get Graph Info"))
}

/// A call: the graph LogSeq reports, as JSON.
pub async fn call(client: &LogseqClient, _tips_enabled: bool, _arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let graph = get_graph_info(client).await?;
    Ok(success_result(vec![ContentBlock::text(graph.to_string())]))
}

/// The open graph: `url`, `name` and `path`, as LogSeq answers them.
///
/// Fails with [`ToolError::Failed`] when LogSeq answers `null`, which is no graph open rather than
/// a graph with no fields.
pub async fn get_graph_info(client: &LogseqClient) -> Result<serde_json::Value, ToolError> {
    let answer = client.call_api(wire::METHOD, &[]).await?;
    match wire::graph_info(&answer)? {
        Some(graph) => Ok(graph.clone()),
        None => Err(ToolError::Failed("Failed to retrieve graph information".to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::testing::{meaning, schema_of};
    use serde_json::json;

    #[test]
    fn the_schema_is_an_empty_object_as_pinned() {
        let pinned = json!({"type": "object", "properties": {}, "required": []});
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&pinned));
    }

    #[test]
    fn the_tool_is_read_only_and_titled_as_pinned() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Get Graph Info"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Get Graph Info", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }
}
