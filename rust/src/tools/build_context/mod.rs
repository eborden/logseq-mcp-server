//! `logseq_build_context` (the Rust side of `src/tools/build-context.ts`): everything on one topic
//! in a call. The page's blocks, the pages that link to it and the blocks that do, capped by
//! `max_blocks`, `max_related_pages` and `max_references`. `get_context_for_query` builds one of
//! these for each topic of its query.
//!
//! Calls (the two-query pattern, ADR-0007): the page resolver (1 query for an exact name, an alias
//! or an ISO date; a namespace-leaf name adds the leaf query, and a missing page adds the
//! suggestion lookup before it fails), the alias lookup (1 query, only when the page has alias
//! links), the page's blocks (1 query: over the whole alias group for a page with aliases), then
//! the linked references (`logseq.Editor.getPageLinkedReferences` for a page with no aliases, or
//! one Datalog query over the group). The caps are applied after the fetch, so they cost no call.
//! With `resolve_refs`, up to 2 more Datalog queries, none when no returned block holds a ref.
//!
//! `format: "markdown"` renders the same context through [`crate::markdown_context`], its warnings
//! and `hasMore` in a footer. `compact` replaces each block with its snippet and uuid
//! ([`crate::compact`]) and skips `resolve_refs`, with a warning.
//!
//! This directory holds what only this tool uses: its queries (`queries.rs`). The linked references
//! are `get_backlinks`'s, and the alias groups and the resolver are shared (`resolve`).

mod queries;

use std::collections::HashSet;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::args::Arguments;
use crate::client::LogseqClient;
use crate::compact::compact_topic_context;
use crate::edn::PageName;
use crate::entity::{id_of, journal_day_of, journal_flag};
use crate::errors::{MatchedBy, ToolError};
use crate::js;
use crate::markdown::{FooterMeta, with_footer};
use crate::markdown_context::{ContextRenderOptions, render_topic_context};
use crate::meta::ResultWarning;
use crate::output_format::OutputFormat;
use crate::params::{ParamAliases, resolve_param_aliases};
use crate::resolve::alias::{AliasSet, alias_set_warnings, resolve_alias_set};
use crate::resolve::{ResolvedPage, require_page};
use crate::resolve_refs::resolve_block_refs;
use crate::tool::{input_schema, read_only_annotations, result_value, success_result};
use crate::tools::get_backlinks::{block_rows, fetch_backlinks};
use crate::truncation::{INLINE_BLOCKS, INLINE_REFERENCES, INLINE_RELATED_PAGES, truncation_warning};

use self::queries::{get_blocks_on_pages, get_page_blocks};

pub const NAME: &str = "logseq_build_context";

/// The description the TypeScript server gives the tool (`src/tool-descriptions.ts`).
const DESCRIPTION: &str = "Everything on one topic in a call: the page's blocks, related pages, and linked references.\n\n\
**Use when:** researching or explaining a topic that has a page.\n\
**Can't find:** topics with no page (use logseq_search_blocks), or anything past the caps (see hasMore and warnings).\n\
**Alternatives:** logseq_get_page (content only), logseq_get_concept_network (structure only).";

/// Parameter aliases (BR-0008): not in the schema, so they cost nothing in `tools/list`.
const ALIASES: ParamAliases = &[("topic_name", &["name", "page", "page_name"])];

/// Blocks kept when `max_blocks` is absent (`DEFAULT_MAX_BLOCKS`).
pub const DEFAULT_MAX_BLOCKS: u64 = 50;
/// Related pages kept when `max_related_pages` is absent.
pub const DEFAULT_MAX_RELATED_PAGES: u64 = 10;
/// Reference blocks kept when `max_references` is absent.
pub const DEFAULT_MAX_REFERENCES: u64 = 20;
/// Whether `temporalContext` is added when `include_temporal_context` is absent.
pub const DEFAULT_INCLUDE_TEMPORAL_CONTEXT: bool = true;

fn default_max_blocks() -> u32 {
    DEFAULT_MAX_BLOCKS as u32
}

fn default_max_related_pages() -> u32 {
    DEFAULT_MAX_RELATED_PAGES as u32
}

fn default_max_references() -> u32 {
    DEFAULT_MAX_REFERENCES as u32
}

fn default_include_temporal_context() -> bool {
    DEFAULT_INCLUDE_TEMPORAL_CONTEXT
}

/// The tool's arguments, as `tools/list` shows them. The schema is generated from this type
/// (ADR-0019); a call reads its arguments through [`Arguments`], which words a bad one as the
/// TypeScript server does. Unknown fields are ignored, as every TypeScript tool ignores them.
#[derive(Debug, Deserialize, JsonSchema)]
#[allow(dead_code)]
pub struct Args {
    /// Topic to build context for (page name, alias or ISO date)
    pub topic_name: String,
    /// Maximum number of blocks to include (default: 50)
    #[serde(default = "default_max_blocks")]
    pub max_blocks: u32,
    /// Maximum number of related pages to include (default: 10)
    #[serde(default = "default_max_related_pages")]
    pub max_related_pages: u32,
    /// Maximum number of reference blocks to include (default: 20)
    #[serde(default = "default_max_references")]
    pub max_references: u32,
    /// Include temporal context for journal pages (default: true)
    #[serde(default = "default_include_temporal_context")]
    pub include_temporal_context: bool,
    /// Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2)
    #[serde(default)]
    pub resolve_refs: bool,
    /// json (default), or markdown text. Markdown has block uuids only on search hits and with compact
    pub format: Option<OutputFormat>,
    /// Block snippets and uuids, no bodies. Read one with logseq_get_block
    #[serde(default)]
    pub compact: bool,
}

/// What a call asked for, read from the arguments in the order the schema lists them, so the first
/// one that is wrong is the one reported, as `parseArgs` does.
#[derive(Debug, PartialEq)]
struct Request {
    topic_name: String,
    caps: Caps,
    format: Option<OutputFormat>,
    compact: bool,
    resolve_refs: bool,
}

fn read_args(arguments: Option<&JsonObject>) -> Result<Request, ToolError> {
    let read = Arguments::new(arguments);
    let topic_name = read.required_string("topic_name")?;
    let max_blocks = read.count_or("max_blocks", 0, DEFAULT_MAX_BLOCKS)?;
    let max_related_pages = read.count_or("max_related_pages", 0, DEFAULT_MAX_RELATED_PAGES)?;
    let max_references = read.count_or("max_references", 0, DEFAULT_MAX_REFERENCES)?;
    let include_temporal_context = read.boolean("include_temporal_context", DEFAULT_INCLUDE_TEMPORAL_CONTEXT)?;
    let resolve_refs = read.boolean("resolve_refs", false)?;
    let format = OutputFormat::read(&read)?;
    let compact = read.boolean("compact", false)?;
    // Compact output drops the bodies, so there is nothing to resolve refs in
    let caps = Caps { max_blocks, max_related_pages, max_references, include_temporal_context, resolve_refs: resolve_refs && !compact };
    Ok(Request { topic_name, caps, format, compact, resolve_refs })
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Build Context")
        .with_annotations(read_only_annotations("Build Context"))
}

/// A call: aliases folded, arguments read, the context, then JSON, compact JSON or Markdown. This
/// tool makes no tips.
pub async fn call(client: &LogseqClient, _tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let arguments = resolve_param_aliases(ALIASES, arguments)?;
    let request = read_args(arguments.as_ref())?;
    let mut context = build_context_for_topic(client, &request.topic_name, request.caps).await?;
    // Compact output has no block bodies to resolve refs in. Say so rather than drop the request silently.
    if request.compact && request.resolve_refs {
        context.warnings.push(ResultWarning::new(
            "resolve_refs_ignored_in_compact",
            "compact output has no block bodies, so resolve_refs was skipped. Set compact to false for resolved text, or read a block with logseq_get_block and resolve_refs."
                .to_owned(),
        ));
    }
    let result = context.to_value(true);
    if request.format == Some(OutputFormat::Markdown) {
        let body = render_topic_context(&result, ContextRenderOptions { compact: request.compact, ..Default::default() });
        return Ok(success_result(vec![ContentBlock::text(with_footer(body, &FooterMeta::of_result(&result, &[])))]));
    }
    let shown = if request.compact { compact_topic_context(&result) } else { result };
    Ok(success_result(vec![ContentBlock::text(js::json_stringify(&shown))]))
}

/// What `buildContextForTopic` takes beyond the topic (`ContextOptions`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    pub max_blocks: u64,
    pub max_related_pages: u64,
    pub max_references: u64,
    pub include_temporal_context: bool,
    /// Resolve `((uuid))` refs and `{{embed}}`s in the blocks and the reference blocks returned
    pub resolve_refs: bool,
}

impl Default for Caps {
    fn default() -> Self {
        Caps {
            max_blocks: DEFAULT_MAX_BLOCKS,
            max_related_pages: DEFAULT_MAX_RELATED_PAGES,
            max_references: DEFAULT_MAX_REFERENCES,
            include_temporal_context: DEFAULT_INCLUDE_TEMPORAL_CONTEXT,
            resolve_refs: false,
        }
    }
}

/// A block that links the topic, and the page it sits on.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Reference {
    pub block: Value,
    #[serde(rename = "sourcePage")]
    pub source_page: Value,
}

/// Real counts before the caps were applied (`totals`; the `summary` counts what is returned).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Totals {
    pub blocks: usize,
    #[serde(rename = "relatedPages")]
    pub related_pages: usize,
    pub references: usize,
}

/// `temporalContext`: whether the page is a journal, and its day.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TemporalContext {
    #[serde(rename = "isJournal")]
    pub is_journal: bool,
    /// The journal's day as `YYYYMMDD`; absent for a page that is not a journal or has no day
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<i64>,
}

/// A topic's context (`TopicContext`). The page, the blocks and the pages are the entities LogSeq
/// sent, whole (BR-0004).
#[derive(Debug, Clone, PartialEq)]
pub struct TopicContext {
    pub topic: String,
    pub resolved_from: Option<Value>,
    pub resolved_aliases: Option<Vec<String>>,
    /// The page as the resolver pulled it
    pub main_page: Value,
    pub direct_blocks: Vec<Value>,
    /// The pages that link the topic, each shown as `{ page, relationshipType: "inbound" }`
    pub related_pages: Vec<Value>,
    pub references: Vec<Reference>,
    pub temporal_context: Option<TemporalContext>,
    pub warnings: Vec<ResultWarning>,
    pub totals: Totals,
}

/// One related page as the result shows it.
#[derive(Serialize)]
struct RelatedPage<'a> {
    page: &'a Value,
    #[serde(rename = "relationshipType")]
    relationship_type: &'static str,
}

/// What the result holds, counted over what it returns (`summary`; `totals` counts before the caps).
#[derive(Serialize)]
struct ContextSummary {
    #[serde(rename = "totalBlocks")]
    total_blocks: usize,
    #[serde(rename = "totalRelatedPages")]
    total_related_pages: usize,
    #[serde(rename = "totalReferences")]
    total_references: usize,
    #[serde(rename = "pageProperties")]
    page_properties: Value,
}

/// The completeness keys of a context.
#[derive(Serialize)]
struct Completeness<'a> {
    #[serde(rename = "hasMore")]
    has_more: bool,
    warnings: &'a [ResultWarning],
    totals: Totals,
}

/// A context as written, in BR-0013's order: what was answered (`topic`, `resolvedFrom`,
/// `resolvedAliases`), what must not be missed (`hasMore`, `warnings`, `totals`, then `summary`), then
/// the data (`mainPage`, `directBlocks`, `relatedPages`, `references`, `temporalContext`).
/// `get_context_for_query` keeps each topic's context without the completeness keys
/// (`TopicQueryContext`), since it rolls the warnings up into its own.
#[derive(Serialize)]
pub(crate) struct TopicContextOutput<'a> {
    topic: &'a str,
    #[serde(rename = "resolvedFrom", skip_serializing_if = "Option::is_none")]
    resolved_from: Option<&'a Value>,
    #[serde(rename = "resolvedAliases", skip_serializing_if = "Option::is_none")]
    resolved_aliases: Option<&'a [String]>,
    #[serde(flatten)]
    completeness: Option<Completeness<'a>>,
    summary: ContextSummary,
    #[serde(rename = "mainPage")]
    main_page: &'a Value,
    #[serde(rename = "directBlocks")]
    direct_blocks: &'a [Value],
    #[serde(rename = "relatedPages")]
    related_pages: Vec<RelatedPage<'a>>,
    references: &'a [Reference],
    #[serde(rename = "temporalContext", skip_serializing_if = "Option::is_none")]
    temporal_context: Option<TemporalContext>,
}

impl TopicContext {
    /// `hasMore`: some warning says how to fetch what it cut.
    pub fn has_more(&self) -> bool {
        self.warnings.iter().any(|warning| warning.how_to_fetch_all.is_some())
    }

    /// The context in BR-0013's key order, with `hasMore`, `warnings` and `totals` when `with_meta`.
    pub fn to_value(&self, with_meta: bool) -> Value {
        result_value(&self.output(with_meta))
    }

    /// What [`to_value`](Self::to_value) writes, for a result that holds contexts of its own.
    pub(crate) fn output(&self, with_meta: bool) -> TopicContextOutput<'_> {
        TopicContextOutput {
            topic: &self.topic,
            resolved_from: self.resolved_from.as_ref(),
            resolved_aliases: self.resolved_aliases.as_deref(),
            completeness: with_meta.then(|| Completeness { has_more: self.has_more(), warnings: &self.warnings, totals: self.totals }),
            summary: ContextSummary {
                total_blocks: self.direct_blocks.len(),
                total_related_pages: self.related_pages.len(),
                total_references: self.references.len(),
                page_properties: page_properties(&self.main_page),
            },
            main_page: &self.main_page,
            direct_blocks: &self.direct_blocks,
            related_pages: self.related_pages.iter().map(|page| RelatedPage { page, relationship_type: "inbound" }).collect(),
            references: &self.references,
            temporal_context: self.temporal_context,
        }
    }
}

/// `mainPage.properties || {}`: the page's properties, or an empty object when it has none.
fn page_properties(page: &Value) -> Value {
    match page.get("properties") {
        Some(properties) if !matches!(properties, Value::Null | Value::Bool(false)) => properties.clone(),
        _ => json!({}),
    }
}

/// `resolvedFromInfo`: says the page isn't the exact name the caller gave. Absent for an exact match.
pub fn resolved_from(input: &str, resolved: &ResolvedPage) -> Option<Value> {
    (resolved.matched_by != MatchedBy::Name)
        .then(|| json!({"name": input, "matchedBy": resolved.matched_by.as_str(), "resolvedTo": resolved.original_name}))
}

/// The blocks of the page, or of every page of its alias group. For a group the page asked about
/// comes first, so a cap keeps its own blocks before the aliases' (the order inside each part is the
/// query's).
fn blocks_of(fetched: Vec<Value>, aliased: bool, main_page_id: Option<i64>) -> Vec<Value> {
    if !aliased {
        return fetched;
    }
    let (own, others): (Vec<Value>, Vec<Value>) = fetched.into_iter().partition(|block| id_of(block.get("page")) == main_page_id);
    own.into_iter().chain(others).collect()
}

/// The inbound pages and the reference blocks of a topic's linked references: each block with the
/// page it sits on (the tuple's page, else the block's own), and each page once, first seen first.
fn references_of(backlinks: Vec<crate::tools::get_backlinks::Backlink>) -> (Vec<Value>, Vec<Reference>) {
    let mut related_pages = Vec::new();
    let mut references = Vec::new();
    let mut seen = HashSet::new();
    for backlink in backlinks {
        for block in backlink.blocks {
            // The source page is the tuple's first element, or `block.page` for a tuple with none
            let source = match (&backlink.page, block.get("page")) {
                (page, _) if !page.is_null() => page.clone(),
                (_, Some(page)) if !page.is_null() => page.clone(),
                _ => continue,
            };
            // Add the source page to the related pages (an inbound connection), once
            if let Some(id) = id_of(Some(&source)) {
                if seen.insert(id) {
                    related_pages.push(source.clone());
                }
            }
            references.push(Reference { block, source_page: source });
        }
    }
    (related_pages, references)
}

/// The `temporalContext` of a page: whether it is a journal, and its day.
fn temporal_context(page: &Value) -> TemporalContext {
    if journal_flag(Some(page)) == Some(true) {
        TemporalContext { is_journal: true, date: journal_day_of(Some(page)) }
    } else {
        TemporalContext { is_journal: false, date: None }
    }
}

/// `buildContextForTopic`: build the context of a topic.
///
/// `topic_name` is a page name, an alias or an ISO date (`2025-01-01`) of a journal. The page is
/// resolved first (BR-0010); with aliases, its blocks and references cover every name of the group
/// (#69).
///
/// Fails with [`ToolError::PageNotFound`] (guidance with the closest names) if no page matches, and
/// [`ToolError::AmbiguousPage`] (with the candidates) if several do.
pub async fn build_context_for_topic(client: &LogseqClient, topic_name: &str, caps: Caps) -> Result<TopicContext, ToolError> {
    // Query 1: resolve the main page (exact name, alias or ISO date, in one query)
    let resolved = require_page(client, topic_name).await?;
    let main_page = resolved.page.raw.clone();

    // The names this page goes by (#69): a page with no `alias::` costs no call here
    let alias_set: AliasSet = resolve_alias_set(client, &resolved.page).await?;
    let aliased = alias_set.has_aliases();

    // Query 2: the blocks of the page, or of every page of its alias group (may be empty)
    let blocks_query = if aliased { get_blocks_on_pages(&alias_set.ids()?) } else { get_page_blocks(&PageName::new(&resolved.lookup_name)) };
    let answer = client.execute_datalog_query(&blocks_query.text, &blocks_query.inputs).await?;
    // PARITY(#299): a `null` answer is read as "no blocks", so the page looks empty when LogSeq didn't answer
    // (suspected TS bug, BR-0011) — fix per #338, in both servers.
    let rows = block_rows(answer)?.unwrap_or_default();
    let fetched: Vec<Value> = rows.into_iter().flatten().map(Value::Object).collect();
    let all_blocks = blocks_of(fetched, aliased, id_of(Some(&main_page)));
    let mut direct_blocks: Vec<Value> = all_blocks.iter().take(caps.max_blocks as usize).cloned().collect();

    // Query 3: the reference blocks, and the related pages derived from them. `null` and `[]` both
    // mean the page has no backlinks; an error (connection, timeout, auth, unexpected) propagates.
    // PARITY(#299): a `null` answer is read as "no backlinks" (suspected TS bug, BR-0011) — fix per #338, in both servers.
    let backlinks = fetch_backlinks(client, &resolved.lookup_name, &alias_set).await?.unwrap_or_default();
    let (all_related_pages, all_references) = references_of(backlinks);

    // Everything is already in memory, so the totals cost no extra API call.
    let mut references: Vec<Reference> = all_references.iter().take(caps.max_references as usize).cloned().collect();
    let related_pages: Vec<Value> = all_related_pages.iter().take(caps.max_related_pages as usize).cloned().collect();
    let totals = Totals { blocks: all_blocks.len(), related_pages: all_related_pages.len(), references: all_references.len() };

    let mut warnings = alias_set_warnings(&[&alias_set]);
    if totals.blocks > direct_blocks.len() {
        warnings.push(truncation_warning("blocks", direct_blocks.len(), totals.blocks, "max_blocks", "blocks_truncated", Some(INLINE_BLOCKS)));
    }
    if totals.references > references.len() {
        warnings.push(truncation_warning("references", references.len(), totals.references, "max_references", "references_truncated", Some(INLINE_REFERENCES)));
    }
    if totals.related_pages > related_pages.len() {
        warnings.push(truncation_warning(
            "related pages",
            related_pages.len(),
            totals.related_pages,
            "max_related_pages",
            "related_pages_truncated",
            Some(INLINE_RELATED_PAGES),
        ));
    }

    // Opt-in (#18): one resolver pass over the blocks that are actually returned
    if caps.resolve_refs {
        let roots: Vec<Value> = direct_blocks.iter().cloned().chain(references.iter().map(|reference| reference.block.clone())).collect();
        let resolved_refs = resolve_block_refs(client, &roots).await?;
        let (direct, referenced) = resolved_refs.blocks.split_at(direct_blocks.len());
        direct_blocks = direct.to_vec();
        for (reference, block) in references.iter_mut().zip(referenced) {
            reference.block = block.clone();
        }
        warnings.extend(resolved_refs.warnings);
    }

    // The page is a Datalog pull (`journal?`, `journal-day`), and the readers accept the Editor API's spelling too (#152)
    let temporal_context = caps.include_temporal_context.then(|| temporal_context(&main_page));

    Ok(TopicContext {
        topic: topic_name.to_owned(),
        resolved_from: resolved_from(topic_name, &resolved),
        resolved_aliases: alias_set.resolved_aliases(),
        main_page,
        direct_blocks,
        related_pages,
        references,
        temporal_context,
        warnings,
        totals,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::testing::{meaning, schema_of};
    use crate::tools::get_backlinks::Backlink;

    fn args(value: Value) -> Option<JsonObject> {
        value.as_object().cloned()
    }

    #[test]
    fn the_build_context_schema_means_what_the_typescript_one_means() {
        // `inputSchema` of logseq_build_context in the ADR-0016 snapshot
        let typescript = json!({
            "type": "object",
            "properties": {
                "topic_name": {"type": "string", "description": "Topic to build context for (page name, alias or ISO date)"},
                "max_blocks": {"type": "integer", "minimum": 0, "default": 50, "description": "Maximum number of blocks to include (default: 50)"},
                "max_related_pages": {"type": "integer", "minimum": 0, "default": 10, "description": "Maximum number of related pages to include (default: 10)"},
                "max_references": {"type": "integer", "minimum": 0, "default": 20, "description": "Maximum number of reference blocks to include (default: 20)"},
                "include_temporal_context": {"type": "boolean", "default": true, "description": "Include temporal context for journal pages (default: true)"},
                "resolve_refs": {"type": "boolean", "default": false, "description": "Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2)"},
                "format": {"type": "string", "enum": ["json", "markdown"], "description": "json (default), or markdown text. Markdown has block uuids only on search hits and with compact"},
                "compact": {"type": "boolean", "default": false, "description": "Block snippets and uuids, no bodies. Read one with logseq_get_block"},
            },
            "required": ["topic_name"],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&typescript));
    }

    #[test]
    fn the_tool_is_read_only_and_titled_as_in_typescript() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Build Context"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Build Context", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }

    #[test]
    fn the_arguments_are_read_in_schema_order_and_the_aliases_are_folded() {
        let folded = resolve_param_aliases(ALIASES, args(json!({"page_name": "Atlas", "max_blocks": 3}))).unwrap();
        let request = read_args(folded.as_ref()).unwrap();
        assert_eq!(request.topic_name, "Atlas");
        assert_eq!(request.caps, Caps { max_blocks: 3, ..Caps::default() });
        let error = read_args(args(json!({"topic_name": "a", "max_blocks": -1, "format": "xml"})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'max_blocks': -1"), "{error}");
        let error = read_args(args(json!({})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'topic_name': missing"), "{error}");
    }

    #[test]
    fn compact_skips_resolve_refs_but_the_request_remembers_it_was_asked() {
        let request = read_args(args(json!({"topic_name": "a", "resolve_refs": true, "compact": true})).as_ref()).unwrap();
        assert!(!request.caps.resolve_refs && request.resolve_refs && request.compact);
        let request = read_args(args(json!({"topic_name": "a", "resolve_refs": true})).as_ref()).unwrap();
        assert!(request.caps.resolve_refs);
    }

    fn block(id: i64, page: i64) -> Value {
        json!({"id": id, "uuid": format!("u{id}"), "page": {"id": page}})
    }

    #[test]
    fn an_alias_group_shows_the_page_asked_about_first() {
        let fetched = vec![block(1, 11), block(2, 10), block(3, 11), block(4, 10)];
        let ids = |blocks: Vec<Value>| blocks.iter().map(|b| b["id"].as_i64().unwrap()).collect::<Vec<_>>();
        assert_eq!(ids(blocks_of(fetched.clone(), true, Some(10))), [2, 4, 1, 3]);
        assert_eq!(ids(blocks_of(fetched, false, Some(10))), [1, 2, 3, 4]);
    }

    #[test]
    fn related_pages_are_the_source_pages_once_each_and_every_block_is_a_reference() {
        let backlinks = vec![
            Backlink { page: json!({"id": 20, "name": "bob"}), blocks: vec![block(201, 20), block(202, 20)] },
            // a tuple with no page: the block's own page names the source
            Backlink { page: Value::Null, blocks: vec![block(301, 30), json!({"id": 302, "uuid": "u302"})] },
            Backlink { page: json!({"id": 20, "name": "bob"}), blocks: vec![block(203, 20)] },
        ];
        let (pages, references) = references_of(backlinks);
        assert_eq!(pages, [json!({"id": 20, "name": "bob"}), json!({"id": 30})]);
        // the block with no page anywhere has no source and is skipped
        assert_eq!(references.iter().map(|r| r.block["id"].as_i64().unwrap()).collect::<Vec<_>>(), [201, 202, 301, 203]);
        assert_eq!(references[2].source_page, json!({"id": 30}));
    }


    #[test]
    fn the_properties_of_a_page_with_none_are_an_empty_object() {
        assert_eq!(page_properties(&json!({"properties": {"a": 1}})), json!({"a": 1}));
        assert_eq!(page_properties(&json!({"properties": {}})), json!({}));
        assert_eq!(page_properties(&json!({"properties": null})), json!({}));
        assert_eq!(page_properties(&json!({})), json!({}));
    }

    #[test]
    fn a_journal_says_so_with_its_day_and_any_other_page_says_it_is_not_one() {
        let written = |page: Value| js::json_stringify(&result_value(&temporal_context(&page)));
        assert_eq!(written(json!({"journal?": true, "journal-day": 20250101})), r#"{"isJournal":true,"date":20250101}"#);
        assert_eq!(written(json!({"journal?": true})), r#"{"isJournal":true}"#);
        assert_eq!(written(json!({"journal?": false, "journal-day": 20250101})), r#"{"isJournal":false}"#);
        assert_eq!(written(json!({})), r#"{"isJournal":false}"#);
    }

    fn context() -> TopicContext {
        TopicContext {
            topic: "atlas".into(),
            resolved_from: Some(json!({"name": "atlas", "matchedBy": "alias", "resolvedTo": "Project Atlas"})),
            resolved_aliases: Some(vec!["Atlas".into(), "Project Atlas".into()]),
            main_page: json!({"id": 1, "name": "project atlas", "properties": {"type": "project"}}),
            direct_blocks: vec![json!({"id": 5, "uuid": "u5"})],
            related_pages: vec![json!({"id": 2})],
            references: vec![Reference { block: json!({"id": 6}), source_page: json!({"id": 2}) }],
            temporal_context: Some(TemporalContext { is_journal: false, date: None }),
            warnings: vec![ResultWarning::new("w", "m".into())],
            totals: Totals { blocks: 9, related_pages: 1, references: 1 },
        }
    }

    #[test]
    fn a_context_writes_what_was_answered_then_what_must_not_be_missed_then_the_data() {
        assert_eq!(
            js::json_stringify(&context().to_value(true)),
            concat!(
                r#"{"topic":"atlas","resolvedFrom":{"name":"atlas","matchedBy":"alias","resolvedTo":"Project Atlas"},"#,
                r#""resolvedAliases":["Atlas","Project Atlas"],"#,
                r#""hasMore":false,"warnings":[{"code":"w","message":"m"}],"totals":{"blocks":9,"relatedPages":1,"references":1},"#,
                r#""summary":{"totalBlocks":1,"totalRelatedPages":1,"totalReferences":1,"pageProperties":{"type":"project"}},"#,
                r#""mainPage":{"id":1,"name":"project atlas","properties":{"type":"project"}},"#,
                r#""directBlocks":[{"id":5,"uuid":"u5"}],"relatedPages":[{"page":{"id":2},"relationshipType":"inbound"}],"#,
                r#""references":[{"block":{"id":6},"sourcePage":{"id":2}}],"temporalContext":{"isJournal":false}}"#
            )
        );
    }

    #[test]
    fn the_order_of_a_context_does_not_depend_on_which_optional_keys_are_there() {
        use crate::tool::testing::keys;
        let all = [
            "topic", "resolvedFrom", "resolvedAliases", "hasMore", "warnings", "totals", "summary", "mainPage", "directBlocks", "relatedPages",
            "references", "temporalContext",
        ];
        assert_eq!(keys(&context().to_value(true)), all);
        // `get_context_for_query` keeps a topic's context without the completeness keys
        let without_meta: Vec<&str> = all.iter().copied().filter(|key| !["hasMore", "warnings", "totals"].contains(key)).collect();
        assert_eq!(keys(&context().to_value(false)), without_meta);
        // no resolution, no temporal context: the others keep their places
        let bare = TopicContext { resolved_from: None, resolved_aliases: None, temporal_context: None, ..context() };
        assert_eq!(
            keys(&bare.to_value(true)),
            ["topic", "hasMore", "warnings", "totals", "summary", "mainPage", "directBlocks", "relatedPages", "references"]
        );
    }

}
