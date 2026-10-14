import type { Json } from './types.js';

/**
 * The first page of `explore_network` on the hub fixture (#556, ADR-0038). When the walk moved onto the cursor, its first page
 * had to be what the capped walk returned before: the same nodes in the same order with the same depths, and the same edges
 * between them. `data/explore-network-page1.json` is that result, recorded from the capped walk before it changed, so it pins
 * the pages and their order, not the warnings, which the cursor words anew.
 *
 * A page is named by its name, since ids come from LogSeq's load order. Pages that tie on rank are ordered by `:db/id`, which the
 * fixture's load order fixes for a given copy; the recording was taken twice from separate instances and agreed.
 */

export interface Page1Case {
  name: string;
  page: string;
  maxDepth?: number;
  maxNodes?: number;
  maxFanout?: number;
  expandJournals?: boolean;
  withSnippets?: boolean;
  /**
   * The capped walk was cut to the 30,000-character budget (#485): the first page is then a prefix of it, since the page
   * is cut to fit the budget with its own warnings and cursor, which are longer, so it may hold a few pages less.
   */
  sizeCut?: boolean;
}

export const PAGE1_CASES: Page1Case[] = [
  { name: 'hub depth 1, defaults', page: 'hub central', maxDepth: 1 },
  { name: 'hub depth 2, defaults', page: 'hub central', maxDepth: 2 },
  { name: 'hub depth 3, defaults', page: 'hub central', maxDepth: 3 },
  { name: 'hub depth 1, 500 nodes, fanout 100', page: 'hub central', maxDepth: 1, maxNodes: 500, maxFanout: 100 },
  { name: 'hub depth 2, 500 nodes, fanout 100', page: 'hub central', maxDepth: 2, maxNodes: 500, maxFanout: 100, sizeCut: true },
  { name: 'hub depth 2, 500 nodes, fanout 100, expand journals', page: 'hub central', maxDepth: 2, maxNodes: 500, maxFanout: 100, expandJournals: true, sizeCut: true },
  { name: 'hub depth 2, 30 nodes', page: 'hub central', maxDepth: 2, maxNodes: 30 },
  { name: 'hub depth 2, 120 nodes, fanout 40', page: 'hub central', maxDepth: 2, maxNodes: 120, maxFanout: 40 },
  { name: 'hub depth 1, with snippets', page: 'hub central', maxDepth: 1, withSnippets: true },
  { name: 'journal topic depth 2, expand journals', page: 'journal-topic-01', maxDepth: 2, expandJournals: true },
  { name: 'journal topic depth 2, expand journals, fanout 100', page: 'journal-topic-01', maxDepth: 2, expandJournals: true, maxFanout: 100 },
  { name: 'bob depth 2', page: 'bob', maxDepth: 2 },
];

/** A result as the pin keeps it: the nodes and the edges between them, by page name. */
export interface Page1 {
  nodes: Array<[name: string, depth: number]>;
  edges: Array<[from: string, to: string, type: string, count: number, outbound: number, inbound: number, snippet?: string]>;
}

export function projectPage1(result: Json): Page1 {
  const names = new Map<number, string>(result.nodes.map((node: Json) => [node.id, node.name]));
  const nodeName = (id: number): string => {
    const name = names.get(id);
    if (name === undefined) throw new Error(`An edge names a page that is not a node: ${id}`);
    return name;
  };
  return {
    nodes: result.nodes.map((node: Json) => [node.name, node.depth]),
    edges: result.edges.map((edge: Json) => {
      const row: Page1['edges'][number] = [nodeName(edge.from), nodeName(edge.to), edge.type, edge.count, edge.outbound, edge.inbound];
      if (edge.snippet !== undefined) row.push(edge.snippet);
      return row;
    }),
  };
}
