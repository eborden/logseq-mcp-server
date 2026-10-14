//! `logseq_explore_context`: everything on one page in a call. The page's blocks, the pages that link to it and
//! the blocks that do (its references), each list read to the end with the cursor (ADR-0038, #555).
//!
//! The references are the linked references of the page and of every alias, most-linking source pages first (ties by
//! page name, then id; [`references::rank_backlinks`]), so the blocks of one source page sit together. The related
//! pages are those source pages in the order LogSeq sent them, each once.
//!
//! Calls (the two-query pattern, ADR-0007): the page resolver (1 query for an exact name, an alias
//! or an ISO date; a namespace-leaf name adds the leaf query, and a missing page adds the
//! suggestion lookup before it fails), the alias lookup (1 query, only when the page has alias
//! links), the page's blocks (1 query: over the whole alias group for a page with aliases), then
//! the linked references (`logseq.Editor.getPageLinkedReferences` for a page with no aliases, or
//! one Datalog query over the group). The ranking and the caps are applied after the fetch, so they
//! cost no call. With `resolve_refs`, up to 2 more Datalog queries, none when no returned block holds a ref.
//!
//! A `null` answer to the blocks or to the linked references is not "none" (BR-0011, #338): the context is built
//! without that part and carries a `page_blocks_unavailable` or `backlinks_unavailable` warning, with no
//! `howToFetchAll`.
//!
//! **Pages.** The three lists (the page's blocks, then its references, then its related pages) each have a position,
//! and a page takes up to `max_blocks`, `max_references` and `max_related_pages` of each from there, then is cut to the
//! character budget (#485) from the tail: related pages first, then references, then blocks. Each position advances by
//! what the page sent, and a page that leaves anything behind carries a `nextCursor` (and `hasMore`) that holds the
//! three positions and the last block, reference and related page sent. A list that is read to its end is simply empty
//! on the pages after, and `max_X: 0` leaves a list out. The first call keeps the whole context in a snapshot
//! (`crate::snapshots`), so a call with only the cursor reads the next page from memory, with no LogSeq call; a snapshot
//! that is gone is built again with the first page's calls, and the last entry of each list sent is checked against
//! its position (`cursor_stale` says when a list moved). `resolve_refs` runs for the blocks and references of the page
//! being sent, whether the context came from LogSeq or from the snapshot.
//!
//! `resolvedFrom`, `resolvedAliases` and `summary` are on the first page only (maintainer, #568). The
//! warnings about the read itself (an alias group that was cut, a part LogSeq did not answer) are repeated on every
//! page.
//!
//! `format: "markdown"` renders the same context through [`crate::markdown_context`], its warnings, `hasMore` and
//! `nextCursor` in a footer. `compact` replaces each block with its snippet and uuid ([`crate::compact`]) and skips
//! `resolve_refs`, with a warning.
//!
//! This directory holds what only this tool uses: its queries (`queries.rs`), where the linked references are read
//! and ranked (`references.rs`) and the answers it reads (`wire.rs`). The alias groups and the resolver are shared
//! (`resolve`).

mod queries;
mod references;
mod wire;

use std::collections::HashSet;
use std::time::Instant;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::args::parse_args;
use crate::budget::{Fit, fit, size};
use crate::client::LogseqClient;
use crate::compact::compact_topic_context;
use crate::cursor::{Anchor, Cursor, Position, SectionAnchors, SnapshotKey, decode, encode, invalid};
use crate::edn::PageName;
use crate::entity::{id_of, journal_day_of, journal_flag};
use crate::errors::{InvalidParameter, MatchedBy, ToolError};
use crate::markdown::{FooterMeta, with_footer};
use crate::markdown_context::{ContextRenderOptions, render_topic_context};
use crate::meta::ResultWarning;
use crate::output_format::OutputFormat;
use crate::paging::{Cut, NEXT_PAGE, PagedCut, Resumed, Stale, paged_warning, refuse_with_cursor, resume_at, serve, stale_warning};
use crate::params::{ParamAliases, resolve_param_aliases};
use crate::resolve::alias::{AliasSet, alias_set_warnings, resolve_alias_set};
use crate::resolve::{RETRY_ADVICE, ResolvedPage, require_page};
use crate::resolve_refs::resolve_block_refs;
use crate::snapshots::{Snapshots, resident_weight};
use crate::tool::{CursorSchema, input_schema, read_only_annotations, result_value, success_result};
use crate::truncation::{INLINE_BLOCKS, INLINE_REFERENCES, INLINE_RELATED_PAGES, SizeCut, large_result_note, size_truncation_warning};

use self::queries::{get_blocks_on_pages, get_page_blocks};
use self::references::{fetch_backlinks, rank_backlinks};
use self::wire::{Backlink, block_rows};

pub const NAME: &str = "logseq_explore_context";

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Explore one page: its blocks, related pages and references (blocks linking to it, most-linking pages first). max_* are page sizes; hasMore: send only cursor=nextCursor.\n\n\
**Use when:** researching a topic with a page, or what links to it.\n\
**Can't find:** topics with no page (logseq_find_blocks).\n\
**Alternatives:** logseq_get_page (content only), logseq_explore_network (structure only).";

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
    /// Page to explore (name, alias or ISO date). Required unless cursor is given
    pub page: Option<String>,
    /// Blocks per page (default: 50)
    #[serde(default = "default_max_blocks")]
    pub max_blocks: u64,
    /// Related pages per page (default: 10)
    #[serde(default = "default_max_related_pages")]
    pub max_related_pages: u64,
    /// Reference blocks per page (default: 20)
    #[serde(default = "default_max_references")]
    pub max_references: u64,
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
    // No doc comment: the shared description is the type's (`CursorSchema`), and a doc comment would replace it
    #[schemars(with = "Option<CursorSchema>")]
    pub cursor: Option<String>,
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

impl Request {
    /// The request of arguments that name a page. `None` when they don't (a call with neither a page nor a cursor).
    fn of(args: Args) -> Option<Request> {
        let Args { page, max_blocks, max_related_pages, max_references, include_temporal_context, resolve_refs, format, compact, cursor: _ } = args;
        // Compact output drops the bodies, so there is nothing to resolve refs in
        let caps = Caps { max_blocks, max_related_pages, max_references, include_temporal_context, resolve_refs: resolve_refs && !compact };
        Some(Request { page: page?, caps, format, compact, resolve_refs })
    }

    /// The arguments as a cursor carries them: what the call asked, read again by [`Args`].
    fn stored(&self) -> Map<String, Value> {
        let mut stored = Map::new();
        stored.insert("page".into(), json!(self.page));
        stored.insert("max_blocks".into(), json!(self.caps.max_blocks));
        stored.insert("max_related_pages".into(), json!(self.caps.max_related_pages));
        stored.insert("max_references".into(), json!(self.caps.max_references));
        stored.insert("include_temporal_context".into(), json!(self.caps.include_temporal_context));
        stored.insert("resolve_refs".into(), json!(self.resolve_refs));
        match self.format {
            Some(OutputFormat::Json) => stored.insert("format".into(), json!("json")),
            Some(OutputFormat::Markdown) => stored.insert("format".into(), json!("markdown")),
            None => None,
        };
        stored.insert("compact".into(), json!(self.compact));
        stored
    }
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Explore Context")
        .with_annotations(read_only_annotations("Explore Context"))
}

/// What a cursor says about where to read on, once decoded and checked against this tool: where each of the three
/// lists continues, and the last entry of each that the page before sent. The arguments come back as [`Args`], parsed
/// again like any other (ADR-0038: nothing in a token is trusted).
struct Resume {
    cursor: Cursor,
    /// Where the blocks, the references and the related pages continue
    at: [usize; 3],
    anchors: SectionAnchors,
}

impl Resume {
    fn read(token: &str) -> Result<(Request, Resume), InvalidParameter> {
        let cursor = decode(token, NAME)?;
        let Position::Sections { blocks, references, related } = cursor.position else {
            return Err(invalid(token, NAME, "this is not a cursor of this tool: its position is not three lists"));
        };
        let Anchor::Sections(anchors) = cursor.anchor else {
            return Err(invalid(token, NAME, "this is not a cursor of this tool: its last entries are not three lists' own"));
        };
        // The arguments the token holds are read as any call's are. A cursor holds none of its own
        let args = parse_args::<Args>(Some(&cursor.args)).ok().filter(|args| args.cursor.is_none());
        let request = args.and_then(Request::of).ok_or_else(|| invalid(token, NAME, "its arguments are not ones this tool takes"))?;
        Ok((request, Resume { cursor, at: [blocks, references, related], anchors }))
    }

    /// Where each list continues in the list as it is now, with a warning for each that moved since the page before
    /// (ADR-0038): the position when the last entry sent is just before it, else right after that entry, else the
    /// position, clamped to the list.
    fn starts(&self, list: &ContextList) -> ([usize; 3], Vec<ResultWarning>) {
        let anchors = [self.anchors.blocks, self.anchors.references, self.anchors.related];
        let ids = [list.block_ids(), list.reference_ids(), list.related_ids()];
        let mut start = [0; 3];
        let mut stale = Vec::new();
        for section in 0..3 {
            let resumed = resume_list(&ids[section], self.at[section], anchors[section]);
            start[section] = resumed.start;
            if let Some(moved) = resumed.stale {
                stale.push(stale_warning(moved, SECTIONS[section].what));
            }
        }
        (start, stale)
    }
}

/// Where a list resumes: `position` if the entry just before it is the `anchor`, else right after the anchor, else
/// `position`. A list that has sent nothing has no anchor, and resumes at the start.
fn resume_list(ids: &[Option<i64>], position: usize, anchor: Option<i64>) -> Resumed {
    match anchor {
        None if position == 0 => Resumed { start: 0, stale: None },
        None => Resumed { start: position.min(ids.len()), stale: Some(Stale::Gone) },
        Some(anchor) => resume_at(ids.len(), position, |at| ids[at] == Some(anchor), || ids.iter().position(|id| *id == Some(anchor)).map(|at| at + 1)),
    }
}

/// The refusal of a call with neither a page nor a cursor, before any LogSeq call (BR-0008).
fn needs_page() -> ToolError {
    ToolError::InvalidParameter(InvalidParameter {
        param: "page".to_owned(),
        value: "missing".to_owned(),
        expected: "a string (required unless cursor is given)".to_owned(),
        example: Some("page: \"...\"".to_owned()),
    })
}

/// A call: aliases folded, arguments read, the context (from the snapshot a cursor names, or from LogSeq), then one
/// page of it as JSON, compact JSON or Markdown. This tool makes no tips.
///
/// A call with a `cursor` takes no other argument (they are in the token, ADR-0038), and is refused as such on the
/// arguments after the aliases are folded, so `{ cursor, name }` is not a cursor alone (BR-0008). A call with neither
/// `page` nor `cursor` is refused here, not by the schema.
pub async fn call(client: &LogseqClient, _tips_enabled: bool, snapshots: &Snapshots, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let arguments = resolve_param_aliases(ALIASES, arguments)?;
    let asked = parse_args::<Args>(arguments.as_ref())?;
    let (request, resume) = match asked.cursor.clone() {
        Some(token) => {
            refuse_with_cursor::<Args>(arguments.as_ref())?;
            let (request, resume) = Resume::read(&token)?;
            (request, Some(resume))
        }
        None => (Request::of(asked).ok_or_else(needs_page)?, None),
    };
    let now = Instant::now();
    // The arguments the context was built from: the cursor's own, byte for byte, so the snapshot it names is the one asked for
    let stored = resume.as_ref().map_or_else(|| request.stored(), |resume| resume.cursor.args.clone());
    let served = serve(snapshots, resume.as_ref().map(|resume| &resume.cursor.snapshot), &stored, now, || read_context(client, &request.page)).await?;
    let list = &*served.list;
    let (start, stale) = resume.as_ref().map_or(([0; 3], Vec::new()), |resume| resume.starts(list));
    let token = Token { args: stored.clone(), key: served.key, before: resume.as_ref().map(|resume| resume.anchors).unwrap_or_default() };
    let mut view = View::new(list, start, request.caps, resume.is_none(), stale, Some(token));
    view.resolve_refs(client, request.caps.resolve_refs).await?;
    // Compact output has no block bodies to resolve refs in. Say so rather than drop the request silently.
    if request.compact && request.resolve_refs {
        view.after.push(ResultWarning::new(
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
    let context = view.fit_to_budget(&render, request.compact);
    // A context that fits one page needs no snapshot, and a hit is kept already
    if context.next_cursor.is_some() {
        served.keep(snapshots, &stored, list.weight(), now);
    }
    Ok(success_result(vec![ContentBlock::text(render(&context))]))
}

/// What a context is built with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    /// Blocks per page
    pub max_blocks: u64,
    /// Related pages per page
    pub max_related_pages: u64,
    /// Reference blocks per page
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

impl Caps {
    /// The page sizes of the three lists, in the order a page holds them: blocks, references, related pages.
    fn page_sizes(&self) -> [usize; 3] {
        let size = |cap: u64| usize::try_from(cap).unwrap_or(usize::MAX);
        [size(self.max_blocks), size(self.max_references), size(self.max_related_pages)]
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

/// One of the three lists a page holds, and how it is worded in the warnings.
#[derive(Clone, Copy)]
struct Section {
    /// What the list holds, plural
    what: &'static str,
    /// The parameter that is its page size
    param: &'static str,
    /// The code of the warning for a cut by that page size
    code: &'static str,
    /// Rough count of entries that still come back inline (`truncation.rs`)
    inline_max: usize,
}

/// The lists, in the order a page holds them and the budget keeps them: blocks, references, related pages.
const SECTIONS: [Section; 3] = [
    Section { what: "blocks", param: "max_blocks", code: "blocks_truncated", inline_max: INLINE_BLOCKS },
    Section { what: "references", param: "max_references", code: "references_truncated", inline_max: INLINE_REFERENCES },
    Section { what: "related pages", param: "max_related_pages", code: "related_pages_truncated", inline_max: INLINE_RELATED_PAGES },
];

/// A context as it was read from LogSeq, whole: what a snapshot keeps. It does not depend on the page sizes, so a
/// page of any size can be cut from it.
#[derive(Debug, Clone, PartialEq)]
pub struct ContextList {
    page: String,
    resolved_from: Option<Value>,
    resolved_aliases: Option<Vec<String>>,
    /// The page as the resolver pulled it
    main_page: Value,
    blocks: Vec<Value>,
    /// The references, most-linking pages first
    references: Vec<Reference>,
    /// The pages that link the topic, each once, in the order LogSeq sent them
    related_pages: Vec<Value>,
    temporal_context: TemporalContext,
    /// What the read warned of (an alias group cut or not looked up, a part LogSeq did not answer): every page says it
    warnings: Vec<ResultWarning>,
}

impl ContextList {
    fn lens(&self) -> [usize; 3] {
        [self.blocks.len(), self.references.len(), self.related_pages.len()]
    }

    fn block_ids(&self) -> Vec<Option<i64>> {
        self.blocks.iter().map(|block| id_of(Some(block))).collect()
    }

    fn reference_ids(&self) -> Vec<Option<i64>> {
        self.references.iter().map(|reference| id_of(Some(&reference.block))).collect()
    }

    fn related_ids(&self) -> Vec<Option<i64>> {
        self.related_pages.iter().map(|page| id_of(Some(page))).collect()
    }

    /// The id of entry `at` of list `section`.
    fn id_at(&self, section: usize, at: usize) -> Option<i64> {
        match section {
            0 => id_of(self.blocks.get(at)),
            1 => id_of(self.references.get(at).map(|reference| &reference.block)),
            _ => id_of(self.related_pages.get(at)),
        }
    }

    /// What the snapshot weighs for the cache's bounds: the length of the JSON of the lists, scaled to the memory it
    /// takes ([`resident_weight`]).
    fn weight(&self) -> usize {
        let length = |text: serde_json::Result<String>| text.map_or(0, |text| text.len());
        resident_weight(
            length(serde_json::to_string(&self.blocks))
                + length(serde_json::to_string(&self.references))
                + length(serde_json::to_string(&self.related_pages))
                + length(serde_json::to_string(&self.main_page)),
        )
    }
}

/// One page of a topic's context (`TopicContext`). The page, the blocks and the pages are the entities LogSeq
/// sent, whole (BR-0004).
#[derive(Debug, Clone, PartialEq)]
pub struct TopicContext {
    pub page: String,
    /// How the request was read: on the first page only
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
    /// The cursor that reads the next page: there exactly when `hasMore` is true (ADR-0038), but for the offer a
    /// `resolve_refs` warning makes of its own
    pub next_cursor: Option<String>,
    has_more: bool,
    /// Whether `summary` is written: on the first page only (maintainer, #568)
    with_summary: bool,
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
    #[serde(rename = "nextCursor", skip_serializing_if = "Option::is_none")]
    next_cursor: Option<&'a str>,
    warnings: &'a [ResultWarning],
    totals: Totals,
}

/// A context as written, in BR-0013's order: what was answered (`page`, `resolvedFrom`,
/// `resolvedAliases`), what must not be missed (`hasMore`, `nextCursor`, `warnings`, `totals`, then `summary`), then
/// the data (`mainPage`, `directBlocks`, `relatedPages`, `references`, `temporalContext`).
#[derive(Serialize)]
struct TopicContextOutput<'a> {
    page: &'a str,
    #[serde(rename = "resolvedFrom", skip_serializing_if = "Option::is_none")]
    resolved_from: Option<&'a Value>,
    #[serde(rename = "resolvedAliases", skip_serializing_if = "Option::is_none")]
    resolved_aliases: Option<&'a [String]>,
    #[serde(flatten)]
    completeness: Completeness<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<ContextSummary>,
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
    /// `hasMore`: a `nextCursor` reads on (ADR-0038). A `resolve_refs` warning that offers a way of its own keeps it true
    /// with no cursor, as it did before the cursor.
    pub fn has_more(&self) -> bool {
        self.has_more
    }

    /// The context in BR-0013's key order.
    pub fn to_value(&self) -> Value {
        result_value(&TopicContextOutput {
            page: &self.page,
            resolved_from: self.resolved_from.as_ref(),
            resolved_aliases: self.resolved_aliases.as_deref(),
            completeness: Completeness { has_more: self.has_more, next_cursor: self.next_cursor.as_deref(), warnings: &self.warnings, totals: self.totals },
            summary: self.with_summary.then(|| ContextSummary {
                total_blocks: self.direct_blocks.len(),
                total_related_pages: self.related_pages.len(),
                total_references: self.references.len(),
                page_properties: page_properties(&self.main_page),
            }),
            main_page: &self.main_page,
            direct_blocks: &self.direct_blocks,
            related_pages: self.related_pages.iter().map(|page| RelatedPage { page, relationship_type: "inbound" }).collect(),
            references: &self.references,
            temporal_context: self.temporal_context,
        })
    }
}

/// What a cursor is made from: the arguments of the call, the snapshot its context was kept as, and the last entries
/// the pages before sent.
struct Token {
    args: Map<String, Value>,
    key: SnapshotKey,
    before: SectionAnchors,
}

/// What a page takes from each list before the budget cuts it: up to the page size from the position, with
/// `resolve_refs` applied to the blocks and references.
struct Candidates {
    blocks: Vec<Value>,
    references: Vec<Reference>,
    related_pages: Vec<Value>,
}

/// One page of a context, and everything its warnings, cursor and result are made from.
struct View<'a> {
    list: &'a ContextList,
    /// Where each list starts on this page
    start: [usize; 3],
    caps: Caps,
    candidates: Candidates,
    first_page: bool,
    /// A list moved between the pages
    stale: Vec<ResultWarning>,
    /// The warnings of the steps after the cut that `resolve_refs` and `compact` make, said after the count warnings
    after: Vec<ResultWarning>,
    /// What the next page's cursor carries. None for the library function, which has no snapshots to name
    token: Option<Token>,
}

impl<'a> View<'a> {
    fn new(list: &'a ContextList, start: [usize; 3], caps: Caps, first_page: bool, stale: Vec<ResultWarning>, token: Option<Token>) -> View<'a> {
        let [blocks, references, related] = caps.page_sizes();
        let slice = |at: usize, length: usize, cap: usize| (at.min(length), at.saturating_add(cap).min(length));
        let (from, to) = slice(start[0], list.blocks.len(), blocks);
        let direct_blocks = list.blocks[from..to].to_vec();
        let (from, to) = slice(start[1], list.references.len(), references);
        let refs = list.references[from..to].to_vec();
        let (from, to) = slice(start[2], list.related_pages.len(), related);
        let related_pages = list.related_pages[from..to].to_vec();
        View { list, start, caps, candidates: Candidates { blocks: direct_blocks, references: refs, related_pages }, first_page, stale, after: Vec::new(), token }
    }

    /// Opt-in (#18): one resolver pass over the blocks and references this page takes. Done before the budget measures
    /// the page, since the resolved text is part of what is sent.
    async fn resolve_refs(&mut self, client: &LogseqClient, resolve: bool) -> Result<(), ToolError> {
        if !resolve {
            return Ok(());
        }
        let candidates = &mut self.candidates;
        let roots: Vec<Value> = candidates.blocks.iter().cloned().chain(candidates.references.iter().map(|reference| reference.block.clone())).collect();
        let resolved = resolve_block_refs(client, &roots).await?;
        let (direct, referenced) = resolved.blocks.split_at(candidates.blocks.len());
        candidates.blocks = direct.to_vec();
        for (reference, block) in candidates.references.iter_mut().zip(referenced) {
            reference.block = block.clone();
        }
        self.after.extend(resolved.warnings);
        Ok(())
    }

    /// How many entries the page takes from each list.
    fn take(&self) -> [usize; 3] {
        [self.candidates.blocks.len(), self.candidates.references.len(), self.candidates.related_pages.len()]
    }

    fn total(&self) -> usize {
        self.take().iter().sum()
    }

    /// How many blocks, references and related pages the first `kept` entries are, in that order.
    fn share_of(&self, kept: usize) -> [usize; 3] {
        let take = self.take();
        let blocks = kept.min(take[0]);
        let references = (kept - blocks).min(take[1]);
        let related = (kept - blocks - references).min(take[2]);
        [blocks, references, related]
    }

    /// Whether the page, holding `share` of each list, leaves anything a cursor can read: a list whose page size is not
    /// 0 with entries past what the page sent. A page of no entry has none: a cursor that does not move reads nothing on.
    fn has_next(&self, share: [usize; 3]) -> bool {
        let sizes = self.caps.page_sizes();
        let lens = self.list.lens();
        self.token.is_some() && share.iter().sum::<usize>() > 0 && (0..3).any(|section| sizes[section] > 0 && self.start[section] + share[section] < lens[section])
    }

    /// The cursor that starts after what the page holds: each position advanced by what the page sent, each anchor the
    /// last entry sent (or, for a list the page sent nothing of, the one before).
    fn next_cursor(&self, share: [usize; 3]) -> Option<String> {
        let token = self.token.as_ref().filter(|_| self.has_next(share))?;
        let last = |section: usize, before: Option<i64>| if share[section] > 0 { self.list.id_at(section, self.start[section] + share[section] - 1) } else { before };
        let anchors = SectionAnchors { blocks: last(0, token.before.blocks), references: last(1, token.before.references), related: last(2, token.before.related) };
        let position = Position::Sections { blocks: self.start[0] + share[0], references: self.start[1] + share[1], related: self.start[2] + share[2] };
        Some(encode(&Cursor::new(NAME, token.args.clone(), position, Anchor::Sections(anchors), token.key)))
    }

    /// The warning of list `section` cut by its page size: it has entries past the ones this page takes. The cursor leads
    /// when it reads this list on; a raise of the page size is offered beside it on the first page, which a cursor call
    /// can't change.
    fn count_warning(&self, section: usize, has_next: bool) -> ResultWarning {
        let Section { what, param, code, inline_max } = SECTIONS[section];
        let len = self.list.lens()[section];
        let sizes = self.caps.page_sizes();
        let raise = self.first_page.then(|| format!("set {param} to {len} (or higher) to get all {len} in one call.{}", large_result_note(len, Some(inline_max))));
        paged_warning(PagedCut {
            count_code: code,
            cut: Cut::Count,
            what,
            start: self.start[section],
            kept: self.take()[section],
            total: len,
            advice: "",
            raise,
            has_next: has_next && sizes[section] > 0,
        })
    }

    /// The context holding the first `kept` entries of this page, with the warning of the size cut when that leaves
    /// entries behind (`oversize`: even the first ones are over the budget).
    fn result(&self, kept: usize, oversize: bool, compact: bool) -> TopicContext {
        let take = self.take();
        let share = self.share_of(kept);
        let next_cursor = self.next_cursor(share);
        let has_next = next_cursor.is_some();
        let mut warnings = self.stale.clone();
        warnings.extend(self.list.warnings.iter().cloned());
        // A list the size cut went into says so in its warning, so a count cap's own is left out
        for section in 0..3 {
            if share[section] == take[section] && self.start[section] + take[section] < self.list.lens()[section] {
                warnings.push(self.count_warning(section, has_next));
            }
        }
        warnings.extend(self.after.iter().cloned());
        if kept < self.total() {
            let more = if compact { "Read a block in full with logseq_get_block." } else { "Set compact to true for short snippets, or read a block with logseq_get_block." };
            warnings.push(size_truncation_warning(SizeCut {
                what: "entries (blocks, then references, then related pages)",
                kept,
                total: self.total(),
                oversize,
                advice: &format!(
                    "On this page that is {} of {} blocks, {} of {} references and {} of {} related pages. {more}",
                    share[0], take[0], share[1], take[1], share[2], take[2]
                ),
                how_to_fetch_all: has_next.then(|| NEXT_PAGE.to_owned()),
            }));
        }
        // A warning that offers a way of its own (the refs `resolve_refs` left) keeps `hasMore` true, as before the cursor
        let offers = self.after.iter().any(|warning| warning.how_to_fetch_all.is_some());
        TopicContext {
            page: self.list.page.clone(),
            resolved_from: self.first_page.then(|| self.list.resolved_from.clone()).flatten(),
            resolved_aliases: self.first_page.then(|| self.list.resolved_aliases.clone()).flatten(),
            main_page: self.list.main_page.clone(),
            direct_blocks: self.candidates.blocks[..share[0]].to_vec(),
            related_pages: self.candidates.related_pages[..share[2]].to_vec(),
            references: self.candidates.references[..share[1]].to_vec(),
            temporal_context: self.caps.include_temporal_context.then_some(self.list.temporal_context),
            warnings,
            totals: Totals { blocks: self.list.blocks.len(), related_pages: self.list.related_pages.len(), references: self.list.references.len() },
            has_more: has_next || offers,
            with_summary: self.first_page,
            next_cursor,
        }
    }

    /// The page as it is when its text fits the character budget (#485), else cut to the first entries that do: the
    /// related pages go first, then the references, then the blocks, and a page of one entry is never cut inside it
    /// (BR-0007). The warning and the cursor count against the budget.
    fn fit_to_budget(&self, render: &impl Fn(&TopicContext) -> String, compact: bool) -> TopicContext {
        let total = self.total();
        let size_of = |kept: usize| size(&render(&self.result(kept, false, compact)));
        match fit(total, 1, size_of) {
            Fit::Whole => self.result(total, false, compact),
            Fit::Cut { kept, oversize } => self.result(kept, oversize, compact),
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

/// Reads the context of a page: the whole of it, whatever the page sizes are.
///
/// `page_name` is a page name, an alias or an ISO date (`2025-01-01`) of a journal. The page is
/// resolved first (BR-0010); with aliases, its blocks and references cover every name of the group
/// (#69).
///
/// Fails with [`ToolError::PageNotFound`] (guidance with the closest names) if no page matches, and
/// [`ToolError::AmbiguousPage`] (with the candidates) if several do.
async fn read_context(client: &LogseqClient, page_name: &str) -> Result<ContextList, ToolError> {
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
    let blocks = blocks_of(fetched, aliased, id_of(Some(&main_page)));

    // Query 3: the reference blocks, and the related pages derived from them. `[]` means the page has no
    // backlinks and `null` that LogSeq gave no answer (BR-0011, #338: a warning says so); an error
    // (connection, timeout, auth, unexpected) propagates.
    let backlinks = fetch_backlinks(client, &resolved.lookup_name, &alias_set).await?;
    let backlinks_unavailable = backlinks.is_none();
    let backlinks = backlinks.unwrap_or_default();
    // The related pages stay in the order LogSeq gave them, and the references are ranked, most-linking pages first
    let related_pages = related_pages_of(&backlinks);
    let references = references_of(rank_backlinks(backlinks));

    let mut warnings = alias_set_warnings(&[&alias_set]);
    // No `howToFetchAll`: no parameter fetches what LogSeq did not answer, so `hasMore` stays false
    if blocks_unavailable {
        warnings.push(page_blocks_unavailable(&resolved.original_name));
    }
    if backlinks_unavailable {
        warnings.push(backlinks_unavailable_warning(&resolved.original_name));
    }

    Ok(ContextList {
        page: page_name.to_owned(),
        resolved_from: resolved_from(page_name, &resolved),
        resolved_aliases: alias_set.resolved_aliases(),
        // The page is a Datalog pull (`journal?`, `journal-day`), and the readers accept the Editor API's spelling too (#152)
        temporal_context: temporal_context(&main_page),
        main_page,
        blocks,
        references,
        related_pages,
        warnings,
    })
}

/// Builds the first page of the context of a page, with the page sizes of `caps` and no cut to the character budget.
/// It keeps no snapshot and makes no cursor, so a page size that leaves entries behind says so with a raise of that
/// page size, which is the one way on without a cursor (`call` is the tool).
///
/// Fails as [`read_context`] does.
pub async fn explore_page_context(client: &LogseqClient, page_name: &str, caps: Caps) -> Result<TopicContext, ToolError> {
    let list = read_context(client, page_name).await?;
    let mut view = View::new(&list, [0; 3], caps, true, Vec::new(), None);
    view.resolve_refs(client, caps.resolve_refs).await?;
    Ok(view.result(view.total(), false, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::budget::BUDGET_CHARS;
    use crate::tool::testing::{keys, meaning, schema_of};

    fn args(value: Value) -> Option<JsonObject> {
        value.as_object().cloned()
    }

    #[test]
    fn the_explore_context_schema_means_what_the_pinned_one_means() {
        // `inputSchema` of logseq_explore_context in the ADR-0016 snapshot
        let pinned = json!({
            "type": "object",
            "properties": {
                "page": {"type": "string", "description": "Page to explore (name, alias or ISO date). Required unless cursor is given"},
                "max_blocks": {"type": "integer", "minimum": 0, "default": 50, "description": "Blocks per page (default: 50)"},
                "max_related_pages": {"type": "integer", "minimum": 0, "default": 10, "description": "Related pages per page (default: 10)"},
                "max_references": {"type": "integer", "minimum": 0, "default": 20, "description": "Reference blocks per page (default: 20)"},
                "include_temporal_context": {"type": "boolean", "default": true, "description": "Include temporal context for journal pages (default: true)"},
                "resolve_refs": {"type": "boolean", "default": false, "description": "Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2)"},
                "format": {"type": "string", "enum": ["json", "markdown"], "description": "json (default), or markdown text. Markdown has block uuids only on search hits and with compact"},
                "compact": {"type": "boolean", "default": false, "description": "Block snippets and uuids, no bodies. Read one with logseq_get_block"},
                "cursor": {"type": "string", "description": crate::tool::CURSOR_DESCRIPTION},
            },
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&pinned));
    }

    // ---- a context to cut pages from

    const KEY: SnapshotKey = SnapshotKey { started: 1_760_000_000_000, n: 1 };

    /// A context of `blocks` blocks (ids from 100), `references` references (ids from 900) and `related` related pages
    /// (ids from 500), each block and reference `length` characters long.
    fn list_of(blocks: usize, references: usize, related: usize, length: usize) -> ContextList {
        let text = "x".repeat(length);
        ContextList {
            page: "atlas".into(),
            resolved_from: Some(json!({"name": "atlas", "matchedBy": "alias", "resolvedTo": "Project Atlas"})),
            resolved_aliases: Some(vec!["Atlas".into(), "Project Atlas".into()]),
            main_page: json!({"id": 1, "name": "atlas"}),
            blocks: (0..blocks as i64).map(|id| json!({"id": 100 + id, "content": text})).collect(),
            references: (0..references as i64).map(|id| Reference { block: json!({"id": 900 + id, "content": text}), source_page: json!({"id": 2000 + id}) }).collect(),
            related_pages: (0..related as i64).map(|id| json!({"id": 500 + id, "name": format!("page {id}")})).collect(),
            temporal_context: TemporalContext { is_journal: false, date: None },
            warnings: Vec::new(),
        }
    }

    fn json_of(context: &TopicContext) -> String {
        context.to_value().to_string()
    }

    fn request(caps: Caps) -> Request {
        Request { page: "atlas".into(), caps, format: None, compact: false, resolve_refs: false }
    }

    fn caps(max_blocks: u64, max_references: u64, max_related_pages: u64) -> Caps {
        Caps { max_blocks, max_references, max_related_pages, ..Caps::default() }
    }

    /// The first page of a context, cut to the budget, with a cursor that names the snapshot `KEY`.
    fn first_page(list: &ContextList, caps: Caps) -> TopicContext {
        page_after(list, caps, None)
    }

    /// The page a `cursor` reads (the first page for none), as `call` makes it from a snapshot.
    fn page_after(list: &ContextList, caps: Caps, cursor: Option<&str>) -> TopicContext {
        let (start, stale, before) = match cursor {
            None => ([0; 3], Vec::new(), SectionAnchors::default()),
            Some(token) => {
                let (_, resume) = Resume::read(token).unwrap();
                let (start, stale) = resume.starts(list);
                (start, stale, resume.anchors)
            }
        };
        let token = Token { args: request(caps).stored(), key: KEY, before };
        View::new(list, start, caps, cursor.is_none(), stale, Some(token)).fit_to_budget(&json_of, false)
    }

    /// The ids a page holds: blocks, references, related pages.
    fn ids_of(page: &TopicContext) -> [Vec<i64>; 3] {
        [
            page.direct_blocks.iter().map(|block| block["id"].as_i64().unwrap()).collect(),
            page.references.iter().map(|reference| reference.block["id"].as_i64().unwrap()).collect(),
            page.related_pages.iter().map(|page| page["id"].as_i64().unwrap()).collect(),
        ]
    }

    /// Every page from the first until one has no cursor.
    fn read_to_the_end(list: &ContextList, caps: Caps) -> Vec<TopicContext> {
        let mut pages: Vec<TopicContext> = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = page_after(list, caps, cursor.as_deref());
            cursor = page.next_cursor.clone();
            pages.push(page);
            assert!(pages.len() < 500, "the cursor never ends");
            if cursor.is_none() {
                return pages;
            }
        }
    }

    fn codes(page: &TopicContext) -> Vec<&str> {
        page.warnings.iter().map(|warning| warning.code.as_str()).collect()
    }

    #[test]
    fn a_context_that_fits_one_page_has_no_warning_and_no_cursor() {
        let list = list_of(5, 5, 5, 200);
        let page = first_page(&list, Caps::default());
        assert_eq!(ids_of(&page).map(|ids| ids.len()), [5, 5, 5]);
        assert_eq!((page.warnings.clone(), page.next_cursor.clone(), page.has_more()), (vec![], None, false));
        let value = page.to_value();
        assert!(value.get("nextCursor").is_none());
        assert_eq!(value["totals"], json!({"blocks": 5, "relatedPages": 5, "references": 5}));
    }

    #[test]
    fn a_list_exactly_at_its_page_size_is_no_cut_and_one_more_is() {
        let list = list_of(50, 20, 10, 10);
        let page = first_page(&list, Caps::default());
        assert_eq!((page.warnings.len(), page.next_cursor.is_some()), (0, false));
        let more = list_of(51, 20, 10, 10);
        let page = first_page(&more, Caps::default());
        assert_eq!(codes(&page), ["blocks_truncated"]);
        assert!(page.next_cursor.is_some() && page.has_more());
    }

    #[test]
    fn a_count_cut_leads_with_the_cursor_and_offers_the_raise_beside_it_on_the_first_page() {
        let list = list_of(5, 66, 3, 10);
        let page = first_page(&list, Caps::default());
        assert_eq!(codes(&page), ["references_truncated"]);
        let warning = &page.warnings[0];
        assert_eq!(warning.message, "Showing 1-20 of 66 references.");
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some("Pass nextCursor as cursor, with no other argument, to read the next page. Or set max_references to 66 (or higher) to get all 66 in one call.")
        );
        // the cursor holds each list's position and the last entry of each that was sent
        let cursor = decode(page.next_cursor.as_deref().unwrap(), NAME).unwrap();
        assert_eq!(cursor.position, Position::Sections { blocks: 5, references: 20, related: 3 });
        assert_eq!(cursor.anchor, Anchor::Sections(SectionAnchors { blocks: Some(104), references: Some(919), related: Some(502) }));
        assert_eq!(cursor.snapshot, KEY);
        // `hasMore` and `nextCursor` come right after the answer's notes, before the warnings (BR-0013)
        assert_eq!(
            keys(&page.to_value()),
            ["page", "resolvedFrom", "resolvedAliases", "hasMore", "nextCursor", "warnings", "totals", "summary", "mainPage", "directBlocks", "relatedPages", "references", "temporalContext"]
        );
    }

    #[test]
    fn a_raise_past_the_inline_estimate_carries_the_large_result_note_and_a_later_page_offers_none() {
        let list = list_of(5, 400, 3, 10);
        let page = first_page(&list, Caps::default());
        assert!(page.warnings[0].how_to_fetch_all.as_deref().unwrap().ends_with("A result this large may be saved to a file by the host instead of shown; the server can't tell."));
        // a cursor call can't change a page size, so the next page offers only the cursor
        let next = page_after(&list, Caps::default(), page.next_cursor.as_deref());
        assert_eq!(next.warnings[0].message, "Showing 21-40 of 400 references.");
        assert_eq!(next.warnings[0].how_to_fetch_all.as_deref(), Some("Pass nextCursor as cursor, with no other argument, to read the next page."));
    }

    #[test]
    fn the_notes_on_how_the_request_was_read_are_on_the_first_page_only_and_the_read_s_warnings_on_every_page() {
        let mut list = list_of(5, 30, 3, 10);
        list.warnings = vec![ResultWarning::new("alias_set_truncated", "m".into())];
        let first = first_page(&list, Caps::default());
        assert!(first.resolved_from.is_some() && first.resolved_aliases.is_some());
        assert_eq!(codes(&first), ["alias_set_truncated", "references_truncated"]);
        let last = page_after(&list, Caps::default(), first.next_cursor.as_deref());
        assert!(last.resolved_from.is_none() && last.resolved_aliases.is_none());
        assert_eq!(codes(&last), ["alias_set_truncated"]);
        assert_eq!(last.next_cursor, None);
        // every page says which page it is of, and what the totals were
        assert_eq!((last.page.as_str(), last.totals), ("atlas", first.totals));
    }

    #[test]
    fn the_summary_is_on_the_first_page_only() {
        let list = list_of(5, 50, 3, 10);
        let first = first_page(&list, Caps::default());
        assert!(first.to_value().get("summary").is_some());
        let second = page_after(&list, Caps::default(), first.next_cursor.as_deref());
        let value = second.to_value();
        assert!(value.get("summary").is_none());
        // the rest of a later page is as before: the page, its totals and its main page
        assert_eq!(keys(&value), ["page", "hasMore", "nextCursor", "warnings", "totals", "mainPage", "directBlocks", "relatedPages", "references", "temporalContext"]);
    }

    #[test]
    fn a_list_that_is_read_to_its_end_is_empty_on_the_pages_after() {
        // 5 blocks and 3 related pages are read on the first page; the references go on for three pages
        let list = list_of(5, 50, 3, 10);
        let pages = read_to_the_end(&list, Caps::default());
        assert_eq!(pages.len(), 3);
        assert_eq!(ids_of(&pages[0]).map(|ids| ids.len()), [5, 20, 3]);
        assert_eq!(ids_of(&pages[1]).map(|ids| ids.len()), [0, 20, 0]);
        assert_eq!(ids_of(&pages[2]).map(|ids| ids.len()), [0, 10, 0]);
        assert_eq!(pages[2].next_cursor, None);
        assert!(pages[2].warnings.is_empty() && !pages[2].has_more());
    }

    #[test]
    fn a_list_left_out_with_a_page_size_of_zero_never_moves_the_cursor_and_is_not_a_reason_for_one() {
        let list = list_of(30, 5, 4, 10);
        // blocks left out: the references and related pages fit one page, so there is nothing to read on
        let page = first_page(&list, caps(0, 20, 10));
        assert_eq!(ids_of(&page).map(|ids| ids.len()), [0, 5, 4]);
        assert_eq!(page.next_cursor, None);
        assert_eq!(codes(&page), ["blocks_truncated"]);
        assert_eq!(page.warnings[0].message, "Showing 0 of 30 blocks.");
        assert_eq!(page.warnings[0].how_to_fetch_all.as_deref(), Some("Set max_blocks to 30 (or higher) to get all 30 in one call."));
        // another list continues: the cursor reads it, and the warning about the blocks does not offer it for them
        let list = list_of(30, 45, 4, 10);
        let first = first_page(&list, caps(0, 20, 10));
        let warning = first.warnings.iter().find(|warning| warning.code == "blocks_truncated").unwrap();
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set max_blocks to 30 (or higher) to get all 30 in one call."));
        let pages = read_to_the_end(&list, caps(0, 20, 10));
        assert_eq!(pages.len(), 3);
        assert!(pages.iter().all(|page| page.direct_blocks.is_empty()));
        assert_eq!(pages.iter().map(|page| page.references.len()).sum::<usize>(), 45);
        // every page of no entry has no cursor: a cursor that does not move reads nothing on
        assert_eq!(first_page(&list, caps(0, 0, 0)).next_cursor, None);
    }

    #[test]
    fn an_empty_context_is_one_empty_page() {
        let page = first_page(&list_of(0, 0, 0, 0), Caps::default());
        assert_eq!(ids_of(&page).map(|ids| ids.len()), [0, 0, 0]);
        assert_eq!((page.warnings.len(), page.next_cursor), (0, None));
    }

    #[test]
    fn the_budget_drops_related_pages_then_references_then_blocks_and_the_cursor_reads_them_on() {
        // 30 blocks and 30 references of 600 characters: 36,000 of text, and 10 related pages
        let list = list_of(30, 30, 10, 600);
        let page = first_page(&list, caps(50, 50, 10));
        assert!(size(&json_of(&page)) <= BUDGET_CHARS);
        // every block is kept before a reference, and every reference before a related page
        let [blocks, references, related] = ids_of(&page);
        assert_eq!(blocks.len(), 30);
        assert!(!references.is_empty() && references.len() < 30);
        assert!(related.is_empty());
        let warning = page.warnings.last().unwrap();
        assert_eq!(warning.code, "result_size_truncated");
        assert!(warning.message.contains(&format!("Showing {} of 70 entries (blocks, then references, then related pages)", 30 + references.len())), "{}", warning.message);
        assert!(warning.message.contains(&format!("On this page that is 30 of 30 blocks, {} of 30 references and 0 of 10 related pages.", references.len())), "{}", warning.message);
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some(NEXT_PAGE));
        assert!(page.has_more() && page.next_cursor.is_some());
        // one more entry would not fit
        let view = View::new(&list, [0; 3], caps(50, 50, 10), true, Vec::new(), Some(Token { args: request(caps(50, 50, 10)).stored(), key: KEY, before: SectionAnchors::default() }));
        assert!(size(&json_of(&view.result(30 + references.len() + 1, false, false))) > BUDGET_CHARS);
        // `summary` counts what is returned, `totals` what the lists hold
        let value = page.to_value();
        assert_eq!(value["summary"]["totalReferences"], json!(references.len()));
        assert_eq!(value["totals"], json!({"blocks": 30, "relatedPages": 10, "references": 30}));
    }

    #[test]
    fn a_count_cap_warning_is_left_out_of_a_list_the_size_cut_went_into_and_stays_for_one_it_left_alone() {
        // the references are cut by the budget, the blocks only by their page size
        let list = list_of(60, 30, 0, 400);
        let page = first_page(&list, caps(50, 50, 10));
        assert_eq!(codes(&page), ["blocks_truncated", "result_size_truncated"]);
        // the blocks are kept whole, so the count cap's own advice about them holds; only references went
        assert_eq!(page.direct_blocks.len(), 50);
        // and a list the size cut went into has none of its own
        let page = first_page(&list_of(30, 60, 0, 600), caps(50, 60, 10));
        assert_eq!(codes(&page), ["result_size_truncated"]);
    }

    #[test]
    fn every_entry_of_a_context_several_times_the_budget_is_read_exactly_once_and_the_last_page_has_no_cursor() {
        // 60 blocks, 70 references and 25 related pages of 500 characters: about 70,000 characters
        let list = list_of(60, 70, 25, 500);
        let pages = read_to_the_end(&list, caps(50, 40, 12));
        assert!(pages.len() >= 4, "{} pages", pages.len());
        for page in &pages {
            assert!(size(&json_of(page)) <= BUDGET_CHARS);
        }
        let mut seen: [Vec<i64>; 3] = [Vec::new(), Vec::new(), Vec::new()];
        for page in &pages {
            for (section, ids) in ids_of(page).into_iter().enumerate() {
                seen[section].extend(ids);
            }
        }
        let expect: [Vec<i64>; 3] = [(100..160).collect(), (900..970).collect(), (500..525).collect()];
        assert_eq!(seen, expect, "each list exactly once, in order");
        let (last, others) = pages.split_last().unwrap();
        assert!(last.next_cursor.is_none() && !last.has_more());
        assert!(others.iter().all(|page| page.next_cursor.is_some() && page.has_more()));
        // each section ends on its own page: the blocks are read before the references, and the references before the related pages
        let last_page_with = |section: usize| pages.iter().rposition(|page| !ids_of(page)[section].is_empty()).unwrap();
        assert!(last_page_with(0) <= last_page_with(1) && last_page_with(1) <= last_page_with(2));
        assert!(pages.iter().all(|page| page.warnings.iter().all(|warning| warning.code != "cursor_stale")));
    }

    #[test]
    fn an_entry_over_the_budget_is_returned_alone_and_the_cursor_moves_past_it() {
        let list = list_of(3, 0, 0, 40_000);
        let pages = read_to_the_end(&list, Caps::default());
        assert_eq!(pages.len(), 3);
        for page in &pages {
            assert_eq!(page.direct_blocks.len(), 1);
            assert_eq!(page.direct_blocks[0]["content"].as_str().unwrap().len(), 40_000);
        }
        assert!(pages[0].warnings.last().unwrap().message.contains("an entry is never cut inside its text"));
        assert!(pages[2].warnings.is_empty());
        // a context with a single entry, however large, is not cut
        let lone = first_page(&list_of(1, 0, 0, 40_000), Caps::default());
        assert_eq!((lone.direct_blocks.len(), lone.warnings.len(), lone.next_cursor), (1, 0, None));
    }

    #[test]
    fn the_budget_measures_the_markdown_and_the_compact_text_the_call_sends() {
        let list = list_of(30, 30, 0, 600);
        let page_with = |render: &dyn Fn(&TopicContext) -> String, compact: bool| {
            let token = Token { args: request(Caps::default()).stored(), key: KEY, before: SectionAnchors::default() };
            View::new(&list, [0; 3], caps(50, 50, 10), true, Vec::new(), Some(token)).fit_to_budget(&render, compact)
        };
        let markdown = |context: &TopicContext| {
            let result = context.to_value();
            with_footer(render_topic_context(&result, ContextRenderOptions::default()), &FooterMeta::of_result(&result, &[]))
        };
        let fitted = page_with(&markdown, false);
        assert!(size(&markdown(&fitted)) <= BUDGET_CHARS);
        assert!(fitted.direct_blocks.len() + fitted.references.len() < 60);
        // the footer carries the warning, and the cursor that reads on
        assert!(markdown(&fitted).contains("result_size_truncated"));
        assert!(markdown(&fitted).contains(&format!("nextCursor: {}", fitted.next_cursor.as_deref().unwrap())));
        // compact text is short enough for the same context to fit whole
        let compact = |context: &TopicContext| compact_topic_context(&context.to_value()).to_string();
        let whole = page_with(&compact, true);
        assert_eq!((whole.direct_blocks.len(), whole.references.len(), whole.next_cursor), (30, 30, None));
    }

    #[test]
    fn a_page_a_list_changed_under_resumes_after_the_last_entry_sent_and_says_so() {
        let list = list_of(5, 60, 0, 10);
        let first = first_page(&list, Caps::default());
        let token = first.next_cursor.clone().unwrap();
        // three new references ranked before the position: the last one sent (919) is now at index 22
        let mut moved = list_of(5, 60, 0, 10);
        for id in [800, 801, 802] {
            moved.references.insert(0, Reference { block: json!({"id": id, "content": "x"}), source_page: json!({"id": 1}) });
        }
        let page = page_after(&moved, Caps::default(), Some(&token));
        assert_eq!(page.warnings[0].code, "cursor_stale");
        assert!(page.warnings[0].message.contains("The references changed"), "{}", page.warnings[0].message);
        assert_eq!(page.references[0].block["id"], 920, "right after the anchor: none repeated");
        // the last entry sent is gone: the page starts at the position, clamped
        let mut gone = list_of(5, 60, 0, 10);
        gone.references.retain(|reference| reference.block["id"] != 919);
        let page = page_after(&gone, Caps::default(), Some(&token));
        assert!(page.warnings[0].message.contains("is gone"), "{}", page.warnings[0].message);
        assert_eq!(page.references[0].block["id"], 921);
        // a list that did not change is no stale
        assert!(page_after(&list, Caps::default(), Some(&token)).warnings.iter().all(|warning| warning.code != "cursor_stale"));
        // a context that shrank past the position is an empty last page, not a panic
        let page = page_after(&list_of(5, 3, 0, 10), Caps::default(), Some(&token));
        assert!(page.references.is_empty() && page.next_cursor.is_none());
    }

    #[test]
    fn a_position_with_no_entry_sent_before_it_is_stale_and_one_at_the_start_is_not() {
        let ids = [Some(1), Some(2), Some(3)];
        assert_eq!(resume_list(&ids, 0, None), Resumed { start: 0, stale: None });
        assert_eq!(resume_list(&ids, 2, None), Resumed { start: 2, stale: Some(Stale::Gone) });
        assert_eq!(resume_list(&ids, 9, None), Resumed { start: 3, stale: Some(Stale::Gone) });
        assert_eq!(resume_list(&ids, 2, Some(2)), Resumed { start: 2, stale: None });
        assert_eq!(resume_list(&ids, 1, Some(3)), Resumed { start: 3, stale: Some(Stale::Moved) });
        assert_eq!(resume_list(&ids, 2, Some(7)), Resumed { start: 2, stale: Some(Stale::Gone) });
        assert_eq!(resume_list(&[], 0, None), Resumed { start: 0, stale: None });
    }

    #[test]
    fn a_cursor_is_read_as_a_call_and_a_token_that_is_not_this_tools_is_refused() {
        let list = list_of(5, 60, 0, 10);
        let token = first_page(&list, Caps::default()).next_cursor.unwrap();
        let (request, resume) = Resume::read(&token).unwrap();
        assert_eq!(request, Request { page: "atlas".into(), caps: Caps::default(), format: None, compact: false, resolve_refs: false });
        assert_eq!(resume.at, [5, 20, 0]);
        let refuse = |cursor: Cursor| Resume::read(&encode(&cursor)).err().expect("refused").expected;
        let good = decode(&token, NAME).unwrap();
        // another tool's token, a position or an anchor that are not three lists, arguments that name no page or hold a cursor
        assert!(refuse(Cursor { tool: "logseq_find_blocks".into(), ..good.clone() }).contains("made by another tool"));
        assert!(refuse(Cursor { position: Position::Index { at: 3 }, ..good.clone() }).contains("its position is not three lists"));
        assert!(refuse(Cursor { anchor: Anchor::Id(3), ..good.clone() }).contains("its last entries are not three lists' own"));
        let mut no_page = good.args.clone();
        no_page.remove("page");
        assert!(refuse(Cursor { args: no_page, ..good.clone() }).contains("its arguments are not ones this tool takes"));
        let mut nested = good.args.clone();
        nested.insert("cursor".into(), json!("abc"));
        assert!(refuse(Cursor { args: nested, ..good.clone() }).contains("its arguments are not ones this tool takes"));
        let mut wrong_type = good.args;
        wrong_type.insert("max_blocks".into(), json!("many"));
        assert!(refuse(Cursor { args: wrong_type, ..good }).contains("its arguments are not ones this tool takes"));
    }

    #[test]
    fn a_call_with_neither_a_page_nor_a_cursor_is_refused_with_the_page_named() {
        let error = Request::of(parse_args::<Args>(args(json!({"max_blocks": 3})).as_ref()).unwrap());
        assert_eq!(error, None);
        assert_eq!(needs_page().to_string(), "Invalid parameter 'page': missing\n\nExpected: a string (required unless cursor is given)\nExample: page: \"...\"");
    }

    #[test]
    fn a_cursor_with_an_alias_of_the_page_is_not_a_cursor_alone() {
        // BR-0008: the aliases are folded first, so `{ cursor, name }` is `{ cursor, page }` and the page can't change
        for alias in ["name", "page_name", "page"] {
            let folded = resolve_param_aliases(ALIASES, args(json!({"cursor": "abc", alias: "Atlas"}))).unwrap();
            let error = refuse_with_cursor::<Args>(folded.as_ref()).unwrap_err();
            assert_eq!(error.param, "page", "{alias}");
        }
        let alone = resolve_param_aliases(ALIASES, args(json!({"cursor": "abc"}))).unwrap();
        assert!(refuse_with_cursor::<Args>(alone.as_ref()).is_ok());
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
        let request = Request::of(parse_args::<Args>(folded.as_ref()).unwrap()).unwrap();
        assert_eq!(request.page, "Atlas");
        assert_eq!(request.caps, Caps { max_blocks: 3, ..Caps::default() });
        let error = parse_args::<Args>(args(json!({"page": "a", "max_blocks": -1, "format": "xml"})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'max_blocks': -1"), "{error}");
    }

    #[test]
    fn every_argument_takes_what_it_says_and_nothing_else() {
        use crate::args::testing::{Takes, sweep};
        let base = json!({"page": "Atlas"});
        sweep::<Args>(json!({}), "page", Takes::Text, false);
        for count in ["max_blocks", "max_related_pages", "max_references"] {
            sweep::<Args>(base.clone(), count, Takes::Count(0), false);
        }
        for flag in ["include_temporal_context", "resolve_refs", "compact"] {
            sweep::<Args>(base.clone(), flag, Takes::Flag, false);
        }
        sweep::<Args>(base.clone(), "cursor", Takes::Text, false);
        sweep::<Args>(base, "format", Takes::Words(&["json", "markdown"]), false);
    }

    #[test]
    fn the_stored_arguments_read_back_to_the_request_and_leave_out_the_cursor() {
        for request in [
            request(Caps::default()),
            Request { page: "Project Atlas".into(), caps: Caps { max_blocks: 0, max_related_pages: 3, max_references: 99, include_temporal_context: false, resolve_refs: true }, format: Some(OutputFormat::Markdown), compact: false, resolve_refs: true },
            Request { page: "a".into(), caps: Caps::default(), format: Some(OutputFormat::Json), compact: true, resolve_refs: true },
        ] {
            let stored = request.stored();
            assert!(!stored.contains_key("cursor"));
            let again = Request::of(parse_args::<Args>(Some(&stored)).unwrap()).unwrap();
            assert_eq!(again, Request { caps: Caps { resolve_refs: request.resolve_refs && !request.compact, ..request.caps }, ..request });
        }
    }

    #[test]
    fn compact_skips_resolve_refs_but_the_request_remembers_it_was_asked() {
        let request = Request::of(parse_args::<Args>(args(json!({"page": "a", "resolve_refs": true, "compact": true})).as_ref()).unwrap()).unwrap();
        assert!(!request.caps.resolve_refs && request.resolve_refs && request.compact);
        let request = Request::of(parse_args::<Args>(args(json!({"page": "a", "resolve_refs": true})).as_ref()).unwrap()).unwrap();
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

    #[test]
    fn the_same_context_makes_the_same_cursor() {
        // a token is made of the context and the arguments alone, so a snapshot that was built again resumes the same
        let list = list_of(70, 70, 70, 10);
        let first = first_page(&list, Caps::default());
        let again = first_page(&list, Caps::default());
        assert_eq!(first.next_cursor, again.next_cursor);
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
            page: "atlas".into(),
            resolved_from: Some(json!({"name": "atlas", "matchedBy": "alias", "resolvedTo": "Project Atlas"})),
            resolved_aliases: Some(vec!["Atlas".into(), "Project Atlas".into()]),
            main_page: json!({"id": 1, "name": "project atlas", "properties": {"type": "project"}}),
            direct_blocks: vec![json!({"id": 5, "uuid": "u5"})],
            related_pages: vec![json!({"id": 2})],
            references: vec![Reference { block: json!({"id": 6}), source_page: json!({"id": 2}) }],
            temporal_context: Some(TemporalContext { is_journal: false, date: None }),
            warnings: vec![ResultWarning::new("w", "m".into())],
            totals: Totals { blocks: 9, related_pages: 1, references: 1 },
            next_cursor: Some("abc".into()),
            has_more: true,
            with_summary: true,
        }
    }

    #[test]
    fn a_context_writes_what_was_answered_then_what_must_not_be_missed_then_the_data() {
        assert_eq!(
            context().to_value().to_string(),
            concat!(
                r#"{"page":"atlas","resolvedFrom":{"name":"atlas","matchedBy":"alias","resolvedTo":"Project Atlas"},"#,
                r#""resolvedAliases":["Atlas","Project Atlas"],"#,
                r#""hasMore":true,"nextCursor":"abc","warnings":[{"code":"w","message":"m"}],"totals":{"blocks":9,"relatedPages":1,"references":1},"#,
                r#""summary":{"totalBlocks":1,"totalRelatedPages":1,"totalReferences":1,"pageProperties":{"type":"project"}},"#,
                r#""mainPage":{"id":1,"name":"project atlas","properties":{"type":"project"}},"#,
                r#""directBlocks":[{"id":5,"uuid":"u5"}],"relatedPages":[{"page":{"id":2},"relationshipType":"inbound"}],"#,
                r#""references":[{"block":{"id":6},"sourcePage":{"id":2}}],"temporalContext":{"isJournal":false}}"#
            )
        );
    }

    #[test]
    fn the_order_of_a_context_does_not_depend_on_which_optional_keys_are_there() {
        let all = [
            "page", "resolvedFrom", "resolvedAliases", "hasMore", "nextCursor", "warnings", "totals", "summary", "mainPage", "directBlocks", "relatedPages",
            "references", "temporalContext",
        ];
        assert_eq!(keys(&context().to_value()), all);
        // no resolution, no cursor, no temporal context: the others keep their places
        let bare = TopicContext { resolved_from: None, resolved_aliases: None, temporal_context: None, next_cursor: None, has_more: false, ..context() };
        assert_eq!(
            keys(&bare.to_value()),
            ["page", "hasMore", "warnings", "totals", "summary", "mainPage", "directBlocks", "relatedPages", "references"]
        );
    }
}
