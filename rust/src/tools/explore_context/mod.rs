//! `logseq_explore_context`: everything on one page in a call. The page's blocks, the pages that link to it and
//! the blocks that do (its references), capped by `max_blocks`, `max_related_pages` and `max_references`, with the
//! references paged by `references_offset`.
//!
//! The references are the linked references of the page and of every alias, most-linking source pages first (ties by
//! page name, then id; [`references::rank_backlinks`]), so the blocks of one source page sit together. The related
//! pages are those source pages in the order LogSeq sent them, each once. `references_offset` skips that many
//! references from the top of the ranking, so a later page of references is the same ranking read further on.
//!
//! Calls (the two-query pattern, ADR-0007): the page resolver (1 query for an exact name, an alias
//! or an ISO date; a namespace-leaf name adds the leaf query, and a missing page adds the
//! suggestion lookup before it fails), the alias lookup (1 query, only when the page has alias
//! links), the page's blocks (1 query: over the whole alias group for a page with aliases), then
//! the linked references (`logseq.Editor.getPageLinkedReferences` for a page with no aliases, or
//! one Datalog query over the group). The ranking, the caps and the offset are applied after the fetch, so they
//! cost no call. With `resolve_refs`, up to 2 more Datalog queries, none when no returned block holds a ref.
//!
//! A `null` answer to the blocks or to the linked references is not "none" (BR-0011, #338): the context is built
//! without that part and carries a `page_blocks_unavailable` or `backlinks_unavailable` warning, with no
//! `howToFetchAll` (`hasMore` stays false).
//!
//! The result is cut to the character budget (#485) after the caps, blocks first, then references, then related
//! pages. A cut that drops some of the references and none of the blocks names the `references_offset` that reads on.
//!
//! `format: "markdown"` renders the same context through [`crate::markdown_context`], its warnings
//! and `hasMore` in a footer. `compact` replaces each block with its snippet and uuid
//! ([`crate::compact`]) and skips `resolve_refs`, with a warning.
//!
//! This directory holds what only this tool uses: its queries (`queries.rs`), where the linked references are read
//! and ranked (`references.rs`) and the answers it reads (`wire.rs`). The alias groups and the resolver are shared
//! (`resolve`).

mod queries;
mod references;
mod wire;

use std::collections::HashSet;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::args::parse_args;
use crate::budget::{Fit, fit, size};
use crate::client::LogseqClient;
use crate::compact::compact_topic_context;
use crate::edn::PageName;
use crate::entity::{id_of, journal_day_of, journal_flag};
use crate::errors::{MatchedBy, ToolError};
use crate::markdown::{FooterMeta, with_footer};
use crate::markdown_context::{ContextRenderOptions, render_topic_context};
use crate::meta::ResultWarning;
use crate::output_format::OutputFormat;
use crate::params::{ParamAliases, resolve_param_aliases};
use crate::resolve::alias::{AliasSet, alias_set_warnings, resolve_alias_set};
use crate::resolve::{RETRY_ADVICE, ResolvedPage, require_page};
use crate::resolve_refs::resolve_block_refs;
use crate::tool::{input_schema, read_only_annotations, result_value, success_result};
use crate::truncation::{
    CappedTruncation, INLINE_BLOCKS, INLINE_REFERENCES, INLINE_RELATED_PAGES, Paging, SizeCut, capped_truncation_warning, size_truncation_warning, truncation_warning,
};

use self::queries::{get_blocks_on_pages, get_page_blocks};
use self::references::{fetch_backlinks, rank_backlinks};
use self::wire::{Backlink, block_rows};

pub const NAME: &str = "logseq_explore_context";

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Explore one page: its blocks, related pages and references (blocks linking to it, most-linking pages first; page with references_offset).\n\n\
**Use when:** researching a topic with a page, or what links to it.\n\
**Can't find:** topics with no page (logseq_find_blocks), or anything past the caps (hasMore).\n\
**Alternatives:** logseq_get_page (content only), logseq_get_concept_network (structure only).";

/// Parameter aliases (BR-0008): not in the schema, so they cost nothing in `tools/list`.
const ALIASES: ParamAliases = &[("page", &["name", "page_name"])];

/// Blocks kept when `max_blocks` is absent (`DEFAULT_MAX_BLOCKS`).
pub const DEFAULT_MAX_BLOCKS: u64 = 50;
/// Related pages kept when `max_related_pages` is absent.
pub const DEFAULT_MAX_RELATED_PAGES: u64 = 10;
/// Reference blocks kept when `max_references` is absent.
pub const DEFAULT_MAX_REFERENCES: u64 = 20;
/// Whether `temporalContext` is added when `include_temporal_context` is absent.
pub const DEFAULT_INCLUDE_TEMPORAL_CONTEXT: bool = true;

fn default_max_blocks() -> u64 {
    DEFAULT_MAX_BLOCKS
}

fn default_max_related_pages() -> u64 {
    DEFAULT_MAX_RELATED_PAGES
}

fn default_max_references() -> u64 {
    DEFAULT_MAX_REFERENCES
}

fn default_include_temporal_context() -> bool {
    DEFAULT_INCLUDE_TEMPORAL_CONTEXT
}

/// The tool's arguments, as `tools/list` shows them. The schema is generated from this type, and a
/// call parses its arguments into it (ADR-0019). Unknown fields are ignored, as in every tool (see `input_schema`)
/// ignores them.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct Args {
    /// Page to explore (name, alias or ISO date)
    pub page: String,
    /// Maximum number of blocks to include (default: 50)
    #[serde(default = "default_max_blocks")]
    pub max_blocks: u64,
    /// Maximum number of related pages to include (default: 10)
    #[serde(default = "default_max_related_pages")]
    pub max_related_pages: u64,
    /// Maximum number of reference blocks to include (default: 20)
    #[serde(default = "default_max_references")]
    pub max_references: u64,
    /// Reference blocks to skip, most-linking pages first (default: 0)
    #[serde(default)]
    pub references_offset: u64,
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

/// What a call asked for, from the arguments parsed into [`Args`].
#[derive(Debug, PartialEq)]
struct Request {
    page: String,
    caps: Caps,
    format: Option<OutputFormat>,
    compact: bool,
    resolve_refs: bool,
}

impl From<Args> for Request {
    fn from(args: Args) -> Request {
        let Args { page, max_blocks, max_related_pages, max_references, references_offset, include_temporal_context, resolve_refs, format, compact } = args;
        // Compact output drops the bodies, so there is nothing to resolve refs in
        let caps = Caps { max_blocks, max_related_pages, max_references, references_offset, include_temporal_context, resolve_refs: resolve_refs && !compact };
        Request { page, caps, format, compact, resolve_refs }
    }
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Explore Context")
        .with_annotations(read_only_annotations("Explore Context"))
}

/// A call: aliases folded, arguments read, the context, then JSON, compact JSON or Markdown. This
/// tool makes no tips.
pub async fn call(client: &LogseqClient, _tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let arguments = resolve_param_aliases(ALIASES, arguments)?;
    let request = Request::from(parse_args::<Args>(arguments.as_ref())?);
    let mut context = explore_page_context(client, &request.page, request.caps).await?;
    // Compact output has no block bodies to resolve refs in. Say so rather than drop the request silently.
    if request.compact && request.resolve_refs {
        context.warnings.push(ResultWarning::new(
            "resolve_refs_ignored_in_compact",
            "compact output has no block bodies, so resolve_refs was skipped. Set compact to false for resolved text, or read a block with logseq_get_block and resolve_refs."
                .to_owned(),
        ));
    }
    // The text the call sends, which the character budget measures (#485)
    let render = |context: &TopicContext| -> String {
        let result = context.to_value();
        if request.format == Some(OutputFormat::Markdown) {
            let body = render_topic_context(&result, ContextRenderOptions { compact: request.compact, ..Default::default() });
            return with_footer(body, &FooterMeta::of_result(&result, &[]));
        }
        if request.compact { compact_topic_context(&result).to_string() } else { result.to_string() }
    };
    let context = context.fit_to_budget(&render, request.compact);
    Ok(success_result(vec![ContentBlock::text(render(&context))]))
}

/// What building a context takes beyond the topic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    pub max_blocks: u64,
    pub max_related_pages: u64,
    pub max_references: u64,
    /// References skipped from the top of the ranking before `max_references` are kept
    pub references_offset: u64,
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
            references_offset: 0,
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

/// Real counts before the caps and the offset were applied (`totals`; the `summary` counts what is returned).
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
    /// The references from `references_from` on, at most `max_references` of them, most-linking pages first
    pub references: Vec<Reference>,
    /// The references skipped before `references`: the offset asked for, or the number there are when it asked for more
    pub references_from: usize,
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
#[derive(Serialize)]
struct TopicContextOutput<'a> {
    topic: &'a str,
    #[serde(rename = "resolvedFrom", skip_serializing_if = "Option::is_none")]
    resolved_from: Option<&'a Value>,
    #[serde(rename = "resolvedAliases", skip_serializing_if = "Option::is_none")]
    resolved_aliases: Option<&'a [String]>,
    #[serde(flatten)]
    completeness: Completeness<'a>,
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

    /// The context in BR-0013's key order.
    pub fn to_value(&self) -> Value {
        result_value(&TopicContextOutput {
            topic: &self.topic,
            resolved_from: self.resolved_from.as_ref(),
            resolved_aliases: self.resolved_aliases.as_deref(),
            completeness: Completeness { has_more: self.has_more(), warnings: &self.warnings, totals: self.totals },
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
        })
    }
}

impl TopicContext {
    /// How many blocks, references and related pages the first `kept` entries are, in that order.
    fn share_of(&self, kept: usize) -> (usize, usize, usize) {
        let blocks = kept.min(self.direct_blocks.len());
        let references = (kept - blocks).min(self.references.len());
        let related = (kept - blocks - references).min(self.related_pages.len());
        (blocks, references, related)
    }
}

impl TopicContext {
    /// The blocks, then the references, then the related pages, cut to the first `kept` of them in that order
    /// (#485): the page's own blocks are the answer, the references come next, and the related pages, which are
    /// names the references mostly repeat, go first. `summary` counts what is returned and `totals` what there was
    /// before the caps; the warning says what is left.
    ///
    /// A count cap's warning (`blocks_truncated`, `references_truncated`, `related_pages_truncated`) is dropped when
    /// this cut goes further into the same list: its advice, to raise the cap or to read on from the end of the list it
    /// counted, would be about entries that are no longer there. The size cut says what is left instead, and when it
    /// has dropped references and no block, it names the `references_offset` that reads on from the last one kept.
    fn cut_to(&self, kept: usize, oversize: bool, compact: bool) -> TopicContext {
        let (blocks, references, related) = self.share_of(kept);
        let mut warnings: Vec<ResultWarning> = self
            .warnings
            .iter()
            .filter(|warning| match warning.code.as_str() {
                "blocks_truncated" => blocks == self.direct_blocks.len(),
                "references_truncated" => references == self.references.len(),
                "related_pages_truncated" => related == self.related_pages.len(),
                _ => true,
            })
            .cloned()
            .collect();
        let more = if compact { "Read a block in full with logseq_get_block." } else { "Set compact to true for short snippets, or read a block with logseq_get_block." };
        let (tail, how_to_fetch_all) = self.read_on(blocks, references);
        warnings.push(size_truncation_warning(SizeCut {
            what: "entries (blocks, then references, then related pages)",
            kept,
            total: self.direct_blocks.len() + self.references.len() + self.related_pages.len(),
            oversize,
            advice: &format!(
                "That is {blocks} of {} blocks, {references} of {} references and {related} of {} related pages. {more} {tail}",
                self.direct_blocks.len(),
                self.references.len(),
                self.related_pages.len()
            ),
            how_to_fetch_all,
        }));
        TopicContext {
            direct_blocks: self.direct_blocks[..blocks].to_vec(),
            references: self.references[..references].to_vec(),
            related_pages: self.related_pages[..related].to_vec(),
            warnings,
            ..self.clone()
        }
    }

    /// What a reader can do about a size cut that kept `blocks` blocks and `references` references: the sentence for
    /// the warning, and the `howToFetchAll` when a parameter reads on (BR-0006). Only the references can be read on,
    /// by `references_offset` from the last one kept, or by making room for them with a lower `max_blocks` when the
    /// blocks left none. Blocks and related pages have no offset.
    fn read_on(&self, blocks: usize, references: usize) -> (String, Option<String>) {
        let left_out = |kept: usize, all: usize| kept < all;
        if references > 0 && left_out(references, self.references.len()) && blocks == self.direct_blocks.len() {
            let next = self.references_from + references;
            return (
                "No parameter raises this limit, but references_offset reads on.".to_owned(),
                Some(format!("Set references_offset to {next} for the next references. Pass max_blocks 0 and max_related_pages 0 to leave out what is already read.")),
            );
        }
        if references == 0 && !self.references.is_empty() {
            return (
                "No parameter raises this limit, but a lower max_blocks makes room for the references.".to_owned(),
                Some("Set max_blocks lower (0 leaves the blocks out) to read the references the blocks left no room for.".to_owned()),
            );
        }
        ("No parameter raises this limit.".to_owned(), None)
    }

    /// The context as it is when its text fits the character budget (#485), else cut to the first entries that do.
    fn fit_to_budget(self, render: &impl Fn(&TopicContext) -> String, compact: bool) -> TopicContext {
        let total = self.direct_blocks.len() + self.references.len() + self.related_pages.len();
        let size_of = |kept: usize| size(&render(&if kept < total { self.cut_to(kept, false, compact) } else { self.clone() }));
        match fit(total, 1, size_of) {
            Fit::Whole => self,
            Fit::Cut { kept, oversize } => self.cut_to(kept, oversize, compact),
        }
    }
}

/// The page's properties, or an empty object when it has none.
fn page_properties(page: &Value) -> Value {
    match page.get("properties") {
        Some(properties) if !matches!(properties, Value::Null | Value::Bool(false)) => properties.clone(),
        _ => json!({}),
    }
}

/// Says the page isn't the exact name the caller gave (`resolvedFrom`). Absent for an exact match.
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

/// The page a linking block sits on: the tuple's page, else the block's own. None for a block with neither, which is
/// no reference.
fn source_page_of(backlink: &Backlink, block: &Value) -> Option<Value> {
    match (&backlink.page, block.get("page")) {
        (page, _) if !page.is_null() => Some(page.clone()),
        (_, Some(page)) if !page.is_null() => Some(page.clone()),
        _ => None,
    }
}

/// The pages that link the topic, each once, in the order of `backlinks` (LogSeq's, or by name for an alias group):
/// the source page of each linking block.
fn related_pages_of(backlinks: &[Backlink]) -> Vec<Value> {
    let mut related_pages = Vec::new();
    let mut seen = HashSet::new();
    for backlink in backlinks {
        for block in &backlink.blocks {
            let Some(source) = source_page_of(backlink, block) else { continue };
            if let Some(id) = id_of(Some(&source)) {
                if seen.insert(id) {
                    related_pages.push(source);
                }
            }
        }
    }
    related_pages
}

/// The reference blocks, each with the page it sits on, in the order of `backlinks`. A block with no source page is
/// no reference.
fn references_of(backlinks: Vec<Backlink>) -> Vec<Reference> {
    let mut references = Vec::new();
    for backlink in backlinks {
        for block in &backlink.blocks {
            let Some(source_page) = source_page_of(&backlink, block) else { continue };
            references.push(Reference { block: block.clone(), source_page });
        }
    }
    references
}

/// The `temporalContext` of a page: whether it is a journal, and its day.
fn temporal_context(page: &Value) -> TemporalContext {
    if journal_flag(Some(page)) == Some(true) {
        TemporalContext { is_journal: true, date: journal_day_of(Some(page)) }
    } else {
        TemporalContext { is_journal: false, date: None }
    }
}

/// The `references_truncated` warning: `shown` of the references from `offset` on were kept, out of `total`. It pages
/// with `references_offset` first and offers the raise of `max_references` as the other way, and it has no maximum to
/// name: the character budget bounds the result, and its own warning says when it bites.
fn references_truncated_warning(offset: usize, shown: usize, total: usize) -> ResultWarning {
    let remaining = total - offset;
    let what = if offset > 0 { format!("references from offset {offset}") } else { "references".to_owned() };
    // An offset that does not move reads nothing on, so a result with no reference has no next page
    let paging = (shown > 0).then(|| Paging { param: "references_offset", next: format!("Set references_offset to {} for the next page.", offset + shown) });
    capped_truncation_warning(CappedTruncation {
        what: &what,
        shown,
        total: remaining,
        param: "max_references",
        max: usize::MAX,
        narrower: "",
        requested: None,
        code: "references_truncated",
        inline_max: Some(INLINE_REFERENCES),
        paging,
    })
}

/// LogSeq answered `null` to the query for the blocks of the page (or of its alias group).
fn page_blocks_unavailable(page: &str) -> ResultWarning {
    ResultWarning::new(
        "page_blocks_unavailable",
        format!(
            "LogSeq returned no answer when looking up the blocks of \"{page}\" (possibly no graph open or a re-index in progress), \
             so the empty directBlocks may not mean the page has none. {RETRY_ADVICE}"
        ),
    )
}

/// LogSeq answered `null` to the linked references of the page (or of its alias group).
fn backlinks_unavailable_warning(page: &str) -> ResultWarning {
    ResultWarning::new(
        "backlinks_unavailable",
        format!(
            "LogSeq returned no answer when looking up the pages that link to \"{page}\" (possibly no graph open or a re-index in progress), \
             so the empty relatedPages and references may not mean nothing links here. {RETRY_ADVICE}"
        ),
    )
}

/// Builds the context of a page.
///
/// `page_name` is a page name, an alias or an ISO date (`2025-01-01`) of a journal. The page is
/// resolved first (BR-0010); with aliases, its blocks and references cover every name of the group
/// (#69).
///
/// Fails with [`ToolError::PageNotFound`] (guidance with the closest names) if no page matches, and
/// [`ToolError::AmbiguousPage`] (with the candidates) if several do.
pub async fn explore_page_context(client: &LogseqClient, page_name: &str, caps: Caps) -> Result<TopicContext, ToolError> {
    // Query 1: resolve the main page (exact name, alias or ISO date, in one query)
    let resolved = require_page(client, page_name).await?;
    let main_page = resolved.page.raw.clone();

    // The names this page goes by (#69): a page with no `alias::` costs no call here
    let alias_set: AliasSet = resolve_alias_set(client, &resolved.page).await?;
    let aliased = alias_set.has_aliases();

    // Query 2: the blocks of the page, or of every page of its alias group (may be empty)
    let blocks_query = if aliased { get_blocks_on_pages(&alias_set.ids()?) } else { get_page_blocks(&PageName::new(&resolved.lookup_name)) };
    let answer = client.execute_datalog_query(&blocks_query.text, &blocks_query.inputs).await?;
    // A `null` answer is no answer, not "no blocks" (BR-0011, #338): the page is shown without them, and a warning says why
    let rows = block_rows(answer)?;
    let blocks_unavailable = rows.is_none();
    let rows = rows.unwrap_or_default();
    let fetched: Vec<Value> = rows.into_iter().flatten().map(Value::Object).collect();
    let all_blocks = blocks_of(fetched, aliased, id_of(Some(&main_page)));
    let mut direct_blocks: Vec<Value> = all_blocks.iter().take(caps.max_blocks as usize).cloned().collect();

    // Query 3: the reference blocks, and the related pages derived from them. `[]` means the page has no
    // backlinks and `null` that LogSeq gave no answer (BR-0011, #338: a warning says so); an error
    // (connection, timeout, auth, unexpected) propagates.
    let backlinks = fetch_backlinks(client, &resolved.lookup_name, &alias_set).await?;
    let backlinks_unavailable = backlinks.is_none();
    let backlinks = backlinks.unwrap_or_default();
    // The related pages stay in the order LogSeq gave them, and the references are ranked, most-linking pages first
    let all_related_pages = related_pages_of(&backlinks);
    let all_references = references_of(rank_backlinks(backlinks));

    // Everything is already in memory, so the totals cost no extra API call. An offset past the last reference reads
    // nothing and is no more than the end.
    let totals = Totals { blocks: all_blocks.len(), related_pages: all_related_pages.len(), references: all_references.len() };
    let references_from = usize::try_from(caps.references_offset).unwrap_or(usize::MAX).min(all_references.len());
    let mut references: Vec<Reference> = all_references.into_iter().skip(references_from).take(caps.max_references as usize).collect();
    let related_pages: Vec<Value> = all_related_pages.into_iter().take(caps.max_related_pages as usize).collect();

    let mut warnings = alias_set_warnings(&[&alias_set]);
    // No `howToFetchAll`: no parameter fetches what LogSeq did not answer, so `hasMore` stays false
    if blocks_unavailable {
        warnings.push(page_blocks_unavailable(&resolved.original_name));
    }
    if backlinks_unavailable {
        warnings.push(backlinks_unavailable_warning(&resolved.original_name));
    }
    if totals.blocks > direct_blocks.len() {
        warnings.push(truncation_warning("blocks", direct_blocks.len(), totals.blocks, "max_blocks", "blocks_truncated", Some(INLINE_BLOCKS)));
    }
    if totals.references > references_from + references.len() {
        warnings.push(references_truncated_warning(references_from, references.len(), totals.references));
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
        topic: page_name.to_owned(),
        resolved_from: resolved_from(page_name, &resolved),
        resolved_aliases: alias_set.resolved_aliases(),
        main_page,
        direct_blocks,
        related_pages,
        references,
        references_from,
        temporal_context,
        warnings,
        totals,
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
    fn the_explore_context_schema_means_what_the_pinned_one_means() {
        // `inputSchema` of logseq_explore_context in the ADR-0016 snapshot
        let pinned = json!({
            "type": "object",
            "properties": {
                "page": {"type": "string", "description": "Page to explore (name, alias or ISO date)"},
                "max_blocks": {"type": "integer", "minimum": 0, "default": 50, "description": "Maximum number of blocks to include (default: 50)"},
                "max_related_pages": {"type": "integer", "minimum": 0, "default": 10, "description": "Maximum number of related pages to include (default: 10)"},
                "max_references": {"type": "integer", "minimum": 0, "default": 20, "description": "Maximum number of reference blocks to include (default: 20)"},
                "references_offset": {"type": "integer", "minimum": 0, "default": 0, "description": "Reference blocks to skip, most-linking pages first (default: 0)"},
                "include_temporal_context": {"type": "boolean", "default": true, "description": "Include temporal context for journal pages (default: true)"},
                "resolve_refs": {"type": "boolean", "default": false, "description": "Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2)"},
                "format": {"type": "string", "enum": ["json", "markdown"], "description": "json (default), or markdown text. Markdown has block uuids only on search hits and with compact"},
                "compact": {"type": "boolean", "default": false, "description": "Block snippets and uuids, no bodies. Read one with logseq_get_block"},
            },
            "required": ["page"],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&pinned));
    }

    fn context_of(blocks: usize, references: usize, related: usize, length: usize) -> TopicContext {
        let text = "x".repeat(length);
        TopicContext {
            topic: "atlas".into(),
            resolved_from: None,
            resolved_aliases: None,
            main_page: json!({"id": 1, "name": "atlas"}),
            direct_blocks: (0..blocks as i64).map(|id| json!({"id": 100 + id, "content": text})).collect(),
            related_pages: (0..related as i64).map(|id| json!({"id": 500 + id, "name": format!("page {id}")})).collect(),
            references: (0..references as i64)
                .map(|id| Reference { block: json!({"id": 900 + id, "content": text}), source_page: json!({"id": 2000 + id}) })
                .collect(),
            references_from: 0,
            temporal_context: None,
            warnings: vec![],
            totals: Totals { blocks: blocks + 5, related_pages: related, references },
        }
    }

    fn json_of(context: &TopicContext) -> String {
        context.to_value().to_string()
    }

    #[test]
    fn a_context_that_fits_the_budget_is_returned_as_it_is() {
        let context = context_of(5, 5, 5, 200);
        assert_eq!(context.clone().fit_to_budget(&json_of, false), context);
    }

    #[test]
    fn a_context_over_the_budget_drops_related_pages_then_references_then_blocks() {
        // 30 blocks and 30 references of 600 characters: 36,000 of text, and 20 related pages
        let context = context_of(30, 30, 20, 600);
        let fitted = context.clone().fit_to_budget(&json_of, false);
        assert!(size(&json_of(&fitted)) <= crate::budget::BUDGET_CHARS);
        // every block is kept before a reference, and every reference before a related page
        assert_eq!(fitted.direct_blocks.len(), 30);
        assert!(fitted.references.len() < 30 && fitted.references.len() > 0);
        assert!(fitted.related_pages.is_empty());
        // `summary` counts what is returned, `totals` what there was before the caps
        let value = fitted.to_value();
        assert_eq!(value["summary"]["totalReferences"], json!(fitted.references.len()));
        assert_eq!(value["totals"], json!({"blocks": 35, "relatedPages": 20, "references": 30}));
        // the references that did not fit can be read on with an offset, so there is more
        assert_eq!(value["hasMore"], true);
        assert_eq!(value["warnings"][0]["code"], "result_size_truncated");
        assert!(value["warnings"][0]["howToFetchAll"].as_str().unwrap().starts_with(&format!("Set references_offset to {} ", fitted.references.len())));
        // one more entry would not fit
        let kept = fitted.direct_blocks.len() + fitted.references.len();
        assert!(size(&json_of(&context.cut_to(kept + 1, false, false))) > crate::budget::BUDGET_CHARS);
    }

    #[test]
    fn a_block_over_the_budget_is_kept_alone_and_never_cut() {
        let context = context_of(2, 0, 0, 40_000);
        let fitted = context.fit_to_budget(&json_of, false);
        assert_eq!(fitted.direct_blocks.len(), 1);
        assert_eq!(fitted.direct_blocks[0]["content"].as_str().unwrap().len(), 40_000);
        assert!(fitted.warnings[0].message.contains("an entry is never cut inside its text"));
        // a context with a single entry, however large, is not cut
        let lone = context_of(1, 0, 0, 40_000);
        assert_eq!(lone.clone().fit_to_budget(&json_of, false), lone);
        // and an empty one has nothing to cut
        let empty = context_of(0, 0, 0, 0);
        assert_eq!(empty.clone().fit_to_budget(&json_of, true), empty);
    }

    #[test]
    fn the_budget_measures_the_markdown_and_the_compact_text_the_call_sends() {
        let context = context_of(30, 30, 0, 600);
        let markdown = |context: &TopicContext| {
            let result = context.to_value();
            with_footer(render_topic_context(&result, ContextRenderOptions::default()), &FooterMeta::of_result(&result, &[]))
        };
        let fitted = context.clone().fit_to_budget(&markdown, false);
        assert!(size(&markdown(&fitted)) <= crate::budget::BUDGET_CHARS);
        assert!(fitted.direct_blocks.len() + fitted.references.len() < 60);
        // the footer carries the warning
        assert!(markdown(&fitted).contains("result_size_truncated"));
        // compact text is short enough for the same context to fit whole
        let compact = |context: &TopicContext| compact_topic_context(&context.to_value()).to_string();
        assert_eq!(context.clone().fit_to_budget(&compact, true), context);
    }

    #[test]
    fn the_tool_is_read_only_and_titled_as_pinned() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Explore Context"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Explore Context", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }

    #[test]
    fn the_arguments_are_read_in_schema_order_and_the_aliases_are_folded() {
        let folded = resolve_param_aliases(ALIASES, args(json!({"page_name": "Atlas", "max_blocks": 3}))).unwrap();
        let request = Request::from(parse_args::<Args>(folded.as_ref()).unwrap());
        assert_eq!(request.page, "Atlas");
        assert_eq!(request.caps, Caps { max_blocks: 3, ..Caps::default() });
        let error = parse_args::<Args>(args(json!({"page": "a", "max_blocks": -1, "format": "xml"})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'max_blocks': -1"), "{error}");
        let error = parse_args::<Args>(args(json!({})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'page': missing"), "{error}");
    }

    #[test]
    fn every_argument_takes_what_it_says_and_nothing_else() {
        use crate::args::testing::{Takes, sweep};
        let base = json!({"page": "Atlas"});
        sweep::<Args>(json!({}), "page", Takes::Text, true);
        for count in ["max_blocks", "max_related_pages", "max_references", "references_offset"] {
            sweep::<Args>(base.clone(), count, Takes::Count(0), false);
        }
        for flag in ["include_temporal_context", "resolve_refs", "compact"] {
            sweep::<Args>(base.clone(), flag, Takes::Flag, false);
        }
        sweep::<Args>(base, "format", Takes::Words(&["json", "markdown"]), false);
    }

    #[test]
    fn compact_skips_resolve_refs_but_the_request_remembers_it_was_asked() {
        let request = Request::from(parse_args::<Args>(args(json!({"page": "a", "resolve_refs": true, "compact": true})).as_ref()).unwrap());
        assert!(!request.caps.resolve_refs && request.resolve_refs && request.compact);
        let request = Request::from(parse_args::<Args>(args(json!({"page": "a", "resolve_refs": true})).as_ref()).unwrap());
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

    fn tuples() -> Vec<Backlink> {
        vec![
            Backlink { page: json!({"id": 20, "name": "bob"}), blocks: vec![block(201, 20), block(202, 20)] },
            // a tuple with no page: the block's own page names the source
            Backlink { page: Value::Null, blocks: vec![block(301, 30), json!({"id": 302, "uuid": "u302"})] },
            Backlink { page: json!({"id": 20, "name": "bob"}), blocks: vec![block(203, 20)] },
        ]
    }

    fn ids(references: &[Reference]) -> Vec<i64> {
        references.iter().map(|r| r.block["id"].as_i64().unwrap()).collect()
    }

    #[test]
    fn related_pages_are_the_source_pages_once_each_and_every_block_is_a_reference() {
        assert_eq!(related_pages_of(&tuples()), [json!({"id": 20, "name": "bob"}), json!({"id": 30})]);
        let references = references_of(tuples());
        // the block with no page anywhere has no source and is skipped
        assert_eq!(ids(&references), [201, 202, 301, 203]);
        assert_eq!(references[2].source_page, json!({"id": 30}));
    }

    #[test]
    fn the_references_come_ranked_and_the_related_pages_in_the_order_of_the_tuples() {
        // bob links twice in the first tuple, carol once, alice three times in the last
        let source = |id: i64, name: &str, blocks: usize| Backlink {
            page: json!({"id": id, "name": name}),
            blocks: (0..blocks as i64).map(|n| block(id * 100 + n, id)).collect(),
        };
        let backlinks = vec![source(2, "bob", 2), source(3, "carol", 1), source(1, "alice", 3)];
        let related = related_pages_of(&backlinks);
        assert_eq!(related.iter().map(|page| page["name"].as_str().unwrap()).collect::<Vec<_>>(), ["bob", "carol", "alice"]);
        let ranked = references_of(rank_backlinks(backlinks));
        // alice (3), bob (2), carol (1), and the blocks of one page sit together
        assert_eq!(ids(&ranked), [100, 101, 102, 200, 201, 300]);
    }

    fn references_of_pages(per_page: &[usize]) -> Vec<Reference> {
        per_page
            .iter()
            .enumerate()
            .flat_map(|(page, &count)| (0..count).map(move |n| Reference { block: json!({"id": page * 100 + n, "content": "x"}), source_page: json!({"id": page + 1}) }))
            .collect()
    }

    #[test]
    fn a_cut_references_warning_names_the_offset_that_reads_on_and_the_raise_as_the_other_way() {
        let warning = references_truncated_warning(0, 20, 66);
        assert_eq!(warning.code, "references_truncated");
        assert_eq!(warning.message, "Showing 20 of 66 references. Page through the rest with references_offset.");
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some("Set references_offset to 20 for the next page. Or set max_references to 66 (or higher) to get all 66 in one call.")
        );
        // from an offset the count is of what is left, and the next page starts where this one ends
        let later = references_truncated_warning(20, 20, 66);
        assert_eq!(later.message, "Showing 20 of 46 references from offset 20. Page through the rest with references_offset.");
        assert!(later.how_to_fetch_all.as_deref().unwrap().starts_with("Set references_offset to 40 for the next page. Or set max_references to 46 "));
        // a cap of 0 shows none, so an offset that does not move is not offered
        let none = references_truncated_warning(0, 0, 5);
        assert_eq!(none.message, "Showing 0 of 5 references.");
        assert_eq!(none.how_to_fetch_all.as_deref(), Some("Set max_references to 5 (or higher) to get all 5."));
        // a raise past the inline estimate carries the large-result note
        assert!(references_truncated_warning(0, 20, 400).how_to_fetch_all.unwrap().ends_with("A result this large may be saved to a file by the host instead of shown; the server can't tell."));
    }

    fn with_references(references: Vec<Reference>, references_from: usize, warnings: Vec<ResultWarning>) -> TopicContext {
        TopicContext { references, references_from, warnings, ..context_of(0, 0, 0, 0) }
    }

    #[test]
    fn a_size_cut_that_drops_references_but_no_block_names_the_offset_after_the_last_one_kept() {
        let mut context = with_references(references_of_pages(&[10]), 30, vec![references_truncated_warning(30, 10, 80)]);
        context.direct_blocks = vec![json!({"id": 1, "content": "b"})];
        // 1 block and 4 of the 10 references kept
        let cut = context.cut_to(5, false, false);
        assert_eq!(cut.references.len(), 4);
        // the count cap's own advice is about references that are no longer there, so the size cut says it instead
        assert_eq!(cut.warnings.iter().map(|w| w.code.as_str()).collect::<Vec<_>>(), ["result_size_truncated"]);
        let warning = &cut.warnings[0];
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set references_offset to 34 for the next references. Pass max_blocks 0 and max_related_pages 0 to leave out what is already read."));
        assert!(warning.message.contains("That is 1 of 1 blocks, 4 of 10 references and 0 of 0 related pages."), "{}", warning.message);
        assert!(warning.message.ends_with("No parameter raises this limit, but references_offset reads on."), "{}", warning.message);
        assert!(cut.has_more());
    }

    #[test]
    fn a_count_cap_warning_stays_when_the_size_cut_leaves_its_list_alone() {
        // the references are kept whole, so the count cap's paging advice still holds; only a related page goes
        let mut context = with_references(references_of_pages(&[3]), 0, vec![references_truncated_warning(0, 3, 50)]);
        context.related_pages = vec![json!({"id": 1}), json!({"id": 2})];
        let cut = context.cut_to(4, false, false);
        assert_eq!((cut.references.len(), cut.related_pages.len()), (3, 1));
        assert_eq!(cut.warnings.iter().map(|w| w.code.as_str()).collect::<Vec<_>>(), ["references_truncated", "result_size_truncated"]);
        assert!(cut.warnings[1].how_to_fetch_all.is_none());
        assert!(cut.warnings[1].message.ends_with("No parameter raises this limit."));
    }

    #[test]
    fn references_the_blocks_left_no_room_for_are_reached_with_a_lower_max_blocks() {
        let mut context = with_references(references_of_pages(&[4]), 0, vec![]);
        context.direct_blocks = vec![json!({"id": 1, "content": "b"}), json!({"id": 2, "content": "b"})];
        // only the blocks fit: no reference is kept, and paging would read the same call again
        let cut = context.cut_to(2, false, false);
        assert!(cut.references.is_empty());
        let warning = &cut.warnings[0];
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set max_blocks lower (0 leaves the blocks out) to read the references the blocks left no room for."));
        assert!(warning.message.ends_with("No parameter raises this limit, but a lower max_blocks makes room for the references."), "{}", warning.message);
        // a cut inside the blocks drops the references too, and so does the same advice
        assert!(context.cut_to(1, false, false).warnings[0].how_to_fetch_all.is_some());
    }

    #[test]
    fn a_size_cut_with_no_references_to_read_on_has_nothing_to_fetch() {
        let mut context = with_references(Vec::new(), 0, vec![]);
        context.direct_blocks = vec![json!({"id": 1, "content": "b"}), json!({"id": 2, "content": "b"})];
        let cut = context.cut_to(1, false, false);
        assert_eq!(cut.warnings[0].how_to_fetch_all, None);
        assert!(!cut.has_more());
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
        let written = |page: Value| result_value(&temporal_context(&page)).to_string();
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
            references_from: 0,
            temporal_context: Some(TemporalContext { is_journal: false, date: None }),
            warnings: vec![ResultWarning::new("w", "m".into())],
            totals: Totals { blocks: 9, related_pages: 1, references: 1 },
        }
    }

    #[test]
    fn a_context_writes_what_was_answered_then_what_must_not_be_missed_then_the_data() {
        assert_eq!(
            context().to_value().to_string(),
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
        assert_eq!(keys(&context().to_value()), all);
        // no resolution, no temporal context: the others keep their places
        let bare = TopicContext { resolved_from: None, resolved_aliases: None, temporal_context: None, ..context() };
        assert_eq!(
            keys(&bare.to_value()),
            ["topic", "hasMore", "warnings", "totals", "summary", "mainPage", "directBlocks", "relatedPages", "references"]
        );
    }

}
