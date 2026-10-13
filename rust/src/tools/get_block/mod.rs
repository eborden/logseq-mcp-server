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
//!
//! With `include_children` the subtree has no count cap, so [`call`] cuts it to the character budget (#507, #485): the
//! block, then its descendants in document order, until the text it sends is at most `BUDGET_CHARS`. A block is never
//! cut inside its text (BR-0007), and a kept block that lost children says so with `childrenTruncated`. No parameter
//! pages a subtree, so the `result_size_truncated` warning has no `howToFetchAll`. A block read without its children is
//! one entity and is never cut.

mod wire;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::args::parse_args;
use crate::block_budget::{Budget, count_blocks, take_blocks};
use crate::budget::{Fit, fit, size};
use crate::client::LogseqClient;
use crate::errors::ToolError;
use crate::markdown::{FooterMeta, render_block, with_footer};
use crate::output_format::OutputFormat;
use crate::params::{ParamAliases, resolve_param_aliases};
use crate::resolve_refs::{push_warning, resolve_block_refs, with_meta};
use crate::tool::{input_schema, read_only_annotations, success_result};
use crate::truncation::{SizeCut, size_truncation_warning};

pub const NAME: &str = "logseq_get_block";

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Get one block by UUID, optionally with its children. UUIDs come from other results and from ((uuid)) refs in content.\n\n\
**Can't find:** blocks by text (logseq_find_blocks) or by numeric id. For a whole page use logseq_get_page.";

/// Parameter aliases (BR-0008): not in the schema, so they cost nothing in `tools/list`.
const ALIASES: ParamAliases = &[("uuid", &["block_uuid"])];

/// The block tool's arguments. Unknown fields are ignored, as in every tool (see `input_schema`).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct Args {
    /// UUID of the block to retrieve
    pub uuid: String,
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
    let block = get_block(client, &args.uuid, args.include_children, args.resolve_refs).await?;
    // The text the call sends, which the character budget measures (#507)
    let markdown = args.format == Some(OutputFormat::Markdown);
    let text = |block: &Value| if markdown { with_footer(render_block(block), &FooterMeta::of_result(block, &[])) } else { block.to_string() };
    // Without `include_children` the children are unfetched `["uuid", "<id>"]` tuples, and the result is one block
    let block = if args.include_children { fit_to_budget(block, &text, markdown) } else { block };
    Ok(success_result(vec![ContentBlock::text(text(&block))]))
}

/// The block as it is when its text fits the character budget (#507, #485), else with the first blocks that do: the
/// block itself, then its descendants in document order. A block is never cut inside its text (BR-0007), so a block
/// that is over the budget by itself comes back alone.
fn fit_to_budget(block: Value, text: &impl Fn(&Value) -> String, markdown: bool) -> Value {
    let total = count_blocks(std::slice::from_ref(&block));
    let size_of = |kept: usize| size(&text(&if kept < total { cut_block(&block, kept, total, false, markdown) } else { block.clone() }));
    match fit(total, 1, size_of) {
        Fit::Whole => block,
        Fit::Cut { kept, oversize } => cut_block(&block, kept, total, oversize, markdown),
    }
}

/// The block cut to its first `kept` blocks of `total` (itself and its descendants, in document order), with the
/// `result_size_truncated` warning and `hasMore` worked out again. A kept block that lost children carries
/// `childrenTruncated`. `hasMore` and `warnings` come last when the block had none.
fn cut_block(block: &Value, kept: usize, total: usize, oversize: bool, markdown: bool) -> Value {
    let mut budget = Budget::new(kept);
    let Some(Value::Object(cut)) = take_blocks(std::slice::from_ref(block), &mut budget).into_iter().next() else { return block.clone() };
    // Markdown writes no marker for a block that lost children, so it names none
    let advice = if markdown {
        "The last blocks are left out, and the last blocks kept may have lost some of their children. No parameter raises this limit: \
         find what was left out by its text with logseq_find_blocks."
    } else {
        "The last blocks are left out, and a kept block marked childrenTruncated lost some of its children. No parameter raises this limit: \
         read such a block on its own with logseq_get_block and include_children, which starts from it, or find a block left out by its text with logseq_find_blocks."
    };
    let warning = size_truncation_warning(SizeCut {
        what: "blocks (the block and its descendants, in document order)",
        kept,
        total,
        oversize,
        advice,
        how_to_fetch_all: None,
    });
    Value::Object(push_warning(cut, &warning))
}

/// `BlockNotFoundError`, which shows the uuid as the caller wrote it.
fn not_found(uuid: &str) -> ToolError {
    ToolError::Failed(format!(
        "Block not found: \"{uuid}\"\n\nTip: Block UUIDs come from search results or page queries. Verify the UUID is correct."
    ))
}

/// A block by uuid, as LogSeq sent it.
///
/// With `include_children` its `children` are blocks, nested; without, LogSeq sends them as
/// unfetched `["uuid", "<id>"]` tuples. With `resolve_refs` the block and its children are
/// annotated and `hasMore` and `warnings` are added (at most 2 extra Datalog queries).
///
/// Fails with a "Block not found" error when LogSeq answers `null`.
pub async fn get_block(client: &LogseqClient, uuid: &str, include_children: bool, resolve_refs: bool) -> Result<Value, ToolError> {
    let mut call_args = vec![Value::from(uuid)];
    if include_children {
        call_args.push(serde_json::json!({ "includeChildren": true }));
    }
    let answer = client.call_api(wire::METHOD, &call_args).await?;
    let Some(block) = wire::block(&answer)? else { return Err(not_found(uuid)) };

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
                "uuid": {"type": "string", "description": "UUID of the block to retrieve"},
                "include_children": {"type": "boolean", "default": false, "description": "Whether to include child blocks"},
                "resolve_refs": {"type": "boolean", "default": false, "description": "Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2)"},
                "format": {"type": "string", "enum": ["json", "markdown"], "description": "json (default), or markdown text. Markdown has block uuids only on search hits and with compact"},
            },
            "required": ["uuid"],
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
    fn the_arguments_are_read_in_schema_order_and_the_block_uuid_alias_is_folded() {
        let args = |value: Value| value.as_object().cloned();
        let folded = resolve_param_aliases(ALIASES, args(json!({"block_uuid": "u1", "include_children": true}))).unwrap();
        let read = parse_args::<Args>(folded.as_ref()).unwrap();
        assert_eq!((read.uuid.as_str(), read.include_children, read.resolve_refs), ("u1", true, false));
        // the first bad argument in schema order is the one reported
        let error = parse_args::<Args>(args(json!({"uuid": 5, "resolve_refs": "yes"})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'uuid': 5"), "{error}");
        let error = parse_args::<Args>(args(json!({"uuid": "u", "resolve_refs": "yes", "format": "xml"})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'resolve_refs': \"yes\""), "{error}");
        let error = parse_args::<Args>(args(json!({})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'uuid': missing"), "{error}");
    }

    #[test]
    fn every_argument_takes_what_it_says_and_nothing_else() {
        use crate::args::testing::{Takes, sweep};
        let base = json!({"uuid": "u1"});
        sweep::<Args>(json!({}), "uuid", Takes::Text, true);
        sweep::<Args>(base.clone(), "include_children", Takes::Flag, false);
        sweep::<Args>(base.clone(), "resolve_refs", Takes::Flag, false);
        sweep::<Args>(base, "format", Takes::Words(&["json", "markdown"]), false);
    }

    /// A block with `children` children of `length` characters each, and one grandchild under the first.
    fn tree(children: usize, length: usize) -> Value {
        let child = |n: usize| {
            let grand: Vec<Value> = if n == 0 { vec![json!({"uuid": "g", "content": "z".repeat(length), "children": []})] } else { Vec::new() };
            json!({"uuid": format!("c{n}"), "content": "y".repeat(length), "children": grand})
        };
        json!({"id": 1, "uuid": "root", "content": "root", "children": (0..children).map(child).collect::<Vec<_>>()})
    }

    fn json_text(block: &Value) -> String {
        block.to_string()
    }

    #[test]
    fn a_subtree_under_the_budget_is_untouched_and_a_lone_block_is_never_cut() {
        let small = tree(5, 100);
        assert_eq!(fit_to_budget(small.clone(), &json_text, false), small);
        let lone = json!({"id": 1, "uuid": "root", "content": "x".repeat(40_000), "children": []});
        assert_eq!(fit_to_budget(lone.clone(), &json_text, false), lone);
        // a block whose children are unfetched tuples is one block too
        let tuples = json!({"id": 1, "uuid": "root", "content": "x", "children": [["uuid", "a"], ["uuid", "b"]]});
        assert_eq!(fit_to_budget(tuples.clone(), &json_text, false), tuples);
    }

    #[test]
    fn a_subtree_over_the_budget_keeps_the_first_blocks_in_document_order_and_marks_what_lost_children() {
        let big = tree(40, 1000);
        let cut = fit_to_budget(big.clone(), &json_text, false);
        assert!(size(&cut.to_string()) <= crate::budget::BUDGET_CHARS);
        // the root is kept, with its first children (and the grandchild under the first)
        assert_eq!(cut["uuid"], "root");
        let kept = count_blocks(std::slice::from_ref(&cut));
        assert!(kept > 5 && kept < 42, "{kept}");
        assert_eq!(cut["children"][0], big["children"][0]);
        assert_eq!(cut["childrenTruncated"], true);
        assert!(size(&cut_block(&big, kept + 1, 42, false, false).to_string()) > crate::budget::BUDGET_CHARS);
        let warning = &cut["warnings"][0];
        assert_eq!(warning["code"], "result_size_truncated");
        assert!(warning["message"].as_str().unwrap().starts_with(&format!("Showing {kept} of 42 blocks (the block and its descendants, in document order)")));
        assert_eq!(cut["hasMore"], false);
        assert!(warning.get("howToFetchAll").is_none());
        let keys: Vec<&String> = cut.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["id", "uuid", "content", "children", "childrenTruncated", "hasMore", "warnings"]);
    }

    #[test]
    fn a_root_over_the_budget_is_kept_alone_with_its_children_dropped_and_the_warning_says_so() {
        let mut big = tree(3, 10);
        big["content"] = json!("x".repeat(40_000));
        let cut = fit_to_budget(big, &json_text, false);
        assert_eq!(cut["children"], json!([]));
        assert!(cut["warnings"][0]["message"].as_str().unwrap().contains("Even those are over that size"));
    }

    #[test]
    fn a_missing_block_is_named_as_the_caller_wrote_it() {
        assert_eq!(
            not_found("a \"b\"").to_string(),
            "Block not found: \"a \"b\"\"\n\nTip: Block UUIDs come from search results or page queries. Verify the UUID is correct."
        );
    }
}
