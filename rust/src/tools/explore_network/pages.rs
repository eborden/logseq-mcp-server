//! One page of the walk (ADR-0038, #556): the slice of the network that fits the page size and the character budget, the
//! edges it carries, its warnings and the cursor that reads on.
//!
//! The walk runs to `MAX_NODES_LIMIT` pages whatever `max_nodes` says, and `max_nodes` is the size of a page. The nodes are
//! in the order the walk admitted them (depth, then rank), so a page is a slice of them, and a page carries the edges whose
//! later end is one of its nodes: an edge between two pages is sent with the later of the two, so every edge a page sends
//! points at pages already sent or on the page itself, and an edge between pages of different pages is on the later
//! page. The depth labels were fixed by the walk (`relabel_depths`) before any page was cut, so a label never changes between
//! pages.
//!
//! The walk's own warnings (the alias group, `network_truncated`, `links_unavailable`) ride on every page, and the roll-up
//! warning names the roll-ups of the page it is on.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::args::parse_args;
use crate::budget::{BUDGET_CHARS, size};
use crate::cursor::{Anchor, Cursor, Position, SnapshotKey, decode, encode, invalid};
use crate::errors::InvalidParameter;
use crate::markdown::{FooterMeta, with_footer};
use crate::markdown_context::render_network;
use crate::meta::ResultWarning;
use crate::output_format::OutputFormat;
use crate::paging::{Cut, PagedCut, Stale, paged_warning, stale_warning};
use crate::tool::result_value;

use super::graph::{EdgeOutput, Node};
use super::warning::{HUB_CODE, HubPage, MAX_FANOUT_LIMIT, MAX_NODES_LIMIT, hub_pages_not_expanded};
use super::{Args, NAME, Network};

/// The code of the warning for a page cut at `max_nodes`. The walk's own rules have `network_truncated`.
const COUNT_CUT: &str = "pages_truncated";

/// What the list holds, as a warning says it.
const WHAT: &str = "pages";

/// What a cursor says about where to read on, once decoded and checked against this tool: the index of the first page of
/// the next page and the page the last page ended with. The arguments come back as [`Args`], parsed again like any other
/// (ADR-0038: nothing in a token is trusted).
pub struct Resume {
    pub cursor: Cursor,
    /// The index of the first page of the next page, in the walk as the first call read it
    pub at: usize,
    /// The id of the last page the page before sent
    pub anchor: i64,
}

impl Resume {
    pub fn read(token: &str) -> Result<(Args, Resume), InvalidParameter> {
        let cursor = decode(token, NAME)?;
        let Position::Index { at } = cursor.position else {
            return Err(invalid(token, NAME, "this is not a cursor of this tool: its position is not one page"));
        };
        let Anchor::Id(anchor) = cursor.anchor.clone() else {
            return Err(invalid(token, NAME, "this is not a cursor of this tool: its last page is not a page id"));
        };
        // The arguments the token holds are read as any call's are. A cursor holds no `to` and none of its own
        let args = parse_args::<Args>(Some(&cursor.args))
            .ok()
            .filter(|args| args.cursor.is_none() && args.to.is_none() && args.page.as_deref().is_some_and(|page| !page.trim().is_empty()));
        let args = args.ok_or_else(|| invalid(token, NAME, "its arguments are not a walk this tool makes"))?;
        Ok((args, Resume { cursor, at, anchor }))
    }
}

/// The arguments of a walk as a cursor carries them: what the call asked, with each cap as it is read (a larger one is
/// clamped, so the same walk with 800 and with 500 has one token). Read again by [`Args`].
pub fn stored_arguments(args: &Args, page: &str) -> Map<String, Value> {
    let mut stored = Map::new();
    stored.insert("page".into(), json!(page));
    stored.insert("max_depth".into(), json!(args.max_depth.min(super::MAX_DEPTH_LIMIT)));
    stored.insert("max_nodes".into(), json!(args.max_nodes.min(MAX_NODES_LIMIT as u64)));
    stored.insert("max_fanout".into(), json!(args.max_fanout.min(MAX_FANOUT_LIMIT as u64)));
    if args.expand_journals {
        stored.insert("expand_journals".into(), json!(true));
    }
    if args.with_snippets {
        stored.insert("with_snippets".into(), json!(true));
    }
    match args.format {
        Some(OutputFormat::Json) => stored.insert("format".into(), json!("json")),
        Some(OutputFormat::Markdown) => stored.insert("format".into(), json!("markdown")),
        None => None,
    };
    stored
}

/// What a cursor is made from: the arguments of the call and the snapshot its walk was kept as.
pub struct Token {
    pub args: Map<String, Value>,
    pub key: SnapshotKey,
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
    #[serde(rename = "nextCursor", skip_serializing_if = "Option::is_none")]
    next_cursor: Option<&'a str>,
    warnings: &'a [ResultWarning],
    nodes: &'a [Node],
    edges: Vec<EdgeOutput>,
}

/// One page of a walk, and everything its warnings, cursor and edges are made from.
pub struct View<'a> {
    pub network: &'a Network,
    /// The index of the first page of this page in the walk
    pub start: usize,
    /// The most pages a page holds: `max_nodes`, clamped
    pub page_size: usize,
    pub stale: Option<Stale>,
    /// Whether this is the first page, which offers the raise of the page size
    pub first_page: bool,
    pub markdown: bool,
    /// What the next page's cursor carries. None for the walk as one result, which has no snapshot to name
    pub token: Option<Token>,
    /// The place of each page in the walk
    positions: HashMap<i64, usize>,
}

impl<'a> View<'a> {
    pub fn new(network: &'a Network, start: usize, page_size: usize, stale: Option<Stale>, first_page: bool, markdown: bool, token: Option<Token>) -> View<'a> {
        let positions = network.nodes.iter().enumerate().map(|(at, node)| (node.id, at)).collect();
        View { network, start, page_size, stale, first_page, markdown, token, positions }
    }

    /// The whole walk as one result: no cursor, so no cut.
    pub fn whole(network: &'a Network) -> View<'a> {
        View::new(network, 0, network.nodes.len().max(1), None, true, false, None)
    }

    /// Pages in the walk, the root included.
    pub fn total(&self) -> usize {
        self.network.nodes.len()
    }

    /// How the page ends when it holds the first `kept` pages it could: not at all when it reaches the last page of the
    /// walk, by the page size when it holds all it could, by the budget otherwise.
    pub fn cut_at(&self, kept: usize) -> Option<Cut> {
        if self.start + kept >= self.total() {
            None
        } else if kept == self.page_size.min(self.total() - self.start) {
            Some(Cut::Count)
        } else {
            Some(Cut::Size { oversize: false })
        }
    }

    /// Whether the page, held to `kept` pages and ending as `cut` says, has a cursor to read on with.
    fn has_next(&self, kept: usize, cut: Option<Cut>) -> bool {
        cut.is_some() && kept > 0 && self.token.is_some()
    }

    /// The cursor that starts at the page after the first `kept`, which the last of them names.
    fn next_cursor(&self, kept: usize, cut: Option<Cut>) -> Option<String> {
        let token = self.token.as_ref().filter(|_| self.has_next(kept, cut))?;
        let anchor = Anchor::Id(self.network.nodes[self.start + kept - 1].id);
        Some(encode(&Cursor::new(NAME, token.args.clone(), Position::Index { at: self.start + kept }, anchor, token.key)))
    }

    /// What a reader can do about a result cut for its size. The cursor reads on, and a more specific start makes less to read.
    fn size_advice(&self) -> &'static str {
        if self.network.with_snippets {
            "Start from a more specific page, or lower max_depth, to see a smaller network. Leaving out with_snippets also shortens each edge."
        } else {
            "Start from a more specific page, or lower max_depth, to see a smaller network."
        }
    }

    /// A raise of the page size to offer beside the cursor, on the first page only (a cursor call can't change it). It is
    /// always an honest offer, since a result that is too large for the budget is cut again and carries a cursor of its own.
    fn raise(&self, cut: Cut) -> Option<String> {
        let more = self.total().min(MAX_NODES_LIMIT);
        (cut == Cut::Count && self.first_page && more > self.page_size)
            .then(|| format!("set max_nodes to {more} for a larger page (a result holds at most {BUDGET_CHARS} characters)."))
    }

    /// The warnings of the page holding the first `kept` pages: a walk that moved, what the rules of the walk left out, then
    /// the cut of the page.
    fn warnings(&self, kept: usize, cut: Option<Cut>) -> Vec<ResultWarning> {
        let mut warnings: Vec<ResultWarning> = self.stale.map(|stale| stale_warning(stale, WHAT)).into_iter().collect();
        let on_page: HashSet<i64> = self.network.nodes[self.start..self.start + kept].iter().map(|node| node.id).collect();
        for warning in &self.network.warnings {
            if warning.code != HUB_CODE {
                warnings.push(warning.clone());
                continue;
            }
            // The roll-ups this page shows are the ones to name
            let hubs: Vec<HubPage> = self.network.hubs.iter().filter(|hub| on_page.contains(&hub.id)).cloned().collect();
            if !hubs.is_empty() {
                warnings.push(hub_pages_not_expanded(&hubs, (self.network.hub_adds > 0).then_some(self.network.hub_adds)));
            }
        }
        if let Some(cut) = cut {
            warnings.push(paged_warning(PagedCut {
                count_code: COUNT_CUT,
                cut,
                what: WHAT,
                start: self.start,
                kept,
                total: self.total(),
                advice: if matches!(cut, Cut::Size { .. }) { self.size_advice() } else { "" },
                raise: self.raise(cut),
                has_next: self.has_next(kept, Some(cut)),
            }));
        }
        warnings
    }

    /// The edges whose later end is one of the first `kept` pages of this page, in the order the walk sorted them.
    fn edges(&self, kept: usize) -> Vec<EdgeOutput> {
        let page = self.start..self.start + kept;
        self.network
            .edges
            .iter()
            .filter(|edge| match (self.positions.get(&edge.from), self.positions.get(&edge.to)) {
                (Some(&from), Some(&to)) => page.contains(&from.max(to)),
                _ => false,
            })
            .map(|edge| EdgeOutput::from(edge).with_snippet(self.network.snippets.get(&(edge.from, edge.to)).map(String::as_str)))
            .collect()
    }

    /// The result holding the first `kept` pages of this page, ending as `cut` says.
    pub fn result(&self, kept: usize, cut: Option<Cut>) -> Value {
        let warnings = self.warnings(kept, cut);
        let next_cursor = self.next_cursor(kept, cut);
        result_value(&NetworkOutput {
            page: &self.network.page,
            resolved_from: self.network.resolved_from.as_ref(),
            resolved_aliases: self.network.resolved_aliases.as_deref(),
            truncated: self.network.truncated,
            has_more: next_cursor.is_some(),
            next_cursor: next_cursor.as_deref(),
            warnings: &warnings,
            nodes: &self.network.nodes[self.start..self.start + kept],
            edges: self.edges(kept),
        })
    }

    /// What the call sends for the first `kept` pages: the result as JSON, or as Markdown with its footer.
    pub fn text(&self, kept: usize, cut: Option<Cut>) -> String {
        let result = self.result(kept, cut);
        if self.markdown { with_footer(render_network(&result), &FooterMeta::of_result(&result, &[])) } else { result.to_string() }
    }

    /// The length of the text holding the first `kept` pages, as `call` would send it (what the budget measures).
    pub fn size(&self, kept: usize) -> usize {
        size(&self.text(kept, self.cut_at(kept)))
    }
}
