import { LogseqClient } from '../client.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';

export interface ConceptNetworkNode {
  id: number;
  name: string;
  depth: number;
}

/**
 * One edge per unordered page pair.
 *
 * `from` is the endpoint closer to the root (lower id on a depth tie), `to`
 * the other one. Link direction is carried by `outbound` / `inbound`, not by
 * the from/to order:
 * - `outbound`: blocks on `from` that reference `to`
 * - `inbound`: blocks on `to` that reference `from`
 * - `count`: `outbound + inbound`
 * - `type`: `'reference'` if `from` links to `to` at all, else `'backlink'`
 */
export interface ConceptNetworkEdge {
  from: number;
  to: number;
  type: 'reference' | 'backlink';
  count: number;
  outbound: number;
  inbound: number;
}

export interface ConceptNetworkResult {
  concept: string;
  nodes: ConceptNetworkNode[];
  edges: ConceptNetworkEdge[];
  /** True when `maxNodes` or `maxFanout` dropped at least one page from the network. */
  truncated: boolean;
}

export interface ConceptNetworkOptions {
  /** Hard cap on nodes in the result, root included. Default: 50. */
  maxNodes?: number;
  /** Most new pages any single page may add to the network. Default: 15. */
  maxFanout?: number;
  /**
   * Journal pages link to nearly everything, so by default they appear as
   * leaf nodes but are not expanded at the next depth. Set to true to walk
   * through them like any other page. Default: false.
   */
  expandJournals?: boolean;
}

export const DEFAULT_MAX_NODES = 50;
export const DEFAULT_MAX_FANOUT = 15;

/** One row of `DatalogQueryBuilder.connectedPages`. */
type ConnectedRow = [number, number, string, string, boolean, 'outbound' | 'inbound', number];

/** Directed link counts, keyed `"<from>><to>"`: blocks on `from` referencing `to`. */
type LinkCounts = Map<string, number>;

interface Candidate {
  id: number;
  name: string;
  isJournal: boolean;
  /** Reference count per frontier page this candidate is linked to. */
  bySource: Map<number, number>;
  /** Sum of `bySource`. */
  total: number;
}

const linkKey = (from: number, to: number) => `${from}>${to}`;

/**
 * Get network of pages related to a concept using batched Datalog queries.
 *
 * One query for the root plus one per depth level (at most maxDepth + 1
 * calls), each covering the whole BFS frontier in both link directions.
 *
 * Caps keep hub pages usable. When they bite, survivors are picked
 * deterministically: non-journal pages first, then more references to the
 * frontier, then lower id. `truncated` is set if any page was dropped.
 * @param client - LogseqClient instance
 * @param conceptName - Name of the root concept
 * @param maxDepth - Maximum depth to traverse (default: 2, max: 3)
 * @param options - Caps and journal handling (see ConceptNetworkOptions)
 * @returns ConceptNetworkResult with nodes, edges and a truncated flag
 */
export async function getConceptNetwork(
  client: LogseqClient,
  conceptName: string,
  maxDepth: number = 2,
  options: ConceptNetworkOptions = {}
): Promise<ConceptNetworkResult> {
  const maxNodes = normalizeCap(options.maxNodes, DEFAULT_MAX_NODES);
  const maxFanout = normalizeCap(options.maxFanout, DEFAULT_MAX_FANOUT);
  const expandJournals = options.expandJournals ?? false;
  let truncated = false;

  const nodeMap = new Map<number, ConceptNetworkNode>();
  const links: LinkCounts = new Map();

  // Query 0: Get root page only (case-insensitive, name passed as :in input)
  const root = DatalogQueryBuilder.conceptNetwork(conceptName, 0);
  const rootResults = await client.executeDatalogQuery<Array<[any]>>(root.query, ...root.inputs);

  if (!rootResults || rootResults.length === 0) {
    throw new Error(`Page not found: ${conceptName}`);
  }

  const rootPage = rootResults[0][0];
  const rootId = rootPage.id || rootPage['db/id'];
  const rootName = rootPage['original-name'] || rootPage.originalName || rootPage.name;

  if (!rootId || !rootName) {
    throw new Error(`Invalid root page data for: ${conceptName}`);
  }

  nodeMap.set(rootId, { id: rootId, name: rootName, depth: 0 });

  // BFS: one batched query per depth level
  let frontier = [rootId];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const q = DatalogQueryBuilder.connectedPages(frontier);
    const rows = (await client.executeDatalogQuery<ConnectedRow[]>(q.query, ...q.inputs)) || [];

    const candidates = new Map<number, Candidate>();
    for (const [sourceId, connectedId, name, originalName, isJournal, relType, count] of rows) {
      // Self-loops are excluded in the query; guard anyway.
      if (sourceId === connectedId) continue;

      // The same links are reported from both sides when two frontier pages
      // link to each other, so set (never add) the directed count.
      if (relType === 'outbound') {
        links.set(linkKey(sourceId, connectedId), count);
      } else {
        links.set(linkKey(connectedId, sourceId), count);
      }

      if (nodeMap.has(connectedId)) continue;

      let candidate = candidates.get(connectedId);
      if (!candidate) {
        candidate = {
          id: connectedId,
          name: originalName || name,
          isJournal: isJournal === true,
          bySource: new Map(),
          total: 0
        };
        candidates.set(connectedId, candidate);
      }
      candidate.bySource.set(sourceId, (candidate.bySource.get(sourceId) ?? 0) + count);
      candidate.total += count;
    }

    const admitted = selectCandidates(candidates, frontier, maxFanout, maxNodes - nodeMap.size);
    if (admitted.length < candidates.size) truncated = true;

    const nextFrontier: number[] = [];
    for (const candidate of admitted) {
      nodeMap.set(candidate.id, { id: candidate.id, name: candidate.name, depth });
      if (expandJournals || !candidate.isJournal) nextFrontier.push(candidate.id);
    }
    frontier = nextFrontier;
  }

  return {
    concept: conceptName,
    nodes: Array.from(nodeMap.values()),
    edges: buildEdges(nodeMap, links),
    truncated
  };
}

/** Floor to an integer >= 1; `Infinity` means uncapped. */
function normalizeCap(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

/**
 * Pick which candidates join the network at this depth.
 *
 * Rank: non-journal pages first, then more references, then lower id, so
 * the choice never depends on query row order.
 * 1. Each frontier page keeps its top `maxFanout` new neighbours (ranked by
 *    the references to that page); the survivors are the union.
 * 2. If that still exceeds the remaining node budget, the best by total
 *    references are kept.
 * Returns the admitted candidates in rank order.
 */
function selectCandidates(
  candidates: Map<number, Candidate>,
  frontier: number[],
  maxFanout: number,
  budget: number
): Candidate[] {
  const rank = (score: (c: Candidate) => number) => (a: Candidate, b: Candidate) =>
    Number(a.isJournal) - Number(b.isJournal) || score(b) - score(a) || a.id - b.id;

  const kept = new Set<number>();
  for (const sourceId of frontier) {
    const neighbours = [...candidates.values()].filter(c => c.bySource.has(sourceId));
    neighbours
      .sort(rank(c => c.bySource.get(sourceId) ?? 0))
      .slice(0, maxFanout)
      .forEach(c => kept.add(c.id));
  }

  return [...kept]
    .map(id => candidates.get(id)!)
    .sort(rank(c => c.total))
    .slice(0, Math.max(0, budget));
}

/**
 * Merge directed link counts into one edge per unordered pair, keeping only
 * pairs whose endpoints are both in the network. Sorted for determinism.
 */
function buildEdges(
  nodeMap: Map<number, ConceptNetworkNode>,
  links: LinkCounts
): ConceptNetworkEdge[] {
  const seen = new Set<string>();
  const edges: ConceptNetworkEdge[] = [];

  for (const key of links.keys()) {
    const [a, b] = key.split('>').map(Number);
    const pairKey = a < b ? linkKey(a, b) : linkKey(b, a);
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    const nodeA = nodeMap.get(a);
    const nodeB = nodeMap.get(b);
    if (!nodeA || !nodeB) continue;

    // from = endpoint closer to the root, lower id on a tie
    const aFirst = nodeA.depth < nodeB.depth || (nodeA.depth === nodeB.depth && a < b);
    const [from, to] = aFirst ? [a, b] : [b, a];

    const outbound = links.get(linkKey(from, to)) ?? 0;
    const inbound = links.get(linkKey(to, from)) ?? 0;

    edges.push({
      from,
      to,
      type: outbound > 0 ? 'reference' : 'backlink',
      count: outbound + inbound,
      outbound,
      inbound
    });
  }

  return edges.sort((x, y) => x.from - y.from || x.to - y.to);
}
