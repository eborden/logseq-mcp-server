//! `logseq_explore_network`: the pages
//! linked to a page as nodes and edges, in both link directions, up to `max_depth` hops, with one
//! edge per page pair and its reference count.
//!
//! Calls (Pattern 2, ADR-0011): the page resolver (1 query for an exact name, an alias or an ISO
//! date; a namespace-leaf name adds the leaf query, and a missing page adds the suggestion lookup
//! before it fails), the alias lookup (1 query, only with `max_depth` of 1 or more and a page that
//! has alias links), then one batched query per depth, each covering the whole frontier in both
//! directions: at most `max_depth` more, 2 + `max_depth` in all for a page with no aliases. The walk
//! stops early when a depth admits nothing to expand, or when LogSeq answers `null` for one (a
//! `links_unavailable` warning, BR-0011: the network is partial, not complete). When the root has
//! aliases, depth 1 expands every name of the group in one query (`connected_pages_grouped`) and the
//! group is one node.
//!
//! The rules of the walk keep a hub usable: `max_fanout` limits the new pages one page may add, the walk holds at most
//! [`MAX_NODES_LIMIT`] pages (the root included), and journal pages are leaves unless `expand_journals` is set.
//! `truncated` is set whenever a rule dropped a page, with a `network_truncated` warning (BR-0006).
//!
//! The walk is read to the end with the cursor (ADR-0038, #556). `max_nodes` is the size of a page, and the walk runs to
//! [`MAX_NODES_LIMIT`] pages whatever it is, so a page is the next `max_nodes` pages in the order the walk admitted them
//! (depth, then rank) and the edges whose later end is one of them. A page is also cut to the character budget
//! (`crate::budget`, #485), whole pages, the first of them always kept, and then carries a `nextCursor` and says so
//! with a `pages_truncated` (the count) or `result_size_truncated` (the budget) warning (BR-0006). A call with only that
//! `cursor` reads the next page: from the snapshot the first call kept, with no LogSeq call, or, when the snapshot is
//! gone, with the calls the first page made, resuming after the last page sent (`cursor_stale` says when the walk moved).
//! A raise of `max_fanout` is a different walk, not a later page, so it stays in the `network_truncated` warning beside the
//! cursor and never makes `hasMore` true.
//!
//! Roll-up pages (#498) are leaves too: a page that links more than [`HUB_LINKS`] pages (the generated weekly or
//! monthly summary pages of a graph) behaves like a journal, so it ranks after every other page when a rule bites and is
//! not walked through unless `expand_journals` is set. The same query that finds the links counts them
//! (a `degree` row per pair, no call of its own), so the rule costs no call, and the pages it kept as leaves are named in
//! a `hub_pages_not_expanded` warning. `with_snippets` adds to each edge of the root the first line of one block that
//! makes the link, cut to 80 characters, from the same call again (the block's text is one more cell of depth 1).
//!
//! `format: "markdown"` renders the same network through [`crate::markdown_context`], its warnings, `hasMore` and
//! `nextCursor` in a footer. This tool makes no tips.
//!
//! What only this tool uses is in its directory: its queries, the rows it reads, the choice of which
//! pages join, the graph it builds, the words of the cut and the pages of the walk.

mod graph;
mod pages;
mod path;
mod queries;
mod selection;
mod warning;
mod wire;

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::args::parse_args;
use crate::client::LogseqClient;
use crate::edn::PageId;
use crate::errors::{InvalidParameter, ToolError};
use crate::markdown::{FooterMeta, with_footer};
use crate::markdown_context::render_path;
use crate::meta::ResultWarning;
use crate::output_format::OutputFormat;
use crate::paging::{page_of, refuse_with_cursor, resume_at, serve};
use crate::params::{ParamAliases, resolve_param_aliases};
use crate::resolve::alias::{AliasSet, alias_set_warnings, resolve_alias_set};
use crate::resolve::{RETRY_ADVICE, require_page};
use crate::snapshots::Snapshots;
use crate::snippet::Snippet;
use crate::tool::{CursorSchema, input_schema, read_only_annotations, success_result};
use crate::tools::explore_context::resolved_from;

use self::graph::{Edge, Links, Node, Nodes, build_edges, relabel_depths};
use self::pages::{Resume, Token, View, stored_arguments};
use self::queries::{Extras, connected_pages, connected_pages_grouped};
use self::selection::{Candidate, select_candidates};
use self::warning::{HubPage, TruncationFacts, hub_pages_not_expanded, network_truncated_warning};
use self::wire::{Link, connected_rows, connected_rows_with_snippets};

pub use self::path::{MAX_FRONTIER, PathAnswer, explore_path};
pub use self::selection::HUB_LINKS;
pub use self::warning::{MAX_FANOUT_LIMIT, MAX_NODES_LIMIT};

pub const NAME: &str = "logseq_explore_network";

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Explore a page's links as nodes and edges, both directions, max_depth hops, one edge per pair with a count. With to, the shortest link path to another page.\n\n\
**Caps:** max_nodes pages per call (max 500), 15 new per page; journals, roll-ups (over 30 links) rank last. hasMore: send only cursor=nextCursor. truncated: see warnings.\n\
**Can't find:** unlinked pages, or page text (logseq_explore_context).";

/// Parameter aliases (BR-0008): not in the schema, so they cost nothing in `tools/list`.
const ALIASES: ParamAliases = &[("page", &["name", "page_name"])];

/// Depth walked when `max_depth` is absent.
pub const DEFAULT_MAX_DEPTH: u64 = 2;
/// Pages in a page, the root included, when `max_nodes` is absent.
pub const DEFAULT_MAX_NODES: u64 = 50;
/// New pages one page may add when `max_fanout` is absent.
pub const DEFAULT_MAX_FANOUT: u64 = 15;
/// The deepest the handler lets a caller walk.
pub const MAX_DEPTH_LIMIT: u64 = 3;

fn default_max_depth() -> u64 {
    DEFAULT_MAX_DEPTH
}

fn default_max_nodes() -> u64 {
    DEFAULT_MAX_NODES
}

fn default_max_fanout() -> u64 {
    DEFAULT_MAX_FANOUT
}

/// The tool's arguments, as `tools/list` shows them. The schema is generated from this type, and a
/// call parses its arguments into it (ADR-0019). Unknown fields are ignored, as in every tool (see `input_schema`)
/// ignores them. `max_nodes` and `max_fanout` start at 1, a `max_depth` of 0 returns the root alone. `page` is optional in
/// the schema because a call with a `cursor` takes no other argument (BR-0008), and a call with neither is refused by
/// [`call`].
#[derive(Debug, Deserialize, JsonSchema)]
pub struct Args {
    /// Page to start from (page name, alias or ISO date)
    pub page: Option<String>,
    /// A second page: the shortest path of links from page to it, within max_depth, instead of the network
    pub to: Option<String>,
    /// Maximum depth to traverse (default: 2, max: 3)
    #[serde(default = "default_max_depth")]
    pub max_depth: u64,
    /// Page size: most pages per call, root included (default: 50, max: 500). Not with to
    #[serde(default = "default_max_nodes")]
    #[schemars(range(min = 1))]
    pub max_nodes: u64,
    /// Maximum new pages any one page may add (default: 15, max: 100). Not with to
    #[serde(default = "default_max_fanout")]
    #[schemars(range(min = 1))]
    pub max_fanout: u64,
    /// Expand through journal pages and roll-up pages (pages that link over 30 pages) instead of treating them as leaves (default: false). They link to almost everything, so this can flood the network. Not with to
    #[serde(default)]
    pub expand_journals: bool,
    /// Add to each edge of the root the first line (80 characters) of one block that makes the link (default: false: longer results). Not with to
    #[serde(default)]
    pub with_snippets: bool,
    /// json (default), or markdown text. Markdown has block uuids only on search hits and with compact
    pub format: Option<OutputFormat>,
    // No doc comment: the shared description is the type's (`CursorSchema`), and a doc comment would replace it
    #[schemars(with = "Option<CursorSchema>")]
    pub cursor: Option<String>,
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Explore Network")
        .with_annotations(read_only_annotations("Explore Network"))
}

/// The arguments that size the walk without `to`. The path is one page after another, at most `max_depth` hops long,
/// so they have nothing to bound there.
const NETWORK_ONLY: [&str; 4] = ["max_nodes", "max_fanout", "expand_journals", "with_snippets"];

/// With `to`, the arguments of the walk without it are refused rather than ignored, in the order the schema lists them.
/// `null` counts as absent, as everywhere. They are read from the arguments as sent, since a default and a value that
/// was asked for look the same once parsed.
fn check_combination(arguments: Option<&JsonObject>) -> Result<(), ToolError> {
    for param in NETWORK_ONLY {
        let Some(value) = arguments.and_then(|arguments| arguments.get(param)).filter(|value| !value.is_null()) else { continue };
        return Err(ToolError::InvalidParameter(InvalidParameter {
            param: param.to_owned(),
            value: value.to_string(),
            expected: format!("left out when to is given: {param} sizes the network, and with to the result is one path, at most max_depth hops long"),
            example: Some("max_depth: 3".to_owned()),
        }));
    }
    Ok(())
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

/// A call: aliases folded, arguments read, then the path to `to` when it is given, else the walk (with the handler's
/// own limits on it: depth 3, 500 pages, 100 new per page, whatever the caller asks for), one page of it, as JSON or
/// Markdown. This tool makes no tips.
///
/// A call with a `cursor` takes no other argument (they are in the token, ADR-0038), and is refused as such on the
/// arguments after the aliases are folded, so `{ cursor, name }` is not a cursor alone (BR-0008). It reads the next page
/// of the walk the token names: from the snapshot the first call kept, or, when it is gone, from the walk made again with
/// the first page's calls, resuming after the last page sent if the one before the position is not it (a
/// `cursor_stale` warning, BR-0006). A call with neither `page` nor `cursor` is refused here, not by the schema.
pub async fn call(client: &LogseqClient, _tips_enabled: bool, snapshots: &Snapshots, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let arguments = resolve_param_aliases(ALIASES, arguments)?;
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
    let Some(page) = args.page.clone() else { return Err(needs_page()) };
    let markdown = args.format == Some(OutputFormat::Markdown);
    if let Some(to) = &args.to {
        check_combination(arguments.as_ref())?;
        let depth = args.max_depth.min(MAX_DEPTH_LIMIT);
        let answer = explore_path(client, &page, to, depth, args.max_depth).await?;
        let result = answer.to_value();
        let text = if markdown { with_footer(render_path(&result), &FooterMeta::of_result(&result, &[])) } else { result.to_string() };
        return Ok(success_result(vec![ContentBlock::text(text)]));
    }
    // The walk runs to the limit whatever the page size is, with the handler's own limits on it. The token carries the
    // arguments, so a snapshot is served only to a call that asks for the walk it was built from
    let options = Options {
        walk_limit: MAX_NODES_LIMIT as u64,
        max_fanout: args.max_fanout.min(MAX_FANOUT_LIMIT as u64),
        expand_journals: args.expand_journals,
        with_snippets: args.with_snippets,
    };
    let depth = args.max_depth.min(MAX_DEPTH_LIMIT);
    let stored = resume.as_ref().map_or_else(|| stored_arguments(&args, &page), |resume| resume.cursor.args.clone());
    let served = serve(snapshots, resume.as_ref().map(|resume| &resume.cursor.snapshot), &stored, now, || explore_network(client, &page, depth, options)).await?;
    let network = &*served.list;
    let total = network.nodes.len();
    let (start, stale) = match &resume {
        None => (0, None),
        Some(resume) => {
            // The walk is in the order it admitted pages, so a page that moved is found by its id: the pages after it are
            // the ones to send
            let resumed = resume_at(
                total,
                resume.at,
                |at| network.nodes[at].id == resume.anchor,
                || network.nodes.iter().position(|node| node.id == resume.anchor).map(|at| at + 1),
            );
            (resumed.start, resumed.stale)
        }
    };
    let page_size = args.max_nodes.min(MAX_NODES_LIMIT as u64) as usize;
    let view = View::new(network, start, page_size, stale, resume.is_none(), markdown, Some(Token { args: stored.clone(), key: served.key }));
    let cut = page_of(total, start, page_size, |kept| view.size(kept));
    // A walk that fits one page needs no snapshot, and a hit is kept already
    if cut.next().is_some() {
        served.keep(snapshots, &stored, network.weight(), now);
    }
    Ok(success_result(vec![ContentBlock::text(view.text(cut.kept, cut.cut))]))
}

/// What the network walk takes beyond the root and the depth.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Options {
    /// Hard cap on pages in the walk, root included. The handler's is [`MAX_NODES_LIMIT`], whatever `max_nodes` (the page
    /// size) is, so every page of the walk is read from one walk
    pub walk_limit: u64,
    /// Most new pages any single page may add to the network
    pub max_fanout: u64,
    /// Journal pages and roll-up pages (those that link more than [`HUB_LINKS`] pages) link to nearly everything, so
    /// by default they appear as leaf nodes but are not expanded at the next depth. Set to walk through them like any
    /// other page.
    pub expand_journals: bool,
    /// Each edge of the root carries the first line of one block that makes the link (#498)
    pub with_snippets: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { walk_limit: MAX_NODES_LIMIT as u64, max_fanout: DEFAULT_MAX_FANOUT, expand_journals: false, with_snippets: false }
    }
}

/// A concept network (`NetworkResult`): the whole walk, which a call sends a page at a time.
#[derive(Debug, Clone, PartialEq)]
pub struct Network {
    /// The name as the caller gave it
    pub page: String,
    pub resolved_from: Option<Value>,
    pub resolved_aliases: Option<Vec<String>>,
    /// The pages in the order the walk admitted them (depth, then rank), the root first
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    /// `max_fanout` or the limit of the walk dropped at least one page from the network
    pub truncated: bool,
    /// The alias group's warnings, `network_truncated` when `truncated`, `hub_pages_not_expanded` and
    /// `links_unavailable` when a depth's query got no answer, in that order. A page of the walk names the roll-ups it shows
    pub warnings: Vec<ResultWarning>,
    /// The roll-up pages the walk showed as leaves although a further depth was left, which the
    /// `hub_pages_not_expanded` warning names (#498)
    hubs: Vec<HubPage>,
    /// The pages walking through `hubs` would bring at least: 0 when it would bring none, when the walk did not get
    /// to the end, or when a journal page was left as a leaf too (`expand_journals` walks through it as well, and what
    /// it would bring is not known). The warning offers `expand_journals` only when it is more than 0
    hub_adds: usize,
    /// The first line of one block that makes each edge of the root, by the pair `(from, to)`, when `with_snippets` was
    /// asked (#498)
    snippets: HashMap<(i64, i64), String>,
    /// `with_snippets` was asked, so the words of a size cut may say how to shorten the edges
    with_snippets: bool,
}

impl Network {
    /// The network in BR-0013's key order: `page`, `resolvedFrom`, `resolvedAliases`, then `truncated`,
    /// `hasMore`, `warnings`, then `nodes` and `edges`. The whole walk as one result, with no cursor: what the library
    /// function reads. A call sends it a page at a time ([`call`]).
    pub fn to_value(&self) -> Value {
        let view = View::whole(self);
        view.result(self.nodes.len(), None)
    }

    /// What a snapshot of the walk weighs for the cache's bounds: the pages, the edges and the snippets it holds.
    fn weight(&self) -> usize {
        let nodes: usize = self.nodes.iter().map(|node| std::mem::size_of::<Node>() + node.name.len()).sum();
        let snippets: usize = self.snippets.values().map(|snippet| snippet.len() + std::mem::size_of::<(i64, i64)>() + 24).sum();
        let hubs: usize = self.hubs.iter().map(|hub| std::mem::size_of::<HubPage>() + hub.name.len()).sum();
        nodes + self.edges.len() * std::mem::size_of::<Edge>() + snippets + hubs + 4096
    }
}

/// The warning for a `null` answer to the connected-pages query of one depth. No `howToFetchAll`: no
/// parameter fetches what LogSeq did not answer (like `pages_unavailable`, #64), so it adds nothing to `hasMore`,
/// and `truncated` stays as the caps left it.
fn links_unavailable(depth: i64) -> ResultWarning {
    ResultWarning::new(
        "links_unavailable",
        format!(
            "LogSeq returned no answer when looking up the pages linked at depth {depth} of the network (possibly no graph \
             open or a re-index in progress), so the walk stopped there and the network may be missing pages. \
             This does not mean those pages link to nothing. {RETRY_ADVICE}"
        ),
    )
}

/// A cap: a whole number of at least 1 (an argument is whole already).
fn cap(value: u64) -> usize {
    usize::try_from(value.max(1)).unwrap_or(usize::MAX)
}

/// The ids of a walk's frontier, as ids a query can embed.
fn page_ids(ids: &[i64]) -> Result<Vec<PageId>, ToolError> {
    ids.iter().map(|&id| PageId::new(id).map_err(ToolError::from)).collect()
}

/// The network of pages linked to a concept, by batched Datalog queries.
///
/// One query for the root plus one per depth level (at most `max_depth` + 1 calls), each covering
/// the whole BFS frontier in both link directions.
///
/// Aliases (#69): the root and the pages it is an alias of, or that alias it, are one concept, so
/// they are one node. Their links are unioned (a block that links two of those names counts once),
/// links among them are dropped, and `resolvedAliases` lists the names. This costs one query before
/// the walk and only when the root has an alias.
///
/// Caps keep hub pages usable. When they bite, survivors are picked deterministically: non-journal
/// pages first, then more references to the frontier, then lower id. `truncated` is set if any page
/// was dropped.
///
/// `page` is a page name, an alias or an ISO date (`2025-01-01`) of the root. Fails with
/// [`ToolError::PageNotFound`] (guidance with the closest names) if none matches and
/// [`ToolError::AmbiguousPage`] (with the candidates) if several do.
pub async fn explore_network(client: &LogseqClient, page: &str, max_depth: u64, options: Options) -> Result<Network, ToolError> {
    let walk_limit = cap(options.walk_limit);
    let max_fanout = cap(options.max_fanout);
    let expand_journals = options.expand_journals;
    let with_snippets = options.with_snippets;
    let mut truncated = false;
    let mut dropped = 0usize;
    // Which rule dropped them (#132): `max_fanout` leaves a page's extra neighbours out, the walk's limit
    // leaves out what the walk can't hold.
    let mut dropped_by_fanout = 0usize;
    let mut dropped_by_budget = 0usize;
    // The first level that dropped a page: lowering max_depth below it is what narrows the walk (#132)
    let mut first_drop_depth: Option<i64> = None;
    // A journal page was admitted and expanded before any page was dropped (#132)
    let mut expanded_journal = false;
    // The depth whose connected-pages query LogSeq did not answer: the walk stopped there (BR-0011)
    let mut unavailable_at: Option<i64> = None;
    // The roll-up pages admitted as leaves with a depth left, in the order they joined (#498)
    let mut unexpanded_hubs: Vec<HubPage> = Vec::new();
    // Journal pages admitted as leaves with a depth left: `expand_journals` would walk through them too (#498)
    let mut unexpanded_journals = 0usize;
    // The text of one linking block per page the root links or is linked by: from the root's own blocks when it has
    // one, else from the page's (#498). Read at depth 1 only
    let mut outbound_snippets: HashMap<i64, String> = HashMap::new();
    let mut inbound_snippets: HashMap<i64, String> = HashMap::new();

    let mut nodes = Nodes::default();
    let mut links = Links::default();

    // Query 0: resolve the root page (exact name, alias or ISO date, in one query).
    let resolved = require_page(client, page).await?;
    let root_id = resolved.page.entity_id().filter(|id| *id != 0);
    let root_name = resolved.page.display_name();
    let Some(root_id) = root_id.filter(|_| !root_name.is_empty()) else {
        return Err(ToolError::Failed(format!("Invalid root page data for: {page}")));
    };
    nodes.insert(Node { id: root_id, name: root_name, depth: 0 });

    // The root's names (#69). Nothing is followed at depth 0, so nothing to look up.
    let alias_set: AliasSet = if max_depth >= 1 { resolve_alias_set(client, &resolved.page).await? } else { AliasSet::single(&resolved.page) };
    let member_ids: Vec<PageId> = alias_set.ids()?;
    let aliased = alias_set.has_aliases();
    // Links to any name of the root are the root's, and the grouped depth-1 query already counted them
    // across names. Later depths would overwrite that with a single name's count.
    let folded_ids: HashSet<i64> = if aliased { member_ids.iter().map(|id| id.get() as i64).collect() } else { HashSet::new() };

    // BFS: one batched query per depth level
    let mut frontier = vec![root_id];
    let mut depth = 1i64;
    while depth as u64 <= max_depth && !frontier.is_empty() {
        // At depth 1 the frontier is the root, expanded through every one of its names. Every depth also asks for how many
        // pages each connected page links (the roll-up rule, #498), and depth 1 for a block's text when it was asked
        let extras = Extras { degree: true, snippets: with_snippets && depth == 1 };
        let query = if depth == 1 && aliased {
            let root = PageId::new(root_id)?;
            let pairs: Vec<(PageId, PageId)> = member_ids.iter().map(|&id| (id, root)).collect();
            connected_pages_grouped(&pairs, extras)
        } else {
            connected_pages(&page_ids(&frontier)?, extras)
        };
        let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
        // A `null` answer is not "no connected pages" (BR-0011): the walk stops here and says so.
        let rows = if extras.snippets { connected_rows_with_snippets(&answer)? } else { connected_rows(&answer)? };
        let Some(rows) = rows else {
            unavailable_at = Some(depth);
            break;
        };

        let mut candidates: HashMap<i64, Candidate> = HashMap::new();
        // How many pages each connected page links; a page with no row links none
        let mut degrees: HashMap<i64, i64> = HashMap::new();
        for row in rows {
            // Self-loops are excluded in the query; guard anyway.
            if row.source == row.connected || folded_ids.contains(&row.connected) {
                continue;
            }
            let outbound = match row.link {
                Link::Degree => {
                    degrees.insert(row.connected, row.count);
                    continue;
                }
                Link::Outbound => true,
                Link::Inbound => false,
            };
            // The same links are reported from both sides when two frontier pages link to each other,
            // so set (never add) the directed count.
            if outbound {
                links.set(row.source, row.connected, row.count);
            } else {
                links.set(row.connected, row.source, row.count);
            }
            if let Some(text) = row.snippet.as_deref().filter(|text| !text.is_empty()) {
                let snippets = if outbound { &mut outbound_snippets } else { &mut inbound_snippets };
                snippets.insert(row.connected, Snippet::of(Some(text)).as_str().to_owned());
            }
            if nodes.contains(row.connected) {
                continue;
            }
            let candidate = candidates.entry(row.connected).or_insert_with(|| Candidate {
                id: row.connected,
                name: if row.original_name.is_empty() { row.name.clone() } else { row.original_name.clone() },
                is_journal: row.is_journal,
                links: 0,
                by_source: HashMap::new(),
                total: 0,
            });
            *candidate.by_source.entry(row.source).or_insert(0) += row.count;
            candidate.total += row.count;
        }
        for candidate in candidates.values_mut() {
            candidate.links = degrees.get(&candidate.id).copied().unwrap_or(0);
        }

        let budget = walk_limit as i64 - nodes.len() as i64;
        let selection = select_candidates(&candidates, &frontier, max_fanout, budget);
        if selection.admitted.len() < candidates.len() {
            truncated = true;
            first_drop_depth.get_or_insert(depth);
            dropped += candidates.len() - selection.admitted.len();
            dropped_by_fanout += selection.dropped_by_fanout;
            dropped_by_budget += selection.dropped_by_budget;
        }

        let mut next_frontier = Vec::new();
        for candidate in &selection.admitted {
            nodes.insert(Node { id: candidate.id, name: candidate.name.clone(), depth });
            // A roll-up is a leaf like a journal: walked through only with `expand_journals`
            let leaf = candidate.is_journal || candidate.is_hub();
            if expand_journals || !leaf {
                next_frontier.push(candidate.id);
                if leaf && (depth as u64) < max_depth && !truncated {
                    expanded_journal = true;
                }
            } else if (depth as u64) < max_depth {
                if candidate.is_hub() {
                    unexpanded_hubs.push(HubPage { id: candidate.id, name: candidate.name.clone(), links: candidate.links });
                } else {
                    unexpanded_journals += 1;
                }
            }
        }
        frontier = next_frontier;
        depth += 1;
    }

    relabel_depths(&mut nodes, root_id, &links);
    let edges = build_edges(&nodes, &links);
    let kept = nodes.len();
    // Alongside `truncated`, which stays as is. `dropped` counts only the pages seen at the depths
    // that were walked, so it is a lower bound.
    let mut warnings = alias_set_warnings(&[&alias_set]);
    let cap_facts = truncated.then(|| TruncationFacts {
        kept,
        dropped,
        dropped_by_fanout,
        dropped_by_budget,
        walk_limit,
        max_fanout,
        first_drop_depth: first_drop_depth.expect("a truncated walk has a first drop"),
        expand_journals,
        expanded_journal,
    });
    warnings.extend(cap_facts.map(network_truncated_warning));
    // Walking through a roll-up brings pages when it links more of them than the network holds (the network holds `kept`
    // pages, the roll-up one of them), a page not yet in it is admitted unless the walk is full, and a page that
    // was left out by `max_fanout` of another page has a slot of its own under the roll-up. Each roll-up brings at most
    // `max_fanout`, so a roll-up alone brings at least that many (the most of the roll-ups, each judged alone). The walk must
    // also have reached its end, or the depth that would expand them never ran. `expand_journals` walks through the journal
    // leaves too, and what those bring is not known, so with one left no offer is made. The offer is not measured against
    // the character budget: a larger walk is read in pages with the cursor.
    let room = walk_limit.saturating_sub(kept);
    let covered = unavailable_at.is_none() && unexpanded_journals == 0;
    let at_least = |hub: &HubPage| usize::try_from(hub.links).unwrap_or(0).saturating_sub(kept - 1).min(max_fanout).min(room);
    let hub_adds = if covered { unexpanded_hubs.iter().map(at_least).max().unwrap_or(0) } else { 0 };
    if !unexpanded_hubs.is_empty() {
        warnings.push(hub_pages_not_expanded(&unexpanded_hubs, (hub_adds > 0).then_some(hub_adds)));
    }
    if let Some(depth) = unavailable_at {
        warnings.push(links_unavailable(depth));
    }
    // Only the edges of the root have a snippet: from the root's own blocks, else the other page's
    let snippets: HashMap<(i64, i64), String> = nodes_of_root_edges(&edges, root_id)
        .filter_map(|to| Some(((root_id, to), outbound_snippets.get(&to).or_else(|| inbound_snippets.get(&to))?.clone())))
        .collect();

    Ok(Network {
        page: page.to_owned(),
        resolved_from: resolved_from(page, &resolved),
        resolved_aliases: alias_set.resolved_aliases(),
        nodes: nodes.into_vec(),
        edges,
        truncated,
        warnings,
        hubs: unexpanded_hubs,
        hub_adds,
        snippets,
        with_snippets,
    })
}

/// The page at the other end of each edge that starts at the root.
fn nodes_of_root_edges(edges: &[Edge], root: i64) -> impl Iterator<Item = i64> + '_ {
    edges.iter().filter(move |edge| edge.from == root).map(|edge| edge.to)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor::{Anchor, Cursor, Position, SnapshotKey, decode, encode};
    use crate::tool::testing::{keys, meaning, schema_of};
    use serde_json::{Map, json};

    fn args(value: Value) -> Option<JsonObject> {
        value.as_object().cloned()
    }

    #[test]
    fn the_network_schema_means_what_the_pinned_one_means() {
        // `inputSchema` of logseq_explore_network in the ADR-0016 snapshot
        let pinned = json!({
            "type": "object",
            "properties": {
                "page": {"type": "string", "description": "Page to start from (page name, alias or ISO date)"},
                "to": {"type": "string", "description": "A second page: the shortest path of links from page to it, within max_depth, instead of the network"},
                "max_depth": {"type": "integer", "minimum": 0, "default": 2, "description": "Maximum depth to traverse (default: 2, max: 3)"},
                "max_nodes": {"type": "integer", "minimum": 1, "default": 50, "description": "Page size: most pages per call, root included (default: 50, max: 500). Not with to"},
                "max_fanout": {"type": "integer", "minimum": 1, "default": 15, "description": "Maximum new pages any one page may add (default: 15, max: 100). Not with to"},
                "expand_journals": {"type": "boolean", "default": false, "description": "Expand through journal pages and roll-up pages (pages that link over 30 pages) instead of treating them as leaves (default: false). They link to almost everything, so this can flood the network. Not with to"},
                "with_snippets": {"type": "boolean", "default": false, "description": "Add to each edge of the root the first line (80 characters) of one block that makes the link (default: false: longer results). Not with to"},
                "format": {"type": "string", "enum": ["json", "markdown"], "description": "json (default), or markdown text. Markdown has block uuids only on search hits and with compact"},
                "cursor": {"type": "string", "description": crate::tool::CURSOR_DESCRIPTION},
            },
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&pinned));
    }

    #[test]
    fn the_tool_is_read_only_and_titled_as_pinned() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Explore Network"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Explore Network", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
        assert!(tool.description.as_deref().unwrap().contains("**Can't find:**"));
    }

    fn parse(arguments: Option<&JsonObject>) -> Result<Args, crate::errors::InvalidParameter> {
        parse_args::<Args>(arguments)
    }

    #[test]
    fn every_argument_takes_what_it_says_and_nothing_else() {
        use crate::args::testing::{Takes, sweep};
        let base = json!({"page": "Atlas"});
        sweep::<Args>(json!({}), "page", Takes::Text, false);
        sweep::<Args>(base.clone(), "to", Takes::Text, false);
        sweep::<Args>(base.clone(), "max_depth", Takes::Count(0), false);
        sweep::<Args>(base.clone(), "max_nodes", Takes::Count(1), false);
        sweep::<Args>(base.clone(), "max_fanout", Takes::Count(1), false);
        sweep::<Args>(base.clone(), "expand_journals", Takes::Flag, false);
        sweep::<Args>(base.clone(), "with_snippets", Takes::Flag, false);
        sweep::<Args>(base.clone(), "format", Takes::Words(&["json", "markdown"]), false);
        sweep::<Args>(base, "cursor", Takes::Text, false);
    }

    #[test]
    fn the_arguments_are_read_in_schema_order_and_the_aliases_are_folded() {
        let folded = resolve_param_aliases(ALIASES, args(json!({"page_name": "Atlas", "max_depth": 3, "expand_journals": true}))).unwrap();
        let parsed = parse(folded.as_ref()).unwrap();
        assert_eq!(parsed.page.as_deref(), Some("Atlas"));
        assert_eq!((parsed.max_depth, parsed.max_nodes, parsed.max_fanout), (3, 50, 15));
        assert!(parsed.expand_journals && !parsed.with_snippets);
        let parsed = parse(args(json!({"page": "a", "format": "markdown"})).as_ref()).unwrap();
        assert_eq!((parsed.max_depth, parsed.format), (2, Some(OutputFormat::Markdown)));
        let error = parse(args(json!({"page": "a", "max_depth": -1, "max_nodes": 0})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'max_depth': -1"), "{error}");
    }

    #[test]
    fn a_call_with_neither_a_page_nor_a_cursor_is_refused_with_the_missing_page_named() {
        assert_eq!(needs_page().to_string(), "Invalid parameter 'page': missing\n\nExpected: a string (required unless cursor is given)\nExample: page: \"...\"");
        // the schema does not refuse it: it is the handler's refusal, so a cursor can stand alone
        assert!(parse(args(json!({})).as_ref()).unwrap().page.is_none());
    }

    #[test]
    fn a_cursor_with_an_alias_of_the_page_is_not_a_cursor_alone() {
        // BR-0008: the aliases are folded first, so `{ cursor, name }` is `{ cursor, page }` and the page can't change
        for alias in ["name", "page_name"] {
            let sent = args(json!({"cursor": "abc", alias: "Atlas"}));
            let folded = resolve_param_aliases(ALIASES, sent).unwrap();
            let error = refuse_with_cursor::<Args>(folded.as_ref()).unwrap_err();
            assert_eq!((error.param.as_str(), error.value.as_str()), ("page", "\"Atlas\""), "{alias}");
        }
        let alone = resolve_param_aliases(ALIASES, args(json!({"cursor": "abc"}))).unwrap();
        assert!(refuse_with_cursor::<Args>(alone.as_ref()).is_ok());
        // so is any other argument of the tool
        for (param, value) in [("to", json!("b")), ("max_depth", json!(3)), ("max_nodes", json!(10)), ("max_fanout", json!(5)), ("expand_journals", json!(true)), ("with_snippets", json!(true)), ("format", json!("markdown"))] {
            let error = refuse_with_cursor::<Args>(args(json!({"cursor": "abc", param: value})).as_ref()).unwrap_err();
            assert_eq!(error.param, param);
        }
    }

    #[test]
    fn a_second_page_is_a_path_and_null_is_none() {
        let parsed = parse(args(json!({"page": "a", "to": "b", "max_depth": 3})).as_ref()).unwrap();
        assert_eq!((parsed.to.as_deref(), parsed.max_depth), (Some("b"), 3));
        assert_eq!(parse(args(json!({"page": "a", "to": null})).as_ref()).unwrap().to, None);
        assert_eq!(parse(args(json!({"page": "a"})).as_ref()).unwrap().to, None);
        let error = parse(args(json!({"page": "a", "to": 5, "max_depth": -1})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'to': 5"), "{error}");
    }

    #[test]
    fn the_arguments_that_size_the_network_are_refused_with_to_in_the_order_the_schema_lists_them() {
        assert!(check_combination(args(json!({"page": "a", "to": "b", "max_depth": 2, "format": "markdown"})).as_ref()).is_ok());
        // null is absent
        assert!(check_combination(args(json!({"page": "a", "to": "b", "max_nodes": null, "expand_journals": null})).as_ref()).is_ok());
        assert!(check_combination(None).is_ok());
        for (param, value) in [("max_nodes", json!(10)), ("max_fanout", json!(5)), ("expand_journals", json!(false)), ("with_snippets", json!(true))] {
            let error = check_combination(args(json!({"page": "a", "to": "b", param: value.clone()})).as_ref()).unwrap_err();
            let text = error.to_string();
            assert!(text.starts_with(&format!("Invalid parameter '{param}': {value}\n\nExpected: left out when to is given")), "{text}");
            assert!(text.ends_with("Example: max_depth: 3"), "{text}");
        }
        // the first of them in schema order is the one named
        let error = check_combination(args(json!({"expand_journals": true, "max_fanout": 5, "max_nodes": 10})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'max_nodes': 10"), "{error}");
    }

    #[test]
    fn max_nodes_and_max_fanout_start_at_one_and_max_depth_at_zero() {
        let parsed = parse(args(json!({"page": "a", "max_depth": 0, "max_nodes": 1, "max_fanout": 1})).as_ref()).unwrap();
        assert_eq!((parsed.max_depth, parsed.max_nodes, parsed.max_fanout), (0, 1, 1));
        for param in ["max_nodes", "max_fanout"] {
            let error = parse(args(json!({"page": "a", param: 0})).as_ref()).unwrap_err();
            assert!(error.to_string().starts_with(&format!("Invalid parameter '{param}': 0")), "{error}");
            assert!(error.to_string().contains("at least 1"), "{error}");
        }
    }

    fn token(arguments: Value, position: Position, anchor: Anchor) -> String {
        encode(&Cursor::new(NAME, arguments.as_object().cloned().unwrap(), position, anchor, SnapshotKey { started: 1, n: 1 }))
    }

    #[test]
    fn a_cursor_stands_for_a_walk_and_its_arguments_read_as_a_call_does() {
        let walk = json!({"page": "Atlas", "max_depth": 2, "max_nodes": 50, "max_fanout": 15});
        let (parsed, resume) = Resume::read(&token(walk.clone(), Position::Index { at: 50 }, Anchor::Id(77))).unwrap();
        assert_eq!((parsed.page.as_deref(), parsed.max_nodes, resume.at, resume.anchor), (Some("Atlas"), 50, 50, 77));
        // not this tool's, a position that is no page, an anchor that is no id, a walk with no page or with a path, a cursor inside the cursor
        let refused = [
            token(walk.clone(), Position::Sections { blocks: 1, references: 1, related: 1 }, Anchor::Id(77)),
            token(walk.clone(), Position::Index { at: 50 }, Anchor::Text("77".into())),
            token(json!({"max_depth": 2}), Position::Index { at: 50 }, Anchor::Id(77)),
            token(json!({"page": "  "}), Position::Index { at: 50 }, Anchor::Id(77)),
            token(json!({"page": "Atlas", "to": "Bob"}), Position::Index { at: 50 }, Anchor::Id(77)),
            token(json!({"page": "Atlas", "cursor": "abc"}), Position::Index { at: 50 }, Anchor::Id(77)),
            token(json!({"page": "Atlas", "max_nodes": 0}), Position::Index { at: 50 }, Anchor::Id(77)),
            token(json!({"page": "Atlas", "max_depth": "deep"}), Position::Index { at: 50 }, Anchor::Id(77)),
        ];
        for token in refused {
            let error = Resume::read(&token).err().unwrap();
            assert_eq!(error.param, "cursor", "{token}");
        }
        let other = encode(&Cursor::new("logseq_find_pages", walk.as_object().cloned().unwrap(), Position::Index { at: 1 }, Anchor::Id(1), SnapshotKey { started: 1, n: 1 }));
        assert!(Resume::read(&other).err().unwrap().expected.contains("made by another tool"));
        assert!(Resume::read("not a token!").is_err());
    }

    #[test]
    fn the_arguments_a_cursor_carries_are_the_call_that_made_it_and_read_back_to_it() {
        let parsed = parse(args(json!({"page": "Atlas", "max_depth": 9, "max_nodes": 800, "max_fanout": 400, "expand_journals": true, "with_snippets": true, "format": "markdown"})).as_ref()).unwrap();
        let stored = pages::stored_arguments(&parsed, "Atlas");
        // the limits are applied, so the same walk asked with a larger cap has one token
        assert_eq!(
            Value::Object(stored.clone()),
            json!({"page": "Atlas", "max_depth": 3, "max_nodes": 500, "max_fanout": 100, "expand_journals": true, "with_snippets": true, "format": "markdown"})
        );
        let again = parse(Some(&stored)).unwrap();
        assert_eq!(pages::stored_arguments(&again, "Atlas"), stored);
        // the defaults are stored too, so the token reads the same whatever they become
        let plain = pages::stored_arguments(&parse(args(json!({"page": "Atlas"})).as_ref()).unwrap(), "Atlas");
        assert_eq!(Value::Object(plain), json!({"page": "Atlas", "max_depth": 2, "max_nodes": 50, "max_fanout": 15}));
    }

    fn node(id: i64, name: &str, depth: i64) -> Node {
        Node { id, name: name.to_owned(), depth }
    }

    fn edge(from: i64, to: i64) -> Edge {
        Edge { from, to, outbound: 1, inbound: 0 }
    }

    /// A network of a root (id 1), neighbours 2 to `count + 1` and a page 900 behind the first one, in the order a walk admits them.
    fn star(count: usize, name_length: usize) -> Network {
        let mut nodes = vec![node(1, "Atlas", 0)];
        let mut edges = Vec::new();
        for id in 2..=count as i64 + 1 {
            nodes.push(node(id, &format!("{id:03}{}", "x".repeat(name_length)), 1));
            edges.push(edge(1, id));
        }
        nodes.push(node(900, "deep", 2));
        edges.push(edge(2, 900));
        Network {
            page: "Atlas".into(),
            resolved_from: None,
            resolved_aliases: None,
            nodes,
            edges,
            truncated: false,
            warnings: vec![],
            hubs: vec![],
            hub_adds: 0,
            snippets: HashMap::new(),
            with_snippets: false,
        }
    }

    fn page_of_star(network: &Network, start: usize, page_size: usize) -> (Value, Option<String>) {
        let token = Some(Token { args: stored_arguments(&parse(args(json!({"page": "Atlas", "max_nodes": page_size})).as_ref()).unwrap(), "Atlas"), key: SnapshotKey { started: 1, n: 1 } });
        let view = View::new(network, start, page_size, None, start == 0, false, token);
        let page = page_of(network.nodes.len(), start, page_size, |kept| view.size(kept));
        let value = view.result(page.kept, page.cut);
        let next = value.get("nextCursor").and_then(Value::as_str).map(str::to_owned);
        (value, next)
    }

    #[test]
    fn a_network_says_what_it_answered_and_whether_it_is_complete_before_its_nodes_and_edges() {
        let network = Network {
            page: "atlas".into(),
            resolved_from: Some(json!({"name": "atlas", "matchedBy": "alias", "resolvedTo": "Project Atlas"})),
            resolved_aliases: Some(vec!["Atlas".into(), "Project Atlas".into()]),
            nodes: vec![node(10, "Project Atlas", 0), node(20, "Bob", 1)],
            edges: vec![Edge { from: 10, to: 20, outbound: 2, inbound: 1 }],
            truncated: true,
            warnings: vec![ResultWarning { code: "w".into(), message: "m".into(), how_to_fetch_all: Some("h".into()) }],
            hubs: vec![],
            hub_adds: 0,
            snippets: HashMap::new(),
            with_snippets: false,
        };
        // a raise offered in a warning does not make `hasMore` true: only a cursor does
        assert_eq!(
            network.to_value().to_string(),
            concat!(
                r#"{"page":"atlas","resolvedFrom":{"name":"atlas","matchedBy":"alias","resolvedTo":"Project Atlas"},"#,
                r#""resolvedAliases":["Atlas","Project Atlas"],"#,
                r#""truncated":true,"hasMore":false,"warnings":[{"code":"w","message":"m","howToFetchAll":"h"}],"#,
                r#""nodes":[{"id":10,"name":"Project Atlas","depth":0},{"id":20,"name":"Bob","depth":1}],"#,
                r#""edges":[{"from":10,"to":20,"type":"reference","count":3,"outbound":2,"inbound":1}]}"#
            )
        );
    }

    #[test]
    fn the_order_of_a_network_does_not_depend_on_which_optional_keys_are_there() {
        let network = Network { resolved_from: Some(json!({"name": "atlas"})), resolved_aliases: Some(vec!["Atlas".into()]), ..star(2, 3) };
        assert_eq!(keys(&network.to_value()), ["page", "resolvedFrom", "resolvedAliases", "truncated", "hasMore", "warnings", "nodes", "edges"]);
        let bare = Network { resolved_from: None, resolved_aliases: None, ..network.clone() };
        assert_eq!(keys(&bare.to_value()), ["page", "truncated", "hasMore", "warnings", "nodes", "edges"]);
        // a page with a cursor has it right after `hasMore` (BR-0013)
        let (page, next) = page_of_star(&network, 0, 2);
        assert!(next.is_some());
        assert_eq!(keys(&page), ["page", "resolvedFrom", "resolvedAliases", "truncated", "hasMore", "nextCursor", "warnings", "nodes", "edges"]);
    }

    #[test]
    fn a_links_unavailable_warning_names_the_depth_and_offers_nothing_to_fetch() {
        let warning = links_unavailable(2);
        assert_eq!(warning.code, "links_unavailable");
        assert!(warning.message.contains("depth 2 of the network"), "{}", warning.message);
        assert!(warning.message.contains("the walk stopped there"), "{}", warning.message);
        assert!(warning.message.ends_with(RETRY_ADVICE), "{}", warning.message);
        assert!(warning.how_to_fetch_all.is_none());
        let network = Network { warnings: vec![warning], ..star(1, 3) };
        assert_eq!(network.to_value()["hasMore"], false);
        assert_eq!(network.to_value()["truncated"], false);
    }

    #[test]
    fn a_page_is_a_slice_of_the_walk_and_carries_the_edges_whose_later_end_it_holds() {
        // the root, 5 neighbours, and the deep page behind the first neighbour (7 pages), 3 to a page
        let network = star(5, 3);
        let ids = |page: &Value| page["nodes"].as_array().unwrap().iter().map(|node| node["id"].as_i64().unwrap()).collect::<Vec<_>>();
        let edges = |page: &Value| page["edges"].as_array().unwrap().iter().map(|edge| (edge["from"].as_i64().unwrap(), edge["to"].as_i64().unwrap())).collect::<Vec<_>>();
        let (first, next) = page_of_star(&network, 0, 3);
        assert_eq!((ids(&first), edges(&first)), (vec![1, 2, 3], vec![(1, 2), (1, 3)]));
        assert_eq!((first["hasMore"].clone(), first["warnings"][0]["code"].clone()), (json!(true), json!("pages_truncated")));
        // the cursor names the last page sent and the index of the next one
        let cursor = decode(&next.unwrap(), NAME).unwrap();
        assert_eq!((cursor.position, cursor.anchor), (Position::Index { at: 3 }, Anchor::Id(3)));
        let (second, next) = page_of_star(&network, 3, 3);
        assert_eq!((ids(&second), edges(&second)), (vec![4, 5, 6], vec![(1, 4), (1, 5), (1, 6)]));
        // the last page: the edge from page 2 (sent on the first page) to the deep page arrives with the deep page
        let (last, none) = page_of_star(&network, 6, 3);
        assert_eq!((ids(&last), edges(&last)), (vec![900], vec![(2, 900)]));
        assert_eq!(last["hasMore"], false);
        assert!(none.is_none() && last.get("nextCursor").is_none());
        assert!(next.is_some());
    }

    #[test]
    fn every_edge_is_sent_once_and_every_page_once_over_the_pages_of_a_walk() {
        let network = star(40, 3);
        let mut start = 0;
        let (mut seen, mut sent) = (Vec::new(), Vec::new());
        loop {
            let (page, next) = page_of_star(&network, start, 7);
            seen.extend(page["nodes"].as_array().unwrap().iter().map(|node| node["id"].as_i64().unwrap()));
            sent.extend(page["edges"].as_array().unwrap().iter().map(|edge| (edge["from"].as_i64().unwrap(), edge["to"].as_i64().unwrap())));
            let Some(next) = next else { break };
            start = match decode(&next, NAME).unwrap().position {
                Position::Index { at } => at,
                other => panic!("{other:?}"),
            };
        }
        assert_eq!(seen, network.nodes.iter().map(|node| node.id).collect::<Vec<_>>());
        let mut wanted: Vec<(i64, i64)> = network.edges.iter().map(|edge| (edge.from, edge.to)).collect();
        wanted.sort_unstable();
        sent.sort_unstable();
        assert_eq!(sent, wanted);
    }

    #[test]
    fn a_walk_exactly_at_the_page_size_is_one_page_with_no_cursor_and_one_over_it_has_a_second() {
        let network = star(4, 3);
        // 6 pages
        let (whole, next) = page_of_star(&network, 0, 6);
        assert_eq!((whole["nodes"].as_array().unwrap().len(), whole["hasMore"].clone(), next), (6, json!(false), None));
        assert_eq!(whole["warnings"], json!([]));
        let (first, next) = page_of_star(&network, 0, 5);
        assert_eq!(first["nodes"].as_array().unwrap().len(), 5);
        assert!(next.is_some());
        assert!(first["warnings"][0]["message"].as_str().unwrap().starts_with("Showing 1-5 of 6 pages."), "{}", first["warnings"][0]["message"]);
    }

    #[test]
    fn a_first_page_offers_a_larger_page_beside_the_cursor_and_a_later_page_does_not() {
        let network = star(98, 3);
        let (first, _) = page_of_star(&network, 0, 50);
        let how = first["warnings"][0]["howToFetchAll"].as_str().unwrap();
        assert!(how.starts_with("Pass nextCursor as cursor, with no other argument, to read the next page. Or set max_nodes to 100 for a larger page"), "{how}");
        let (second, next) = page_of_star(&network, 50, 50);
        assert!(next.is_none());
        assert_eq!(second["warnings"], json!([]));
        let (middle, _) = page_of_star(&network, 20, 40);
        assert_eq!(middle["warnings"][0]["howToFetchAll"], json!("Pass nextCursor as cursor, with no other argument, to read the next page."));
    }

    #[test]
    fn a_walk_over_the_budget_is_cut_to_whole_pages_that_fit_and_the_cursor_reads_on() {
        let network = star(120, 300);
        let (page, next) = page_of_star(&network, 0, 500);
        let text = page.to_string();
        assert!(crate::budget::size(&text) <= crate::budget::BUDGET_CHARS, "{}", crate::budget::size(&text));
        let kept = page["nodes"].as_array().unwrap().len();
        assert!(kept > 1 && kept < 122, "{kept}");
        assert_eq!(page["warnings"][0]["code"], "result_size_truncated");
        // one more page would not have fit
        let token = Some(Token { args: Map::new(), key: SnapshotKey { started: 1, n: 1 } });
        let view = View::new(&network, 0, 500, None, true, false, token);
        assert!(view.size(kept + 1) > crate::budget::BUDGET_CHARS);
        assert!(next.is_some());
        // an edge never points at a page not sent yet
        let ids: Vec<i64> = page["nodes"].as_array().unwrap().iter().map(|node| node["id"].as_i64().unwrap()).collect();
        for edge in page["edges"].as_array().unwrap() {
            assert!(ids.contains(&edge["from"].as_i64().unwrap()) && ids.contains(&edge["to"].as_i64().unwrap()));
        }
    }

    #[test]
    fn a_page_over_the_budget_by_itself_is_returned_alone_and_the_cursor_moves_past_it() {
        let mut network = star(2, 3);
        network.nodes[1].name = "n".repeat(40_000);
        let (page, next) = page_of_star(&network, 1, 3);
        assert_eq!(page["nodes"].as_array().unwrap().len(), 1);
        assert!(page["warnings"][0]["message"].as_str().unwrap().contains("an entry is never cut inside its text"), "{}", page["warnings"][0]["message"]);
        assert_eq!(decode(&next.unwrap(), NAME).unwrap().position, Position::Index { at: 2 });
    }

    #[test]
    fn the_walks_own_warnings_ride_on_every_page_and_the_roll_ups_named_are_the_ones_on_the_page() {
        let mut network = star(6, 3);
        let hubs = vec![HubPage { id: 2, name: "Rollup A".into(), links: 41 }, HubPage { id: 6, name: "Rollup B".into(), links: 52 }];
        network.truncated = true;
        network.warnings = vec![
            ResultWarning::new("network_truncated", "walk rule".to_owned()),
            hub_pages_not_expanded(&hubs, Some(15)),
            ResultWarning::new("links_unavailable", "no answer".to_owned()),
        ];
        network.hubs = hubs;
        network.hub_adds = 15;
        let codes = |page: &Value| page["warnings"].as_array().unwrap().iter().map(|warning| warning["code"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        let (first, _) = page_of_star(&network, 0, 3);
        assert_eq!(codes(&first), ["network_truncated", "hub_pages_not_expanded", "links_unavailable", "pages_truncated"]);
        assert_eq!(first["truncated"], true);
        let named = first["warnings"][1]["message"].as_str().unwrap();
        assert!(named.starts_with("1 page links more than 30 pages") && named.contains("Rollup A") && !named.contains("Rollup B"), "{named}");
        let (second, _) = page_of_star(&network, 3, 3);
        assert_eq!(codes(&second), ["network_truncated", "hub_pages_not_expanded", "links_unavailable", "pages_truncated"]);
        let named = second["warnings"][1]["message"].as_str().unwrap();
        assert!(named.contains("Rollup B") && !named.contains("Rollup A"), "{named}");
        // a page with no roll-up on it does not name any
        let (third, _) = page_of_star(&network, 4, 1);
        assert_eq!(codes(&third), ["network_truncated", "links_unavailable", "pages_truncated"]);
    }

    #[test]
    fn the_snippets_ride_on_the_page_that_carries_the_edge_of_the_root() {
        let mut network = star(3, 3);
        network.with_snippets = true;
        network.snippets = HashMap::from([((1, 2), "Met Bob at the fair".to_owned()), ((1, 4), "Second".to_owned())]);
        let (first, _) = page_of_star(&network, 0, 2);
        assert_eq!(first["edges"].as_array().unwrap().len(), 1);
        assert_eq!(first["edges"][0].to_string(), r#"{"from":1,"to":2,"type":"reference","count":1,"outbound":1,"inbound":0,"snippet":"Met Bob at the fair"}"#);
        let (second, _) = page_of_star(&network, 2, 2);
        assert_eq!(second["edges"][1]["snippet"], "Second");
        // an edge with none has no key, and the other keys are where they were
        assert_eq!(keys(&second["edges"][0]), ["from", "to", "type", "count", "outbound", "inbound"]);
        // a size cut says how to shorten them, and without snippets the advice is as it was
        let mut big = star(120, 300);
        big.with_snippets = true;
        let (cut, _) = page_of_star(&big, 0, 500);
        assert!(cut["warnings"][0]["message"].as_str().unwrap().contains("Leaving out with_snippets also shortens each edge."));
        let (plain, _) = page_of_star(&star(120, 300), 0, 500);
        assert!(!plain["warnings"][0]["message"].as_str().unwrap().contains("with_snippets"));
    }

    #[test]
    fn a_walk_that_fits_no_snapshot_has_no_weight_to_speak_of_and_one_that_is_large_weighs_more() {
        assert!(star(2, 3).weight() < star(400, 3).weight());
        assert!(star(400, 3).weight() < crate::snapshots::MAX_SNAPSHOT_BYTES);
    }

    #[test]
    fn a_cap_is_at_least_one() {
        assert_eq!((cap(0), cap(1), cap(50)), (1, 1, 50));
    }
}
