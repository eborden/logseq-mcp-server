import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../../scripts/lib/logseq-api.js';
import { getConceptNetwork } from '../helpers/tools.js';
import type { ConceptNetworkResult } from '../helpers/types.js';
import { connectFixture } from '../helpers/fixture-client.js';
import {
  assertNoNodeDuplicates,
  assertReferentialIntegrity,
  assertDepthMonotonic,
  assertDepthIsDistance,
  assertConnectedGraph,
  assertSubset
} from '../helpers/invariants.js';

/**
 * Property-Based Tests for Graph Traversal Tools
 *
 * Invariants that must hold for any graph, checked over a fixed set of fixture pages that
 * cover the shapes that matter (#90): a page with an alias, plain pages with links, a journal,
 * a namespace page, a page with no links, a page with no file, the hub (caps bite) and a hub
 * neighbour. graph-tools.test.ts holds the exact results; these hold for every page.
 */

/** Every page here exists in tests/fixtures/graph; most of them link other pages. */
const PAGES = [
  'project atlas', 'Bob', 'alice', 'project cascade', 'Jan 6th, 2025', 'project atlas/meetings',
  'deep outline', 'hub central', 'neighbour-both-01', 'journal-topic-01',
];
/** Pages with links: each has at least one neighbour at depth 1. */
const LINKED = PAGES;
/** Pages with nothing to traverse */
const ISOLATED = ['archive', 'empty page'];

describe('Property: Graph Traversal Invariants', () => {
  let client: LogseqClient;
  // Each (page, depth) network is fetched once per run and shared by every test that needs it (#193).
  // LogSeq answers one request at a time, so when several agents' suites share a machine, every
  // call queues behind theirs; the file used to make ~200 network calls for ~50 distinct ones.
  // The tool is stateless and the tests only read a result, so sharing one is safe. The idempotence
  // test is the one that must ask again, and does.
  const networks = new Map<string, Promise<ConceptNetworkResult>>();
  const network = (page: string, depth: number): Promise<ConceptNetworkResult> => {
    const key = `${depth}:${page}`;
    let cached = networks.get(key);
    if (!cached) {
      // A rejected call is dropped from the cache, so one transient failure (a timeout under load)
      // fails only the test that hit it; later tests retry instead of replaying the same error.
      cached = getConceptNetwork(client, page, depth).catch((e: unknown) => {
        networks.delete(key);
        throw e;
      });
      networks.set(key, cached);
    }
    return cached;
  };

  beforeAll(async () => {
    ({ client } = await connectFixture());
  });

  describe('Universal Graph Properties', () => {
    it('should have no duplicate nodes for any fixture page', async () => {
      const pages = [...PAGES, ...ISOLATED];

      for (const page of pages) {
        for (const depth of [0, 1, 2]) {
          const result = await network(page, depth);

          // Property: No duplicate node IDs
          assertNoNodeDuplicates(result.nodes);
        }
      }
    });

    it('should maintain referential integrity for all edges', async () => {
      const pages = LINKED;

      for (const page of pages) {
        const result = await network(page, 2);

        // Property: All edges reference valid nodes
        assertReferentialIntegrity(result.nodes, result.edges);
      }
    });

    it('should respect depth constraints', async () => {
      const pages = [...PAGES, ...ISOLATED];

      for (const page of pages) {
        for (const maxDepth of [0, 1, 2, 3]) {
          const result = await network(page, maxDepth);

          // Property: All nodes have depth <= maxDepth
          for (const node of result.nodes) {
            expect(node.depth).toBeLessThanOrEqual(maxDepth);
          }
        }
      }
    });

    it('should always have a root node at depth 0', async () => {
      const pages = [...PAGES, ...ISOLATED];

      for (const page of pages) {
        const result = await network(page, 2);

        // Property: Exactly one node at depth 0
        const rootNodes = result.nodes.filter(n => n.depth === 0);
        expect(rootNodes.length).toBe(1);

        // Property: Root node name matches requested page
        expect(rootNodes[0].name.toLowerCase()).toBe(page.toLowerCase());
      }
    });

    it('should have monotonic depth increases along edges, capped or not', async () => {
      const pages = LINKED;
      let capped = 0;

      for (const page of pages) {
        const result = await network(page, 2);

        expect(result.edges.length, page).toBeGreaterThan(0);
        if (result.truncated) capped++;

        // Property: Depth increases by at most 1 along edges. Holds under a cap too: depth is
        // the node's distance from the root over the returned edges (#155).
        assertDepthMonotonic(result.nodes, result.edges);
        // Exact, so a label that is too low fails too, not only one that is too high
        assertDepthIsDistance(result.nodes, result.edges, page);
      }
      // The capped networks are the ones that used to break the invariant
      expect(capped, 'no fixture network was capped').toBeGreaterThanOrEqual(1);
    });

    it('should maintain graph connectivity from root', async () => {
      const pages = LINKED;

      for (const page of pages) {
        const result = await network(page, 2);

        expect(result.nodes.length, page).toBeGreaterThan(1);
        const rootNode = result.nodes.find(n => n.depth === 0)!;

        // Property: All nodes reachable from root
        assertConnectedGraph(rootNode.id, result.nodes, result.edges);
      }
    });
  });

  describe('Edge and Cap Properties', () => {
    it('should emit one edge per unordered pair, no self-loops, and respect the caps', async () => {
      const pages = LINKED;

      for (const page of pages) {
        const result = await network(page, 2);

        // Property: at most one edge per unordered page pair, never a self-loop
        const pairs = result.edges.map(e => [Math.min(e.from, e.to), Math.max(e.from, e.to)].join('-'));
        expect(new Set(pairs).size).toBe(pairs.length);
        for (const edge of result.edges) {
          expect(edge.from).not.toBe(edge.to);
          expect(edge.count).toBe(edge.outbound + edge.inbound);
          expect(edge.count).toBeGreaterThan(0);
        }

        // Property: default node cap holds, and truncated is always a boolean
        expect(result.nodes.length).toBeLessThanOrEqual(50);
        expect(typeof result.truncated).toBe('boolean');
      }
    });
  });

  describe('Metamorphic Properties', () => {
    it('should never lose nodes when increasing depth', async () => {
      const pages = LINKED;

      for (const page of pages) {
        const depth0 = await network(page, 0);
        const depth1 = await network(page, 1);
        const depth2 = await network(page, 2);

        // Property: depth0 ⊆ depth1 ⊆ depth2
        const nodes0 = new Set(depth0.nodes.map(n => n.id));
        const nodes1 = new Set(depth1.nodes.map(n => n.id));
        const nodes2 = new Set(depth2.nodes.map(n => n.id));

        assertSubset(nodes0, nodes1);
        assertSubset(nodes1, nodes2);
      }
    });

    it('should return identical results on repeated calls (idempotence)', async () => {
      const pages = [...PAGES, ...ISOLATED];

      for (const page of pages) {
        // result1 may be the run's shared copy, fetched by an earlier test, so this also checks the
        // network doesn't change between calls made minutes apart. result2 is always a new call.
        // Run alone (e.g. with -t), result1 is a fresh call too, so this compares two back-to-back
        // calls: still a valid idempotence check, only without the cross-time part.
        const result1 = await network(page, 2);
        const result2 = await getConceptNetwork(client, page, 2);

        // Property: the same nodes (with names and depths) and the same edges (with counts).
        // Compared as sets: the order of nodes and edges isn't part of the contract. It was
        // identical in every one of ~500 repeated calls on the fixture (#193), but that is
        // not promised, so a failure here is a real change in what is returned.
        const nodeKey = (r: ConceptNetworkResult) => r.nodes.map(n => `${n.id}:${n.name}:${n.depth}`).sort();
        const edgeKey = (r: ConceptNetworkResult) =>
          r.edges.map(e => `${e.from}>${e.to}:${e.type}:${e.outbound}/${e.inbound}`).sort();
        expect(nodeKey(result1), page).toEqual(nodeKey(result2));
        expect(edgeKey(result1), page).toEqual(edgeKey(result2));
        expect(result1.truncated, page).toBe(result2.truncated);
      }
    });
  });

  describe('Boundary Conditions', () => {
    it('should return only root node at depth 0', async () => {
      const pages = [...PAGES, ...ISOLATED];

      for (const page of pages) {
        const result = await network(page, 0);

        // Property: depth=0 means single root node, no edges
        expect(result.nodes.length).toBe(1);
        expect(result.edges.length).toBe(0);
        expect(result.nodes[0].depth).toBe(0);
      }
    });

    it('should throw error for non-existent pages', async () => {
      const nonExistentPage = `NonExistent-Page-${Date.now()}`;

      // Property: Missing pages throw consistent error
      await expect(getConceptNetwork(client, nonExistentPage, 2)).rejects.toThrow(/^No page /);
    });
  });
});
