import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../../src/client.js';
import { getConceptNetwork } from '../../../src/tools/get-concept-network.js';
import { connectFixture } from '../helpers/fixture-client.js';
import {
  assertNoNodeDuplicates,
  assertReferentialIntegrity,
  assertDepthMonotonic,
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

  beforeAll(async () => {
    ({ client } = await connectFixture());
  });

  describe('Universal Graph Properties', () => {
    it('should have no duplicate nodes for any fixture page', async () => {
      const pages = [...PAGES, ...ISOLATED];

      for (const page of pages) {
        for (const depth of [0, 1, 2]) {
          const result = await getConceptNetwork(client, page, depth);

          // Property: No duplicate node IDs
          assertNoNodeDuplicates(result.nodes);
        }
      }
    });

    it('should maintain referential integrity for all edges', async () => {
      const pages = LINKED;

      for (const page of pages) {
        const result = await getConceptNetwork(client, page, 2);

        // Property: All edges reference valid nodes
        assertReferentialIntegrity(result.nodes, result.edges);
      }
    });

    it('should respect depth constraints', async () => {
      const pages = [...PAGES, ...ISOLATED];

      for (const page of pages) {
        for (const maxDepth of [0, 1, 2, 3]) {
          const result = await getConceptNetwork(client, page, maxDepth);

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
        const result = await getConceptNetwork(client, page, 2);

        // Property: Exactly one node at depth 0
        const rootNodes = result.nodes.filter(n => n.depth === 0);
        expect(rootNodes.length).toBe(1);

        // Property: Root node name matches requested page
        expect(rootNodes[0].name.toLowerCase()).toBe(page.toLowerCase());
      }
    });

    it('should have monotonic depth increases along edges when no cap bites', async () => {
      const pages = LINKED;
      let untruncated = 0;

      for (const page of pages) {
        const result = await getConceptNetwork(client, page, 2);

        expect(result.edges.length, page).toBeGreaterThan(0);
        // Under a cap, depth is the BFS level a node was admitted at, not its distance: a direct
        // neighbour the fanout cap dropped at depth 1 can come back at depth 2 through another
        // page, with its edge to the root (project atlas and project cascade do this with their
        // journals). So the property holds for the networks no cap cut.
        if (result.truncated) continue;
        untruncated++;

        // Property: Depth increases by at most 1 along edges
        assertDepthMonotonic(result.nodes, result.edges);
      }
      expect(untruncated, 'no fixture network was below the caps').toBeGreaterThanOrEqual(3);
    });

    it('should maintain graph connectivity from root', async () => {
      const pages = LINKED;

      for (const page of pages) {
        const result = await getConceptNetwork(client, page, 2);

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
        const result = await getConceptNetwork(client, page, 2);

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
        const depth0 = await getConceptNetwork(client, page, 0);
        const depth1 = await getConceptNetwork(client, page, 1);
        const depth2 = await getConceptNetwork(client, page, 2);

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
        const result1 = await getConceptNetwork(client, page, 2);
        const result2 = await getConceptNetwork(client, page, 2);

        // Property: Results are deterministic
        expect(result1.nodes.map(n => n.id).sort()).toEqual(result2.nodes.map(n => n.id).sort());
        expect(result1.edges.length).toBe(result2.edges.length);
      }
    });
  });

  describe('Boundary Conditions', () => {
    it('should return only root node at depth 0', async () => {
      const pages = [...PAGES, ...ISOLATED];

      for (const page of pages) {
        const result = await getConceptNetwork(client, page, 0);

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
