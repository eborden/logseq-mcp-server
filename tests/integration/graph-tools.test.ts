import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';
import { access } from 'fs/promises';
import { loadConfig } from '../../src/config.js';
import { LogseqClient } from '../../src/client.js';
import { getRelatedPages } from '../../src/tools/get-related-pages.js';
import { getEntityTimeline } from '../../src/tools/get-entity-timeline.js';
import { getConceptNetwork } from '../../src/tools/get-concept-network.js';

/**
 * Integration tests for Graph Traversal Tools
 *
 * These tests require:
 * 1. LogSeq running with HTTP API enabled
 * 2. Config file at ~/.logseq-mcp/config.json
 * 3. Test data in LogSeq graph
 *
 * Tests will be skipped if prerequisites are not met.
 */

describe('Graph Traversal Tools Integration Tests', () => {
  let client: LogseqClient;
  let skipTests = false;
  let skipReason = '';

  beforeAll(async () => {
    try {
      // Check if config file exists
      const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');

      try {
        await access(configPath);
      } catch {
        skipTests = true;
        skipReason = 'Config file not found. See tests/integration/setup.md for setup instructions.';
        return;
      }

      // Load config
      const config = await loadConfig(configPath);
      client = new LogseqClient(config);

      // Test connection to LogSeq
      try {
        await client.callAPI('logseq.App.getCurrentGraph');
      } catch (error) {
        skipTests = true;
        skipReason = `Cannot connect to LogSeq: ${error instanceof Error ? error.message : 'Unknown error'}. Ensure LogSeq is running with HTTP server enabled.`;
      }
    } catch (error) {
      skipTests = true;
      skipReason = `Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  describe('logseq_get_related_pages', () => {
    it.skipIf(skipTests)('should return structure with sourcePage and relatedPages', async () => {
      // Find any page to test with
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        console.warn('No pages found for get_related_pages test');
        return;
      }

      // Get first page name
      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        console.warn('Could not determine page name');
        return;
      }

      const result = await getRelatedPages(client, pageName, 1);

      // Validate structure
      expect(result).toHaveProperty('sourcePage');
      expect(result).toHaveProperty('relatedPages');
      expect(result.sourcePage).toHaveProperty('id');
      expect(result.sourcePage).toHaveProperty('name');
      expect(Array.isArray(result.relatedPages)).toBe(true);

      // If there are related pages, validate their structure
      if (result.relatedPages.length > 0) {
        const related = result.relatedPages[0];
        expect(related).toHaveProperty('page');
        expect(related).toHaveProperty('relationshipType');
        expect(related).toHaveProperty('distance');
        expect(['outbound-reference', 'inbound-reference']).toContain(related.relationshipType);
        expect(typeof related.distance).toBe('number');
      }
    });

    it.skipIf(skipTests)('should respect depth parameter', async () => {
      // Find a page
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        return;
      }

      // Test with depth 0
      const resultDepth0 = await getRelatedPages(client, pageName, 0);
      expect(resultDepth0.relatedPages).toHaveLength(0);

      // Test with depth 1 (should return results or empty array)
      const resultDepth1 = await getRelatedPages(client, pageName, 1);
      expect(Array.isArray(resultDepth1.relatedPages)).toBe(true);
    });

    it.skipIf(skipTests)('should throw error for non-existent page', async () => {
      await expect(
        getRelatedPages(client, 'NonExistentPageForGraphTools12345', 1)
      ).rejects.toThrow('Page not found');
    });
  });

  describe('logseq_get_entity_timeline', () => {
    it.skipIf(skipTests)('should return timeline structure', async () => {
      // Find any page to test with
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        console.warn('No pages found for get_entity_timeline test');
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        return;
      }

      const result = await getEntityTimeline(client, pageName);

      // Validate structure
      expect(result).toHaveProperty('entity');
      expect(result).toHaveProperty('timeline');
      expect(result.entity).toBe(pageName);
      expect(Array.isArray(result.timeline)).toBe(true);

      // If timeline has entries, validate structure
      if (result.timeline.length > 0) {
        const entry = result.timeline[0];
        expect(entry).toHaveProperty('date');
        expect(entry).toHaveProperty('block');

        // date should be either number or null
        expect(entry.date === null || typeof entry.date === 'number').toBe(true);

        // Block should have expected properties
        expect(entry.block).toHaveProperty('id');
        expect(entry.block).toHaveProperty('content');
      }
    });

    it.skipIf(skipTests)('should filter by date range', async () => {
      // Find a journal page to test with
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/journal? true]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        console.warn('No journal pages found for date range test');
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        return;
      }

      // Test with date range (future dates - should return empty or filtered)
      const result = await getEntityTimeline(
        client,
        pageName,
        20300101,  // Start date far in future
        20301231   // End date far in future
      );

      expect(result).toHaveProperty('timeline');
      expect(Array.isArray(result.timeline)).toBe(true);

      // All returned entries should be within range or null
      for (const entry of result.timeline) {
        if (entry.date !== null) {
          expect(entry.date).toBeGreaterThanOrEqual(20300101);
          expect(entry.date).toBeLessThanOrEqual(20301231);
        }
      }
    });

    it.skipIf(skipTests)('should sort timeline chronologically', async () => {
      // Find any page with multiple references
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        return;
      }

      const result = await getEntityTimeline(client, pageName);

      // Check that dates are sorted (non-null dates before nulls, and in ascending order)
      let lastDate: number | null = null;
      let seenNull = false;

      for (const entry of result.timeline) {
        if (entry.date === null) {
          seenNull = true;
        } else {
          // If we've seen a null, no more non-null dates should appear
          expect(seenNull).toBe(false);

          // Check ascending order
          if (lastDate !== null) {
            expect(entry.date).toBeGreaterThanOrEqual(lastDate);
          }
          lastDate = entry.date;
        }
      }
    });
  });

  describe('logseq_get_concept_network', () => {
    it.skipIf(skipTests)('should return network structure with nodes and edges', async () => {
      // Find any page to test with
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        console.warn('No pages found for get_concept_network test');
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        return;
      }

      const result = await getConceptNetwork(client, pageName, 2);

      // Validate structure
      expect(result).toHaveProperty('concept');
      expect(result).toHaveProperty('nodes');
      expect(result).toHaveProperty('edges');
      expect(result.concept).toBe(pageName);
      expect(Array.isArray(result.nodes)).toBe(true);
      expect(Array.isArray(result.edges)).toBe(true);

      // Should have at least the root node
      expect(result.nodes.length).toBeGreaterThanOrEqual(1);

      // Validate node structure
      const rootNode = result.nodes[0];
      expect(rootNode).toHaveProperty('id');
      expect(rootNode).toHaveProperty('name');
      expect(rootNode).toHaveProperty('depth');
      expect(rootNode.depth).toBe(0);

      // If there are edges, validate edge structure
      if (result.edges.length > 0) {
        const edge = result.edges[0];
        expect(edge).toHaveProperty('from');
        expect(edge).toHaveProperty('to');
        expect(edge).toHaveProperty('type');
        expect(['reference', 'backlink']).toContain(edge.type);
        expect(typeof edge.from).toBe('number');
        expect(typeof edge.to).toBe('number');
      }
    });

    it.skipIf(skipTests)('should respect maxDepth parameter', async () => {
      // Find a page
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        return;
      }

      // Test with depth 0 - should only return root node
      const resultDepth0 = await getConceptNetwork(client, pageName, 0);
      expect(resultDepth0.nodes).toHaveLength(1);
      expect(resultDepth0.edges).toHaveLength(0);
      expect(resultDepth0.nodes[0].depth).toBe(0);

      // Test with depth 1 - should have at most depth 1 nodes
      const resultDepth1 = await getConceptNetwork(client, pageName, 1);
      for (const node of resultDepth1.nodes) {
        expect(node.depth).toBeLessThanOrEqual(1);
      }

      // Test with depth 2 - should have at most depth 2 nodes
      const resultDepth2 = await getConceptNetwork(client, pageName, 2);
      for (const node of resultDepth2.nodes) {
        expect(node.depth).toBeLessThanOrEqual(2);
      }
    });

    it.skipIf(skipTests)('should not have duplicate nodes', async () => {
      // Find a page
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        return;
      }

      const result = await getConceptNetwork(client, pageName, 2);

      // Check that all node IDs are unique
      const nodeIds = result.nodes.map(n => n.id);
      const uniqueNodeIds = new Set(nodeIds);
      expect(nodeIds.length).toBe(uniqueNodeIds.size);
    });

    it.skipIf(skipTests)('should throw error for non-existent page', async () => {
      await expect(
        getConceptNetwork(client, 'NonExistentConceptForGraphTools12345', 2)
      ).rejects.toThrow('Page not found');
    });
  });

  // Display skip reason if tests were skipped
  if (skipTests) {
    it.skip(`Tests skipped: ${skipReason}`, () => {
      // This test is just to display the skip reason
    });
  }
});
