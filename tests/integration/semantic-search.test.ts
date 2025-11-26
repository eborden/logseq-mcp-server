import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';
import { access } from 'fs/promises';
import { loadConfig } from '../../src/config.js';
import { LogseqClient } from '../../src/client.js';
import { searchByRelationship } from '../../src/tools/search-by-relationship.js';
import { searchBlocks } from '../../src/tools/search-blocks.js';

/**
 * Integration tests for Semantic Search Tools
 *
 * These tests require:
 * 1. LogSeq running with HTTP API enabled
 * 2. Config file at ~/.logseq-mcp/config.json
 * 3. Test data in LogSeq graph
 *
 * Tests will FAIL if prerequisites are not met.
 */

describe('Semantic Search Integration Tests', () => {
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

  describe('logseq_search_by_relationship', () => {
    it('should return structure with query and results', async () => {
      // Find any two pages to test with
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
      const pageA = searchResult[0][0];
      const pageB = searchResult[1][0];
      expect(pageA).toBeDefined();
      expect(pageB).toBeDefined();

      const pageAName = pageA.name || pageA['original-name'];
      const pageBName = pageB.name || pageB['original-name'];
      expect(pageAName).toBeTruthy('Page A missing name property - data integrity issue');
      expect(pageBName).toBeTruthy('Page B missing name property - data integrity issue');

      const result = await searchByRelationship(
        client,
        pageAName,
        pageBName,
        'references'
      );

      // Validate structure
      expect(result).toHaveProperty('query');
      expect(result).toHaveProperty('relationshipType');
      expect(result).toHaveProperty('results');

      // Validate query structure
      expect(result.query).toHaveProperty('topicA');
      expect(result.query).toHaveProperty('topicB');
      expect(result.query).toHaveProperty('relationshipType');
      expect(result.query.topicA).toBe(pageAName);
      expect(result.query.topicB).toBe(pageBName);
      expect(result.query.relationshipType).toBe('references');

      // Validate results is an array
      expect(Array.isArray(result.results)).toBe(true);

      // If there are results, validate block structure
      if (result.results.length > 0) {
        const block = result.results[0];
        expect(block).toHaveProperty('id');
        expect(block).toHaveProperty('content');
      }
    });

    it('should support in-pages-linking-to relationship', async () => {
      // Find any two pages to test with
      const searchResult = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length < 2) {
        return;
      }

      const pageA = searchResult[0];
      const pageB = searchResult[1];
      const pageAName = pageA.name || pageA['original-name'];
      const pageBName = pageB.name || pageB['original-name'];

      if (!pageAName || !pageBName) {
        return;
      }

      const result = await searchByRelationship(
        client,
        pageAName,
        pageBName,
        'in-pages-linking-to'
      );

      // Validate structure
      expect(result).toHaveProperty('query');
      expect(result).toHaveProperty('relationshipType');
      expect(result).toHaveProperty('results');
      expect(result.relationshipType).toBe('in-pages-linking-to');
      expect(Array.isArray(result.results)).toBe(true);
    });

    it('should support connected-within relationship with maxDistance', async () => {
      // Find any two pages to test with
      const searchResult = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length < 2) {
        return;
      }

      const pageA = searchResult[0];
      const pageB = searchResult[1];
      const pageAName = pageA.name || pageA['original-name'];
      const pageBName = pageB.name || pageB['original-name'];

      if (!pageAName || !pageBName) {
        return;
      }

      const result = await searchByRelationship(
        client,
        pageAName,
        pageBName,
        'connected-within',
        3
      );

      // Validate structure
      expect(result).toHaveProperty('query');
      expect(result).toHaveProperty('relationshipType');
      expect(result).toHaveProperty('results');
      expect(result.relationshipType).toBe('connected-within');
      expect(result.query.maxDistance).toBe(3);
      expect(Array.isArray(result.results)).toBe(true);
    });
  });

  describe('enhanced search_blocks with includeContext', () => {
    it('should return blocks without context when includeContext is false', async () => {
      const results = await searchBlocks(client, 'test', 5, false);

      expect(results).not.toBeNull(
        'searchBlocks returned null - unexpected API behavior. ' +
        'Check LogSeq connection and ensure test data exists.'
      );
      expect(Array.isArray(results)).toBe(true);

      // Blocks should not have context property when includeContext is false
      if (results.length > 0) {
        expect(results[0]).not.toHaveProperty('context');
      }
    });

    it('should include context when includeContext is true', async () => {
      const results = await searchBlocks(client, 'test', 10, true);

      expect(results).not.toBeNull('searchBlocks returned null - unexpected');
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0,
        'No blocks found containing "test". Create test data in LogSeq. ' +
        'See tests/integration/setup.md'
      );

      // Validate that includeContext actually adds context to blocks
      const blocksWithContext = results.filter(b => b.context !== undefined);
      expect(blocksWithContext.length).toBeGreaterThan(0,
        'No blocks have context. Blocks are missing page information. ' +
        'Ensure blocks have page references. See tests/integration/setup.md'
      );

      // Validate context structure
      const block = blocksWithContext[0];
      expect(block.context).toHaveProperty('page');
      expect(block.context).toHaveProperty('references');
      expect(block.context).toHaveProperty('tags');
      expect(Array.isArray(block.context.references)).toBe(true);
      expect(Array.isArray(block.context.tags)).toBe(true);
      expect(block.context.page).toHaveProperty('id');
      expect(block.context.page).toHaveProperty('name');
    });

    it('should extract references from block content', async () => {
      // Search for a common term that's likely to appear with page references
      const results = await searchBlocks(client, '[[', 10, true);

      expect(results).not.toBeNull('searchBlocks returned null');
      expect(results.length).toBeGreaterThan(0,
        'No blocks with references ([[page]]) found. ' +
        'Create blocks with page references in LogSeq. ' +
        'See tests/integration/setup.md'
      );

      // Validate that references are extracted from block content
      const blocksWithRefs = results.filter(
        b => b.context && b.context.references.length > 0
      );

      expect(blocksWithRefs.length).toBeGreaterThan(0,
        'No blocks with extracted references. Create blocks with [[page references]]. ' +
        'See tests/integration/setup.md'
      );

      const block = blocksWithRefs[0];
      expect(block.context).toBeDefined();
      expect(block.context.references.length).toBeGreaterThan(0);

      // Validate reference extraction matches content
      const hasMatchingRef = block.context.references.some(ref =>
        block.content.includes(`[[${ref}]]`)
      );
      expect(hasMatchingRef).toBe(true);
    });

    it('should extract tags from block content', async () => {
      // Search for blocks with hashtags
      const results = await searchBlocks(client, '#', 10, true);

      expect(results).not.toBeNull('searchBlocks returned null');
      expect(results.length).toBeGreaterThan(0,
        'No blocks with tags (#tag) found. ' +
        'Create blocks with hashtags in LogSeq. ' +
        'See tests/integration/setup.md'
      );

      // Validate that tags are extracted from block content
      const blocksWithTags = results.filter(
        b => b.context && b.context.tags.length > 0
      );

      expect(blocksWithTags.length).toBeGreaterThan(0,
        'No blocks with extracted tags. Create blocks with #tags. ' +
        'See tests/integration/setup.md'
      );

      const block = blocksWithTags[0];
      expect(block.context).toBeDefined();
      expect(block.context.tags.length).toBeGreaterThan(0);

      // Validate tag extraction matches content
      const hasMatchingTag = block.context.tags.some(tag =>
        block.content.includes(`#${tag}`)
      );
      expect(hasMatchingTag).toBe(true);
    });
  });
});
