//! The `detail: "outline"` of `logseq_get_page`: a page's top-level blocks with a first-line snippet and a child
//! count each, so a model can choose what to read with `logseq_get_block` instead of loading a long page whole.
//! It was the tool `logseq_get_page_outline` before the v2 rename (ADR-0037, #489), and its result is unchanged.
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

use rmcp::model::{CallToolResult, ContentBlock};
use serde::Serialize;

use crate::block_tree::order_siblings;
use crate::budget::{Fit, fit, size};
use crate::client::LogseqClient;
use crate::edn::PageId;
use crate::errors::{MatchedBy, ToolError};
use crate::meta::{ResultMeta, ResultWarning};
use crate::output_format::ListFormat;
use crate::resolve::require_page;
use crate::snippet::Snippet;
use crate::tips::tips_value;
use crate::tool::{result_value, success_result};
use crate::truncation::{SizeCut, size_truncation_warning};

use self::tips::{TipBlock, outline_tips};
use self::wire::OutlineBlock;

/// The outline of a page as a tool result: the outline, then its tip. `format` is the outline's own (`json`, the
/// default, or `toon`), and the tip is written in the same one.
pub async fn outline_result(
    client: &LogseqClient,
    tips_enabled: bool,
    page: &str,
    format: Option<ListFormat>,
) -> Result<CallToolResult, ToolError> {
    let outline = fit_to_budget(get_page_outline(client, page).await?, tips_enabled, format);
    Ok(success_result(outline_texts(&outline, tips_enabled, format)?.into_iter().map(ContentBlock::text).collect()))
}

/// The text of the content blocks a call sends for `outline`: the outline, then its tip.
fn outline_texts(outline: &PageOutline, tips_enabled: bool, format: Option<ListFormat>) -> Result<Vec<String>, ToolError> {
    let mut texts = vec![ListFormat::text(format, &result_value(outline))?];
    if tips_enabled {
        let blocks: Vec<TipBlock<'_>> =
            outline.blocks.iter().map(|block| TipBlock { uuid: &block.uuid, child_count: block.child_count }).collect();
        if let Some(tips) = tips_value(&outline_tips(&blocks)) {
            texts.push(ListFormat::text(format, &tips)?);
        }
    }
    Ok(texts)
}

/// The outline as it is when the text it sends fits the character budget (#507, #485), else with the first top-level
/// blocks that do. The 200-block cap leaves a long outline of long snippets just over it: each entry is a 36-character
/// uuid and a snippet of up to 80, so 200 of them are about 31,000 characters in JSON. An entry is never cut inside
/// its text (BR-0007). No LogSeq call is made.
fn fit_to_budget(outline: PageOutline, tips_enabled: bool, format: Option<ListFormat>) -> PageOutline {
    let size_of = |kept: usize| -> usize {
        let sent = if kept < outline.blocks.len() { cut_outline(&outline, kept, false) } else { outline.clone() };
        outline_texts(&sent, tips_enabled, format).map_or(0, |texts| texts.iter().map(|text| size(text)).sum())
    };
    match fit(outline.blocks.len(), 1, size_of) {
        Fit::Whole => outline,
        Fit::Cut { kept, oversize } => cut_outline(&outline, kept, oversize),
    }
}

/// The outline cut to its first `kept` top-level blocks, with the `result_size_truncated` warning in place of the
/// `outline_truncated` one, which counted against the 200-block cap and said to read the rest with `detail` `full`.
/// `totals.blocks` is still every top-level block the page has.
fn cut_outline(outline: &PageOutline, kept: usize, oversize: bool) -> PageOutline {
    let total = outline.meta.totals.get("blocks").and_then(serde_json::Value::as_u64).map_or(outline.blocks.len(), |total| total as usize);
    let mut warnings: Vec<ResultWarning> = outline.meta.warnings.iter().filter(|warning| warning.code != "outline_truncated").cloned().collect();
    warnings.push(size_truncation_warning(SizeCut {
        what: "top-level blocks",
        kept,
        total,
        oversize,
        advice: "The last blocks are left out. The outline can't be paged and no parameter raises this limit: read a block with logseq_get_block and its uuid, or find a later one by its text with logseq_find_blocks.",
        how_to_fetch_all: None,
    }));
    let has_more = warnings.iter().any(|warning| warning.how_to_fetch_all.is_some());
    PageOutline {
        blocks: outline.blocks[..kept].to_vec(),
        meta: ResultMeta { has_more, warnings, totals: outline.meta.totals.clone() },
        ..outline.clone()
    }
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
                 The outline has no way to page; read a block with logseq_get_block by its uuid, or find a later one by its text with logseq_find_blocks. Detail \"full\" is cut to 30000 characters too, so it does not read the rest.",
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

/// The warning for a `null` answer to the page's blocks. `hasMore` stays false and there is no `howToFetchAll`:
/// no parameter fetches blocks LogSeq did not answer (BR-0006, BR-0011).
fn blocks_unavailable() -> ResultWarning {
    ResultWarning::new(
        "outline_unavailable",
        "LogSeq returned no answer when looking up the blocks of this page (possibly no graph open or a re-index in progress), \
         so the empty outline may not mean the page has no blocks. \
         Retry in a moment, or call logseq_get_graph to check which graph is open."
            .to_owned(),
    )
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
    // BR-0011: a `null` answer is not an empty outline. It gives the same empty list plus a warning that says
    // the data was unavailable. A real `[]` is a page with no blocks and carries no warning.
    let rows = wire::outline_rows(&answer)?;
    let unavailable = rows.is_none();

    let (blocks, mut warnings, total) = outline_of(raw_id, &rows.unwrap_or_default());
    if unavailable {
        warnings.push(blocks_unavailable());
    }
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
    fn a_parent_spelled_db_id_counts_as_the_page_or_the_parent_block() {
        let mut top = block(103, None, 10, "top");
        top["parent"] = json!({"db/id": 10});
        let mut child = block(203, None, 103, "child");
        child["parent"] = json!({"db/id": 103});
        let (blocks, _, total) = outline_of(10, &rows(vec![top, child]));
        assert_eq!((uuids(&blocks), blocks[0].child_count, total), (vec!["u103"], 1, 1));
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
            "Showing the first 200 of 201 top-level blocks. The outline has no way to page; read a block with logseq_get_block by its uuid, or find a later one by its text with logseq_find_blocks. Detail \"full\" is cut to 30000 characters too, so it does not read the rest."
        );
    }

    /// An outline of `count` top-level blocks whose first lines are `snippet` characters long.
    fn outline_of_lines(count: usize, snippet: usize) -> PageOutline {
        let entry = |n: usize| OutlineEntry {
            uuid: format!("00000000-0000-4000-8000-{n:012}"),
            snippet: Snippet::of(Some(&"w".repeat(snippet))),
            child_count: n % 3,
        };
        PageOutline {
            page: "Atlas".into(),
            resolved_from: None,
            blocks: (0..count).map(entry).collect(),
            meta: ResultMeta::new(Vec::new(), &[("blocks", count)]),
        }
    }

    fn sent(outline: &PageOutline, format: Option<ListFormat>) -> usize {
        outline_texts(outline, true, format).unwrap().iter().map(|text| size(text)).sum()
    }

    #[test]
    fn two_hundred_entries_with_full_snippets_are_over_the_budget_and_under_it_with_short_ones() {
        // the cap of 200 blocks alone does not keep an outline under 30,000 characters
        let long = outline_of_lines(MAX_OUTLINE_BLOCKS, 80);
        assert!(sent(&long, None) > crate::budget::BUDGET_CHARS, "{}", sent(&long, None));
        let cut = fit_to_budget(long.clone(), true, None);
        assert!(sent(&cut, None) <= crate::budget::BUDGET_CHARS);
        let kept = cut.blocks.len();
        assert!(kept > 150 && kept < MAX_OUTLINE_BLOCKS, "{kept}");
        assert_eq!(cut.blocks[..], long.blocks[..kept]);
        assert!(sent(&cut_outline(&long, kept + 1, false), None) > crate::budget::BUDGET_CHARS);
        // a short outline, and an outline of short lines, are as they were
        let short = outline_of_lines(MAX_OUTLINE_BLOCKS, 20);
        assert_eq!(fit_to_budget(short.clone(), true, None), short);
        assert_eq!(fit_to_budget(outline_of_lines(3, 80), true, None), outline_of_lines(3, 80));
    }

    #[test]
    fn a_cut_outline_says_so_in_place_of_the_cap_warning_and_counts_every_top_level_block() {
        let mut long = outline_of_lines(MAX_OUTLINE_BLOCKS, 80);
        // the page had 230 top-level blocks and the cap of 200 had cut it
        long.meta = ResultMeta::new(
            vec![ResultWarning::new("outline_truncated", "Showing the first 200 of 230 top-level blocks.".into())],
            &[("blocks", 230)],
        );
        let cut = fit_to_budget(long, false, None);
        let codes: Vec<&str> = cut.meta.warnings.iter().map(|warning| warning.code.as_str()).collect();
        assert_eq!(codes, ["result_size_truncated"]);
        let kept = cut.blocks.len();
        assert!(cut.meta.warnings[0].message.starts_with(&format!("Showing {kept} of 230 top-level blocks: the result was cut to fit 30000 characters")), "{}", cut.meta.warnings[0].message);
        assert!(!cut.meta.has_more);
        assert_eq!(cut.meta.totals["blocks"], 230);
    }

    #[test]
    fn toon_is_measured_as_toon() {
        // the same 200 entries in TOON are shorter, and may fit where JSON does not
        let long = outline_of_lines(MAX_OUTLINE_BLOCKS, 80);
        let toon = sent(&long, Some(ListFormat::Toon));
        assert!(toon < sent(&long, None), "{toon}");
        let fitted = fit_to_budget(long.clone(), true, Some(ListFormat::Toon));
        assert_eq!(fitted == long, toon <= crate::budget::BUDGET_CHARS);
    }

    #[test]
    fn a_page_with_no_blocks_is_an_empty_outline() {
        let (blocks, warnings, total) = outline_of(10, &[]);
        assert!(blocks.is_empty() && warnings.is_empty());
        assert_eq!(total, 0);
    }

    #[test]
    fn the_unavailable_warning_says_the_empty_outline_may_not_mean_no_blocks_and_offers_no_way_to_fetch_more() {
        let warning = blocks_unavailable();
        assert_eq!(warning.code, "outline_unavailable");
        assert!(warning.message.contains("when looking up the blocks of this page"), "{}", warning.message);
        assert!(warning.message.contains("so the empty outline may not mean the page has no blocks"), "{}", warning.message);
        assert_eq!(warning.how_to_fetch_all, None);
        // No way to fetch more, so `hasMore` is false (BR-0006)
        assert!(!ResultMeta::new(vec![warning], &[("blocks", 0)]).has_more);
    }

    #[test]
    fn the_outline_serializes_in_the_pinned_key_order() {
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
