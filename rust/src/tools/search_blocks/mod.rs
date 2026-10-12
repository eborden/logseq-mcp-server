//! `logseq_search_blocks`: a case-insensitive,
//! literal substring search over block content, newest first.
//!
//! Calls: 1 (the search query), or 2 with `include_context` (one batched lookup of the pages the
//! returned blocks sit on, and none when no block has a page id; a `null` answer to it is a
//! `context_unavailable` warning, not blocks with no context, BR-0011). The match runs inside LogSeq
//! (`re-pattern` / `re-find` over the text with its metacharacters escaped), results are sorted
//! here, newest first (highest block id), and cut to `limit`, since Datalog here has no `:limit`.
//!
//! `call` then cuts the hits to the character budget (#506, `crate::budget`), the oldest first, and says so with a
//! `result_size_truncated` warning that takes the place of the `limit` warning. The warning of a `limit` cut offers a
//! raise only when the raised result fits the budget, which the hits already read show exactly (slim, or full
//! without `include_context`) or as an upper bound (`include_context`, whose pages are read for the hits kept only).
//! `search_blocks_with_meta`, the library function, applies no budget.
//!
//! This directory holds everything only the search uses: its queries (`queries.rs`), the answers it
//! reads (`wire.rs`) and its tip (`tips.rs`). What it shares with other tools is outside it: slim
//! output, entity fields, the truncation warnings and the tool helpers.

mod queries;
mod tips;
mod wire;

use std::collections::HashMap;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::args::parse_args;
use crate::budget::{BUDGET_CHARS, Fit, fit, size};
use crate::client::LogseqClient;
use crate::edn::PageId;
use crate::entity::{id_of, page_display_name};
use crate::errors::ToolError;
use crate::meta::{ResultMeta, ResultWarning};
use crate::pages_by_ids::pages_by_ids;
use crate::resolve::RETRY_ADVICE;
use crate::slim::{DEFAULT_SLIM_RESULTS, extract_page_refs, extract_tags, to_slim_block, to_slim_page};
use crate::tool::{input_schema, read_only_annotations, success_result};
use crate::truncation::{CappedTruncation, SizeCut, blocks_inline_max, capped_truncation_warning, size_truncation_warning};

use self::tips::search_tips;

pub const NAME: &str = "logseq_search_blocks";

/// Results returned when `limit` is absent.
pub const DEFAULT_SEARCH_LIMIT: u64 = 100;

/// Most results one call returns (#61). A larger `limit` is clamped to it. The library function reports a cut at the
/// maximum by a `results_truncated` warning with no `howToFetchAll`; through `call`, 500 hits are always past the
/// character budget (a slim hit is at least ~60 characters), so the size cut (`result_size_truncated`) takes that
/// place (#506).
pub const MAX_SEARCH_LIMIT: u64 = 500;

/// The code of the warning for a result cut at `limit`.
const COUNT_CUT: &str = "results_truncated";

/// How to reach matches past the maximum: no parameter fetches them.
const NARROWER: &str = "Narrow the query to see the rest.";

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Case-insensitive literal substring search over block content, newest first, capped by limit (max 500). Check hasMore and warnings.\n\n\
**Can't find:** synonyms, stems or related words (try variants), blocks by property (logseq_query_by_property), link structure (logseq_search_by_relationship), or over 500 matches in one call (narrow the query).\n\
**Next:** logseq_build_context on a result's page.";

fn default_slim_results() -> bool {
    DEFAULT_SLIM_RESULTS
}

/// The search's arguments. Unknown fields are ignored, as in every tool (see `input_schema`).
#[derive(Debug, Deserialize, JsonSchema, PartialEq)]
pub struct Args {
    /// Text to search for in block content
    pub query: String,
    /// Maximum number of results to return (default: 100, max: 500)
    pub limit: Option<u64>,
    /// Include semantic context (page, references, tags)
    #[serde(default)]
    pub include_context: bool,
    /// Slim blocks (default). false returns full entities
    #[serde(default = "default_slim_results")]
    pub slim_results: bool,
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Search Blocks")
        .with_annotations(read_only_annotations("Search Blocks"))
}

/// A call: arguments read, the search, then its meta and tips. The character budget (#506, #485) is applied here, to
/// the two content blocks the call sends, so the library function the search is read through stays uncut.
pub async fn call(client: &LogseqClient, tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let args = parse_args::<Args>(arguments.as_ref())?;
    let searched = search(client, &args.query, args.limit, args.include_context, args.slim_results).await?.with_raise(tips_enabled, &args.query);
    let (results, meta) = fit_to_budget(&searched, tips_enabled, &args.query);
    Ok(success_result(vec![ContentBlock::text(results), ContentBlock::text(meta)]))
}

/// A cut by the character budget: how many hits were kept, and whether even those are over it (BR-0007).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SizeCutTo {
    kept: usize,
    oversize: bool,
}

/// What the search read, before anything is said about it: the hits kept by `limit`, as results, and what the
/// warnings need.
struct Searched {
    /// Slim blocks, or full ones with `slim_results: false`, already cut to `limit`
    results: Vec<Value>,
    /// Matching blocks before `limit`
    total: usize,
    limit: u64,
    include_context: bool,
    slim_results: bool,
    /// LogSeq answered `null` to the page lookup of `include_context`
    context_missing: bool,
    /// LogSeq answered `null` to the search itself: the query it was asked, for the warning (BR-0011)
    unavailable_for: Option<String>,
    /// When `limit` cut the hits: every hit the search could return (up to [`MAX_SEARCH_LIMIT`]) as a result without
    /// `context`, which the raise advice measures. Empty when `limit` cut nothing.
    plain: Vec<Value>,
    /// What the warning of a `limit` cut says about raising it, once measured ([`Searched::with_raise`])
    raise: Raise,
}

/// What the warning of a `limit` cut says about raising `limit`, given the character budget (BR-0006: a
/// `howToFetchAll` is a promise).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Raise {
    /// Not measured, or the raise to every hit fits: the usual `limit` warning
    Unchecked,
    /// A larger `limit` returns more hits, up to `limit`. `exact` is false with `include_context`, whose pages are
    /// read for the hits kept only, so `limit` is an upper bound and the result may be cut earlier.
    Offer { limit: usize, exact: bool },
    /// No larger `limit` returns more hits: they would not fit the budget
    NoMore,
}

impl Searched {
    /// The warnings of the result holding the first `cut.kept` hits, or all of them without a cut. A size cut counts
    /// the hits against every match, so it replaces the count cap's warning: that one would offer a larger `limit`,
    /// which returns the same first hits cut the same way (BR-0006).
    fn warnings(&self, cut: Option<SizeCutTo>) -> Vec<ResultWarning> {
        if let Some(query) = &self.unavailable_for {
            return vec![search_unavailable(query)];
        }
        let shown = cut.map_or(self.results.len(), |cut| cut.kept);
        let mut warnings = Vec::new();
        match cut {
            Some(SizeCutTo { kept, oversize }) => warnings.push(size_truncation_warning(SizeCut {
                what: "matching blocks",
                kept,
                total: self.total,
                oversize,
                advice: &self.size_advice(),
                how_to_fetch_all: None,
            })),
            None if self.total > self.results.len() => warnings.push(self.count_warning(shown)),
            None => {}
        }
        if self.context_missing {
            warnings.push(context_unavailable(shown));
        }
        warnings
    }

    /// The warning of a `limit` cut that kept `shown` hits. Raising `limit` is offered only where the raised result
    /// fits the character budget; otherwise it would be cut again and the offer would promise hits it cannot give.
    fn count_warning(&self, shown: usize) -> ResultWarning {
        let total = self.total;
        match self.raise {
            Raise::Unchecked => capped_truncation_warning(CappedTruncation {
                what: "matching blocks",
                shown,
                total,
                param: "limit",
                max: MAX_SEARCH_LIMIT as usize,
                narrower: NARROWER,
                requested: Some(self.limit),
                code: "results_truncated",
                inline_max: Some(blocks_inline_max(self.include_context, self.slim_results)),
                paging: None,
            }),
            Raise::NoMore => ResultWarning::new(
                COUNT_CUT,
                format!(
                    "Showing {shown} of {total} matching blocks: a result holds at most {BUDGET_CHARS} characters and no larger limit fits in that, \
                     so the rest can't be fetched in one call. {NARROWER}"
                ),
            ),
            Raise::Offer { limit, exact } => ResultWarning {
                code: COUNT_CUT.to_owned(),
                message: format!("Showing {shown} of {total} matching blocks."),
                how_to_fetch_all: Some(if exact {
                    format!(
                        "Set limit to {limit} to get {limit} of {total}. That is the most that fits: a result holds at most {BUDGET_CHARS} characters, and more hits would be cut. {NARROWER}"
                    )
                } else {
                    format!(
                        "Set limit to {limit} to get up to {limit} of {total}. Each hit comes with its context, which is read for the hits kept only, \
                         so the result may be cut to {BUDGET_CHARS} characters before that. {NARROWER}"
                    )
                }),
            },
        }
    }

    /// The raise `limit` can honestly offer, measured on the hits already read: the most hits (up to the maximum)
    /// whose result, as `call` would send it, fits the budget. Exact for hits without `context`; with `include_context`
    /// the hits are measured without it, so the count is an upper bound. Only a `limit` cut has one.
    fn with_raise(mut self, tips_enabled: bool, query: &str) -> Searched {
        let kept = self.results.len();
        if self.total <= kept || self.plain.is_empty() {
            return self;
        }
        let reachable = self.plain.len();
        let probe = Searched {
            results: self.plain.clone(),
            total: self.total,
            limit: reachable as u64,
            include_context: self.include_context,
            slim_results: self.slim_results,
            context_missing: false,
            unavailable_for: None,
            plain: Vec::new(),
            raise: Raise::Unchecked,
        };
        let most = probe.fitting(tips_enabled, query);
        self.raise = if most <= kept {
            Raise::NoMore
        } else if most >= reachable && !self.include_context {
            Raise::Unchecked
        } else {
            Raise::Offer { limit: most, exact: !self.include_context }
        };
        self
    }

    /// The length of the result holding the first `kept` hits (all of them when `kept` is the number of hits).
    fn size_with(&self, tips_enabled: bool, query: &str, kept: usize) -> usize {
        let (results, meta) = self.texts(tips_enabled, query, (kept < self.results.len()).then_some(SizeCutTo { kept, oversize: false }));
        size(&results) + size(&meta)
    }

    /// The most hits whose result fits the budget (at least the first one, and all of them when they fit).
    fn fitting(&self, tips_enabled: bool, query: &str) -> usize {
        let total = self.results.len();
        match fit(total, 1, |kept| self.size_with(tips_enabled, query, kept)) {
            Fit::Whole => total,
            Fit::Cut { kept, .. } => kept,
        }
    }

    /// What a reader can do about a result cut for its size. No parameter raises the budget or reads on, so the
    /// first thing is a narrower query; richer hits are bigger ones, so the settings that make them are named.
    fn size_advice(&self) -> String {
        let richer = match (self.include_context, self.slim_results) {
            (true, true) => " include_context: false makes each hit smaller.",
            (false, false) => " slim_results: true makes each hit smaller.",
            (true, false) => " include_context: false and slim_results: true make each hit smaller.",
            (false, true) => "",
        };
        format!("The oldest matches are the ones left out (newest first). Narrow the query to see the rest.{richer} No parameter raises this limit.")
    }

    /// The meta of the result holding the first `cut.kept` hits (all of them without a cut).
    fn meta(&self, cut: Option<SizeCutTo>) -> ResultMeta {
        let warnings = self.warnings(cut);
        match self.unavailable_for {
            Some(_) => ResultMeta::new(warnings, &[]),
            None => ResultMeta::new(warnings, &[("matches", self.total)]),
        }
    }

    /// The two content blocks of the call with the first `cut.kept` hits, all of them without a cut: the results,
    /// then the meta with its tips. The tips read the hits that are sent.
    fn texts(&self, tips_enabled: bool, query: &str, cut: Option<SizeCutTo>) -> (String, String) {
        let sent = &self.results[..cut.map_or(self.results.len(), |cut| cut.kept)];
        // No tip for a search LogSeq did not answer: "No match" would say what the warning says it can't
        let tips = if tips_enabled && self.unavailable_for.is_none() { search_tips(query, sent, Some(self.total)) } else { Vec::new() };
        let mut meta = serde_json::to_value(self.meta(cut)).expect("a result meta serializes");
        if !tips.is_empty() {
            meta.as_object_mut().expect("a result meta is an object").insert("tips".into(), json!(tips));
        }
        (serde_json::to_string(sent).expect("results serialize"), json!({ "meta": meta }).to_string())
    }
}

/// The two content blocks as they are when their text fits the character budget, else with the first hits that do.
/// The unit is a hit: it is never cut inside its text (BR-0007), so a first hit over the budget comes back alone,
/// and the warning says so. The budget counts both blocks, the tips included.
fn fit_to_budget(searched: &Searched, tips_enabled: bool, query: &str) -> (String, String) {
    let total = searched.results.len();
    let texts = |cut: Option<SizeCutTo>| searched.texts(tips_enabled, query, cut);
    match fit(total, 1, |kept| searched.size_with(tips_enabled, query, kept)) {
        Fit::Whole => texts(None),
        Fit::Cut { kept, oversize } => texts(Some(SizeCutTo { kept, oversize })),
    }
}

/// The hits of a search and what to say about them.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchResults {
    /// Slim blocks, or full ones with `slim_results: false`. `[]` when LogSeq answered `null`, with a
    /// `search_unavailable` warning in `meta` (BR-0011, #415)
    pub results: Vec<Value>,
    pub meta: ResultMeta,
}

impl SearchResults {
    /// True when LogSeq gave no answer to the search, so `results` is empty because nothing was read.
    pub fn is_unavailable(&self) -> bool {
        self.meta.warnings.iter().any(|warning| warning.code == SEARCH_UNAVAILABLE)
    }

    /// `totals.matches`: the number of matching blocks before `limit`.
    pub fn matches(&self) -> Option<usize> {
        self.meta.totals.get("matches").and_then(Value::as_u64).map(|matches| matches as usize)
    }
}

/// A block's id as the sort reads it (`b.id - a.id`).
fn block_id(block: &Value) -> i64 {
    block.get("id").and_then(crate::wire::whole_number).unwrap_or(0)
}

/// The id of the page a block sits on: `None` when the block carries no page.
fn block_page_id(block: &Value) -> Option<i64> {
    id_of(block.get("page"))
}

/// A page pulled with `[*]` (kebab-case keys), as the camelCase page entity `getAllPages` returns
/// and the slim output reads: the pull's keys, then the Editor API's spellings added. What it builds
/// carries both `originalName` and `original-name`.
fn pulled_page_to_entity(pulled: &Map<String, Value>) -> Map<String, Value> {
    const RENAMED: [&str; 5] = ["original-name", "journal-day", "created-at", "updated-at", "properties-text-values"];
    let mut page: Map<String, Value> = pulled.iter().filter(|(key, _)| !RENAMED.contains(&key.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    if let Some(original) = pulled.get("original-name") {
        page.insert("originalName".into(), original.clone());
        page.insert("original-name".into(), original.clone());
    }
    for (kebab, camel) in [("journal-day", "journalDay"), ("created-at", "createdAt"), ("updated-at", "updatedAt"), ("properties-text-values", "propertiesTextValues")] {
        if let Some(value) = pulled.get(kebab) {
            page.insert(camel.into(), value.clone());
        }
    }
    page
}

/// The code of the warning for a search LogSeq did not answer.
const SEARCH_UNAVAILABLE: &str = "search_unavailable";

/// The search was not answered: `results` is `[]`, but not because nothing matches. No parameter fetches what LogSeq did
/// not answer, so the warning carries no `howToFetchAll` and `hasMore` stays false (BR-0011). The retry advice is in the
/// message.
fn search_unavailable(query: &str) -> ResultWarning {
    ResultWarning::new(
        SEARCH_UNAVAILABLE,
        format!(
            "LogSeq returned no answer when looking up blocks that contain {} (possibly no graph open or a re-index in progress), \
             so the empty list may not mean nothing matches. {RETRY_ADVICE}",
            json!(query)
        ),
    )
}

/// `include_context` could not read the pages of the `count` result blocks: they are returned without `context`.
fn context_unavailable(count: usize) -> ResultWarning {
    ResultWarning::new(
        "context_unavailable",
        format!(
            "LogSeq returned no answer when looking up the pages of the {count} result block(s) (possibly no graph open or a re-index in \
             progress), so their context is missing. This does not mean they have none. {RETRY_ADVICE}"
        ),
    )
}

/// `get_context_for_query` could not read the pages of the `count` keyword hits: a hit keeps the page its own block names, if any.
pub fn hit_pages_unavailable(count: usize) -> ResultWarning {
    ResultWarning::new(
        "hit_pages_unavailable",
        format!(
            "LogSeq returned no answer when looking up the pages of the {count} keyword hit(s) (possibly no graph open or a re-index in \
             progress), so a hit may be listed without its page. This does not mean it has none. {RETRY_ADVICE}"
        ),
    )
}

/// A block and what `include_context` adds to it.
struct Context {
    page: Map<String, Value>,
    references: Vec<String>,
    tags: Vec<String>,
}

/// Each block with its `context` (page, references, tags), from one batched page lookup (not one
/// per block). A block with no page id, or whose page isn't found, gets none. Only the blocks kept
/// are passed, so the lookup covers no more pages than the result shows. The flag is true when LogSeq
/// answered `null` to the lookup (every block then gets none), which is not "no page found" (BR-0011).
///
/// API calls: 1, or 0 when no block has a page id.
async fn with_page_context(client: &LogseqClient, blocks: &[Value]) -> Result<(Vec<Option<Context>>, bool), ToolError> {
    let mut page_ids: Vec<i64> = Vec::new();
    for id in blocks.iter().filter_map(block_page_id) {
        if !page_ids.contains(&id) {
            page_ids.push(id);
        }
    }

    let mut page_by_id: HashMap<i64, Map<String, Value>> = HashMap::new();
    let mut unavailable = false;
    if !page_ids.is_empty() {
        let ids = page_ids.iter().map(|&id| PageId::new(id)).collect::<Result<Vec<_>, _>>()?;
        let query = pages_by_ids(&ids);
        let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
        let rows = wire::page_rows(&answer)?;
        unavailable = rows.is_none();
        for row in rows.unwrap_or_default() {
            let page = pulled_page_to_entity(row.as_object().expect("a checked page is an object"));
            if let Some(id) = page.get("id").and_then(crate::wire::whole_number) {
                page_by_id.insert(id, page);
            }
        }
    }

    let contexts = blocks
        .iter()
        .map(|block| {
            // No page id, or page not found: skip context for this block
            let page = page_by_id.get(&block_page_id(block)?)?;
            let content = block.get("content").and_then(Value::as_str).unwrap_or("");
            Some(Context { page: page.clone(), references: extract_page_refs(content), tags: extract_tags(content) })
        })
        .collect();
    Ok((contexts, unavailable))
}

/// A slim result: the slim block, with its `context` slimmed too. Empty `references` and `tags` are
/// left out (#42): the block is slim, so the lists add only bytes.
fn slim_result(block: &Value, context: Option<&Context>) -> Value {
    let block = block.as_object().expect("a checked block is an object");
    let mut slim = to_slim_block(block, &page_display_name(block.get("page")));
    if let Some(context) = context {
        let mut slim_context = Map::new();
        slim_context.insert("page".into(), Value::Object(to_slim_page(&Value::Object(context.page.clone()))));
        if !context.references.is_empty() {
            slim_context.insert("references".into(), json!(context.references));
        }
        if !context.tags.is_empty() {
            slim_context.insert("tags".into(), json!(context.tags));
        }
        slim.insert("context".into(), Value::Object(slim_context));
    }
    Value::Object(slim)
}

/// A full result: the block as it came, with `context` after it.
fn full_result(block: &Value, context: Option<&Context>) -> Value {
    let mut result = block.clone();
    if let Some(context) = context {
        result.as_object_mut().expect("a checked block is an object").insert(
            "context".into(),
            json!({"page": context.page, "references": context.references, "tags": context.tags}),
        );
    }
    result
}

/// The blocks whose content holds `query`, newest first (highest block id first) and not cut, or
/// `None` when LogSeq answers `null`. One call. `get_context_for_query`'s keyword search reads these
/// itself and does the cutting.
pub async fn find_blocks(client: &LogseqClient, query: &str) -> Result<Option<Vec<Value>>, ToolError> {
    let search = queries::search_blocks(query);
    let answer = client.execute_datalog_query(&search.text, &search.inputs).await?;
    let Some(mut matches) = wire::hits(&answer)? else { return Ok(None) };
    // Ids are unique, and a sort that keeps ties in order
    matches.sort_by_key(|block| std::cmp::Reverse(block_id(block)));
    Ok(Some(matches))
}

/// `blocks` as full results with `context` (page, references, tags) added from one batched page
/// lookup, and whether LogSeq answered `null` to that lookup (the blocks then carry no
/// `context`, and the caller says so with [`hit_pages_unavailable`]). API calls: 1, or 0 when no block has a page id.
pub async fn full_blocks_with_context(client: &LogseqClient, blocks: Vec<Value>) -> Result<(Vec<Value>, bool), ToolError> {
    let (contexts, unavailable) = with_page_context(client, &blocks).await?;
    Ok((blocks.iter().zip(&contexts).map(|(block, context)| full_result(block, context.as_ref())).collect(), unavailable))
}

/// Search blocks for `query`: the results and their meta (`totals.matches` is the number of
/// matching blocks before `limit`, and a `results_truncated` warning says what `limit` to use to get
/// them all). When LogSeq answers `null` the results are `[]` and the meta carries a `search_unavailable`
/// warning, with no `totals.matches` since none is known (BR-0011, #415); no matches is an empty `results` and no
/// warning.
///
/// `limit` (default 100) is clamped to [`MAX_SEARCH_LIMIT`]. The warning never suggests a value above
/// it, and a cut at the maximum carries no `howToFetchAll`, so `hasMore` is false there (BR-0006). This is the
/// search before the character budget, which only [`call`] applies (#506): a result of this function can be longer
/// than the budget, and its `limit` warning does not account for that. Through `call` a cut at the maximum is always
/// a size cut, and a `limit` warning offers only a raise the budget allows.
pub async fn search_blocks_with_meta(
    client: &LogseqClient,
    query: &str,
    limit: Option<u64>,
    include_context: bool,
    slim_results: bool,
) -> Result<SearchResults, ToolError> {
    let searched = search(client, query, limit, include_context, slim_results).await?;
    let meta = searched.meta(None);
    Ok(SearchResults { results: searched.results, meta })
}

/// The search of [`search_blocks_with_meta`], before the warnings are worded and the character budget applied
/// (only [`call`] applies it, #506). API calls: 1, or 2 with `include_context`.
async fn search(client: &LogseqClient, query: &str, limit: Option<u64>, include_context: bool, slim_results: bool) -> Result<Searched, ToolError> {
    let limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT);
    // Newest first (highest block id first)
    let Some(mut matches) = find_blocks(client, query).await? else {
        return Ok(Searched {
            results: Vec::new(),
            total: 0,
            limit,
            include_context,
            slim_results,
            context_missing: false,
            unavailable_for: Some(query.to_owned()),
            plain: Vec::new(),
            raise: Raise::Unchecked,
        });
    };
    let total = matches.len();
    let kept = limit.min(MAX_SEARCH_LIMIT) as usize;
    // The hits `limit` leaves out, up to the maximum, for the raise advice to measure (no call: they are in hand)
    let beyond: Vec<Value> = if total > kept { matches[kept..total.min(MAX_SEARCH_LIMIT as usize)].to_vec() } else { Vec::new() };
    matches.truncate(kept);

    // Page context only for the blocks kept, so the lookup never covers cut ones
    let (contexts, context_missing) = if include_context { with_page_context(client, &matches).await? } else { (matches.iter().map(|_| None).collect(), false) };

    let results = matches
        .iter()
        .zip(&contexts)
        .map(|(block, context)| if slim_results { slim_result(block, context.as_ref()) } else { full_result(block, context.as_ref()) })
        .collect();
    let plain = if beyond.is_empty() {
        Vec::new()
    } else {
        matches.iter().chain(&beyond).map(|block| if slim_results { slim_result(block, None) } else { full_result(block, None) }).collect()
    };
    Ok(Searched { results, total, limit, include_context, slim_results, context_missing, unavailable_for: None, plain, raise: Raise::Unchecked })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::budget::BUDGET_CHARS;
    use crate::tool::testing::{meaning, schema_of};

    #[test]
    fn a_pulled_page_gets_the_editor_spellings_after_its_own_keys() {
        let pulled = json!({
            "id": 5, "original-name": "Alice", "name": "alice", "journal-day": 20250101, "created-at": 7, "updated-at": 8,
            "properties-text-values": {"a": "b"}, "uuid": "u"
        });
        let entity = pulled_page_to_entity(pulled.as_object().unwrap());
        assert_eq!(
            Value::Object(entity).to_string(),
            r#"{"id":5,"name":"alice","uuid":"u","originalName":"Alice","original-name":"Alice","journalDay":20250101,"createdAt":7,"updatedAt":8,"propertiesTextValues":{"a":"b"}}"#
        );
        // a pull without the renamed keys adds none
        let bare = json!({"id": 6, "name": "bob"});
        assert_eq!(Value::Object(pulled_page_to_entity(bare.as_object().unwrap())).to_string(), r#"{"id":6,"name":"bob"}"#);
    }

    fn block(id: i64, content: &str) -> Value {
        json!({"id": id, "uuid": format!("u{id}"), "content": content, "page": {"id": 5, "name": "alice", "original-name": "Alice"}})
    }

    fn context() -> Context {
        let page = json!({"id": 5, "name": "alice", "originalName": "Alice", "original-name": "Alice", "journal?": false});
        Context { page: page.as_object().unwrap().clone(), references: vec!["Bob".into()], tags: vec![] }
    }

    #[test]
    fn a_full_result_is_the_block_as_it_came_with_its_context_after_it() {
        assert_eq!(
            full_result(&block(1, "hi [[Bob]]"), None).to_string(),
            r#"{"id":1,"uuid":"u1","content":"hi [[Bob]]","page":{"id":5,"name":"alice","original-name":"Alice"}}"#
        );
        assert_eq!(
            full_result(&block(1, "hi [[Bob]]"), Some(&context())).to_string(),
            r#"{"id":1,"uuid":"u1","content":"hi [[Bob]]","page":{"id":5,"name":"alice","original-name":"Alice"},"context":{"page":{"id":5,"name":"alice","originalName":"Alice","original-name":"Alice","journal?":false},"references":["Bob"],"tags":[]}}"#
        );
    }

    #[test]
    fn a_slim_result_names_the_page_and_leaves_out_what_is_empty() {
        assert_eq!(
            slim_result(&block(1, "hi [[Bob]] #t"), None).to_string(),
            r##"{"uuid":"u1","content":"hi [[Bob]] #t","pageName":"Alice","tags":["t"],"pageRefs":["Bob"]}"##
        );
        assert_eq!(
            slim_result(&block(1, "hi [[Bob]]"), Some(&context())).to_string(),
            r#"{"uuid":"u1","content":"hi [[Bob]]","pageName":"Alice","pageRefs":["Bob"],"context":{"page":{"name":"alice","originalName":"Alice"},"references":["Bob"]}}"#
        );
    }

    fn searched(results: Vec<Value>, total: usize) -> Searched {
        Searched { results, total, limit: 100, include_context: false, slim_results: true, context_missing: false, unavailable_for: None, plain: Vec::new(), raise: Raise::Unchecked }
    }

    /// A slim hit whose content is `length` characters.
    fn hit(length: usize) -> Value {
        json!({"uuid": "u", "content": "x".repeat(length)})
    }

    fn chars(texts: &(String, String)) -> usize {
        size(&texts.0) + size(&texts.1)
    }

    fn meta_of(texts: &(String, String)) -> Value {
        serde_json::from_str::<Value>(&texts.1).unwrap()["meta"].clone()
    }

    #[test]
    fn an_empty_search_and_a_result_under_the_budget_are_sent_as_the_search_made_them() {
        let empty = fit_to_budget(&searched(Vec::new(), 0), true, "x");
        assert_eq!(empty.0, "[]");
        assert_eq!(meta_of(&empty), json!({"hasMore": false, "warnings": [], "totals": {"matches": 0}, "tips": [empty_tip()]}));
        let small = searched(vec![hit(10), hit(20)], 2);
        assert_eq!(fit_to_budget(&small, false, "x"), small.texts(false, "x", None));
        assert_eq!(small.texts(false, "x", None).1, r#"{"meta":{"hasMore":false,"warnings":[],"totals":{"matches":2}}}"#);
    }

    fn empty_tip() -> String {
        search_tips("x", &[], Some(0))[0].clone()
    }

    #[test]
    fn a_result_exactly_at_the_budget_is_untouched_and_one_character_over_is_cut() {
        let frame = chars(&searched(vec![hit(10), hit(10), hit(0)], 3).texts(false, "x", None));
        let exact = searched(vec![hit(10), hit(10), hit(BUDGET_CHARS - frame)], 3);
        let texts = fit_to_budget(&exact, false, "x");
        assert_eq!(chars(&texts), BUDGET_CHARS);
        assert_eq!(texts, exact.texts(false, "x", None));
        assert_eq!(meta_of(&texts)["warnings"], json!([]));

        let over = searched(vec![hit(10), hit(10), hit(BUDGET_CHARS - frame + 1)], 3);
        let texts = fit_to_budget(&over, false, "x");
        assert!(chars(&texts) <= BUDGET_CHARS);
        assert_eq!(serde_json::from_str::<Vec<Value>>(&texts.0).unwrap().len(), 2);
        assert_eq!(meta_of(&texts)["warnings"][0]["code"], "result_size_truncated");
    }

    #[test]
    fn a_cut_keeps_the_most_hits_that_fit_with_its_warning_and_the_newest_first() {
        let hits: Vec<Value> = (0..400).map(|n| json!({"uuid": format!("u{n}"), "content": "x".repeat(200)})).collect();
        let found = searched(hits, 400);
        let texts = fit_to_budget(&found, false, "x");
        assert!(chars(&texts) <= BUDGET_CHARS);
        let kept = serde_json::from_str::<Vec<Value>>(&texts.0).unwrap().len();
        assert!(kept > 1 && kept < 400);
        // one more hit would not have fit
        let one_more = found.texts(false, "x", Some(SizeCutTo { kept: kept + 1, oversize: false }));
        assert!(chars(&one_more) > BUDGET_CHARS);
        let meta = meta_of(&texts);
        assert_eq!(meta["hasMore"], false);
        assert_eq!(meta["totals"], json!({"matches": 400}));
        let message = meta["warnings"][0]["message"].as_str().unwrap();
        assert!(message.starts_with(&format!("Showing {kept} of 400 matching blocks: the result was cut to fit 30000 characters")), "{message}");
        assert!(meta["warnings"][0].get("howToFetchAll").is_none());
        assert!(!message.contains("Even those"));
        // the hits are the first ones, whole
        assert_eq!(serde_json::from_str::<Vec<Value>>(&texts.0).unwrap(), found.results[..kept]);
    }

    #[test]
    fn a_single_hit_over_the_budget_is_returned_alone_and_the_first_of_many_says_so() {
        let one = fit_to_budget(&searched(vec![hit(40_000)], 1), false, "x");
        assert_eq!(serde_json::from_str::<Vec<Value>>(&one.0).unwrap().len(), 1);
        assert_eq!(meta_of(&one)["warnings"], json!([]));

        let first_over = fit_to_budget(&searched(vec![hit(40_000), hit(5), hit(5)], 3), false, "x");
        assert_eq!(serde_json::from_str::<Vec<Value>>(&first_over.0).unwrap().len(), 1);
        let meta = meta_of(&first_over);
        assert_eq!(meta["warnings"][0]["code"], "result_size_truncated");
        assert!(meta["warnings"][0]["message"].as_str().unwrap().contains("Showing 1 of 3 matching blocks"));
        assert!(meta["warnings"][0]["message"].as_str().unwrap().contains("Even those are over that size"));
    }

    #[test]
    fn a_size_cut_replaces_the_limit_warning_that_would_offer_a_larger_limit() {
        // 300 matches, `limit` kept 200 of 100 characters each (a limit cut that offers a raise), and the size
        // cuts that to fewer: no larger `limit` returns more, so the only warning is the size one (BR-0006)
        let found = searched((0..200).map(|_| hit(200)).collect(), 300);
        let limit_only = found.meta(None);
        assert_eq!(limit_only.warnings[0].code, "results_truncated");
        assert!(limit_only.has_more, "a limit cut below the maximum offers a raise");
        let texts = fit_to_budget(&found, false, "x");
        let meta = meta_of(&texts);
        let codes: Vec<&str> = meta["warnings"].as_array().unwrap().iter().map(|w| w["code"].as_str().unwrap()).collect();
        assert_eq!(codes, ["result_size_truncated"]);
        assert_eq!(meta["hasMore"], false);
        assert_eq!(meta["totals"]["matches"], 300);
        let kept = serde_json::from_str::<Vec<Value>>(&texts.0).unwrap().len();
        assert!(meta["warnings"][0]["message"].as_str().unwrap().starts_with(&format!("Showing {kept} of 300 matching blocks")));
    }

    #[test]
    fn a_missing_context_warning_counts_the_hits_that_are_sent() {
        let mut found = searched((0..200).map(|_| hit(300)).collect(), 200);
        found.context_missing = true;
        let whole = found.meta(None);
        assert!(whole.warnings[0].message.contains("the 200 result block(s)"));
        let texts = fit_to_budget(&found, false, "x");
        let kept = serde_json::from_str::<Vec<Value>>(&texts.0).unwrap().len();
        assert!(kept < 200);
        let meta = meta_of(&texts);
        assert_eq!(meta["warnings"][1]["code"], "context_unavailable");
        assert!(meta["warnings"][1]["message"].as_str().unwrap().contains(&format!("the {kept} result block(s)")));
    }

    #[test]
    fn the_budget_counts_the_tips_and_a_tip_reads_the_hits_that_are_sent() {
        let hits: Vec<Value> = (0..400).map(|n| json!({"uuid": format!("u{n}"), "content": "x".repeat(200), "pageName": if n < 100 { "Old Page" } else { "Other Page" }})).collect();
        let found = searched(hits, 400);
        let texts = fit_to_budget(&found, true, "x");
        assert!(chars(&texts) <= BUDGET_CHARS);
        let meta = meta_of(&texts);
        assert_eq!(meta["tips"].as_array().unwrap().len(), 1);
        // it matches what the tip tool says of the hits that are sent
        let kept = serde_json::from_str::<Vec<Value>>(&texts.0).unwrap();
        assert_eq!(meta["tips"][0], json!(search_tips("x", &kept, Some(400))[0]));
    }

    #[test]
    fn a_search_that_found_nothing_to_read_keeps_its_unavailable_warning_and_no_total() {
        let mut found = searched(Vec::new(), 0);
        found.unavailable_for = Some("x".into());
        let texts = fit_to_budget(&found, true, "x");
        assert_eq!(texts.0, "[]");
        let meta = meta_of(&texts);
        assert_eq!(meta["warnings"][0]["code"], "search_unavailable");
        assert_eq!(meta["totals"], json!({}));
        assert!(meta.get("tips").is_none());
    }

    #[test]
    fn the_advice_names_what_makes_a_hit_smaller_only_when_the_search_asked_for_more() {
        let mut found = searched(Vec::new(), 0);
        assert_eq!(
            found.size_advice(),
            "The oldest matches are the ones left out (newest first). Narrow the query to see the rest. No parameter raises this limit."
        );
        found.include_context = true;
        assert!(found.size_advice().contains(" include_context: false makes each hit smaller."));
        found.slim_results = false;
        assert!(found.size_advice().contains(" include_context: false and slim_results: true make each hit smaller."));
        found.include_context = false;
        assert!(found.size_advice().contains(" slim_results: true makes each hit smaller."));
    }

    /// A search whose `limit` kept the first `kept` of `reachable` hits (each `length` characters) out of `total` matches.
    fn limited(kept: usize, reachable: usize, total: usize, length: usize) -> Searched {
        let plain: Vec<Value> = (0..reachable).map(|n| json!({"uuid": format!("u{n}"), "content": "x".repeat(length)})).collect();
        Searched { results: plain[..kept].to_vec(), total, limit: kept as u64, plain, ..searched(Vec::new(), total) }
    }

    fn count_warning_of(found: Searched) -> ResultWarning {
        let found = found.with_raise(false, "x");
        let shown = found.results.len();
        found.count_warning(shown)
    }

    #[test]
    fn a_raise_that_fits_the_budget_keeps_the_usual_warning() {
        // 30 hits of ~100 characters in all: raising `limit` to 30 returns them all, so "get all 30" is true
        let warning = count_warning_of(limited(10, 30, 30, 100));
        assert_eq!(warning.code, "results_truncated");
        assert!(warning.how_to_fetch_all.as_deref().unwrap().starts_with("Set limit to 30 (or higher) to get all 30."), "{warning:?}");
        // and the warning is the one the library function gives, byte for byte
        let library = limited(10, 30, 30, 100).meta(None);
        assert_eq!(serde_json::to_value(&library.warnings[0]).unwrap(), serde_json::to_value(&warning).unwrap());
    }

    #[test]
    fn a_raise_past_the_budget_offers_only_what_fits() {
        // 200 hits of 300 characters (~65,000): 30 are kept, and raising to 200 would be cut to the most that fit
        let found = limited(30, 200, 200, 300).with_raise(false, "x");
        let Raise::Offer { limit, exact: true } = found.raise else { panic!("{:?}", found.raise) };
        assert!(limit > 30 && limit < 200, "{limit}");
        // that many fit and one more does not, as the call would send them
        let raised = Searched { results: found.plain[..limit].to_vec(), ..limited(limit, 200, 200, 300) };
        assert!(raised.size_with(false, "x", limit) <= BUDGET_CHARS);
        let more = Searched { results: found.plain[..limit + 1].to_vec(), ..limited(limit + 1, 200, 200, 300) };
        assert!(more.size_with(false, "x", limit + 1) > BUDGET_CHARS);
        let warning = found.count_warning(30);
        assert_eq!(warning.code, "results_truncated");
        assert_eq!(warning.message, "Showing 30 of 200 matching blocks.");
        let how = warning.how_to_fetch_all.unwrap();
        assert!(how.starts_with(&format!("Set limit to {limit} to get {limit} of 200. That is the most that fits: a result holds at most 30000 characters")), "{how}");
        assert!(!how.contains("get all"));
    }

    #[test]
    fn when_no_larger_limit_fits_the_warning_offers_none_and_has_more_is_false() {
        // 95 hits of 300 characters are ~30,000 characters: 95 are kept and no `limit` returns more
        let found = limited(95, 300, 300, 300);
        assert!(found.size_with(false, "x", 95) > BUDGET_CHARS - 600, "the kept hits are near the budget");
        let found = found.with_raise(false, "x");
        let shown = found.results.len();
        let warning = found.count_warning(shown);
        assert_eq!(found.raise, Raise::NoMore, "{warning:?}");
        assert_eq!(warning.how_to_fetch_all, None);
        assert!(warning.message.contains("no larger limit fits in that"), "{}", warning.message);
        assert!(!found.meta(None).has_more);
    }

    #[test]
    fn more_than_the_maximum_in_matches_never_offers_the_maximum() {
        // 700 matches, 500 reachable, 100 kept: 500 hits can't fit, so "Set limit to 500 (the maximum)" is never said
        let warning = count_warning_of(limited(100, 500, 700, 200));
        assert!(!warning.how_to_fetch_all.clone().unwrap_or_default().contains("500"), "{warning:?}");
        assert!(!warning.message.contains("get 500"));
        let found = limited(100, 500, 700, 200).with_raise(false, "x");
        assert!(matches!(found.raise, Raise::Offer { limit, .. } if limit > 100 && limit < 500), "{:?}", found.raise);
    }

    #[test]
    fn a_raise_with_context_is_an_upper_bound_and_never_promises_all() {
        // 30 small hits would fit without context, but context is read for the hits kept only: "up to", never "all"
        let mut found = limited(10, 30, 30, 100);
        found.include_context = true;
        let found = found.with_raise(false, "x");
        assert_eq!(found.raise, Raise::Offer { limit: 30, exact: false });
        let how = found.count_warning(10).how_to_fetch_all.unwrap();
        assert!(how.starts_with("Set limit to 30 to get up to 30 of 30."), "{how}");
        assert!(how.contains("may be cut to 30000 characters"), "{how}");
        assert!(!how.contains("get all"));
        // hits that don't fit even without context never will with it
        let mut full = limited(95, 300, 300, 300);
        full.include_context = true;
        assert_eq!(full.with_raise(false, "x").raise, Raise::NoMore);
    }

    #[test]
    fn a_search_with_no_limit_cut_has_no_raise_to_measure() {
        let found = searched(vec![hit(5), hit(5)], 2).with_raise(true, "x");
        assert_eq!(found.raise, Raise::Unchecked);
        assert!(found.meta(None).warnings.is_empty());
    }

    #[test]
    fn the_budget_counts_characters_not_bytes_through_this_tool() {
        // hits of "é" (2 bytes each): exactly the budget in characters, well over it in bytes
        let accented = |length: usize| json!({"uuid": "u", "content": "é".repeat(length)});
        let frame = chars(&searched(vec![accented(10), accented(10), accented(0)], 3).texts(false, "x", None));
        let exact = searched(vec![accented(10), accented(10), accented(BUDGET_CHARS - frame)], 3);
        let texts = fit_to_budget(&exact, false, "x");
        assert_eq!(chars(&texts), BUDGET_CHARS);
        assert!(texts.0.len() + texts.1.len() > BUDGET_CHARS + 15_000, "{} bytes", texts.0.len() + texts.1.len());
        assert_eq!(texts, exact.texts(false, "x", None), "at the budget in characters, so untouched");
        assert_eq!(meta_of(&texts)["warnings"], json!([]));

        // one more character is a cut, and what is kept is at most the budget in characters
        let over = searched(vec![accented(10), accented(10), accented(BUDGET_CHARS - frame + 1)], 3);
        let texts = fit_to_budget(&over, false, "x");
        assert!(chars(&texts) <= BUDGET_CHARS);
        assert_eq!(serde_json::from_str::<Vec<Value>>(&texts.0).unwrap().len(), 2);
        assert_eq!(meta_of(&texts)["warnings"][0]["code"], "result_size_truncated");
    }

    #[test]
    fn the_schema_means_what_the_pinned_one_means() {
        // `inputSchema` of logseq_search_blocks in the ADR-0016 snapshot
        let pinned = json!({
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Text to search for in block content"},
                "limit": {"type": "integer", "minimum": 0, "description": "Maximum number of results to return (default: 100, max: 500)"},
                "include_context": {"type": "boolean", "default": false, "description": "Include semantic context (page, references, tags)"},
                "slim_results": {"type": "boolean", "default": true, "description": "Slim blocks (default). false returns full entities"},
            },
            "required": ["query"],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&pinned));
    }

    #[test]
    fn the_tool_is_read_only_and_titled_as_pinned() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Search Blocks"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Search Blocks", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }

    #[test]
    fn the_arguments_read_as_the_schema_defaults_say() {
        let only_query = json!({"query": "x"});
        let defaults = parse_args::<Args>(only_query.as_object()).unwrap();
        assert_eq!(defaults, Args { query: "x".into(), limit: None, include_context: false, slim_results: true });
        assert_eq!(serde_json::from_value::<Args>(only_query).unwrap(), defaults);
        // the first argument in schema order that is wrong is the one reported
        let bad = json!({"slim_results": 0, "limit": "a"});
        assert_eq!(parse_args::<Args>(bad.as_object()).unwrap_err().to_string(), "Invalid parameter 'query': missing\n\nExpected: a string (required)\nExample: query: \"...\"");
        let bad = json!({"query": "x", "slim_results": 0, "limit": "a"});
        assert_eq!(
            parse_args::<Args>(bad.as_object()).unwrap_err().to_string(),
            "Invalid parameter 'limit': \"a\"\n\nExpected: a number, not a string\nExample: limit: 5"
        );
    }

    #[test]
    fn every_argument_takes_what_it_says_and_nothing_else() {
        use crate::args::testing::{Takes, sweep};
        let base = json!({"query": "x"});
        sweep::<Args>(json!({}), "query", Takes::Text, true);
        sweep::<Args>(base.clone(), "limit", Takes::Count(0), false);
        sweep::<Args>(base.clone(), "include_context", Takes::Flag, false);
        sweep::<Args>(base, "slim_results", Takes::Flag, false);
    }
}
