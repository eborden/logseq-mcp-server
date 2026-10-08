//! `logseq_get_concept_network` (the Rust side of `src/tools/get-concept-network.ts`): the pages
//! linked to a concept as nodes and edges, in both link directions, up to `max_depth` hops, with one
//! edge per page pair and its reference count.
//!
//! Calls (Pattern 2, ADR-0011): the page resolver (1 query for an exact name, an alias or an ISO
//! date; a namespace-leaf name adds the leaf query, and a missing page adds the suggestion lookup
//! before it fails), the alias lookup (1 query, only with `max_depth` of 1 or more and a page that
//! has alias links), then one batched query per depth, each covering the whole frontier in both
//! directions: at most `max_depth` more, 2 + `max_depth` in all for a page with no aliases. The walk
//! stops early when a depth admits nothing to expand. When the root has aliases, depth 1 expands every
//! name of the group in one query (`connected_pages_grouped`) and the group is one node.
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
mod queries;
mod selection;
mod warning;
mod wire;

use std::collections::{HashMap, HashSet};

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::args::Arguments;
use crate::client::LogseqClient;
use crate::edn::PageId;
use crate::errors::ToolError;
use crate::js;
use crate::markdown::{FooterMeta, with_footer};
use crate::markdown_context::render_network;
use crate::meta::ResultWarning;
use crate::output_format::OutputFormat;
use crate::params::{ParamAliases, resolve_param_aliases};
use crate::resolve::alias::{AliasSet, alias_set_warnings, resolve_alias_set};
use crate::resolve::require_page;
use crate::tool::{input_schema, read_only_annotations, success_result};
use crate::tools::build_context::resolved_from;

use self::graph::{Edge, Links, Node, Nodes, build_edges, relabel_depths};
use self::queries::{connected_pages, connected_pages_grouped};
use self::selection::{Candidate, select_candidates};
use self::warning::{TruncationFacts, network_truncated_warning};
use self::wire::connected_rows;

pub use self::warning::{MAX_FANOUT_LIMIT, MAX_NODES_LIMIT};

pub const NAME: &str = "logseq_get_concept_network";

/// The description the TypeScript server gives the tool (`src/tool-descriptions.ts`).
const DESCRIPTION: &str = "Map pages linked to a concept as nodes and edges, in both link directions, up to max_depth hops. One edge per page pair, with a reference count.\n\n\
**Caps:** 50 pages, 15 new per page; journal pages are shown but not expanded. If truncated is true, raise max_nodes/max_fanout or set expand_journals.\n\
**Can't find:** unlinked pages, or what pages say (logseq_build_context).";

/// Parameter aliases (BR-0008): not in the schema, so they cost nothing in `tools/list`.
const ALIASES: ParamAliases = &[("concept_name", &["name", "page", "page_name"])];

/// Depth walked when `max_depth` is absent.
pub const DEFAULT_MAX_DEPTH: u64 = 2;
/// Pages kept, the root included, when `max_nodes` is absent.
pub const DEFAULT_MAX_NODES: u64 = 50;
/// New pages one page may add when `max_fanout` is absent.
pub const DEFAULT_MAX_FANOUT: u64 = 15;
/// The deepest the handler lets a caller walk.
pub const MAX_DEPTH_LIMIT: u64 = 3;

fn default_max_depth() -> u32 {
    DEFAULT_MAX_DEPTH as u32
}

fn default_max_nodes() -> u32 {
    DEFAULT_MAX_NODES as u32
}

fn default_max_fanout() -> u32 {
    DEFAULT_MAX_FANOUT as u32
}

/// The tool's arguments, as `tools/list` shows them. The schema is generated from this type
/// (ADR-0019); a call reads its arguments through [`Arguments`], which words a bad one as the
/// TypeScript server does. Unknown fields are ignored, as every TypeScript tool ignores them.
/// `max_nodes` and `max_fanout` start at 1, a `max_depth` of 0 returns the root alone.
#[derive(Debug, Deserialize, JsonSchema)]
#[allow(dead_code)]
pub struct Args {
    /// Root concept (page name, alias or ISO date)
    pub concept_name: String,
    /// Maximum depth to traverse (default: 2, max: 3)
    #[serde(default = "default_max_depth")]
    pub max_depth: u32,
    /// Maximum pages in the network, root included (default: 50, max: 500)
    #[serde(default = "default_max_nodes")]
    #[schemars(range(min = 1))]
    pub max_nodes: u32,
    /// Maximum new pages any one page may add (default: 15, max: 100)
    #[serde(default = "default_max_fanout")]
    #[schemars(range(min = 1))]
    pub max_fanout: u32,
    /// Expand through journal pages instead of treating them as leaves (default: false). Journal pages link to almost everything, so this can flood the network.
    #[serde(default)]
    pub expand_journals: bool,
    /// json (default), or markdown text. Markdown has block uuids only on search hits and with compact
    pub format: Option<OutputFormat>,
}

/// What a call asked for, read from the arguments in the order the schema lists them, so the first
/// one that is wrong is the one reported, as `parseArgs` does.
#[derive(Debug, PartialEq)]
struct Request {
    concept_name: String,
    max_depth: u64,
    options: Options,
    format: Option<OutputFormat>,
}

fn read_args(arguments: Option<&JsonObject>) -> Result<Request, ToolError> {
    let read = Arguments::new(arguments);
    let concept_name = read.required_string("concept_name")?;
    let max_depth = read.count_or("max_depth", 0, DEFAULT_MAX_DEPTH)?;
    let max_nodes = read.count_or("max_nodes", 1, DEFAULT_MAX_NODES)?;
    let max_fanout = read.count_or("max_fanout", 1, DEFAULT_MAX_FANOUT)?;
    let expand_journals = read.boolean("expand_journals", false)?;
    let format = OutputFormat::read(&read)?;
    Ok(Request { concept_name, max_depth, options: Options { max_nodes, max_fanout, expand_journals }, format })
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Get Concept Network")
        .with_annotations(read_only_annotations("Get Concept Network"))
}

/// A call: aliases folded, arguments read, the walk (with the handler's own limits on it: depth 3,
/// 500 nodes, 100 per page, whatever the caller asks for), then JSON or Markdown. This tool makes
/// no tips.
pub async fn call(client: &LogseqClient, _tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let arguments = resolve_param_aliases(ALIASES, arguments)?;
    let request = read_args(arguments.as_ref())?;
    // Safeguards: caps on the walk, whatever the caller asks for
    let options = Options {
        max_nodes: request.options.max_nodes.min(MAX_NODES_LIMIT as u64),
        max_fanout: request.options.max_fanout.min(MAX_FANOUT_LIMIT as u64),
        ..request.options
    };
    let network = get_concept_network(client, &request.concept_name, request.max_depth.min(MAX_DEPTH_LIMIT), options).await?;
    let result = network.to_value();
    if request.format == Some(OutputFormat::Markdown) {
        let body = render_network(&result);
        return Ok(success_result(vec![ContentBlock::text(with_footer(body, &FooterMeta::of_result(&result, &[])))]));
    }
    Ok(success_result(vec![ContentBlock::text(js::json_stringify(&result))]))
}

/// What `getConceptNetwork` takes beyond the root and the depth (`ConceptNetworkOptions`).
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

/// A concept network (`ConceptNetworkResult`).
#[derive(Debug, Clone, PartialEq)]
pub struct ConceptNetwork {
    /// The name as the caller gave it
    pub concept: String,
    pub resolved_from: Option<Value>,
    pub resolved_aliases: Option<Vec<String>>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    /// `max_nodes` or `max_fanout` dropped at least one page from the network
    pub truncated: bool,
    /// `network_truncated` when `truncated`, and the alias group's when it was cut
    pub warnings: Vec<ResultWarning>,
}

impl ConceptNetwork {
    /// `hasMore`: some warning says how to fetch what it cut.
    pub fn has_more(&self) -> bool {
        self.warnings.iter().any(|warning| warning.how_to_fetch_all.is_some())
    }

    /// The network as the TypeScript object is written: `concept`, `resolvedFrom`, `resolvedAliases`,
    /// `nodes`, `edges`, `truncated`, `hasMore`, `warnings`.
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("concept".into(), json!(self.concept));
        if let Some(from) = &self.resolved_from {
            out.insert("resolvedFrom".into(), from.clone());
        }
        if let Some(names) = &self.resolved_aliases {
            out.insert("resolvedAliases".into(), json!(names));
        }
        out.insert("nodes".into(), Value::Array(self.nodes.iter().map(|n| json!({"id": n.id, "name": n.name, "depth": n.depth})).collect()));
        out.insert(
            "edges".into(),
            Value::Array(
                self.edges
                    .iter()
                    .map(|e| json!({"from": e.from, "to": e.to, "type": e.kind(), "count": e.count(), "outbound": e.outbound, "inbound": e.inbound}))
                    .collect(),
            ),
        );
        out.insert("truncated".into(), json!(self.truncated));
        out.insert("hasMore".into(), json!(self.has_more()));
        out.insert("warnings".into(), serde_json::to_value(&self.warnings).expect("warnings serialize"));
        Value::Object(out)
    }
}

/// `normalizeCap`: a whole number of at least 1 (a JavaScript number is floored, and an argument is
/// whole already).
fn cap(value: u64) -> usize {
    usize::try_from(value.max(1)).unwrap_or(usize::MAX)
}

/// The ids of a walk's frontier, as ids a query can embed.
fn page_ids(ids: &[i64]) -> Result<Vec<PageId>, ToolError> {
    ids.iter().map(|&id| PageId::new(id).map_err(ToolError::from)).collect()
}

/// `getConceptNetwork`: the network of pages linked to a concept, by batched Datalog queries.
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
/// `concept_name` is a page name, an alias or an ISO date (`2025-01-01`) of the root. Fails with
/// [`ToolError::PageNotFound`] (guidance with the closest names) if none matches and
/// [`ToolError::AmbiguousPage`] (with the candidates) if several do.
pub async fn get_concept_network(client: &LogseqClient, concept_name: &str, max_depth: u64, options: Options) -> Result<ConceptNetwork, ToolError> {
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

    let mut nodes = Nodes::default();
    let mut links = Links::default();

    // Query 0: resolve the root page (exact name, alias or ISO date, in one query).
    let resolved = require_page(client, concept_name).await?;
    let root_id = resolved.page.entity_id().filter(|id| *id != 0);
    let root_name = resolved.page.display_name();
    let Some(root_id) = root_id.filter(|_| !root_name.is_empty()) else {
        return Err(ToolError::Failed(format!("Invalid root page data for: {concept_name}")));
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
        // PARITY(#299): a `null` answer is read as "no connected pages", so the network looks empty when LogSeq
        // didn't answer (suspected TS bug, BR-0011) — fix per #345, in both servers.
        let rows = connected_rows(&answer)?.unwrap_or_default();

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
    if truncated {
        warnings.push(network_truncated_warning(TruncationFacts {
            kept,
            dropped,
            dropped_by_fanout,
            dropped_by_budget,
            max_nodes,
            max_fanout,
            first_drop_depth: first_drop_depth.expect("a truncated walk has a first drop"),
            expand_journals,
            expanded_journal,
        }));
    }

    Ok(ConceptNetwork {
        concept: concept_name.to_owned(),
        resolved_from: resolved_from(concept_name, &resolved),
        resolved_aliases: alias_set.resolved_aliases(),
        nodes: nodes.into_vec(),
        edges,
        truncated,
        warnings,
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
    fn the_concept_network_schema_means_what_the_typescript_one_means() {
        // `inputSchema` of logseq_get_concept_network in the ADR-0016 snapshot
        let typescript = json!({
            "type": "object",
            "properties": {
                "concept_name": {"type": "string", "description": "Root concept (page name, alias or ISO date)"},
                "max_depth": {"type": "integer", "minimum": 0, "default": 2, "description": "Maximum depth to traverse (default: 2, max: 3)"},
                "max_nodes": {"type": "integer", "minimum": 1, "default": 50, "description": "Maximum pages in the network, root included (default: 50, max: 500)"},
                "max_fanout": {"type": "integer", "minimum": 1, "default": 15, "description": "Maximum new pages any one page may add (default: 15, max: 100)"},
                "expand_journals": {"type": "boolean", "default": false, "description": "Expand through journal pages instead of treating them as leaves (default: false). Journal pages link to almost everything, so this can flood the network."},
                "format": {"type": "string", "enum": ["json", "markdown"], "description": "json (default), or markdown text. Markdown has block uuids only on search hits and with compact"},
            },
            "required": ["concept_name"],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&typescript));
    }

    #[test]
    fn the_tool_is_read_only_and_titled_as_in_typescript() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Get Concept Network"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Get Concept Network", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
        assert!(tool.description.as_deref().unwrap().contains("**Can't find:**"));
    }

    #[test]
    fn the_arguments_are_read_in_schema_order_and_the_aliases_are_folded() {
        let folded = resolve_param_aliases(ALIASES, args(json!({"page": "Atlas", "max_depth": 3, "expand_journals": true}))).unwrap();
        let request = read_args(folded.as_ref()).unwrap();
        assert_eq!(request.concept_name, "Atlas");
        assert_eq!(request.max_depth, 3);
        assert_eq!(request.options, Options { expand_journals: true, ..Options::default() });
        let request = read_args(args(json!({"concept_name": "a", "format": "markdown"})).as_ref()).unwrap();
        assert_eq!((request.max_depth, request.format), (2, Some(OutputFormat::Markdown)));
        let error = read_args(args(json!({"concept_name": "a", "max_depth": -1, "max_nodes": 0})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'max_depth': -1"), "{error}");
        let error = read_args(args(json!({})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'concept_name': missing"), "{error}");
    }

    #[test]
    fn max_nodes_and_max_fanout_start_at_one_and_max_depth_at_zero() {
        let request = read_args(args(json!({"concept_name": "a", "max_depth": 0, "max_nodes": 1, "max_fanout": 1})).as_ref()).unwrap();
        assert_eq!((request.max_depth, request.options.max_nodes, request.options.max_fanout), (0, 1, 1));
        for param in ["max_nodes", "max_fanout"] {
            let error = read_args(args(json!({"concept_name": "a", param: 0})).as_ref()).unwrap_err();
            assert!(error.to_string().starts_with(&format!("Invalid parameter '{param}': 0")), "{error}");
            assert!(error.to_string().contains("at least 1"), "{error}");
        }
    }

    #[test]
    fn a_network_is_written_in_the_order_of_the_typescript_object() {
        let network = ConceptNetwork {
            concept: "atlas".into(),
            resolved_from: Some(json!({"name": "atlas", "matchedBy": "alias", "resolvedTo": "Project Atlas"})),
            resolved_aliases: Some(vec!["Atlas".into(), "Project Atlas".into()]),
            nodes: vec![Node { id: 10, name: "Project Atlas".into(), depth: 0 }, Node { id: 20, name: "Bob".into(), depth: 1 }],
            edges: vec![Edge { from: 10, to: 20, outbound: 2, inbound: 1 }],
            truncated: true,
            warnings: vec![ResultWarning { code: "w".into(), message: "m".into(), how_to_fetch_all: Some("h".into()) }],
        };
        assert_eq!(
            js::json_stringify(&network.to_value()),
            concat!(
                r#"{"concept":"atlas","resolvedFrom":{"name":"atlas","matchedBy":"alias","resolvedTo":"Project Atlas"},"#,
                r#""resolvedAliases":["Atlas","Project Atlas"],"#,
                r#""nodes":[{"id":10,"name":"Project Atlas","depth":0},{"id":20,"name":"Bob","depth":1}],"#,
                r#""edges":[{"from":10,"to":20,"type":"reference","count":3,"outbound":2,"inbound":1}],"#,
                r#""truncated":true,"hasMore":true,"warnings":[{"code":"w","message":"m","howToFetchAll":"h"}]}"#
            )
        );
    }

    #[test]
    fn a_cap_is_at_least_one() {
        assert_eq!((cap(0), cap(1), cap(50)), (1, 1, 50));
    }
}
