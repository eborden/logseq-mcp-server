import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { buildContextForTopic, getContextForQuery } from './helpers/tools.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Integration tests for build_context and get_context_for_query against the fixture graph.
 *
 * `Bob` (a property block and two blocks, linked from 10 pages), `project atlas` (an alias, 8
 * blocks), a journal, `empty page` (one empty block), `archive` (no file, no blocks) and the hub
 * (every cap bites; tests/fixtures/README.md, "The hub"). Read-only.
 */

const BOB_SOURCES = [
  'alice', 'block refs', 'jan 10th, 2025', 'jan 15th, 2025', 'jan 6th, 2025', 'jan 7th, 2025',
  'project atlas', 'project atlas/meetings', 'project cascade', 'property types',
];

describe('Context Building Tools Integration Tests', () => {
  let client: LogseqClient;

  beforeAll(async () => {
    ({ client } = await connectFixture());
  });

  describe('logseq_build_context', () => {
    it('returns every block, reference and related page of a page under the caps', async () => {
      const result = await buildContextForTopic(client, 'Bob');

      expect(result.topic).toBe('Bob');
      expect(result.mainPage.name).toBe('bob');
      expect(result.directBlocks).toHaveLength(3);
      // Linked references count the blocks under a referencing block too
      expect(result.references).toHaveLength(18);
      expect(result.relatedPages.map(r => `${r.relationshipType} ${r.page.name}`).sort()).toEqual(
        BOB_SOURCES.map(name => `inbound ${name}`)
      );
      expect(result.summary).toEqual({
        totalBlocks: 3,
        totalRelatedPages: 10,
        totalReferences: 18,
        pageProperties: { role: 'engineer' },
      });
      expect(result.totals).toEqual({ blocks: 3, relatedPages: 10, references: 18 });
      expect(result).toMatchObject({ hasMore: false, warnings: [], temporalContext: { isJournal: false } });
      expect(result).not.toHaveProperty('resolvedFrom');
    });

    it('should respect maxBlocks limit, and say what it cut', async () => {
      const result = await buildContextForTopic(client, 'Bob', { maxBlocks: 2 });

      expect(result.directBlocks).toHaveLength(2);
      expect(result.totals.blocks).toBe(3);
      expect(result.hasMore).toBe(true);
      expect(result.warnings.map(w => w.code)).toEqual(['blocks_truncated']);
    });

    it('folds an alias into the page and reports the references it cut', async () => {
      const result = await buildContextForTopic(client, 'project atlas');

      expect(result.resolvedAliases).toEqual(['atlas', 'project atlas']);
      expect(result.directBlocks).toHaveLength(8);
      expect(result.summary.pageProperties).toEqual({
        alias: ['atlas'], type: 'project', status: 'active', owner: ['Alice'],
      });
      expect(result.totals).toEqual({ blocks: 8, relatedPages: 14, references: 24 });
      expect(result.hasMore).toBe(true);
      expect(result.warnings.map(w => w.code)).toEqual(['references_truncated', 'related_pages_truncated']);
    });

    it('cuts every list on the hub and reports the totals', async () => {
      const result = await buildContextForTopic(client, 'hub central');

      expect([result.directBlocks.length, result.references.length, result.relatedPages.length]).toEqual([50, 20, 10]);
      expect(result.totals).toEqual({ blocks: 71, relatedPages: 61, references: 66 });
      expect(result.hasMore).toBe(true);
      expect(result.warnings.map(w => w.code)).toEqual([
        'blocks_truncated', 'references_truncated', 'related_pages_truncated',
      ]);
    });

    it('builds context for a journal page', async () => {
      const result = await buildContextForTopic(client, 'Jan 6th, 2025');

      expect(result.mainPage.name).toBe('jan 6th, 2025');
      expect(result.mainPage['journal?']).toBe(true);
      expect(result.directBlocks).toHaveLength(8);
      expect(result.totals).toEqual({ blocks: 8, relatedPages: 0, references: 0 });
    });

    it('reports a journal page as a journal with its date (#152)', async () => {
      const result = await buildContextForTopic(client, 'Jan 6th, 2025');

      expect(result.mainPage['journal?']).toBe(true);
      expect(result.temporalContext).toEqual({ isJournal: true, date: 20250106 });
    });

    it('returns an empty context for a page with no blocks, and one block for an empty page', async () => {
      const archive = await buildContextForTopic(client, 'archive');
      const empty = await buildContextForTopic(client, 'empty page');

      expect(archive.totals).toEqual({ blocks: 0, relatedPages: 0, references: 0 });
      expect(archive).toMatchObject({ directBlocks: [], relatedPages: [], references: [], hasMore: false });
      expect(empty.totals).toEqual({ blocks: 1, relatedPages: 0, references: 0 });
    });

    it('should throw error for non-existent page', async () => {
      await expect(
        buildContextForTopic(client, 'NonExistentPageForContextBuilding12345')
      ).rejects.toThrow(/^No page "/);
    });
  });

  describe('logseq_get_context_for_query', () => {
    it('should extract topics and build context', async () => {
      const result = await getContextForQuery(client, 'What is [[Bob]]?');

      expect(result.extractedTopics).toEqual(['Bob']);
      expect(result.contexts.map(c => c.topic)).toEqual(['Bob']);
      expect(result.contexts[0].directBlocks).toHaveLength(3);
      expect(result.summary).toEqual({ totalTopics: 1, totalBlocks: 3, totalPages: 6 });
      // Each topic's context is capped tighter than build_context's default
      expect(result.warnings.map(w => w.code)).toEqual(['topic_truncated']);
      expect(result.hasMore).toBe(true);
    });

    it('should handle multiple topics in query', async () => {
      const result = await getContextForQuery(client, 'Compare [[Bob]] and [[Alice]]');

      expect(result.extractedTopics).toEqual(['Bob', 'Alice']);
      expect(result.contexts.map(c => c.topic)).toEqual(['Bob', 'Alice']);
      expect(result.summary).toMatchObject({ totalTopics: 2, totalBlocks: 7 });
      // Each topic keeps 5 related pages, picked by id order among ties, so which ones (and how many
      // they share) changes when LogSeq re-indexes (tests/fixtures/README.md lists this case).
      // Count the distinct pages the contexts hold.
      const pages = new Set(result.contexts.flatMap(c => [c.mainPage.id, ...c.relatedPages.map(r => r.page.id)]));
      expect(result.contexts.map(c => c.relatedPages.length)).toEqual([5, 5]);
      expect(result.summary.totalPages).toBe(pages.size);
    });

    it('falls back to a keyword search that keeps blocks holding every keyword, newest first', async () => {
      const result = await getContextForQuery(client, 'the importer design');

      expect(result.extractedTopics).toEqual([]);
      expect(result.contexts).toEqual([]);
      expect(result.searchResults!.map(b => (b as any).page.name)).toEqual([
        'jan 10th, 2025', 'jan 8th, 2025', 'jan 6th, 2025', 'jan 2nd, 2025',
      ]);
      expect(result.summary).toEqual({ totalTopics: 0, totalBlocks: 4, totalPages: 0 });
      expect(result).toMatchObject({ hasMore: false, warnings: [] });
    });

    it('returns nothing, not an error, for keywords no block holds', async () => {
      const result = await getContextForQuery(client, 'What is machine learning?');

      expect(result.extractedTopics).toEqual([]);
      expect(result.contexts).toEqual([]);
      expect(result.searchResults).toEqual([]);
      expect(result.summary).toEqual({ totalTopics: 0, totalBlocks: 0, totalPages: 0 });
    });

    it('should respect maxTopics limit', async () => {
      const result = await getContextForQuery(client, '[[Bob]] and [[Alice]] and [[project atlas]]', {
        maxTopics: 2
      });

      expect(result.extractedTopics).toEqual(['Bob', 'Alice', 'project atlas']);
      expect(result.contexts.map(c => c.topic)).toEqual(['Bob', 'Alice']);
      expect(result.warnings[0].code).toBe('topics_truncated');
      expect(result.hasMore).toBe(true);
    });
  });
});
