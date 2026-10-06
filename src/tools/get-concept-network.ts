import { LogseqClient } from '../client.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import { ResultMeta, ResultWarning } from '../types.js';
import { entityId, pageDisplayName } from '../utils/entity-fields.js';
import { buildResultMeta, INLINE_ITEMS, largeResultNote } from '../utils/result-meta.js';
import { requirePage, resolvedFrom, ResolvedFrom } from '../utils/resolve-page.js';
import {
  ResolvedAliases,
  aliasIds,
  aliasSetWarnings,
  hasAliases,
  resolveAliasSet,
  resolvedAliases,
  singleAliasSet
} from '../utils/alias-set.js';

export interface ConceptNetworkNode {
  id: number;
  name: string;
  /** Fewest hops from the root along the returned edges, either link direction (#155). */
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

export interface ConceptNetworkResult extends ResultMeta, ResolvedFrom, ResolvedAliases {
  concept: string;
  nodes: ConceptNetworkNode[];
  edges: ConceptNetworkEdge[];
  /** True when `maxNodes` or `maxFanout` dropped at least one page from the network. */
  truncated: boolean;
  /** `warnings` carries a `network_truncated` entry; `hasMore` is true only when it names a cap that can still be raised (#132). */
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

export const DEFAULT_MAX_DEPTH = 2;
export const DEFAULT_MAX_NODES = 50;
export const DEFAULT_MAX_FANOUT = 15;
/** The most the MCP handler lets a caller set `max_nodes` to. */
export const MAX_NODES_LIMIT = 500;
/** The most the MCP handler lets a caller set `max_fanout` to. */
export const MAX_FANOUT_LIMIT = 100;

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
 * Aliases (#69): the root and the pages it is an alias of, or that alias it,
 * are one concept, so they are one node. Their links are unioned (a block that
 * links two of those names counts once), links among them are dropped, and
 * `resolvedAliases` lists the names. This costs one query before the walk and
 * only when the root has an alias.
 *
 * Caps keep hub pages usable. When they bite, survivors are picked
 * deterministically: non-journal pages first, then more references to the
 * frontier, then lower id. `truncated` is set if any page was dropped.
 * @param client - LogseqClient instance
 * @param conceptName - Page name, alias, or ISO date (`2025-01-01`) of the root; throws
 *   PageNotFoundError if none matches and AmbiguousPageError if several do
 * @param maxDepth - Maximum depth to traverse (default: 2, max: 3)
 * @param options - Caps and journal handling (see ConceptNetworkOptions)
 * @returns ConceptNetworkResult with nodes, edges and a truncated flag
 */
export async function getConceptNetwork(
  client: LogseqClient,
  conceptName: string,
  maxDepth: number = DEFAULT_MAX_DEPTH,
  options: ConceptNetworkOptions = {}
): Promise<ConceptNetworkResult> {
  const maxNodes = normalizeCap(options.maxNodes, DEFAULT_MAX_NODES);
  const maxFanout = normalizeCap(options.maxFanout, DEFAULT_MAX_FANOUT);
  const expandJournals = options.expandJournals ?? false;
  let truncated = false;
  let dropped = 0;
  // Which cap dropped them (#132): `max_fanout` leaves a page's extra neighbours out,
  // `max_nodes` leaves out what the node budget can't hold.
  let droppedByFanout = 0;
  let droppedByBudget = 0;
  // The first level that dropped a page: lowering max_depth below it is what narrows the walk (#132)
  let firstDropDepth: number | undefined;
  // A journal page was admitted and expanded before any page was dropped (#132)
  let expandedJournal = false;

  const nodeMap = new Map<number, ConceptNetworkNode>();
  const links: LinkCounts = new Map();

  // Query 0: Resolve the root page (exact name, alias or ISO date, in one query).
  // Throws PageNotFoundError (with suggestions) or AmbiguousPageError (with candidates).
  const resolved = await requirePage(client, conceptName);
  const rootPage = resolved.page;
  const rootId = entityId(rootPage);
  const rootName = pageDisplayName(rootPage);

  if (!rootId || !rootName) {
    throw new Error(`Invalid root page data for: ${conceptName}`);
  }

  nodeMap.set(rootId, { id: rootId, name: rootName, depth: 0 });

  // The root's names (#69). Nothing is followed at depth 0, so nothing to look up.
  const aliasSet = maxDepth >= 1 ? await resolveAliasSet(client, rootPage) : singleAliasSet(rootPage);
  const aliasMemberIds = new Set(aliasIds(aliasSet));
  const rootGroup = new Map<number, number>([...aliasMemberIds].map(id => [id, rootId]));
  // Links to any name of the root are the root's, and the grouped depth-1 query already
  // counted them across names. Later depths would overwrite that with a single name's count.
  const foldedIds = hasAliases(aliasSet) ? aliasMemberIds : new Set<number>();

  // BFS: one batched query per depth level
  let frontier = [rootId];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    // At depth 1 the frontier is the root, expanded through every one of its names
    const q =
      depth === 1 && hasAliases(aliasSet)
        ? DatalogQueryBuilder.connectedPagesGrouped(aliasIds(aliasSet), rootGroup)
        : DatalogQueryBuilder.connectedPages(frontier);
    const rows = (await client.executeDatalogQuery<ConnectedRow[]>(q.query, ...q.inputs)) || [];

    const candidates = new Map<number, Candidate>();
    for (const [sourceId, connectedId, name, originalName, isJournal, relType, count] of rows) {
      // Self-loops are excluded in the query; guard anyway.
      if (sourceId === connectedId || foldedIds.has(connectedId)) continue;

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

    const selection = selectCandidates(candidates, frontier, maxFanout, maxNodes - nodeMap.size);
    const admitted = selection.admitted;
    if (admitted.length < candidates.size) {
      truncated = true;
      firstDropDepth ??= depth;
      dropped += candidates.size - admitted.length;
      droppedByFanout += selection.droppedByFanout;
      droppedByBudget += selection.droppedByBudget;
    }

    const nextFrontier: number[] = [];
    for (const candidate of admitted) {
      nodeMap.set(candidate.id, { id: candidate.id, name: candidate.name, depth });
      if (expandJournals || !candidate.isJournal) {
        nextFrontier.push(candidate.id);
        if (candidate.isJournal && depth < maxDepth && !truncated) expandedJournal = true;
      }
    }
    frontier = nextFrontier;
  }

  relabelDepths(nodeMap, rootId, links);
  const nodes = Array.from(nodeMap.values());
  // Alongside `truncated`, which stays as is. `dropped` counts only the pages
  // seen at the depths that were walked, so it is a lower bound.
  const warnings: ResultWarning[] = aliasSetWarnings(aliasSet);
  if (truncated) {
    warnings.push(
      networkTruncatedWarning({
        kept: nodes.length,
        dropped,
        droppedByFanout,
        droppedByBudget,
        maxNodes,
        maxFanout,
        firstDropDepth: firstDropDepth!,
        expandJournals,
        expandedJournal
      })
    );
  }

  return {
    concept: conceptName,
    ...resolvedFrom(conceptName, resolved),
    ...resolvedAliases(aliasSet),
    nodes,
    edges: buildEdges(nodeMap, links),
    truncated,
    ...buildResultMeta(warnings)
  };
}

interface TruncationFacts {
  kept: number;
  /** Lower bound: pages dropped at the depths that were walked. */
  dropped: number;
  droppedByFanout: number;
  droppedByBudget: number;
  maxNodes: number;
  maxFanout: number;
  /** The first depth at which a page was dropped. */
  firstDropDepth: number;
  expandJournals: boolean;
  /** A journal page was expanded at a depth before the first drop. */
  expandedJournal: boolean;
}

/**
 * The `network_truncated` warning (#132). Below the maxima it says what it always
 * did. A cap that is already at its maximum (`max_nodes` 500, `max_fanout` 100) is
 * never offered for raising, and a suggested `max_nodes` never goes past 500. When
 * nothing is left to raise there is no `howToFetchAll`, so `hasMore` is false and the
 * warning says the maximum was reached (BR-0006). Each claim is made only when the
 * walk showed it: a cap is named only if it dropped pages, and a way to narrow the
 * walk only if it would. `cappedTruncationWarning` doesn't fit: it takes one
 * parameter and an exact total, and this walk has two caps and a lower bound.
 */
function networkTruncatedWarning(f: TruncationFacts): ResultWarning {
  const base = `Kept ${f.kept} pages; at least ${f.dropped} more connected pages were dropped.`;
  const suggestedNodes = f.kept + f.dropped;

  // No cap at its maximum, and the suggested max_nodes is in range: unchanged
  if (suggestedNodes <= MAX_NODES_LIMIT && f.maxFanout < MAX_FANOUT_LIMIT) {
    return {
      code: 'network_truncated',
      message: base,
      howToFetchAll:
        `Set max_nodes to ${suggestedNodes} (max ${MAX_NODES_LIMIT}) and/or max_fanout higher (max ${MAX_FANOUT_LIMIT}), ` +
        `or set expand_journals to walk through journal pages.${largeResultNote(suggestedNodes, INLINE_ITEMS.networkNodes)}`
    };
  }

  const nodesBit = f.droppedByBudget > 0;
  const fanoutBit = f.droppedByFanout > 0;
  const nodesAtMax = nodesBit && f.maxNodes >= MAX_NODES_LIMIT;
  const fanoutAtMax = fanoutBit && f.maxFanout >= MAX_FANOUT_LIMIT;

  const reached: string[] = [];
  if (nodesAtMax) reached.push(`max_nodes reached its maximum of ${MAX_NODES_LIMIT}`);
  if (fanoutAtMax) reached.push(`max_fanout reached its maximum of ${MAX_FANOUT_LIMIT}`);

  // With the node budget full at its maximum, no other parameter adds a page; a larger
  // fanout would only change which pages are kept.
  const raise: string[] = [];
  let raisedNodes = 0;
  if (nodesBit && !nodesAtMax) {
    // Pages the fanout cap dropped are not the budget's to hold, so count only the budget's
    const holdsAll = f.kept + f.droppedByBudget;
    raisedNodes = Math.min(holdsAll, MAX_NODES_LIMIT);
    raise.push(
      holdsAll <= MAX_NODES_LIMIT
        ? `max_nodes to ${holdsAll} (max ${MAX_NODES_LIMIT})`
        : `max_nodes to ${MAX_NODES_LIMIT} (the maximum)`
    );
  }
  if (fanoutBit && !fanoutAtMax && !nodesAtMax) raise.push(`max_fanout higher (max ${MAX_FANOUT_LIMIT})`);

  const reachedClause = reached.join(' and ');
  if (raise.length > 0) {
    return {
      code: 'network_truncated',
      message: reachedClause ? `${base} ${reachedClause}.` : base,
      howToFetchAll: `Set ${raise.join(' and/or ')}.${largeResultNote(raisedNodes, INLINE_ITEMS.networkNodes)}`
    };
  }

  const narrow: string[] = [];
  // Lowering max_depth changes nothing when the first drop is at depth 1
  if (f.firstDropDepth >= 2) narrow.push('lower max_depth');
  if (f.expandJournals && f.expandedJournal) narrow.push('set expand_journals to false so journal pages stay leaves');
  const narrowText = narrow.length > 0 ? ` To narrow the walk instead, ${narrow.join(' or ')}.` : '';
  return {
    code: 'network_truncated',
    // A cut with nothing to raise has a cap at its maximum, so `reachedClause` is never empty here
    message: `${base} ${reachedClause}, so the rest can't be fetched in one call.${narrowText}`
  };
}

/**
 * Set each node's `depth` to its shortest distance from the root over the edges
 * the result will carry: pairs of kept nodes that link in either direction (#155).
 *
 * The walk labels a page with the level it was admitted at. A fanout cap can drop
 * a direct neighbour of the root at depth 1, and the page then joins at depth 2
 * through another page while its edge to the root is still returned, so the
 * admission level can overstate the distance. This runs on data already fetched,
 * so it adds no calls and leaves the node and edge sets unchanged. A page is
 * admitted through an edge to a page one level up, so the admission level is never
 * below the distance and every node is reachable; a node the pass somehow can't
 * reach keeps its admission level.
 */
function relabelDepths(
  nodeMap: Map<number, ConceptNetworkNode>,
  rootId: number,
  links: LinkCounts
): void {
  const adjacency = new Map<number, number[]>();
  const connect = (a: number, b: number) => {
    const list = adjacency.get(a);
    if (list) list.push(b);
    else adjacency.set(a, [b]);
  };
  for (const key of links.keys()) {
    const [a, b] = key.split('>').map(Number);
    if (!nodeMap.has(a) || !nodeMap.has(b)) continue;
    connect(a, b);
    connect(b, a);
  }

  const distance = new Map<number, number>([[rootId, 0]]);
  const queue = [rootId];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const next of adjacency.get(id) ?? []) {
      if (distance.has(next)) continue;
      distance.set(next, distance.get(id)! + 1);
      queue.push(next);
    }
  }

  for (const node of nodeMap.values()) {
    node.depth = distance.get(node.id) ?? node.depth;
  }
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
 * Returns the admitted candidates in rank order, and how many each step dropped.
 */
function selectCandidates(
  candidates: Map<number, Candidate>,
  frontier: number[],
  maxFanout: number,
  budget: number
): { admitted: Candidate[]; droppedByFanout: number; droppedByBudget: number } {
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

  const admitted = [...kept]
    .map(id => candidates.get(id)!)
    .sort(rank(c => c.total))
    .slice(0, Math.max(0, budget));
  return {
    admitted,
    droppedByFanout: candidates.size - kept.size,
    droppedByBudget: kept.size - admitted.length
  };
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
