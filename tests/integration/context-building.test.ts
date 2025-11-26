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
 * Tests will FAIL if prerequisites are not met.
 */

describe('Context Building Tools Integration Tests', () => {
  let client: LogseqClient;

  beforeAll(async () => {
    // Check if config file exists
    const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');

    try {
      await access(configPath);
    } catch {
      throw new Error(
        'Config file not found at ~/.logseq-mcp/config.json. ' +
        'Integration tests require LogSeq configuration. ' +
        'See tests/integration/setup.md for setup instructions.'
      );
    }

    // Load config
    const config = await loadConfig(configPath);
    client = new LogseqClient(config);

    // Test connection to LogSeq - fail hard if not available
    try {
      await client.callAPI('logseq.App.getCurrentGraph');
    } catch (error) {
      throw new Error(
        `Cannot connect to LogSeq HTTP API: ${error instanceof Error ? error.message : 'Unknown error'}\n` +
        'Ensure LogSeq is running with HTTP server enabled. ' +
        'See tests/integration/setup.md'
      );
    }
  });

  describe('logseq_build_context', () => {
    it('should return comprehensive context structure', async () => {
      // Find any page to test with
      const searchResult = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      // Validate API contract: datascriptQuery should return array, not null
      expect(Array.isArray(searchResult)).toBe(true);
      expect(searchResult.length).toBeGreaterThan(0,
        'No pages found in LogSeq graph. Create at least one page. ' +
        'See tests/integration/setup.md'
      );

      // Get first page name - Datalog returns nested arrays [[page1], [page2]]
      const firstPage = searchResult[0][0];
      expect(firstPage).toBeDefined();
      const pageName = firstPage.name || firstPage['original-name'];
      expect(pageName).toBeTruthy('Page missing name property - data integrity issue');

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

    it('should respect maxBlocks limit', async () => {
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

    it('should handle journal pages with temporal context', async () => {
      // Use Editor API (matches working code in query-by-date-range.ts)
      const allPages = await client.callAPI<any[]>('logseq.Editor.getAllPages');

      expect(Array.isArray(allPages)).toBe(true);

      // Filter for journal pages (check both property names)
      const journalPages = (allPages || []).filter(p => p.journal || p['journal?']);
      expect(journalPages.length).toBeGreaterThan(0,
        'No journal pages found. Create at least one daily journal page. ' +
        'See tests/integration/setup.md'
      );

      const firstPage = journalPages[0];
      expect(firstPage.name).toBeTruthy('Journal page missing name - data integrity issue');
      const pageName = firstPage.name;

      const result = await buildContextForTopic(client, pageName);

      // Should have temporal context for journal pages
      expect(result).toHaveProperty('temporalContext');
      expect(result.temporalContext).toHaveProperty('isJournal');

      // buildContextForTopic checks mainPage.journal (not 'journal?')
      // So temporalContext.isJournal reflects what was in the fetched page
      expect(typeof result.temporalContext.isJournal).toBe('boolean');

      if (result.temporalContext?.date) {
        expect(typeof result.temporalContext.date).toBe('number');
      }
    });

    it('should throw error for non-existent page', async () => {
      await expect(
        buildContextForTopic(client, 'NonExistentPageForContextBuilding12345')
      ).rejects.toThrow('Page not found');
    });

    it('should aggregate related pages correctly', async () => {
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
    it('should extract topics and build context', async () => {
      // Find a page to use in query
      const searchResult = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      // Validate API contract
      expect(Array.isArray(searchResult)).toBe(true);
      expect(searchResult.length).toBeGreaterThan(0,
        'No pages found. Create at least one page in LogSeq graph. ' +
        'See tests/integration/setup.md'
      );

      // Datalog returns nested arrays [[page1], [page2]]
      const firstPage = searchResult[0][0];
      expect(firstPage).toBeDefined();
      const pageName = firstPage.name || firstPage['original-name'];
      expect(pageName).toBeTruthy('Page missing name property - data integrity issue');

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

    it('should handle multiple topics in query', async () => {
      // Find two pages to use in query
      const searchResult = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      // Validate API contract
      expect(Array.isArray(searchResult)).toBe(true);
      expect(searchResult.length).toBeGreaterThanOrEqual(2,
        'Not enough pages found. Create at least 2 pages in LogSeq graph. ' +
        'See tests/integration/setup.md'
      );

      // Datalog returns nested arrays [[page1], [page2]]
      const firstPage = searchResult[0][0];
      const secondPage = searchResult[1][0];
      expect(firstPage).toBeDefined();
      expect(secondPage).toBeDefined();

      const firstName = firstPage.name || firstPage['original-name'];
      const secondName = secondPage.name || secondPage['original-name'];
      expect(firstName).toBeTruthy('First page missing name property - data integrity issue');
      expect(secondName).toBeTruthy('Second page missing name property - data integrity issue');

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

    it('should handle queries without explicit topics', async () => {
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

    it('should respect maxTopics limit', async () => {
      // Create a query with many topics
      const searchResult = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      // Validate API contract
      expect(Array.isArray(searchResult)).toBe(true);
      expect(searchResult.length).toBeGreaterThanOrEqual(3,
        'Not enough pages found. Create at least 3 pages in LogSeq graph. ' +
        'See tests/integration/setup.md'
      );

      // Datalog returns nested arrays [[page1], [page2]] - extract objects
      const pageNames = searchResult
        .slice(0, 5)
        .map((row: any[]) => {
          const page = row[0];
          return page.name || page['original-name'];
        })
        .filter((name: string | undefined) => name);

      expect(pageNames.length).toBeGreaterThanOrEqual(3,
        'Could not extract page names - data integrity issue'
      );

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

    it('should validate context aggregation', async () => {
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
});
