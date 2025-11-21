import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';
import { access } from 'fs/promises';
import { loadConfig } from '../../../src/config.js';
import { LogseqClient } from '../../../src/client.js';
import { getConceptNetworkHTTP } from '../../../src/tools/get-concept-network-http.js';
import { getConceptNetworkDatalog } from '../../../src/tools/get-concept-network-datalog.js';
import { discoverPages, discoverPagesWithLinks } from '../helpers/discovery.js';

/**
 * Property-Based Tests for HTTP vs Datalog Implementation Equivalence
 *
 * Validates that HTTP and Datalog implementations produce equivalent results
 * for any discovered pages in the graph.
 */

describe('Property: HTTP vs Datalog Equivalence', () => {
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

  describe('Structural Equivalence', () => {
    it.skipIf(skipTests)('should return same node IDs for HTTP and Datalog', async () => {
      const pages = await discoverPagesWithLinks(client, 1, 5);

      // REQUIRE pages with links - fail if empty
      expect(pages.length).toBeGreaterThan(0);

      console.log(`\n✓ Testing equivalence on ${pages.length} pages`);

      for (const page of pages) {
        for (const depth of [1, 2]) {
          const httpResult = await getConceptNetworkHTTP(client, page.name, depth);
          const datalogResult = await getConceptNetworkDatalog(client, page.name, depth);

          // Property: Same nodes
          const httpNodeIds = new Set(httpResult.nodes.map(n => n.id));
          const datalogNodeIds = new Set(datalogResult.nodes.map(n => n.id));

          expect(datalogNodeIds).toEqual(httpNodeIds);
        }
      }
    });

    it.skipIf(skipTests)('should return same edge count for HTTP and Datalog', async () => {
      const pages = await discoverPagesWithLinks(client, 2, 5);

      // REQUIRE pages with multiple links - fail if empty
      expect(pages.length).toBeGreaterThan(0);

      for (const page of pages) {
        const httpResult = await getConceptNetworkHTTP(client, page.name, 2);
        const datalogResult = await getConceptNetworkDatalog(client, page.name, 2);

        // Property: Same number of edges
        expect(datalogResult.edges.length).toBe(httpResult.edges.length);
      }
    });

    it.skipIf(skipTests)('should return same concept name for both implementations', async () => {
      const pages = await discoverPages(client, 5);

      // REQUIRE pages - fail if empty
      expect(pages.length).toBeGreaterThan(0);

      for (const page of pages) {
        const httpResult = await getConceptNetworkHTTP(client, page.name, 1);
        const datalogResult = await getConceptNetworkDatalog(client, page.name, 1);

        // Property: Concept name matches
        expect(datalogResult.concept).toBe(httpResult.concept);
      }
    });
  });

  describe('Error Handling Equivalence', () => {
    it.skipIf(skipTests)('should throw identical errors for non-existent pages', async () => {
      const nonExistentPage = `NonExistent-${Date.now()}`;

      let httpError: Error | null = null;
      let datalogError: Error | null = null;

      try {
        await getConceptNetworkHTTP(client, nonExistentPage, 2);
      } catch (error) {
        httpError = error as Error;
      }

      try {
        await getConceptNetworkDatalog(client, nonExistentPage, 2);
      } catch (error) {
        datalogError = error as Error;
      }

      // Property: Both throw errors
      expect(httpError).toBeDefined();
      expect(datalogError).toBeDefined();

      // Property: Both indicate page not found
      expect(httpError?.message).toContain('not found');
      expect(datalogError?.message).toContain('not found');
    });
  });

  describe('Depth Equivalence', () => {
    it.skipIf(skipTests)('should produce equivalent results at depth=0', async () => {
      const pages = await discoverPages(client, 3);

      // REQUIRE pages - fail if empty
      expect(pages.length).toBeGreaterThan(0);

      for (const page of pages) {
        const httpResult = await getConceptNetworkHTTP(client, page.name, 0);
        const datalogResult = await getConceptNetworkDatalog(client, page.name, 0);

        // Property: Both return single root node
        expect(httpResult.nodes.length).toBe(1);
        expect(datalogResult.nodes.length).toBe(1);

        // Property: Same root node ID
        expect(datalogResult.nodes[0].id).toBe(httpResult.nodes[0].id);

        // Property: No edges at depth 0
        expect(httpResult.edges.length).toBe(0);
        expect(datalogResult.edges.length).toBe(0);
      }
    });

    it.skipIf(skipTests)('should produce equivalent results at depth=1', async () => {
      const pages = await discoverPagesWithLinks(client, 1, 5);

      // REQUIRE pages with links - fail if empty
      expect(pages.length).toBeGreaterThan(0);

      for (const page of pages) {
        const httpResult = await getConceptNetworkHTTP(client, page.name, 1);
        const datalogResult = await getConceptNetworkDatalog(client, page.name, 1);

        // Property: Same node IDs
        const httpNodeIds = new Set(httpResult.nodes.map(n => n.id));
        const datalogNodeIds = new Set(datalogResult.nodes.map(n => n.id));
        expect(datalogNodeIds).toEqual(httpNodeIds);
      }
    });

    it.skipIf(skipTests)('should produce equivalent results at depth=2', async () => {
      const pages = await discoverPagesWithLinks(client, 1, 5);

      // REQUIRE pages with links - fail if empty
      expect(pages.length).toBeGreaterThan(0);

      for (const page of pages) {
        const httpResult = await getConceptNetworkHTTP(client, page.name, 2);
        const datalogResult = await getConceptNetworkDatalog(client, page.name, 2);

        // Property: Same node IDs
        const httpNodeIds = new Set(httpResult.nodes.map(n => n.id));
        const datalogNodeIds = new Set(datalogResult.nodes.map(n => n.id));
        expect(datalogNodeIds).toEqual(httpNodeIds);
      }
    });
  });

  describe('Determinism', () => {
    it.skipIf(skipTests)('should produce consistent results across multiple calls', async () => {
      const pages = await discoverPages(client, 3);

      // REQUIRE pages - fail if empty
      expect(pages.length).toBeGreaterThan(0);

      for (const page of pages) {
        // Run HTTP implementation twice
        const http1 = await getConceptNetworkHTTP(client, page.name, 2);
        const http2 = await getConceptNetworkHTTP(client, page.name, 2);

        // Run Datalog implementation twice
        const datalog1 = await getConceptNetworkDatalog(client, page.name, 2);
        const datalog2 = await getConceptNetworkDatalog(client, page.name, 2);

        // Filter out any undefined IDs (shouldn't happen but be defensive)
        const httpIds1 = http1.nodes.map(n => n.id).filter(id => id !== undefined).sort();
        const httpIds2 = http2.nodes.map(n => n.id).filter(id => id !== undefined).sort();
        const datalogIds1 = datalog1.nodes.map(n => n.id).filter(id => id !== undefined).sort();
        const datalogIds2 = datalog2.nodes.map(n => n.id).filter(id => id !== undefined).sort();

        // Property: HTTP is deterministic
        expect(httpIds1).toEqual(httpIds2);

        // Property: Datalog is deterministic
        expect(datalogIds1).toEqual(datalogIds2);

        // Property: Both are equivalent
        expect(httpIds1).toEqual(datalogIds1);
      }
    });
  });

  // Display skip reason if tests were skipped
  if (skipTests) {
    it.skip(`Tests skipped: ${skipReason}`, () => {});
  }
});
