//! `logseq_explore_timeline`: what happened over time, in a period, about a page, or both (ADR-0037, #495). It is the
//! merge of `query_by_date_range` (a period, with the blocks of each journal day) and `get_concept_evolution` (a page's
//! blocks and the blocks that link to it, by day).
//!
//! - A period alone (`start_date` with `end_date`, `last_n` or `preset`): the journal pages in it with every block on
//!   them, one entry per day, empty days included (`journals.rs`). 2 calls whatever the length, 1 when no journal is in
//!   range; `resolve_refs` adds up to 2 more, none when no block holds a ref.
//! - A `page`, with or without a period: the page's own blocks and the blocks that link to it under any of its aliases,
//!   one entry per journal day, oldest first, and with no period the mentions on non-journal pages last in an entry of
//!   their own (`mentions.rs`). 4 calls after the resolver, 5 with aliases. A period leaves out what has no day, which is
//!   everything on a non-journal page.
//!
//! Both give one result: `page` (with a page), `resolvedFrom`, `resolvedAliases`, `dateRange`, then `hasMore`,
//! `warnings`, `totals` (with a cut), the `summary` (`totalDays`, `totalBlocks`, `topConcepts`) and the `entries`
//! (BR-0013). `last_n` is the last N calendar days ending today, in 1 call (the decision on #525), and lists newest first
//! when no page is given, as `query_by_date_range` did for its N most recent journals; with a page the entries are
//! always oldest first. `group_by` week or month joins the entries of a week or month into one, after the cuts.
//!
//! The blocks, nested ones counted, are a list the cursor reads to the end (ADR-0038, #554): `max_blocks` (default 200,
//! at most 1000) is the page size, and a page is also cut to the character budget (#485). A cut page carries
//! `nextCursor`, and a call with only that `cursor` reads the next page from the snapshot the first call kept (no LogSeq
//! call, except the `resolve_refs` queries for the blocks of the page) or, when it is gone, with the first page's calls. A day cut between two pages is on both with the same `date`,
//! and `summary` is on the first page only. A `null` answer to a lookup is not an empty one (BR-0011): the result
//! carries a warning, never an empty list.
//!
//! The directory holds what only this tool uses: its queries, the answers it reads, the two ways to fetch the days
//! (`journals.rs`, `mentions.rs`), the day and week arithmetic (`days.rs`), the roll-up of top concepts, the pages of
//! blocks and the words of their warning (`cap.rs`), and its tip. What it shares is outside: the period (`period`), the date presets and clock
//! (`dates`), the block budget (`block_budget`), the block trees (`block_tree`), the alias groups, the page resolver,
//! `resolve_refs`, slim output and `ResultMeta`.

mod cap;
mod days;
mod journals;
mod mentions;
mod queries;
mod tips;
mod top_concepts;
mod wire;

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::args::{YyyyMmDd, parse_args};
use crate::block_budget::count_blocks;
use crate::client::LogseqClient;
use crate::cursor::{Anchor, Cursor, Position, decode, encode, invalid};
use crate::dates::{CalendarDate, Clock, DatePreset};
use crate::entity::page_display_name;
use crate::errors::{InvalidParameter, ToolError};
use crate::meta::ResultWarning;
use crate::paging::{Cut, PagedCut, page_of, paged_warning, refuse_with_cursor, resume_at, serve, stale_warning};
use crate::period::{Period, Selection, resolve_period};
use crate::resolve_refs::resolve_block_refs;
use crate::slim::{DEFAULT_SLIM_RESULTS, to_slim_block};
use crate::snapshots::{Snapshots, resident_weight};
use crate::snippet::{first_chars, first_non_blank_line};
use crate::tips::tips_content;
use crate::tool::{CursorSchema, input_schema, read_only_annotations, success_result};
use crate::tools::find_blocks::scope::check_names;
use crate::budget::size;

use self::cap::{MAX_BLOCKS, Words, day_count, keys_of, slice_entries};
use self::days::period_key;
use self::tips::date_range_tips;
use self::top_concepts::{ConceptRef, DEFAULT_TOP_CONCEPTS_LIMIT, concept_value, roll_up_top_concepts};

pub use self::cap::DEFAULT_MAX_BLOCKS;
pub use self::days::GroupBy;

pub const NAME: &str = "logseq_explore_timeline";

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Explore a page or period over time: blocks by day (group_by week or month), with summary.topConcepts. Give page (its blocks and blocks linking to it), a period (start_date + end_date, last_n days or preset), or both; a period leaves out non-journal pages. Pages of max_blocks; hasMore: send only cursor=nextCursor.\n\n\
**Can't find:** text matches (logseq_find_blocks) or days with no journal.";

/// Longest first-line snippet of the outline, in characters (code points), ellipsis included.
const SNIPPET_LENGTH: usize = 80;

fn default_slim_results() -> bool {
    DEFAULT_SLIM_RESULTS
}

fn default_include_content() -> bool {
    true
}

fn default_top_concepts_limit() -> u64 {
    u64::from(DEFAULT_TOP_CONCEPTS_LIMIT)
}

fn default_max_blocks() -> u64 {
    DEFAULT_MAX_BLOCKS
}

/// The tool's arguments. Unknown fields are ignored, as in every tool (see `input_schema`). That a page or a period
/// is given, which period was chosen (exactly one of `start_date` with `end_date`, `last_n` or `preset`) and the
/// `YYYYMMDD` format are checked by [`explore_timeline`]; the types and the counts' minimums are checked when the
/// arguments are parsed. There are no parameter aliases: `page` is optional here (BR-0008).
#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq)]
pub struct Args {
    /// Page to follow: its blocks and blocks linking to it, under any alias (page name, alias or ISO date)
    pub page: Option<String>,
    /// Start date in YYYYMMDD format (e.g., 20251115). Needs end_date
    #[schemars(with = "Option<f64>")]
    pub start_date: Option<YyyyMmDd>,
    /// End date in YYYYMMDD format (e.g., 20251120). Needs start_date
    #[schemars(with = "Option<f64>")]
    pub end_date: Option<YyyyMmDd>,
    /// The last N calendar days, today included (whole number, 1+)
    #[schemars(range(min = 1))]
    pub last_n: Option<u64>,
    /// Named period in local time; weeks run Monday to Sunday
    pub preset: Option<DatePreset>,
    /// Join days into weeks or months (default: one entry per day)
    pub group_by: Option<GroupBy>,
    /// Slim blocks (default). false returns full entities
    #[serde(default = "default_slim_results")]
    pub slim_results: bool,
    /// false returns only per-day block counts and top-level snippets
    #[serde(default = "default_include_content")]
    pub include_content: bool,
    /// Entries in summary.topConcepts, the most-linked pages (default 10). 0 omits it
    #[serde(default = "default_top_concepts_limit")]
    pub top_concepts_limit: u64,
    /// Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2)
    #[serde(default)]
    pub resolve_refs: bool,
    /// Page size: blocks across all days, nested ones counted (top-level with include_content false), default 200, max 1000
    #[serde(default = "default_max_blocks")]
    pub max_blocks: u64,
    // No doc comment: the shared description is the type's (`CursorSchema`), and a doc comment would replace it
    #[schemars(with = "Option<CursorSchema>")]
    pub cursor: Option<String>,
}

/// A count a `u32` holds: a larger one is as good as the largest, since `last_n` only ever counts back that many days.
fn saturate(count: u64) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Explore Timeline")
        .with_annotations(read_only_annotations("Explore Timeline"))
}

/// A call: arguments read, a page of the timeline, then the tip.
///
/// A call with a `cursor` takes no other argument: they are in the token (ADR-0038). It reads the next page of the
/// blocks a first call listed, from the snapshot that call kept or, when it is gone, with the calls the first page made.
pub async fn call(client: &LogseqClient, tips_enabled: bool, clock: Clock, snapshots: &Snapshots, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let asked = parse_args::<Args>(arguments.as_ref())?;
    let (args, resume) = match asked.cursor.clone() {
        Some(token) => {
            refuse_with_cursor::<Args>(arguments.as_ref())?;
            let (args, resume) = Resume::read(&token)?;
            (args, Some(resume))
        }
        None => (asked, None),
    };
    let result = read_page(client, snapshots, &args, resume.as_ref(), clock.today(), Instant::now()).await?;
    let mut content = vec![ContentBlock::text(result.json)];
    if tips_enabled {
        if let Some(tips) = tips_content(&date_range_tips(result.top_concept.as_deref())) {
            content.push(ContentBlock::text(tips));
        }
    }
    Ok(success_result(content))
}

/// What a cursor says about where to read on, decoded and checked against this tool: the index of the first block of the
/// next page and the key of the last one the page before sent. The arguments come back as [`Args`], parsed again like
/// any other (ADR-0038: nothing in a token is trusted).
struct Resume {
    cursor: Cursor,
    /// The place of the first block of the next page, in the list as the first call read it
    at: usize,
    anchor: Anchor,
    /// The list is newest day first (`last_n` with no page), which the dates a token stores can't say
    newest_first: bool,
    /// The token as sent, for a refusal
    token: String,
}

impl Resume {
    fn read(token: &str) -> Result<(Args, Resume), InvalidParameter> {
        let cursor = decode(token, NAME)?;
        let Position::Index { at } = cursor.position else {
            return Err(invalid(token, NAME, "this is not a cursor of this tool: its position is not one block"));
        };
        // A token holds the period as dates, a page or both, and no cursor of its own
        let args = parse_args::<Args>(Some(&cursor.args)).ok().filter(|args| {
            args.cursor.is_none() && args.last_n.is_none() && args.preset.is_none() && (args.page.is_some() || args.start_date.is_some())
        });
        let args = args.ok_or_else(|| invalid(token, NAME, "its arguments are not a timeline this tool reads"))?;
        // Present, it is a bool: a token whose order is not one is refused, never read as the other order
        let newest_first = match cursor.args.get("newest_first") {
            None => false,
            Some(Value::Bool(newest)) => *newest,
            Some(_) => return Err(invalid(token, NAME, "its arguments are not a timeline this tool reads")),
        };
        let anchor = cursor.anchor.clone();
        Ok((args, Resume { cursor, at, anchor, newest_first, token: token.to_owned() }))
    }

    /// A token whose arguments no longer make a timeline: the same refusal as one that doesn't parse.
    fn refuse(&self, reason: &str) -> InvalidParameter {
        invalid(&self.token, NAME, reason)
    }
}

/// The arguments of a timeline as a cursor carries them: what the call asked, with a `last_n` or a preset as the dates it
/// meant (so a page read again after midnight reads the same days), and the order `last_n` lists in. Read again by [`Args`].
/// What is the default is left out, and `max_blocks` is stored as the page size that is read.
fn stored_arguments(args: &Args, period: Option<Period>, newest_first: bool) -> Map<String, Value> {
    let mut stored = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            stored.insert(key.to_owned(), value);
        }
    };
    put("page", args.page.as_ref().map(|page| Value::from(page.as_str())));
    put("start_date", period.map(|period| Value::from(period.start)));
    put("end_date", period.map(|period| Value::from(period.end)));
    put("group_by", args.group_by.map(|group| Value::from(match group { GroupBy::Day => "day", GroupBy::Week => "week", GroupBy::Month => "month" })));
    put("slim_results", (!args.slim_results).then_some(Value::Bool(false)));
    put("include_content", (!args.include_content).then_some(Value::Bool(false)));
    put("top_concepts_limit", (args.top_concepts_limit != u64::from(DEFAULT_TOP_CONCEPTS_LIMIT)).then(|| Value::from(args.top_concepts_limit)));
    put("resolve_refs", args.resolve_refs.then_some(Value::Bool(true)));
    put("max_blocks", (args.max_blocks != DEFAULT_MAX_BLOCKS).then(|| Value::from(args.max_blocks.min(MAX_BLOCKS as u64))));
    put("newest_first", newest_first.then_some(Value::Bool(true)));
    stored
}

/// One entry of a result: a journal day (its date, its page and the blocks on it as trees), or the blocks that have no
/// day (`date` is `None`, `page` is `null`), which a page's mentions on non-journal pages are.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// `YYYYMMDD`
    pub date: Option<i64>,
    /// The page as the Editor API spells it (the pull's keys, camelized) for a day
    pub page: Value,
    /// The entry's top-level blocks (kept ones only, after the cap), each with its `children`
    pub blocks: Vec<Value>,
}

/// What [`explore_timeline`] makes: the result as the text the tool prints, and what the tip reads.
#[derive(Debug, Clone, PartialEq)]
pub struct TimelineResult {
    pub json: String,
    /// `summary.topConcepts[0].name`
    pub top_concept: Option<String>,
}

/// What the two ways of fetching the days make.
struct Found {
    /// Every entry, before the cap: days oldest first (newest first for `last_n` with no page), the undated one last
    entries: Vec<Entry>,
    /// The concepts each block links, by block id, for the roll-up
    refs_by_block: HashMap<i64, Vec<ConceptRef>>,
    /// The alias group's warnings, then the ones for a `null` answer
    warnings: Vec<ResultWarning>,
    /// What the server worked out from the request, as keys of the result: `page`, `resolvedFrom`, `resolvedAliases`
    answered: Vec<(&'static str, Value)>,
    /// The earliest and the latest day of the dated blocks, for a page with no period
    span: Option<(i64, i64)>,
    /// The ids of the page asked about and its aliases, which the roll-up leaves out (every mention links them)
    group: HashSet<i64>,
}

/// The first non-blank line of a block, trimmed and shortened, as the page outline
/// takes it. Over 80 characters (code points) it is cut to 77 and ends in `...`, so a cut never
/// lands inside a character. Unlike the outline's snippet, white space the cut leaves at the end
/// stays.
fn snippet_of(block: &Value) -> String {
    let line = first_non_blank_line(block.get("content").and_then(Value::as_str));
    if line.chars().count() > SNIPPET_LENGTH {
        format!("{}...", first_chars(line, SNIPPET_LENGTH - 3))
    } else {
        line.to_owned()
    }
}

/// `hasMore`, `nextCursor` and `warnings` as keys of the result, then `totals` (what there was before a cut, only with a
/// cut): `hasMore` is true when a `nextCursor` reads on, or when a warning of the read itself offers a way to fetch what
/// it left out (BR-0013). A raise of `max_blocks` beside the cursor never makes it true.
fn meta_parts(more: bool, next: Option<&str>, warnings: &[ResultWarning], totals: Option<(usize, usize)>) -> Vec<(&'static str, Value)> {
    let mut parts = vec![("hasMore", Value::Bool(more))];
    if let Some(next) = next {
        parts.push(("nextCursor", Value::from(next)));
    }
    parts.push(("warnings", serde_json::to_value(warnings).expect("warnings serialize")));
    if let Some((blocks, days)) = totals {
        parts.push(("totals", Value::Object(Map::from_iter([("blocks".to_owned(), Value::from(blocks)), ("days".to_owned(), Value::from(days))]))));
    }
    parts
}

/// A JSON object from keys and values, in order.
fn object_of(parts: Vec<(&str, Value)>) -> Value {
    Value::Object(parts.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

/// The refusal for a call with neither a page nor a period.
fn nothing_asked() -> InvalidParameter {
    InvalidParameter {
        param: "page or period".to_owned(),
        value: "none given".to_owned(),
        expected: "A page, or a period (start_date with end_date, last_n or preset), or both".to_owned(),
        example: Some("page: \"Project Atlas\", or last_n: 7, or page: \"Project Atlas\" with preset: \"last_month\"".to_owned()),
    }
}

/// The `date` of an entry as the result writes it: the day, or `null` for the blocks that have none.
fn date_value(entry: &Entry) -> Value {
    entry.date.map_or(Value::Null, Value::from)
}

/// The entry of one day, or of the blocks with no day, as the result writes it.
fn day_entry(entry: &Entry, args: &Args) -> Value {
    let dated = entry.date.is_some();
    if !args.include_content {
        let snippets: Vec<Value> = entry.blocks.iter().map(|block| Value::String(snippet_of(block))).collect();
        let mut parts = vec![("date", date_value(entry))];
        if dated {
            parts.push(("pageName", Value::from(page_display_name(Some(&entry.page)))));
        }
        parts.push(("blockCount", Value::from(count_blocks(&entry.blocks))));
        parts.push(("snippets", Value::Array(snippets)));
        return object_of(parts);
    }
    let mut map = Map::new();
    map.insert("date".to_owned(), date_value(entry));
    if args.slim_results {
        if dated {
            map.insert("pageName".to_owned(), Value::from(page_display_name(Some(&entry.page))));
        }
        // A day names its page, so its blocks don't repeat it (#42); the blocks with no day each say theirs
        let blocks = entry.blocks.iter().filter_map(Value::as_object).map(|block| {
            let name = if dated { String::new() } else { page_display_name(block.get("page")) };
            Value::Object(to_slim_block(block, &name))
        });
        map.insert("blocks".to_owned(), Value::Array(blocks.collect()));
    } else {
        if dated {
            map.insert("page".to_owned(), entry.page.clone());
        }
        map.insert("blocks".to_owned(), Value::Array(entry.blocks.clone()));
    }
    Value::Object(map)
}

/// The entries of one week or month as one: its key, then what a day has but the date. Slim blocks each say their
/// page, since the entry no longer names one.
fn period_entry(key: &str, members: &[&Entry], args: &Args) -> Value {
    if !args.include_content {
        let blocks: Vec<&Value> = members.iter().flat_map(|entry| entry.blocks.iter()).collect();
        let snippets: Vec<Value> = blocks.iter().map(|block| Value::String(snippet_of(block))).collect();
        let count = blocks.iter().map(|block| count_blocks(std::slice::from_ref(*block))).sum::<usize>();
        return object_of(vec![("period", Value::from(key)), ("blockCount", Value::from(count)), ("snippets", Value::Array(snippets))]);
    }
    let blocks: Vec<Value> = if args.slim_results {
        members
            .iter()
            .flat_map(|entry| {
                let day_page = page_display_name(Some(&entry.page));
                entry.blocks.iter().filter_map(Value::as_object).map(move |block| {
                    let name = if day_page.is_empty() { page_display_name(block.get("page")) } else { day_page.clone() };
                    Value::Object(to_slim_block(block, &name))
                })
            })
            .collect()
    } else {
        members.iter().flat_map(|entry| entry.blocks.iter().cloned()).collect()
    };
    object_of(vec![("period", Value::from(key)), ("blocks", Value::Array(blocks))])
}

/// The entries as the result lists them: one per day, or one per week or month with `group_by`. Entries of one
/// period sit together, in the order of the days; an entry with no day, or whose day has no week, stays as it is.
fn entries_value(entries: &[Entry], args: &Args) -> Vec<Value> {
    let Some(group) = args.group_by.filter(|group| *group != GroupBy::Day) else {
        return entries.iter().map(|entry| day_entry(entry, args)).collect();
    };
    enum Row<'a> {
        Day(&'a Entry),
        Period(String, Vec<&'a Entry>),
    }
    let mut rows: Vec<Row> = Vec::new();
    for entry in entries {
        match entry.date.and_then(|date| period_key(group, date)) {
            Some(key) => match rows.last_mut() {
                Some(Row::Period(last, days)) if *last == key => days.push(entry),
                _ => rows.push(Row::Period(key, vec![entry])),
            },
            None => rows.push(Row::Day(entry)),
        }
    }
    rows.into_iter()
        .map(|row| match row {
            Row::Day(entry) => day_entry(entry, args),
            Row::Period(key, days) => period_entry(&key, &days, args),
        })
        .collect()
}

/// What a first call reads, before it is cut into pages: every entry, and what the result says besides them. It is what
/// a snapshot keeps, so the pages after the first need no LogSeq call to read the list (ADR-0038; `resolve_refs` still queries for the blocks of the page).
struct Timeline {
    /// Every entry, before any cut: days oldest first (newest first for `last_n` with no page), the undated one last
    entries: Vec<Entry>,
    /// The key of each block of the list the cursor reads, in its order
    keys: Vec<Anchor>,
    /// The alias group's warnings, then the ones for a `null` answer: every page repeats them
    warnings: Vec<ResultWarning>,
    /// What the server worked out from the request, as keys of the result: `page`, `resolvedFrom`, `resolvedAliases`
    answered: Vec<(&'static str, Value)>,
    date_range: Option<Value>,
    /// `totalDays`, `totalBlocks` and `topConcepts` of every block found, which the first page carries (#61)
    summary: Value,
    /// `summary.topConcepts[0].name`
    top_concept: Option<String>,
}

impl Timeline {
    /// What the snapshot weighs for the cache's bounds: the length of the JSON of the blocks, scaled to the memory a list
    /// of `Value`s takes ([`resident_weight`]).
    fn weight(&self) -> usize {
        let json_len: usize = self.entries.iter().flat_map(|entry| entry.blocks.iter()).map(|block| block.to_string().len()).sum();
        resident_weight(json_len)
    }
}

/// The text of one page of the result: what was answered and the range, the meta (`hasMore`, `nextCursor`, `warnings`,
/// `totals`) when there is something to say, the `summary` on the first page only, then the entries (BR-0013). The meta
/// comes only with something to say, so a result that fits one page is unchanged; resolving refs always brings it.
fn write(timeline: &Timeline, args: &Args, first: bool, entries: &[Entry], warnings: &[ResultWarning], next: Option<&str>, offered: bool, totals: Option<(usize, usize)>) -> String {
    let always_meta = args.include_content && args.resolve_refs;
    let mut parts: Vec<(&str, Value)> = timeline.answered.iter().map(|(key, value)| (*key, value.clone())).collect();
    if let Some(range) = &timeline.date_range {
        parts.push(("dateRange", range.clone()));
    }
    if always_meta || !warnings.is_empty() || next.is_some() {
        parts.extend(meta_parts(next.is_some() || offered, next, warnings, totals));
    }
    if first {
        parts.push(("summary", timeline.summary.clone()));
    }
    parts.push(("entries", Value::Array(entries_value(entries, args))));
    object_of(parts).to_string()
}

/// Explore a page or a period over time: a period alone gives the journal days in it, a page the days its blocks and
/// the blocks that link to it are on, and both the page's days inside the period. This is the first page of the result,
/// read without the cursor's snapshots; [`call`] is the tool.
///
/// Fails with [`ToolError::InvalidParameter`] if neither is given, the period is missing, ambiguous or invalid, or the
/// page name is blank, before any LogSeq call is made. A page that is missing or ambiguous fails with
/// [`ToolError::PageNotFound`] or [`ToolError::AmbiguousPage`]. `today` is the local calendar day a `last_n` or a preset
/// counts from.
pub async fn explore_timeline(client: &LogseqClient, args: &Args, today: CalendarDate) -> Result<TimelineResult, ToolError> {
    read_page(client, &Snapshots::new(0), args, None, today, Instant::now()).await
}

/// Everything a first call reads, with the calls it has always made: the page resolved, then its blocks and mentions, or
/// the journal days of the period. The summary describes every block found (#61), so a cut result still shows what it was
/// about.
async fn read_timeline(client: &LogseqClient, args: &Args, period: Option<Period>, newest_first: bool) -> Result<Timeline, ToolError> {
    let page = args.page.as_deref();
    let found = match (page, period) {
        (Some(name), period) => mentions::fetch(client, name, period, args.top_concepts_limit > 0).await?,
        (None, Some(period)) => journals::fetch(client, period, newest_first).await?,
        (None, None) => unreachable!("a call with neither a page nor a period was refused before"),
    };
    let Found { entries, mut refs_by_block, warnings, answered, span, group } = found;

    // The days the result covers: the period, or for a page with no period the span of its dated blocks
    let range = period.map(|Period { start, end }| (start, end)).or(span);
    let date_range = range.map(|(start, end)| object_of(vec![("start", Value::from(start)), ("end", Value::from(end))]));

    let total_blocks: usize = entries.iter().map(|entry| entry.blocks.len()).sum();
    let mut summary = Map::new();
    summary.insert("totalDays".to_owned(), Value::from(day_count(&entries)));
    summary.insert("totalBlocks".to_owned(), Value::from(total_blocks));
    let top = if args.top_concepts_limit > 0 {
        for concepts in refs_by_block.values_mut() {
            concepts.retain(|concept| !group.contains(&concept.id));
        }
        let top = roll_up_top_concepts(entries.iter().map(|entry| (entry.date, entry.blocks.as_slice())), &refs_by_block, args.top_concepts_limit);
        summary.insert("topConcepts".to_owned(), Value::Array(top.iter().map(concept_value).collect()));
        top
    } else {
        Vec::new()
    };
    let top_concept = top.first().map(|concept| concept.name.clone());
    let keys = keys_of(&entries, args.include_content);
    Ok(Timeline { entries, keys, warnings, answered, date_range, summary: Value::Object(summary), top_concept })
}

/// One page of the timeline: the list from the snapshot a cursor names (no LogSeq call to read the list) or from [`read_timeline`], where
/// the page starts (with `cursor_stale` when the list moved between pages), the most blocks of the `max_blocks` that fit
/// the character budget (never fewer than one, BR-0007), and the result with its `nextCursor`.
///
/// `resolve_refs` runs over the blocks of the page only, so a page costs at most the 2 queries it always did. The
/// token carries the arguments, and the snapshot is served only to a call whose arguments equal them.
async fn read_page(client: &LogseqClient, snapshots: &Snapshots, args: &Args, resume: Option<&Resume>, today: CalendarDate, now: Instant) -> Result<TimelineResult, ToolError> {
    // A token whose arguments no longer make a timeline is a bad token, whatever the arguments say
    let refuse = |error: InvalidParameter| match resume {
        Some(resume) => resume.refuse("its arguments are not a timeline this tool reads"),
        None => error,
    };
    let selection = Selection {
        start_date: args.start_date.map(|day| day.0),
        end_date: args.end_date.map(|day| day.0),
        last_n: args.last_n.map(saturate),
        preset: args.preset,
    };
    let period = resolve_period(selection, today).map_err(refuse)?;
    let page = args.page.as_deref();
    check_names(page, None).map_err(refuse)?;
    if page.is_none() && period.is_none() {
        return Err(refuse(nothing_asked()).into());
    }

    // `last_n` with no page lists the newest days first
    let newest_first = resume.map_or_else(|| page.is_none() && args.last_n.is_some(), |resume| resume.newest_first);
    // The arguments the list was built from: the cursor's own, byte for byte, so the snapshot it names is the one asked for
    let stored = resume.map_or_else(|| stored_arguments(args, period, newest_first), |resume| resume.cursor.args.clone());
    let served = serve::<Timeline, ToolError, _>(snapshots, resume.map(|resume| &resume.cursor.snapshot), &stored, now, || read_timeline(client, args, period, newest_first)).await?;
    let timeline = &*served.list;
    let nested = args.include_content;
    let total = timeline.keys.len();
    let (start, stale) = match resume {
        None => (0, None),
        Some(resume) => {
            let resumed = resume_at(total, resume.at, |at| timeline.keys[at] == resume.anchor, || timeline.keys.iter().position(|key| *key == resume.anchor).map(|at| at + 1));
            (resumed.start, resumed.stale)
        }
    };

    // The blocks the page could hold: `max_blocks` of them, before the budget cuts. Refs are resolved for these, as they
    // were for the blocks `max_blocks` kept before the cursor, and the budget cuts after, on the resolved text
    let page_size = args.max_blocks.min(MAX_BLOCKS as u64) as usize;
    let reach = page_size.min(total - start);
    let mut page_entries = slice_entries(&timeline.entries, start, reach, total, nested);
    let mut resolved_warnings: Vec<ResultWarning> = Vec::new();
    if nested && args.resolve_refs {
        let roots: Vec<Value> = page_entries.iter().flat_map(|entry| entry.blocks.iter().cloned()).collect();
        let resolved = resolve_block_refs(client, &roots).await?;
        let mut offset = 0;
        for entry in &mut page_entries {
            let len = entry.blocks.len();
            entry.blocks = resolved.blocks[offset..offset + len].to_vec();
            offset += len;
        }
        resolved_warnings = resolved.warnings;
    }

    let first = resume.is_none();
    // A warning of this page's `resolve_refs` (a ref past the depth limit) may offer a way of its own to fetch what it left
    // out. The warnings the list was read with offer none, so a last page is `hasMore` only for what it resolved itself
    let offered = resolved_warnings.iter().any(|warning| warning.how_to_fetch_all.is_some());
    let words = Words { nested, newest_first, requested: args.max_blocks };
    // The text of the page with its first `kept` blocks, ending as `cut` says
    let text_for = |kept: usize, cut: Option<Cut>| -> String {
        let entries = slice_entries(&page_entries, 0, kept, reach, nested);
        let next = (cut.is_some() && kept > 0).then(|| {
            encode(&Cursor::new(NAME, stored.clone(), Position::Index { at: start + kept }, timeline.keys[start + kept - 1].clone(), served.key))
        });
        let mut warnings = timeline.warnings.clone();
        warnings.extend(resolved_warnings.iter().cloned());
        warnings.extend(stale.map(|stale| stale_warning(stale, "blocks")));
        if let Some(cut) = cut {
            warnings.push(paged_warning(PagedCut {
                count_code: "blocks_truncated",
                cut,
                what: &words.what(),
                start,
                kept,
                total,
                advice: &words.advice(matches!(cut, Cut::Size { .. })),
                raise: (kept == 0).then(|| words.raise()),
                has_next: next.is_some(),
            }));
        }
        let totals = cut.map(|_| (total, day_count(&timeline.entries)));
        write(timeline, args, first, &entries, &warnings, next.as_deref(), offered, totals)
    };
    // How a page of `kept` blocks would end, for measuring it: by the page size when it holds all it could, else by size
    let guess = |kept: usize| (start + kept < total).then_some(if kept == reach { Cut::Count } else { Cut::Size { oversize: false } });
    let page = page_of(total, start, page_size, |kept| size(&text_for(kept, guess(kept))));
    // A list that fits one page needs no snapshot, and a hit is kept already
    if page.next().is_some() {
        served.keep(snapshots, &stored, timeline.weight(), now);
    }
    let json = text_for(page.kept, page.cut);
    Ok(TimelineResult { json, top_concept: first.then(|| timeline.top_concept.clone()).flatten() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::testing::{keys, meaning, schema_of};
    use serde_json::json;

    #[test]
    fn the_schema_means_what_the_pinned_one_means() {
        // `inputSchema` of logseq_explore_timeline in the ADR-0016 snapshot
        let pinned = json!({
            "type": "object",
            "properties": {
                "page": {"type": "string", "description": "Page to follow: its blocks and blocks linking to it, under any alias (page name, alias or ISO date)"},
                "start_date": {"type": "number", "description": "Start date in YYYYMMDD format (e.g., 20251115). Needs end_date"},
                "end_date": {"type": "number", "description": "End date in YYYYMMDD format (e.g., 20251120). Needs start_date"},
                "last_n": {"type": "integer", "minimum": 1, "description": "The last N calendar days, today included (whole number, 1+)"},
                "preset": {
                    "type": "string",
                    "enum": ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "this_year", "year_to_date"],
                    "description": "Named period in local time; weeks run Monday to Sunday"
                },
                "group_by": {"type": "string", "enum": ["day", "week", "month"], "description": "Join days into weeks or months (default: one entry per day)"},
                "slim_results": {"type": "boolean", "default": true, "description": "Slim blocks (default). false returns full entities"},
                "include_content": {"type": "boolean", "default": true, "description": "false returns only per-day block counts and top-level snippets"},
                "top_concepts_limit": {
                    "type": "integer", "minimum": 0, "default": 10,
                    "description": "Entries in summary.topConcepts, the most-linked pages (default 10). 0 omits it"
                },
                "resolve_refs": {"type": "boolean", "default": false, "description": "Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2)"},
                "max_blocks": {
                    "type": "integer", "minimum": 0, "default": 200,
                    "description": "Page size: blocks across all days, nested ones counted (top-level with include_content false), default 200, max 1000"
                },
                "cursor": {"type": "string", "description": crate::tool::CURSOR_DESCRIPTION},
            },
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&pinned));
    }

    #[test]
    fn the_tool_is_read_only_titled_and_has_no_required_parameter_so_no_alias() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Explore Timeline"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Explore Timeline", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
        let description = tool.description.as_deref().unwrap();
        assert!(description.starts_with("Explore "), "{description}");
        assert!(description.contains("**Can't find:**"), "{description}");
        // BR-0008: an alias needs the canonical parameter to stay required, and `page` is optional here
        assert!(tool.input_schema.get("required").is_none());
    }

    fn read(value: Value) -> Result<Args, String> {
        parse_args::<Args>(value.as_object()).map_err(|error| error.to_string())
    }

    #[test]
    fn every_argument_takes_what_it_says_and_nothing_else() {
        use crate::args::testing::{Takes, sweep};
        let base = json!({"last_n": 7});
        let without = |param: &str| {
            let mut base = base.clone();
            base.as_object_mut().unwrap().remove(param);
            base
        };
        sweep::<Args>(base.clone(), "page", Takes::Text, false);
        sweep::<Args>(base.clone(), "start_date", Takes::Date, false);
        sweep::<Args>(base.clone(), "end_date", Takes::Date, false);
        sweep::<Args>(json!({}), "last_n", Takes::Count(1), false);
        sweep::<Args>(without("preset"), "preset", Takes::Words(&DATE_PRESET_WORDS), false);
        sweep::<Args>(base.clone(), "group_by", Takes::Words(&["day", "week", "month"]), false);
        sweep::<Args>(base.clone(), "slim_results", Takes::Flag, false);
        sweep::<Args>(base.clone(), "include_content", Takes::Flag, false);
        sweep::<Args>(base.clone(), "top_concepts_limit", Takes::Count(0), false);
        sweep::<Args>(base.clone(), "resolve_refs", Takes::Flag, false);
        sweep::<Args>(base.clone(), "max_blocks", Takes::Count(0), false);
        sweep::<Args>(base, "cursor", Takes::Text, false);
    }

    /// The words `preset` takes, as the schema lists them.
    const DATE_PRESET_WORDS: [&str; 8] = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "this_year", "year_to_date"];

    #[test]
    fn the_arguments_read_as_the_schema_defaults_say() {
        let args = read(json!({"last_n": 7})).unwrap();
        assert_eq!(
            args,
            Args {
                page: None,
                start_date: None,
                end_date: None,
                last_n: Some(7),
                preset: None,
                group_by: None,
                slim_results: true,
                include_content: true,
                top_concepts_limit: 10,
                resolve_refs: false,
                max_blocks: 200,
                cursor: None,
            }
        );
        assert_eq!(serde_json::from_value::<Args>(json!({"last_n": 7})).unwrap(), args);
        let all = read(json!({"page": "Atlas", "preset": "last_week", "top_concepts_limit": 0, "max_blocks": 5000000000_u64, "last_n": null, "group_by": "month"})).unwrap();
        assert_eq!(
            (all.page.as_deref(), all.preset, all.last_n, all.top_concepts_limit, all.max_blocks, all.group_by),
            (Some("Atlas"), Some(DatePreset::LastWeek), None, 0, 5_000_000_000, Some(GroupBy::Month))
        );
        // the names the two tools had for the page are no parameter of this one: they are ignored, as any unknown field
        let ignored = read(json!({"last_n": 7, "concept_name": "Atlas", "search_term": "x", "max_entries": 3})).unwrap();
        assert_eq!((ignored.page, ignored.max_blocks), (None, 200));
    }

    #[test]
    fn the_first_bad_argument_in_schema_order_is_the_one_reported() {
        assert_eq!(read(json!({"page": 5, "start_date": "x"})).unwrap_err(), "Invalid parameter 'page': 5\n\nExpected: a string, not a number\nExample: page: \"...\"");
        assert_eq!(
            read(json!({"start_date": "20250101", "preset": "nope", "max_blocks": "x"})).unwrap_err(),
            "Invalid parameter 'start_date': \"20250101\"\n\nExpected: a number, not a string\nExample: start_date: 5"
        );
        assert_eq!(
            read(json!({"last_n": 0, "preset": "nope"})).unwrap_err(),
            "Invalid parameter 'last_n': 0\n\nExpected: at least 1\nExample: last_n: 1"
        );
        assert_eq!(
            read(json!({"last_n": 2.5})).unwrap_err(),
            "Invalid parameter 'last_n': 2.5\n\nExpected: an integer, not a fraction\nExample: last_n: 5"
        );
        assert_eq!(
            read(json!({"preset": "next_week", "slim_results": 1})).unwrap_err(),
            "Invalid parameter 'preset': \"next_week\"\n\nExpected: one of \"today\", \"yesterday\", \"this_week\", \"last_week\", \"this_month\", \"last_month\", \"this_year\", \"year_to_date\"\n\
             Example: preset: \"year_to_date\""
        );
        assert!(read(json!({"page": "a", "group_by": "year"})).unwrap_err().starts_with("Invalid parameter 'group_by': \"year\""));
        assert_eq!(
            read(json!({"top_concepts_limit": -1})).unwrap_err(),
            "Invalid parameter 'top_concepts_limit': -1\n\nExpected: at least 0\nExample: top_concepts_limit: 0"
        );
        assert!(read(json!({"max_blocks": 2.5})).unwrap_err().starts_with("Invalid parameter 'max_blocks': 2.5"));
    }

    #[test]
    fn a_date_is_a_whole_number_and_anything_else_is_refused_as_a_date_of_the_wrong_format() {
        let args = read(json!({"start_date": 20250101, "end_date": 20250102.0})).unwrap();
        assert_eq!((args.start_date, args.end_date), (Some(YyyyMmDd(20_250_101)), Some(YyyyMmDd(20_250_102))));
        let format = "Expected: Date in YYYYMMDD format (8 digits, valid year/month/day)";
        assert_eq!(
            read(json!({"start_date": 20250101.5, "end_date": 20250102})).unwrap_err(),
            format!("Invalid parameter 'start_date': 20250101.5\n\n{format}\nExample: start_date: 20251115")
        );
        assert_eq!(
            read(json!({"start_date": 20250101, "end_date": 1e300})).unwrap_err(),
            format!("Invalid parameter 'end_date': 1e+300\n\n{format}\nExample: end_date: 20251115")
        );
    }

    fn block(content: &str) -> Value {
        json!({"id": 1, "uuid": "u", "content": content, "children": []})
    }

    fn snippet(content: &str) -> String {
        snippet_of(&block(content))
    }

    #[test]
    fn a_snippet_is_the_first_non_blank_line_trimmed_and_cut_at_eighty_characters() {
        assert_eq!(snippet("  Hello  \nsecond"), "Hello");
        // as the page outline takes it: blank lines before the first one with text are skipped
        assert_eq!(snippet("\n\nHello"), "Hello");
        assert_eq!(snippet("  \n \t \n  Hello  \nsecond"), "Hello");
        assert_eq!(snippet("\n  \n"), "");
        assert_eq!(snippet(&"x".repeat(80)), "x".repeat(80));
        assert_eq!(snippet(&"x".repeat(81)), format!("{}...", "x".repeat(77)));
        // no trimEnd after the cut: a space stays
        assert_eq!(snippet(&format!("{} {}", "x".repeat(76), "y".repeat(10))), format!("{} ...", "x".repeat(76)));
        assert_eq!(snippet_of(&json!({"id": 1})), "");
    }

    #[test]
    fn a_snippet_cuts_by_code_point_so_no_lone_surrogate_or_replacement_character_appears() {
        // 80 rockets are 160 UTF-16 units and 80 characters: no cut
        assert_eq!(snippet(&"\u{1F680}".repeat(80)), "\u{1F680}".repeat(80));
        assert_eq!(snippet(&"\u{1F680}".repeat(81)), format!("{}...", "\u{1F680}".repeat(77)));
        // a rocket at the boundary (the 77th character) stays whole, and its JSON has no escape for half of it
        let text = format!("{}\u{1F680}{}", "x".repeat(76), "y".repeat(10));
        assert_eq!(snippet(&text), format!("{}\u{1F680}...", "x".repeat(76)));
        let json = serde_json::to_string(&snippet(&text)).unwrap();
        assert!(!json.contains("\\ud") && !json.contains('\u{FFFD}'), "{json}");
        // a ZWJ emoji is cut between its code points; a letter and its combining mark likewise
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        assert_eq!(snippet(&format!("{}{family}{}", "x".repeat(76), "y".repeat(10))), format!("{}\u{1F468}...", "x".repeat(76)));
        assert_eq!(snippet(&format!("{}e\u{301}{}", "x".repeat(76), "y".repeat(10))), format!("{}e...", "x".repeat(76)));
    }

    #[test]
    fn a_day_is_written_as_an_integer_and_the_meta_leaves_out_totals_unless_there_was_a_cut() {
        assert_eq!(Value::from(20250101_i64).to_string(), "20250101");
        let warning = ResultWarning { code: "c".into(), message: "m".into(), how_to_fetch_all: Some("h".into()) };
        let parts = meta_parts(true, None, &[warning], Some((9, 2)));
        assert_eq!(
            object_of(parts).to_string(),
            r#"{"hasMore":true,"warnings":[{"code":"c","message":"m","howToFetchAll":"h"}],"totals":{"blocks":9,"days":2}}"#
        );
        assert_eq!(object_of(meta_parts(false, None, &[], None)).to_string(), r#"{"hasMore":false,"warnings":[]}"#);
        // a cursor makes hasMore true and sits right after it (BR-0013)
        assert_eq!(object_of(meta_parts(true, Some("abc"), &[], None)).to_string(), r#"{"hasMore":true,"nextCursor":"abc","warnings":[]}"#);
    }

    fn day(date: i64, name: &str, blocks: Vec<Value>) -> Entry {
        Entry { date: Some(date), page: json!({"id": date, "original-name": name, "journal-day": date}), blocks }
    }

    fn frame(answered: Vec<(&'static str, Value)>, with_range: bool) -> Timeline {
        Timeline {
            entries: Vec::new(),
            keys: Vec::new(),
            warnings: Vec::new(),
            answered,
            date_range: with_range.then(|| json!({"start": 20250101, "end": 20250131})),
            summary: json!({"totalDays": 1, "totalBlocks": 1}),
            top_concept: None,
        }
    }

    fn all_args() -> Args {
        read(json!({"page": "a"})).unwrap()
    }

    #[test]
    fn the_keys_of_a_result_go_in_the_order_of_br_0013_whatever_optional_keys_are_there() {
        let warning = ResultWarning { code: "c".into(), message: "m".into(), how_to_fetch_all: None };
        let entries = [day(20250101, "Jan 1st, 2025", vec![block("a")])];
        let answered = vec![("page", json!("atlas")), ("resolvedFrom", json!({"name": "atlas"})), ("resolvedAliases", json!(["Atlas"]))];
        let text = write(&frame(answered, true), &all_args(), true, &entries, &[warning.clone()], Some("abc"), false, Some((9, 2)));
        let value: Value = serde_json::from_str(&text).unwrap();
        // what was answered, what must not be missed (the flags, the cursor, the warnings, the counts, the overview), then the data
        assert_eq!(keys(&value), ["page", "resolvedFrom", "resolvedAliases", "dateRange", "hasMore", "nextCursor", "warnings", "totals", "summary", "entries"]);
        // a period alone has no page; with nothing to say there is no meta
        let quiet = write(&frame(vec![], true), &all_args(), true, &entries, &[], None, false, None);
        assert_eq!(keys(&serde_json::from_str::<Value>(&quiet).unwrap()), ["dateRange", "summary", "entries"]);
        // a page with no dated mention has no range
        let bare = write(&frame(vec![("page", json!("atlas"))], false), &all_args(), true, &[], &[warning.clone()], None, true, None);
        assert_eq!(keys(&serde_json::from_str::<Value>(&bare).unwrap()), ["page", "hasMore", "warnings", "summary", "entries"]);
        // a page after the first has no summary, and keeps what was answered and the range
        let later = write(&frame(vec![("page", json!("atlas"))], true), &all_args(), false, &entries, &[warning], None, true, None);
        assert_eq!(keys(&serde_json::from_str::<Value>(&later).unwrap()), ["page", "dateRange", "hasMore", "warnings", "entries"]);
        // resolving refs always brings the meta
        let resolving = Args { resolve_refs: true, ..all_args() };
        let text = write(&frame(vec![], true), &resolving, true, &entries, &[], None, false, None);
        assert_eq!(keys(&serde_json::from_str::<Value>(&text).unwrap()), ["dateRange", "hasMore", "warnings", "summary", "entries"]);
    }

    #[test]
    fn an_entry_is_a_day_with_its_page_name_or_the_blocks_with_no_day_each_naming_theirs() {
        let args = all_args();
        let dated = day(20250101, "Jan 1st, 2025", vec![json!({"id": 1, "uuid": "u1", "content": "a", "page": {"id": 5}})]);
        assert_eq!(
            day_entry(&dated, &args),
            json!({"date": 20250101, "pageName": "Jan 1st, 2025", "blocks": [{"uuid": "u1", "content": "a"}]})
        );
        let undated = Entry {
            date: None,
            page: Value::Null,
            blocks: vec![json!({"id": 2, "uuid": "u2", "content": "b", "page": {"id": 6, "original-name": "Bob"}})],
        };
        assert_eq!(day_entry(&undated, &args), json!({"date": null, "blocks": [{"uuid": "u2", "content": "b", "pageName": "Bob"}]}));
        // full entities: the page of a day, the blocks as they are
        let full = Args { slim_results: false, ..args.clone() };
        assert_eq!(keys(&day_entry(&dated, &full)), ["date", "page", "blocks"]);
        assert_eq!(keys(&day_entry(&undated, &full)), ["date", "blocks"]);
        // the outline: counts and first lines, a day with its page name
        let outline = Args { include_content: false, ..args };
        assert_eq!(day_entry(&dated, &outline), json!({"date": 20250101, "pageName": "Jan 1st, 2025", "blockCount": 1, "snippets": ["a"]}));
        assert_eq!(day_entry(&undated, &outline), json!({"date": null, "blockCount": 1, "snippets": ["b"]}));
    }

    #[test]
    fn group_by_joins_consecutive_days_of_a_week_or_month_and_leaves_the_others_as_they_are() {
        let entries = [
            day(20250106, "Day 6", vec![block("a")]),
            day(20250107, "Day 7", vec![block("b")]),
            day(20250115, "Day 15", vec![block("c")]),
            Entry { date: None, page: Value::Null, blocks: vec![block("d")] },
        ];
        let by = |group: GroupBy, outline: bool| entries_value(&entries, &Args { group_by: Some(group), include_content: !outline, ..all_args() });
        let weeks = by(GroupBy::Week, false);
        assert_eq!(
            weeks.iter().map(|entry| entry.get("period").or(entry.get("date")).unwrap().clone()).collect::<Vec<_>>(),
            [json!("2025-W02"), json!("2025-W03"), json!(null)]
        );
        assert_eq!(weeks[0]["blocks"].as_array().unwrap().len(), 2);
        // slim blocks name their page, since the entry names none
        assert_eq!(weeks[0]["blocks"][1]["pageName"], "Day 7");
        let months = by(GroupBy::Month, false);
        assert_eq!(months[0]["period"], "202501");
        assert_eq!(months[0]["blocks"].as_array().unwrap().len(), 3);
        // the outline sums the counts and lists the snippets in order
        assert_eq!(by(GroupBy::Month, true)[0], json!({"period": "202501", "blockCount": 3, "snippets": ["a", "b", "c"]}));
        // by day is the default: one entry per day
        assert_eq!(entries_value(&entries, &Args { group_by: Some(GroupBy::Day), ..all_args() }).len(), 4);
        assert_eq!(entries_value(&entries, &all_args()).len(), 4);
    }
}
