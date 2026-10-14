//! The `detail: "outline"` of `logseq_get_page`: a page's top-level blocks with a first-line snippet and a child
//! count each, so a model can choose what to read with `logseq_get_block` instead of loading a long page whole.
//! It was the tool `logseq_get_page_outline` before the v2 rename (ADR-0037, #489).
//!
//! Calls: 2 for an exact name, an alias or an ISO date (the page resolver, then one Datalog query
//! for the blocks). A namespace-leaf name adds the resolver's leaf query; a missing page adds the
//! suggestion lookup before it fails. Never one call per block.
//!
//! A result holds at most [`MAX_OUTLINE_BLOCKS`] top-level blocks and the 30,000-character budget. A page with more
//! is read to the end with a cursor (ADR-0038, #553): the result carries `nextCursor`, `hasMore: true`, and an
//! `outline_truncated` (the count) or `result_size_truncated` (the budget) warning whose `howToFetchAll` says to pass
//! it. A call with only that `cursor` reads the next page: from the snapshot the first call kept (no LogSeq call) or,
//! when the snapshot is gone, with the calls the first page made, resuming after the last block sent (found by its
//! uuid), with a `cursor_stale` warning when the page moved. `totals.blocks` is every top-level block the page has.
//!
//! This directory holds everything only the outline uses: its query (`queries.rs`), the blocks it
//! reads (`wire.rs`) and its tip (`tips.rs`). What it shares with other tools is outside it: the
//! page resolver, `ResultMeta`, the errors and the tool helpers.

mod queries;
mod tips;
mod wire;

use std::collections::HashMap;
use std::time::Instant;

use rmcp::model::{CallToolResult, ContentBlock};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::block_tree::order_siblings;
use crate::budget::size;
use crate::client::LogseqClient;
use crate::cursor::{Anchor, Cursor, Position, SnapshotKey, encode};
use crate::edn::PageId;
use crate::errors::{MatchedBy, ToolError};
use crate::meta::{ResultMeta, ResultWarning};
use crate::output_format::ListFormat;
use crate::paging::{Cut, PagedCut, Stale, page_of, paged_warning, resume_at, serve, stale_warning};
use crate::resolve::require_page;
use crate::snapshots::{Snapshots, resident_weight};
use crate::snippet::Snippet;
use crate::tips::tips_value;
use crate::tool::{result_value, success_result};
use crate::tree_paging::Resume;

use self::tips::{TipBlock, outline_tips};
use self::wire::OutlineBlock;

/// What the list holds, plural, as a warning says it.
const WHAT: &str = "top-level blocks";

/// The code of the warning for a page cut by the page size.
const COUNT_CUT: &str = "outline_truncated";

/// Most top-level blocks one page of the outline holds. A page with more is cut, and a cursor reads the rest.
pub const MAX_OUTLINE_BLOCKS: usize = 200;

/// What a read of the outline needs from the call.
pub struct Read<'a> {
    pub tips_enabled: bool,
    pub snapshots: &'a Snapshots,
    /// The page name, as the call asked or as the cursor holds it
    pub page: &'a str,
    /// `json` (the default) or `toon`
    pub format: Option<ListFormat>,
    /// The arguments the list is built from, which a cursor carries: the first call's, or the token's own
    pub stored: &'a Map<String, Value>,
    /// The cursor the call carried, decoded
    pub resume: Option<&'a Resume>,
}

/// One page of the outline of a page as a tool result: the outline, then its tip. `format` is the outline's own
/// (`json`, the default, or `toon`), and the tip is written in the same one.
///
/// With a `resume` it is the page the cursor names, read from the snapshot an earlier call kept or built again with
/// the calls the first page made, and starting at the block after the last one the page before sent.
pub async fn outline_result(client: &LogseqClient, read: Read<'_>) -> Result<CallToolResult, ToolError> {
    let Read { tips_enabled, snapshots, page, format, stored, resume } = read;
    let now = Instant::now();
    // Refused before any call: the last block a page sent is named by its uuid
    let anchor = match resume {
        None => None,
        Some(resume) => match &resume.cursor.anchor {
            Anchor::Text(uuid) => Some(uuid.as_str()),
            Anchor::Id(_) => return Err(resume.refuse(super::NAME, "this is not a cursor of the outline: its last block is not a uuid").into()),
        },
    };
    let served = serve(snapshots, resume.map(|resume| &resume.cursor.snapshot), stored, now, || listing_of(client, page)).await?;
    let listing = &*served.list;
    let total = listing.entries.len();
    let (start, stale) = match (resume, anchor) {
        (Some(resume), Some(anchor)) => {
            // The block after the anchor is found by its uuid, so a block added or deleted before the position
            // doesn't repeat or skip one; none is found when the anchor itself is gone
            let resumed = resume_at(
                total,
                resume.at(),
                |at| listing.entries[at].uuid == anchor,
                || listing.entries.iter().position(|entry| entry.uuid == anchor).map(|at| at + 1),
            );
            (resumed.start, resumed.stale)
        }
        _ => (0, None),
    };
    let view = View { listing, start, stale, tips_enabled, format, token: Some(Token { args: stored.clone(), key: served.key }) };
    let paged = page_of(total, start, MAX_OUTLINE_BLOCKS, |kept| view.size(kept));
    // A list that fits one page needs no snapshot, and a hit is kept already
    if paged.next().is_some() {
        served.keep(snapshots, stored, listing.weight(), now);
    }
    let texts = view.texts(paged.kept, paged.cut)?;
    Ok(success_result(texts.into_iter().map(ContentBlock::text).collect()))
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

/// Every top-level block of a page in page order, and how the page was found: the list a cursor pages, and what a
/// snapshot keeps.
struct Listing {
    page: String,
    resolved_from: Option<ResolvedFrom>,
    entries: Vec<OutlineEntry>,
    /// LogSeq answered `null` for the blocks (BR-0011)
    unavailable: bool,
}

impl Listing {
    /// What the snapshot weighs for the cache's bounds: the length of the JSON of the list, scaled to the memory it
    /// takes ([`resident_weight`]).
    fn weight(&self) -> usize {
        resident_weight(serde_json::to_string(&self.entries).map_or(0, |text| text.len()))
    }
}

/// What a cursor is made from: the arguments of the call and the snapshot its list was kept as.
struct Token {
    args: Map<String, Value>,
    key: SnapshotKey,
}

/// One page of the list, and everything its warnings, cursor and tip are made from.
struct View<'a> {
    listing: &'a Listing,
    /// The index of the first block of this page in the list
    start: usize,
    stale: Option<Stale>,
    tips_enabled: bool,
    format: Option<ListFormat>,
    /// What the next page's cursor carries. None for the library function, which has no snapshots to name
    token: Option<Token>,
}

impl View<'_> {
    fn total(&self) -> usize {
        self.listing.entries.len()
    }

    /// How the page ends when it holds the first `kept` blocks it could: not at all when it reaches the last block,
    /// by the page size when it holds all it could, by the budget otherwise.
    fn cut_at(&self, kept: usize) -> Option<Cut> {
        if self.start + kept >= self.total() {
            None
        } else if kept == MAX_OUTLINE_BLOCKS.min(self.total() - self.start) {
            Some(Cut::Count)
        } else {
            Some(Cut::Size { oversize: false })
        }
    }

    /// Whether the page, held to `kept` blocks and ending as `cut` says, has a cursor to read on with. A page of no
    /// block has none: a cursor that does not move reads nothing on.
    fn has_next(&self, kept: usize, cut: Option<Cut>) -> bool {
        cut.is_some() && kept > 0 && self.token.is_some()
    }

    /// The cursor that starts at the block after the first `kept`, which the last of them names by its uuid.
    fn next_cursor(&self, kept: usize, cut: Option<Cut>) -> Option<String> {
        let token = self.token.as_ref().filter(|_| self.has_next(kept, cut))?;
        let anchor = Anchor::Text(self.listing.entries[self.start + kept - 1].uuid.clone());
        Some(encode(&Cursor::new(super::NAME, token.args.clone(), Position::Index { at: self.start + kept }, anchor, token.key)))
    }

    /// The warnings of the page holding the first `kept` blocks: a list that moved, then the cut. A `null` answer is
    /// the one warning, with no way to fetch more (BR-0006, BR-0011).
    fn warnings(&self, kept: usize, cut: Option<Cut>) -> Vec<ResultWarning> {
        if self.listing.unavailable {
            return vec![blocks_unavailable()];
        }
        let mut warnings: Vec<ResultWarning> = self.stale.map(|stale| stale_warning(stale, WHAT)).into_iter().collect();
        if let Some(cut) = cut {
            let advice = match cut {
                Cut::Size { .. } => "The last top-level blocks are left out. No parameter raises the size limit: read a block with logseq_get_block and its uuid.",
                Cut::Count => "",
            };
            warnings.push(paged_warning(PagedCut {
                count_code: COUNT_CUT,
                cut,
                what: WHAT,
                start: self.start,
                kept,
                total: self.total(),
                advice,
                raise: None,
                has_next: self.has_next(kept, Some(cut)),
            }));
        }
        warnings
    }

    /// The outline holding the first `kept` blocks of this page, ending as `cut` says.
    fn outline(&self, kept: usize, cut: Option<Cut>) -> PageOutline {
        PageOutline {
            page: self.listing.page.clone(),
            resolved_from: self.listing.resolved_from.clone(),
            blocks: self.listing.entries[self.start..self.start + kept].to_vec(),
            meta: ResultMeta::paged(self.warnings(kept, cut), &[("blocks", self.total())], self.next_cursor(kept, cut)),
        }
    }

    /// What the call sends for the first `kept` blocks: the outline, then its tip.
    fn texts(&self, kept: usize, cut: Option<Cut>) -> Result<Vec<String>, ToolError> {
        outline_texts(&self.outline(kept, cut), self.tips_enabled, self.format)
    }

    /// The length of the result holding the first `kept` blocks, as `call` would send it (what the budget measures).
    fn size(&self, kept: usize) -> usize {
        self.texts(kept, self.cut_at(kept)).map_or(0, |texts| texts.iter().map(|text| size(text)).sum())
    }
}

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

/// The outline of the blocks the query pulled for `page_id`: every top-level block, in page order.
///
/// Top-level blocks hang off the page; every other row is a child of one of them. A `null` cell
/// is skipped, and so is a row with no parent: it is neither a top-level block nor a child.
fn outline_of(page_id: i64, rows: &[Option<OutlineBlock>]) -> Vec<OutlineEntry> {
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

    order_siblings(top, |top| top.id, |top| top.left)
        .iter()
        .map(|top| OutlineEntry {
            uuid: top.block.uuid.clone(),
            snippet: Snippet::of(top.block.content.as_deref()),
            child_count: child_count.get(&top.id).copied().unwrap_or(0),
        })
        .collect()
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

/// The list of a first call, or of a cursor whose snapshot is gone: the page resolved, then the one Datalog query for
/// its blocks, every top-level block kept.
///
/// Fails with [`ToolError::PageNotFound`] (guidance with the closest names) if no page matches,
/// and [`ToolError::AmbiguousPage`] (with the candidates) if several do.
async fn listing_of(client: &LogseqClient, page_name: &str) -> Result<Listing, ToolError> {
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
    let entries = outline_of(raw_id, &rows.unwrap_or_default());
    let resolved_from = (resolved.matched_by != MatchedBy::Name).then(|| ResolvedFrom {
        name: page_name.to_owned(),
        matched_by: resolved.matched_by.as_str(),
        resolved_to: resolved.original_name.clone(),
    });
    Ok(Listing { page: resolved.original_name, resolved_from, entries, unavailable })
}

/// A page's outline: the first page of it, as the tool sends it without the cursor. The library function keeps no
/// snapshot and carries no `nextCursor`, and applies the page size but not the character budget (`outline_result` does).
///
/// `page_name` is a page name, an alias, or an ISO date (`2025-01-01`) of a journal. When it was
/// an alias, a date or a namespace leaf rather than an exact name, `resolvedFrom` says so.
///
/// Fails with [`ToolError::PageNotFound`] (guidance with the closest names) if no page matches,
/// and [`ToolError::AmbiguousPage`] (with the candidates) if several do.
pub async fn get_page_outline(client: &LogseqClient, page_name: &str) -> Result<PageOutline, ToolError> {
    let listing = listing_of(client, page_name).await?;
    let view = View { listing: &listing, start: 0, stale: None, tips_enabled: false, format: None, token: None };
    let kept = MAX_OUTLINE_BLOCKS.min(view.total());
    Ok(view.outline(kept, view.cut_at(kept)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor::decode;
    use crate::paging::NEXT_PAGE;
    use serde_json::json;

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
        let blocks = outline_of(10, &rows);
        assert_eq!(uuids(&blocks), ["u101", "u102", "u103"]);
        assert_eq!(blocks.iter().map(|b| b.child_count).collect::<Vec<_>>(), [2, 0, 0]);
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
        assert_eq!(uuids(&outline_of(41, &rows)), ["u413", "u414", "u411", "u412"]);
    }

    #[test]
    fn two_siblings_with_one_left_keep_the_first_listed_in_the_chain() {
        let rows = rows(vec![block(2, Some(1), 1, "first"), block(3, Some(1), 1, "second")]);
        // both are heads (their left, the page, is no sibling), ordered by id
        assert_eq!(uuids(&outline_of(1, &rows)), ["u2", "u3"]);
        let chained = self::rows(vec![block(5, Some(1), 4, "a"), block(6, Some(1), 5, "b"), block(7, Some(1), 5, "c"), block(4, Some(1), 1, "head")]);
        // 6 was listed before 7, so it follows 5; 7, which no chain reached, comes last
        assert_eq!(uuids(&outline_of(1, &chained)), ["u4", "u5", "u6", "u7"]);
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
        let blocks = outline_of(40, &rows);
        assert_eq!((uuids(&blocks), blocks[0].child_count), (vec!["u401"], 1));
    }

    #[test]
    fn a_parent_can_be_a_bare_number() {
        let mut child = block(203, None, 103, "child");
        child["parent"] = json!(103);
        let rows = rows(vec![block(103, Some(10), 10, "top"), child]);
        assert_eq!(outline_of(10, &rows)[0].child_count, 1);
    }

    #[test]
    fn a_parent_spelled_db_id_counts_as_the_page_or_the_parent_block() {
        let mut top = block(103, None, 10, "top");
        top["parent"] = json!({"db/id": 10});
        let mut child = block(203, None, 103, "child");
        child["parent"] = json!({"db/id": 103});
        let blocks = outline_of(10, &rows(vec![top, child]));
        assert_eq!((uuids(&blocks), blocks[0].child_count), (vec!["u103"], 1));
    }

    #[test]
    fn every_top_level_block_is_listed_past_the_page_size() {
        let many: Vec<Value> = (0..201).map(|i| block(1000 + i, Some(50), if i == 0 { 50 } else { 1000 + i - 1 }, "entry")).collect();
        let blocks = outline_of(50, &rows(many));
        assert_eq!(blocks.len(), 201);
        assert_eq!(blocks[200].uuid, "u1200");
    }

    /// A list of `count` top-level blocks whose first lines are `snippet` characters long.
    fn listing_of_lines(count: usize, snippet: usize) -> Listing {
        let entry = |n: usize| OutlineEntry {
            uuid: format!("00000000-0000-4000-8000-{n:012}"),
            snippet: Snippet::of(Some(&"w".repeat(snippet))),
            child_count: n % 3,
        };
        Listing { page: "Atlas".into(), resolved_from: None, entries: (0..count).map(entry).collect(), unavailable: false }
    }

    fn view(listing: &Listing, start: usize, format: Option<ListFormat>) -> View<'_> {
        let token = Token { args: json!({"page": "Atlas", "detail": "outline"}).as_object().cloned().unwrap(), key: SnapshotKey { started: 1, n: 1 } };
        View { listing, start, stale: None, tips_enabled: true, format, token: Some(token) }
    }

    /// The page the call would send from `start`: its outline and how many characters it takes.
    fn page_at(view: &View<'_>) -> (PageOutline, usize) {
        let page = page_of(view.total(), view.start, MAX_OUTLINE_BLOCKS, |kept| view.size(kept));
        (view.outline(page.kept, page.cut), view.size(page.kept))
    }

    fn token_at(outline: &PageOutline) -> crate::cursor::Cursor {
        decode(outline.meta.next_cursor.as_deref().unwrap(), super::super::NAME).unwrap()
    }

    #[test]
    fn a_list_exactly_at_the_page_size_is_one_page_and_one_more_has_a_cursor() {
        for (count, cursor) in [(MAX_OUTLINE_BLOCKS, false), (MAX_OUTLINE_BLOCKS + 1, true)] {
            let listing = listing_of_lines(count, 5);
            let (outline, _) = page_at(&view(&listing, 0, None));
            assert_eq!((outline.blocks.len(), outline.meta.next_cursor.is_some(), outline.meta.has_more), (MAX_OUTLINE_BLOCKS, cursor, cursor), "{count} blocks");
            assert_eq!(outline.meta.warnings.len(), usize::from(cursor));
            assert_eq!(outline.meta.totals["blocks"], count);
        }
    }

    #[test]
    fn a_count_cut_says_so_and_leads_with_the_cursor() {
        let listing = listing_of_lines(MAX_OUTLINE_BLOCKS + 1, 5);
        let (outline, _) = page_at(&view(&listing, 0, None));
        let warning = &outline.meta.warnings[0];
        assert_eq!(warning.code, "outline_truncated");
        assert_eq!(warning.message, "Showing 1-200 of 201 top-level blocks.");
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some(NEXT_PAGE));
        let cursor = token_at(&outline);
        assert_eq!((cursor.position, cursor.anchor), (Position::Index { at: 200 }, Anchor::Text(listing.entries[199].uuid.clone())));
        // the last page has neither cursor nor warning
        let (last, _) = page_at(&view(&listing, 200, None));
        assert_eq!((last.blocks.len(), last.meta.next_cursor, last.meta.has_more, last.meta.warnings.len()), (1, None, false, 0));
    }

    #[test]
    fn two_hundred_entries_with_full_snippets_are_cut_to_the_budget_and_the_pages_read_to_the_end() {
        // the page size alone does not keep an outline under 30,000 characters
        let listing = listing_of_lines(MAX_OUTLINE_BLOCKS * 3, 80);
        let mut start = 0;
        let mut seen: Vec<String> = Vec::new();
        let mut pages = 0;
        loop {
            let v = view(&listing, start, None);
            let (outline, chars) = page_at(&v);
            assert!(chars <= crate::budget::BUDGET_CHARS, "{chars}");
            assert!(!outline.blocks.is_empty());
            if pages == 0 {
                assert!(outline.blocks.len() > 150 && outline.blocks.len() < MAX_OUTLINE_BLOCKS, "{}", outline.blocks.len());
                assert_eq!(outline.meta.warnings[0].code, "result_size_truncated");
            }
            seen.extend(outline.blocks.iter().map(|entry| entry.uuid.clone()));
            pages += 1;
            match outline.meta.next_cursor.as_deref() {
                None => break,
                Some(_) => {
                    let Position::Index { at } = token_at(&outline).position else { panic!("not an index") };
                    assert_eq!(at, seen.len());
                    start = at;
                }
            }
        }
        let all: Vec<String> = listing.entries.iter().map(|entry| entry.uuid.clone()).collect();
        assert_eq!(seen, all);
        assert!(pages > 3, "{pages}");
    }

    #[test]
    fn a_block_over_the_budget_comes_back_alone_and_the_cursor_moves_past_it() {
        let mut listing = listing_of_lines(3, 5);
        listing.entries[0].snippet = Snippet::of(Some(&"w".repeat(100)));
        let v = view(&listing, 0, None);
        // the least a page keeps is one block, whatever it weighs
        let page = page_of(v.total(), 0, MAX_OUTLINE_BLOCKS, |kept| if kept == 0 { 0 } else { crate::budget::BUDGET_CHARS + kept });
        assert_eq!(page.kept, 1);
        assert_eq!(page.next(), Some(1));
        let outline = v.outline(page.kept, page.cut);
        assert!(outline.meta.next_cursor.is_some());
    }

    #[test]
    fn a_stale_page_leads_with_the_cursor_stale_warning() {
        let listing = listing_of_lines(5, 5);
        let mut v = view(&listing, 2, None);
        v.stale = Some(Stale::Moved);
        let (outline, _) = page_at(&v);
        assert_eq!(outline.meta.warnings[0].code, "cursor_stale");
        assert_eq!(outline.blocks.len(), 3);
        assert_eq!(outline.meta.next_cursor, None);
    }

    #[test]
    fn toon_is_measured_as_toon() {
        // the same entries in TOON are shorter, and may fit where JSON does not
        let listing = listing_of_lines(MAX_OUTLINE_BLOCKS, 80);
        let (json, json_chars) = page_at(&view(&listing, 0, None));
        let (toon, toon_chars) = page_at(&view(&listing, 0, Some(ListFormat::Toon)));
        assert!(toon_chars < json_chars, "{toon_chars} {json_chars}");
        assert!(toon.blocks.len() >= json.blocks.len());
    }

    #[test]
    fn a_page_with_no_blocks_is_an_empty_outline() {
        let listing = listing_of_lines(0, 5);
        let (outline, _) = page_at(&view(&listing, 0, None));
        assert!(outline.blocks.is_empty() && outline.meta.warnings.is_empty() && outline.meta.next_cursor.is_none() && !outline.meta.has_more);
        assert_eq!(outline.meta.totals["blocks"], 0);
    }

    #[test]
    fn the_unavailable_warning_says_the_empty_outline_may_not_mean_no_blocks_and_offers_no_way_to_fetch_more() {
        let warning = blocks_unavailable();
        assert_eq!(warning.code, "outline_unavailable");
        assert!(warning.message.contains("when looking up the blocks of this page"), "{}", warning.message);
        assert!(warning.message.contains("so the empty outline may not mean the page has no blocks"), "{}", warning.message);
        assert_eq!(warning.how_to_fetch_all, None);
        // No way to fetch more, so `hasMore` is false (BR-0006)
        let mut listing = listing_of_lines(0, 5);
        listing.unavailable = true;
        let (outline, _) = page_at(&view(&listing, 0, None));
        assert_eq!((outline.meta.has_more, outline.meta.next_cursor, outline.meta.warnings.len()), (false, None, 1));
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
        let paged = PageOutline { meta: ResultMeta::paged(vec![], &[("blocks", 1)], Some("tok".into())), ..outline };
        assert!(serde_json::to_string(&paged).unwrap().contains(r#""hasMore":true,"nextCursor":"tok","warnings":[]"#));
    }
}
