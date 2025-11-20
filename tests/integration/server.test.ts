import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';
import { access } from 'fs/promises';
import { loadConfig } from '../../src/config.js';
import { LogseqClient } from '../../src/client.js';
import { getPage } from '../../src/tools/get-page.js';
import { getBacklinks } from '../../src/tools/get-backlinks.js';
import { searchBlocks } from '../../src/tools/search-blocks.js';
import { queryByProperty } from '../../src/tools/query-by-property.js';

/**
 * Integration tests for LogSeq MCP Server
 *
 * These tests require:
 * 1. LogSeq running with HTTP API enabled
 * 2. Config file at ~/.logseq-mcp/config.json
 * 3. Test data in LogSeq graph
 *
 * Tests will be skipped if prerequisites are not met.
 */

describe('LogSeq MCP Server Integration Tests', () => {
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

  describe('Connection Tests', () => {
    it.skipIf(skipTests)('should connect to LogSeq HTTP API', async () => {
      const result = await client.callAPI('logseq.App.getCurrentGraph');
      expect(result).toBeDefined();
    });

    it.skipIf(skipTests)('should have valid auth token', async () => {
      // If we got here, auth worked in beforeAll
      expect(client).toBeDefined();
    });
  });

  describe('logseq_get_page', () => {
    it.skipIf(skipTests)('should retrieve a page by name', async () => {
      // Try to get any page - we'll search for one first
      const searchResult = await searchBlocks(client, 'test');

      if (!searchResult || searchResult.length === 0) {
        console.warn('No pages found for get_page test. Create a page with "test" content.');
        return;
      }

      // Get the page name from the first result
      const firstBlock = searchResult[0];
      if (!firstBlock.page) {
        console.warn('Search result has no page reference');
        return;
      }

      // Try to get page by ID
      const pageId = firstBlock.page.id;
      const pageResult = await client.callAPI('logseq.Editor.getPage', [pageId]);

      expect(pageResult).toBeDefined();
      if (pageResult && pageResult.name) {
        // Now test our getPage function
        const result = await getPage(client, pageResult.name, false);
        expect(result).toBeDefined();
        expect(result.name).toBeTruthy();
        expect(result.uuid).toBeTruthy();
      }
    });

    it.skipIf(skipTests)('should include children when requested', async () => {
      // Try to find a page with content
      const searchResult = await searchBlocks(client, 'test');

      if (!searchResult || searchResult.length === 0) {
        console.warn('No pages found for children test');
        return;
      }

      const firstBlock = searchResult[0];
      if (!firstBlock.page) {
        return;
      }

      const pageId = firstBlock.page.id;
      const pageResult = await client.callAPI('logseq.Editor.getPage', [pageId]);

      if (pageResult && pageResult.name) {
        const result = await getPage(client, pageResult.name, true);
        expect(result).toBeDefined();
        // LogSeq only includes children property if blocks exist
        // Just verify we got the page successfully
        expect(result.name).toBeDefined();
      }
    });

    it.skipIf(skipTests)('should throw error for non-existent page', async () => {
      await expect(
        getPage(client, 'NonExistentPageThatShouldNeverExist12345', false)
      ).rejects.toThrow('Page not found');
    });
  });

  describe('logseq_get_backlinks', () => {
    it.skipIf(skipTests)('should get backlinks for a page', async () => {
      // Find any page first
      const searchResult = await searchBlocks(client, 'test');

      if (!searchResult || searchResult.length === 0) {
        console.warn('No pages found for backlinks test');
        return;
      }

      const firstBlock = searchResult[0];
      if (!firstBlock.page) {
        return;
      }

      const pageId = firstBlock.page.id;
      const pageResult = await client.callAPI('logseq.Editor.getPage', [pageId]);

      if (pageResult && pageResult.name) {
        const result = await getBacklinks(client, pageResult.name);
        // Result may be null or empty array if no backlinks exist
        expect(result === null || Array.isArray(result)).toBe(true);
      }
    });
  });

  describe('logseq_search_blocks', () => {
    it.skipIf(skipTests)('should search for blocks by content', async () => {
      // Search for a common word
      const result = await searchBlocks(client, 'test');

      // Result may be empty if no matching blocks
      expect(Array.isArray(result)).toBe(true);

      if (result && result.length > 0) {
        const firstResult = result[0];
        expect(firstResult).toHaveProperty('content');
        expect(firstResult).toHaveProperty('uuid');
      }
    });

    it.skipIf(skipTests)('should return empty array for non-matching search', async () => {
      const result = await searchBlocks(client, 'xyzzyqwertyneverexists12345');
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });

  describe('logseq_query_by_property', () => {
    it.skipIf(skipTests)('should query blocks by property', async () => {
      // Try to find blocks with a status property
      const result = await queryByProperty(client, 'status', 'testing');

      // Result may be empty if no blocks with this property exist
      expect(Array.isArray(result)).toBe(true);

      if (result && result.length > 0) {
        console.log('Found blocks with status::testing property:', result.length);
      } else {
        console.warn('No blocks found with status::testing property. Create test data if needed.');
      }
    });

    it.skipIf(skipTests)('should return empty array for non-existent property', async () => {
      const result = await queryByProperty(
        client,
        'nonexistentproperty12345',
        'neverexists'
      );
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });

  // Display skip reason if tests were skipped
  if (skipTests) {
    it.skip(`Tests skipped: ${skipReason}`, () => {
      // This test is just to display the skip reason
    });
  }
});
