import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';
import { access } from 'fs/promises';
import { loadConfig } from '../../../src/config.js';
import { LogseqClient } from '../../../src/client.js';
import { getConceptNetwork } from '../../../src/tools/get-concept-network.js';
import { discoverPages, discoverPagesWithLinks } from '../helpers/discovery.js';
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
 * These tests discover pages dynamically from the LogSeq graph
 * and validate universal properties that must hold for ANY graph structure.
 *
 * No specific test data required - works with any LogSeq graph!
 */

describe('Property: Graph Traversal Invariants', () => {
  let client: LogseqClient;
  let skipTests = false;
  let skipReason = '';

  beforeAll(async () => {
    try {
      const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');

      try {
        await access(configPath);
      } catch {
        skipTests = true;
        skipReason = 'Config file not found at ~/.logseq-mcp/config.json';
        return;
      }

      const config = await loadConfig(configPath);
      client = new LogseqClient(config);

      try {
        await client.callAPI('logseq.App.getCurrentGraph');
      } catch (error) {
        skipTests = true;
        skipReason = `Cannot connect to LogSeq: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    } catch (error) {
      skipTests = true;
      skipReason = `Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  describe('Universal Graph Properties', () => {
    it.skipIf(skipTests)('should have no duplicate nodes for any discovered page', async () => {
      const pages = await discoverPages(client, 5);

      // REQUIRE data - don't skip if empty
      expect(pages.length).toBeGreaterThan(0);

      console.log(`\n✓ Testing ${pages.length} discovered pages`);

      for (const page of pages) {
        for (const depth of [0, 1, 2]) {
          const result = await getConceptNetwork(client, page.name, depth);

          // Property: No duplicate node IDs
          assertNoNodeDuplicates(result.nodes);
        }
      }
    });

    it.skipIf(skipTests)('should maintain referential integrity for all edges', async () => {
      const pages = await discoverPagesWithLinks(client, 1, 10);

      // REQUIRE pages with links - fail if empty
      expect(pages.length).toBeGreaterThan(0);

      console.log(`\n✓ Testing ${pages.length} pages with links`);

      for (const page of pages) {
        const result = await getConceptNetwork(client, page.name, 2);

        // Property: All edges reference valid nodes
        assertReferentialIntegrity(result.nodes, result.edges);
      }
    });

    it.skipIf(skipTests)('should respect depth constraints', async () => {
      const pages = await discoverPages(client, 5);

      // REQUIRE data - fail if empty
      expect(pages.length).toBeGreaterThan(0);

      for (const page of pages) {
        for (const maxDepth of [0, 1, 2, 3]) {
          const result = await getConceptNetwork(client, page.name, maxDepth);

          // Property: All nodes have depth <= maxDepth
          for (const node of result.nodes) {
            expect(node.depth).toBeLessThanOrEqual(maxDepth);
          }
        }
      }
    });

    it.skipIf(skipTests)('should always have a root node at depth 0', async () => {
      const pages = await discoverPages(client, 5);

      // REQUIRE data - fail if empty
      expect(pages.length).toBeGreaterThan(0);

      for (const page of pages) {
        const result = await getConceptNetwork(client, page.name, 2);

        // Property: Exactly one node at depth 0
        const rootNodes = result.nodes.filter(n => n.depth === 0);
        expect(rootNodes.length).toBe(1);

        // Property: Root node name matches requested page
        expect(rootNodes[0].name.toLowerCase()).toBe(page.name.toLowerCase());
      }
    });

    it.skipIf(skipTests)('should have monotonic depth increases along edges', async () => {
      const pages = await discoverPagesWithLinks(client, 1, 10);

      // REQUIRE pages with links - fail if empty
      expect(pages.length).toBeGreaterThan(0);

      for (const page of pages) {
        const result = await getConceptNetwork(client, page.name, 2);

        if (result.edges.length === 0) continue;

        // Property: Depth increases by at most 1 along edges
        assertDepthMonotonic(result.nodes, result.edges);
      }
    });

    it.skipIf(skipTests)('should maintain graph connectivity from root', async () => {
      const pages = await discoverPagesWithLinks(client, 2, 10);

      // REQUIRE pages with multiple links - fail if empty
      expect(pages.length).toBeGreaterThan(0);

      for (const page of pages.slice(0, 3)) {
        const result = await getConceptNetwork(client, page.name, 2);

        if (result.nodes.length <= 1) continue;

        const rootNode = result.nodes.find(n => n.depth === 0);
        if (!rootNode) continue;

        // Property: All nodes reachable from root
        assertConnectedGraph(rootNode.id, result.nodes, result.edges);
      }
    });
  });

  describe('Metamorphic Properties', () => {
    it.skipIf(skipTests)('should never lose nodes when increasing depth', async () => {
      const pages = await discoverPagesWithLinks(client, 1, 5);

      // REQUIRE pages with links - fail if empty
      expect(pages.length).toBeGreaterThan(0);

      for (const page of pages) {
        const depth0 = await getConceptNetwork(client, page.name, 0);
        const depth1 = await getConceptNetwork(client, page.name, 1);
        const depth2 = await getConceptNetwork(client, page.name, 2);

        // Property: depth0 ⊆ depth1 ⊆ depth2
        const nodes0 = new Set(depth0.nodes.map(n => n.id));
        const nodes1 = new Set(depth1.nodes.map(n => n.id));
        const nodes2 = new Set(depth2.nodes.map(n => n.id));

        assertSubset(nodes0, nodes1);
        assertSubset(nodes1, nodes2);
      }
    });

    it.skipIf(skipTests)('should return identical results on repeated calls (idempotence)', async () => {
      const pages = await discoverPages(client, 3);

      // REQUIRE data - fail if empty
      expect(pages.length).toBeGreaterThan(0);

      for (const page of pages) {
        const result1 = await getConceptNetwork(client, page.name, 2);
        const result2 = await getConceptNetwork(client, page.name, 2);

        // Property: Results are deterministic
        expect(result1.nodes.map(n => n.id).sort()).toEqual(result2.nodes.map(n => n.id).sort());
        expect(result1.edges.length).toBe(result2.edges.length);
      }
    });
  });

  describe('Boundary Conditions', () => {
    it.skipIf(skipTests)('should return only root node at depth 0', async () => {
      const pages = await discoverPages(client, 3);

      // REQUIRE data - fail if empty
      expect(pages.length).toBeGreaterThan(0);

      for (const page of pages) {
        const result = await getConceptNetwork(client, page.name, 0);

        // Property: depth=0 means single root node, no edges
        expect(result.nodes.length).toBe(1);
        expect(result.edges.length).toBe(0);
        expect(result.nodes[0].depth).toBe(0);
      }
    });

    it.skipIf(skipTests)('should throw error for non-existent pages', async () => {
      const nonExistentPage = `NonExistent-Page-${Date.now()}`;

      // Property: Missing pages throw consistent error
      await expect(getConceptNetwork(client, nonExistentPage, 2)).rejects.toThrow(/not found/i);
    });
  });

  // Display skip reason if tests were skipped
  if (skipTests) {
    it.skip(`Tests skipped: ${skipReason}`, () => {});
  }
});
