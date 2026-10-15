//! `logseq_explore_network` with `to`: the shortest path of links from one page to another, as nodes and edges
//! (#494, ADR-0037). It replaces the `connected-within` mode of `search_by_relationship`, which answered whether the
//! pages connect but not how.
//!
//! Calls (Pattern 2, ADR-0011): the page resolver for each page (1 query for an exact name, an alias or an ISO date;
//! the two run together, and once when both are the same name), the alias groups (1 query for both pages, none when
//! neither has an alias link), then one batched query per hop, each covering the whole frontier in both link
//! directions: at most `max_depth` of them, ending at the first hop that reaches `to`. The path is read from the rows of
//! those queries, so finding it costs no call of its own. Two names of one page make no hop query and return a
//! `same_page` warning.
//!
//! Every name of a page counts as that page (#69): the walk starts from all of the first page's names and ends at any
//! of the second's. The walk goes through journal pages like any other page, as `connected-within` did. Among paths
//! of the same length it takes, at each step, the page that is not a journal, then the one with more references
//! to the page before it, then the lower id, so the answer does not depend on the order LogSeq sends rows in.
//!
//! A `null` answer is not an empty one (BR-0011): the walk stops there with a `links_unavailable` warning and no
//! `no_path_within`, since "no path" is not known. A hop whose frontier passed [`MAX_FRONTIER`] pages expanded only
//! the lowest ids, which can hide a path, so a walk that found none says so (`frontier_truncated`), and so does one that found a path after that hop, which
//! may not be the shortest (a path found at that hop is as short as any). A path that was found is always real. A path has at most `max_depth + 1` pages (at most 4), so it needs no cut to the character
//! budget (#485).

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::{Map, Value, json};

use super::graph::{Edge, EdgeOutput, Links, Node};
use super::queries::{Extras, connected_pages, connected_pages_grouped};
use super::wire::{ConnectedRow, Link, connected_rows};
use crate::client::LogseqClient;
use crate::edn::PageId;
use crate::errors::ToolError;
use crate::js;
use crate::meta::ResultWarning;
use crate::resolve::alias::{AliasSet, alias_set_warnings, resolve_alias_sets};
use crate::resolve::{RETRY_ADVICE, ResolvedPage, require_page};
use crate::tools::explore_context::resolved_from;

use super::MAX_DEPTH_LIMIT;

/// Most pages expanded in one hop. Journal pages link to almost everything, so the frontier can grow into the
/// thousands; each hop embeds its ids in one query. The lowest ids (the oldest pages) are kept.
pub const MAX_FRONTIER: usize = 500;

/// A path found, or the reasons it was not.
#[derive(Debug, Clone, PartialEq)]
pub struct PathAnswer {
    /// The first page's name as the caller gave it
    pub page: String,
    /// The second page's name as the caller gave it
    pub to: String,
    /// `{ page, to }`, each present only for a name that was an alias, date or namespace leaf
    pub resolved_from: Option<Value>,
    /// `{ page, to }`, each present only for a page that has aliases
    pub resolved_aliases: Option<Value>,
    /// The pages of the shortest path, in order, each with its distance from the first page
    pub nodes: Vec<Node>,
    /// The links between consecutive pages of the path, each from the earlier to the later
    pub edges: Vec<Edge>,
    /// `same_page`, the alias group's warnings, and `no_path_within`, `frontier_truncated` or `links_unavailable`
    pub warnings: Vec<ResultWarning>,
}

impl PathAnswer {
    /// The number of links of the path, or `None` when there is none.
    pub fn hops(&self) -> Option<usize> {
        self.nodes.len().checked_sub(1).filter(|hops| *hops > 0)
    }

    /// `hasMore`: some warning says how to fetch what it cut.
    pub fn has_more(&self) -> bool {
        self.warnings.iter().any(|warning| warning.how_to_fetch_all.is_some())
    }

    /// The answer in BR-0013's key order: what was asked, what the names resolved to, then `hops` (only when there is a
    /// path), `hasMore` and `warnings`, then `nodes` and `edges`.
    pub fn to_value(&self) -> Value {
        crate::tool::result_value(&PathOutput {
            page: &self.page,
            to: &self.to,
            resolved_from: self.resolved_from.as_ref(),
            resolved_aliases: self.resolved_aliases.as_ref(),
            hops: self.hops(),
            has_more: self.has_more(),
            warnings: &self.warnings,
            nodes: &self.nodes,
            edges: self.edges.iter().map(EdgeOutput::from).collect(),
        })
    }
}

#[derive(Serialize)]
struct PathOutput<'a> {
    page: &'a str,
    to: &'a str,
    #[serde(rename = "resolvedFrom", skip_serializing_if = "Option::is_none")]
    resolved_from: Option<&'a Value>,
    #[serde(rename = "resolvedAliases", skip_serializing_if = "Option::is_none")]
    resolved_aliases: Option<&'a Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hops: Option<usize>,
    #[serde(rename = "hasMore")]
    has_more: bool,
    warnings: &'a [ResultWarning],
    nodes: &'a [Node],
    edges: Vec<EdgeOutput>,
}

/// How the walk got to a page: through which page, and what the row said about the page itself.
#[derive(Debug, Clone)]
struct Reached {
    parent: i64,
    name: String,
    is_journal: bool,
}

/// The state of the walk: which pages it began at, which ends it, what it has reached and the link counts it read.
struct Search {
    /// The first page, which the path begins at
    start: Node,
    /// Every name of the first page: reaching one of them again proves nothing
    seeds: HashSet<i64>,
    /// Every name of the second page that is not also a name of the first
    targets: HashSet<i64>,
    /// The page the path ends at, whichever of its names the walk reached
    end: Node,
    reached: HashMap<i64, Reached>,
    /// Directed link counts as read: `(from, to)` is the blocks on `from` that reference `to`
    links: Links,
}

/// What one hop's rows came to.
#[derive(Debug, PartialEq)]
enum Hop {
    /// A name of the second page was reached: the whole path
    Found { nodes: Vec<Node>, edges: Vec<Edge> },
    /// Not yet: the pages this hop reached, by id, which the next hop expands
    Reached(Vec<i64>),
}

impl Search {
    fn pair_weight(&self, a: i64, b: i64) -> i64 {
        self.links.get(a, b).unwrap_or(0) + self.links.get(b, a).unwrap_or(0)
    }

    fn is_journal(&self, id: i64) -> bool {
        self.reached.get(&id).is_some_and(|reached| reached.is_journal)
    }

    /// The best page to reach `to` through, among those of the frontier that link to it: not a journal, then the
    /// most references, then the lower id. A total order, so row order never decides.
    fn best_parent(&self, to: i64, parents: &HashSet<i64>) -> i64 {
        *parents
            .iter()
            .min_by_key(|&&parent| (self.is_journal(parent), -self.pair_weight(parent, to), parent))
            .expect("a reached page has a parent")
    }

    /// Reads one hop's rows. The links go to the counts, the pages not seen before are reached through their best
    /// parent, and when one of them is a name of the second page the walk is over.
    fn hop(&mut self, rows: Vec<ConnectedRow>) -> Hop {
        // the new pages of this hop, each with the frontier pages that link to it and what the row says of it
        let mut fresh: HashMap<i64, (HashSet<i64>, String, bool)> = HashMap::new();
        for row in rows {
            // Self-loops are excluded in the query; links back into the first page's names are not a way forward
            if row.source == row.connected || self.seeds.contains(&row.connected) {
                continue;
            }
            // The same links are reported from both sides when two frontier pages link to each other, so set
            // (never add) the directed count.
            match row.link {
                Link::Outbound => self.links.set(row.source, row.connected, row.count),
                Link::Inbound => self.links.set(row.connected, row.source, row.count),
                // the path asks for no degrees, and a count of pages is no link
                Link::Degree => continue,
            }
            if self.reached.contains_key(&row.connected) {
                continue;
            }
            let name = if row.original_name.is_empty() { row.name.clone() } else { row.original_name.clone() };
            let entry = fresh.entry(row.connected).or_insert_with(|| (HashSet::new(), name, row.is_journal));
            entry.0.insert(row.source);
        }

        let ends: Vec<i64> = fresh.keys().copied().filter(|id| self.targets.contains(id)).collect();
        if !ends.is_empty() {
            return self.found(&fresh, &ends);
        }

        let mut next: Vec<i64> = fresh.keys().copied().collect();
        next.sort_unstable();
        for id in &next {
            let (parents, name, is_journal) = &fresh[id];
            let parent = self.best_parent(*id, parents);
            self.reached.insert(*id, Reached { parent, name: name.clone(), is_journal: *is_journal });
        }
        Hop::Reached(next)
    }

    /// The path that ends at the best of the second page's names reached in this hop. The last edge counts every name of
    /// the second page that the chosen page links to, since they are one page.
    fn found(&self, fresh: &HashMap<i64, (HashSet<i64>, String, bool)>, ends: &[i64]) -> Hop {
        let mut parents: HashSet<i64> = HashSet::new();
        for end in ends {
            parents.extend(&fresh[end].0);
        }
        let weight = |parent: i64| -> i64 { ends.iter().filter(|end| fresh[*end].0.contains(&parent)).map(|end| self.pair_weight(parent, *end)).sum() };
        let last = *parents.iter().min_by_key(|&&parent| (self.is_journal(parent), -weight(parent), parent)).expect("an end has a parent");
        let (mut outbound, mut inbound) = (0, 0);
        for end in ends.iter().filter(|end| fresh[*end].0.contains(&last)) {
            outbound += self.links.get(last, *end).unwrap_or(0);
            inbound += self.links.get(*end, last).unwrap_or(0);
        }

        // back from the page before the end to the first page
        let mut chain = vec![last];
        while let Some(&at) = chain.last().filter(|at| **at != self.start.id) {
            chain.push(self.reached[&at].parent);
        }
        chain.reverse();

        let mut nodes: Vec<Node> = Vec::with_capacity(chain.len() + 1);
        for (depth, id) in chain.iter().enumerate() {
            let name = self.reached.get(id).map_or_else(|| self.start.name.clone(), |reached| reached.name.clone());
            nodes.push(Node { id: *id, name, depth: depth as i64 });
        }
        nodes.push(Node { depth: chain.len() as i64, ..self.end.clone() });

        let mut edges: Vec<Edge> = chain
            .windows(2)
            .map(|pair| Edge { from: pair[0], to: pair[1], outbound: self.links.get(pair[0], pair[1]).unwrap_or(0), inbound: self.links.get(pair[1], pair[0]).unwrap_or(0) })
            .collect();
        edges.push(Edge { from: last, to: self.end.id, outbound, inbound });
        Hop::Found { nodes, edges }
    }
}

/// The connection to LogSeq failed (not running, timeout, rejected token).
fn is_infrastructure(error: &ToolError) -> bool {
    matches!(error, ToolError::Logseq(error) if error.is_infrastructure())
}

/// Both pages resolved at once. The same name (ignoring case and surrounding whitespace) is resolved once. When both
/// fail, the error is deterministic: a connection, timeout or auth error first, then the first page's, then the
/// second's, whichever request happened to finish first.
async fn resolve_pages(client: &LogseqClient, page: &str, to: &str) -> Result<(ResolvedPage, ResolvedPage), ToolError> {
    if js::trim(page).to_lowercase() == js::trim(to).to_lowercase() {
        let resolved = require_page(client, page).await?;
        return Ok((resolved.clone(), resolved));
    }
    let (first, second) = tokio::join!(require_page(client, page), require_page(client, to));
    match (first, second) {
        (Ok(first), Ok(second)) => Ok((first, second)),
        (Err(first), Err(second)) => Err(if is_infrastructure(&first) || !is_infrastructure(&second) { first } else { second }),
        (Err(error), Ok(_)) | (Ok(_), Err(error)) => Err(error),
    }
}

/// A page's id and name, or the error a page without them is.
fn page_node(input: &str, resolved: &ResolvedPage) -> Result<Node, ToolError> {
    let id = resolved.page.entity_id().filter(|id| *id != 0);
    let name = resolved.page.display_name();
    match id.filter(|_| !name.is_empty()) {
        Some(id) => Ok(Node { id, name, depth: 0 }),
        None => Err(ToolError::Failed(format!("Invalid page data for: {input}"))),
    }
}

/// `{ page, to }` with the entries that exist, or `None` when neither does.
fn keyed(page: Option<Value>, to: Option<Value>) -> Option<Value> {
    if page.is_none() && to.is_none() {
        return None;
    }
    let mut keyed = Map::new();
    keyed.extend(page.map(|value| ("page".to_owned(), value)));
    keyed.extend(to.map(|value| ("to".to_owned(), value)));
    Some(Value::Object(keyed))
}

fn same_page_warning(page: &str, to: &str) -> ResultWarning {
    ResultWarning::new(
        "same_page",
        format!("\"{page}\" and \"{to}\" are names of the same page, so there is no path to find. Ask about two different pages."),
    )
}

/// A hop's frontier was cut: the pages after the first [`MAX_FRONTIER`] by id were not expanded.
fn frontier_truncated(hop: u64, reached: usize) -> ResultWarning {
    ResultWarning::new(
        "frontier_truncated",
        format!(
            "Hop {hop} expanded only {MAX_FRONTIER} of the {reached} pages reached before it, the ones with the lowest ids, \
             so \"no path\" may be a false negative. Try a smaller max_depth or more specific pages."
        ),
    )
}

/// A path was found after a hop whose frontier was cut: a page that was not expanded there could have reached `to` sooner,
/// so the path is real but a shorter one may exist (BR-0006). A path found at the cut hop itself is as short as any, and says
/// nothing. No parameter fetches the rest, so no `howToFetchAll`.
fn path_may_not_be_shortest(cut_hop: u64, reached: usize, found_at: u64) -> ResultWarning {
    ResultWarning::new(
        "frontier_truncated",
        format!(
            "Hop {cut_hop} expanded only {MAX_FRONTIER} of the {reached} pages reached before it, the ones with the lowest ids, \
             so this path of {} is real but a shorter one may exist. Start from a more specific page to be sure of the shortest.",
            hops_word(found_at)
        ),
    )
}

/// No parameter fetches what LogSeq did not answer (like `pages_unavailable`, #64), so no `howToFetchAll`.
fn links_unavailable(hop: u64) -> ResultWarning {
    ResultWarning::new(
        "links_unavailable",
        format!(
            "LogSeq returned no answer when looking up the pages linked at hop {hop} of the path (possibly no graph open or a \
             re-index in progress), so the walk stopped there and a path may have been missed. \
             This does not mean the pages are not connected. {RETRY_ADVICE}"
        ),
    )
}

/// `1 hop`, `2 hops`.
fn hops_word(hops: u64) -> String {
    format!("{hops} hop{}", if hops == 1 { "" } else { "s" })
}

/// What the walk showed about a miss, for [`no_path_within`].
struct Miss<'a> {
    page: &'a str,
    to: &'a str,
    /// Hops that were queried
    walked: u64,
    /// The depth the caller asked for, before the handler's limit
    requested: u64,
    /// The last hop reached no page that was not reached before
    ran_out: bool,
    /// A hop's frontier was cut, so pages were left unexpanded
    cut: bool,
}

/// The warning for a walk that found no path: the depth it reached and, only when a deeper walk could find more, the
/// `max_depth` that reads on (BR-0006). A walk that ran out of pages with none left unexpanded has nothing more to find.
fn no_path_within(miss: Miss<'_>) -> ResultWarning {
    let Miss { page, to, walked, requested, ran_out, cut } = miss;
    let capped = if requested > MAX_DEPTH_LIMIT { format!(" max_depth {requested} was capped at {MAX_DEPTH_LIMIT}.") } else { String::new() };
    if ran_out && !cut {
        return ResultWarning::new(
            "no_path_within",
            format!("No path from \"{page}\" to \"{to}\": every page linked within {} was reached and none is \"{to}\". A larger max_depth finds nothing more.", hops_word(walked)),
        );
    }
    let mut warning = ResultWarning::new("no_path_within", format!("No path from \"{page}\" to \"{to}\" within {}.{capped}", hops_word(walked)));
    if !ran_out && walked < MAX_DEPTH_LIMIT {
        warning.how_to_fetch_all = Some(format!("Set max_depth to {} to look one hop further (max {MAX_DEPTH_LIMIT}).", walked + 1));
    } else if !ran_out {
        warning.message.push_str(&format!(" max_depth is capped at {MAX_DEPTH_LIMIT}, so no longer path can be searched."));
    }
    warning
}

/// The shortest path of links from `page` to `to`, at most `max_depth` hops long, as nodes and edges.
///
/// `max_depth` is the walk's depth (the handler's limit already applied), and `requested_depth` the one the caller
/// asked for, which a warning names when it was capped.
///
/// Fails with [`ToolError::PageNotFound`] (guidance with the closest names) if either name matches no page, and
/// [`ToolError::AmbiguousPage`] (with the candidates) if one matches several.
pub async fn explore_path(client: &LogseqClient, page: &str, to: &str, max_depth: u64, requested_depth: u64) -> Result<PathAnswer, ToolError> {
    // Resolve both pages first (exact name, alias or ISO date: one query each), together and, when both are the same
    // name, once. A page that matches none or several fails instead of quietly returning nothing.
    let (resolved_page, resolved_to) = resolve_pages(client, page, to).await?;
    let (start, end) = (page_node(page, &resolved_page)?, page_node(to, &resolved_to)?);

    // The names each page goes by (#69): one query for both, none when neither has an alias
    let mut sets = resolve_alias_sets(client, &[&resolved_page.page, &resolved_to.page]).await?;
    let set_to = sets.remove(1);
    let set_page = sets.remove(0);
    let one_page = start.id == end.id;
    let mut warnings = alias_set_warnings(&if one_page { vec![&set_page] } else { vec![&set_page, &set_to] });

    let resolved_from_both = keyed(resolved_from(page, &resolved_page), resolved_from(to, &resolved_to));
    let aliases = |set: &AliasSet| set.resolved_aliases().map(|names| json!(names));
    let resolved_aliases = keyed(aliases(&set_page), aliases(&set_to));
    let answer = |nodes: Vec<Node>, edges: Vec<Edge>, warnings: Vec<ResultWarning>| PathAnswer {
        page: page.to_owned(),
        to: to.to_owned(),
        resolved_from: resolved_from_both.clone(),
        resolved_aliases: resolved_aliases.clone(),
        nodes,
        edges,
        warnings,
    };

    // Every name of the first page starts the walk, and any name of the second ends it
    let seeds: HashSet<i64> = set_page.members.iter().map(|member| member.id).chain([start.id]).collect();
    if seeds.contains(&end.id) {
        // Both are names of one page (the same name, or a page and its alias). A walk would "find" the page again
        // through its own links (the `alias::` block refs the alias stub), so say so instead of walking.
        warnings.push(same_page_warning(page, to));
        return Ok(answer(Vec::new(), Vec::new(), warnings));
    }
    // Names of the second page that are also names of the first end nothing: the walk starts there
    let targets: HashSet<i64> = set_to.members.iter().map(|member| member.id).chain([end.id]).filter(|id| !seeds.contains(id)).collect();
    let aliased = set_page.has_aliases();
    let member_ids: Vec<PageId> = set_page.ids()?;
    let mut search = Search { start: start.clone(), seeds, targets, end, reached: HashMap::new(), links: Links::default() };

    let mut frontier = vec![start.id];
    let mut walked = 0u64;
    let mut cut_at: Option<(u64, usize)> = None;
    let mut unavailable_at: Option<u64> = None;
    for hop in 1..=max_depth {
        if frontier.is_empty() {
            break;
        }
        if frontier.len() > MAX_FRONTIER {
            // Deterministic cut: lowest ids (oldest pages) first
            cut_at.get_or_insert((hop, frontier.len()));
            frontier.sort_unstable();
            frontier.truncate(MAX_FRONTIER);
        }
        // At hop 1 the frontier is the first page, expanded through every one of its names
        let query = if hop == 1 && aliased {
            let root = PageId::new(start.id)?;
            let pairs: Vec<(PageId, PageId)> = member_ids.iter().map(|&id| (id, root)).collect();
            connected_pages_grouped(&pairs, Extras::default())
        } else {
            connected_pages(&frontier.iter().map(|&id| PageId::new(id)).collect::<Result<Vec<_>, _>>()?, Extras::default())
        };
        let reply = client.execute_datalog_query(&query.text, &query.inputs).await?;
        // `null` is not "no linked pages" (BR-0011): the walk stops here instead of ending "no path"
        let Some(rows) = connected_rows(&reply)? else {
            unavailable_at = Some(hop);
            break;
        };
        walked = hop;
        match search.hop(rows) {
            Hop::Found { nodes, edges } => {
                // Only a path found after the cut can be longer than another (see `path_may_not_be_shortest`)
                warnings.extend(cut_at.filter(|(cut_hop, _)| hop > *cut_hop).map(|(cut_hop, reached)| path_may_not_be_shortest(cut_hop, reached, hop)));
                return Ok(answer(nodes, edges, warnings));
            }
            Hop::Reached(next) => frontier = next,
        }
    }

    warnings.extend(cut_at.map(|(hop, reached)| frontier_truncated(hop, reached)));
    match unavailable_at {
        Some(hop) => warnings.push(links_unavailable(hop)),
        None => {
            let ran_out = walked > 0 && frontier.is_empty();
            warnings.push(no_path_within(Miss { page, to, walked, requested: requested_depth, ran_out, cut: cut_at.is_some() }));
        }
    }
    Ok(answer(Vec::new(), Vec::new(), warnings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::MatchedBy;
    use crate::tool::testing::keys;

    fn row(source: i64, connected: i64, name: &str, is_journal: bool, outbound: bool, count: i64) -> ConnectedRow {
        let link = if outbound { Link::Outbound } else { Link::Inbound };
        ConnectedRow { source, connected, name: name.to_lowercase(), original_name: name.to_owned(), is_journal, link, count, snippet: None }
    }

    fn search(seeds: &[i64], targets: &[i64]) -> Search {
        let start = Node { id: seeds[0], name: "Atlas".into(), depth: 0 };
        Search {
            start,
            seeds: seeds.iter().copied().collect(),
            targets: targets.iter().copied().collect(),
            end: Node { id: targets[0], name: "Zed".into(), depth: 0 },
            reached: HashMap::new(),
            links: Links::default(),
        }
    }

    fn ids(nodes: &[Node]) -> Vec<i64> {
        nodes.iter().map(|node| node.id).collect()
    }

    #[test]
    fn a_target_in_the_first_hop_is_a_path_of_one_edge_with_its_counts() {
        let mut search = search(&[10], &[20]);
        let rows = vec![row(10, 30, "Team", false, true, 1), row(10, 20, "Zed", false, true, 2), row(10, 20, "Zed", false, false, 3)];
        let Hop::Found { nodes, edges } = search.hop(rows) else { panic!("a name of the second page was reached") };
        assert_eq!(nodes, vec![Node { id: 10, name: "Atlas".into(), depth: 0 }, Node { id: 20, name: "Zed".into(), depth: 1 }]);
        assert_eq!(edges, vec![Edge { from: 10, to: 20, outbound: 2, inbound: 3 }]);
    }

    #[test]
    fn a_path_of_two_hops_runs_through_the_page_that_linked_to_the_target() {
        let mut search = search(&[10], &[20]);
        let Hop::Reached(next) = search.hop(vec![row(10, 31, "Team Y", false, true, 1), row(10, 30, "Team X", false, true, 5)]) else { panic!("no target yet") };
        assert_eq!(next, vec![30, 31]);
        let Hop::Found { nodes, edges } = search.hop(vec![row(31, 20, "Zed", false, true, 1), row(31, 40, "Other", false, true, 1)]) else { panic!("found") };
        assert_eq!(ids(&nodes), [10, 31, 20]);
        assert_eq!(nodes.iter().map(|node| node.depth).collect::<Vec<_>>(), [0, 1, 2]);
        assert_eq!(nodes[1].name, "Team Y");
        assert_eq!(edges, vec![Edge { from: 10, to: 31, outbound: 1, inbound: 0 }, Edge { from: 31, to: 20, outbound: 1, inbound: 0 }]);
    }

    #[test]
    fn among_pages_that_reach_the_target_the_one_that_is_no_journal_wins_then_more_references_then_the_lower_id() {
        let walk = |first: Vec<ConnectedRow>, last: Vec<ConnectedRow>| {
            let mut search = search(&[10], &[20]);
            search.hop(first);
            let Hop::Found { nodes, .. } = search.hop(last) else { panic!("found") };
            nodes[1].id
        };
        let first = || vec![row(10, 30, "Jan 1st, 2025", true, true, 1), row(10, 31, "Team X", false, true, 1), row(10, 32, "Team Y", false, true, 1)];
        let last = |counts: [i64; 3]| vec![row(30, 20, "Zed", false, true, counts[0]), row(31, 20, "Zed", false, true, counts[1]), row(32, 20, "Zed", false, true, counts[2])];
        // the journal links the most and loses to a page that is not one; of the other two, the more linked wins
        assert_eq!(walk(first(), last([9, 1, 4])), 32);
        // equal references: the lower id wins
        assert_eq!(walk(first(), last([9, 2, 2])), 31);
        // and the answer does not depend on the order of the rows
        let mut reversed = last([9, 1, 4]);
        reversed.reverse();
        assert_eq!(walk(first(), reversed), 32);
    }

    #[test]
    fn a_link_back_to_a_name_of_the_first_page_or_to_a_page_reached_is_no_new_page() {
        let mut search = search(&[10, 11], &[20]);
        let Hop::Reached(next) = search.hop(vec![row(10, 11, "Project Atlas", false, true, 1), row(10, 30, "Team X", false, true, 1)]) else { panic!("no target yet") };
        assert_eq!(next, vec![30]);
        // 30 links back to the first page and to a page reached already: nothing is new
        let Hop::Reached(next) = search.hop(vec![row(30, 10, "Atlas", false, true, 1), row(30, 30, "Team X", false, true, 1)]) else { panic!("no target yet") };
        assert!(next.is_empty());
    }

    #[test]
    fn every_name_of_the_second_page_ends_the_walk_and_the_last_edge_counts_them_together() {
        // pages 20 and 21 are names of one page, and the page before them links to both
        let mut search = search(&[10], &[20, 21]);
        let Hop::Found { nodes, edges } = search.hop(vec![
            row(10, 20, "Zed", false, true, 2),
            row(10, 21, "Zed Alias", false, true, 3),
            row(10, 21, "Zed Alias", false, false, 1),
        ]) else {
            panic!("found")
        };
        // the node is the second page itself, whichever of its names the walk reached
        assert_eq!(nodes[1], Node { id: 20, name: "Zed".into(), depth: 1 });
        assert_eq!(edges, vec![Edge { from: 10, to: 20, outbound: 5, inbound: 1 }]);
    }

    #[test]
    fn the_answer_says_what_was_asked_and_has_hops_only_when_there_is_a_path() {
        let found = PathAnswer {
            page: "atlas".into(),
            to: "zed".into(),
            resolved_from: Some(json!({"page": {"name": "atlas", "matchedBy": "alias", "resolvedTo": "Project Atlas"}})),
            resolved_aliases: Some(json!({"page": ["Atlas", "Project Atlas"]})),
            nodes: vec![Node { id: 10, name: "Project Atlas".into(), depth: 0 }, Node { id: 20, name: "Zed".into(), depth: 1 }],
            edges: vec![Edge { from: 10, to: 20, outbound: 2, inbound: 1 }],
            warnings: vec![],
        };
        assert_eq!(
            found.to_value().to_string(),
            concat!(
                r#"{"page":"atlas","to":"zed","resolvedFrom":{"page":{"name":"atlas","matchedBy":"alias","resolvedTo":"Project Atlas"}},"#,
                r#""resolvedAliases":{"page":["Atlas","Project Atlas"]},"hops":1,"hasMore":false,"warnings":[],"#,
                r#""nodes":[{"id":10,"name":"Project Atlas","depth":0},{"id":20,"name":"Zed","depth":1}],"#,
                r#""edges":[{"from":10,"to":20,"type":"reference","count":3,"outbound":2,"inbound":1}]}"#
            )
        );
        let missed = PathAnswer { resolved_from: None, resolved_aliases: None, nodes: vec![], edges: vec![], warnings: vec![same_page_warning("a", "b")], ..found };
        assert_eq!(keys(&missed.to_value()), ["page", "to", "hasMore", "warnings", "nodes", "edges"]);
        assert_eq!(missed.hops(), None);
    }

    #[test]
    fn a_walk_that_stopped_at_the_depth_limit_offers_one_more_hop_until_the_maximum() {
        let miss = |walked, requested, ran_out, cut| no_path_within(Miss { page: "Atlas", to: "Zed", walked, requested, ran_out, cut });
        let two = miss(2, 2, false, false);
        assert_eq!(two.code, "no_path_within");
        assert_eq!(two.message, "No path from \"Atlas\" to \"Zed\" within 2 hops.");
        assert_eq!(two.how_to_fetch_all.as_deref(), Some("Set max_depth to 3 to look one hop further (max 3)."));
        // at the maximum nothing reads on, and a larger request that was capped says so
        let three = miss(3, 9, false, false);
        assert_eq!(three.how_to_fetch_all, None);
        assert_eq!(
            three.message,
            "No path from \"Atlas\" to \"Zed\" within 3 hops. max_depth 9 was capped at 3. max_depth is capped at 3, so no longer path can be searched."
        );
        // zero hops walked asks for one
        assert_eq!(miss(0, 0, false, false).how_to_fetch_all.as_deref(), Some("Set max_depth to 1 to look one hop further (max 3)."));
    }

    #[test]
    fn a_walk_that_ran_out_of_pages_has_nothing_to_raise_unless_a_hop_was_cut() {
        let miss = |cut| no_path_within(Miss { page: "Atlas", to: "Zed", walked: 1, requested: 2, ran_out: true, cut });
        let whole = miss(false);
        assert_eq!(whole.how_to_fetch_all, None);
        assert_eq!(whole.message, "No path from \"Atlas\" to \"Zed\": every page linked within 1 hop was reached and none is \"Zed\". A larger max_depth finds nothing more.");
        // a cut frontier left pages unexpanded, so it does not claim that every page was reached, and offers no raise either
        let cut = miss(true);
        assert_eq!(cut.message, "No path from \"Atlas\" to \"Zed\" within 1 hop.");
        assert_eq!(cut.how_to_fetch_all, None);
    }

    #[test]
    fn a_path_after_a_cut_frontier_says_a_shorter_one_may_exist_and_offers_nothing_to_fetch() {
        let warning = path_may_not_be_shortest(2, 612, 3);
        assert_eq!(warning.code, "frontier_truncated");
        assert_eq!(
            warning.message,
            "Hop 2 expanded only 500 of the 612 pages reached before it, the ones with the lowest ids, so this path of 3 hops is real but a shorter one may exist. \
             Start from a more specific page to be sure of the shortest."
        );
        assert!(warning.how_to_fetch_all.is_none());
    }

    #[test]
    fn the_warnings_of_a_cut_frontier_and_of_an_unanswered_hop_offer_nothing_to_fetch() {
        let cut = frontier_truncated(2, 612);
        assert_eq!(cut.code, "frontier_truncated");
        assert!(cut.message.starts_with("Hop 2 expanded only 500 of the 612 pages reached before it"), "{}", cut.message);
        assert!(cut.how_to_fetch_all.is_none());
        let unavailable = links_unavailable(3);
        assert_eq!(unavailable.code, "links_unavailable");
        assert!(unavailable.message.contains("at hop 3 of the path"), "{}", unavailable.message);
        assert!(unavailable.message.ends_with(RETRY_ADVICE));
        assert!(unavailable.how_to_fetch_all.is_none());
    }

    #[test]
    fn a_page_resolved_by_alias_says_which_page_it_stood_for_under_its_own_parameter() {
        assert_eq!(keyed(None, None), None);
        assert_eq!(keyed(None, Some(json!(1))), Some(json!({"to": 1})));
        assert_eq!(keyed(Some(json!(1)), Some(json!(2))), Some(json!({"page": 1, "to": 2})));
        let resolved = |matched_by| ResolvedPage {
            page: crate::resolve::PulledPage::default(),
            matched_by,
            original_name: "Project Atlas".to_owned(),
            lookup_name: "project atlas".to_owned(),
        };
        assert_eq!(resolved_from("Atlas", &resolved(MatchedBy::Name)), None);
    }
}
