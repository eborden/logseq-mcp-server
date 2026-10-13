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
//! The blocks are cut by `max_blocks` (nested ones counted, the entries in order, `cap.rs`) and then to the character
//! budget (#485); a raise of `max_blocks` is offered only where the raised result fits. A `null` answer to a lookup is
//! not an empty one (BR-0011): the result carries a warning, never an empty list.
//!
//! The directory holds what only this tool uses: its queries, the answers it reads, the two ways to fetch the days
//! (`journals.rs`, `mentions.rs`), the day and week arithmetic (`days.rs`), the roll-up of top concepts, the `max_blocks`
//! cut and its warnings, and its tip. What it shares is outside: the period (`period`), the date presets and clock
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

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::args::{YyyyMmDd, parse_args};
use crate::block_budget::count_blocks;
use crate::budget::size;
use crate::client::LogseqClient;
use crate::dates::{CalendarDate, Clock, DatePreset};
use crate::entity::page_display_name;
use crate::errors::{InvalidParameter, ToolError};
use crate::meta::ResultWarning;
use crate::period::{Period, Selection, resolve_period};
use crate::resolve_refs::resolve_block_refs;
use crate::slim::{DEFAULT_SLIM_RESULTS, to_slim_block};
use crate::snippet::{first_chars, first_non_blank_line};
use crate::tips::tips_content;
use crate::tool::{input_schema, read_only_annotations, success_result};
use crate::tools::find_blocks::scope::check_names;

use self::cap::{BlockCut, MAX_BLOCKS, Raises, TruncationOptions, blocks_truncated, cap_entries, day_count, fits_with_margin, write_within_budget};
use self::days::period_key;
use self::tips::date_range_tips;
use self::top_concepts::{ConceptRef, DEFAULT_TOP_CONCEPTS_LIMIT, concept_value, roll_up_top_concepts};

pub use self::cap::DEFAULT_MAX_BLOCKS;
pub use self::days::GroupBy;

pub const NAME: &str = "logseq_explore_timeline";

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Explore a page or period over time: blocks by day (group_by week or month), with summary.topConcepts. Give page (its blocks and blocks linking to it), a period (start_date + end_date, last_n days or preset), or both; a period leaves out non-journal pages.\n\n\
**Can't find:** text matches (logseq_find_blocks), days with no journal, or blocks past max_blocks (see hasMore).";

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
    /// Max blocks across all days, nested ones counted (top-level with include_content false), default 200, max 1000
    #[serde(default = "default_max_blocks")]
    pub max_blocks: u64,
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

/// A call: arguments read, the timeline, then the tip.
pub async fn call(client: &LogseqClient, tips_enabled: bool, clock: Clock, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let args = parse_args::<Args>(arguments.as_ref())?;
    let result = explore_timeline(client, &args, clock.today()).await?;
    let mut content = vec![ContentBlock::text(result.json)];
    if tips_enabled {
        if let Some(tips) = tips_content(&date_range_tips(result.top_concept.as_deref())) {
            content.push(ContentBlock::text(tips));
        }
    }
    Ok(success_result(content))
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

/// `{"hasMore":..,"warnings":[..],"totals":{..}}` as keys of the result: `hasMore` is true when any
/// warning offers a way to fetch the rest, and `totals` (what there was before a cut) comes only
/// with a cut.
fn meta_parts(warnings: &[ResultWarning], totals: Option<(usize, usize)>) -> Vec<(&'static str, Value)> {
    let mut parts = vec![
        ("hasMore", Value::Bool(warnings.iter().any(|warning| warning.how_to_fetch_all.is_some()))),
        ("warnings", serde_json::to_value(warnings).expect("warnings serialize")),
    ];
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

/// What the result writes besides its entries and its meta: the keys of what was answered, and the range and summary.
struct Frame {
    answered: Vec<(&'static str, Value)>,
    date_range: Option<Value>,
    summary: Value,
}

/// The text of the result for some entries, the warnings and the `totals`, which the character budget measures (#485).
/// The meta comes only with something to say, so output below the cap is unchanged; resolving refs always brings it.
fn write(frame: &Frame, args: &Args, entries: &[Entry], warnings: &[ResultWarning], totals: Option<(usize, usize)>) -> String {
    let always_meta = args.include_content && args.resolve_refs;
    let mut parts: Vec<(&str, Value)> = frame.answered.iter().map(|(key, value)| (*key, value.clone())).collect();
    if let Some(range) = &frame.date_range {
        parts.push(("dateRange", range.clone()));
    }
    if always_meta || !warnings.is_empty() {
        parts.extend(meta_parts(warnings, totals));
    }
    parts.push(("summary", frame.summary.clone()));
    parts.push(("entries", Value::Array(entries_value(entries, args))));
    object_of(parts).to_string()
}

/// Explore a page or a period over time: a period alone gives the journal days in it, a page the days its blocks and
/// the blocks that link to it are on, and both the page's days inside the period.
///
/// Fails with [`ToolError::InvalidParameter`] if neither is given, the period is missing, ambiguous or invalid, or the
/// page name is blank, before any LogSeq call is made. A page that is missing or ambiguous fails with
/// [`ToolError::PageNotFound`] or [`ToolError::AmbiguousPage`]. `today` is the local calendar day a `last_n` or a preset
/// counts from.
pub async fn explore_timeline(client: &LogseqClient, args: &Args, today: CalendarDate) -> Result<TimelineResult, ToolError> {
    let selection = Selection {
        start_date: args.start_date.map(|day| day.0),
        end_date: args.end_date.map(|day| day.0),
        last_n: args.last_n.map(saturate),
        preset: args.preset,
    };
    let period = resolve_period(selection, today)?;
    let page = args.page.as_deref();
    check_names(page, None)?;
    if page.is_none() && period.is_none() {
        return Err(nothing_asked().into());
    }

    // `last_n` with no page lists the newest days first, so a cap keeps the most recent
    let newest_first = page.is_none() && args.last_n.is_some();
    let found = match (page, period) {
        (Some(name), period) => mentions::fetch(client, name, period).await?,
        (None, Some(period)) => journals::fetch(client, period, newest_first).await?,
        (None, None) => unreachable!("a call with neither a page nor a period was refused above"),
    };
    let Found { entries: all_entries, mut refs_by_block, warnings: found_warnings, answered, span, group } = found;

    // The days the result covers: the period, or for a page with no period the span of its dated blocks
    let range = period.map(|Period { start, end }| (start, end)).or(span);
    let date_range = range.map(|(start, end)| object_of(vec![("start", Value::from(start)), ("end", Value::from(end))]));
    let (range_start, range_end) = range.unwrap_or((0, 0));

    // The summary describes every block found, cut or not (#61), so a cut result still shows what it was about
    let total_blocks: usize = all_entries.iter().map(|entry| entry.blocks.len()).sum();
    let mut summary = Map::new();
    summary.insert("totalDays".to_owned(), Value::from(day_count(&all_entries)));
    summary.insert("totalBlocks".to_owned(), Value::from(total_blocks));
    let top = if args.top_concepts_limit > 0 {
        for concepts in refs_by_block.values_mut() {
            concepts.retain(|concept| !group.contains(&concept.id));
        }
        let top = roll_up_top_concepts(all_entries.iter().map(|entry| (entry.date, entry.blocks.as_slice())), &refs_by_block, args.top_concepts_limit);
        summary.insert("topConcepts".to_owned(), Value::Array(top.iter().map(concept_value).collect()));
        top
    } else {
        Vec::new()
    };
    let top_concept = top.first().map(|concept| concept.name.clone());
    let frame = Frame { answered, date_range, summary: Value::Object(summary) };

    let options = TruncationOptions {
        nested: args.include_content,
        newest_first,
        start: range_start,
        end: range_end,
        requested: args.max_blocks,
        with_page: page.is_some(),
        // a period leaves out the mentions on non-journal pages, so there are none to lose
        has_undated: period.is_none() && all_entries.iter().any(|entry| entry.date.is_none() && !entry.blocks.is_empty()),
    };

    // Cap the blocks (#61) on data already fetched, so it adds no API call. At or below the cap
    // nothing changes. What comes after (resolving refs, slimming) sees only the kept blocks.
    let cap = args.max_blocks.min(MAX_BLOCKS as u64) as usize;
    let cut: Option<BlockCut> = cap_entries(&all_entries, cap, args.include_content);
    let mut warnings: Vec<ResultWarning> = found_warnings;
    if let Some(cut) = &cut {
        // Whether a raise of `max_blocks` would fit the character budget, measured on the entries before the cap
        let fits = |raised: &[Entry]| fits_with_margin(size(&write(&frame, args, raised, &warnings, None)));
        let raises = Raises { all: &all_entries, nested: args.include_content, fits: &fits };
        let warning = blocks_truncated(cut, cap, &options, &raises);
        warnings.push(warning);
    }
    let (entries, totals) = match cut {
        Some(cut) => (cut.entries.clone(), Some((cut.total, day_count(&all_entries)))),
        None => (all_entries, None),
    };

    // Opt-in (#18): resolve once over every returned block, whatever the number of days. Only the
    // kept blocks: each block resolves on its own, so their output is the same, and the batched
    // queries never carry the refs of blocks the `max_blocks` cap cut. The character budget (#485) cuts after
    // this, on the resolved text, so they may carry refs of blocks it then drops: the same calls as before.
    let mut entries = entries;
    if args.include_content && args.resolve_refs {
        let roots: Vec<Value> = entries.iter().flat_map(|entry| entry.blocks.iter().cloned()).collect();
        let resolved = resolve_block_refs(client, &roots).await?;
        let mut offset = 0;
        for entry in &mut entries {
            let len = entry.blocks.len();
            entry.blocks = resolved.blocks[offset..offset + len].to_vec();
            offset += len;
        }
        warnings.extend(resolved.warnings);
    }

    let json = write_within_budget(&entries, &warnings, totals, &options, |entries, warnings, totals| write(&frame, args, entries, warnings, totals));
    Ok(TimelineResult { json, top_concept })
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
                    "description": "Max blocks across all days, nested ones counted (top-level with include_content false), default 200, max 1000"
                },
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
        sweep::<Args>(base, "max_blocks", Takes::Count(0), false);
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
        let parts = meta_parts(&[warning], Some((9, 2)));
        assert_eq!(
            object_of(parts).to_string(),
            r#"{"hasMore":true,"warnings":[{"code":"c","message":"m","howToFetchAll":"h"}],"totals":{"blocks":9,"days":2}}"#
        );
        assert_eq!(object_of(meta_parts(&[], None)).to_string(), r#"{"hasMore":false,"warnings":[]}"#);
    }

    fn day(date: i64, name: &str, blocks: Vec<Value>) -> Entry {
        Entry { date: Some(date), page: json!({"id": date, "original-name": name, "journal-day": date}), blocks }
    }

    fn frame(answered: Vec<(&'static str, Value)>, with_range: bool) -> Frame {
        Frame {
            answered,
            date_range: with_range.then(|| json!({"start": 20250101, "end": 20250131})),
            summary: json!({"totalDays": 1, "totalBlocks": 1}),
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
        let text = write(&frame(answered, true), &all_args(), &entries, &[warning.clone()], Some((9, 2)));
        let value: Value = serde_json::from_str(&text).unwrap();
        // what was answered, what must not be missed (the flags, the warnings, the counts, the overview), then the data
        assert_eq!(keys(&value), ["page", "resolvedFrom", "resolvedAliases", "dateRange", "hasMore", "warnings", "totals", "summary", "entries"]);
        // a period alone has no page; with nothing to say there is no meta
        let quiet = write(&frame(vec![], true), &all_args(), &entries, &[], None);
        assert_eq!(keys(&serde_json::from_str::<Value>(&quiet).unwrap()), ["dateRange", "summary", "entries"]);
        // a page with no dated mention has no range
        let bare = write(&frame(vec![("page", json!("atlas"))], false), &all_args(), &[], &[warning], None);
        assert_eq!(keys(&serde_json::from_str::<Value>(&bare).unwrap()), ["page", "hasMore", "warnings", "summary", "entries"]);
        // resolving refs always brings the meta
        let resolving = Args { resolve_refs: true, ..all_args() };
        let text = write(&frame(vec![], true), &resolving, &entries, &[], None);
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
            [json!("2025-W01"), json!("2025-W03"), json!(null)]
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
