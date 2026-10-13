import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { findBlocks, findBlocksWithMeta, searchByRelationship } from './helpers/tools.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Integration tests for search_by_relationship (`connected-within`) and find_blocks (with `page`, `links_to` and
 * `include_context`) against the fixture graph.
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

    it('connected-within: adjacent topics are connected whatever the casing', async () => {
      const result = await searchByRelationship(client, 'ALICE', 'BOB', 'connected-within', 1);

      expect(result.results).toHaveLength(7);
    });
  });

  describe('logseq_find_blocks with page and links_to (#492)', () => {
    let idB: number;

    beforeAll(async () => {
      const rows = await client.executeDatalogQuery<Array<[number]>>(
        '[:find ?b :in $ ?n :where [?b :block/name ?n]]', 'bob'
      );
      idB = rows[0][0];
    });

    it('the blocks on page A that link page B', async () => {
      const { results, meta } = await findBlocksWithMeta(client, { page: 'Alice', linksTo: ['Bob'] });

      expect(results.map(b => b.content)).toEqual(['She works with [[Bob]] on the room names.']);
      expect(meta).toEqual({ hasMore: false, warnings: [], totals: { matches: 1 } });
    });

    it('every casing of both names returns the same non-empty result', async () => {
      const lower = await findBlocks(client, { page: 'alice', linksTo: ['bob'] });
      const upper = await findBlocks(client, { page: 'ALICE', linksTo: ['BOB'] });

      expect(lower).toHaveLength(1);
      expect(upper.map(b => b.id).sort()).toEqual(lower.map(b => b.id).sort());
    });

    it('every returned block actually references the linked page, as [[a link]] or #a-tag and not as a word', async () => {
      const results = await findBlocks(client, { linksTo: ['BOB'] }, { limit: 100 });

      // `Bob` is linked by 13 blocks on 10 pages
      expect(results).toHaveLength(13);
      for (const block of results) {
        expect((block.refs || []).map((ref: any) => ref.id)).toContain(idB);
      }
    });

    it('several pages in links_to are all needed: the blocks that link every one of them', async () => {
      const bob = await findBlocks(client, { linksTo: ['bob'] }, { limit: 100 });
      const both = await findBlocks(client, { linksTo: ['bob', 'alice'] }, { limit: 100 });

      // 3 of the 13 blocks that link Bob also link Alice
      expect(both.map(b => b.content).sort()).toEqual([
        'Kickoff for [[project atlas]] with [[Alice]] and [[Bob]] #meeting',
        'Kickoff with [[Alice]] and [[Bob]] #meeting',
        'Two page refs, a multi-value set\nparticipants:: [[Alice]], [[Bob]]',
      ]);
      const ids = new Set(bob.map(b => b.id));
      expect(both.every(b => ids.has(b.id))).toBe(true);
      expect(await findBlocks(client, { linksTo: ['alice', 'bob'] }, { limit: 100 })).toEqual(both);
    });

    it('plain text is not a link: 16 blocks say bob, and the 13 that link him are among them', async () => {
      const said = await findBlocks(client, { text: 'bob' }, { limit: 100 });
      const linked = await findBlocks(client, { linksTo: ['bob'] }, { limit: 100 });

      expect(said).toHaveLength(16);
      const ids = new Set(said.map(b => b.id));
      expect(linked.every(b => ids.has(b.id))).toBe(true);
      expect(linked).toHaveLength(13);
    });

    it('the pages narrow a text search too, and a page nobody links to finds nothing', async () => {
      const room = await findBlocks(client, { text: 'room names', page: 'alice', linksTo: ['bob'] });
      expect(room.map(b => b.content)).toEqual(['She works with [[Bob]] on the room names.']);

      const none = await findBlocksWithMeta(client, { page: 'archive', linksTo: ['bob'] });
      expect(none.results).toEqual([]);
      expect(none.meta).toMatchObject({ hasMore: false, totals: { matches: 0 } });
    });
  });

  describe('find_blocks with includeContext', () => {
    // "test" is in 9 blocks: 3 on `property types`, 3 on the sentinel page, 1 on the hub and the
    // two journals that mention a test plan
    const TEST_PAGES = [
      'hub central', 'jan 10th, 2025', 'jan 8th, 2025', 'logseq-mcp-fixture-sentinel',
      'logseq-mcp-fixture-sentinel', 'logseq-mcp-fixture-sentinel', 'property types', 'property types',
      'property types',
    ];

    it('should return blocks without context when includeContext is false', async () => {
      const results = (await findBlocks(client, { text: 'test' }, { limit: 5, includeContext: false }))!;

      expect(results).toHaveLength(5);
      expect(results.every(b => !('context' in b))).toBe(true);
    });

    it('should include context when includeContext is true', async () => {
      const results = (await findBlocks(client, { text: 'test' }, { limit: 10, includeContext: true }))!;

      expect(results.map(b => b.context!.page.name).sort()).toEqual(TEST_PAGES);
      for (const block of results) {
        expect(Array.isArray(block.context!.references)).toBe(true);
        expect(Array.isArray(block.context!.tags)).toBe(true);
        expect(typeof (block.context!.page as { id?: number }).id).toBe('number');
      }
    });

    it('should extract references from block content', async () => {
      const results = (await findBlocks(client, { text: 'test' }, { limit: 10, includeContext: true }))!;
      const references = results.flatMap(b => b.context!.references).sort();

      // `category:: [[test data]]` and `[[project atlas]]: ... test plan started`
      expect(references).toEqual(['project atlas', 'test data']);
      for (const block of results) {
        const content = String(block.content);
        expect((block.context!.references ?? []).every(ref => content.includes(`[[${ref}]]`))).toBe(true);
      }
    });

    it('should extract tags from block content', async () => {
      const results = (await findBlocks(client, { text: '#meeting' }, { limit: 100, includeContext: true }))!;

      expect(results.map(b => b.context!.page.name).sort()).toEqual([
        'jan 15th, 2025', 'jan 6th, 2025', 'project atlas/meetings', 'project atlas/meetings',
        'project borealis/meetings',
      ]);
      expect(results.every(b => JSON.stringify(b.context!.tags) === '["meeting"]')).toBe(true);
    });
  });
});
