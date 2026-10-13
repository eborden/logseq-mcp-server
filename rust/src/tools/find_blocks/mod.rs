//! `logseq_find_blocks`: the blocks that match every filter given, newest first. `text` is a case-insensitive,
//! literal substring of the block's content, `property` with `value` an exact property value, and a period
//! (`start_date` with `end_date`, `last_n` or `preset`) limits the search to the blocks on the journal pages of those
//! days (#491; the two tools it replaces, `search_blocks` and `query_by_property`, each had one of the first two).
//! `page` limits it to the blocks on one page and `links_to` to the blocks that link to every one of 1 to 5 pages,
//! each followed through its alias group (#492; the `references` mode of `search_by_relationship` was both).
//!
//! Calls: 1 (the search query, whatever the filters), or 2 with `include_context` (one batched lookup of the pages the
//! returned blocks sit on, and none when no block has a page id; a `null` answer to it is a
//! `context_unavailable` warning, not blocks with no context, BR-0011). Naming pages adds the calls that find them
//! first (`scope.rs`): one resolver query per distinct name, then one alias-group query for all of them, or none when
//! no page has an alias link. The match runs inside LogSeq
//! (`re-pattern` / `re-find` over the text with its metacharacters escaped; `:block/properties` for the property),
//! results are sorted here, newest first (highest block id), and cut to `offset` and `limit`, since Datalog here has no
//! `:limit`.
//!
//! `call` then cuts the hits to the character budget (#506, `crate::budget`), the oldest first, and says so with a
//! `result_size_truncated` warning that takes the place of the `limit` warning. Both warnings name the `offset` that
//! reads on from where the cut fell, so the rest of a long result can always be fetched, a page at a time (BR-0006). The warning of a `limit` cut offers a
//! raise only when the raised result fits the budget, which the hits already read show exactly (slim, or full
//! without `include_context`) or as an upper bound (`include_context`, whose pages are read for the hits kept only).
//! `find_blocks_with_meta`, the library function, applies no budget.
//!
//! This directory holds everything only the finder uses: its query (`queries.rs`), the answers it
//! reads (`wire.rs`) and its tip (`tips.rs`). What it shares with other tools is outside it: slim
//! output, entity fields, the truncation warnings and the tool helpers.

mod period;
mod queries;
pub mod scope;
mod tips;
mod wire;

use std::collections::HashMap;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::args::{Scalar, YyyyMmDd, parse_args};
use crate::budget::{BUDGET_CHARS, Fit, fit, size};
use crate::client::LogseqClient;
use crate::dates::{CalendarDate, Clock, DatePreset};
use crate::edn::PageId;
use crate::entity::{id_of, page_display_name};
use crate::errors::{InvalidParameter, ToolError};
use crate::meta::{ResultMeta, ResultWarning};
use crate::pages_by_ids::pages_by_ids;
use crate::property::{PropertyFilter, property_filter};
use crate::resolve::RETRY_ADVICE;
use crate::slim::{DEFAULT_SLIM_RESULTS, extract_page_refs, extract_tags, to_slim_block, to_slim_page};
use crate::tool::{input_schema, read_only_annotations, success_result};
use crate::tools::query_by_date_range::selection::Selection;
use crate::truncation::{CappedTruncation, Paging, SizeCut, blocks_inline_max, capped_truncation_warning, size_truncation_warning};

use self::period::{Period, resolve_period};
use self::queries::Match;
use self::scope::{Notes, Scope, check_names, resolve_scope};
use self::tips::{Others, find_tips};

pub const NAME: &str = "logseq_find_blocks";

/// Results returned when `limit` is absent.
pub const DEFAULT_FIND_LIMIT: u64 = 100;

/// Most results one call returns (#61). A larger `limit` is clamped to it. The library function reports a cut at the
/// maximum by a `results_truncated` warning with no `howToFetchAll`; through `call`, 500 hits are always past the
/// character budget (a slim hit is at least ~60 characters), so the size cut (`result_size_truncated`) takes that
/// place (#506).
pub const MAX_FIND_LIMIT: u64 = 500;

/// The code of the warning for a result cut at `limit`.
const COUNT_CUT: &str = "results_truncated";

/// How to reach matches past the maximum: no parameter fetches them.
const NARROWER: &str = "Narrow the filters to see the rest.";

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Find blocks, newest first. Filters AND (one or more): text (substring, case-insensitive); page; links_to (1-5 pages; [[x]] or #x, not plain text); property + value (exact); period on journals (start_date + end_date, last_n days or preset). Pages by limit (max 500) and offset: check hasMore.\n\n\
**Can't find:** synonyms, stems, ranged values, or how pages connect (logseq_search_by_relationship).";

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
    /// Maximum number of results to return (default: 100, max: 500)
    #[serde(default = "default_limit")]
    pub limit: u64,
    /// Results to skip, newest first; shifts if the graph changes
    #[serde(default)]
    pub offset: u64,
    /// Include semantic context (page, references, tags)
    #[serde(default)]
    pub include_context: bool,
    /// Slim blocks (default). false returns full entities
    #[serde(default = "default_slim_results")]
    pub slim_results: bool,
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

/// A call: arguments read, the search, then its meta and tips. The character budget (#506, #485) is applied here, to
/// the two content blocks the call sends, so the library function the search is read through stays uncut.
pub async fn call(client: &LogseqClient, tips_enabled: bool, clock: Clock, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let args = parse_args::<Args>(arguments.as_ref())?;
    let filters = Filters::from_args(&args, clock.today())?;
    // The pages, resolved after every argument is checked, so a refusal makes no call
    let scope = resolve_scope(client, args.page.as_deref(), args.links_to.as_deref().unwrap_or_default()).await?;
    let filters = filters.scoped(scope);
    let text = filters.text.as_deref();
    let searched = search(client, &filters, args.limit, args.offset, args.include_context, args.slim_results).await?.with_raise(tips_enabled, text);
    let (results, meta) = fit_to_budget(&searched, tips_enabled, text);
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
    /// Slim blocks, or full ones with `slim_results: false`, from `offset` on and already cut to `limit`
    results: Vec<Value>,
    /// Matching blocks before `offset` and `limit`
    total: usize,
    /// The matches skipped before `results` start: the `offset` asked for, or `total` when it asked for more
    offset: usize,
    limit: u64,
    include_context: bool,
    slim_results: bool,
    /// LogSeq answered `null` to the page lookup of `include_context`
    context_missing: bool,
    /// LogSeq answered `null` to the search itself: what the blocks were asked to be ([`Filters::describe`]), for the
    /// warning (BR-0011)
    unavailable_for: Option<String>,
    /// When `limit` cut the hits: every hit the search could return from `offset` (up to [`MAX_FIND_LIMIT`]) as a result
    /// without `context`, which the raise advice measures. Empty when `limit` cut nothing.
    plain: Vec<Value>,
    /// The filters besides `text`, for the tip of a miss
    others: Others,
    /// What resolving the pages of the call found: which names were not exact, the groups searched, the alias warnings
    notes: Notes,
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
    /// The matches from `offset` on: what a cut leaves out counts against these, not against the ones skipped.
    fn remaining(&self) -> usize {
        self.total.saturating_sub(self.offset)
    }

    /// What the results are of, as a warning says it: the matches, and from which one when some were skipped.
    fn what(&self) -> String {
        if self.offset > 0 { format!("matching blocks from offset {}", self.offset) } else { "matching blocks".to_owned() }
    }

    /// How to read on past the `shown` hits of this result: the `offset` that starts where they end (BR-0006). None for
    /// a result with no hit, since an offset that does not move reads nothing on.
    fn next_page(&self, shown: usize) -> Option<String> {
        (shown > 0).then(|| format!("Set offset to {} for the next page.", self.offset + shown))
    }

    /// The warnings of the result holding the first `cut.kept` hits, or all of them without a cut. A size cut counts
    /// the hits against every match from `offset`, so it replaces the count cap's warning: that one would offer a larger
    /// `limit`, which returns the same first hits cut the same way (BR-0006). Its `howToFetchAll` is the next page.
    fn warnings(&self, cut: Option<SizeCutTo>) -> Vec<ResultWarning> {
        // What was said about the pages comes first: it is about how the request was read, before what came back
        let mut warnings = self.notes.warnings.clone();
        if let Some(asked) = &self.unavailable_for {
            warnings.push(search_unavailable(asked));
            return warnings;
        }
        let shown = cut.map_or(self.results.len(), |cut| cut.kept);
        match cut {
            Some(SizeCutTo { kept, oversize }) => warnings.push(size_truncation_warning(SizeCut {
                what: &self.what(),
                kept,
                total: self.remaining(),
                oversize,
                advice: &self.size_advice(),
                how_to_fetch_all: self.next_page(kept),
            })),
            None if self.remaining() > self.results.len() => warnings.push(self.count_warning(shown)),
            None => {}
        }
        if self.context_missing {
            warnings.push(context_unavailable(shown));
        }
        warnings
    }

    /// The warning of a `limit` cut that kept `shown` hits. The next page is always there to fetch, so it leads;
    /// raising `limit` is the alternative, offered only where the raised result fits the character budget (otherwise it
    /// would be cut again and the offer would promise hits it cannot give).
    fn count_warning(&self, shown: usize) -> ResultWarning {
        let (remaining, what) = (self.remaining(), self.what());
        let next = self.next_page(shown);
        // "Set limit to ..." alone, or as the alternative to the next page
        let lead = next.as_ref().map_or("Set".to_owned(), |next| format!("{next} Or set"));
        match self.raise {
            Raise::Unchecked => capped_truncation_warning(CappedTruncation {
                what: &what,
                shown,
                total: remaining,
                param: "limit",
                max: MAX_FIND_LIMIT as usize,
                narrower: NARROWER,
                requested: Some(self.limit),
                code: COUNT_CUT,
                inline_max: Some(blocks_inline_max(self.include_context, self.slim_results)),
                paging: next.map(|next| Paging { param: "offset", next }),
            }),
            Raise::NoMore => ResultWarning {
                code: COUNT_CUT.to_owned(),
                message: format!(
                    "Showing {shown} of {remaining} {what}: a result holds at most {BUDGET_CHARS} characters, so no larger limit fits in that. \
                     Page through the rest with offset. {NARROWER}"
                ),
                how_to_fetch_all: next,
            },
            Raise::Offer { limit, exact } => ResultWarning {
                code: COUNT_CUT.to_owned(),
                message: format!("Showing {shown} of {remaining} {what}. Page through the rest with offset."),
                how_to_fetch_all: Some(if exact {
                    format!(
                        "{lead} limit to {limit} to get {limit} of {remaining}. That is the most that fits: a result holds at most {BUDGET_CHARS} characters, and more hits would be cut. {NARROWER}"
                    )
                } else {
                    format!(
                        "{lead} limit to {limit} to get up to {limit} of {remaining}. Each hit comes with its context, which is read for the hits kept only, \
                         so the result may be cut to {BUDGET_CHARS} characters before that. {NARROWER}"
                    )
                }),
            },
        }
    }

    /// The raise `limit` can honestly offer, measured on the hits already read: the most hits (up to the maximum)
    /// whose result, as `call` would send it for that `limit`, fits the budget. That result carries the warning of its
    /// own `limit` cut, which is as long as the one measured here, so a `limit` of that many hits comes back whole and
    /// the hit after it would not fit. Exact for hits without `context`; with `include_context` the hits are measured
    /// without it, so the count is an upper bound. Only a `limit` cut has one.
    fn with_raise(mut self, tips_enabled: bool, text: Option<&str>) -> Searched {
        let kept = self.results.len();
        if self.remaining() <= kept || self.plain.is_empty() {
            return self;
        }
        let reachable = self.plain.len();
        // the result of a `limit` of `hits`: those hits, and the warning that more were left
        let at_limit = |hits: usize| Searched {
            results: self.plain[..hits].to_vec(),
            total: self.total,
            offset: self.offset,
            limit: hits as u64,
            include_context: self.include_context,
            slim_results: self.slim_results,
            context_missing: false,
            unavailable_for: None,
            plain: Vec::new(),
            others: self.others,
            notes: self.notes.clone(),
            raise: Raise::Offer { limit: reachable, exact: !self.include_context },
        };
        let most = match fit(reachable, 1, |hits| at_limit(hits).size_with(tips_enabled, text, hits)) {
            Fit::Whole => reachable,
            Fit::Cut { kept, .. } => kept,
        };
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
    fn size_with(&self, tips_enabled: bool, text: Option<&str>, kept: usize) -> usize {
        let (results, meta) = self.texts(tips_enabled, text, (kept < self.results.len()).then_some(SizeCutTo { kept, oversize: false }));
        size(&results) + size(&meta)
    }

    /// What a reader can do about a result cut for its size. No parameter raises the budget, but `offset` reads on
    /// (the warning's `howToFetchAll` names it), and a narrower filter makes less to read; richer hits are bigger ones,
    /// so the settings that make them are named.
    fn size_advice(&self) -> String {
        let richer = match (self.include_context, self.slim_results) {
            (true, true) => " include_context: false makes each hit smaller.",
            (false, false) => " slim_results: true makes each hit smaller.",
            (true, false) => " include_context: false and slim_results: true make each hit smaller.",
            (false, true) => "",
        };
        format!("The oldest matches are the ones left out (newest first). Read on with offset, or narrow the filters.{richer} No parameter raises the size limit.")
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
    fn texts(&self, tips_enabled: bool, text: Option<&str>, cut: Option<SizeCutTo>) -> (String, String) {
        let sent = &self.results[..cut.map_or(self.results.len(), |cut| cut.kept)];
        // No tip for a search LogSeq did not answer: "No match" would say what the warning says it can't
        let tips = if tips_enabled && self.unavailable_for.is_none() { find_tips(text, self.others, sent, Some(self.total)) } else { Vec::new() };
        // BR-0013: how the pages were read (`resolvedFrom`, `resolvedAliases`) first, then what must not be missed
        // (`hasMore`, `warnings`, `totals`), then the tips
        let mut meta = Map::new();
        meta.extend(self.notes.resolved_from_value().map(|from| ("resolvedFrom".to_owned(), from)));
        meta.extend(self.notes.resolved_aliases_value().map(|aliases| ("resolvedAliases".to_owned(), aliases)));
        let Value::Object(counted) = serde_json::to_value(self.meta(cut)).expect("a result meta serializes") else { unreachable!("a result meta is an object") };
        meta.extend(counted);
        if !tips.is_empty() {
            meta.insert("tips".into(), json!(tips));
        }
        (serde_json::to_string(sent).expect("results serialize"), json!({ "meta": meta }).to_string())
    }
}

/// The two content blocks as they are when their text fits the character budget, else with the first hits that do.
/// The unit is a hit: it is never cut inside its text (BR-0007), so a first hit over the budget comes back alone,
/// and the warning says so. The budget counts both blocks, the tips included.
fn fit_to_budget(searched: &Searched, tips_enabled: bool, text: Option<&str>) -> (String, String) {
    let total = searched.results.len();
    let texts = |cut: Option<SizeCutTo>| searched.texts(tips_enabled, text, cut);
    match fit(total, 1, |kept| searched.size_with(tips_enabled, text, kept)) {
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

/// Find the blocks that match `filters`: the results and their meta (`totals.matches` is the number of
/// matching blocks before `limit`, and a `results_truncated` warning says what `limit` to use to get
/// them all). When LogSeq answers `null` the results are `[]` and the meta carries a `search_unavailable`
/// warning, with no `totals.matches` since none is known (BR-0011, #415); no matches is an empty `results` and no
/// warning.
///
/// `limit` is clamped to [`MAX_FIND_LIMIT`]. The warning never suggests a value above
/// it, and a cut at the maximum carries no `howToFetchAll`, so `hasMore` is false there (BR-0006). This is the
/// search before the character budget, which only [`call`] applies (#506): a result of this function can be longer
/// than the budget, and its `limit` warning does not account for that. Through `call` a cut at the maximum is always
/// a size cut, and a `limit` warning offers only a raise the budget allows.
pub async fn find_blocks_with_meta(
    client: &LogseqClient,
    filters: &Filters,
    limit: u64,
    offset: u64,
    include_context: bool,
    slim_results: bool,
) -> Result<SearchResults, ToolError> {
    let searched = search(client, filters, limit, offset, include_context, slim_results).await?;
    let meta = searched.meta(None);
    Ok(SearchResults { results: searched.results, meta })
}

/// The search of [`find_blocks_with_meta`], before the warnings are worded and the character budget applied
/// (only [`call`] applies it, #506). API calls: 1, or 2 with `include_context`.
async fn search(
    client: &LogseqClient,
    filters: &Filters,
    limit: u64,
    offset: u64,
    include_context: bool,
    slim_results: bool,
) -> Result<Searched, ToolError> {
    // Newest first (highest block id first)
    let Some(mut matches) = find(client, filters).await? else {
        return Ok(Searched {
            results: Vec::new(),
            total: 0,
            offset: 0,
            limit,
            include_context,
            slim_results,
            context_missing: false,
            unavailable_for: Some(filters.describe()),
            plain: Vec::new(),
            others: filters.others(),
            notes: filters.scope.notes.clone(),
            raise: Raise::Unchecked,
        });
    };
    let total = matches.len();
    // An offset past the last match reads nothing, and is no more than the end
    let offset = usize::try_from(offset).unwrap_or(usize::MAX).min(total);
    let mut matches = matches.split_off(offset);
    let kept = limit.min(MAX_FIND_LIMIT) as usize;
    // The hits `limit` leaves out, up to the maximum, for the raise advice to measure (no call: they are in hand)
    let beyond: Vec<Value> = if matches.len() > kept { matches[kept..matches.len().min(MAX_FIND_LIMIT as usize)].to_vec() } else { Vec::new() };
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
    Ok(Searched { results, total, offset, limit, include_context, slim_results, context_missing, unavailable_for: None, plain, others: filters.others(), notes: filters.scope.notes.clone(), raise: Raise::Unchecked })
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
        Searched { results, total, offset: 0, limit: 100, include_context: false, slim_results: true, context_missing: false, unavailable_for: None, plain: Vec::new(), others: Others::default(), notes: Notes::default(), raise: Raise::Unchecked }
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
        let empty = fit_to_budget(&searched(Vec::new(), 0), true, Some("x"));
        assert_eq!(empty.0, "[]");
        assert_eq!(meta_of(&empty), json!({"hasMore": false, "warnings": [], "totals": {"matches": 0}, "tips": [empty_tip()]}));
        let small = searched(vec![hit(10), hit(20)], 2);
        assert_eq!(fit_to_budget(&small, false, Some("x")), small.texts(false, Some("x"), None));
        assert_eq!(small.texts(false, Some("x"), None).1, r#"{"meta":{"hasMore":false,"warnings":[],"totals":{"matches":2}}}"#);
    }

    fn empty_tip() -> String {
        find_tips(Some("x"), Others::default(), &[], Some(0))[0].clone()
    }

    #[test]
    fn a_result_exactly_at_the_budget_is_untouched_and_one_character_over_is_cut() {
        let frame = chars(&searched(vec![hit(10), hit(10), hit(0)], 3).texts(false, Some("x"), None));
        let exact = searched(vec![hit(10), hit(10), hit(BUDGET_CHARS - frame)], 3);
        let texts = fit_to_budget(&exact, false, Some("x"));
        assert_eq!(chars(&texts), BUDGET_CHARS);
        assert_eq!(texts, exact.texts(false, Some("x"), None));
        assert_eq!(meta_of(&texts)["warnings"], json!([]));

        let over = searched(vec![hit(10), hit(10), hit(BUDGET_CHARS - frame + 1)], 3);
        let texts = fit_to_budget(&over, false, Some("x"));
        assert!(chars(&texts) <= BUDGET_CHARS);
        assert_eq!(serde_json::from_str::<Vec<Value>>(&texts.0).unwrap().len(), 2);
        assert_eq!(meta_of(&texts)["warnings"][0]["code"], "result_size_truncated");
    }

    #[test]
    fn a_cut_keeps_the_most_hits_that_fit_with_its_warning_and_the_newest_first() {
        let hits: Vec<Value> = (0..400).map(|n| json!({"uuid": format!("u{n}"), "content": "x".repeat(200)})).collect();
        let found = searched(hits, 400);
        let texts = fit_to_budget(&found, false, Some("x"));
        assert!(chars(&texts) <= BUDGET_CHARS);
        let kept = serde_json::from_str::<Vec<Value>>(&texts.0).unwrap().len();
        assert!(kept > 1 && kept < 400);
        // one more hit would not have fit
        let one_more = found.texts(false, Some("x"), Some(SizeCutTo { kept: kept + 1, oversize: false }));
        assert!(chars(&one_more) > BUDGET_CHARS);
        let meta = meta_of(&texts);
        // no parameter raises the size limit, but the next page reads on from where the cut fell
        assert_eq!(meta["hasMore"], true);
        assert_eq!(meta["totals"], json!({"matches": 400}));
        let message = meta["warnings"][0]["message"].as_str().unwrap();
        assert!(message.starts_with(&format!("Showing {kept} of 400 matching blocks: the result was cut to fit 30000 characters")), "{message}");
        assert_eq!(meta["warnings"][0]["howToFetchAll"], format!("Set offset to {kept} for the next page."));
        assert!(!message.contains("Even those"));
        // the hits are the first ones, whole
        assert_eq!(serde_json::from_str::<Vec<Value>>(&texts.0).unwrap(), found.results[..kept]);
    }

    #[test]
    fn a_single_hit_over_the_budget_is_returned_alone_and_the_first_of_many_says_so() {
        let one = fit_to_budget(&searched(vec![hit(40_000)], 1), false, Some("x"));
        assert_eq!(serde_json::from_str::<Vec<Value>>(&one.0).unwrap().len(), 1);
        assert_eq!(meta_of(&one)["warnings"], json!([]));

        let first_over = fit_to_budget(&searched(vec![hit(40_000), hit(5), hit(5)], 3), false, Some("x"));
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
        let texts = fit_to_budget(&found, false, Some("x"));
        let meta = meta_of(&texts);
        let codes: Vec<&str> = meta["warnings"].as_array().unwrap().iter().map(|w| w["code"].as_str().unwrap()).collect();
        assert_eq!(codes, ["result_size_truncated"]);
        assert_eq!(meta["hasMore"], true);
        assert_eq!(meta["totals"]["matches"], 300);
        let kept = serde_json::from_str::<Vec<Value>>(&texts.0).unwrap().len();
        // the next page starts where the kept hits end, which is before where `limit` would have cut
        assert_eq!(meta["warnings"][0]["howToFetchAll"], format!("Set offset to {kept} for the next page."));
        assert!(meta["warnings"][0]["message"].as_str().unwrap().starts_with(&format!("Showing {kept} of 300 matching blocks")));
    }

    #[test]
    fn a_missing_context_warning_counts_the_hits_that_are_sent() {
        let mut found = searched((0..200).map(|_| hit(300)).collect(), 200);
        found.context_missing = true;
        let whole = found.meta(None);
        assert!(whole.warnings[0].message.contains("the 200 result block(s)"));
        let texts = fit_to_budget(&found, false, Some("x"));
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
        let texts = fit_to_budget(&found, true, Some("x"));
        assert!(chars(&texts) <= BUDGET_CHARS);
        let meta = meta_of(&texts);
        assert_eq!(meta["tips"].as_array().unwrap().len(), 1);
        // it matches what the tip tool says of the hits that are sent
        let kept = serde_json::from_str::<Vec<Value>>(&texts.0).unwrap();
        assert_eq!(meta["tips"][0], json!(find_tips(Some("x"), Others::default(), &kept, Some(400))[0]));
    }

    #[test]
    fn a_search_that_found_nothing_to_read_keeps_its_unavailable_warning_and_no_total() {
        let mut found = searched(Vec::new(), 0);
        found.unavailable_for = Some("x".into());
        let texts = fit_to_budget(&found, true, Some("x"));
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
            "The oldest matches are the ones left out (newest first). Read on with offset, or narrow the filters. No parameter raises the size limit."
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
        let found = found.with_raise(false, Some("x"));
        let shown = found.results.len();
        found.count_warning(shown)
    }

    #[test]
    fn a_raise_that_fits_the_budget_keeps_the_usual_warning() {
        // 30 hits of ~100 characters in all: raising `limit` to 30 returns them all, so "get all 30" is true
        let warning = count_warning_of(limited(10, 30, 30, 100));
        assert_eq!(warning.code, "results_truncated");
        assert_eq!(warning.message, "Showing 10 of 30 matching blocks. Page through the rest with offset.");
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some("Set offset to 10 for the next page. Or set limit to 30 (or higher) to get all 30 in one call."),
            "{warning:?}"
        );
        // and the warning is the one the library function gives, byte for byte
        let library = limited(10, 30, 30, 100).meta(None);
        assert_eq!(serde_json::to_value(&library.warnings[0]).unwrap(), serde_json::to_value(&warning).unwrap());
    }

    #[test]
    fn a_raise_past_the_budget_offers_only_what_fits() {
        // 200 hits of 300 characters (~65,000): 30 are kept, and raising to 200 would be cut to the most that fit
        let found = limited(30, 200, 200, 300).with_raise(false, Some("x"));
        let Raise::Offer { limit, exact: true } = found.raise else { panic!("{:?}", found.raise) };
        assert!(limit > 30 && limit < 200, "{limit}");
        // that many fit and one more does not, as the call would send them
        let raised = Searched { results: found.plain[..limit].to_vec(), ..limited(limit, 200, 200, 300) };
        assert!(raised.size_with(false, Some("x"), limit) <= BUDGET_CHARS);
        let more = Searched { results: found.plain[..limit + 1].to_vec(), ..limited(limit + 1, 200, 200, 300) };
        assert!(more.size_with(false, Some("x"), limit + 1) > BUDGET_CHARS);
        let warning = found.count_warning(30);
        assert_eq!(warning.code, "results_truncated");
        assert_eq!(warning.message, "Showing 30 of 200 matching blocks. Page through the rest with offset.");
        let how = warning.how_to_fetch_all.unwrap();
        assert!(
            how.starts_with(&format!(
                "Set offset to 30 for the next page. Or set limit to {limit} to get {limit} of 200. That is the most that fits: a result holds at most 30000 characters"
            )),
            "{how}"
        );
        assert!(!how.contains("get all"));
    }

    #[test]
    fn when_no_larger_limit_fits_the_warning_offers_the_next_page_alone() {
        // 95 hits of 300 characters are ~30,000 characters: 95 are kept and no `limit` returns more
        let found = limited(95, 300, 300, 300);
        assert!(found.size_with(false, Some("x"), 95) > BUDGET_CHARS - 600, "the kept hits are near the budget");
        let found = found.with_raise(false, Some("x"));
        let shown = found.results.len();
        let warning = found.count_warning(shown);
        assert_eq!(found.raise, Raise::NoMore, "{warning:?}");
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set offset to 95 for the next page."));
        assert!(warning.message.contains("no larger limit fits in that"), "{}", warning.message);
        assert!(!warning.message.contains("Set limit"), "no raise is offered: {}", warning.message);
        assert!(found.meta(None).has_more, "the next page can be fetched");
    }

    #[test]
    fn more_than_the_maximum_in_matches_never_offers_the_maximum() {
        // 700 matches, 500 reachable, 100 kept: 500 hits can't fit, so "Set limit to 500 (the maximum)" is never said
        let warning = count_warning_of(limited(100, 500, 700, 200));
        assert!(!warning.how_to_fetch_all.clone().unwrap_or_default().contains("500"), "{warning:?}");
        assert!(!warning.message.contains("get 500"));
        let found = limited(100, 500, 700, 200).with_raise(false, Some("x"));
        assert!(matches!(found.raise, Raise::Offer { limit, .. } if limit > 100 && limit < 500), "{:?}", found.raise);
    }

    #[test]
    fn a_raise_with_context_is_an_upper_bound_and_never_promises_all() {
        // 30 small hits would fit without context, but context is read for the hits kept only: "up to", never "all"
        let mut found = limited(10, 30, 30, 100);
        found.include_context = true;
        let found = found.with_raise(false, Some("x"));
        assert_eq!(found.raise, Raise::Offer { limit: 30, exact: false });
        let how = found.count_warning(10).how_to_fetch_all.unwrap();
        assert!(how.starts_with("Set offset to 10 for the next page. Or set limit to 30 to get up to 30 of 30."), "{how}");
        assert!(how.contains("may be cut to 30000 characters"), "{how}");
        assert!(!how.contains("get all"));
        // hits that don't fit even without context never will with it
        let mut full = limited(95, 300, 300, 300);
        full.include_context = true;
        assert_eq!(full.with_raise(false, Some("x")).raise, Raise::NoMore);
    }

    #[test]
    fn a_search_with_no_limit_cut_has_no_raise_to_measure() {
        let found = searched(vec![hit(5), hit(5)], 2).with_raise(true, Some("x"));
        assert_eq!(found.raise, Raise::Unchecked);
        assert!(found.meta(None).warnings.is_empty());
    }

    /// A search whose `offset` skipped `offset` of the `total` matches and whose `limit` kept `kept` hits of `length`
    /// characters, with `reachable` hits from the offset on in hand for the raise advice.
    fn paged(offset: usize, kept: usize, reachable: usize, total: usize, length: usize) -> Searched {
        Searched { offset, ..limited(kept, reachable, total, length) }
    }

    #[test]
    fn an_offset_counts_a_limit_cut_against_the_matches_from_it_and_names_the_next_page() {
        // 400 matches, 120 skipped, 50 of the 280 left are shown: "get all" would mean those 280, not 400
        let found = paged(120, 50, 280, 400, 100).with_raise(false, Some("x"));
        let warning = found.count_warning(50);
        assert_eq!(warning.code, "results_truncated");
        assert_eq!(warning.message, "Showing 50 of 280 matching blocks from offset 120. Page through the rest with offset.");
        let how = warning.how_to_fetch_all.unwrap();
        assert!(how.starts_with("Set offset to 170 for the next page. Or set limit to "), "{how}");
        assert!(how.contains(" of 280."), "{how}");
        // the totals still count every match, skipped ones included
        assert_eq!(found.meta(None).totals["matches"], 400);
    }

    #[test]
    fn an_offset_that_reaches_the_end_has_no_warning_and_one_past_it_is_the_end() {
        // the last 5 of 125 matches, and the offset that is exactly the total: neither is a cut
        let last = paged(120, 5, 5, 125, 100);
        assert_eq!(last.remaining(), 5);
        assert!(last.meta(None).warnings.is_empty());
        let end = Searched { offset: 125, ..searched(Vec::new(), 125) };
        assert_eq!(end.remaining(), 0);
        let meta = end.meta(None);
        assert!(meta.warnings.is_empty() && !meta.has_more);
        assert_eq!(meta.totals["matches"], 125);
        // and with the tips on, an empty page that skipped real matches is no miss
        assert_eq!(meta_of(&fit_to_budget(&end, true, Some("x")))["tips"], json!(null));
    }

    #[test]
    fn a_size_cut_with_an_offset_reads_on_from_the_offset_plus_the_hits_kept() {
        let hits: Vec<Value> = (0..400).map(|n| json!({"uuid": format!("u{n}"), "content": "x".repeat(200)})).collect();
        let found = Searched { offset: 25, ..searched(hits, 425) };
        let texts = fit_to_budget(&found, false, Some("x"));
        let kept = serde_json::from_str::<Vec<Value>>(&texts.0).unwrap().len();
        assert!(kept > 1 && kept < 400);
        let meta = meta_of(&texts);
        assert_eq!(meta["hasMore"], true);
        assert_eq!(meta["totals"], json!({"matches": 425}));
        let warning = &meta["warnings"][0];
        assert_eq!(warning["code"], "result_size_truncated");
        assert!(
            warning["message"].as_str().unwrap().starts_with(&format!("Showing {kept} of 400 matching blocks from offset 25: the result was cut to fit 30000 characters")),
            "{warning}"
        );
        assert_eq!(warning["howToFetchAll"], format!("Set offset to {} for the next page.", 25 + kept));
    }

    #[test]
    fn a_result_with_no_hit_has_no_next_page_to_name() {
        let found = paged(0, 0, 30, 30, 100).with_raise(false, Some("x"));
        assert_eq!(found.next_page(0), None);
        let warning = found.count_warning(0);
        // `limit: 0` shows nothing: raising it is the only way on, and the warning says so
        assert!(warning.how_to_fetch_all.as_deref().unwrap().starts_with("Set limit to 30 (or higher) to get all 30"), "{warning:?}");
    }

    #[test]
    fn the_budget_counts_characters_not_bytes_through_this_tool() {
        // hits of "é" (2 bytes each): exactly the budget in characters, well over it in bytes
        let accented = |length: usize| json!({"uuid": "u", "content": "é".repeat(length)});
        let frame = chars(&searched(vec![accented(10), accented(10), accented(0)], 3).texts(false, Some("x"), None));
        let exact = searched(vec![accented(10), accented(10), accented(BUDGET_CHARS - frame)], 3);
        let texts = fit_to_budget(&exact, false, Some("x"));
        assert_eq!(chars(&texts), BUDGET_CHARS);
        assert!(texts.0.len() + texts.1.len() > BUDGET_CHARS + 15_000, "{} bytes", texts.0.len() + texts.1.len());
        assert_eq!(texts, exact.texts(false, Some("x"), None), "at the budget in characters, so untouched");
        assert_eq!(meta_of(&texts)["warnings"], json!([]));

        // one more character is a cut, and what is kept is at most the budget in characters
        let over = searched(vec![accented(10), accented(10), accented(BUDGET_CHARS - frame + 1)], 3);
        let texts = fit_to_budget(&over, false, Some("x"));
        assert!(chars(&texts) <= BUDGET_CHARS);
        assert_eq!(serde_json::from_str::<Vec<Value>>(&texts.0).unwrap().len(), 2);
        assert_eq!(meta_of(&texts)["warnings"][0]["code"], "result_size_truncated");
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
                "limit": {"type": "integer", "minimum": 0, "default": 100, "description": "Maximum number of results to return (default: 100, max: 500)"},
                "offset": {"type": "integer", "minimum": 0, "default": 0, "description": "Results to skip, newest first; shifts if the graph changes"},
                "include_context": {"type": "boolean", "default": false, "description": "Include semantic context (page, references, tags)"},
                "slim_results": {"type": "boolean", "default": true, "description": "Slim blocks (default). false returns full entities"},
            },
            "required": [],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&pinned));
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
                offset: 0,
                include_context: false,
                slim_results: true
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
        sweep::<Args>(base.clone(), "offset", Takes::Count(0), false);
        sweep::<Args>(base.clone(), "include_context", Takes::Flag, false);
        sweep::<Args>(base, "slim_results", Takes::Flag, false);
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

    #[test]
    fn how_the_pages_were_read_leads_the_meta_and_the_alias_warnings_lead_the_warnings() {
        let notes = Notes {
            resolved_from: vec![scope::ResolvedFrom { name: "al".into(), matched_by: crate::errors::MatchedBy::Alias, resolved_to: "Alice".into() }],
            resolved_aliases: vec![("Alice".into(), vec!["Al".into(), "Alice".into()])],
            warnings: vec![ResultWarning::new("alias_lookup_unavailable", "m".into())],
        };
        let found = Searched { notes, ..searched(vec![hit(10)], 1) };
        let texts = found.texts(true, None, None);
        let meta = meta_of(&texts);
        let keys: Vec<&str> = meta.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["resolvedFrom", "resolvedAliases", "hasMore", "warnings", "totals", "tips"]);
        assert_eq!(meta["resolvedFrom"], json!([{"name": "al", "matchedBy": "alias", "resolvedTo": "Alice"}]));
        assert_eq!(meta["resolvedAliases"], json!({"Alice": ["Al", "Alice"]}));
        assert_eq!(meta["warnings"][0]["code"], "alias_lookup_unavailable");
        // no pages named: the meta is the one it always was
        let plain = meta_of(&searched(vec![hit(10)], 1).texts(false, None, None));
        assert_eq!(plain.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(), ["hasMore", "warnings", "totals"]);
        // a search that was not answered keeps the alias warning beside its own, and claims no total
        let mut unanswered = Searched { notes: found.notes.clone(), ..searched(Vec::new(), 0) };
        unanswered.unavailable_for = Some("x".into());
        let meta = meta_of(&unanswered.texts(true, None, None));
        assert_eq!(meta["warnings"].as_array().unwrap().iter().map(|w| w["code"].as_str().unwrap()).collect::<Vec<_>>(), ["alias_lookup_unavailable", "search_unavailable"]);
        assert_eq!(meta["totals"], json!({}));
    }
}
