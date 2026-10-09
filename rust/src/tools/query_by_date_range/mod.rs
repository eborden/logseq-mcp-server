//! `logseq_query_by_date_range`: journal
//! entries for a range chosen one of three ways (explicit dates, the `last_n` most recent journals,
//! or a named `preset`), with the blocks of each day as trees, an optional search, a roll-up of the
//! pages the period was about (`summary.topConcepts`) and a cap on the blocks returned.
//!
//! Calls: at most 2 whatever the range or N (the roll-up reads the refs pulled with the blocks, so
//! it adds none). Explicit dates and presets: the journal pages in range, then every block on them.
//! `last_n`: the journal pages up to today (sorted and cut here), then every block on the pages that
//! were kept. The second call is skipped when no page matched. A `search_term` that names a page
//! with aliases (#69) adds one query (the alias group), only when there is a journal to search; any
//! other term costs the same one query, which finds no page. `resolve_refs` adds up to 2 more
//! Datalog queries however many days, none when no block holds a ref.
//!
//! Entries are oldest first, except `last_n`, which is newest first. For `last_n`, `dateRange` spans
//! the oldest to the newest page returned (0 to 0 if none), and each full-result `page` holds only
//! the attributes the up-to query pulls.
//!
//! The directory holds what only this tool uses: its queries, the answers it reads, the selection of
//! a range, the `search_term` matcher, the roll-up of top concepts, the `max_blocks` cut and its
//! warning, and its tip. What it shares is outside: the date presets and clock (`dates`), the block
//! budget (`block_budget`), the block trees (`block_tree`), the alias groups, `resolve_refs`, slim
//! output and `ResultMeta`.

mod cap;
mod queries;
mod search;
mod selection;
mod tips;
mod top_concepts;
mod wire;

use std::collections::HashMap;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::args::{YyyyMmDd, parse_args};
use crate::block_budget::count_blocks;
use crate::block_tree::{build_block_trees, camelize_keys};
use crate::client::LogseqClient;
use crate::dates::{CalendarDate, Clock, DatePreset};
use crate::entity::{id_of, page_display_name};
use crate::errors::ToolError;
use crate::meta::ResultWarning;
use crate::resolve::alias::{AliasSet, alias_set_warnings, resolve_alias_set_by_name};
use crate::resolve_refs::resolve_block_refs;
use crate::slim::{DEFAULT_SLIM_RESULTS, to_slim_block};
use crate::snippet::{first_chars, first_non_blank_line};
use crate::tips::tips_content;
use crate::tool::{input_schema, read_only_annotations, success_result};

use self::cap::{BlockCut, MAX_DATE_RANGE_BLOCKS, TruncationOptions, blocks_truncated, cap_entries};
use self::search::BlockMatcher;
use self::selection::{Resolved, Selection, resolve_selection};
use self::tips::date_range_tips;
use self::top_concepts::{ConceptRef, DEFAULT_TOP_CONCEPTS_LIMIT, concept_value, extract_concept_refs, roll_up_top_concepts};

pub use self::cap::DEFAULT_DATE_RANGE_MAX_BLOCKS;

pub const NAME: &str = "logseq_query_by_date_range";

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Query journal entries by start_date + end_date, last_n journals, or a preset (give exactly one), with optional search.\n\n\
**Use when:** \"what did I do last week?\" or catching up. summary.topConcepts shows what a period was about.\n\
**Can't find:** non-journal pages, days with no journal, or blocks past 200 (max_blocks, max 1000).\n\
**Alternatives:** logseq_get_concept_evolution, logseq_search_blocks.";

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
    DEFAULT_DATE_RANGE_MAX_BLOCKS
}

/// The tool's arguments. Unknown fields are ignored, as in every tool (see `input_schema`). Which
/// selection was given (exactly one of `start_date` with `end_date`, `last_n` or `preset`) and the
/// `YYYYMMDD` format are checked by [`query_journals`]; the types and the counts'
/// minimums are checked when the arguments are parsed.
#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq)]
pub struct Args {
    /// Start date in YYYYMMDD format (e.g., 20251115). Needs end_date
    #[schemars(with = "Option<f64>")]
    pub start_date: Option<YyyyMmDd>,
    /// End date in YYYYMMDD format (e.g., 20251120). Needs start_date
    #[schemars(with = "Option<f64>")]
    pub end_date: Option<YyyyMmDd>,
    /// The N most recent journals that exist (whole number, 1+), newest first
    #[schemars(range(min = 1))]
    pub last_n: Option<u64>,
    /// Named period in local time; weeks run Monday to Sunday
    pub preset: Option<DatePreset>,
    /// Optional search term to filter blocks
    pub search_term: Option<String>,
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

/// A count a `u32` holds: a larger one is as good as the largest, since `last_n` only ever cuts a
/// list at that many.
fn saturate(count: u64) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Query by Date Range")
        .with_annotations(read_only_annotations("Query by Date Range"))
}

/// A call: arguments read, the journals, then the tip.
pub async fn call(client: &LogseqClient, tips_enabled: bool, clock: Clock, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let args = parse_args::<Args>(arguments.as_ref())?;
    let result = query_journals(client, &args, clock.today()).await?;
    let mut content = vec![ContentBlock::text(result.json)];
    if tips_enabled {
        if let Some(tips) = tips_content(&date_range_tips(result.top_concept.as_deref())) {
            content.push(ContentBlock::text(tips));
        }
    }
    Ok(success_result(content))
}

/// One journal day of a result: its date, its page and the blocks on it as trees.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// `YYYYMMDD`
    pub date: i64,
    /// The page as the Editor API spells it (`camelizeKeys` of the pull)
    pub page: Value,
    /// The day's top-level blocks (kept ones only, after the cap), each with its `children`
    pub blocks: Vec<Value>,
}

/// What [`query_journals`] makes: the result as the text the tool prints, and what the tip reads.
#[derive(Debug, Clone, PartialEq)]
pub struct JournalsResult {
    pub json: String,
    /// `summary.topConcepts[0].name`
    pub top_concept: Option<String>,
}

/// A journal page the first query found.
struct Journal {
    /// The page as the Editor API spells it
    page: Map<String, Value>,
    id: Option<i64>,
    /// `page.journalDay || 0`
    day: i64,
}

/// `fetchPages`: the journal pages a query finds, or `None` when LogSeq answered `null`. `null` is
/// not `[]` (BR-0011, #269): an empty array is a range with no journals, `null` is no answer at all.
async fn fetch_journals(client: &LogseqClient, query: crate::edn::Query) -> Result<Option<Vec<Journal>>, ToolError> {
    let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
    let Some(pages) = wire::pages(&answer)? else { return Ok(None) };
    Ok(Some(
        pages
            .iter()
            .map(|pulled| {
                let page = camelize_keys(pulled);
                let id = page.get("id").and_then(crate::wire::whole_number);
                let day = page.get("journalDay").and_then(crate::wire::whole_number).unwrap_or(0);
                Journal { page, id, day }
            })
            .collect(),
    ))
}

/// No `howToFetchAll` on either warning: no parameter fetches what LogSeq did not answer (like
/// `pages_unavailable`, #64), so `hasMore` is unaffected. The retry advice is in the message.
const RETRY_ADVICE: &str = "Retry in a moment, or call logseq_get_graph_info to check which graph is open.";

fn journals_unavailable() -> ResultWarning {
    ResultWarning::new(
        "journals_unavailable",
        format!(
            "LogSeq returned no answer when looking up journal pages (possibly no graph open or a re-index \
             in progress), so the empty result may not mean there are no journals to show. {RETRY_ADVICE}"
        ),
    )
}

fn blocks_unavailable(page_count: usize) -> ResultWarning {
    ResultWarning::new(
        "blocks_unavailable",
        format!(
            "LogSeq returned no answer when looking up the blocks on {page_count} journal page(s) (possibly no graph \
             open or a re-index in progress), so their blocks are missing from this result (with a search term, \
             those days are left out). This does not mean the days are empty. {RETRY_ADVICE}"
        ),
    )
}

/// The first non-blank line of a block, trimmed and shortened (`snippetOf`), as the page outline
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

/// The block trees of the blocks one query pulled, and each block's concepts for the roll-up.
///
/// The query pulls each ref as a page map. The concepts are kept for the roll-up, and the tree gets
/// the bare `{ id }` refs the Editor API returns.
fn trees_of(blocks: Vec<Map<String, Value>>, page_ids: &[i64]) -> (HashMap<i64, Vec<Value>>, HashMap<i64, Vec<ConceptRef>>) {
    let mut refs_by_block = HashMap::new();
    let flat: Vec<Map<String, Value>> = blocks
        .into_iter()
        .map(|mut block| {
            let Some(refs) = block.get("refs").and_then(Value::as_array) else { return block };
            if let Some(id) = block.get("id").and_then(crate::wire::whole_number) {
                refs_by_block.insert(id, extract_concept_refs(&block));
            }
            // `refs.map(ref => ({ id: entityId(ref) }))`: a ref with no id is `{}`
            let bare: Vec<Value> = refs
                .iter()
                .map(|reference| {
                    let mut bare = Map::new();
                    if let Some(id) = id_of(Some(reference)) {
                        bare.insert("id".to_owned(), Value::from(id));
                    }
                    Value::Object(bare)
                })
                .collect();
            block.insert("refs".to_owned(), Value::Array(bare));
            block
        })
        .collect();
    (build_block_trees(flat, page_ids), refs_by_block)
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

/// Query journal entries for a range chosen one of three ways: explicit dates, the `last_n` most
/// recent journals, or a named `preset` (resolved against `today`, the local calendar day).
///
/// Fails with [`ToolError::InvalidParameter`] if the selection is missing, ambiguous or invalid,
/// before any LogSeq call is made.
pub async fn query_journals(client: &LogseqClient, args: &Args, today: CalendarDate) -> Result<JournalsResult, ToolError> {
    let selection = resolve_selection(
        Selection { start_date: args.start_date.map(|day| day.0), end_date: args.end_date.map(|day| day.0), last_n: args.last_n.map(saturate), preset: args.preset },
        today,
    )?;
    let search_term = args.search_term.as_deref().filter(|term| !term.is_empty());

    // Query 1: journal pages (may be empty), in the order entries are returned. A `null` answer is not
    // an empty one (BR-0011, #269): it reads as no journals here, and a warning says it was no answer.
    let mut unavailable: Vec<ResultWarning> = Vec::new();
    let (mut journals, range_start, range_end, newest_first) = match selection {
        Resolved::Range { start, end } => {
            let found = fetch_journals(client, queries::journal_pages_in_range(start, end)).await?;
            if found.is_none() {
                unavailable = vec![journals_unavailable()];
            }
            let mut journals = found.unwrap_or_default();
            journals.sort_by_key(|journal| journal.day);
            (journals, start, end, false)
        }
        Resolved::LastN { count, latest } => {
            let found = fetch_journals(client, queries::journal_pages_up_to(latest)).await?;
            if found.is_none() {
                unavailable = vec![journals_unavailable()];
            }
            let mut all = found.unwrap_or_default();
            all.sort_by_key(|journal| std::cmp::Reverse(journal.day));
            all.truncate(count as usize);
            // Journals are unique per day, so every page between the oldest and newest kept is one of
            // the kept pages: the range query below fetches exactly them.
            let end = all.first().map_or(0, |journal| journal.day);
            let start = all.last().map_or(0, |journal| journal.day);
            (all, start, end, true)
        }
    };

    // Query 2: every block on those pages (may be empty), rebuilt into trees. Skipped when there are
    // no pages; a second query never scales with range length.
    let mut trees: HashMap<i64, Vec<Value>> = HashMap::new();
    let mut refs_by_block: HashMap<i64, Vec<ConceptRef>> = HashMap::new();
    if !journals.is_empty() {
        let query = queries::journal_blocks_in_range(range_start, range_end);
        let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
        let rows = wire::blocks(&answer)?;
        // `null` here would otherwise show journal pages that exist with no blocks, as if the days were empty
        if rows.is_none() {
            unavailable = vec![blocks_unavailable(journals.len())];
        }
        let page_ids: Vec<i64> = journals.iter().filter_map(|journal| journal.id).collect();
        (trees, refs_by_block) = trees_of(rows.unwrap_or_default(), &page_ids);
    }

    // A search term that names a page with aliases also finds blocks written under the other names
    // (#69). One query, only when there is something to search; none for any text that is not such a
    // page. After the journal queries, so it never delays them.
    let alias_set: Option<AliasSet> = match search_term {
        Some(term) if !journals.is_empty() => resolve_alias_set_by_name(client, term).await?,
        _ => None,
    };
    let matcher = search_term.map(|term| BlockMatcher::new(term, alias_set.as_ref()));

    let mut all_entries: Vec<Entry> = Vec::new();
    let mut total_blocks = 0;
    for journal in journals.drain(..) {
        // every journal page has a tree, `[]` for a page with no blocks
        let blocks = journal.id.and_then(|id| trees.remove(&id)).unwrap_or_default();
        // Filter top-level blocks by search term if provided
        let kept: Vec<Value> = match &matcher {
            Some(matcher) => blocks.into_iter().filter(|block| matcher.matches(block)).collect(),
            None => blocks,
        };
        if !kept.is_empty() || search_term.is_none() {
            total_blocks += kept.len();
            all_entries.push(Entry { date: journal.day, page: Value::Object(journal.page), blocks: kept });
        }
    }

    let date_range = object_of(vec![("start", Value::from(range_start)), ("end", Value::from(range_end))]);
    // The summary describes every block found, cut or not (#61), so a cut result still shows what the period was about
    let mut summary = Map::new();
    summary.insert("totalDays".to_owned(), Value::from(all_entries.len()));
    summary.insert("totalBlocks".to_owned(), Value::from(total_blocks));
    // An empty `search_term` is no search, so it is not echoed
    if let Some(term) = search_term {
        summary.insert("searchTerm".to_owned(), Value::from(term));
    }
    let top = if args.top_concepts_limit > 0 {
        let top = roll_up_top_concepts(
            all_entries.iter().map(|entry| (entry.date, entry.blocks.as_slice())),
            &refs_by_block,
            args.top_concepts_limit,
        );
        summary.insert("topConcepts".to_owned(), Value::Array(top.iter().map(concept_value).collect()));
        top
    } else {
        Vec::new()
    };
    let top_concept = top.first().map(|concept| concept.name.clone());
    let summary = Value::Object(summary);

    // Cap the blocks (#61) on data already fetched, so it adds no API call. At or below the cap
    // nothing changes. What comes after (resolving refs, slimming) sees only the kept blocks.
    let cap = args.max_blocks.min(MAX_DATE_RANGE_BLOCKS as u64) as usize;
    let cut: Option<BlockCut> = cap_entries(&all_entries, cap, args.include_content);
    let (entries, totals) = match cut {
        Some(ref cut) => (cut.entries.clone(), Some((cut.total, all_entries.len()))),
        None => (all_entries, None),
    };

    // Which names the search covered (#69); absent unless the term named a page with aliases
    let mut warnings: Vec<ResultWarning> = alias_set.as_ref().map(|set| alias_set_warnings(&[set])).unwrap_or_default();
    warnings.extend(unavailable);
    if let Some(cut) = &cut {
        warnings.push(blocks_truncated(
            cut,
            cap,
            &TruncationOptions { nested: args.include_content, newest_first, start: range_start, end: range_end, requested: args.max_blocks },
        ));
    }
    let mut alias_parts: Vec<(&str, Value)> = Vec::new();
    if let Some(names) = alias_set.as_ref().and_then(AliasSet::resolved_aliases) {
        alias_parts.push(("resolvedAliases", Value::from(names)));
    }
    // The meta comes only with something to say, so output below the cap is unchanged
    let cut_meta = if warnings.is_empty() { Vec::new() } else { meta_parts(&warnings, totals) };

    let page_name = |entry: &Entry| page_display_name(Some(&entry.page));
    let mut parts: Vec<(&str, Value)> = vec![("dateRange", date_range)];

    if !args.include_content {
        let entries_value: Vec<Value> = entries
            .iter()
            .map(|entry| {
                let snippets: Vec<Value> = entry.blocks.iter().map(|block| Value::String(snippet_of(block))).collect();
                object_of(vec![
                    ("date", Value::from(entry.date)),
                    ("pageName", Value::from(page_name(entry))),
                    ("blockCount", Value::from(count_blocks(&entry.blocks))),
                    ("snippets", Value::Array(snippets)),
                ])
            })
            .collect();
        parts.push(("entries", Value::Array(entries_value)));
        parts.push(("summary", summary));
        parts.extend(alias_parts);
        parts.extend(cut_meta);
        return Ok(JournalsResult { json: object_of(parts).to_string(), top_concept });
    }

    // Opt-in (#18): resolve once over every returned block, whatever the number of days. Only the
    // kept blocks: each block resolves on its own, so their output is the same, and the batched
    // queries never carry the refs of blocks that were cut.
    let mut entries = entries;
    let mut meta = cut_meta;
    if args.resolve_refs {
        let roots: Vec<Value> = entries.iter().flat_map(|entry| entry.blocks.iter().cloned()).collect();
        let resolved = resolve_block_refs(client, &roots).await?;
        let mut offset = 0;
        for entry in &mut entries {
            let len = entry.blocks.len();
            entry.blocks = resolved.blocks[offset..offset + len].to_vec();
            offset += len;
        }
        warnings.extend(resolved.warnings);
        meta = meta_parts(&warnings, totals);
    }

    let entries_value: Vec<Value> = entries
        .iter()
        .map(|entry| {
            let mut map = Map::new();
            map.insert("date".to_owned(), Value::from(entry.date));
            if args.slim_results {
                map.insert("pageName".to_owned(), Value::from(page_name(entry)));
                // The entry names the page, so its blocks don't repeat it (#42)
                let blocks = entry.blocks.iter().filter_map(Value::as_object).map(|block| Value::Object(to_slim_block(block, "")));
                map.insert("blocks".to_owned(), Value::Array(blocks.collect()));
            } else {
                map.insert("page".to_owned(), entry.page.clone());
                map.insert("blocks".to_owned(), Value::Array(entry.blocks.clone()));
            }
            Value::Object(map)
        })
        .collect();
    parts.push(("entries", Value::Array(entries_value)));
    parts.push(("summary", summary));
    parts.extend(alias_parts);
    parts.extend(meta);
    Ok(JournalsResult { json: object_of(parts).to_string(), top_concept })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::testing::{meaning, schema_of};
    use serde_json::json;

    #[test]
    fn the_schema_means_what_the_typescript_one_means() {
        // `inputSchema` of logseq_query_by_date_range in the ADR-0016 snapshot
        let typescript = json!({
            "type": "object",
            "properties": {
                "start_date": {"type": "number", "description": "Start date in YYYYMMDD format (e.g., 20251115). Needs end_date"},
                "end_date": {"type": "number", "description": "End date in YYYYMMDD format (e.g., 20251120). Needs start_date"},
                "last_n": {"type": "integer", "minimum": 1, "description": "The N most recent journals that exist (whole number, 1+), newest first"},
                "preset": {
                    "type": "string",
                    "enum": ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "this_year", "year_to_date"],
                    "description": "Named period in local time; weeks run Monday to Sunday"
                },
                "search_term": {"type": "string", "description": "Optional search term to filter blocks"},
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
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&typescript));
    }

    #[test]
    fn the_tool_is_read_only_and_titled_as_in_typescript() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Query by Date Range"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Query by Date Range", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
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
        sweep::<Args>(base.clone(), "start_date", Takes::Date, false);
        sweep::<Args>(base.clone(), "end_date", Takes::Date, false);
        sweep::<Args>(json!({}), "last_n", Takes::Count(1), false);
        sweep::<Args>(without("preset"), "preset", Takes::Words(&DATE_PRESET_WORDS), false);
        sweep::<Args>(base.clone(), "search_term", Takes::Text, false);
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
                start_date: None,
                end_date: None,
                last_n: Some(7),
                preset: None,
                search_term: None,
                slim_results: true,
                include_content: true,
                top_concepts_limit: 10,
                resolve_refs: false,
                max_blocks: 200,
            }
        );
        assert_eq!(serde_json::from_value::<Args>(json!({"last_n": 7})).unwrap(), args);
        let all = read(json!({"preset": "last_week", "top_concepts_limit": 0, "max_blocks": 5000000000_u64, "last_n": null})).unwrap();
        assert_eq!((all.preset, all.last_n, all.top_concepts_limit, all.max_blocks), (Some(DatePreset::LastWeek), None, 0, 5_000_000_000));
    }

    #[test]
    fn the_first_bad_argument_in_schema_order_is_the_one_reported() {
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
}
