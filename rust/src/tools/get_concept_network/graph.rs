//! The network's nodes and links, and what is derived from them once the walk is over
//! (`relabelDepths` and `buildEdges` in `src/tools/get-concept-network.ts`).

use std::collections::{HashMap, HashSet, VecDeque};

use serde::Serialize;

/// A page in the network: identity, then where it sits in the walk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Node {
    pub id: i64,
    pub name: String,
    /// Fewest hops from the root along the returned edges, either link direction (#155)
    pub depth: i64,
}

/// One edge per unordered page pair.
///
/// `from` is the endpoint closer to the root (lower id on a depth tie), `to` the other one. Link
/// direction is carried by `outbound` and `inbound`, not by the from/to order:
/// - `outbound`: blocks on `from` that reference `to`
/// - `inbound`: blocks on `to` that reference `from`
/// - `count`: `outbound + inbound`
/// - `type`: `reference` if `from` links to `to` at all, else `backlink`
///
/// Written as `from`, `to`, `type`, `count`, `outbound`, `inbound`: the pair, what kind it is and how many,
/// then the counts it is made of. `type` and `count` are derived, so the output is [`EdgeOutput`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    pub from: i64,
    pub to: i64,
    pub outbound: i64,
    pub inbound: i64,
}

impl Edge {
    pub fn kind(&self) -> &'static str {
        if self.outbound > 0 { "reference" } else { "backlink" }
    }

    pub fn count(&self) -> i64 {
        self.outbound + self.inbound
    }
}

/// An [`Edge`] as the result writes it.
#[derive(Debug, Serialize)]
pub struct EdgeOutput {
    from: i64,
    to: i64,
    #[serde(rename = "type")]
    kind: &'static str,
    count: i64,
    outbound: i64,
    inbound: i64,
}

impl From<&Edge> for EdgeOutput {
    fn from(edge: &Edge) -> Self {
        EdgeOutput { from: edge.from, to: edge.to, kind: edge.kind(), count: edge.count(), outbound: edge.outbound, inbound: edge.inbound }
    }
}

/// Directed link counts, `(from, to)` to the blocks on `from` that reference `to`, in the order
/// they were first set (a JavaScript `Map` keeps that order, and the walk to the nodes follows it).
#[derive(Debug, Default)]
pub struct Links {
    order: Vec<(i64, i64)>,
    counts: HashMap<(i64, i64), i64>,
}

impl Links {
    /// Set (never add) a directed count: the same links are reported from both sides when two
    /// frontier pages link to each other.
    pub fn set(&mut self, from: i64, to: i64, count: i64) {
        if self.counts.insert((from, to), count).is_none() {
            self.order.push((from, to));
        }
    }

    pub fn get(&self, from: i64, to: i64) -> Option<i64> {
        self.counts.get(&(from, to)).copied()
    }

    fn keys(&self) -> impl Iterator<Item = (i64, i64)> + '_ {
        self.order.iter().copied()
    }
}

/// The nodes in the order they joined, found by id.
#[derive(Debug, Default)]
pub struct Nodes {
    list: Vec<Node>,
    index: HashMap<i64, usize>,
}

impl Nodes {
    pub fn insert(&mut self, node: Node) {
        match self.index.get(&node.id) {
            Some(&at) => self.list[at] = node,
            None => {
                self.index.insert(node.id, self.list.len());
                self.list.push(node);
            }
        }
    }

    pub fn contains(&self, id: i64) -> bool {
        self.index.contains_key(&id)
    }

    pub fn get(&self, id: i64) -> Option<&Node> {
        self.index.get(&id).map(|&at| &self.list[at])
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    pub fn into_vec(self) -> Vec<Node> {
        self.list
    }

    #[cfg(test)]
    pub fn as_slice(&self) -> &[Node] {
        &self.list
    }
}

/// Set each node's `depth` to its shortest distance from the root over the edges the result will
/// carry: pairs of kept nodes that link in either direction (#155).
///
/// The walk labels a page with the level it was admitted at. A fanout cap can drop a direct
/// neighbour of the root at depth 1, and the page then joins at depth 2 through another page while
/// its edge to the root is still returned, so the admission level can overstate the distance. This
/// runs on data already fetched, so it adds no calls and leaves the node and edge sets unchanged. A
/// page is admitted through an edge to a page one level up, so the admission level is never below the
/// distance and every node is reachable; a node the pass somehow can't reach keeps its admission level.
pub fn relabel_depths(nodes: &mut Nodes, root: i64, links: &Links) {
    let mut adjacency: HashMap<i64, Vec<i64>> = HashMap::new();
    for (a, b) in links.keys() {
        if !nodes.contains(a) || !nodes.contains(b) {
            continue;
        }
        adjacency.entry(a).or_default().push(b);
        adjacency.entry(b).or_default().push(a);
    }
    let mut distance: HashMap<i64, i64> = HashMap::from([(root, 0)]);
    let mut queue = VecDeque::from([root]);
    while let Some(id) = queue.pop_front() {
        for &next in adjacency.get(&id).map_or(&[][..], Vec::as_slice) {
            if distance.contains_key(&next) {
                continue;
            }
            distance.insert(next, distance[&id] + 1);
            queue.push_back(next);
        }
    }
    for node in &mut nodes.list {
        if let Some(&found) = distance.get(&node.id) {
            node.depth = found;
        }
    }
}

/// Merge directed link counts into one edge per unordered pair, keeping only pairs whose endpoints
/// are both in the network. Sorted by `from`, then `to`, for determinism.
pub fn build_edges(nodes: &Nodes, links: &Links) -> Vec<Edge> {
    let mut seen: HashSet<(i64, i64)> = HashSet::new();
    let mut edges = Vec::new();
    for (a, b) in links.keys() {
        if !seen.insert(if a < b { (a, b) } else { (b, a) }) {
            continue;
        }
        let (Some(node_a), Some(node_b)) = (nodes.get(a), nodes.get(b)) else { continue };
        // from = endpoint closer to the root, lower id on a tie
        let a_first = node_a.depth < node_b.depth || (node_a.depth == node_b.depth && a < b);
        let (from, to) = if a_first { (a, b) } else { (b, a) };
        edges.push(Edge { from, to, outbound: links.get(from, to).unwrap_or(0), inbound: links.get(to, from).unwrap_or(0) });
    }
    edges.sort_by_key(|edge| (edge.from, edge.to));
    edges
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nodes(entries: &[(i64, i64)]) -> Nodes {
        let mut nodes = Nodes::default();
        for &(id, depth) in entries {
            nodes.insert(Node { id, name: format!("page {id}"), depth });
        }
        nodes
    }

    fn links(entries: &[(i64, i64, i64)]) -> Links {
        let mut links = Links::default();
        for &(from, to, count) in entries {
            links.set(from, to, count);
        }
        links
    }

    #[test]
    fn a_count_set_twice_is_the_last_one_and_keeps_its_first_place() {
        let mut links = links(&[(1, 2, 3), (2, 3, 1)]);
        links.set(1, 2, 5);
        assert_eq!(links.get(1, 2), Some(5));
        assert_eq!(links.keys().collect::<Vec<_>>(), [(1, 2), (2, 3)]);
    }

    #[test]
    fn a_pair_that_links_both_ways_is_one_edge_from_the_page_closer_to_the_root() {
        let nodes = nodes(&[(1, 0), (2, 1)]);
        let edges = build_edges(&nodes, &links(&[(2, 1, 4), (1, 2, 3)]));
        assert_eq!(edges, [Edge { from: 1, to: 2, outbound: 3, inbound: 4 }]);
        assert_eq!((edges[0].kind(), edges[0].count()), ("reference", 7));
    }

    #[test]
    fn an_edge_that_only_the_far_page_makes_is_a_backlink() {
        let nodes = nodes(&[(1, 0), (2, 1)]);
        let edges = build_edges(&nodes, &links(&[(2, 1, 4)]));
        assert_eq!(edges, [Edge { from: 1, to: 2, outbound: 0, inbound: 4 }]);
        assert_eq!(edges[0].kind(), "backlink");
    }

    #[test]
    fn a_depth_tie_puts_the_lower_id_first_and_a_pair_outside_the_network_is_dropped() {
        let nodes = nodes(&[(1, 0), (7, 1), (5, 1)]);
        let edges = build_edges(&nodes, &links(&[(7, 5, 2), (1, 9, 1), (1, 7, 1), (1, 5, 1)]));
        assert_eq!(
            edges,
            [
                Edge { from: 1, to: 5, outbound: 1, inbound: 0 },
                Edge { from: 1, to: 7, outbound: 1, inbound: 0 },
                Edge { from: 5, to: 7, outbound: 0, inbound: 2 },
            ]
        );
    }

    #[test]
    fn a_depth_is_the_shortest_distance_over_the_kept_edges() {
        // 3 was admitted at depth 2, but it links the root directly
        let mut nodes = nodes(&[(1, 0), (2, 1), (3, 2)]);
        relabel_depths(&mut nodes, 1, &links(&[(1, 2, 1), (2, 3, 1), (3, 1, 1)]));
        assert_eq!(nodes.as_slice().iter().map(|n| n.depth).collect::<Vec<_>>(), [0, 1, 1]);
    }

    #[test]
    fn a_node_no_edge_reaches_keeps_its_admission_depth_and_a_link_to_a_dropped_page_is_ignored() {
        let mut nodes = nodes(&[(1, 0), (2, 1), (3, 2)]);
        relabel_depths(&mut nodes, 1, &links(&[(1, 2, 1), (3, 9, 1)]));
        assert_eq!(nodes.as_slice().iter().map(|n| n.depth).collect::<Vec<_>>(), [0, 1, 2]);
    }
}
