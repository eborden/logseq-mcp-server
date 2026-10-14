//! `logseq_find_blocks`: the blocks that match every filter given, newest first. `text` is a case-insensitive,
//! literal substring of the block's content, `property` with `value` an exact property value, and a period
//! (`start_date` with `end_date`, `last_n` or `preset`) limits the search to the blocks on the journal pages of those
//! days (#491; the two tools it replaces, `search_blocks` and `query_by_property`, each had one of the first two).
//! `page` limits it to the blocks on one page and `links_to` to the blocks that link to every one of 1 to 5 pages,
//! each followed through its alias group (#492; the `references` mode of the removed `search_by_relationship` was both).
//!
//! Calls: 1 (the search query, whatever the filters), or 2 with `include_context` (one batched lookup of the pages the
//! returned blocks sit on, and none when no block has a page id; a `null` answer to it is a
//! `context_unavailable` warning, not blocks with no context, BR-0011). Naming pages adds the calls that find them
//! first (`scope.rs`): one resolver query per distinct name, then one alias-group query for all of them, or none when
//! no page has an alias link. The match runs inside LogSeq
//! (`re-pattern` / `re-find` over the text with its metacharacters escaped; `:block/properties` for the property),
//! results are sorted here, newest first (highest block id), since Datalog here has no `:limit`.
//!
//! The whole match list is read in that one query and cut here into pages (ADR-0038). A page holds at most `limit`
//! hits and at most the character budget (#506, `crate::budget`), the oldest hits last, and when hits are left it
//! carries a `nextCursor` and says so with a `results_truncated` (the count) or `result_size_truncated` (the budget)
//! warning (BR-0006). A call with only that `cursor` reads the next page: from the snapshot the first call kept, with
//! no LogSeq call (`include_context` still reads the pages of the hits it sends), or, when the snapshot is gone,
//! with the first page's calls, resuming by block id after the last hit sent (`cursor_stale` says when the list moved).
//! `find_blocks_with_meta`, the library function, reads the first page only and applies no budget.
//!
//! This directory holds everything only the finder uses: its query (`queries.rs`), the answers it
//! reads (`wire.rs`) and its tip (`tips.rs`). What it shares with other tools is outside it: slim
//! output, entity fields, the paging helpers (`crate::paging`) and the tool helpers.

mod queries;
pub mod scope;
mod tips;
mod wire;

use std::collections::HashMap;
use std::time::Instant;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::args::{Scalar, YyyyMmDd, parse_args};
use crate::budget::{BUDGET_CHARS, size};
use crate::client::LogseqClient;
use crate::cursor::{Anchor, Cursor, Position, SnapshotKey, decode, encode, invalid};
use crate::dates::{CalendarDate, Clock, DatePreset};
use crate::edn::PageId;
use crate::entity::{id_of, page_display_name};
use crate::errors::{InvalidParameter, ToolError};
use crate::meta::{ResultMeta, ResultWarning};
use crate::pages_by_ids::pages_by_ids;
use crate::paging::{Cut, PagedCut, Stale, page_of, paged_warning, refuse_with_cursor, resume_at, serve, stale_warning};
use crate::period::{Period, Selection, resolve_period};
use crate::property::{PropertyFilter, property_filter};
use crate::resolve::RETRY_ADVICE;
use crate::slim::{DEFAULT_SLIM_RESULTS, extract_page_refs, extract_tags, to_slim_block, to_slim_page};
use crate::snapshots::{Snapshots, resident_weight};
use crate::tool::{CursorSchema, input_schema, read_only_annotations, success_result};

use self::queries::Match;
use self::scope::{Notes, Scope, check_names, resolve_scope};
use self::tips::{Others, find_tips};

pub const NAME: &str = "logseq_find_blocks";

/// Results returned when `limit` is absent.
pub const DEFAULT_FIND_LIMIT: u64 = 100;

/// Most results one page holds (#61). A larger `limit` is clamped to it. Through `call`, 500 hits are always past the
/// character budget (a slim hit is at least ~60 characters), so the size cut (`result_size_truncated`) takes the place
/// of the count cut there (#506), and the cursor reads on from where it fell.
pub const MAX_FIND_LIMIT: u64 = 500;

/// The code of the warning for a result cut at `limit`.
const COUNT_CUT: &str = "results_truncated";

/// What the list holds, as a warning says it.
const WHAT: &str = "matching blocks";

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Find blocks, newest first. Filters AND (one or more): text (substring, case-insensitive); page; links_to (1-5 pages; [[x]] or #x, not plain text); property + value (exact); period on journals (start_date + end_date, last_n days or preset). Pages of limit (max 500); hasMore: send only cursor=nextCursor.\n\n\
**Can't find:** synonyms, stems, ranged values, or how pages connect (logseq_explore_network).";

fn default_limit() -> u64 {
    DEFAULT_FIND_LIMIT
}

fn default_slim_results() -> bool {
    DEFAULT_SLIM_RESULTS
}

/// The finder's arguments. Unknown fields are ignored, as in every tool (see `input_schema`). That one filter at
/// least is given, and that `property` and `value` go together, is checked by [`Filters::parse`] before any call.
#[derive(Debug, Deserialize, JsonSchema, PartialEq)]
pub struct Args {
    /// Text to find in block content (case-insensitive, literal)
    pub text: Option<String>,
    /// Only blocks on this page and its aliases (page name, alias or ISO date)
    pub page: Option<String>,
    /// Only blocks that link to every one of these pages, under any of their names: [[x]], #x and #[[x]] count, plain text does not (1 to 5 page names, aliases or ISO dates)
    #[schemars(length(min = 1, max = 5))]
    pub links_to: Option<Vec<String>>,
    /// Block property to match (letters, digits, "-" and "_"; createdAt and created-at are equivalent). Needs value
    pub property: Option<String>,
    /// Exact value of the property. A multi-value property matches if any one value equals it. Needs property
    #[serde(default)]
    #[schemars(with = "Scalar")]
    pub value: Option<Scalar>,
    /// Start date in YYYYMMDD format (e.g., 20251115). Needs end_date
    #[schemars(with = "Option<f64>")]
    pub start_date: Option<YyyyMmDd>,
    /// End date in YYYYMMDD format (e.g., 20251120). Needs start_date
    #[schemars(with = "Option<f64>")]
    pub end_date: Option<YyyyMmDd>,
    /// Only blocks on journal pages in the last N calendar days, today included (whole number, 1+)
    #[schemars(range(min = 1))]
    pub last_n: Option<u64>,
    /// Named period in local time; weeks run Monday to Sunday
    pub preset: Option<DatePreset>,
    /// Page size: most results per call (default: 100, max: 500)
    #[serde(default = "default_limit")]
    pub limit: u64,
    /// Include semantic context (page, references, tags)
    #[serde(default)]
    pub include_context: bool,
    /// Slim blocks (default). false returns full entities
    #[serde(default = "default_slim_results")]
    pub slim_results: bool,
    // No doc comment: the shared description is the type's (`CursorSchema`), and a doc comment would replace it
    #[schemars(with = "Option<CursorSchema>")]
    pub cursor: Option<String>,
}

/// A count a `u32` holds: a larger one is as good as the largest, since `last_n` only ever counts back that many days.
fn saturate(count: u64) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// The filters of a call, checked: at least one, so a call never lists every block in the graph by accident.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Filters {
    /// The text to find. An empty `text` is no filter
    pub text: Option<String>,
    pub property: Option<PropertyFilter>,
    /// The days whose journal pages the blocks must be on
    pub period: Option<Period>,
    /// The `page` and the `links_to` pages, once resolved ([`resolve_scope`]). Empty until [`Filters::scoped`] sets it
    pub scope: Scope,
}

impl Filters {
    /// The filters the arguments name, with `today` as the day a `last_n` or a preset counts from. A `property` without
    /// a `value` (or the reverse), a key LogSeq can't store, a period chosen in no way or in several, a blank page
    /// name, and a call with no filter at all are an `InvalidParameter`, refused before any LogSeq call. The pages
    /// are not resolved yet: that takes calls ([`Filters::scoped`]), and a call that is refused makes none.
    pub fn from_args(args: &Args, today: CalendarDate) -> Result<Filters, InvalidParameter> {
        check_names(args.page.as_deref(), args.links_to.as_deref())?;
        let property = property_filter(args.property.as_deref(), args.value.as_ref())?;
        let selection = Selection {
            start_date: args.start_date.map(|day| day.0),
            end_date: args.end_date.map(|day| day.0),
            last_n: args.last_n.map(saturate),
            preset: args.preset,
        };
        let names_a_page = args.page.is_some() || args.links_to.is_some();
        Filters::assemble(args.text.as_deref(), property, resolve_period(selection, today)?, names_a_page)
    }

    /// The filters of a search with no period, from the arguments that name them ([`Filters::from_args`] checks the
    /// same things for a call).
    pub fn parse(text: Option<&str>, property: Option<&str>, value: Option<&Scalar>) -> Result<Filters, InvalidParameter> {
        Filters::assemble(text, property_filter(property, value)?, None, false)
    }

    /// `names_a_page`: the call has a `page` or `links_to`, which are filters of their own (resolved later).
    fn assemble(text: Option<&str>, property: Option<PropertyFilter>, period: Option<Period>, names_a_page: bool) -> Result<Filters, InvalidParameter> {
        let sent_empty = text == Some("");
        let text = text.filter(|text| !text.is_empty()).map(str::to_owned);
        if text.is_none() && property.is_none() && period.is_none() && !names_a_page {
            return Err(InvalidParameter {
                param: "filters".to_owned(),
                // a model that sent `text: ""` should learn why that was nothing
                value: if sent_empty { "none given: text is empty, so it filters nothing" } else { "none given" }.to_owned(),
                expected: "At least one of: text, page, links_to, property with value, or a period (start_date with end_date, last_n or preset)".to_owned(),
                example: Some("text: \"importer\", or links_to: [\"alice\"], or property: \"status\" with value: \"doing\", or last_n: 7".to_owned()),
            });
        }
        Ok(Filters { text, property, period, scope: Scope::default() })
    }

    /// These filters with the pages of the call resolved.
    pub fn scoped(self, scope: Scope) -> Filters {
        Filters { scope, ..self }
    }

    /// The filters besides `text`, as the tip for a miss names them.
    fn others(&self) -> Others {
        Others {
            property: self.property.is_some(),
            period: self.period.is_some(),
            page: self.scope.page.is_some(),
            links_to: !self.scope.links_to.is_empty(),
        }
    }

    fn matching(&self) -> Match<'_> {
        Match {
            text: self.text.as_deref(),
            page: self.scope.page.as_ref().map(|page| page.ids.as_slice()),
            links_to: self.scope.links_to.iter().map(|group| group.ids.as_slice()).collect(),
            property: self.property.as_ref(),
            period: self.period,
        }
    }

    /// What the blocks are said to be when the search was not answered: "contain "x"", "sit on the page "p"", "link to
    /// "a"", "have the property "k"", "sit on journal pages from 20250101 to 20250107", or the ones that were asked
    /// for, joined by "and".
    fn describe(&self) -> String {
        let mut parts = Vec::new();
        if let Some(text) = &self.text {
            parts.push(format!("contain {}", json!(text)));
        }
        if let Some(page) = &self.scope.page {
            parts.push(format!("sit on the page {}", json!(page.asked)));
        }
        for group in &self.scope.links_to {
            parts.push(format!("link to {}", json!(group.asked)));
        }
        if let Some(filter) = &self.property {
            parts.push(format!("have the property {}", json!(filter.key.as_str())));
        }
        if let Some(period) = &self.period {
            parts.push(format!("sit on journal pages from {} to {}", period.start, period.end));
        }
        parts.join(" and ")
    }
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Find Blocks")
        .with_annotations(read_only_annotations("Find Blocks"))
}

/// What a cursor says about where to read on, once decoded and checked against this tool: the hit the last page ended
/// with and the index of the next one. The arguments come back as [`Args`], parsed again like any other (ADR-0038:
/// nothing in a token is trusted).
struct Resume {
    cursor: Cursor,
    /// The index of the first hit of the next page, in the list as the first call read it
    at: usize,
    /// The id of the last block the page before sent
    anchor: i64,
    /// The token as sent, for a refusal
    token: String,
}

impl Resume {
    fn read(token: &str) -> Result<(Args, Resume), InvalidParameter> {
        let cursor = decode(token, NAME)?;
        let Position::Index { at } = cursor.position else {
            return Err(invalid(token, NAME, "this is not a cursor of this tool: its position is not one hit"));
        };
        let Anchor::Id(anchor) = cursor.anchor else {
            return Err(invalid(token, NAME, "this is not a cursor of this tool: its last hit is not a block id"));
        };
        // The arguments the token holds are read as any call's are. A cursor holds none of its own
        let args = parse_args::<Args>(Some(&cursor.args)).ok().filter(|args| args.cursor.is_none());
        let args = args.ok_or_else(|| invalid(token, NAME, "its arguments are not ones this tool takes"))?;
        Ok((args, Resume { cursor, at, anchor, token: token.to_owned() }))
    }

    /// A token whose arguments no longer make a search: the same refusal as one that doesn't parse.
    fn refuse(&self, reason: &str) -> InvalidParameter {
        invalid(&self.token, NAME, reason)
    }
}

/// The arguments of a search as a cursor carries them: what the call asked, with a `last_n` or a preset as the dates it
/// meant, so a page read again after midnight reads the same days (ADR-0038). Read again by [`Args`].
fn stored_arguments(args: &Args, filters: &Filters) -> Map<String, Value> {
    let mut stored = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            stored.insert(key.to_owned(), value);
        }
    };
    put("text", args.text.as_ref().map(|text| json!(text)));
    put("page", args.page.as_ref().map(|page| json!(page)));
    put("links_to", args.links_to.as_ref().map(|names| json!(names)));
    put("property", args.property.as_ref().map(|property| json!(property)));
    put(
        "value",
        args.value.as_ref().map(|value| match value {
            Scalar::Text(text) => json!(text),
            Scalar::Number(number) => json!(number),
            Scalar::Flag(flag) => json!(flag),
        }),
    );
    put("start_date", filters.period.map(|period| json!(period.start)));
    put("end_date", filters.period.map(|period| json!(period.end)));
    // The limit that is read: a larger one is clamped (so the same search with 600 and with 500 has one token)
    put("limit", Some(json!(args.limit.min(MAX_FIND_LIMIT))));
    put("include_context", Some(json!(args.include_context)));
    put("slim_results", Some(json!(args.slim_results)));
    stored
}

/// What a search read: every matching block, newest first, and what resolving the pages of the call found. This is the
/// list a cursor pages, and what a snapshot keeps.
struct Listing {
    /// `None` when LogSeq answered `null`: the search was not answered (BR-0011)
    matches: Option<Vec<Value>>,
    /// How the pages of the call were read
    notes: Notes,
    /// What the blocks were asked to be ([`Filters::describe`]), for the warning of a search that was not answered
    asked: String,
}

impl Listing {
    /// What the snapshot weighs for the cache's bounds: the matches' JSON length, scaled to the memory a list of
    /// `Value`s takes ([`resident_weight`]).
    fn weight(&self) -> usize {
        resident_weight(self.matches.iter().flatten().map(|block| block.to_string().len()).sum())
    }
}

/// A call: arguments read, the list read (from the snapshot a cursor names, or from LogSeq), then one page of it with
/// its meta and tips. The character budget (#506, #485) is applied here, to the two content blocks the call sends, so
/// the library function the search is read through stays uncut.
///
/// A call with a `cursor` takes no other argument: they are in the token. The page it reads starts where the token's
/// position says, if the last hit the page before sent is just before it, and otherwise right after that hit in block
/// order, with a `cursor_stale` warning (BR-0006).
pub async fn call(client: &LogseqClient, tips_enabled: bool, clock: Clock, snapshots: &Snapshots, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let asked = parse_args::<Args>(arguments.as_ref())?;
    let now = Instant::now();
    let (args, resume) = match asked.cursor.clone() {
        Some(token) => {
            refuse_with_cursor::<Args>(arguments.as_ref())?;
            let (args, resume) = Resume::read(&token)?;
            (args, Some(resume))
        }
        None => (asked, None),
    };
    let filters = Filters::from_args(&args, clock.today()).map_err(|error| resume.as_ref().map_or(error, |resume| resume.refuse("its arguments are not a search this tool makes")))?;
    // The arguments the list was built from: the cursor's own, byte for byte, so the snapshot it names is the one asked for
    let stored = match &resume {
        Some(resume) => resume.cursor.args.clone(),
        None => stored_arguments(&args, &filters),
    };
    let served = serve(snapshots, resume.as_ref().map(|resume| &resume.cursor.snapshot), &stored, now, || listing_of(client, &args, &filters)).await?;
    let listing = &*served.list;
    let first_page = resume.is_none();
    let Some(matches) = &listing.matches else {
        let (results, meta) = unavailable_texts(listing, first_page);
        return Ok(success_result(vec![ContentBlock::text(results), ContentBlock::text(meta)]));
    };

    let total = matches.len();
    let (start, stale) = match &resume {
        None => (0, None),
        Some(resume) => {
            // The list is newest first, so the hits after the anchor are the first ones with a lower id: found by key,
            // which holds when the list gained a newer hit, or lost the anchor itself, since the last page
            let resumed = resume_at(total, resume.at, |at| block_id(&matches[at]) == resume.anchor, || Some(matches.partition_point(|block| block_id(block) >= resume.anchor)));
            (resumed.start, resumed.stale)
        }
    };
    let page_size = args.limit.min(MAX_FIND_LIMIT) as usize;
    // Context is read for the hits the page holds, before the budget cuts them: one call per page
    let reach = page_size.min(total - start);
    let (results, context_missing) = hits_of(client, &matches[start..start + reach], args.include_context, args.slim_results).await?;
    let view = View {
        anchors: matches[start..start + reach].iter().map(block_id).collect(),
        results,
        notes: listing.notes.clone(),
        first_page,
        stale,
        start,
        total,
        page_size,
        include_context: args.include_context,
        slim_results: args.slim_results,
        context_missing,
        others: Others { property: filters.property.is_some(), period: filters.period.is_some(), page: args.page.is_some(), links_to: args.links_to.is_some() },
        text: filters.text.clone(),
        tips_enabled,
        token: Some(Token { args: stored.clone(), key: served.key }),
    };
    let page = page_of(total, start, page_size, |kept| view.size(kept));
    // A list that fits one page needs no snapshot, and a hit is kept already
    if page.next().is_some() {
        served.keep(snapshots, &stored, listing.weight(), now);
    }
    let (results, meta) = view.texts(page.kept, page.cut);
    Ok(success_result(vec![ContentBlock::text(results), ContentBlock::text(meta)]))
}

/// The list of a first call, or of a cursor whose snapshot is gone: the pages named are resolved, then the one search
/// runs. These are the first page's calls and no more, so no call ceiling rises (ADR-0038).
async fn listing_of(client: &LogseqClient, args: &Args, filters: &Filters) -> Result<Listing, ToolError> {
    // The pages, resolved after every argument is checked, so a refusal makes no call
    let scope = resolve_scope(client, args.page.as_deref(), args.links_to.as_deref().unwrap_or_default()).await?;
    read_listing(client, &filters.clone().scoped(scope)).await
}

/// The one search, with the pages of `filters` resolved.
async fn read_listing(client: &LogseqClient, filters: &Filters) -> Result<Listing, ToolError> {
    Ok(Listing { matches: find(client, filters).await?, notes: filters.scope.notes.clone(), asked: filters.describe() })
}

/// The two content blocks of a search LogSeq did not answer: `[]` and the warning, which is no `howToFetchAll`, so
/// there is nothing to read on (BR-0011). No total is claimed, and no tip.
fn unavailable_texts(listing: &Listing, first_page: bool) -> (String, String) {
    let meta = unavailable_meta(listing);
    (
        "[]".to_owned(),
        json!({ "meta": meta_object(&listing.notes, first_page, &meta, &[]) }).to_string(),
    )
}

fn unavailable_meta(listing: &Listing) -> ResultMeta {
    let mut warnings = listing.notes.warnings.clone();
    warnings.push(search_unavailable(&listing.asked));
    ResultMeta::paged(warnings, &[], None)
}

/// The `meta` object: how the pages were read (`resolvedFrom`, `resolvedAliases`) first, then what must not be missed
/// (`hasMore`, `nextCursor`, `warnings`, `totals`), then the tips (BR-0013). How the pages were read is said on the
/// first page only: it describes the request, which the pages after it carry in the cursor.
fn meta_object(notes: &Notes, first_page: bool, meta: &ResultMeta, tips: &[String]) -> Map<String, Value> {
    let mut object = Map::new();
    if first_page {
        object.extend(notes.resolved_from_value().map(|from| ("resolvedFrom".to_owned(), from)));
        object.extend(notes.resolved_aliases_value().map(|aliases| ("resolvedAliases".to_owned(), aliases)));
    }
    let Value::Object(counted) = serde_json::to_value(meta).expect("a result meta serializes") else { unreachable!("a result meta is an object") };
    object.extend(counted);
    if !tips.is_empty() {
        object.insert("tips".into(), json!(tips));
    }
    object
}

/// What a page's cursor is made from: the arguments of the call and the snapshot its list was kept as.
struct Token {
    args: Map<String, Value>,
    key: SnapshotKey,
}

/// One page of hits, and everything its warnings, cursor and tips are made from.
struct View {
    /// The hits the page could hold, as results: slim, or full with `slim_results: false`, with their context
    results: Vec<Value>,
    /// The block id of each of `results`, which is what a cursor names its last hit by
    anchors: Vec<i64>,
    notes: Notes,
    /// Whether this is the first page of a list, which says how its pages were read
    first_page: bool,
    stale: Option<Stale>,
    /// The index of the first of `results` in the list
    start: usize,
    /// Matching blocks in all
    total: usize,
    /// The most hits a page holds: `limit`, clamped
    page_size: usize,
    include_context: bool,
    slim_results: bool,
    /// LogSeq answered `null` to the page lookup of `include_context`
    context_missing: bool,
    /// The filters besides `text`, for the tip of a miss
    others: Others,
    text: Option<String>,
    tips_enabled: bool,
    /// What the next page's cursor carries. None for the library function, which has no snapshots to name
    token: Option<Token>,
}

impl View {
    /// How the page ends when it holds the first `kept` of its hits: not at all when it reaches the last hit of the
    /// list, by the page size when it holds all it could, by the budget otherwise.
    fn cut_at(&self, kept: usize) -> Option<Cut> {
        if self.start + kept >= self.total {
            None
        } else if kept == self.results.len() {
            Some(Cut::Count)
        } else {
            Some(Cut::Size { oversize: false })
        }
    }

    /// The length of the result holding the first `kept` hits, as `call` would send it (what the budget measures).
    fn size(&self, kept: usize) -> usize {
        let (results, meta) = self.texts(kept, self.cut_at(kept));
        size(&results) + size(&meta)
    }

    /// Whether the page, held to `kept` hits and ending as `cut` says, has a cursor to read on with. A page of no hit
    /// has none: a cursor that does not move reads nothing on.
    fn has_next(&self, kept: usize, cut: Option<Cut>) -> bool {
        cut.is_some() && kept > 0 && self.token.is_some()
    }

    /// The cursor that starts at the hit after the first `kept`, which the last of them names.
    fn next_cursor(&self, kept: usize, cut: Option<Cut>) -> Option<String> {
        let token = self.token.as_ref().filter(|_| self.has_next(kept, cut))?;
        let anchor = Anchor::Id(self.anchors[kept - 1]);
        Some(encode(&Cursor::new(NAME, token.args.clone(), Position::Index { at: self.start + kept }, anchor, token.key)))
    }

    /// What a reader can do about a result cut for its size. No parameter raises the budget, and the cursor reads on
    /// (the warning's `howToFetchAll` names it), but a narrower filter makes less to read, and richer hits are bigger
    /// ones, so the settings that make them are named.
    fn size_advice(&self) -> String {
        let richer = match (self.include_context, self.slim_results) {
            (true, true) => " include_context: false makes each hit smaller.",
            (false, false) => " slim_results: true makes each hit smaller.",
            (true, false) => " include_context: false and slim_results: true make each hit smaller.",
            (false, true) => "",
        };
        format!("The oldest matches are the ones left out (newest first). Narrow the filters to read fewer.{richer} No parameter raises the size limit.")
    }

    /// A raise of `limit` to offer beside the cursor, on the first page only (a cursor call can't change it). It is
    /// always an honest offer, since a result that is too large for the budget is cut again and carries a cursor of its own.
    fn raise(&self, cut: Cut) -> Option<String> {
        let more = self.total.min(MAX_FIND_LIMIT as usize);
        (cut == Cut::Count && self.first_page && more > self.page_size)
            .then(|| format!("set limit to {more} for a larger page (a result holds at most {BUDGET_CHARS} characters)."))
    }

    /// The warnings of the page holding the first `kept` hits: how the pages were read, a list that moved, the cut,
    /// and the context that was not read, in that order.
    fn warnings(&self, kept: usize, cut: Option<Cut>) -> Vec<ResultWarning> {
        // What was said about the pages comes first: it is about how the request was read, before what came back
        let mut warnings = self.notes.warnings.clone();
        warnings.extend(self.stale.map(|stale| stale_warning(stale, WHAT)));
        if let Some(cut) = cut {
            let advice = match cut {
                Cut::Size { .. } => self.size_advice(),
                Cut::Count if self.page_size == 0 => "limit is 0, so no hit is returned.".to_owned(),
                Cut::Count => String::new(),
            };
            warnings.push(paged_warning(PagedCut {
                count_code: COUNT_CUT,
                cut,
                what: WHAT,
                start: self.start,
                kept,
                total: self.total,
                advice: &advice,
                raise: self.raise(cut),
                has_next: self.has_next(kept, Some(cut)),
            }));
        }
        if self.context_missing {
            warnings.push(context_unavailable(kept));
        }
        warnings
    }

    /// The meta of the page holding the first `kept` hits.
    fn meta(&self, kept: usize, cut: Option<Cut>) -> ResultMeta {
        ResultMeta::paged(self.warnings(kept, cut), &[("matches", self.total)], self.next_cursor(kept, cut))
    }

    /// The two content blocks of the page holding the first `kept` hits: the results, then the meta with its tips. The
    /// tips read the hits that are sent.
    fn texts(&self, kept: usize, cut: Option<Cut>) -> (String, String) {
        let sent = &self.results[..kept];
        let tips = if self.tips_enabled { find_tips(self.text.as_deref(), self.others, sent, Some(self.total)) } else { Vec::new() };
        let meta = self.meta(kept, cut);
        (serde_json::to_string(sent).expect("results serialize"), json!({ "meta": meta_object(&self.notes, self.first_page, &meta, &tips) }).to_string())
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


/// Find the blocks that match `filters`: the first page of results and their meta (`totals.matches` is the number of
/// matching blocks before `limit`, and a `results_truncated` warning says what `limit` to use to get more). When
/// LogSeq answers `null` the results are `[]` and the meta carries a `search_unavailable` warning, with no
/// `totals.matches` since none is known (BR-0011, #415); no matches is an empty `results` and no warning.
///
/// `limit` is clamped to [`MAX_FIND_LIMIT`]. This is the search before the character budget and before the cursor,
/// which only [`call`] applies (#506, ADR-0038): it reads the first page of the list and keeps no snapshot, so a cut
/// carries no `nextCursor` (`hasMore` is false) and its warning offers the raise of `limit` alone.
pub async fn find_blocks_with_meta(client: &LogseqClient, filters: &Filters, limit: u64, include_context: bool, slim_results: bool) -> Result<SearchResults, ToolError> {
    let listing = read_listing(client, filters).await?;
    let Some(matches) = &listing.matches else { return Ok(SearchResults { results: Vec::new(), meta: unavailable_meta(&listing) }) };
    let page_size = limit.min(MAX_FIND_LIMIT) as usize;
    let shown = page_size.min(matches.len());
    let (results, context_missing) = hits_of(client, &matches[..shown], include_context, slim_results).await?;
    let view = View {
        anchors: matches[..shown].iter().map(block_id).collect(),
        results,
        notes: listing.notes.clone(),
        first_page: true,
        stale: None,
        start: 0,
        total: matches.len(),
        page_size,
        include_context,
        slim_results,
        context_missing,
        others: filters.others(),
        text: None,
        tips_enabled: false,
        token: None,
    };
    let meta = view.meta(shown, view.cut_at(shown));
    Ok(SearchResults { results: view.results, meta })
}

/// The hits of a page as results: slim, or full with `slim_results: false`, each with its `context` when asked. The
/// context of the hits is read for these hits only (one call), so the lookup never covers a hit of another page.
async fn hits_of(client: &LogseqClient, blocks: &[Value], include_context: bool, slim_results: bool) -> Result<(Vec<Value>, bool), ToolError> {
    let (contexts, context_missing) = if include_context { with_page_context(client, blocks).await? } else { (blocks.iter().map(|_| None).collect(), false) };
    let results = blocks
        .iter()
        .zip(&contexts)
        .map(|(block, context)| if slim_results { slim_result(block, context.as_ref()) } else { full_result(block, context.as_ref()) })
        .collect();
    Ok((results, context_missing))
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
/// message. `asked` is what the blocks were asked to be ([`Filters::describe`]).
fn search_unavailable(asked: &str) -> ResultWarning {
    ResultWarning::new(
        SEARCH_UNAVAILABLE,
        format!(
            "LogSeq returned no answer when looking up blocks that {asked} (possibly no graph open or a re-index in progress), \
             so the empty list may not mean nothing matches. {RETRY_ADVICE}"
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

/// The blocks that match `filters`, newest first (highest block id first) and not cut, or `None` when LogSeq
/// answers `null`. One call.
async fn find(client: &LogseqClient, filters: &Filters) -> Result<Option<Vec<Value>>, ToolError> {
    let search = queries::find_blocks(&filters.matching());
    let answer = client.execute_datalog_query(&search.text, &search.inputs).await?;
    let Some(mut matches) = wire::hits(&answer, filters.text.is_some())? else { return Ok(None) };
    // Ids are unique, and a sort that keeps ties in order
    matches.sort_by_key(|block| std::cmp::Reverse(block_id(block)));
    Ok(Some(matches))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::budget::BUDGET_CHARS;
    use crate::cursor::decode;
    use crate::paging::{NEXT_PAGE, Page};
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

    const KEY: SnapshotKey = SnapshotKey { started: 1_760_000_000_000, n: 7 };

    fn token_args() -> Map<String, Value> {
        json!({"text": "x", "limit": 100, "include_context": false, "slim_results": true}).as_object().cloned().unwrap()
    }

    /// A first page whose hits are `results`, out of `total` matches, with a cursor to read on and no tips.
    fn view(results: Vec<Value>, total: usize) -> View {
        View {
            anchors: (0..results.len() as i64).map(|n| 1000 - n).collect(),
            results,
            notes: Notes::default(),
            first_page: true,
            stale: None,
            start: 0,
            total,
            page_size: 100,
            include_context: false,
            slim_results: true,
            context_missing: false,
            others: Others::default(),
            text: Some("x".to_owned()),
            tips_enabled: false,
            token: Some(Token { args: token_args(), key: KEY }),
        }
    }

    /// A slim hit whose content is `length` characters.
    fn hit(length: usize) -> Value {
        json!({"uuid": "u", "content": "x".repeat(length)})
    }

    /// The page the budget and the page size make of a view, and the two texts it sends.
    fn paged(view: &View) -> ((String, String), Page) {
        let page = page_of(view.total, view.start, view.page_size, |kept| view.size(kept));
        (view.texts(page.kept, page.cut), page)
    }

    fn chars(texts: &(String, String)) -> usize {
        size(&texts.0) + size(&texts.1)
    }

    fn meta_of(texts: &(String, String)) -> Value {
        serde_json::from_str::<Value>(&texts.1).unwrap()["meta"].clone()
    }

    fn sent(texts: &(String, String)) -> Vec<Value> {
        serde_json::from_str(&texts.0).unwrap()
    }

    #[test]
    fn an_empty_search_and_a_result_under_the_budget_are_sent_as_the_search_made_them() {
        let empty = View { tips_enabled: true, ..view(Vec::new(), 0) };
        let (texts, page) = paged(&empty);
        assert_eq!(texts.0, "[]");
        assert_eq!(page, Page { start: 0, kept: 0, cut: None });
        assert_eq!(meta_of(&texts), json!({"hasMore": false, "warnings": [], "totals": {"matches": 0}, "tips": [empty_tip()]}));
        let small = view(vec![hit(10), hit(20)], 2);
        let (texts, page) = paged(&small);
        assert_eq!((page.kept, page.cut), (2, None));
        assert_eq!(texts.1, r#"{"meta":{"hasMore":false,"warnings":[],"totals":{"matches":2}}}"#);
    }

    fn empty_tip() -> String {
        find_tips(Some("x"), Others::default(), &[], Some(0))[0].clone()
    }

    #[test]
    fn a_result_exactly_at_the_budget_is_untouched_and_one_character_over_is_cut() {
        let frame = chars(&view(vec![hit(10), hit(10), hit(0)], 3).texts(3, None));
        let exact = view(vec![hit(10), hit(10), hit(BUDGET_CHARS - frame)], 3);
        let (texts, page) = paged(&exact);
        assert_eq!(chars(&texts), BUDGET_CHARS);
        assert_eq!((page.kept, page.cut), (3, None));
        assert_eq!(meta_of(&texts)["warnings"], json!([]));

        let over = view(vec![hit(10), hit(10), hit(BUDGET_CHARS - frame + 1)], 3);
        let (texts, page) = paged(&over);
        assert!(chars(&texts) <= BUDGET_CHARS);
        assert_eq!((page.kept, sent(&texts).len()), (2, 2));
        assert_eq!(meta_of(&texts)["warnings"][0]["code"], "result_size_truncated");
    }

    #[test]
    fn a_cut_keeps_the_most_hits_that_fit_with_its_warning_and_cursor_and_the_newest_first() {
        let hits: Vec<Value> = (0..400).map(|n| json!({"uuid": format!("u{n}"), "content": "x".repeat(200)})).collect();
        let found = View { page_size: 400, ..view(hits, 400) };
        let (texts, page) = paged(&found);
        assert!(chars(&texts) <= BUDGET_CHARS);
        let kept = page.kept;
        assert!(kept > 1 && kept < 400);
        // one more hit would not have fit, with its warning and the cursor that names it
        assert!(found.size(kept + 1) > BUDGET_CHARS);
        let meta = meta_of(&texts);
        assert_eq!(meta["hasMore"], true);
        assert!(meta["nextCursor"].is_string());
        assert_eq!(meta["totals"], json!({"matches": 400}));
        let message = meta["warnings"][0]["message"].as_str().unwrap();
        assert!(message.starts_with(&format!("Showing 1-{kept} of 400 matching blocks: the result was cut to fit 30000 characters")), "{message}");
        assert_eq!(meta["warnings"][0]["howToFetchAll"], NEXT_PAGE);
        assert!(!message.contains("Even those"));
        // the hits are the first ones, whole
        assert_eq!(sent(&texts), found.results[..kept]);
    }

    #[test]
    fn a_single_hit_over_the_budget_is_returned_alone_and_the_first_of_many_says_so_and_moves_the_cursor_past_it() {
        let (one, page) = paged(&view(vec![hit(40_000)], 1));
        assert_eq!((sent(&one).len(), page.cut), (1, None));
        assert_eq!(meta_of(&one)["warnings"], json!([]));

        let (first_over, page) = paged(&view(vec![hit(40_000), hit(5), hit(5)], 3));
        assert_eq!((sent(&first_over).len(), page.next()), (1, Some(1)));
        let meta = meta_of(&first_over);
        assert_eq!(meta["warnings"][0]["code"], "result_size_truncated");
        assert!(meta["warnings"][0]["message"].as_str().unwrap().contains("Showing 1 of 3 matching blocks"));
        assert!(meta["warnings"][0]["message"].as_str().unwrap().contains("Even those are over that size"));
        let cursor = decode(meta["nextCursor"].as_str().unwrap(), NAME).unwrap();
        assert_eq!(cursor.position, Position::Index { at: 1 });
    }

    #[test]
    fn a_page_size_cut_is_the_count_warning_with_the_cursor_first_and_the_raise_beside_it_on_the_first_page_only() {
        let hits: Vec<Value> = (0..100).map(|_| hit(10)).collect();
        let found = View { page_size: 100, ..view(hits, 400) };
        let (texts, page) = paged(&found);
        assert_eq!((page.kept, page.cut), (100, Some(Cut::Count)));
        let meta = meta_of(&texts);
        assert_eq!(meta["hasMore"], true);
        let warning = &meta["warnings"][0];
        assert_eq!(warning["code"], "results_truncated");
        assert_eq!(warning["message"], "Showing 1-100 of 400 matching blocks.");
        assert_eq!(
            warning["howToFetchAll"],
            format!("{NEXT_PAGE} Or set limit to 400 for a larger page (a result holds at most 30000 characters).")
        );
        // a page after the first can't change `limit`, and a limit at the maximum has nothing to raise to
        let later = View { start: 100, first_page: false, ..view((0..100).map(|_| hit(10)).collect(), 400) };
        assert_eq!(meta_of(&paged(&later).0)["warnings"][0]["howToFetchAll"], NEXT_PAGE);
        assert_eq!(meta_of(&paged(&later).0)["warnings"][0]["message"], "Showing 101-200 of 400 matching blocks.");
        let widest = View { page_size: 500, ..view((0..500).map(|_| hit(10)).collect(), 900) };
        assert_eq!(meta_of(&paged(&widest).0)["warnings"][0]["howToFetchAll"], NEXT_PAGE);
        // exactly `limit` matches is no cut
        let exact = View { page_size: 100, ..view((0..100).map(|_| hit(10)).collect(), 100) };
        assert_eq!(meta_of(&paged(&exact).0)["warnings"], json!([]));
    }

    #[test]
    fn a_limit_of_zero_shows_nothing_has_no_cursor_and_offers_the_raise_alone() {
        let nothing = View { page_size: 0, ..view(Vec::new(), 5) };
        let (texts, page) = paged(&nothing);
        assert_eq!((texts.0.as_str(), page.kept, page.next()), ("[]", 0, None));
        let meta = meta_of(&texts);
        // nothing reads on with a cursor, so hasMore is false, and the warning still says how to see the hits
        assert_eq!(meta["hasMore"], false);
        assert!(meta.get("nextCursor").is_none());
        assert_eq!(meta["totals"], json!({"matches": 5}));
        assert_eq!(meta["warnings"][0]["code"], "results_truncated");
        assert_eq!(meta["warnings"][0]["message"], "Showing 0 of 5 matching blocks. limit is 0, so no hit is returned.");
        assert_eq!(meta["warnings"][0]["howToFetchAll"], "Set limit to 5 for a larger page (a result holds at most 30000 characters).");
    }

    #[test]
    fn a_missing_context_warning_counts_the_hits_that_are_sent() {
        let found = View { context_missing: true, page_size: 200, ..view((0..200).map(|_| hit(300)).collect(), 200) };
        let whole = found.meta(200, None);
        assert!(whole.warnings[0].message.contains("the 200 result block(s)"));
        let (texts, page) = paged(&found);
        assert!(page.kept < 200);
        let meta = meta_of(&texts);
        assert_eq!(meta["warnings"][1]["code"], "context_unavailable");
        assert!(meta["warnings"][1]["message"].as_str().unwrap().contains(&format!("the {} result block(s)", page.kept)));
    }

    #[test]
    fn the_budget_counts_the_tips_and_a_tip_reads_the_hits_that_are_sent() {
        let hits: Vec<Value> = (0..400).map(|n| json!({"uuid": format!("u{n}"), "content": "x".repeat(200), "pageName": if n < 100 { "Old Page" } else { "Other Page" }})).collect();
        let found = View { tips_enabled: true, page_size: 400, ..view(hits, 400) };
        let (texts, _) = paged(&found);
        assert!(chars(&texts) <= BUDGET_CHARS);
        let meta = meta_of(&texts);
        assert_eq!(meta["tips"].as_array().unwrap().len(), 1);
        // it matches what the tip tool says of the hits that are sent
        assert_eq!(meta["tips"][0], json!(find_tips(Some("x"), Others::default(), &sent(&texts), Some(400))[0]));
    }

    #[test]
    fn a_search_that_found_nothing_to_read_keeps_its_unavailable_warning_and_no_total() {
        let listing = Listing { matches: None, notes: Notes::default(), asked: "contain \"x\"".to_owned() };
        let texts = unavailable_texts(&listing, true);
        assert_eq!(texts.0, "[]");
        let meta = meta_of(&texts);
        assert_eq!(meta["warnings"][0]["code"], "search_unavailable");
        assert_eq!((meta["totals"].clone(), meta["hasMore"].clone()), (json!({}), json!(false)));
        assert!(meta.get("tips").is_none() && meta.get("nextCursor").is_none());
    }

    #[test]
    fn the_advice_names_what_makes_a_hit_smaller_only_when_the_search_asked_for_more() {
        let mut found = view(Vec::new(), 0);
        assert_eq!(
            found.size_advice(),
            "The oldest matches are the ones left out (newest first). Narrow the filters to read fewer. No parameter raises the size limit."
        );
        found.include_context = true;
        assert!(found.size_advice().contains(" include_context: false makes each hit smaller."));
        found.slim_results = false;
        assert!(found.size_advice().contains(" include_context: false and slim_results: true make each hit smaller."));
        found.include_context = false;
        assert!(found.size_advice().contains(" slim_results: true makes each hit smaller."));
    }

    #[test]
    fn the_next_cursor_names_the_next_hit_and_the_last_one_sent_and_the_last_page_has_none() {
        let hits: Vec<Value> = (0..100).map(|_| hit(10)).collect();
        let (texts, page) = paged(&View { start: 200, first_page: false, ..view(hits, 450) });
        assert_eq!(page.next(), Some(300));
        let meta = meta_of(&texts);
        let cursor = decode(meta["nextCursor"].as_str().unwrap(), NAME).unwrap();
        // the 100 hits ended with the block of id 901 (1000 - 99), so that is the anchor
        assert_eq!(cursor, Cursor::new(NAME, token_args(), Position::Index { at: 300 }, Anchor::Id(901), KEY));
        // the last page, and the library function's page, have none
        let last = View { start: 400, first_page: false, ..view((0..50).map(|_| hit(10)).collect(), 450) };
        assert!(meta_of(&paged(&last).0).get("nextCursor").is_none());
        let library = View { token: None, ..view((0..100).map(|_| hit(10)).collect(), 450) };
        let meta = library.meta(100, library.cut_at(100));
        assert!(!meta.has_more && meta.next_cursor.is_none());
        assert!(meta.warnings[0].how_to_fetch_all.as_deref().unwrap().starts_with("Set limit to 450"));
    }

    #[test]
    fn the_warnings_come_in_order_how_the_pages_were_read_a_list_that_moved_the_cut_and_the_context() {
        let notes = Notes { warnings: vec![ResultWarning::new("alias_lookup_unavailable", "m".into())], ..Notes::default() };
        let found = View { notes, stale: Some(Stale::Moved), context_missing: true, page_size: 2, ..view(vec![hit(5), hit(5)], 9) };
        let codes: Vec<String> = found.warnings(2, Some(Cut::Count)).into_iter().map(|warning| warning.code).collect();
        assert_eq!(codes, ["alias_lookup_unavailable", "cursor_stale", "results_truncated", "context_unavailable"]);
    }

    #[test]
    fn the_budget_counts_characters_not_bytes_through_this_tool() {
        // hits of "é" (2 bytes each): exactly the budget in characters, well over it in bytes
        let accented = |length: usize| json!({"uuid": "u", "content": "é".repeat(length)});
        let frame = chars(&view(vec![accented(10), accented(10), accented(0)], 3).texts(3, None));
        let exact = view(vec![accented(10), accented(10), accented(BUDGET_CHARS - frame)], 3);
        let (texts, _) = paged(&exact);
        assert_eq!(chars(&texts), BUDGET_CHARS);
        assert!(texts.0.len() + texts.1.len() > BUDGET_CHARS + 15_000, "{} bytes", texts.0.len() + texts.1.len());
        assert_eq!(meta_of(&texts)["warnings"], json!([]));

        // one more character is a cut, and what is kept is at most the budget in characters
        let over = view(vec![accented(10), accented(10), accented(BUDGET_CHARS - frame + 1)], 3);
        let (texts, _) = paged(&over);
        assert!(chars(&texts) <= BUDGET_CHARS);
        assert_eq!(sent(&texts).len(), 2);
        assert_eq!(meta_of(&texts)["warnings"][0]["code"], "result_size_truncated");
    }

    #[test]
    fn how_the_pages_were_read_leads_the_meta_of_the_first_page_only_and_the_alias_warnings_stay() {
        let notes = Notes {
            resolved_from: vec![scope::ResolvedFrom { name: "al".into(), matched_by: crate::errors::MatchedBy::Alias, resolved_to: "Alice".into() }],
            resolved_aliases: vec![("Alice".into(), vec!["Al".into(), "Alice".into()])],
            warnings: vec![ResultWarning::new("alias_lookup_unavailable", "m".into())],
        };
        let found = View { notes: notes.clone(), tips_enabled: true, text: None, ..view(vec![hit(10)], 1) };
        let meta = meta_of(&found.texts(1, None));
        let keys: Vec<&str> = meta.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["resolvedFrom", "resolvedAliases", "hasMore", "warnings", "totals", "tips"]);
        assert_eq!(meta["resolvedFrom"], json!([{"name": "al", "matchedBy": "alias", "resolvedTo": "Alice"}]));
        assert_eq!(meta["resolvedAliases"], json!({"Alice": ["Al", "Alice"]}));
        assert_eq!(meta["warnings"][0]["code"], "alias_lookup_unavailable");
        // a page after the first says how the request was read nowhere (the cursor holds it), but a warning that the
        // search may be incomplete is not about the request and stays
        let later = View { notes, first_page: false, ..view(vec![hit(10)], 1) };
        let meta = meta_of(&later.texts(1, None));
        assert_eq!(meta.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(), ["hasMore", "warnings", "totals"]);
        assert_eq!(meta["warnings"][0]["code"], "alias_lookup_unavailable");
        // no pages named: the meta is the one it always was
        let plain = meta_of(&view(vec![hit(10)], 1).texts(1, None));
        assert_eq!(plain.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(), ["hasMore", "warnings", "totals"]);
        // a search that was not answered keeps the alias warning beside its own, and claims no total
        let unanswered = Listing { matches: None, notes: found.notes.clone(), asked: "x".into() };
        let meta = meta_of(&unavailable_texts(&unanswered, true));
        assert_eq!(meta["warnings"].as_array().unwrap().iter().map(|w| w["code"].as_str().unwrap()).collect::<Vec<_>>(), ["alias_lookup_unavailable", "search_unavailable"]);
        assert_eq!(meta["totals"], json!({}));
        assert!(meta.get("resolvedFrom").is_some());
        assert!(meta_of(&unavailable_texts(&unanswered, false)).get("resolvedFrom").is_none());
    }

    #[test]
    fn the_schema_means_what_the_pinned_one_means() {
        // `inputSchema` of logseq_find_blocks in the ADR-0016 snapshot
        let pinned = json!({
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Text to find in block content (case-insensitive, literal)"},
                "page": {"type": "string", "description": "Only blocks on this page and its aliases (page name, alias or ISO date)"},
                "links_to": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "maxItems": 5,
                    "description": "Only blocks that link to every one of these pages, under any of their names: [[x]], #x and #[[x]] count, plain text does not (1 to 5 page names, aliases or ISO dates)"
                },
                "property": {"type": "string", "description": "Block property to match (letters, digits, \"-\" and \"_\"; createdAt and created-at are equivalent). Needs value"},
                "value": {"anyOf": [{"type": "string"}, {"type": "number"}, {"type": "boolean"}], "description": "Exact value of the property. A multi-value property matches if any one value equals it. Needs property"},
                "start_date": {"type": "number", "description": "Start date in YYYYMMDD format (e.g., 20251115). Needs end_date"},
                "end_date": {"type": "number", "description": "End date in YYYYMMDD format (e.g., 20251120). Needs start_date"},
                "last_n": {"type": "integer", "minimum": 1, "description": "Only blocks on journal pages in the last N calendar days, today included (whole number, 1+)"},
                "preset": {
                    "type": "string",
                    "enum": ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "this_year", "year_to_date"],
                    "description": "Named period in local time; weeks run Monday to Sunday"
                },
                "limit": {"type": "integer", "minimum": 0, "default": 100, "description": "Page size: most results per call (default: 100, max: 500)"},
                "include_context": {"type": "boolean", "default": false, "description": "Include semantic context (page, references, tags)"},
                "slim_results": {"type": "boolean", "default": true, "description": "Slim blocks (default). false returns full entities"},
                "cursor": {"type": "string", "description": crate::tool::CURSOR_DESCRIPTION},
            },
            "required": [],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&pinned));
        // there is no `offset`: a cursor reads on (ADR-0038)
        assert!(schema_of::<Args>()["properties"].get("offset").is_none());
    }

    #[test]
    fn the_tool_is_read_only_and_titled_as_pinned() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Find Blocks"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Find Blocks", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }

    #[test]
    fn the_arguments_read_as_the_schema_defaults_say() {
        let defaults = parse_args::<Args>(None).unwrap();
        assert_eq!(
            defaults,
            Args {
                text: None,
                page: None,
                links_to: None,
                property: None,
                value: None,
                start_date: None,
                end_date: None,
                last_n: None,
                preset: None,
                limit: 100,
                include_context: false,
                slim_results: true,
                cursor: None
            }
        );
        assert_eq!(serde_json::from_value::<Args>(json!({})).unwrap(), defaults);
        let with_text = json!({"text": "x", "property": "status", "value": 3});
        let args = parse_args::<Args>(with_text.as_object()).unwrap();
        assert_eq!(args, Args { text: Some("x".into()), property: Some("status".into()), value: Some(Scalar::Number(3.0)), ..defaults });
        // the first argument in schema order that is wrong is the one reported
        let with_period = json!({"start_date": 20250101, "end_date": 20250107.0, "last_n": 3, "preset": "last_week"});
        let args = parse_args::<Args>(with_period.as_object()).unwrap();
        assert_eq!(
            (args.start_date, args.end_date, args.last_n, args.preset),
            (Some(YyyyMmDd(20_250_101)), Some(YyyyMmDd(20_250_107)), Some(3), Some(DatePreset::LastWeek))
        );
        let bad = json!({"slim_results": 0, "limit": "a", "value": []});
        assert_eq!(
            parse_args::<Args>(bad.as_object()).unwrap_err().to_string(),
            "Invalid parameter 'value': []\n\nExpected: a string, a number or a boolean, not an array\nExample: value: \"...\""
        );
        let bad = json!({"text": "x", "slim_results": 0, "limit": "a"});
        assert_eq!(
            parse_args::<Args>(bad.as_object()).unwrap_err().to_string(),
            "Invalid parameter 'limit': \"a\"\n\nExpected: a number, not a string\nExample: limit: 5"
        );
        // `offset` went with the cursor (ADR-0038): it is an unknown field now, which every tool ignores
        assert!(parse_args::<Args>(json!({"text": "x", "offset": 5}).as_object()).is_ok());
    }

    #[test]
    fn every_argument_takes_what_it_says_and_nothing_else() {
        use crate::args::testing::{Takes, sweep};
        let base = json!({"text": "x"});
        sweep::<Args>(json!({}), "text", Takes::Text, false);
        sweep::<Args>(json!({}), "page", Takes::Text, false);
        sweep::<Args>(json!({}), "links_to", Takes::List(scope::MAX_LINKS_TO), false);
        sweep::<Args>(json!({}), "property", Takes::Text, false);
        sweep::<Args>(json!({}), "value", Takes::Scalar, false);
        sweep::<Args>(base.clone(), "start_date", Takes::Date, false);
        sweep::<Args>(base.clone(), "end_date", Takes::Date, false);
        sweep::<Args>(base.clone(), "last_n", Takes::Count(1), false);
        sweep::<Args>(base.clone(), "preset", Takes::Words(&DATE_PRESET_WORDS), false);
        sweep::<Args>(base.clone(), "limit", Takes::Count(0), false);
        sweep::<Args>(base.clone(), "include_context", Takes::Flag, false);
        sweep::<Args>(base.clone(), "slim_results", Takes::Flag, false);
        sweep::<Args>(base, "cursor", Takes::Text, false);
    }

    /// The words `preset` takes, as the schema lists them.
    const DATE_PRESET_WORDS: [&str; 8] = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "this_year", "year_to_date"];

    fn filters(text: Option<&str>, property: Option<&str>, value: Option<Scalar>) -> Result<Filters, String> {
        Filters::parse(text, property, value.as_ref()).map_err(|error| error.to_string())
    }

    /// The filters of a call whose arguments are `arguments`, on 2025-03-12.
    fn from_arguments(arguments: Value) -> Result<Filters, String> {
        let args = parse_args::<Args>(arguments.as_object()).map_err(|error| error.to_string())?;
        Filters::from_args(&args, CalendarDate { year: 2025, month: 3, day: 12 }).map_err(|error| error.to_string())
    }

    #[test]
    fn a_call_with_no_filter_is_refused_and_says_what_a_filter_is() {
        let refusal = "Invalid parameter 'filters': none given\n\nExpected: At least one of: text, page, links_to, property with value, or a period (start_date with end_date, last_n or preset)\n\
                       Example: text: \"importer\", or links_to: [\"alice\"], or property: \"status\" with value: \"doing\", or last_n: 7";
        assert_eq!(filters(None, None, None).unwrap_err(), refusal);
        assert_eq!(from_arguments(json!({"limit": 3})).unwrap_err(), refusal);
        // an empty text is no filter, and the refusal says the text was empty
        let empty = refusal.replace("none given", "none given: text is empty, so it filters nothing");
        assert_eq!(from_arguments(json!({"text": ""})).unwrap_err(), empty);
        assert_eq!(filters(Some(""), None, None).unwrap_err(), empty);
        // white space is text: a block can hold exactly that
        assert_eq!(filters(Some(" "), None, None).unwrap().text.as_deref(), Some(" "));
    }

    #[test]
    fn property_and_value_go_together_and_each_filter_stands_alone() {
        let only_text = filters(Some("x"), None, None).unwrap();
        assert_eq!((only_text.text.as_deref(), only_text.property.is_none()), (Some("x"), true));
        let only_property = filters(None, Some("createdAt"), Some(Scalar::Text("today".into()))).unwrap();
        let property = only_property.property.unwrap();
        assert_eq!((only_property.text, property.key.as_str(), property.value.as_str()), (None, "created-at", "today"));
        let both = filters(Some("x"), Some("status"), Some(Scalar::Flag(true))).unwrap();
        assert_eq!((both.text.as_deref(), both.property.unwrap().value.as_str()), (Some("x"), "true"));
        // one alone is refused, naming the one that is missing, and a bad key before a missing value
        assert!(filters(Some("x"), Some("status"), None).unwrap_err().starts_with("Invalid parameter 'value': missing"));
        assert!(filters(Some("x"), None, Some(Scalar::Text("a".into()))).unwrap_err().starts_with("Invalid parameter 'property': missing"));
        assert!(filters(Some("x"), Some("a b"), None).unwrap_err().starts_with("Invalid parameter 'property': a b"));
    }

    #[test]
    fn a_period_is_a_filter_of_its_own_and_stands_beside_the_others() {
        let only = from_arguments(json!({"preset": "last_week"})).unwrap();
        assert_eq!((only.text, only.property, only.period), (None, None, Some(Period { start: 20250303, end: 20250309 })));
        let all = from_arguments(json!({"text": "x", "property": "status", "value": "doing", "last_n": 7})).unwrap();
        assert_eq!(all.period, Some(Period { start: 20250306, end: 20250312 }));
        assert!(all.text.is_some() && all.property.is_some());
        // no period is none, not a default one
        assert_eq!(from_arguments(json!({"text": "x"})).unwrap().period, None);
        // choosing it no way, or two ways, or by half, is the date range tool's refusal, before a bad property is looked at
        assert!(from_arguments(json!({"text": "x", "last_n": 7, "preset": "today"})).unwrap_err().contains("last_n and preset"));
        assert!(from_arguments(json!({"text": "x", "end_date": 20250101})).unwrap_err().starts_with("Invalid parameter 'start_date': missing"));
        assert!(from_arguments(json!({"property": "a b", "value": "x", "preset": "nope"})).unwrap_err().contains("'preset'"));
        assert!(from_arguments(json!({"property": "a b", "value": "x", "last_n": 7})).unwrap_err().starts_with("Invalid parameter 'property': a b"));
    }

    #[test]
    fn a_last_n_too_large_for_a_count_is_as_good_as_the_largest() {
        let args = parse_args::<Args>(json!({"last_n": 9007199254740991_u64}).as_object()).unwrap();
        assert_eq!(saturate(args.last_n.unwrap()), u32::MAX);
        let filters = Filters::from_args(&args, CalendarDate { year: 2025, month: 3, day: 12 }).unwrap();
        assert_eq!(filters.period.unwrap().end, 20250312);
    }

    #[test]
    fn what_was_asked_is_described_in_the_warning_for_a_search_that_got_no_answer() {
        let text = Filters::parse(Some("a \"b\""), None, None).unwrap();
        assert_eq!(text.describe(), r#"contain "a \"b\"""#);
        let property = Filters::parse(None, Some("createdAt"), Some(&Scalar::Text("x".into()))).unwrap();
        assert_eq!(property.describe(), r#"have the property "created-at""#);
        let both = Filters::parse(Some("x"), Some("status"), Some(&Scalar::Text("x".into()))).unwrap();
        assert_eq!(both.describe(), r#"contain "x" and have the property "status""#);
        // the value is never part of it
        assert!(!both.describe().contains("doing"));
        let period = from_arguments(json!({"text": "x", "start_date": 20250101, "end_date": 20250107})).unwrap();
        assert_eq!(period.describe(), r#"contain "x" and sit on journal pages from 20250101 to 20250107"#);
        assert!(search_unavailable(&text.describe()).message.starts_with(r#"LogSeq returned no answer when looking up blocks that contain "a \"b\"" (possibly"#));
    }

    fn group(asked: &str, ids: &[i64]) -> scope::Group {
        scope::Group { asked: asked.to_owned(), ids: ids.iter().map(|&id| crate::edn::PageId::new(id).unwrap()).collect() }
    }

    #[test]
    fn a_page_or_a_list_of_links_is_a_filter_of_its_own() {
        for arguments in [json!({"page": "Atlas"}), json!({"links_to": ["Alice"]}), json!({"page": "Atlas", "links_to": ["Alice", "Bob"]})] {
            assert!(from_arguments(arguments.clone()).is_ok(), "{arguments}");
        }
        // blank names are refused before any call, the page first, and `text: ""` beside a page is still no text
        assert!(from_arguments(json!({"page": " "})).unwrap_err().starts_with("Invalid parameter 'page': \" \""));
        assert!(from_arguments(json!({"links_to": ["Alice", ""]})).unwrap_err().starts_with("Invalid parameter 'links_to': \"\""));
        assert_eq!(from_arguments(json!({"text": "", "page": "Atlas"})).unwrap().text, None);
        // the bounds of the list are the argument parser's, with the words every list has
        assert_eq!(
            parse_args::<Args>(json!({"links_to": []}).as_object()).unwrap_err().to_string(),
            "Invalid parameter 'links_to': []\n\nExpected: at least 1 item\nExample: links_to: [\"...\"]"
        );
        assert!(parse_args::<Args>(json!({"links_to": ["a", "b", "c", "d", "e", "f"]}).as_object()).unwrap_err().to_string().contains("at most 5 items"));
    }

    #[test]
    fn the_pages_are_in_what_a_search_that_got_no_answer_says_it_asked_for() {
        let scope = Scope { page: Some(group("Atlas", &[1])), links_to: vec![group("alice", &[2]), group("Bob \"b\"", &[3])], notes: Notes::default() };
        let filters = Filters::parse(Some("x"), None, None).unwrap().scoped(scope);
        assert_eq!(filters.describe(), r#"contain "x" and sit on the page "Atlas" and link to "alice" and link to "Bob \"b\"""#);
        let others = filters.others();
        assert!(others.page && others.links_to && !others.property && !others.period);
        // what the query is matched against is the ids of the groups, in the order asked
        let wanted = filters.matching();
        assert_eq!(wanted.page.map(|ids| ids.len()), Some(1));
        assert_eq!(wanted.links_to.iter().map(|ids| ids[0].get()).collect::<Vec<_>>(), [2, 3]);
    }

    // ---- the cursor: what a token holds, and what a call reads back from it

    fn resume_of(arguments: Value) -> (Args, Resume) {
        let args = parse_args::<Args>(arguments.as_object()).unwrap();
        let filters = Filters::from_args(&args, CalendarDate { year: 2025, month: 3, day: 12 }).unwrap();
        let cursor = Cursor::new(NAME, stored_arguments(&args, &filters), Position::Index { at: 100 }, Anchor::Id(4242), KEY);
        Resume::read(&encode(&cursor)).unwrap()
    }

    #[test]
    fn a_period_given_as_last_n_or_a_preset_is_stored_as_its_dates_and_read_back_as_the_same_search() {
        for arguments in [json!({"text": "x", "last_n": 7}), json!({"text": "x", "preset": "last_week"}), json!({"text": "x", "start_date": 20250301, "end_date": 20250307})] {
            let args = parse_args::<Args>(arguments.as_object()).unwrap();
            let filters = Filters::from_args(&args, CalendarDate { year: 2025, month: 3, day: 12 }).unwrap();
            let stored = stored_arguments(&args, &filters);
            assert!(stored.get("last_n").is_none() && stored.get("preset").is_none(), "{stored:?}");
            let period = filters.period.unwrap();
            assert_eq!((stored["start_date"].clone(), stored["end_date"].clone()), (json!(period.start), json!(period.end)));
            // read again a month later, the same days (a `last_n` stored as 7 would now be another week)
            let (again, _) = resume_of(arguments.clone());
            let later = Filters::from_args(&again, CalendarDate { year: 2025, month: 4, day: 20 }).unwrap();
            assert_eq!(later.period, Some(period), "{arguments}");
        }
    }

    #[test]
    fn a_snapshot_is_declared_at_the_memory_its_matches_take_and_nothing_is_declared_for_no_answer() {
        let block = json!({"id": 1, "uuid": "u", "content": "x"});
        let listing = Listing { matches: Some(vec![block.clone(), block.clone()]), notes: Notes::default(), asked: String::new() };
        assert_eq!(listing.weight(), 2 * block.to_string().len() * crate::snapshots::VALUE_RESIDENT_FACTOR);
        assert_eq!(Listing { matches: None, ..listing }.weight(), 0);
    }

    #[test]
    fn a_limit_above_the_maximum_is_stored_as_the_maximum() {
        let stored = |limit: u64| {
            let args = parse_args::<Args>(json!({"text": "x", "limit": limit}).as_object()).unwrap();
            let filters = Filters::from_args(&args, CalendarDate { year: 2025, month: 3, day: 12 }).unwrap();
            stored_arguments(&args, &filters)
        };
        assert_eq!(stored(600), stored(500));
        assert_eq!(stored(600)["limit"], 500);
        assert_eq!(stored(0)["limit"], 0);
        assert_eq!(stored(499)["limit"], 499);
    }

    #[test]
    fn every_argument_survives_the_token() {
        let arguments = json!({
            "text": "importer", "page": "Project Atlas", "links_to": ["Alice", "Bob"], "property": "status", "value": "doing",
            "last_n": 3, "limit": 25, "include_context": true, "slim_results": false
        });
        let (args, resume) = resume_of(arguments);
        assert_eq!(
            args,
            Args {
                text: Some("importer".into()),
                page: Some("Project Atlas".into()),
                links_to: Some(vec!["Alice".into(), "Bob".into()]),
                property: Some("status".into()),
                value: Some(Scalar::Text("doing".into())),
                start_date: Some(YyyyMmDd(20250310)),
                end_date: Some(YyyyMmDd(20250312)),
                last_n: None,
                preset: None,
                limit: 25,
                include_context: true,
                slim_results: false,
                cursor: None
            }
        );
        assert_eq!((resume.at, resume.anchor, resume.cursor.snapshot), (100, 4242, KEY));
        // a number and a flag as the value, which the property filter reads as text
        for (value, text) in [(json!(3), "3"), (json!(true), "true")] {
            let (args, _) = resume_of(json!({"property": "n", "value": value}));
            assert_eq!(args.value.unwrap().to_js_string(), text);
        }
    }

    #[test]
    fn a_token_this_tool_cannot_read_is_refused_by_the_cursor_and_not_by_a_parameter_it_never_sent() {
        let good = Cursor::new(NAME, token_args(), Position::Index { at: 1 }, Anchor::Id(5), KEY);
        let refused = |cursor: Cursor| Resume::read(&encode(&cursor)).err().map(|error| (error.param, error.expected));
        assert!(refused(good.clone()).is_none());
        let (param, expected) = refused(Cursor { position: Position::Sections { blocks: 1, references: 0, related: 0 }, ..good.clone() }).unwrap();
        assert!(param == "cursor" && expected.contains("its position is not one hit"), "{expected}");
        assert!(refused(Cursor { anchor: Anchor::Text("u".into()), ..good.clone() }).unwrap().1.contains("its last hit is not a block id"));
        // arguments that parse as no call of this tool, and one that holds a cursor of its own
        let bad_limit = json!({"text": "x", "limit": "many"}).as_object().cloned().unwrap();
        assert!(refused(Cursor { args: bad_limit, ..good.clone() }).unwrap().1.contains("its arguments are not ones this tool takes"));
        let nested = json!({"text": "x", "cursor": "abc"}).as_object().cloned().unwrap();
        assert!(refused(Cursor { args: nested, ..good.clone() }).unwrap().1.contains("its arguments are not ones this tool takes"));
        // and a token another tool made, or no token at all
        assert!(refused(Cursor { tool: "logseq_find_pages".into(), ..good }).unwrap().1.contains("made by another tool"));
        assert!(Resume::read("not a cursor").is_err());
    }
}
