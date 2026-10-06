import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../src/client.js';
import { getPage } from '../../src/tools/get-page.js';
import { getBacklinks } from '../../src/tools/get-backlinks.js';
import { searchBlocks } from '../../src/tools/search-blocks.js';
import { queryByProperty } from '../../src/tools/query-by-property.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Integration tests for the basic tools against the fixture graph: get_page, get_backlinks,
 * search_blocks and query_by_property on known pages. Read-only.
 */

describe('LogSeq MCP Server Integration Tests', () => {
  let client: LogseqClient;

  beforeAll(async () => {
    ({ client } = await connectFixture());
  });

  describe('Connection Tests', () => {
    it('should connect to LogSeq HTTP API', async () => {
      const result = await client.callAPI<{ name: string }>('logseq.App.getCurrentGraph');
      expect(result.name).toBe('graph');
    });
  });

  describe('logseq_get_page', () => {
    it('should retrieve a page by name, in any casing', async () => {
      for (const name of ['property types', 'Property Types']) {
        const result = await getPage(client, name, false);
        expect(result.name, name).toBe('property types');
        expect(result.originalName, name).toBe('property types');
        expect(typeof result.uuid).toBe('string');
        expect(result.resolvedFrom).toBeUndefined();
      }
    });

    it('should include children when requested', async () => {
      const result = await getPage(client, 'property types', true);

      // The page-property block and ten blocks, one per value type
      expect(result.children).toHaveLength(11);
    });

    it('should throw error for non-existent page', async () => {
      await expect(
        getPage(client, 'NonExistentPageThatShouldNeverExist12345', false)
      ).rejects.toThrow(/^No page "/);
    });
  });

  describe('logseq_get_backlinks', () => {
    it('groups the blocks that link a page by their source page', async () => {
      const result = await getBacklinks(client, 'Alice');
      const bySource = Object.fromEntries((result ?? []).map(([page, blocks]) => [page.name, blocks.length]));

      expect(bySource).toEqual({
        'dec 31st, 2024': 1,
        'jan 6th, 2025': 6,
        'jan 7th, 2025': 1,
        'jan 15th, 2025': 1,
        'project atlas': 1,
        'project atlas/meetings': 2,
        'project cascade': 1,
        'property types': 2,
      });
    });

    it('returns nothing for a page no block links', async () => {
      const result = await getBacklinks(client, 'property types');
      expect(result ?? []).toEqual([]);
    });
  });

  describe('logseq_search_blocks', () => {
    it('should search for blocks by content', async () => {
      const result = (await searchBlocks(client, 'importer'))!;

      // The 11 blocks that say "importer": 7 in journals, 4 on pages
      expect(result).toHaveLength(11);
      expect(result.every(b => b.content.toLowerCase().includes('importer'))).toBe(true);
      expect(result.every(b => typeof b.uuid === 'string')).toBe(true);
    });

    it('should return empty array for non-matching search', async () => {
      const result = (await searchBlocks(client, 'xyzzyqwertyneverexists12345'))!;
      expect(result).toEqual([]);
    });
  });

  describe('logseq_query_by_property', () => {
    it('should query blocks by property', async () => {
      const result = (await queryByProperty(client, 'status', 'testing')) as Array<{ content: string; properties?: unknown }>;

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('A text value\nstatus:: testing');
      expect(result[0].properties).toEqual({ status: 'testing' });
    });

    it('should return empty array for non-existent property', async () => {
      const result = await queryByProperty(client, 'nonexistentproperty12345', 'neverexists');
      expect(result).toEqual([]);
    });
  });
});
