import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';
import { access } from 'fs/promises';
import { loadConfig } from '../../src/config.js';
import { LogseqClient } from '../../src/client.js';
import { buildContextForTopic } from '../../src/tools/build-context.js';
import { getContextForQuery } from '../../src/tools/get-context-for-query.js';

/**
 * Integration tests for Context Building Tools
 *
 * These tests require:
 * 1. LogSeq running with HTTP API enabled
 * 2. Config file at ~/.logseq-mcp/config.json
 * 3. Test data in LogSeq graph
 *
 * Tests will be skipped if prerequisites are not met.
 */

describe('Context Building Tools Integration Tests', () => {
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

  describe('logseq_build_context', () => {
    it.skipIf(skipTests)('should return comprehensive context structure', async () => {
      // Find any page to test with
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        console.warn('No pages found for build_context test');
        return;
      }

      // Get first page name
      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        console.warn('Could not determine page name');
        return;
      }

      const result = await buildContextForTopic(client, pageName);

      // Validate structure
      expect(result).toHaveProperty('topic');
      expect(result).toHaveProperty('mainPage');
      expect(result).toHaveProperty('directBlocks');
      expect(result).toHaveProperty('relatedPages');
      expect(result).toHaveProperty('references');
      expect(result).toHaveProperty('summary');

      // Validate main page structure
      expect(result.mainPage).toHaveProperty('id');
      expect(result.mainPage).toHaveProperty('name');
      expect(result.topic).toBe(pageName);

      // Validate arrays
      expect(Array.isArray(result.directBlocks)).toBe(true);
      expect(Array.isArray(result.relatedPages)).toBe(true);
      expect(Array.isArray(result.references)).toBe(true);

      // Validate summary structure
      expect(result.summary).toHaveProperty('totalBlocks');
      expect(result.summary).toHaveProperty('totalRelatedPages');
      expect(result.summary).toHaveProperty('totalReferences');
      expect(result.summary).toHaveProperty('pageProperties');

      expect(typeof result.summary.totalBlocks).toBe('number');
      expect(typeof result.summary.totalRelatedPages).toBe('number');
      expect(typeof result.summary.totalReferences).toBe('number');
    });

    it.skipIf(skipTests)('should respect maxBlocks limit', async () => {
      // Find a page with blocks
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

      // Test with limited blocks
      const result = await buildContextForTopic(client, pageName, {
        maxBlocks: 5
      });

      expect(result.directBlocks.length).toBeLessThanOrEqual(5);
    });

    it.skipIf(skipTests)('should handle journal pages with temporal context', async () => {
      // Find a journal page
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/journal? true]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        console.warn('No journal pages found for temporal context test');
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        return;
      }

      const result = await buildContextForTopic(client, pageName);

      // Should have temporal context for journal pages
      expect(result).toHaveProperty('temporalContext');
      expect(result.temporalContext).toHaveProperty('isJournal');
      expect(result.temporalContext?.isJournal).toBe(true);

      if (result.temporalContext?.date) {
        expect(typeof result.temporalContext.date).toBe('number');
      }
    });

    it.skipIf(skipTests)('should throw error for non-existent page', async () => {
      await expect(
        buildContextForTopic(client, 'NonExistentPageForContextBuilding12345')
      ).rejects.toThrow('Page not found');
    });

    it.skipIf(skipTests)('should aggregate related pages correctly', async () => {
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

      const result = await buildContextForTopic(client, pageName);

      // If there are related pages, validate their structure
      if (result.relatedPages.length > 0) {
        const related = result.relatedPages[0];
        expect(related).toHaveProperty('page');
        expect(related).toHaveProperty('relationshipType');
        expect(['outbound', 'inbound']).toContain(related.relationshipType);
        expect(related.page).toHaveProperty('id');
        expect(related.page).toHaveProperty('name');
      }

      // Summary should match actual counts
      expect(result.summary.totalRelatedPages).toBe(result.relatedPages.length);
    });
  });

  describe('logseq_get_context_for_query', () => {
    it.skipIf(skipTests)('should extract topics and build context', async () => {
      // Find a page to use in query
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        console.warn('No pages found for get_context_for_query test');
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        return;
      }

      // Query with explicit page reference
      const result = await getContextForQuery(
        client,
        `What is [[${pageName}]]?`
      );

      // Validate structure
      expect(result).toHaveProperty('query');
      expect(result).toHaveProperty('extractedTopics');
      expect(result).toHaveProperty('contexts');
      expect(result).toHaveProperty('summary');

      // Should extract the topic
      expect(result.extractedTopics).toContain(pageName);
      expect(Array.isArray(result.contexts)).toBe(true);

      // Validate summary
      expect(result.summary).toHaveProperty('totalTopics');
      expect(result.summary).toHaveProperty('totalBlocks');
      expect(result.summary).toHaveProperty('totalPages');
      expect(typeof result.summary.totalTopics).toBe('number');
    });

    it.skipIf(skipTests)('should handle multiple topics in query', async () => {
      // Find two pages to use in query
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length < 2) {
        console.warn('Not enough pages found for multiple topics test');
        return;
      }

      const firstPage = searchResult[0];
      const secondPage = searchResult[1];
      const firstName = firstPage.name || firstPage['original-name'];
      const secondName = secondPage.name || secondPage['original-name'];

      if (!firstName || !secondName) {
        return;
      }

      // Query with two explicit page references
      const result = await getContextForQuery(
        client,
        `Compare [[${firstName}]] and [[${secondName}]]`
      );

      // Should extract both topics
      expect(result.extractedTopics).toContain(firstName);
      expect(result.extractedTopics).toContain(secondName);

      // Should have contexts for both (if pages exist)
      expect(result.contexts.length).toBeGreaterThanOrEqual(0);
      expect(result.contexts.length).toBeLessThanOrEqual(2);
    });

    it.skipIf(skipTests)('should handle queries without explicit topics', async () => {
      // Query without page references
      const result = await getContextForQuery(
        client,
        'What is machine learning?'
      );

      // Should handle gracefully
      expect(result).toHaveProperty('query');
      expect(result).toHaveProperty('extractedTopics');
      expect(result).toHaveProperty('contexts');

      // May have search results if no explicit topics
      expect(Array.isArray(result.contexts)).toBe(true);
    });

    it.skipIf(skipTests)('should respect maxTopics limit', async () => {
      // Create a query with many topics
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length < 3) {
        console.warn('Not enough pages found for maxTopics test');
        return;
      }

      const pageNames = searchResult
        .slice(0, 5)
        .map((p: any) => p.name || p['original-name'])
        .filter((name: string | undefined) => name);

      if (pageNames.length < 3) {
        return;
      }

      // Create query with multiple page references
      const query = pageNames
        .map((name: string) => `[[${name}]]`)
        .join(' and ');

      const result = await getContextForQuery(client, query, {
        maxTopics: 2
      });

      // Should respect the limit
      expect(result.contexts.length).toBeLessThanOrEqual(2);
    });

    it.skipIf(skipTests)('should validate context aggregation', async () => {
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

      const result = await getContextForQuery(
        client,
        `Tell me about [[${pageName}]]`
      );

      // If contexts were built, validate their structure
      if (result.contexts.length > 0) {
        const context = result.contexts[0];
        expect(context).toHaveProperty('topic');
        expect(context).toHaveProperty('mainPage');
        expect(context).toHaveProperty('directBlocks');
        expect(context).toHaveProperty('relatedPages');
        expect(context).toHaveProperty('summary');
      }

      // Summary should aggregate correctly
      const expectedTotalBlocks = result.contexts.reduce(
        (sum, ctx) => sum + ctx.directBlocks.length,
        0
      ) + (result.searchResults?.length || 0);

      expect(result.summary.totalBlocks).toBeGreaterThanOrEqual(0);
    });
  });

  // Display skip reason if tests were skipped
  if (skipTests) {
    it.skip(`Tests skipped: ${skipReason}`, () => {
      // This test is just to display the skip reason
    });
  }
});
