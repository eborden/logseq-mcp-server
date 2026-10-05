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
}

/** One row of `DatalogQueryBuilder.connectedPages`. */
type ConnectedRow = [number, number, string, string, boolean, 'outbound' | 'inbound', number];

/** Directed link counts, keyed `"<from>><to>"`: blocks on `from` referencing `to`. */
type LinkCounts = Map<string, number>;

interface Candidate {
  id: number;
  name: string;
  isJournal: boolean;
}

const linkKey = (from: number, to: number) => `${from}>${to}`;

/**
 * Get network of pages related to a concept using batched Datalog queries.
 *
 * One query for the root plus one per depth level (at most maxDepth + 1
 * calls), each covering the whole BFS frontier in both link directions.
 * @param client - LogseqClient instance
 * @param conceptName - Name of the root concept
 * @param maxDepth - Maximum depth to traverse (default: 2, max: 3)
 * @returns ConceptNetworkResult with nodes and edges
 */
export async function getConceptNetwork(
  client: LogseqClient,
  conceptName: string,
  maxDepth: number = 2
): Promise<ConceptNetworkResult> {
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

      if (!nodeMap.has(connectedId) && !candidates.has(connectedId)) {
        candidates.set(connectedId, {
          id: connectedId,
          name: originalName || name,
          isJournal: isJournal === true
        });
      }
    }

    const nextFrontier: number[] = [];
    for (const candidate of [...candidates.values()].sort((a, b) => a.id - b.id)) {
      nodeMap.set(candidate.id, { id: candidate.id, name: candidate.name, depth });
      nextFrontier.push(candidate.id);
    }
    frontier = nextFrontier;
  }

  return {
    concept: conceptName,
    nodes: Array.from(nodeMap.values()),
    edges: buildEdges(nodeMap, links)
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
