//! `logseq_get_block`: one block by uuid, optionally
//! with its children, optionally with its `((uuid))` refs and `{{embed}}`s resolved.
//!
//! Calls: 1 (`logseq.Editor.getBlock`), and with `resolve_refs` up to 2 more Datalog queries, one
//! per nesting level, none when the block and its children hold no ref (see `resolve_refs`).
//!
//! The block is the entity LogSeq sent, key order and spelling included (BR-0004); with
//! `resolve_refs` it gains `resolvedContent` and `resolvedRefs` where it holds a ref, and `hasMore`
//! and `warnings` last.
//!
//! With `format: "markdown"` the block and the children fetched are rendered by `crate::markdown`
//! into one text block, with its warnings and `hasMore` in a footer. The calls are the same.

mod wire;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::args::parse_args;
use crate::client::LogseqClient;
use crate::errors::ToolError;
use crate::markdown::{FooterMeta, render_block, with_footer};
use crate::output_format::OutputFormat;
use crate::params::{ParamAliases, resolve_param_aliases};
use crate::resolve_refs::{resolve_block_refs, with_meta};
use crate::tool::{input_schema, read_only_annotations, success_result};

pub const NAME: &str = "logseq_get_block";

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Get one block by UUID, optionally with its children. UUIDs come from other results and from ((uuid)) refs in content.\n\n\
**Can't find:** blocks by text (logseq_search_blocks) or by numeric id. For a whole page use logseq_get_page.";

/// Parameter aliases (BR-0008): not in the schema, so they cost nothing in `tools/list`.
const ALIASES: ParamAliases = &[("block_uuid", &["uuid"])];

/// The block tool's arguments. Unknown fields are ignored, as in every tool (see `input_schema`).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct Args {
    /// UUID of the block to retrieve
    pub block_uuid: String,
    /// Whether to include child blocks
    #[serde(default)]
    pub include_children: bool,
    /// Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2)
    #[serde(default)]
    pub resolve_refs: bool,
    /// json (default), or markdown text. Markdown has block uuids only on search hits and with compact
    pub format: Option<OutputFormat>,
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Get Block")
        .with_annotations(read_only_annotations("Get Block"))
}

/// A call: aliases folded, arguments read, then the block. This tool has no tips.
pub async fn call(client: &LogseqClient, _tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let arguments = resolve_param_aliases(ALIASES, arguments)?;
    let args = parse_args::<Args>(arguments.as_ref())?;
    let block = get_block(client, &args.block_uuid, args.include_children, args.resolve_refs).await?;
    if args.format == Some(OutputFormat::Markdown) {
        return Ok(success_result(vec![ContentBlock::text(with_footer(render_block(&block), &FooterMeta::of_result(&block, &[])))]));
    }
    Ok(success_result(vec![ContentBlock::text(block.to_string())]))
}

/// `BlockNotFoundError`, which shows the uuid as the caller wrote it.
fn not_found(block_uuid: &str) -> ToolError {
    ToolError::Failed(format!(
        "Block not found: \"{block_uuid}\"\n\nTip: Block UUIDs come from search results or page queries. Verify the UUID is correct."
    ))
}

/// A block by uuid, as LogSeq sent it.
///
/// With `include_children` its `children` are blocks, nested; without, LogSeq sends them as
/// unfetched `["uuid", "<id>"]` tuples. With `resolve_refs` the block and its children are
/// annotated and `hasMore` and `warnings` are added (at most 2 extra Datalog queries).
///
/// Fails with a "Block not found" error when LogSeq answers `null`.
pub async fn get_block(client: &LogseqClient, block_uuid: &str, include_children: bool, resolve_refs: bool) -> Result<Value, ToolError> {
    let mut call_args = vec![Value::from(block_uuid)];
    if include_children {
        call_args.push(serde_json::json!({ "includeChildren": true }));
    }
    let answer = client.call_api(wire::METHOD, &call_args).await?;
    let Some(block) = wire::block(&answer)? else { return Err(not_found(block_uuid)) };

    if !resolve_refs {
        return Ok(block);
    }
    let resolved = resolve_block_refs(client, std::slice::from_ref(&block)).await?;
    let annotated = resolved.blocks.into_iter().next().expect("one block in, one block out");
    // `{ ...blocks[0], ...buildResultMeta(warnings) }`: a block is an object, and anything else spreads to nothing
    let fields = match annotated {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    Ok(Value::Object(with_meta(fields, &resolved.warnings)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::testing::{meaning, schema_of};
    use serde_json::json;

    #[test]
    fn the_block_schema_means_what_the_pinned_one_means() {
        // `inputSchema` of logseq_get_block in the ADR-0016 snapshot
        let pinned = json!({
            "type": "object",
            "properties": {
                "block_uuid": {"type": "string", "description": "UUID of the block to retrieve"},
                "include_children": {"type": "boolean", "default": false, "description": "Whether to include child blocks"},
                "resolve_refs": {"type": "boolean", "default": false, "description": "Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2)"},
                "format": {"type": "string", "enum": ["json", "markdown"], "description": "json (default), or markdown text. Markdown has block uuids only on search hits and with compact"},
            },
            "required": ["block_uuid"],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&pinned));
    }

    #[test]
    fn the_block_tool_is_read_only_and_titled_as_pinned() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Get Block"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Get Block", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }

    #[test]
    fn the_arguments_are_read_in_schema_order_and_the_uuid_alias_is_folded() {
        let args = |value: Value| value.as_object().cloned();
        let folded = resolve_param_aliases(ALIASES, args(json!({"uuid": "u1", "include_children": true}))).unwrap();
        let read = parse_args::<Args>(folded.as_ref()).unwrap();
        assert_eq!((read.block_uuid.as_str(), read.include_children, read.resolve_refs), ("u1", true, false));
        // the first bad argument in schema order is the one reported
        let error = parse_args::<Args>(args(json!({"block_uuid": 5, "resolve_refs": "yes"})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'block_uuid': 5"), "{error}");
        let error = parse_args::<Args>(args(json!({"block_uuid": "u", "resolve_refs": "yes", "format": "xml"})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'resolve_refs': \"yes\""), "{error}");
        let error = parse_args::<Args>(args(json!({})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'block_uuid': missing"), "{error}");
    }

    #[test]
    fn every_argument_takes_what_it_says_and_nothing_else() {
        use crate::args::testing::{Takes, sweep};
        let base = json!({"block_uuid": "u1"});
        sweep::<Args>(json!({}), "block_uuid", Takes::Text, true);
        sweep::<Args>(base.clone(), "include_children", Takes::Flag, false);
        sweep::<Args>(base.clone(), "resolve_refs", Takes::Flag, false);
        sweep::<Args>(base, "format", Takes::Words(&["json", "markdown"]), false);
    }

    #[test]
    fn a_missing_block_is_named_as_the_caller_wrote_it() {
        assert_eq!(
            not_found("a \"b\"").to_string(),
            "Block not found: \"a \"b\"\"\n\nTip: Block UUIDs come from search results or page queries. Verify the UUID is correct."
        );
    }
}
