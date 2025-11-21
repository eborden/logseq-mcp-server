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
 * Tests will be skipped if prerequisites are not met.
 */

describe('Semantic Search Integration Tests', () => {
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

  describe('logseq_search_by_relationship', () => {
    it.skipIf(skipTests)('should return structure with query and results', async () => {
      // Find any two pages to test with
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length < 2) {
        console.warn('Not enough pages found for search_by_relationship test');
        return;
      }

      const pageA = searchResult[0];
      const pageB = searchResult[1];
      const pageAName = pageA.name || pageA['original-name'];
      const pageBName = pageB.name || pageB['original-name'];

      if (!pageAName || !pageBName) {
        console.warn('Could not determine page names');
        return;
      }

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

    it.skipIf(skipTests)('should support in-pages-linking-to relationship', async () => {
      // Find any two pages to test with
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
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

    it.skipIf(skipTests)('should support connected-within relationship with maxDistance', async () => {
      // Find any two pages to test with
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
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
    it.skipIf(skipTests)('should return blocks without context when includeContext is false', async () => {
      const results = await searchBlocks(client, 'test', 5, false);

      // Should return results or null
      if (results === null) {
        console.warn('searchBlocks returned null');
        return;
      }

      expect(Array.isArray(results)).toBe(true);

      // Blocks should not have context property when includeContext is false
      if (results.length > 0) {
        expect(results[0]).not.toHaveProperty('context');
      }
    });

    it.skipIf(skipTests)('should include context when includeContext is true', async () => {
      const results = await searchBlocks(client, 'test', 10, true);

      // Should return results or null
      if (results === null) {
        console.warn('searchBlocks returned null');
        return;
      }

      expect(Array.isArray(results)).toBe(true);

      // If there are results, find one with context to validate structure
      if (results.length > 0) {
        // Find a block that has context property (not all blocks may have page info)
        const blockWithContext = results.find(b => b.context !== undefined);

        if (!blockWithContext) {
          console.warn('No blocks with context found in results');
          return;
        }

        // Validate context structure
        expect(blockWithContext.context).toHaveProperty('page');
        expect(blockWithContext.context).toHaveProperty('references');
        expect(blockWithContext.context).toHaveProperty('tags');

        // Validate types
        expect(Array.isArray(blockWithContext.context.references)).toBe(true);
        expect(Array.isArray(blockWithContext.context.tags)).toBe(true);
        expect(blockWithContext.context.page).toHaveProperty('id');
        expect(blockWithContext.context.page).toHaveProperty('name');
      }
    });

    it.skipIf(skipTests)('should extract references from block content', async () => {
      // Search for a common term that's likely to appear with page references
      const results = await searchBlocks(client, '[[', 10, true);

      if (results === null || results.length === 0) {
        console.warn('No blocks with references found');
        return;
      }

      // Find a block that has page references
      const blockWithRefs = results.find(
        b => b.context && b.context.references.length > 0
      );

      if (!blockWithRefs) {
        console.warn('No blocks with references in results');
        return;
      }

      // Validate that extracted references match what's in content
      expect(blockWithRefs.context).toBeDefined();
      expect(blockWithRefs.context!.references.length).toBeGreaterThan(0);

      // Check that at least one reference appears in the content
      const hasMatchingRef = blockWithRefs.context!.references.some(ref =>
        blockWithRefs.content.includes(`[[${ref}]]`)
      );
      expect(hasMatchingRef).toBe(true);
    });

    it.skipIf(skipTests)('should extract tags from block content', async () => {
      // Search for blocks with hashtags
      const results = await searchBlocks(client, '#', 10, true);

      if (results === null || results.length === 0) {
        console.warn('No blocks with tags found');
        return;
      }

      // Find a block that has tags
      const blockWithTags = results.find(
        b => b.context && b.context.tags.length > 0
      );

      if (!blockWithTags) {
        console.warn('No blocks with tags in results');
        return;
      }

      // Validate that extracted tags match what's in content
      expect(blockWithTags.context).toBeDefined();
      expect(blockWithTags.context!.tags.length).toBeGreaterThan(0);

      // Check that at least one tag appears in the content
      const hasMatchingTag = blockWithTags.context!.tags.some(tag =>
        blockWithTags.content.includes(`#${tag}`)
      );
      expect(hasMatchingTag).toBe(true);
    });
  });

  // Display skip reason if tests were skipped
  if (skipTests) {
    it.skip(`Tests skipped: ${skipReason}`, () => {
      // This test is just to display the skip reason
    });
  }
});
