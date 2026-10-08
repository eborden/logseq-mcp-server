//! `logseq_get_page_outline` (the Rust side of `src/tools/get-page-outline.ts`): a page's
//! top-level blocks with a first-line snippet and a child count each, so a model can choose what
//! to read with `logseq_get_block` instead of loading a long page whole.
//!
//! Calls: 2 for an exact name, an alias or an ISO date (the page resolver, then one Datalog query
//! for the blocks). A namespace-leaf name adds the resolver's leaf query; a missing page adds the
//! suggestion lookup before it fails. Never one call per block.
//!
//! This directory holds everything only the outline uses: its query (`queries.rs`), the blocks it
//! reads (`wire.rs`) and its tip (`tips.rs`). What it shares with other tools is outside it: the
//! page resolver, `ResultMeta`, the errors and the tool helpers.

mod queries;
mod tips;
mod wire;

use std::collections::HashMap;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::block_tree::order_siblings;
use crate::client::LogseqClient;
use crate::edn::PageId;
use crate::errors::{MatchedBy, ToolError};
use crate::meta::{ResultMeta, ResultWarning};
use crate::params::{ParamAliases, bad_string_param, resolve_param_aliases};
use crate::resolve::require_page;
use crate::snippet::Snippet;
use crate::tips::tips_content;
use crate::tool::{input_schema, parse_args, read_only_annotations, success_result};

use self::tips::{TipBlock, outline_tips};
use self::wire::OutlineBlock;

pub const NAME: &str = "logseq_get_page_outline";

/// The description the TypeScript server gives the tool (`src/tool-descriptions.ts`).
const DESCRIPTION: &str = "List a page's top-level blocks: uuid, the first line (80 characters) and the number of children. Cheaper than logseq_get_page for a long page.\n\n\
**Use when:** you need a page's shape before reading parts of it. Read the blocks you pick with logseq_get_block.\n\
**Can't find:** nested blocks below the first level, or block text past the first line (logseq_get_block, logseq_get_page).";

/// Parameter aliases (BR-0008): not in the schema, so they cost nothing in `tools/list`.
const ALIASES: ParamAliases = &[("page_name", &["name", "page"])];

/// The outline's arguments. Unknown fields are ignored, as every TypeScript tool ignores them.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct Args {
    /// Page name, alias, or ISO date (2025-01-01) for a journal
    pub page_name: String,
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Get Page Outline")
        .with_annotations(read_only_annotations("Get Page Outline"))
}

/// A call: aliases folded, arguments parsed, the tool, then its tip.
pub async fn call(client: &LogseqClient, tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let arguments = resolve_param_aliases(ALIASES, arguments)?;
    let args = parse_args::<Args>(arguments.clone())
        .map_err(|_| ToolError::InvalidParameter(bad_string_param("page_name", arguments.as_ref())))?;
    let outline = get_page_outline(client, &args.page_name).await?;
    let mut content = vec![ContentBlock::text(serde_json::to_string(&outline).expect("an outline serializes"))];
    if tips_enabled {
        let blocks: Vec<TipBlock<'_>> =
            outline.blocks.iter().map(|block| TipBlock { uuid: &block.uuid, child_count: block.child_count }).collect();
        if let Some(tips) = tips_content(&outline_tips(&blocks)) {
            content.push(ContentBlock::text(tips));
        }
    }
    Ok(success_result(content))
}

/// Most top-level blocks one outline lists. A page with more is cut, and the result says so.
pub const MAX_OUTLINE_BLOCKS: usize = 200;

/// One top-level block: enough to choose it, not to read it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OutlineEntry {
    /// Pass to `logseq_get_block` to read the block
    pub uuid: String,
    /// First line of the block, cut to 80 characters
    pub snippet: Snippet,
    /// Direct children only, not all descendants
    #[serde(rename = "childCount")]
    pub child_count: usize,
}

/// Says a tool used another page than the one named (`PageResolvedFrom`). Absent for an exact match.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResolvedFrom {
    /// The name the caller passed
    pub name: String,
    #[serde(rename = "matchedBy")]
    pub matched_by: &'static str,
    /// Original-case name of the page that was used
    #[serde(rename = "resolvedTo")]
    pub resolved_to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageOutline {
    /// The page's name in its original casing
    pub page: String,
    #[serde(rename = "resolvedFrom", skip_serializing_if = "Option::is_none")]
    pub resolved_from: Option<ResolvedFrom>,
    /// Top-level blocks in page order; empty for a page with no blocks
    pub blocks: Vec<OutlineEntry>,
    #[serde(flatten)]
    pub meta: ResultMeta,
}

/// A top-level block on its way to being ordered.
struct Top<'a> {
    id: i64,
    /// The `id` of the block's `:block/left`
    left: Option<i64>,
    block: &'a OutlineBlock,
}

/// The outline of the blocks the query pulled for `page_id`.
///
/// Top-level blocks hang off the page; every other row is a child of one of them. A `null` cell
/// is skipped, and so is a row with no parent: it is neither a top-level block nor a child.
fn outline_of(page_id: i64, rows: &[Option<OutlineBlock>]) -> (Vec<OutlineEntry>, Vec<ResultWarning>, usize) {
    let mut top: Vec<Top<'_>> = Vec::new();
    let mut child_count: HashMap<i64, usize> = HashMap::new();
    for block in rows.iter().flatten() {
        // PARITY(#299): a parent counts by its `id` only, while a block's own id reads `id` then `db/id`
        // (suspected TS inconsistency) — drop if Rust becomes the only server.
        let Some(parent_id) = block.parent.and_then(self::wire::Parent::id) else { continue };
        if parent_id == page_id {
            top.push(Top { id: block.entity_id().unwrap_or(0), left: block.left_id, block });
        } else {
            *child_count.entry(parent_id).or_insert(0) += 1;
        }
    }

    let ordered = order_siblings(top, |top| top.id, |top| top.left);
    let total = ordered.len();
    let shown = &ordered[..total.min(MAX_OUTLINE_BLOCKS)];

    let mut warnings = Vec::new();
    if total > shown.len() {
        warnings.push(ResultWarning::new(
            "outline_truncated",
            format!(
                "Showing the first {} of {} top-level blocks. \
                 The outline has no way to page; read the rest with logseq_get_page and include_children.",
                shown.len(),
                total
            ),
        ));
    }
    let blocks = shown
        .iter()
        .map(|top| OutlineEntry {
            uuid: top.block.uuid.clone(),
            snippet: Snippet::of(top.block.content.as_deref()),
            child_count: child_count.get(&top.id).copied().unwrap_or(0),
        })
        .collect();
    (blocks, warnings, total)
}

/// A page's outline.
///
/// `page_name` is a page name, an alias, or an ISO date (`2025-01-01`) of a journal. When it was
/// an alias, a date or a namespace leaf rather than an exact name, `resolvedFrom` says so.
///
/// Fails with [`ToolError::PageNotFound`] (guidance with the closest names) if no page matches,
/// and [`ToolError::AmbiguousPage`] (with the candidates) if several do.
pub async fn get_page_outline(client: &LogseqClient, page_name: &str) -> Result<PageOutline, ToolError> {
    let resolved = require_page(client, page_name).await?;
    // The resolver pulls the page by :db/id, so it always has one (a page without it can't be queried)
    let raw_id = resolved.page.entity_id().ok_or(ToolError::PageWithoutId)?;
    let page_id = PageId::new(raw_id)?;

    let query = self::queries::page_outline_blocks(page_id);
    let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
    // PARITY(#299): a `null` answer becomes an empty outline with no warning, where BR-0011 asks for
    // one that says the data was unavailable (suspected TS bug) — fix per #300, in both servers.
    let rows = wire::outline_rows(&answer)?.unwrap_or_default();

    let (blocks, warnings, total) = outline_of(raw_id, &rows);
    let resolved_from = (resolved.matched_by != MatchedBy::Name).then(|| ResolvedFrom {
        name: page_name.to_owned(),
        matched_by: resolved.matched_by.as_str(),
        resolved_to: resolved.original_name.clone(),
    });
    Ok(PageOutline {
        page: resolved.original_name,
        resolved_from,
        blocks,
        meta: ResultMeta::new(warnings, &[("blocks", total)]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn rows(blocks: Vec<Value>) -> Vec<Option<OutlineBlock>> {
        let answer = Value::Array(blocks.into_iter().map(|b| json!([b])).collect());
        wire::outline_rows(&answer).unwrap().unwrap()
    }

    fn block(id: i64, parent: Option<i64>, left: i64, content: &str) -> Value {
        let mut block = json!({"id": id, "uuid": format!("u{id}"), "content": content, "left": {"id": left}});
        if let Some(parent) = parent {
            block["parent"] = json!({"id": parent});
        }
        block
    }

    fn uuids(outline: &[OutlineEntry]) -> Vec<&str> {
        outline.iter().map(|entry| entry.uuid.as_str()).collect()
    }

    #[test]
    fn blocks_come_in_the_order_of_the_left_chain_and_children_are_counted() {
        let rows = rows(vec![
            block(103, Some(10), 102, "c"),
            block(201, Some(101), 101, "child"),
            block(101, Some(10), 10, "a"),
            block(202, Some(101), 201, "child"),
            block(102, Some(10), 101, "b"),
        ]);
        let (blocks, warnings, total) = outline_of(10, &rows);
        assert_eq!(uuids(&blocks), ["u101", "u102", "u103"]);
        assert_eq!(blocks.iter().map(|b| b.child_count).collect::<Vec<_>>(), [2, 0, 0]);
        assert!(warnings.is_empty());
        assert_eq!(total, 3);
    }

    #[test]
    fn a_chain_that_is_broken_or_cyclic_loses_no_block() {
        // 411 and 412 point at each other and 413 at a block that isn't there: the chain from 413
        // comes first, then the blocks no chain reached, by id
        let rows = rows(vec![
            block(411, Some(41), 412, "one"),
            block(412, Some(41), 411, "two"),
            block(414, Some(41), 413, "after"),
            block(413, Some(41), 999, "orphan"),
        ]);
        let (blocks, _, _) = outline_of(41, &rows);
        assert_eq!(uuids(&blocks), ["u413", "u414", "u411", "u412"]);
    }

    #[test]
    fn two_siblings_with_one_left_keep_the_first_listed_in_the_chain() {
        let rows = rows(vec![block(2, Some(1), 1, "first"), block(3, Some(1), 1, "second")]);
        // both are heads (their left, the page, is no sibling), ordered by id
        let (blocks, _, _) = outline_of(1, &rows);
        assert_eq!(uuids(&blocks), ["u2", "u3"]);
        let chained = self::rows(vec![block(5, Some(1), 4, "a"), block(6, Some(1), 5, "b"), block(7, Some(1), 5, "c"), block(4, Some(1), 1, "head")]);
        let (blocks, _, _) = outline_of(1, &chained);
        // 6 was listed before 7, so it follows 5; 7, which no chain reached, comes last
        assert_eq!(uuids(&blocks), ["u4", "u5", "u6", "u7"]);
    }

    #[test]
    fn a_null_cell_and_a_row_without_a_parent_are_skipped() {
        let answer = json!([
            [null],
            [block(401, Some(40), 40, "kept")],
            [block(402, None, 401, "no parent")],
            [block(403, Some(401), 401, "child")]
        ]);
        let rows = wire::outline_rows(&answer).unwrap().unwrap();
        let (blocks, _, total) = outline_of(40, &rows);
        assert_eq!((uuids(&blocks), blocks[0].child_count, total), (vec!["u401"], 1, 1));
    }

    #[test]
    fn a_parent_can_be_a_bare_number() {
        let mut child = block(203, None, 103, "child");
        child["parent"] = json!(103);
        let rows = rows(vec![block(103, Some(10), 10, "top"), child]);
        let (blocks, _, _) = outline_of(10, &rows);
        assert_eq!(blocks[0].child_count, 1);
    }

    #[test]
    fn more_than_the_cap_is_cut_and_said_so_without_a_way_to_fetch_the_rest() {
        let many: Vec<Value> = (0..201).map(|i| block(1000 + i, Some(50), if i == 0 { 50 } else { 1000 + i - 1 }, "entry")).collect();
        let (blocks, warnings, total) = outline_of(50, &rows(many));
        assert_eq!((blocks.len(), total), (200, 201));
        assert_eq!(blocks[199].uuid, "u1199");
        let meta = ResultMeta::new(warnings, &[("blocks", total)]);
        assert!(!meta.has_more);
        assert_eq!(meta.warnings[0].code, "outline_truncated");
        assert_eq!(
            meta.warnings[0].message,
            "Showing the first 200 of 201 top-level blocks. The outline has no way to page; read the rest with logseq_get_page and include_children."
        );
    }

    #[test]
    fn a_page_with_no_blocks_is_an_empty_outline() {
        let (blocks, warnings, total) = outline_of(10, &[]);
        assert!(blocks.is_empty() && warnings.is_empty());
        assert_eq!(total, 0);
    }

    #[test]
    fn the_outline_schema_means_what_the_typescript_one_means() {
        use crate::tool::testing::{meaning, schema_of};
        // `inputSchema` of logseq_get_page_outline in the ADR-0016 snapshot
        let typescript = json!({
            "type": "object",
            "properties": {"page_name": {"type": "string", "description": "Page name, alias, or ISO date (2025-01-01) for a journal"}},
            "required": ["page_name"],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&typescript));
    }

    #[test]
    fn the_outline_tool_is_read_only_and_titled_as_in_typescript() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Get Page Outline"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Get Page Outline", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }

    #[test]
    fn the_outline_serializes_in_the_order_the_typescript_server_writes_it() {
        let outline = PageOutline {
            page: "Project Atlas".into(),
            resolved_from: Some(ResolvedFrom { name: "atlas".into(), matched_by: "alias", resolved_to: "Project Atlas".into() }),
            blocks: vec![OutlineEntry { uuid: "u1".into(), snippet: Snippet::of(Some("Hi")), child_count: 2 }],
            meta: ResultMeta::new(vec![], &[("blocks", 1)]),
        };
        assert_eq!(
            serde_json::to_string(&outline).unwrap(),
            r#"{"page":"Project Atlas","resolvedFrom":{"name":"atlas","matchedBy":"alias","resolvedTo":"Project Atlas"},"blocks":[{"uuid":"u1","snippet":"Hi","childCount":2}],"hasMore":false,"warnings":[],"totals":{"blocks":1}}"#
        );
    }
}
