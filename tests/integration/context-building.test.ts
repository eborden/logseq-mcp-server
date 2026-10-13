import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { exploreContext } from './helpers/tools.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Integration tests for explore_context against the fixture graph.
 *
 * `Bob` (a property block and two blocks, linked from 10 pages), `project atlas` (an alias, 8
 * blocks), a journal, `empty page` (one empty block), `archive` (no file, no blocks) and the hub
 * (every cap bites; tests/fixtures/README.md, "The hub"). Read-only.
 */

const BOB_SOURCES = [
  'alice', 'block refs', 'jan 10th, 2025', 'jan 15th, 2025', 'jan 6th, 2025', 'jan 7th, 2025',
  'project atlas', 'project atlas/meetings', 'project cascade', 'property types',
];

/** The source page of each reference, in the order the tool returned them. */
const sources = (result: any): string[] => result.references.map((reference: any) => reference.sourcePage.name);

describe('logseq_explore_context', () => {
  let client: LogseqClient;

  beforeAll(async () => {
    ({ client } = await connectFixture());
  });

  it('returns every block, reference and related page of a page under the caps', async () => {
    const result = await exploreContext(client, 'Bob');

    expect(result.page).toBe('Bob');
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

  it('ranks the references by the blocks a page links with, most first, ties by page name', async () => {
    const result = await exploreContext(client, 'Bob');

    expect(sources(result)).toEqual([
      ...Array(6).fill('jan 6th, 2025'),
      ...Array(2).fill('project atlas'),
      ...Array(2).fill('project atlas/meetings'),
      ...Array(2).fill('property types'),
      'alice', 'block refs', 'jan 10th, 2025', 'jan 15th, 2025', 'jan 7th, 2025', 'project cascade',
    ]);
  });

  it('should respect maxBlocks limit, and say what it cut', async () => {
    const result = await exploreContext(client, 'Bob', { maxBlocks: 2 });

    expect(result.directBlocks).toHaveLength(2);
    expect(result.totals.blocks).toBe(3);
    expect(result.hasMore).toBe(true);
    expect(result.warnings.map(w => w.code)).toEqual(['blocks_truncated']);
  });

  it('folds an alias into the page and reports the references it cut', async () => {
    const result = await exploreContext(client, 'project atlas');

    expect(result.resolvedAliases).toEqual(['atlas', 'project atlas']);
    expect(result.directBlocks).toHaveLength(8);
    expect(result.summary.pageProperties).toEqual({
      alias: ['atlas'], type: 'project', status: 'active', owner: ['Alice'],
    });
    expect(result.totals).toEqual({ blocks: 8, relatedPages: 14, references: 24 });
    expect(result.hasMore).toBe(true);
    expect(result.warnings.map(w => w.code)).toEqual(['references_truncated', 'related_pages_truncated']);
    // the cut references name the offset that reads on
    expect(result.warnings[0].howToFetchAll).toBe(
      'Set references_offset to 20 for the next page. Or set max_references to 24 (or higher) to get all 24 in one call.'
    );
  });

  it('cuts every list on the hub and reports the totals', async () => {
    const result = await exploreContext(client, 'hub central');

    expect([result.directBlocks.length, result.references.length, result.relatedPages.length]).toEqual([50, 20, 10]);
    expect(result.totals).toEqual({ blocks: 71, relatedPages: 61, references: 66 });
    expect(result.hasMore).toBe(true);
    expect(result.warnings.map(w => w.code)).toEqual([
      'blocks_truncated', 'references_truncated', 'related_pages_truncated',
    ]);
  });

  describe('references_offset', () => {
    it('pages through every reference once, in the order of one call that holds them all', async () => {
      const all = await exploreContext(client, 'project atlas', { maxReferences: 100 });
      const ids = (result: any): number[] => result.references.map((reference: any) => reference.block.id);
      expect(ids(all)).toHaveLength(24);
      // the ranking puts the 7 blocks of the busiest page first, and a page's blocks together
      expect(sources(all).slice(0, 7)).toEqual(Array(7).fill('jan 6th, 2025'));

      const pages = [
        await exploreContext(client, 'project atlas', { maxReferences: 10, referencesOffset: 0 }),
        await exploreContext(client, 'project atlas', { maxReferences: 10, referencesOffset: 10 }),
        await exploreContext(client, 'project atlas', { maxReferences: 10, referencesOffset: 20 }),
      ];
      expect(pages.map(page => page.references.length)).toEqual([10, 10, 4]);
      expect(pages.flatMap(ids)).toEqual(ids(all));
      // every page carries the same totals, and the blocks and related pages it was asked for
      for (const page of pages) expect(page.totals).toEqual({ blocks: 8, relatedPages: 14, references: 24 });

      // the first two say where to read on, and the last has no references warning
      expect(pages[0].warnings[0]).toMatchObject({
        code: 'references_truncated',
        message: 'Showing 10 of 24 references. Page through the rest with references_offset.',
      });
      expect(pages[1].warnings[0]).toMatchObject({
        code: 'references_truncated',
        message: 'Showing 10 of 14 references from offset 10. Page through the rest with references_offset.',
      });
      expect(pages[1].warnings[0].howToFetchAll).toMatch(/^Set references_offset to 20 for the next page\./);
      expect(pages[2].warnings.map(w => w.code)).not.toContain('references_truncated');
    });

    it('reads nothing, and says nothing was cut, at or past the last reference', async () => {
      for (const referencesOffset of [24, 25, 1000]) {
        const result = await exploreContext(client, 'project atlas', { referencesOffset });
        expect(result.references).toEqual([]);
        expect(result.totals.references).toBe(24);
        expect(result.warnings.map(w => w.code)).not.toContain('references_truncated');
      }
    });

    it('lets a later page leave the blocks and the related pages out', async () => {
      const result = await exploreContext(client, 'hub central', { referencesOffset: 20, maxBlocks: 0, maxRelatedPages: 0 });

      expect(result.directBlocks).toEqual([]);
      expect(result.relatedPages).toEqual([]);
      expect(result.references).toHaveLength(20);
      expect(result.totals).toEqual({ blocks: 71, relatedPages: 61, references: 66 });
      expect(result.warnings.find(w => w.code === 'references_truncated')?.message).toBe(
        'Showing 20 of 46 references from offset 20. Page through the rest with references_offset.'
      );
    });
  });

  it('builds context for a journal page', async () => {
    const result = await exploreContext(client, 'Jan 6th, 2025');

    expect(result.mainPage.name).toBe('jan 6th, 2025');
    expect(result.mainPage['journal?']).toBe(true);
    expect(result.directBlocks).toHaveLength(8);
    expect(result.totals).toEqual({ blocks: 8, relatedPages: 0, references: 0 });
  });

  it('reports a journal page as a journal with its date (#152)', async () => {
    const result = await exploreContext(client, 'Jan 6th, 2025');

    expect(result.mainPage['journal?']).toBe(true);
    expect(result.temporalContext).toEqual({ isJournal: true, date: 20250106 });
  });

  it('returns an empty context for a page with no blocks, and one block for an empty page', async () => {
    const archive = await exploreContext(client, 'archive');
    const empty = await exploreContext(client, 'empty page');

    expect(archive.totals).toEqual({ blocks: 0, relatedPages: 0, references: 0 });
    expect(archive).toMatchObject({ directBlocks: [], relatedPages: [], references: [], hasMore: false });
    expect(empty.totals).toEqual({ blocks: 1, relatedPages: 0, references: 0 });
  });

  it('should throw error for non-existent page', async () => {
    await expect(
      exploreContext(client, 'NonExistentPageForContextBuilding12345')
    ).rejects.toThrow(/^No page "/);
  });
});
