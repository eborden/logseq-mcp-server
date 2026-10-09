//! `logseq_get_concept_evolution` (the Rust side of `src/tools/get-concept-evolution.ts`): a concept
//! over time. The blocks on its page and the blocks that link to it, by journal day, oldest first, with
//! the mentions on non-journal pages last, optionally grouped by day, week or month and cut by date.
//!
//! Calls: the page resolver (1 query for an exact name, an alias or an ISO date; a namespace-leaf name
//! adds the leaf query, and a missing page adds the suggestion lookup before it fails), the alias lookup
//! (1 query, only when the page has alias links), the page's block tree (`getPageBlocksTree`), the page
//! itself (`getPage`, to put its day on the tree's blocks) and the mentions (1 Datalog query, over the
//! whole alias group for a page with aliases): 4 for a page with no aliases and an exact name, 5 with
//! aliases. The cap on mentions is applied after the fetch, so it costs no call.
//!
//! The result is the entities LogSeq sent (BR-0004): the tree's blocks with their children, each with
//! the page's own entity as its `page`, and the mentions as the query pulled them. This tool makes no
//! tips and has no Markdown form.
//!
//! No clock is read: the weeks and months are calendar arithmetic on the `YYYYMMDD` number, so the
//! result is the same in every time zone (#249).

mod queries;
mod timeline;
mod wire;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::args::Arguments;
use crate::client::LogseqClient;
use crate::edn::{PageId, PageName};
use crate::errors::ToolError;
use crate::js;
use crate::meta::ResultWarning;
use crate::params::{ParamAliases, resolve_param_aliases};
use crate::resolve::alias::{alias_set_warnings, resolve_alias_set};
use crate::resolve::{RETRY_ADVICE, require_page};
use crate::tool::{input_schema, read_only_annotations, result_value, success_result};
use crate::tools::build_context::resolved_from;
use crate::tools::get_page::wire as page_wire;

use self::queries::{blocks_referencing_page, blocks_referencing_pages};
use self::timeline::{
    Entry, GROUP_BY_VALUES, cap_timeline, day_of, entries_truncated, filter_by_dates, full_timeline, period_key, shown_places,
    unique_by_id,
};
use self::wire::block_rows;

pub use self::timeline::GroupBy;

pub const NAME: &str = "logseq_get_concept_evolution";

/// The description the TypeScript server gives the tool (`src/tool-descriptions.ts`).
const DESCRIPTION: &str = "Track a concept over time: blocks on its page and blocks linking to it, grouped by day, week or month, with optional date bounds.\n\n\
**Use when:** \"how has X evolved?\" or \"what's the history of Y?\"\n\
**Can't find:** unlinked plain-text mentions (logseq_search_blocks), topics with no page, or dated mentions past 500 (narrow dates).\n\
**Alternatives:** logseq_query_by_date_range for plain journal queries.";

/// Parameter aliases (BR-0008): not in the schema, so they cost nothing in `tools/list`.
const ALIASES: ParamAliases = &[("concept_name", &["name", "page", "page_name"])];

/// Mentions kept when `max_entries` is absent.
pub const DEFAULT_MAX_ENTRIES: u64 = 100;

fn default_max_entries() -> u32 {
    DEFAULT_MAX_ENTRIES as u32
}

/// The tool's arguments, as `tools/list` shows them. The schema is generated from this type
/// (ADR-0019); a call reads its arguments through [`Arguments`], which words a bad one as the
/// TypeScript server does. Unknown fields are ignored, as every TypeScript tool ignores them. The tool
/// does no range check on the dates: 0 or an absent date is no bound, and any other whole number is compared
/// with each block's `YYYYMMDD` day.
#[derive(Debug, Deserialize, JsonSchema)]
#[allow(dead_code)]
pub struct Args {
    /// Concept to track (page name, alias or ISO date)
    pub concept_name: String,
    /// Optional start date in YYYYMMDD format
    #[schemars(with = "Option<f64>")]
    pub start_date: Option<i64>,
    /// Optional end date in YYYYMMDD format
    #[schemars(with = "Option<f64>")]
    pub end_date: Option<i64>,
    /// Optional grouping period
    pub group_by: Option<GroupBy>,
    /// Max mentions, oldest first (default: 100, max: 500)
    #[serde(default = "default_max_entries")]
    pub max_entries: u32,
}

/// What a call asked for, read from the arguments in the order the schema lists them, so the first
/// one that is wrong is the one reported, as `parseArgs` does.
#[derive(Debug, PartialEq)]
struct Request {
    concept_name: String,
    options: Options,
}

fn read_args(arguments: Option<&JsonObject>) -> Result<Request, ToolError> {
    let read = Arguments::new(arguments);
    let concept_name = read.required_string("concept_name")?;
    let start_date = read.optional_whole("start_date", "start_date: 20251115")?;
    let end_date = read.optional_whole("end_date", "end_date: 20251120")?;
    let group_by = read.optional_enum("group_by", GROUP_BY_VALUES)?.and_then(GroupBy::from_word);
    let max_entries = read.count_or("max_entries", 0, DEFAULT_MAX_ENTRIES)?;
    Ok(Request { concept_name, options: Options { start_date, end_date, group_by, max_entries } })
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Get Concept Evolution")
        .with_annotations(read_only_annotations("Get Concept Evolution"))
}

/// A call: aliases folded, arguments read, the timeline. This tool makes no tips.
pub async fn call(client: &LogseqClient, _tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let arguments = resolve_param_aliases(ALIASES, arguments)?;
    let request = read_args(arguments.as_ref())?;
    let evolution = get_concept_evolution(client, &request.concept_name, request.options).await?;
    Ok(success_result(vec![ContentBlock::text(js::json_stringify(&evolution.to_value()))]))
}

/// What `getConceptEvolution` takes beyond the concept (`ConceptEvolutionOptions`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Options {
    /// `YYYYMMDD`; 0 or absent is no bound
    pub start_date: Option<i64>,
    /// `YYYYMMDD`; 0 or absent is no bound
    pub end_date: Option<i64>,
    pub group_by: Option<GroupBy>,
    /// Mentions kept, clamped to 0..500. The timeline's order decides which: oldest first, mentions
    /// with no date last.
    pub max_entries: u64,
}

impl Default for Options {
    fn default() -> Self {
        Options { start_date: None, end_date: None, group_by: None, max_entries: DEFAULT_MAX_ENTRIES }
    }
}

/// The counts over every mention found, whether or not the timeline kept it all.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Summary {
    pub total_mentions: usize,
    pub earliest: Option<i64>,
    pub latest: Option<i64>,
    pub journal_mentions: usize,
    pub non_journal_mentions: usize,
}

/// A concept over time (`ConceptEvolutionResult`).
#[derive(Debug, Clone, PartialEq)]
pub struct ConceptEvolution {
    /// The name as the caller gave it
    pub concept: String,
    pub resolved_from: Option<Value>,
    pub resolved_aliases: Option<Vec<String>>,
    /// An alias group cut at its maximum or not looked up, a lookup LogSeq did not answer, or mentions cut
    /// at `max_entries`; empty otherwise
    pub warnings: Vec<ResultWarning>,
    /// How many mentions there were, when the timeline cut some
    pub total_mentions_before_cut: Option<usize>,
    /// `{ date, blocks }` per day, oldest first, the undated last
    pub timeline: Vec<(Option<i64>, Vec<Value>)>,
    /// Period key to blocks, in the order the periods were first met; present when `group_by` was given
    pub grouped_timeline: Option<Vec<(String, Vec<Value>)>>,
    pub summary: Summary,
}

/// `totals`: how many mentions there were before the timeline cut some.
#[derive(Serialize)]
struct MentionTotals {
    mentions: usize,
}

/// The completeness keys, there only when a warning applies (`totals` only with a cut).
#[derive(Serialize)]
struct Completeness<'a> {
    #[serde(rename = "hasMore")]
    has_more: bool,
    warnings: &'a [ResultWarning],
    #[serde(skip_serializing_if = "Option::is_none")]
    totals: Option<MentionTotals>,
}

/// One day of the timeline: its date (`null` for the undated mentions) and the mentions on it.
#[derive(Serialize)]
struct TimelineEntry<'a> {
    date: Option<i64>,
    blocks: &'a [Value],
}

/// The period keys of `groupedTimeline` as an object, in the order the periods were first met.
struct GroupedTimeline<'a>(&'a [(String, Vec<Value>)]);

impl Serialize for GroupedTimeline<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_map(self.0.iter().map(|(period, blocks)| (period, blocks)))
    }
}

/// The span the mentions cover, `null` where there is no mention to bound it.
#[derive(Serialize)]
struct DateRange {
    earliest: Option<i64>,
    latest: Option<i64>,
}

/// `summary`: the counts over every mention found, in the order mentions, when, then the split.
#[derive(Serialize)]
struct SummaryOutput {
    #[serde(rename = "totalMentions")]
    total_mentions: usize,
    #[serde(rename = "dateRange")]
    date_range: DateRange,
    #[serde(rename = "journalMentions")]
    journal_mentions: usize,
    #[serde(rename = "nonJournalMentions")]
    non_journal_mentions: usize,
}

/// A result as written, in BR-0013's order: what was answered (`concept`, `resolvedFrom`, `resolvedAliases`), what
/// must not be missed (`hasMore`, `warnings`, `totals`, then `summary`), then the data (`timeline`, `groupedTimeline`).
#[derive(Serialize)]
struct EvolutionOutput<'a> {
    concept: &'a str,
    #[serde(rename = "resolvedFrom", skip_serializing_if = "Option::is_none")]
    resolved_from: Option<&'a Value>,
    #[serde(rename = "resolvedAliases", skip_serializing_if = "Option::is_none")]
    resolved_aliases: Option<&'a [String]>,
    #[serde(flatten)]
    completeness: Option<Completeness<'a>>,
    summary: SummaryOutput,
    timeline: Vec<TimelineEntry<'a>>,
    #[serde(rename = "groupedTimeline", skip_serializing_if = "Option::is_none")]
    grouped_timeline: Option<GroupedTimeline<'a>>,
}

impl ConceptEvolution {
    /// The result in BR-0013's key order.
    pub fn to_value(&self) -> Value {
        let totals = self.total_mentions_before_cut.map(|mentions| MentionTotals { mentions });
        let completeness = (!self.warnings.is_empty()).then(|| Completeness {
            has_more: self.warnings.iter().any(|warning| warning.how_to_fetch_all.is_some()),
            warnings: &self.warnings,
            totals,
        });
        result_value(&EvolutionOutput {
            concept: &self.concept,
            resolved_from: self.resolved_from.as_ref(),
            resolved_aliases: self.resolved_aliases.as_deref(),
            completeness,
            summary: SummaryOutput {
                total_mentions: self.summary.total_mentions,
                date_range: DateRange { earliest: self.summary.earliest, latest: self.summary.latest },
                journal_mentions: self.summary.journal_mentions,
                non_journal_mentions: self.summary.non_journal_mentions,
            },
            timeline: self.timeline.iter().map(|(date, blocks)| TimelineEntry { date: *date, blocks }).collect(),
            grouped_timeline: self.grouped_timeline.as_deref().map(GroupedTimeline),
        })
    }
}

/// The warnings for a `null` answer to one of the three lookups (BR-0011). No `howToFetchAll` on any: no
/// parameter fetches what LogSeq did not answer (like `pages_unavailable`, #64), so none adds to `hasMore`.
fn page_blocks_unavailable() -> ResultWarning {
    ResultWarning::new(
        "page_blocks_unavailable",
        format!(
            "LogSeq returned no answer when looking up the blocks of this page (possibly no graph open or a re-index in \
             progress), so the page's own blocks are missing from the timeline. This does not mean the page has no \
             blocks. {RETRY_ADVICE}"
        ),
    )
}

fn page_unavailable_warning() -> ResultWarning {
    ResultWarning::new(
        "page_unavailable",
        format!(
            "LogSeq returned no answer when looking up this page (possibly no graph open or a re-index in progress), so \
             the page's blocks lost their day and are listed as undated mentions. This does not mean the page has no \
             day. {RETRY_ADVICE}"
        ),
    )
}

fn mentions_unavailable_warning() -> ResultWarning {
    ResultWarning::new(
        "mentions_unavailable",
        format!(
            "LogSeq returned no answer when looking up the blocks that mention this concept (possibly no graph open or a \
             re-index in progress), so the mentions are missing from the timeline. This does not mean nothing \
             mentions it. {RETRY_ADVICE}"
        ),
    )
}

/// `getConceptEvolution`: track how a concept evolves over time.
///
/// `concept_name` is a page name, an alias or an ISO date (`2025-01-01`). When the name was an alias,
/// date or namespace leaf rather than an exact name, `resolvedFrom` says which page was used. Mentions
/// under any alias of the page are included (blocks that link one name, and the blocks of the alias
/// pages themselves); `resolvedAliases` lists the names covered.
///
/// Fails with [`ToolError::PageNotFound`] (guidance with the closest names) if no page matches and
/// [`ToolError::AmbiguousPage`] (with the candidates) if several do.
pub async fn get_concept_evolution(client: &LogseqClient, concept_name: &str, options: Options) -> Result<ConceptEvolution, ToolError> {
    let Options { start_date, end_date, group_by, max_entries } = options;

    // Resolve the name first (exact name, alias or ISO date, in one query)
    let resolved = require_page(client, concept_name).await?;
    let lookup_name = resolved.lookup_name.clone();

    // The names this page goes by (#69): a page with no `alias::` costs no call here
    let alias_set = resolve_alias_set(client, &resolved.page).await?;

    // The page's own blocks, as a tree
    let answer = client.call_api(page_wire::BLOCKS_METHOD, &[Value::from(lookup_name.as_str())]).await?;
    let tree = page_wire::blocks(&answer)?;

    // The page itself, to enrich the tree's blocks, which name their page by a bare `{ id }`
    let answer = client.call_api(page_wire::PAGE_METHOD, &[Value::from(lookup_name.as_str())]).await?;
    let concept_page = page_wire::page(&answer)?;
    let mut tree = tree;
    // A `null` page leaves the tree's blocks with their bare `{ id }` page, so they would lose their day and become
    // undated mentions: that is `page_unavailable` (BR-0011), said only when there are blocks to enrich.
    let mut page_unavailable = false;
    if let Some(blocks) = tree.as_mut() {
        match concept_page.as_ref() {
            Some(page) => {
                for block in blocks {
                    if let Value::Object(map) = block {
                        map.insert("page".to_owned(), page.clone());
                    }
                }
            }
            None => page_unavailable = !blocks.is_empty(),
        }
    }

    // Also search for inline mentions using Datalog. For an alias group, one query matches references
    // to any of its names and adds the blocks of the alias pages (the page's own come from the tree).
    let main_page_id = resolved.page.entity_id();
    let query = if alias_set.has_aliases() {
        let ids = alias_set.ids()?;
        let own: Vec<PageId> = ids.iter().copied().filter(|id| Some(id.get() as i64) != main_page_id).collect();
        blocks_referencing_pages(&ids, &own)
    } else {
        blocks_referencing_page(&PageName::new(&lookup_name))
    };
    let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
    // A `null` answer is not "no mentions" (BR-0011): the concept is listed without any, and the result says so.
    let mentions = block_rows(&answer)?;

    // Combine and deduplicate. A `null` block tree is not "no blocks on the page" either (BR-0011).
    let blocks_unavailable = tree.is_none();
    let mentions_unavailable = mentions.is_none();
    let all_blocks: Vec<Value> = tree.unwrap_or_default().into_iter().chain(mentions.unwrap_or_default()).collect();
    let unique = unique_by_id(all_blocks);

    // Filter by date range
    let filtered = filter_by_dates(unique, start_date, end_date);

    // Mentions there are before the cap (#61): the summary and the warning count them all
    let total = filtered.len();

    // The timeline, then the mentions the cap keeps in its order: oldest first, undated last
    let full = full_timeline(&filtered);
    let kept = cap_timeline(&full, max_entries);
    let shown = shown_places(total, &kept);

    // Group by period if requested, over the mentions the timeline kept, in the order they were found
    let grouped_timeline = group_by.map(|period| {
        let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
        for &place in &shown {
            let block = &filtered[place];
            // `if (!date) continue`; a date with no week is no more in a period than an undated block
            let Some(key) = day_of(block).and_then(|date| period_key(period, date)) else { continue };
            match groups.iter_mut().find(|(seen, _)| *seen == key) {
                Some((_, blocks)) => blocks.push(block.clone()),
                None => groups.push((key, vec![block.clone()])),
            }
        }
        groups
    });

    // Summary over every mention found
    let dates: Vec<i64> = filtered.iter().filter_map(day_of).collect();
    let summary = Summary {
        total_mentions: total,
        earliest: dates.iter().copied().min(),
        latest: dates.iter().copied().max(),
        journal_mentions: dates.len(),
        non_journal_mentions: total - dates.len(),
    };

    let mut warnings = alias_set_warnings(&[&alias_set]);
    if blocks_unavailable {
        warnings.push(page_blocks_unavailable());
    }
    if page_unavailable {
        warnings.push(page_unavailable_warning());
    }
    if mentions_unavailable {
        warnings.push(mentions_unavailable_warning());
    }
    let cut = total > shown.len();
    if cut {
        warnings.push(entries_truncated(&full, &kept, total, shown.len(), max_entries));
    }

    let timeline = kept.iter().map(|Entry { date, blocks }| (*date, blocks.iter().map(|&place| filtered[place].clone()).collect())).collect();
    Ok(ConceptEvolution {
        concept: concept_name.to_owned(),
        resolved_from: resolved_from(concept_name, &resolved),
        resolved_aliases: alias_set.resolved_aliases(),
        warnings,
        total_mentions_before_cut: cut.then_some(total),
        timeline,
        grouped_timeline,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::testing::{keys, meaning, schema_of};
    use serde_json::json;

    fn args(value: Value) -> Option<JsonObject> {
        value.as_object().cloned()
    }

    #[test]
    fn the_concept_evolution_schema_means_what_the_typescript_one_means() {
        // `inputSchema` of logseq_get_concept_evolution in the ADR-0016 snapshot
        let typescript = json!({
            "type": "object",
            "properties": {
                "concept_name": {"type": "string", "description": "Concept to track (page name, alias or ISO date)"},
                "start_date": {"type": "number", "description": "Optional start date in YYYYMMDD format"},
                "end_date": {"type": "number", "description": "Optional end date in YYYYMMDD format"},
                "group_by": {"type": "string", "enum": ["day", "week", "month"], "description": "Optional grouping period"},
                "max_entries": {"type": "integer", "minimum": 0, "default": 100, "description": "Max mentions, oldest first (default: 100, max: 500)"},
            },
            "required": ["concept_name"],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&typescript));
    }

    #[test]
    fn the_tool_is_read_only_and_titled_as_in_typescript() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Get Concept Evolution"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Get Concept Evolution", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
        assert!(tool.description.as_deref().unwrap().contains("**Can't find:**"));
    }

    #[test]
    fn the_arguments_are_read_in_schema_order_and_the_aliases_are_folded() {
        let folded = resolve_param_aliases(ALIASES, args(json!({"name": "Atlas", "group_by": "week", "start_date": 20250101, "max_entries": 7}))).unwrap();
        let request = read_args(folded.as_ref()).unwrap();
        assert_eq!(request.concept_name, "Atlas");
        assert_eq!(
            request.options,
            Options { start_date: Some(20250101), end_date: None, group_by: Some(GroupBy::Week), max_entries: 7 }
        );
        assert_eq!(read_args(args(json!({"concept_name": "a"})).as_ref()).unwrap().options, Options::default());
        // a date is a whole number, which the tool does no range check on; a fraction is no date
        assert!(read_args(args(json!({"concept_name": "a", "end_date": 2})).as_ref()).is_ok());
        let error = read_args(args(json!({"concept_name": "a", "end_date": 2.5})).as_ref()).unwrap_err();
        assert_eq!(error.to_string(), "Invalid parameter 'end_date': 2.5\n\nExpected: an integer, not a fraction\nExample: end_date: 20251120");
        let error = read_args(args(json!({"concept_name": "a", "group_by": "year", "max_entries": -1})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'group_by': \"year\""), "{error}");
        let error = read_args(args(json!({"concept_name": "a", "max_entries": -1})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'max_entries': -1"), "{error}");
        let error = read_args(args(json!({})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'concept_name': missing"), "{error}");
    }

    fn mention(id: i64, day: Option<i64>) -> Value {
        match day {
            Some(day) => json!({"id": id, "uuid": format!("u{id}"), "page": {"id": 100 + id, "journalDay": day}}),
            None => json!({"id": id, "uuid": format!("u{id}"), "page": {"id": 100 + id}}),
        }
    }

    fn evolution() -> ConceptEvolution {
        ConceptEvolution {
            concept: "atlas".into(),
            resolved_from: Some(json!({"name": "atlas", "matchedBy": "alias", "resolvedTo": "Project Atlas"})),
            resolved_aliases: Some(vec!["Atlas".into(), "Project Atlas".into()]),
            warnings: vec![ResultWarning { code: "entries_truncated".into(), message: "m".into(), how_to_fetch_all: None }],
            total_mentions_before_cut: Some(9),
            timeline: vec![(Some(20250101), vec![mention(1, Some(20250101))]), (None, vec![mention(2, None)])],
            grouped_timeline: Some(vec![("20250101".into(), vec![mention(1, Some(20250101))])]),
            summary: Summary { total_mentions: 9, earliest: Some(20250101), latest: Some(20250101), journal_mentions: 1, non_journal_mentions: 8 },
        }
    }

    #[test]
    fn a_result_says_what_it_answered_what_may_be_missing_and_the_summary_before_the_timeline() {
        let text = js::json_stringify(&evolution().to_value());
        assert_eq!(
            text,
            concat!(
                r#"{"concept":"atlas","resolvedFrom":{"name":"atlas","matchedBy":"alias","resolvedTo":"Project Atlas"},"#,
                r#""resolvedAliases":["Atlas","Project Atlas"],"#,
                r#""hasMore":false,"warnings":[{"code":"entries_truncated","message":"m"}],"totals":{"mentions":9},"#,
                r#""summary":{"totalMentions":9,"dateRange":{"earliest":20250101,"latest":20250101},"journalMentions":1,"nonJournalMentions":8},"#,
                r#""timeline":[{"date":20250101,"blocks":[{"id":1,"uuid":"u1","page":{"id":101,"journalDay":20250101}}]},"#,
                r#"{"date":null,"blocks":[{"id":2,"uuid":"u2","page":{"id":102}}]}],"#,
                r#""groupedTimeline":{"20250101":[{"id":1,"uuid":"u1","page":{"id":101,"journalDay":20250101}}]}}"#
            )
        );
    }

    #[test]
    fn an_unavailable_lookup_says_which_data_is_missing_and_offers_nothing_to_fetch() {
        let warnings = vec![page_blocks_unavailable(), page_unavailable_warning(), mentions_unavailable_warning()];
        assert_eq!(warnings.iter().map(|w| w.code.as_str()).collect::<Vec<_>>(), ["page_blocks_unavailable", "page_unavailable", "mentions_unavailable"]);
        for warning in &warnings {
            assert!(warning.message.starts_with("LogSeq returned no answer when looking up"), "{}", warning.message);
            assert!(warning.message.ends_with(RETRY_ADVICE), "{}", warning.message);
            assert!(warning.how_to_fetch_all.is_none());
        }
        assert!(warnings[1].message.contains("listed as undated mentions"));
        // the completeness block is there for them alone, with no `totals` and `hasMore` false
        let only = ConceptEvolution { warnings, total_mentions_before_cut: None, ..evolution() };
        let value = only.to_value();
        assert_eq!(value["hasMore"], false);
        assert!(value.get("totals").is_none());
    }

    #[test]
    fn the_order_of_a_result_does_not_depend_on_which_optional_keys_are_there() {
        let all = ["concept", "resolvedFrom", "resolvedAliases", "hasMore", "warnings", "totals", "summary", "timeline", "groupedTimeline"];
        assert_eq!(keys(&evolution().to_value()), all);
        // a warning with no cut count has no `totals`; no warning has none of the three
        let no_totals = ConceptEvolution { total_mentions_before_cut: None, ..evolution() };
        assert_eq!(keys(&no_totals.to_value()), ["concept", "resolvedFrom", "resolvedAliases", "hasMore", "warnings", "summary", "timeline", "groupedTimeline"]);
        let quiet = ConceptEvolution { warnings: vec![], total_mentions_before_cut: None, resolved_from: None, resolved_aliases: None, grouped_timeline: None, ..evolution() };
        assert_eq!(keys(&quiet.to_value()), ["concept", "summary", "timeline"]);
        let value = evolution().to_value();
        assert_eq!(keys(&value["summary"]), ["totalMentions", "dateRange", "journalMentions", "nonJournalMentions"]);
        assert_eq!(keys(&value["timeline"][0]), ["date", "blocks"]);
    }

    #[test]
    fn with_no_warning_there_is_no_meta_and_with_no_grouping_no_grouped_timeline() {
        let plain = ConceptEvolution {
            warnings: vec![],
            total_mentions_before_cut: None,
            resolved_from: None,
            resolved_aliases: None,
            grouped_timeline: None,
            timeline: vec![],
            summary: Summary { total_mentions: 0, earliest: None, latest: None, journal_mentions: 0, non_journal_mentions: 0 },
            ..evolution()
        };
        assert_eq!(
            js::json_stringify(&plain.to_value()),
            r#"{"concept":"atlas","summary":{"totalMentions":0,"dateRange":{"earliest":null,"latest":null},"journalMentions":0,"nonJournalMentions":0},"timeline":[]}"#
        );
        // an alias group's warning alone adds the meta, with no totals
        let aliased = ConceptEvolution { total_mentions_before_cut: None, ..evolution() };
        assert!(!js::json_stringify(&aliased.to_value()).contains("totals"));
        // grouping asked for and nothing to group is an empty object, not an absent key
        let empty = ConceptEvolution { grouped_timeline: Some(vec![]), ..plain };
        assert!(js::json_stringify(&empty.to_value()).contains(r#""groupedTimeline":{}"#));
    }

    #[test]
    fn grouped_keys_that_are_whole_numbers_come_first_as_javascript_writes_an_object() {
        let grouped = ConceptEvolution {
            grouped_timeline: Some(vec![("2025-W02".into(), vec![]), ("20250301".into(), vec![]), ("20250201".into(), vec![])]),
            ..evolution()
        };
        assert!(js::json_stringify(&grouped.to_value()).contains(r#""groupedTimeline":{"20250201":[],"20250301":[],"2025-W02":[]}"#));
    }
}
