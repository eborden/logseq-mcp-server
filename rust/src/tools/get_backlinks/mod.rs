//! `logseq_get_backlinks` (the Rust side of `src/tools/get-backlinks.ts`): the pages and blocks
//! that link to a page under any of its names, most-linking pages first, capped by `max_pages`
//! and `max_blocks_per_page` (#61, #178).
//!
//! Calls: the page resolver (1 query for an exact name, an alias or an ISO date), then the alias
//! lookup (1 query, only when the resolved page has alias links), then the references: one
//! `logseq.Editor.getPageLinkedReferences` call for a page with no aliases, or one Datalog query
//! over the whole alias group for a page with some. A namespace-leaf name adds the resolver's
//! leaf query, and a missing page adds the suggestion lookup before it fails. The cap is applied
//! after the fetch, so it costs no call.
//!
//! This directory holds what only the backlinks use: the answers it reads (`wire.rs`) and its tip
//! (`tips.rs`). The alias groups are shared with other tools (`resolve::alias`).

mod tips;
mod wire;

use std::cmp::Ordering;
use std::collections::HashMap;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::args::Arguments;
use crate::block_tree::{camelize_block, camelize_keys};
use crate::client::LogseqClient;
use crate::errors::{MatchedBy, ToolError};
use crate::js;
use crate::meta::{ResultMeta, ResultWarning};
use crate::params::{ParamAliases, resolve_param_aliases};
use crate::resolve::alias::{AliasSet, alias_set_warnings, compare_code_units, linked_references_of_pages, resolve_alias_set};
use crate::resolve::require_page;
use crate::tool::{input_schema, read_only_annotations, success_result};
use crate::truncation::{CappedTruncation, INLINE_BLOCKS, capped_truncation_warning, large_result_note};

use self::tips::backlink_tips;
pub use self::wire::{Backlink, block_rows};
use self::wire::LINKED_REFERENCES_METHOD;

pub const NAME: &str = "logseq_get_backlinks";

/// The description the TypeScript server gives the tool (`src/tool-descriptions.ts`).
const DESCRIPTION: &str = "List the pages and blocks that link to a page with [[page]] or #tag, most-linking pages first. Capped by max_pages and max_blocks_per_page: check meta.\n\n\
**Use when:** \"what links to X?\" or \"where is X used?\"\n\
**Can't find:** unlinked text mentions (logseq_search_blocks), outbound links (logseq_get_concept_network), or over 100 pages.\n\
**Alternatives:** logseq_build_context for related pages.";

/// Parameter aliases (BR-0008): not in the schema, so they cost nothing in `tools/list`.
const ALIASES: ParamAliases = &[("page_name", &["name", "page"])];

/// Source pages kept when `max_pages` is absent.
pub const DEFAULT_MAX_PAGES: u64 = 20;

/// Most source pages one call returns (#61). A larger `max_pages` is clamped to it, and a cut at
/// the maximum is a `pages_truncated` warning with no `howToFetchAll`.
pub const MAX_PAGES: u64 = 100;

/// Linking blocks kept per source page when `max_blocks_per_page` is absent.
pub const DEFAULT_MAX_BLOCKS_PER_PAGE: u64 = 10;

/// Most linking blocks one source page returns (#61). A larger value is clamped to it, and a cut
/// at the maximum is a `page_blocks_truncated` warning with no `howToFetchAll`.
pub const MAX_BLOCKS_PER_PAGE: u64 = 50;

/// Source pages named in a `page_blocks_truncated` message; the rest are counted.
const MAX_NAMED_PAGES: usize = 5;

fn default_max_pages() -> u32 {
    DEFAULT_MAX_PAGES as u32
}

fn default_max_blocks_per_page() -> u32 {
    DEFAULT_MAX_BLOCKS_PER_PAGE as u32
}

/// The tool's arguments, as `tools/list` shows them. The schema is generated from this type
/// (ADR-0019); a call reads its arguments through [`Arguments`], which words a bad one as the
/// TypeScript server does. Unknown fields are ignored, as every TypeScript tool ignores them.
#[derive(Debug, Deserialize, JsonSchema)]
#[allow(dead_code)]
pub struct Args {
    /// Page to get backlinks for (name, alias or ISO date)
    pub page_name: String,
    /// Max source pages (default: 20, max: 100)
    #[serde(default = "default_max_pages")]
    pub max_pages: u32,
    /// Max linking blocks per source page (default: 10, max: 50)
    #[serde(default = "default_max_blocks_per_page")]
    pub max_blocks_per_page: u32,
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Get Backlinks")
        .with_annotations(read_only_annotations("Get Backlinks"))
}

/// A call: aliases folded, arguments read, the tool, then its tip.
pub async fn call(client: &LogseqClient, tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let arguments = resolve_param_aliases(ALIASES, arguments)?;
    let read = Arguments::new(arguments.as_ref());
    let page_name = read.required_string("page_name")?;
    let max_pages = read.count_or("max_pages", 0, DEFAULT_MAX_PAGES)?;
    let max_blocks_per_page = read.count_or("max_blocks_per_page", 0, DEFAULT_MAX_BLOCKS_PER_PAGE)?;

    let outcome = get_backlinks_with_meta(client, &page_name, max_pages, max_blocks_per_page).await?;
    let has_results = outcome.results.as_ref().is_some_and(|results| !results.is_empty());
    let text = js::json_stringify(&match outcome.results {
        Some(results) => Value::Array(results.into_iter().map(Backlink::into_value).collect()),
        // PARITY(#299): LogSeq's null is passed through as the text `null` with no warning; BR-0011 only requires one
        // when null becomes empty, so whether this needs one is open in #318 — drop if Rust becomes the only server.
        None => Value::Null,
    });
    let mut content = vec![ContentBlock::text(text)];
    let tips = if tips_enabled { backlink_tips(&page_name, has_results) } else { Vec::new() };
    if let Some(meta) = meta_content(outcome.meta, &tips) {
        content.push(ContentBlock::text(meta));
    }
    Ok(success_result(content))
}

/// `metaContent(meta, tips)`: the trailing `{"meta": ...}` block, which carries the tips too, or
/// nothing when there is neither.
fn meta_content(meta: Option<Map<String, Value>>, tips: &[String]) -> Option<String> {
    let merged = match (meta, tips.is_empty()) {
        (None, true) => return None,
        (Some(meta), true) => meta,
        (meta, false) => {
            let mut merged = meta.unwrap_or_default();
            merged.insert("tips".to_owned(), json!(tips));
            merged
        }
    };
    Some(js::json_stringify(&json!({ "meta": Value::Object(merged) })))
}

/// `[sourcePage, linking blocks]` ranked and cut: the result and what the cut says about it.
#[derive(Debug, PartialEq)]
pub struct Capped {
    pub results: Vec<Backlink>,
    pub warnings: Vec<ResultWarning>,
    /// Every source page and every linking block before any cut. Present only when a cap bit.
    pub totals: Option<(usize, usize)>,
}

fn block_count(backlink: &Backlink) -> String {
    let n = backlink.blocks.len();
    format!("{n} linking {}", if n == 1 { "block" } else { "blocks" })
}

/// `String(value)` for the strings and numbers a page or block carries.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(n) => js::number_to_string(n.as_f64().expect("a JSON number is finite")),
        other => other.to_string(),
    }
}

/// A field of an optional entity.
fn field<'a>(map: Option<&'a Map<String, Value>>, key: &str) -> Option<&'a Value> {
    map.and_then(|map| map.get(key))
}

/// The first of `candidates` that is present (`a ?? b ?? c`; a `null` can't occur, the schema
/// refuses it).
fn first_present<'a>(candidates: impl IntoIterator<Item = Option<&'a Value>>) -> Option<&'a Value> {
    candidates.into_iter().flatten().find(|value| !value.is_null())
}

/// `sourceName`: the name a warning shows for a source page: the page's, else its first block's
/// page (a tuple can have no page), else a neutral label.
fn source_name(backlink: &Backlink) -> String {
    let page = backlink.page.as_object();
    let from_block = backlink.block_page();
    first_present([
        field(page, "originalName"),
        field(page, "name"),
        field(page, "id"),
        field(from_block, "originalName"),
        field(from_block, "name"),
        field(from_block, "id"),
    ])
    .map_or_else(|| "unknown page".to_owned(), js_string)
}

/// The name a source page ties on: `name` is lowercase, so case never decides.
fn rank_name(backlink: &Backlink) -> String {
    first_present([field(backlink.page.as_object(), "name"), field(backlink.block_page(), "name")]).map(js_string).unwrap_or_default()
}

fn rank_id(backlink: &Backlink) -> f64 {
    first_present([field(backlink.page.as_object(), "id"), field(backlink.block_page(), "id")]).and_then(Value::as_f64).unwrap_or(0.0)
}

/// `rankBacklinks`: source pages ranked by how many blocks link the target, most first (#178).
/// Ties break by page name (lowercase, plain code-unit order), then by page id, so the order is
/// the same on every run and on both paths: the Editor call's order is LogSeq's own and the alias
/// group's is by name, and neither says which pages link most. The blocks of each page keep the
/// order they came in. Costs no call.
pub fn rank_backlinks(results: Vec<Backlink>) -> Vec<Backlink> {
    let mut keyed: Vec<(String, f64, Backlink)> = results.into_iter().map(|b| (rank_name(&b), rank_id(&b), b)).collect();
    keyed.sort_by(|a, b| {
        b.2.blocks
            .len()
            .cmp(&a.2.blocks.len())
            .then_with(|| compare_code_units(&a.0, &b.0))
            .then_with(|| a.1.partial_cmp(&b.1).unwrap_or(Ordering::Equal))
    });
    keyed.into_iter().map(|(_, _, backlink)| backlink).collect()
}

/// `pagesThatFit` (#196): the most source pages, from the top of the ranking, whose blocks still
/// plausibly come back inline: the longest prefix of `results` that holds at most
/// [`INLINE_BLOCKS`] blocks once each page is cut to `block_cap`.
fn pages_that_fit(results: &[Backlink], block_cap: usize) -> usize {
    let mut blocks = 0;
    let mut pages = 0;
    for backlink in results {
        blocks += backlink.blocks.len().min(block_cap);
        if blocks > INLINE_BLOCKS {
            break;
        }
        pages += 1;
    }
    pages
}

/// `capBacklinks`: rank `fetched`, then cut to `max_pages` source pages and `max_blocks_per_page`
/// blocks each (#61), keeping the first of each in that order. The ranking applies whether or
/// not a cap bites, so the order is the same at every cap value and a smaller cap is always a
/// prefix of a larger one. A result that fits both caps comes back ranked, with no warning and no
/// totals. `target` is the page's name, for the search advice in the pages warning.
pub fn cap_backlinks(fetched: Vec<Backlink>, target: &str, max_pages: u64, max_blocks_per_page: u64) -> Capped {
    let page_cap = max_pages.min(MAX_PAGES) as usize;
    let block_cap = max_blocks_per_page.min(MAX_BLOCKS_PER_PAGE) as usize;

    let ranked = rank_backlinks(fetched);
    let kept_count = ranked.len().min(page_cap);
    let affected: Vec<&Backlink> = ranked[..kept_count].iter().filter(|b| b.blocks.len() > block_cap).collect();
    if kept_count == ranked.len() && affected.is_empty() {
        return Capped { results: ranked, warnings: Vec::new(), totals: None };
    }

    let mut warnings = Vec::new();
    if kept_count < ranked.len() {
        let narrower = format!(
            "logseq_search_blocks with query \"[[{target}]]\" lists the blocks that write the link that way, on every page (not #tags or alias spellings)."
        );
        let mut warning = capped_truncation_warning(CappedTruncation {
            what: "source pages, ranked by linking blocks (most first, ties by page name)",
            shown: kept_count,
            total: ranked.len(),
            param: "max_pages",
            max: MAX_PAGES as usize,
            narrower: &narrower,
            requested: Some(max_pages),
            code: "pages_truncated",
            inline_max: Some(pages_that_fit(&ranked, block_cap)),
            paging: None,
        });
        // The counts are in hand, so say where the cut fell: the dropped pages link the target no more than this
        // PARITY(#299): the first dropped page's count has no "linking block(s)" after it, unlike the last kept
        // page's (suspected TS inconsistency) — drop if Rust becomes the only server.
        let edge = match kept_count {
            0 => String::new(),
            n => format!(
                " The last page kept has {}, the first dropped page has {}.",
                block_count(&ranked[n - 1]),
                ranked[n].blocks.len()
            ),
        };
        // Raising max_pages shows pages whose blocks may then be cut by the per-page cap
        warning.message = format!("{}{edge} Blocks per page are capped separately by max_blocks_per_page.", warning.message);
        warnings.push(warning);
    }
    if !affected.is_empty() {
        warnings.push(page_blocks_truncated(&affected, block_cap, max_blocks_per_page, &ranked[..kept_count]));
    }

    let totals = (ranked.len(), ranked.iter().map(|b| b.blocks.len()).sum());
    let results = ranked
        .into_iter()
        .take(kept_count)
        .map(|mut backlink| {
            backlink.blocks.truncate(block_cap);
            backlink
        })
        .collect();
    Capped { results, warnings, totals: Some(totals) }
}

/// The `page_blocks_truncated` warning: `affected` kept source pages hold more than `cap` linking
/// blocks. Raising the cap helps below the maximum, to the largest page's count when that fits
/// and to the maximum when it doesn't; at the maximum nothing can be raised, so there is no
/// `howToFetchAll` and `hasMore` stays false. Reading a source page whole with `logseq_get_page`
/// gets the blocks the cap dropped either way.
fn page_blocks_truncated(affected: &[&Backlink], cap: usize, requested: u64, kept: &[Backlink]) -> ResultWarning {
    let n = affected.len();
    let named: Vec<String> =
        affected.iter().take(MAX_NAMED_PAGES).map(|backlink| format!("\"{}\" ({})", source_name(backlink), backlink.blocks.len())).collect();
    let more = if n > MAX_NAMED_PAGES { format!(" and {} more", n - MAX_NAMED_PAGES) } else { String::new() };
    let shown = format!(
        "Showing the first {cap} linking blocks of {n} source {} with more: {}{more}.",
        if n == 1 { "page" } else { "pages" },
        named.join(", ")
    );
    let read_whole = "logseq_get_page with include_children reads a source page whole.";
    let largest = affected.iter().map(|backlink| backlink.blocks.len()).max().unwrap_or(0);

    if cap >= MAX_BLOCKS_PER_PAGE as usize {
        let clamped = if requested > MAX_BLOCKS_PER_PAGE { format!(" ({requested} was asked for)") } else { String::new() };
        return ResultWarning::new(
            "page_blocks_truncated",
            format!("{shown} max_blocks_per_page is capped at its maximum of {MAX_BLOCKS_PER_PAGE}{clamped}, so the rest can't be fetched in one call. {read_whole}"),
        );
    }
    // The blocks the raise would return across every kept page, to say when that may not come back inline (#196)
    let raise_to = largest.min(MAX_BLOCKS_PER_PAGE as usize);
    let after_raise: usize = kept.iter().map(|backlink| backlink.blocks.len().min(raise_to)).sum();
    let note = large_result_note(after_raise, Some(INLINE_BLOCKS));
    ResultWarning {
        code: "page_blocks_truncated".to_owned(),
        message: shown,
        how_to_fetch_all: Some(if largest <= MAX_BLOCKS_PER_PAGE as usize {
            format!("Set max_blocks_per_page to {largest} (or higher) to get every block of these pages.{note}")
        } else {
            format!("Set max_blocks_per_page to {MAX_BLOCKS_PER_PAGE} (the maximum) to get {MAX_BLOCKS_PER_PAGE} per page.{note} {read_whole}")
        }),
    }
}

/// What a backlinks call found, ready to write out.
#[derive(Debug)]
pub struct Outcome {
    /// `None` is LogSeq's `null` (BR-0011), which stays `null` in the output
    pub results: Option<Vec<Backlink>>,
    /// The second content block's `meta`: absent for an exact match on a page with no aliases
    /// that fits both caps, so default output is unchanged.
    pub meta: Option<Map<String, Value>>,
}

/// The `{ page, blocks }` of each source page of the aliased query, as the Editor API shapes it
/// (camelCase entities, the page nested in each block the same one).
fn group_by_source_page(rows: Vec<Option<Map<String, Value>>>) -> Vec<Backlink> {
    struct Group {
        page: Map<String, Value>,
        /// Blocks by id, in the order each id first came
        blocks: Vec<(f64, Map<String, Value>)>,
        index: HashMap<u64, usize>,
    }
    let mut groups: Vec<Group> = Vec::new();
    let mut by_page: HashMap<u64, usize> = HashMap::new();
    for row in rows.into_iter().flatten() {
        let mut block = camelize_block(&row);
        // A block with no page id has no source page
        let Some(page_id) = block.get("page").and_then(Value::as_object).and_then(|page| page.get("id")).and_then(Value::as_f64) else {
            continue;
        };
        let at = *by_page.entry(page_id.to_bits()).or_insert_with(|| {
            let page = block.get("page").and_then(Value::as_object).expect("checked above");
            groups.push(Group { page: camelize_keys(page), blocks: Vec::new(), index: HashMap::new() });
            groups.len() - 1
        });
        let group = &mut groups[at];
        block.insert("page".to_owned(), Value::Object(group.page.clone()));
        let block_id = block.get("id").and_then(Value::as_f64).unwrap_or(f64::NAN);
        match group.index.get(&block_id.to_bits()) {
            Some(&i) => group.blocks[i].1 = block,
            None => {
                group.index.insert(block_id.to_bits(), group.blocks.len());
                group.blocks.push((block_id, block));
            }
        }
    }
    groups
        .into_iter()
        .map(|mut group| {
            group.blocks.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(Ordering::Equal));
            Backlink { page: Value::Object(group.page), blocks: group.blocks.into_iter().map(|(_, block)| Value::Object(block)).collect() }
        })
        .collect()
}

/// `fetchBacklinks`: the linked references of a resolved page. Without aliases this is the Editor
/// API's own call for `resolved_name`, unchanged. For a page with aliases it is one Datalog query
/// over the ids of the whole group, shaped like that call's result (camelCase entities, one
/// `[page, blocks]` tuple per source page), the pages in order of name, then id. A caller that ranks
/// them (`get_backlinks`) loses that order, one that doesn't (`build_context`) keeps it.
pub async fn fetch_backlinks(client: &LogseqClient, resolved_name: &str, alias_set: &AliasSet) -> Result<Option<Vec<Backlink>>, ToolError> {
    if !alias_set.has_aliases() {
        let answer = client.call_api(LINKED_REFERENCES_METHOD, &[Value::from(resolved_name)]).await?;
        return Ok(wire::linked_references(answer)?);
    }
    let query = linked_references_of_pages(&alias_set.ids()?);
    let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
    // PARITY(#299): a `null` answer is read as "no rows", so the page looks like it has no backlinks when
    // LogSeq didn't answer (suspected TS bug, BR-0011) — fix per #318, in both servers.
    let rows = wire::block_rows(answer)?.unwrap_or_default();
    let mut groups = group_by_source_page(rows);
    // PARITY(#299): orders names with `localeCompare`, approximated by `js::locale_compare` — drop if Rust
    // becomes the only server.
    // `String(a.page.name).localeCompare(String(b.page.name)) || a.page.id - b.page.id`
    groups.sort_by(|a, b| {
        let name = |backlink: &Backlink| backlink.page.get("name").map_or_else(|| "undefined".to_owned(), js_string);
        let id = |backlink: &Backlink| backlink.page.get("id").and_then(Value::as_f64).unwrap_or(f64::NAN);
        js::locale_compare(&name(a), &name(b)).then_with(|| id(a).total_cmp(&id(b)))
    });
    Ok(Some(groups))
}

/// `getBacklinksWithMeta`: every page and block that links to `page_name` under any of its names.
///
/// `page_name` is a page name, an alias, or an ISO date (`2025-01-01`) of a journal. The meta
/// carries `resolvedFrom` when the name was an alias, date or namespace leaf rather than an exact
/// name, `resolvedAliases` when the page has aliases, and the warnings and totals of a cut.
///
/// Fails with [`ToolError::PageNotFound`] (guidance with the closest names) if no page matches,
/// and [`ToolError::AmbiguousPage`] (with the candidates) if several do.
pub async fn get_backlinks_with_meta(
    client: &LogseqClient,
    page_name: &str,
    max_pages: u64,
    max_blocks_per_page: u64,
) -> Result<Outcome, ToolError> {
    let resolved = require_page(client, page_name).await?;
    let alias_set = resolve_alias_set(client, &resolved.page).await?;
    let fetched = fetch_backlinks(client, &resolved.lookup_name, &alias_set).await?;
    // The same cut for both paths, after the fetch: a null answer stays null (BR-0011)
    let capped = fetched.map(|fetched| cap_backlinks(fetched, &resolved.lookup_name, max_pages, max_blocks_per_page));
    let resolved_from = (resolved.matched_by != MatchedBy::Name).then(|| {
        json!({"name": page_name, "matchedBy": resolved.matched_by.as_str(), "resolvedTo": resolved.original_name})
    });
    let mut warnings = alias_set_warnings(&[&alias_set]);
    warnings.extend(capped.as_ref().map(|capped| capped.warnings.clone()).unwrap_or_default());

    let meta = if resolved_from.is_none() && !alias_set.has_aliases() && warnings.is_empty() {
        None
    } else {
        let totals = capped.as_ref().and_then(|capped| capped.totals);
        let mut meta = Map::new();
        let base = ResultMeta::new(warnings, &[]);
        meta.insert("hasMore".to_owned(), json!(base.has_more));
        meta.insert("warnings".to_owned(), serde_json::to_value(&base.warnings).expect("warnings serialize"));
        if let Some((pages, blocks)) = totals {
            meta.insert("totals".to_owned(), json!({"pages": pages, "blocks": blocks}));
        }
        if let Some(resolved_from) = resolved_from {
            meta.insert("resolvedFrom".to_owned(), resolved_from);
        }
        if let Some(names) = alias_set.resolved_aliases() {
            meta.insert("resolvedAliases".to_owned(), json!(names));
        }
        Some(meta)
    };
    Ok(Outcome { results: capped.map(|capped| capped.results), meta })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(id: i64) -> Value {
        json!({"id": id, "uuid": format!("u{id}")})
    }

    fn source(id: i64, name: &str, blocks: usize) -> Backlink {
        Backlink {
            page: json!({"id": id, "name": name, "originalName": name.to_uppercase()}),
            blocks: (0..blocks as i64).map(|i| block(id * 1000 + i)).collect(),
        }
    }

    fn names(results: &[Backlink]) -> Vec<String> {
        results.iter().map(rank_name).collect()
    }

    #[test]
    fn pages_rank_by_block_count_then_name_then_id() {
        let ranked = rank_backlinks(vec![source(1, "b", 1), source(2, "a", 1), source(3, "c", 3), source(4, "a", 1)]);
        assert_eq!(names(&ranked), ["c", "a", "a", "b"]);
        assert_eq!(ranked.iter().map(|b| rank_id(b) as i64).collect::<Vec<_>>(), [3, 2, 4, 1]);
    }

    #[test]
    fn a_tuple_with_no_page_ranks_and_names_itself_by_its_first_block() {
        let nameless = Backlink { page: Value::Null, blocks: vec![json!({"id": 1, "uuid": "u", "page": {"id": 7, "name": "z", "originalName": "Z"}})] };
        assert_eq!((rank_name(&nameless), rank_id(&nameless), source_name(&nameless)), ("z".to_owned(), 7.0, "Z".to_owned()));
        let bare = Backlink { page: Value::Null, blocks: vec![] };
        assert_eq!((rank_name(&bare), rank_id(&bare), source_name(&bare)), (String::new(), 0.0, "unknown page".to_owned()));
        let id_only = Backlink { page: json!({"id": 5}), blocks: vec![] };
        assert_eq!(source_name(&id_only), "5");
    }

    #[test]
    fn a_result_that_fits_both_caps_is_ranked_and_says_nothing() {
        let capped = cap_backlinks(vec![source(1, "a", 1), source(2, "b", 2)], "t", 20, 10);
        assert_eq!(names(&capped.results), ["b", "a"]);
        assert!(capped.warnings.is_empty() && capped.totals.is_none());
    }

    #[test]
    fn more_pages_than_the_cap_are_cut_with_where_the_cut_fell() {
        let fetched: Vec<Backlink> = (0..25).map(|i| source(i + 1, &format!("p{i:02}"), if i < 3 { 2 } else { 1 })).collect();
        let capped = cap_backlinks(fetched, "Atlas", 20, 10);
        assert_eq!(capped.results.len(), 20);
        assert_eq!(capped.totals, Some((25, 28)));
        let [warning] = &capped.warnings[..] else { panic!("one warning") };
        assert_eq!(warning.code, "pages_truncated");
        assert_eq!(
            warning.message,
            "Showing 20 of 25 source pages, ranked by linking blocks (most first, ties by page name). \
             The last page kept has 1 linking block, the first dropped page has 1. \
             Blocks per page are capped separately by max_blocks_per_page."
        );
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set max_pages to 25 (or higher) to get all 25."));
    }

    #[test]
    fn a_cap_of_zero_keeps_no_page_and_has_no_edge_sentence() {
        let capped = cap_backlinks(vec![source(1, "a", 1)], "t", 0, 10);
        assert!(capped.results.is_empty());
        assert_eq!(
            capped.warnings[0].message,
            "Showing 0 of 1 source pages, ranked by linking blocks (most first, ties by page name). Blocks per page are capped separately by max_blocks_per_page."
        );
    }

    #[test]
    fn blocks_past_the_per_page_cap_are_cut_and_the_page_named() {
        let capped = cap_backlinks(vec![source(1, "a", 12), source(2, "b", 3)], "t", 20, 10);
        assert_eq!(capped.results[0].blocks.len(), 10);
        assert_eq!(capped.totals, Some((2, 15)));
        let [warning] = &capped.warnings[..] else { panic!("one warning") };
        assert_eq!(warning.message, "Showing the first 10 linking blocks of 1 source page with more: \"A\" (12).");
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set max_blocks_per_page to 12 (or higher) to get every block of these pages."));
    }

    #[test]
    fn at_the_per_page_maximum_nothing_can_be_raised() {
        let capped = cap_backlinks(vec![source(1, "a", 60)], "t", 20, 500);
        assert_eq!(capped.results[0].blocks.len(), 50);
        let [warning] = &capped.warnings[..] else { panic!("one warning") };
        assert!(warning.how_to_fetch_all.is_none());
        assert_eq!(
            warning.message,
            "Showing the first 50 linking blocks of 1 source page with more: \"A\" (60). max_blocks_per_page is capped at its maximum of 50 (500 was asked for), \
             so the rest can't be fetched in one call. logseq_get_page with include_children reads a source page whole."
        );
    }

    #[test]
    fn a_raise_that_may_not_come_back_inline_says_so() {
        // 5 pages of 60 blocks each: raising to 50 a page is 250 blocks, past the inline estimate
        let capped = cap_backlinks((0..5).map(|i| source(i + 1, &format!("p{i}"), 60)).collect(), "t", 20, 10);
        let how = capped.warnings[0].how_to_fetch_all.clone().unwrap();
        assert!(how.starts_with("Set max_blocks_per_page to 50 (the maximum) to get 50 per page. A result this large may be saved to a file"), "{how}");
        assert!(how.ends_with("logseq_get_page with include_children reads a source page whole."));
    }

    #[test]
    fn the_pages_that_fit_inline_are_a_prefix_of_the_ranking() {
        let results: Vec<Backlink> = (0..10).map(|i| source(i + 1, "p", 60)).collect();
        assert_eq!(pages_that_fit(&results, 50), 4); // 4 * 50 = 200
        assert_eq!(pages_that_fit(&results, 10), 10);
    }

    #[test]
    fn the_aliased_rows_group_by_source_page_with_blocks_sorted_and_camelized() {
        let row = |id: i64, page: i64| {
            Some(json!({"id": id, "uuid": format!("u{id}"), "path-refs": [], "page": {"id": page, "name": format!("p{page}"), "original-name": format!("P{page}"), "journal-day": 20250101}}))
                .and_then(|v| v.as_object().cloned())
        };
        let groups = group_by_source_page(vec![row(30, 2), row(20, 1), None, row(10, 2), row(20, 1)]);
        assert_eq!(groups.len(), 2);
        // the first page seen first; its blocks by id, and a repeated id once
        assert_eq!(groups[0].page, json!({"id": 2, "name": "p2", "originalName": "P2", "journalDay": 20250101}));
        assert_eq!(groups[0].blocks.iter().map(|b| b["id"].as_i64().unwrap()).collect::<Vec<_>>(), [10, 30]);
        assert_eq!(groups[1].blocks.len(), 1);
        assert_eq!(groups[0].blocks[0]["pathRefs"], json!([]));
        assert_eq!(groups[0].blocks[0]["page"], groups[0].page);
    }

    #[test]
    fn a_row_without_a_page_id_is_skipped() {
        let rows = vec![json!({"id": 1, "uuid": "u"}).as_object().cloned(), json!({"id": 2, "uuid": "u", "page": {"name": "x"}}).as_object().cloned()];
        assert!(group_by_source_page(rows).is_empty());
    }

    #[test]
    fn the_meta_block_carries_the_tips_and_is_absent_with_neither() {
        assert_eq!(meta_content(None, &[]), None);
        assert_eq!(meta_content(None, &["t".to_owned()]).unwrap(), r#"{"meta":{"tips":["t"]}}"#);
        let meta = json!({"hasMore": false, "warnings": []}).as_object().cloned();
        assert_eq!(meta_content(meta.clone(), &[]).unwrap(), r#"{"meta":{"hasMore":false,"warnings":[]}}"#);
        assert_eq!(meta_content(meta, &["t".to_owned()]).unwrap(), r#"{"meta":{"hasMore":false,"warnings":[],"tips":["t"]}}"#);
    }

    #[test]
    fn the_backlinks_schema_means_what_the_typescript_one_means() {
        use crate::tool::testing::{meaning, schema_of};
        // `inputSchema` of logseq_get_backlinks in the ADR-0016 snapshot
        let typescript = json!({
            "type": "object",
            "properties": {
                "page_name": {"type": "string", "description": "Page to get backlinks for (name, alias or ISO date)"},
                "max_pages": {"type": "integer", "minimum": 0, "default": 20, "description": "Max source pages (default: 20, max: 100)"},
                "max_blocks_per_page": {"type": "integer", "minimum": 0, "default": 10, "description": "Max linking blocks per source page (default: 10, max: 50)"},
            },
            "required": ["page_name"],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&typescript));
    }

    #[test]
    fn the_backlinks_tool_is_read_only_and_titled_as_in_typescript() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Get Backlinks"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Get Backlinks", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }
}
