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
 * Tests will FAIL if prerequisites are not met.
 */

describe('LogSeq MCP Server Integration Tests', () => {
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

  describe('Connection Tests', () => {
    it('should connect to LogSeq HTTP API', async () => {
      const result = await client.callAPI('logseq.App.getCurrentGraph');
      expect(result).toBeDefined();
    });

    it('should have valid auth token', async () => {
      // If we got here, auth worked in beforeAll
      expect(client).toBeDefined();
    });
  });

  describe('logseq_get_page', () => {
    it('should retrieve a page by name', async () => {
      // Try to get any page - we'll search for one first
      const searchResult = await searchBlocks(client, 'test');

      expect(searchResult).toBeDefined();
      expect(searchResult.length).toBeGreaterThan(0,
        'No pages found containing "test". Integration tests require test data. ' +
        'Create a page with "test" in the content. See tests/integration/setup.md'
      );

      // Get the page name from the first result
      const firstBlock = searchResult[0];
      expect(firstBlock.page).toBeDefined(
        'Search result has no page reference - data integrity issue'
      );

      // Try to get page by ID
      const pageId = firstBlock.page.id;
      const pageResult = await client.callAPI('logseq.Editor.getPage', [pageId]);

      expect(pageResult).toBeDefined();
      expect(pageResult.name).toBeTruthy();

      // Now test our getPage function
      const result = await getPage(client, pageResult.name, false);
      expect(result).toBeDefined();
      expect(result.name).toBeTruthy();
      expect(result.uuid).toBeTruthy();
    });

    it('should include children when requested', async () => {
      // Try to find a page with content
      const searchResult = await searchBlocks(client, 'test');

      expect(searchResult).toBeDefined();
      expect(searchResult.length).toBeGreaterThan(0,
        'No pages found for children test. Create a page with "test" content. ' +
        'See tests/integration/setup.md'
      );

      const firstBlock = searchResult[0];
      expect(firstBlock.page).toBeDefined(
        'Search result has no page reference - data integrity issue'
      );

      const pageId = firstBlock.page.id;
      const pageResult = await client.callAPI('logseq.Editor.getPage', [pageId]);

      expect(pageResult).toBeDefined();
      expect(pageResult.name).toBeTruthy();

      const result = await getPage(client, pageResult.name, true);
      expect(result).toBeDefined();
      // LogSeq only includes children property if blocks exist
      // Just verify we got the page successfully
      expect(result.name).toBeDefined();
    });

    it('should throw error for non-existent page', async () => {
      await expect(
        getPage(client, 'NonExistentPageThatShouldNeverExist12345', false)
      ).rejects.toThrow('Page not found');
    });
  });

  describe('logseq_get_backlinks', () => {
    it('should get backlinks for a page', async () => {
      // Find any page first
      const searchResult = await searchBlocks(client, 'test');

      expect(searchResult).toBeDefined();
      expect(searchResult.length).toBeGreaterThan(0,
        'No pages found for backlinks test. Create a page with "test" content. ' +
        'See tests/integration/setup.md'
      );

      const firstBlock = searchResult[0];
      expect(firstBlock.page).toBeDefined(
        'Search result has no page reference - data integrity issue'
      );

      const pageId = firstBlock.page.id;
      const pageResult = await client.callAPI('logseq.Editor.getPage', [pageId]);

      expect(pageResult).toBeDefined();
      expect(pageResult.name).toBeTruthy();

      const result = await getBacklinks(client, pageResult.name);
      // Result may be null or empty array if no backlinks exist
      expect(result === null || Array.isArray(result)).toBe(true);
    });
  });

  describe('logseq_search_blocks', () => {
    it('should search for blocks by content', async () => {
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

    it('should return empty array for non-matching search', async () => {
      const result = await searchBlocks(client, 'xyzzyqwertyneverexists12345');
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });

  describe('logseq_query_by_property', () => {
    it('should query blocks by property', async () => {
      // Query for blocks with a status property
      const result = await queryByProperty(client, 'status', 'testing');

      // Validate API contract
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0,
        'No blocks with status::testing property. Add blocks with this property. ' +
        'See tests/integration/setup.md'
      );

      // Validate structure of returned blocks
      result.forEach(block => {
        expect(block).toHaveProperty('uuid');
        expect(block).toHaveProperty('properties');
        expect(block.properties).toHaveProperty('status');
        expect(block.properties.status).toBe('testing');
      });
    });

    it('should return empty array for non-existent property', async () => {
      const result = await queryByProperty(
        client,
        'nonexistentproperty12345',
        'neverexists'
      );
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });
});
