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
//! The caps keep a hub usable: `max_fanout` limits the new pages one page may add, `max_nodes` the
//! pages in all (the root included), and journal pages are leaves unless `expand_journals` is set.
//! `truncated` is set whenever a cap dropped a page, with a `network_truncated` warning (BR-0006).
//!
//! `format: "markdown"` renders the same network through [`crate::markdown_context`], its warnings and
//! `hasMore` in a footer. This tool makes no tips.
//!
//! What only this tool uses is in its directory: its queries, the rows it reads, the choice of which
//! pages join, the graph it builds and the words of the cut.

mod graph;
mod path;
mod queries;
mod selection;
mod warning;
mod wire;

use std::collections::{HashMap, HashSet};

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::args::parse_args;
use crate::budget::{BUDGET_CHARS, Fit, fit, size};
use crate::client::LogseqClient;
use crate::edn::PageId;
use crate::errors::{InvalidParameter, ToolError};
use crate::markdown::{FooterMeta, with_footer};
use crate::markdown_context::{render_network, render_path};
use crate::meta::ResultWarning;
use crate::output_format::OutputFormat;
use crate::params::{ParamAliases, resolve_param_aliases};
use crate::resolve::alias::{AliasSet, alias_set_warnings, resolve_alias_set};
use crate::resolve::{RETRY_ADVICE, require_page};
use crate::tool::{input_schema, read_only_annotations, result_value, success_result};
use crate::truncation::{SizeCut, size_truncation_warning};
use crate::tools::explore_context::resolved_from;

use self::graph::{Edge, EdgeOutput, Links, Node, Nodes, build_edges, relabel_depths};
use self::queries::{connected_pages, connected_pages_grouped};
use self::selection::{Candidate, select_candidates};
use self::warning::{TruncationFacts, network_truncated_then_cut_by_size, network_truncated_warning};
use self::wire::connected_rows;

pub use self::path::{MAX_FRONTIER, PathAnswer, explore_path};
pub use self::warning::{MAX_FANOUT_LIMIT, MAX_NODES_LIMIT};

pub const NAME: &str = "logseq_explore_network";

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Explore how a page connects: the pages linked to it as nodes and edges, both link directions, up to max_depth hops, one edge per page pair with a reference count. With to, the shortest link path to a second page instead.\n\n\
**Caps:** 50 pages, 15 new per page; journal pages are shown but not expanded. If truncated is true, see warnings.\n\
**Can't find:** unlinked pages, or what pages say (logseq_explore_context).";

/// Parameter aliases (BR-0008): not in the schema, so they cost nothing in `tools/list`.
const ALIASES: ParamAliases = &[("page", &["name", "page_name"])];

/// Depth walked when `max_depth` is absent.
pub const DEFAULT_MAX_DEPTH: u64 = 2;
/// Pages kept, the root included, when `max_nodes` is absent.
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
/// ignores them. `max_nodes` and `max_fanout` start at 1, a `max_depth` of 0 returns the root alone.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct Args {
    /// Page to start from (page name, alias or ISO date)
    pub page: String,
    /// A second page: the shortest path of links from page to it, within max_depth, instead of the network
    pub to: Option<String>,
    /// Maximum depth to traverse (default: 2, max: 3)
    #[serde(default = "default_max_depth")]
    pub max_depth: u64,
    /// Maximum pages in the network, root included (default: 50, max: 500). Not with to
    #[serde(default = "default_max_nodes")]
    #[schemars(range(min = 1))]
    pub max_nodes: u64,
    /// Maximum new pages any one page may add (default: 15, max: 100). Not with to
    #[serde(default = "default_max_fanout")]
    #[schemars(range(min = 1))]
    pub max_fanout: u64,
    /// Expand through journal pages instead of treating them as leaves (default: false). Journal pages link to almost everything, so this can flood the network. Not with to
    #[serde(default)]
    pub expand_journals: bool,
    /// json (default), or markdown text. Markdown has block uuids only on search hits and with compact
    pub format: Option<OutputFormat>,
}

/// What a call asked for, from the arguments parsed into [`Args`].
#[derive(Debug, PartialEq)]
struct Request {
    page: String,
    to: Option<String>,
    max_depth: u64,
    options: Options,
    format: Option<OutputFormat>,
}

impl From<Args> for Request {
    fn from(args: Args) -> Request {
        let Args { page, to, max_depth, max_nodes, max_fanout, expand_journals, format } = args;
        Request { page, to, max_depth, options: Options { max_nodes, max_fanout, expand_journals }, format }
    }
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Explore Network")
        .with_annotations(read_only_annotations("Explore Network"))
}

/// The arguments that size the walk without `to`. The path is one page after another, at most `max_depth` hops long,
/// so they have nothing to bound there.
const NETWORK_ONLY: [&str; 3] = ["max_nodes", "max_fanout", "expand_journals"];

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

/// A call: aliases folded, arguments read, then the path to `to` when it is given, else the walk (with the handler's
/// own limits on it: depth 3, 500 nodes, 100 per page, whatever the caller asks for), as JSON or Markdown. This tool
/// makes no tips.
pub async fn call(client: &LogseqClient, _tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let arguments = resolve_param_aliases(ALIASES, arguments)?;
    let request = Request::from(parse_args::<Args>(arguments.as_ref())?);
    let markdown = request.format == Some(OutputFormat::Markdown);
    if let Some(to) = &request.to {
        check_combination(arguments.as_ref())?;
        let depth = request.max_depth.min(MAX_DEPTH_LIMIT);
        let answer = explore_path(client, &request.page, to, depth, request.max_depth).await?;
        let result = answer.to_value();
        let text = if markdown { with_footer(render_path(&result), &FooterMeta::of_result(&result, &[])) } else { result.to_string() };
        return Ok(success_result(vec![ContentBlock::text(text)]));
    }
    // Safeguards: caps on the walk, whatever the caller asks for
    let options = Options {
        max_nodes: request.options.max_nodes.min(MAX_NODES_LIMIT as u64),
        max_fanout: request.options.max_fanout.min(MAX_FANOUT_LIMIT as u64),
        ..request.options
    };
    let network = explore_network(client, &request.page, request.max_depth.min(MAX_DEPTH_LIMIT), options).await?;
    // The text the call sends, which the character budget measures (#485)
    let render = |network: &Network| -> String {
        let result = network.to_value();
        if markdown { with_footer(render_network(&result), &FooterMeta::of_result(&result, &[])) } else { result.to_string() }
    };
    let network = fit_to_budget(network, &render);
    Ok(success_result(vec![ContentBlock::text(render(&network))]))
}

/// The network cut to its `kept` pages nearest the root (the deepest go first, and the earlier admitted
/// first among equals), with the links among them, as `truncated`, and with the `result_size_truncated` warning (#485).
/// Pages keep the order they had. The root is at depth 0, so it is always kept.
fn cut_to_pages(network: &Network, kept: usize, oversize: bool) -> Network {
    let mut by_depth: Vec<usize> = (0..network.nodes.len()).collect();
    by_depth.sort_by_key(|&at| network.nodes[at].depth);
    let keep: HashSet<usize> = by_depth.into_iter().take(kept).collect();
    let nodes: Vec<Node> = network.nodes.iter().enumerate().filter(|(at, _)| keep.contains(at)).map(|(_, node)| node.clone()).collect();
    let ids: HashSet<i64> = nodes.iter().map(|node| node.id).collect();
    let edges = network.edges.iter().filter(|edge| ids.contains(&edge.from) && ids.contains(&edge.to)).cloned().collect();
    let mut warnings = network.warnings.clone();
    // The caps dropped pages and the size limit cut the rest: raising a cap would end in this cut again
    if let Some(facts) = network.cap_facts {
        replace_cap_warning(&mut warnings, network_truncated_then_cut_by_size(facts));
    }
    warnings.push(size_truncation_warning(SizeCut {
        what: "pages",
        kept,
        total: network.nodes.len(),
        oversize,
        advice: "Start from a more specific page, or lower max_depth, to see a smaller network. No parameter raises this limit.",
        how_to_fetch_all: None,
    }));
    Network { nodes, edges, truncated: true, warnings, ..network.clone() }
}

/// Puts `warning` where the `network_truncated` warning is, which a walk that was cut has.
fn replace_cap_warning(warnings: &mut [ResultWarning], warning: ResultWarning) {
    if let Some(at) = warnings.iter().position(|existing| existing.code == warning.code) {
        warnings[at] = warning;
    }
}

impl Network {
    /// A raise of `max_nodes` or `max_fanout` is offered only when the raised result would fit the character budget
    /// (BR-0006, #485): a call that returns the same pages cut to 30,000 characters is no way to fetch the rest. The
    /// result is measured as it stands, and the pages it holds give the size of one page, so the raised result is an
    /// estimate, from the pages that raising brings at least (the dropped ones). A result that is over the budget as it
    /// stands is cut by [`fit_to_budget`], which words the warning itself.
    fn raise_only_if_it_fits(mut self, render: &impl Fn(&Network) -> String) -> Network {
        let Some(facts) = self.cap_facts else { return self };
        if !self.warnings.iter().any(|warning| warning.code == "network_truncated" && warning.how_to_fetch_all.is_some()) {
            return self;
        }
        let whole = size(&render(&self));
        if whole > BUDGET_CHARS {
            return self;
        }
        let fits = BUDGET_CHARS * self.nodes.len() / whole.max(1);
        replace_cap_warning(&mut self.warnings, network_truncated_warning(facts, Some(fits)));
        self
    }
}

/// The network as it is when its text fits the character budget, else cut to the pages that do (#485).
fn fit_to_budget(network: Network, render: &impl Fn(&Network) -> String) -> Network {
    let network = network.raise_only_if_it_fits(render);
    let total = network.nodes.len();
    // The root is the answer, so it is the one page a cut always keeps
    let cut_size = |kept: usize| size(&render(&if kept < total { cut_to_pages(&network, kept, false) } else { network.clone() }));
    match fit(total, 1, cut_size) {
        Fit::Whole => network,
        Fit::Cut { kept, oversize } => cut_to_pages(&network, kept, oversize),
    }
}

/// What the network walk takes beyond the root and the depth.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Options {
    /// Hard cap on nodes in the result, root included
    pub max_nodes: u64,
    /// Most new pages any single page may add to the network
    pub max_fanout: u64,
    /// Journal pages link to nearly everything, so by default they appear as leaf nodes but are not
    /// expanded at the next depth. Set to walk through them like any other page.
    pub expand_journals: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { max_nodes: DEFAULT_MAX_NODES, max_fanout: DEFAULT_MAX_FANOUT, expand_journals: false }
    }
}

/// A concept network (`NetworkResult`).
#[derive(Debug, Clone, PartialEq)]
pub struct Network {
    /// The name as the caller gave it
    pub page: String,
    pub resolved_from: Option<Value>,
    pub resolved_aliases: Option<Vec<String>>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    /// `max_nodes` or `max_fanout` dropped at least one page from the network
    pub truncated: bool,
    /// `network_truncated` when `truncated`, the alias group's when it was cut or not looked up, and
    /// `links_unavailable` when a depth's query got no answer
    pub warnings: Vec<ResultWarning>,
    /// What the walk showed about the cut its caps made, which the `network_truncated` warning in `warnings` is
    /// written from, kept to write it again once the size of the result is known (#494)
    cap_facts: Option<TruncationFacts>,
}

impl Network {
    /// `hasMore`: some warning says how to fetch what it cut.
    pub fn has_more(&self) -> bool {
        self.warnings.iter().any(|warning| warning.how_to_fetch_all.is_some())
    }

    /// The network in BR-0013's key order: `page`, `resolvedFrom`, `resolvedAliases`, then `truncated`,
    /// `hasMore`, `warnings`, then `nodes` and `edges`.
    pub fn to_value(&self) -> Value {
        result_value(&NetworkOutput {
            page: &self.page,
            resolved_from: self.resolved_from.as_ref(),
            resolved_aliases: self.resolved_aliases.as_deref(),
            truncated: self.truncated,
            has_more: self.has_more(),
            warnings: &self.warnings,
            nodes: &self.nodes,
            edges: self.edges.iter().map(EdgeOutput::from).collect(),
        })
    }
}

/// A network as written, in BR-0013's order: what was answered, whether it is complete and why not, then the data.
#[derive(Serialize)]
struct NetworkOutput<'a> {
    page: &'a str,
    #[serde(rename = "resolvedFrom", skip_serializing_if = "Option::is_none")]
    resolved_from: Option<&'a Value>,
    #[serde(rename = "resolvedAliases", skip_serializing_if = "Option::is_none")]
    resolved_aliases: Option<&'a [String]>,
    truncated: bool,
    #[serde(rename = "hasMore")]
    has_more: bool,
    warnings: &'a [ResultWarning],
    nodes: &'a [Node],
    edges: Vec<EdgeOutput>,
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
    let max_nodes = cap(options.max_nodes);
    let max_fanout = cap(options.max_fanout);
    let expand_journals = options.expand_journals;
    let mut truncated = false;
    let mut dropped = 0usize;
    // Which cap dropped them (#132): `max_fanout` leaves a page's extra neighbours out, `max_nodes`
    // leaves out what the node budget can't hold.
    let mut dropped_by_fanout = 0usize;
    let mut dropped_by_budget = 0usize;
    // The first level that dropped a page: lowering max_depth below it is what narrows the walk (#132)
    let mut first_drop_depth: Option<i64> = None;
    // A journal page was admitted and expanded before any page was dropped (#132)
    let mut expanded_journal = false;
    // The depth whose connected-pages query LogSeq did not answer: the walk stopped there (BR-0011)
    let mut unavailable_at: Option<i64> = None;

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
        // At depth 1 the frontier is the root, expanded through every one of its names
        let query = if depth == 1 && aliased {
            let root = PageId::new(root_id)?;
            let pairs: Vec<(PageId, PageId)> = member_ids.iter().map(|&id| (id, root)).collect();
            connected_pages_grouped(&pairs)
        } else {
            connected_pages(&page_ids(&frontier)?)
        };
        let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
        // A `null` answer is not "no connected pages" (BR-0011): the walk stops here and says so.
        let Some(rows) = connected_rows(&answer)? else {
            unavailable_at = Some(depth);
            break;
        };

        let mut candidates: HashMap<i64, Candidate> = HashMap::new();
        for row in rows {
            // Self-loops are excluded in the query; guard anyway.
            if row.source == row.connected || folded_ids.contains(&row.connected) {
                continue;
            }
            // The same links are reported from both sides when two frontier pages link to each other,
            // so set (never add) the directed count.
            if row.outbound {
                links.set(row.source, row.connected, row.count);
            } else {
                links.set(row.connected, row.source, row.count);
            }
            if nodes.contains(row.connected) {
                continue;
            }
            let candidate = candidates.entry(row.connected).or_insert_with(|| Candidate {
                id: row.connected,
                name: if row.original_name.is_empty() { row.name.clone() } else { row.original_name.clone() },
                is_journal: row.is_journal,
                by_source: HashMap::new(),
                total: 0,
            });
            *candidate.by_source.entry(row.source).or_insert(0) += row.count;
            candidate.total += row.count;
        }

        let budget = max_nodes as i64 - nodes.len() as i64;
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
            if expand_journals || !candidate.is_journal {
                next_frontier.push(candidate.id);
                if candidate.is_journal && (depth as u64) < max_depth && !truncated {
                    expanded_journal = true;
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
        max_nodes,
        max_fanout,
        first_drop_depth: first_drop_depth.expect("a truncated walk has a first drop"),
        expand_journals,
        expanded_journal,
    });
    warnings.extend(cap_facts.map(|facts| network_truncated_warning(facts, None)));
    if let Some(depth) = unavailable_at {
        warnings.push(links_unavailable(depth));
    }

    Ok(Network {
        page: page.to_owned(),
        resolved_from: resolved_from(page, &resolved),
        resolved_aliases: alias_set.resolved_aliases(),
        nodes: nodes.into_vec(),
        edges,
        truncated,
        warnings,
        cap_facts,
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
    fn the_network_schema_means_what_the_pinned_one_means() {
        // `inputSchema` of logseq_explore_network in the ADR-0016 snapshot
        let pinned = json!({
            "type": "object",
            "properties": {
                "page": {"type": "string", "description": "Page to start from (page name, alias or ISO date)"},
                "to": {"type": "string", "description": "A second page: the shortest path of links from page to it, within max_depth, instead of the network"},
                "max_depth": {"type": "integer", "minimum": 0, "default": 2, "description": "Maximum depth to traverse (default: 2, max: 3)"},
                "max_nodes": {"type": "integer", "minimum": 1, "default": 50, "description": "Maximum pages in the network, root included (default: 50, max: 500). Not with to"},
                "max_fanout": {"type": "integer", "minimum": 1, "default": 15, "description": "Maximum new pages any one page may add (default: 15, max: 100). Not with to"},
                "expand_journals": {"type": "boolean", "default": false, "description": "Expand through journal pages instead of treating them as leaves (default: false). Journal pages link to almost everything, so this can flood the network. Not with to"},
                "format": {"type": "string", "enum": ["json", "markdown"], "description": "json (default), or markdown text. Markdown has block uuids only on search hits and with compact"},
            },
            "required": ["page"],
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

    fn parse_request(arguments: Option<&JsonObject>) -> Result<Request, crate::errors::InvalidParameter> {
        parse_args::<Args>(arguments).map(Request::from)
    }

    #[test]
    fn every_argument_takes_what_it_says_and_nothing_else() {
        use crate::args::testing::{Takes, sweep};
        let base = json!({"page": "Atlas"});
        sweep::<Args>(json!({}), "page", Takes::Text, true);
        sweep::<Args>(base.clone(), "to", Takes::Text, false);
        sweep::<Args>(base.clone(), "max_depth", Takes::Count(0), false);
        sweep::<Args>(base.clone(), "max_nodes", Takes::Count(1), false);
        sweep::<Args>(base.clone(), "max_fanout", Takes::Count(1), false);
        sweep::<Args>(base.clone(), "expand_journals", Takes::Flag, false);
        sweep::<Args>(base, "format", Takes::Words(&["json", "markdown"]), false);
    }

    #[test]
    fn the_arguments_are_read_in_schema_order_and_the_aliases_are_folded() {
        let folded = resolve_param_aliases(ALIASES, args(json!({"page_name": "Atlas", "max_depth": 3, "expand_journals": true}))).unwrap();
        let request = parse_request(folded.as_ref()).unwrap();
        assert_eq!(request.page, "Atlas");
        assert_eq!(request.max_depth, 3);
        assert_eq!(request.options, Options { expand_journals: true, ..Options::default() });
        let request = parse_request(args(json!({"page": "a", "format": "markdown"})).as_ref()).unwrap();
        assert_eq!((request.max_depth, request.format), (2, Some(OutputFormat::Markdown)));
        let error = parse_request(args(json!({"page": "a", "max_depth": -1, "max_nodes": 0})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'max_depth': -1"), "{error}");
        let error = parse_request(args(json!({})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'page': missing"), "{error}");
    }

    #[test]
    fn a_second_page_is_a_path_and_null_is_none() {
        let request = parse_request(args(json!({"page": "a", "to": "b", "max_depth": 3})).as_ref()).unwrap();
        assert_eq!((request.to.as_deref(), request.max_depth), (Some("b"), 3));
        assert_eq!(parse_request(args(json!({"page": "a", "to": null})).as_ref()).unwrap().to, None);
        assert_eq!(parse_request(args(json!({"page": "a"})).as_ref()).unwrap().to, None);
        // `to` is read after `page` and before the counts
        let error = parse_request(args(json!({"to": 5, "max_depth": -1})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'page': missing"), "{error}");
        let error = parse_request(args(json!({"page": "a", "to": 5, "max_depth": -1})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'to': 5"), "{error}");
    }

    #[test]
    fn the_arguments_that_size_the_network_are_refused_with_to_in_the_order_the_schema_lists_them() {
        assert!(check_combination(args(json!({"page": "a", "to": "b", "max_depth": 2, "format": "markdown"})).as_ref()).is_ok());
        // null is absent
        assert!(check_combination(args(json!({"page": "a", "to": "b", "max_nodes": null, "expand_journals": null})).as_ref()).is_ok());
        assert!(check_combination(None).is_ok());
        for (param, value) in [("max_nodes", json!(10)), ("max_fanout", json!(5)), ("expand_journals", json!(false))] {
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
        let request = parse_request(args(json!({"page": "a", "max_depth": 0, "max_nodes": 1, "max_fanout": 1})).as_ref()).unwrap();
        assert_eq!((request.max_depth, request.options.max_nodes, request.options.max_fanout), (0, 1, 1));
        for param in ["max_nodes", "max_fanout"] {
            let error = parse_request(args(json!({"page": "a", param: 0})).as_ref()).unwrap_err();
            assert!(error.to_string().starts_with(&format!("Invalid parameter '{param}': 0")), "{error}");
            assert!(error.to_string().contains("at least 1"), "{error}");
        }
    }

    #[test]
    fn a_network_says_what_it_answered_and_whether_it_is_complete_before_its_nodes_and_edges() {
        let network = Network {
            page: "atlas".into(),
            resolved_from: Some(json!({"name": "atlas", "matchedBy": "alias", "resolvedTo": "Project Atlas"})),
            resolved_aliases: Some(vec!["Atlas".into(), "Project Atlas".into()]),
            nodes: vec![Node { id: 10, name: "Project Atlas".into(), depth: 0 }, Node { id: 20, name: "Bob".into(), depth: 1 }],
            edges: vec![Edge { from: 10, to: 20, outbound: 2, inbound: 1 }],
            truncated: true,
            warnings: vec![ResultWarning { code: "w".into(), message: "m".into(), how_to_fetch_all: Some("h".into()) }],
            cap_facts: None,
        };
        assert_eq!(
            network.to_value().to_string(),
            concat!(
                r#"{"page":"atlas","resolvedFrom":{"name":"atlas","matchedBy":"alias","resolvedTo":"Project Atlas"},"#,
                r#""resolvedAliases":["Atlas","Project Atlas"],"#,
                r#""truncated":true,"hasMore":true,"warnings":[{"code":"w","message":"m","howToFetchAll":"h"}],"#,
                r#""nodes":[{"id":10,"name":"Project Atlas","depth":0},{"id":20,"name":"Bob","depth":1}],"#,
                r#""edges":[{"from":10,"to":20,"type":"reference","count":3,"outbound":2,"inbound":1}]}"#
            )
        );
    }

    #[test]
    fn the_order_of_a_network_does_not_depend_on_which_optional_keys_are_there() {
        let all = ["page", "resolvedFrom", "resolvedAliases", "truncated", "hasMore", "warnings", "nodes", "edges"];
        let network = Network {
            page: "atlas".into(),
            resolved_from: Some(json!({"name": "atlas", "matchedBy": "alias", "resolvedTo": "Project Atlas"})),
            resolved_aliases: Some(vec!["Atlas".into()]),
            nodes: vec![],
            edges: vec![],
            truncated: false,
            warnings: vec![],
            cap_facts: None,
        };
        assert_eq!(keys(&network.to_value()), all);
        let bare = Network { resolved_from: None, resolved_aliases: None, ..network };
        assert_eq!(keys(&bare.to_value()), ["page", "truncated", "hasMore", "warnings", "nodes", "edges"]);
    }

    #[test]
    fn a_links_unavailable_warning_names_the_depth_and_offers_nothing_to_fetch() {
        let warning = links_unavailable(2);
        assert_eq!(warning.code, "links_unavailable");
        assert!(warning.message.contains("depth 2 of the network"), "{}", warning.message);
        assert!(warning.message.contains("the walk stopped there"), "{}", warning.message);
        assert!(warning.message.ends_with(RETRY_ADVICE), "{}", warning.message);
        assert!(warning.how_to_fetch_all.is_none());
        // so a network that carries only it has no more to fetch
        let network = Network {
            page: "atlas".into(),
            resolved_from: None,
            resolved_aliases: None,
            nodes: vec![],
            edges: vec![],
            truncated: false,
            warnings: vec![warning],
            cap_facts: None,
        };
        assert!(!network.has_more());
        assert_eq!(network.to_value()["truncated"], false);
    }

    fn star(pages: usize, name_length: usize) -> Network {
        // a root, `pages - 1` neighbours at depth 1 and a second-level page behind the first neighbour
        let mut nodes = vec![Node { id: 1, name: "Atlas".into(), depth: 0 }];
        let mut edges = Vec::new();
        for id in 2..=pages as i64 {
            nodes.push(Node { id, name: "x".repeat(name_length), depth: 1 });
            edges.push(Edge { from: 1, to: id, outbound: 1, inbound: 0 });
        }
        nodes.insert(2, Node { id: 900, name: "deep".into(), depth: 2 });
        edges.push(Edge { from: 2, to: 900, outbound: 1, inbound: 0 });
        Network {
            page: "Atlas".into(),
            resolved_from: None,
            resolved_aliases: None,
            nodes,
            edges,
            truncated: false,
            warnings: vec![],
            cap_facts: None,
        }
    }

    #[test]
    fn a_cut_drops_the_deepest_pages_first_with_their_links_and_says_so() {
        let network = star(5, 3);
        let cut = cut_to_pages(&network, 4, false);
        // 6 pages: the root, 4 neighbours and the page behind the first one; the deep page goes first
        assert_eq!(cut.nodes.iter().map(|node| node.id).collect::<Vec<_>>(), [1, 2, 3, 4]);
        assert!(cut.edges.iter().all(|edge| edge.from != 900 && edge.to != 900));
        assert_eq!(cut.edges.len(), 3);
        assert!(cut.truncated);
        let warning = cut.warnings.last().unwrap();
        assert_eq!(warning.code, "result_size_truncated");
        assert!(warning.message.starts_with("Showing 4 of 6 pages"), "{}", warning.message);
        assert!(!cut.has_more(), "no parameter fetches the rest");
        // the key order of the result is unchanged
        assert_eq!(keys(&cut.to_value()), ["page", "truncated", "hasMore", "warnings", "nodes", "edges"]);
    }

    /// A star of `pages` pages whose caps dropped `dropped` more, with the warning the walk wrote for it
    fn capped_star(pages: usize, name_length: usize, dropped: usize) -> Network {
        let facts = TruncationFacts {
            kept: pages,
            dropped,
            dropped_by_fanout: 0,
            dropped_by_budget: dropped,
            max_nodes: pages,
            max_fanout: 15,
            first_drop_depth: 1,
            expand_journals: false,
            expanded_journal: false,
        };
        let mut network = star(pages - 1, name_length);
        network.truncated = true;
        network.warnings = vec![network_truncated_warning(facts, None)];
        network.cap_facts = Some(facts);
        network
    }

    fn json_of(network: &Network) -> String {
        network.to_value().to_string()
    }

    #[test]
    fn a_raise_is_offered_when_the_raised_network_fits_the_budget() {
        let network = capped_star(50, 20, 50);
        let fitted = fit_to_budget(network.clone(), &json_of);
        assert_eq!(fitted, network);
        assert!(fitted.warnings[0].how_to_fetch_all.as_deref().is_some_and(|raise| raise.starts_with("Set max_nodes to 100")));
        assert!(fitted.has_more());
    }

    #[test]
    fn a_raise_is_not_offered_when_the_raised_network_would_be_cut_to_the_budget() {
        // 50 pages of about 400 characters fit (20,000), the 100 that a raise would bring do not (40,000)
        let network = capped_star(50, 300, 50);
        assert!(size(&json_of(&network)) < crate::budget::BUDGET_CHARS);
        let fitted = fit_to_budget(network, &json_of);
        assert_eq!(fitted.nodes.len(), 50, "nothing is cut: the result fits as it stands");
        let warning = &fitted.warnings[0];
        assert_eq!(warning.code, "network_truncated");
        assert_eq!(warning.how_to_fetch_all, None);
        assert!(warning.message.starts_with("Kept 50 pages; at least 50 more connected pages were dropped. A larger cap would only return a result cut to the size limit"), "{}", warning.message);
        assert!(!fitted.has_more() && fitted.truncated);
    }

    #[test]
    fn a_network_cut_to_the_budget_after_the_caps_offers_no_raise_and_says_both_cuts() {
        let network = capped_star(400, 100, 20);
        assert!(size(&json_of(&network)) > crate::budget::BUDGET_CHARS);
        let fitted = fit_to_budget(network, &json_of);
        assert!(fitted.nodes.len() < 400);
        let codes: Vec<&str> = fitted.warnings.iter().map(|warning| warning.code.as_str()).collect();
        assert_eq!(codes, ["network_truncated", "result_size_truncated"]);
        assert_eq!(
            fitted.warnings[0].message,
            "At least 20 more connected pages were dropped by max_nodes or max_fanout before the result was cut to its size limit."
        );
        assert!(!fitted.has_more(), "no parameter fetches the rest");
        assert!(size(&json_of(&fitted)) <= crate::budget::BUDGET_CHARS);
    }

    #[test]
    fn a_network_that_fits_is_returned_as_it_is() {
        let network = star(5, 3);
        let render = |network: &Network| network.to_value().to_string();
        assert_eq!(fit_to_budget(network.clone(), &render), network);
    }

    #[test]
    fn a_network_over_the_budget_is_cut_to_fit_and_the_root_is_always_kept() {
        let network = star(400, 100);
        let render = |network: &Network| network.to_value().to_string();
        assert!(size(&render(&network)) > crate::budget::BUDGET_CHARS);
        let fitted = fit_to_budget(network.clone(), &render);
        assert!(size(&render(&fitted)) <= crate::budget::BUDGET_CHARS);
        assert!(fitted.nodes.len() < network.nodes.len());
        assert_eq!(fitted.nodes[0].id, 1);
        assert!(fitted.nodes.iter().all(|node| node.id != 900), "the deep page is the first to go");
        assert!(fitted.truncated);
        // one more page would not have fit
        let one_more = size(&render(&cut_to_pages(&network, fitted.nodes.len() + 1, false)));
        assert!(one_more > crate::budget::BUDGET_CHARS);
    }

    #[test]
    fn a_cap_is_at_least_one() {
        assert_eq!((cap(0), cap(1), cap(50)), (1, 1, 50));
    }
}
