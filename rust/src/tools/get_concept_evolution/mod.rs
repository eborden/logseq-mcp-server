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
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::args::Arguments;
use crate::client::LogseqClient;
use crate::edn::{PageId, PageName};
use crate::errors::ToolError;
use crate::js;
use crate::meta::{ResultMeta, ResultWarning};
use crate::params::{ParamAliases, resolve_param_aliases};
use crate::resolve::alias::{alias_set_warnings, resolve_alias_set};
use crate::resolve::require_page;
use crate::tool::{input_schema, read_only_annotations, success_result};
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
    let start_date = read.optional_whole("start_date")?;
    let end_date = read.optional_whole("end_date")?;
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
    /// An alias group cut at its maximum, or mentions cut at `max_entries`; empty otherwise
    pub warnings: Vec<ResultWarning>,
    /// How many mentions there were, when the timeline cut some
    pub total_mentions_before_cut: Option<usize>,
    /// `{ date, blocks }` per day, oldest first, the undated last
    pub timeline: Vec<(Option<i64>, Vec<Value>)>,
    /// Period key to blocks, in the order the periods were first met; present when `group_by` was given
    pub grouped_timeline: Option<Vec<(String, Vec<Value>)>>,
    pub summary: Summary,
}

impl ConceptEvolution {
    /// The result as the TypeScript object is written: `concept`, `resolvedFrom`, `resolvedAliases`,
    /// the meta (`hasMore`, `warnings` and `totals`, only when a warning applies), `timeline`,
    /// `groupedTimeline`, `summary`.
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("concept".into(), json!(self.concept));
        if let Some(from) = &self.resolved_from {
            out.insert("resolvedFrom".into(), from.clone());
        }
        if let Some(names) = &self.resolved_aliases {
            out.insert("resolvedAliases".into(), json!(names));
        }
        if !self.warnings.is_empty() {
            let totals: Vec<(&str, usize)> = self.total_mentions_before_cut.map(|total| ("mentions", total)).into_iter().collect();
            let meta = serde_json::to_value(ResultMeta::new(self.warnings.clone(), &totals)).expect("a result meta serializes");
            let Value::Object(meta) = meta else { unreachable!("a result meta is an object") };
            for (key, value) in meta {
                // `totals` is there only with a cut
                if key == "totals" && self.total_mentions_before_cut.is_none() {
                    continue;
                }
                out.insert(key, value);
            }
        }
        out.insert(
            "timeline".into(),
            Value::Array(
                self.timeline
                    .iter()
                    .map(|(date, blocks)| json!({"date": date.map_or(Value::Null, Value::from), "blocks": blocks}))
                    .collect(),
            ),
        );
        if let Some(grouped) = &self.grouped_timeline {
            let mut object = Map::new();
            for (key, blocks) in grouped {
                object.insert(key.clone(), Value::Array(blocks.clone()));
            }
            out.insert("groupedTimeline".into(), Value::Object(object));
        }
        let mut summary = Map::new();
        summary.insert("totalMentions".into(), json!(self.summary.total_mentions));
        summary.insert(
            "dateRange".into(),
            json!({"earliest": self.summary.earliest.map_or(Value::Null, Value::from), "latest": self.summary.latest.map_or(Value::Null, Value::from)}),
        );
        summary.insert("journalMentions".into(), json!(self.summary.journal_mentions));
        summary.insert("nonJournalMentions".into(), json!(self.summary.non_journal_mentions));
        out.insert("summary".into(), Value::Object(summary));
        Value::Object(out)
    }
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
    // PARITY(#299): a `null` page leaves the tree's blocks with their bare `{ id }` page, so they lose their day and
    // become undated mentions with no warning (suspected TS bug, BR-0011) — fix per #345, in both servers.
    if let (Some(blocks), Some(page)) = (tree.as_mut(), concept_page.as_ref()) {
        for block in blocks {
            if let Value::Object(map) = block {
                map.insert("page".to_owned(), page.clone());
            }
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
    // PARITY(#299): a `null` answer is read as "no mentions", so the concept looks unmentioned when LogSeq didn't
    // answer (suspected TS bug, BR-0011) — fix per #345, in both servers.
    let mentions = block_rows(&answer)?.unwrap_or_default();

    // Combine and deduplicate
    // PARITY(#299): a `null` block tree is read as "no blocks on the page", as a missing mention list is
    // (suspected TS bug, BR-0011) — fix per #345, in both servers.
    let all_blocks: Vec<Value> = tree.unwrap_or_default().into_iter().chain(mentions).collect();
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
            // `if (!date) continue`
            let Some(date) = day_of(block) else { continue };
            let key = period_key(period, date);
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
    use crate::tool::testing::{meaning, schema_of};

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
        assert_eq!(error.to_string(), "Invalid parameter 'end_date': 2.5\n\nExpected: an integer, not a fraction\nExample: end_date: 5");
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
    fn a_result_is_written_in_the_order_of_the_typescript_object() {
        let text = js::json_stringify(&evolution().to_value());
        assert_eq!(
            text,
            concat!(
                r#"{"concept":"atlas","resolvedFrom":{"name":"atlas","matchedBy":"alias","resolvedTo":"Project Atlas"},"#,
                r#""resolvedAliases":["Atlas","Project Atlas"],"#,
                r#""hasMore":false,"warnings":[{"code":"entries_truncated","message":"m"}],"totals":{"mentions":9},"#,
                r#""timeline":[{"date":20250101,"blocks":[{"id":1,"uuid":"u1","page":{"id":101,"journalDay":20250101}}]},"#,
                r#"{"date":null,"blocks":[{"id":2,"uuid":"u2","page":{"id":102}}]}],"#,
                r#""groupedTimeline":{"20250101":[{"id":1,"uuid":"u1","page":{"id":101,"journalDay":20250101}}]},"#,
                r#""summary":{"totalMentions":9,"dateRange":{"earliest":20250101,"latest":20250101},"journalMentions":1,"nonJournalMentions":8}}"#
            )
        );
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
            r#"{"concept":"atlas","timeline":[],"summary":{"totalMentions":0,"dateRange":{"earliest":null,"latest":null},"journalMentions":0,"nonJournalMentions":0}}"#
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
