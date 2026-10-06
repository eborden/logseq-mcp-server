import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../src/client.js';
import { searchByRelationship } from '../../src/tools/search-by-relationship.js';
import { searchBlocks } from '../../src/tools/search-blocks.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Integration tests for search_by_relationship and search_blocks against the fixture graph.
 *
 * `Alice` and `Bob` link each other; 13 blocks on 10 pages link `Bob`; `archive` has no links at
 * all. Read-only.
 */

describe('Semantic Search Integration Tests', () => {
  let client: LogseqClient;

  beforeAll(async () => {
    ({ client } = await connectFixture());
  });

  describe('logseq_search_by_relationship', () => {
    it('references: the blocks on topic A that link topic B', async () => {
      const result = await searchByRelationship(client, 'Alice', 'Bob', 'references');

      expect(result.query).toEqual({ topicA: 'Alice', topicB: 'Bob', relationshipType: 'references' });
      expect(result.relationshipType).toBe('references');
      expect(result.results.map(b => b.content)).toEqual(['She works with [[Bob]] on the room names.']);
      expect(result).toMatchObject({ hasMore: false, warnings: [] });
    });

    it('in-pages-linking-to: blocks linking topic A, on pages that link topic B', async () => {
      const result = await searchByRelationship(client, 'alice', 'bob', 'in-pages-linking-to');

      expect(result.relationshipType).toBe('in-pages-linking-to');
      expect(result.results).toHaveLength(8);
      expect(result.results.every(b => (b.refs ?? []).length > 0)).toBe(true);
    });

    it('connected-within: adjacent pages return the blocks of both', async () => {
      const result = await searchByRelationship(client, 'Alice', 'Bob', 'connected-within', 1);

      expect(result.query.maxDistance).toBe(1);
      // Alice's property block and 3 blocks, Bob's property block and 2 blocks
      expect(result.results).toHaveLength(7);
    });

    it('connected-within: a page with no links is connected to nothing', async () => {
      const result = await searchByRelationship(client, 'archive', 'Bob', 'connected-within', 3);

      expect(result.results).toEqual([]);
    });
  });

  describe('logseq_search_by_relationship casing (issue #7)', () => {
    let idB: number;

    beforeAll(async () => {
      const rows = await client.executeDatalogQuery<Array<[number]>>(
        '[:find ?b :in $ ?n :where [?b :block/name ?n]]', 'bob'
      );
      idB = rows[0][0];
    });

    it('references: every casing of topicB returns the same non-empty result', async () => {
      const lower = await searchByRelationship(client, 'alice', 'bob', 'references');
      const upper = await searchByRelationship(client, 'ALICE', 'BOB', 'references');

      expect(lower.results).toHaveLength(1);
      expect(upper.results.map(b => b.id).sort()).toEqual(lower.results.map(b => b.id).sort());
    });

    it('references: every returned block actually references topicB', async () => {
      const result = await searchByRelationship(client, 'alice', 'BOB', 'references');

      expect(result.results).toHaveLength(1);
      for (const block of result.results) {
        expect((block.refs || []).map((ref: any) => ref.id)).toContain(idB);
      }
    });

    it('in-pages-linking-to: is case-insensitive in both topics', async () => {
      // Every block that links Bob is on a page that links Bob
      const lower = await searchByRelationship(client, 'bob', 'bob', 'in-pages-linking-to');
      const upper = await searchByRelationship(client, 'BOB', 'BOB', 'in-pages-linking-to');

      expect(lower.results).toHaveLength(13);
      expect(upper.results.map(b => b.id).sort()).toEqual(lower.results.map(b => b.id).sort());
    });

    it('connected-within: adjacent topics are connected whatever the casing', async () => {
      const result = await searchByRelationship(client, 'ALICE', 'BOB', 'connected-within', 1);

      expect(result.results).toHaveLength(7);
    });
  });

  describe('enhanced search_blocks with includeContext', () => {
    // "test" is in 9 blocks: 3 on `property types`, 3 on the sentinel page, 1 on the hub and the
    // two journals that mention a test plan
    const TEST_PAGES = [
      'hub central', 'jan 10th, 2025', 'jan 8th, 2025', 'logseq-mcp-fixture-sentinel',
      'logseq-mcp-fixture-sentinel', 'logseq-mcp-fixture-sentinel', 'property types', 'property types',
      'property types',
    ];

    it('should return blocks without context when includeContext is false', async () => {
      const results = (await searchBlocks(client, 'test', 5, false))!;

      expect(results).toHaveLength(5);
      expect(results.every(b => !('context' in b))).toBe(true);
    });

    it('should include context when includeContext is true', async () => {
      const results = (await searchBlocks(client, 'test', 10, true))!;

      expect(results.map(b => b.context!.page.name).sort()).toEqual(TEST_PAGES);
      for (const block of results) {
        expect(Array.isArray(block.context!.references)).toBe(true);
        expect(Array.isArray(block.context!.tags)).toBe(true);
        expect(typeof (block.context!.page as { id?: number }).id).toBe('number');
      }
    });

    it('should extract references from block content', async () => {
      const results = (await searchBlocks(client, 'test', 10, true))!;
      const references = results.flatMap(b => b.context!.references).sort();

      // `category:: [[test data]]` and `[[project atlas]]: ... test plan started`
      expect(references).toEqual(['project atlas', 'test data']);
      for (const block of results) {
        const content = String(block.content);
        expect((block.context!.references ?? []).every(ref => content.includes(`[[${ref}]]`))).toBe(true);
      }
    });

    it('should extract tags from block content', async () => {
      const results = (await searchBlocks(client, '#meeting', 100, true))!;

      expect(results.map(b => b.context!.page.name).sort()).toEqual([
        'jan 15th, 2025', 'jan 6th, 2025', 'project atlas/meetings', 'project atlas/meetings',
        'project borealis/meetings',
      ]);
      expect(results.every(b => JSON.stringify(b.context!.tags) === '["meeting"]')).toBe(true);
    });
  });
});
