import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_MAX_BLOCKS_PER_PAGE,
  DEFAULT_MAX_PAGES,
  MAX_BLOCKS_PER_PAGE,
  MAX_PAGES,
  getBacklinks,
  getBacklinksWithMeta
} from './get-backlinks.js';
import { LogseqClient } from '../client.js';

// A stand-in alias-group warning, so the caps' warnings can be seen next to it
const aliasWarnings = vi.hoisted(() => ({ current: [] as Array<{ code: string; message: string }> }));
vi.mock('../utils/alias-set.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/alias-set.js')>()),
  aliasSetWarnings: () => [...aliasWarnings.current]
}));

// A made-up source page: `blocks` linking blocks, on a page named `source NNN` (so the alias
// group's name order is the order given) and shown as `Source NNN`
interface Source {
  id: number;
  blocks: number;
}

const name = (id: number) => `source ${String(id).padStart(3, '0')}`;
const originalName = (id: number) => `Source ${String(id).padStart(3, '0')}`;
const blockId = (source: Source, j: number) => source.id * 1000 + j;

/** `n` source pages with `blocks` linking blocks each, ids 1..n */
const sources = (n: number, blocks = 1): Source[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, blocks }));

interface Harness {
  client: LogseqClient;
  /** Calls the code made to the Editor API and to Datalog */
  calls: () => { editor: number; datalog: number };
}

/** What the Editor API's getPageLinkedReferences returns: one [page, blocks] tuple per source page */
function editorTuples(list: Source[]) {
  return list.map(source => [
    { id: source.id, uuid: `page-${source.id}`, name: name(source.id), originalName: originalName(source.id) },
    Array.from({ length: source.blocks }, (_, j) => ({
      id: blockId(source, j),
      uuid: `block-${blockId(source, j)}`,
      content: `Link ${j} [[Target]]`,
      page: { id: source.id }
    }))
  ]);
}

/** A page with no alias: the backlinks come from the Editor API call */
function editorPath(list: Source[] | null): Harness {
  const callAPI = vi.fn().mockResolvedValue(list === null ? null : editorTuples(list));
  const executeDatalogQuery = vi.fn().mockResolvedValue([[{ id: 1, name: 'target', 'original-name': 'Target' }, 'name']]);
  return {
    client: { callAPI, executeDatalogQuery } as unknown as LogseqClient,
    calls: () => ({ editor: callAPI.mock.calls.length, datalog: executeDatalogQuery.mock.calls.length })
  };
}

const target = { id: 1, name: 'target', 'original-name': 'Target', file: { id: 900 }, alias: [{ id: 2 }] };
const alias = { id: 2, name: 'target alias', 'original-name': 'Target Alias', alias: [{ id: 1 }] };
const member = (p: { id: number; name: string; 'original-name': string }) => ({
  id: p.id,
  name: p.name,
  'original-name': p['original-name']
});

/** A page with an alias: the backlinks come from one Datalog query over the group (#69) */
function aliasGroupPath(list: Source[] | null): Harness {
  const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
    if (query.includes(':in $ ?n')) return inputs[0] === 'target alias' ? [[alias, 'name'], [target, 'alias']] : [[target, 'name']];
    if (query.includes('?start')) return [[1, member(target)], [1, member(alias)]];
    if (query.includes(':block/path-refs')) {
      if (list === null) return null;
      // Rows in no particular order: the tool sorts by page name, then block id
      return [...list]
        .reverse()
        .flatMap(source =>
          Array.from({ length: source.blocks }, (_, j) => [
            {
              id: blockId(source, j),
              uuid: `block-${blockId(source, j)}`,
              content: `Link ${j} [[Target]]`,
              page: { id: source.id, name: name(source.id), 'original-name': originalName(source.id) }
            }
          ])
        );
    }
    throw new Error(`unexpected query: ${query}`);
  });
  const callAPI = vi.fn();
  return {
    client: { callAPI, executeDatalogQuery } as unknown as LogseqClient,
    calls: () => ({ editor: callAPI.mock.calls.length, datalog: executeDatalogQuery.mock.calls.length })
  };
}

const paths: Array<[string, (list: Source[] | null) => Harness]> = [
  ['the Editor API path', editorPath],
  ['the alias group Datalog path (#69)', aliasGroupPath]
];

type Tuple = [{ id?: number; originalName?: string } | null, Array<{ id: number }>];
const pageIds = (results: Tuple[] | null) => (results ?? []).map(([page]) => page?.id);
const blockCounts = (results: Tuple[] | null) => (results ?? []).map(([, blocks]) => blocks.length);
/** Each page id with its block ids, to compare two results whole */
const idsOf = (results: Tuple[] | null) => (results ?? []).map(([page, blocks]) => [page?.id, blocks.map(b => b.id)]);
const totalBlocks = (results: Tuple[] | null) => blockCounts(results).reduce((a, b) => a + b, 0);

/** Every `Set <param> to N` in a result's warnings. */
function suggestedValues(meta: { warnings: Array<{ howToFetchAll?: string }> } | null, param: string): number[] {
  return (meta?.warnings ?? []).flatMap(w =>
    [...(w.howToFetchAll ?? '').matchAll(new RegExp(`Set ${param} to (\\d+)`, 'g'))].map(m => Number(m[1]))
  );
}

describe('get_backlinks max_pages and max_blocks_per_page (#61)', () => {
  it('has defaults of 20 pages and 10 blocks, and maximums of 100 and 50', () => {
    expect([DEFAULT_MAX_PAGES, DEFAULT_MAX_BLOCKS_PER_PAGE]).toEqual([20, 10]);
    expect([MAX_PAGES, MAX_BLOCKS_PER_PAGE]).toEqual([100, 50]);
  });

  describe.each(paths)('%s', (_label, harness) => {
    const run = (list: Source[], caps?: Parameters<typeof getBacklinksWithMeta>[2]) =>
      getBacklinksWithMeta(harness(list).client, 'Target', caps);

    describe('below the caps', () => {
      it('returns everything with no meta, whatever the caps, byte for byte', async () => {
        const list = sources(19, 9);
        const outputs = await Promise.all(
          [undefined, { maxPages: 19, maxBlocksPerPage: 9 }, { maxPages: 100, maxBlocksPerPage: 50 }, { maxPages: 5000, maxBlocksPerPage: 5000 }].map(
            async caps => {
              const { results, meta } = await run(list, caps);
              return JSON.stringify({ results, meta });
            }
          )
        );
        expect(new Set(outputs).size).toBe(1);
        const { results, meta } = await run(list);
        expect(pageIds(results)).toEqual(list.map(s => s.id));
        expect(blockCounts(results)).toEqual(list.map(() => 9));
        expect(meta === null || meta.warnings.length === 0).toBe(true);
        expect(meta === null || meta.totals === undefined).toBe(true);
      });

      it('returns the same pages and blocks as before the caps existed', async () => {
        const list = sources(5, 3);
        const { results } = await run(list, { maxPages: 100, maxBlocksPerPage: 50 });
        expect(pageIds(results)).toEqual([1, 2, 3, 4, 5]);
        expect(results!.map(([, blocks]) => blocks.map(b => b.id))).toEqual(list.map(s => [0, 1, 2].map(j => blockId(s, j))));
      });
    });

    describe('at the caps', () => {
      it('returns exactly 20 pages of 10 blocks with no warning and no totals at the defaults', async () => {
        const { results, meta } = await run(sources(DEFAULT_MAX_PAGES, DEFAULT_MAX_BLOCKS_PER_PAGE));
        expect(results).toHaveLength(20);
        expect(blockCounts(results).every(n => n === 10)).toBe(true);
        expect(meta === null || (meta.warnings.length === 0 && meta.totals === undefined && !meta.hasMore)).toBe(true);
      });

      it('adds no warning at a custom cap that equals the size', async () => {
        const { results, meta } = await run(sources(7, 4), { maxPages: 7, maxBlocksPerPage: 4 });
        expect(results).toHaveLength(7);
        expect(totalBlocks(results)).toBe(28);
        expect(meta === null || meta.warnings.length === 0).toBe(true);
      });
    });

    describe('above max_pages', () => {
      it('keeps the first 20 pages (ranked, see the ranking test file) and says how to get them all', async () => {
        const { results, meta } = await run(sources(21, 2));
        expect(pageIds(results)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
        expect(blockCounts(results).every(n => n === 2)).toBe(true);
        expect(meta).toMatchObject({
          hasMore: true,
          totals: { pages: 21, blocks: 42 },
          warnings: [
            {
              code: 'pages_truncated',
              message: 'Showing 20 of 21 source pages, ranked by linking blocks (most first, ties by page name). The last page kept has 2 linking blocks, the first dropped page has 2. Blocks per page are capped separately by max_blocks_per_page.',
              howToFetchAll: 'Set max_pages to 21 (or higher) to get all 21.'
            }
          ]
        });
      });

      it('adds the large-result note only when the pages raised to would pass 200 blocks (#196)', async () => {
        const note = "A result this large may be saved to a file by the host instead of shown; the server can't tell.";
        // 30 pages of 5 blocks: 200 blocks hold 40 pages, so raising to 30 (150 blocks) plausibly comes back inline
        const fits = await run(sources(30, 5), { maxPages: 20 });
        expect(fits.meta!.warnings[0].howToFetchAll).toBe('Set max_pages to 30 (or higher) to get all 30.');
        // 30 pages of 10 blocks (the default per-page cap) is 300 blocks, past 200
        const big = await run(sources(30, 10), { maxPages: 20 });
        expect(big.meta!.warnings[0].howToFetchAll).toBe(`Set max_pages to 30 (or higher) to get all 30. ${note}`);
        // Pages with 50 blocks each are cut to the per-page cap, so the cap sets the count
        const capped = await run(sources(30, 50), { maxPages: 20, maxBlocksPerPage: 5 });
        expect(capped.meta!.warnings.map(w => w.howToFetchAll)).toEqual([
          'Set max_pages to 30 (or higher) to get all 30.',
          `Set max_blocks_per_page to 50 (or higher) to get every block of these pages. ${note}`
        ]);
      });

      it('cuts at a custom cap, and a cap of 0 returns no pages but offers a value', async () => {
        const some = await run(sources(10), { maxPages: 4 });
        expect(pageIds(some.results)).toEqual([1, 2, 3, 4]);
        expect(some.meta!.warnings[0].message).toContain('Showing 4 of 10 source pages');
        expect(some.meta!.warnings[0].howToFetchAll).toBe('Set max_pages to 10 (or higher) to get all 10.');

        const none = await run(sources(3), { maxPages: 0 });
        expect(none.results).toEqual([]);
        expect(none.meta!.warnings[0].message).toBe('Showing 0 of 3 source pages, ranked by linking blocks (most first, ties by page name). Blocks per page are capped separately by max_blocks_per_page.');
        expect(suggestedValues(none.meta, 'max_pages')).toEqual([3]);
      });

      it('floors a fractional cap and treats a negative one as 0', async () => {
        expect(pageIds((await run(sources(6), { maxPages: 2.9 })).results)).toEqual([1, 2]);
        expect((await run(sources(6), { maxPages: -4 })).results).toEqual([]);
      });

      it('names only the pages kept in the per-page warning, but counts the dropped page in the totals', async () => {
        // The dropped page links least, so the ranking puts it last and the cut falls on it
        const { meta } = await run([{ id: 1, blocks: 3 }, { id: 2, blocks: 3 }, { id: 3, blocks: 1 }], { maxPages: 2, maxBlocksPerPage: 1 });
        expect(meta!.warnings.map(w => w.code)).toEqual(['pages_truncated', 'page_blocks_truncated']);
        expect(meta!.warnings[1].message).toContain('2 source pages');
        expect(meta!.warnings[1].message).not.toContain('Source 003');
        expect(meta!.totals).toEqual({ pages: 3, blocks: 7 });
      });

      it('keeps the pages it kept at a larger cap, as a prefix', async () => {
        const list = sources(30, 2);
        const small = pageIds((await run(list, { maxPages: 5 })).results);
        const large = pageIds((await run(list, { maxPages: 12 })).results);
        expect(large.slice(0, 5)).toEqual(small);
      });
    });

    describe('above max_blocks_per_page', () => {
      it('keeps the first 10 blocks of a page with 11 and says how to get them all', async () => {
        const list = [{ id: 1, blocks: 11 }, { id: 2, blocks: 3 }];
        const { results, meta } = await run(list);
        expect(pageIds(results)).toEqual([1, 2]);
        expect(blockCounts(results)).toEqual([10, 3]);
        expect(results![0][1].map(b => b.id)).toEqual(Array.from({ length: 10 }, (_, j) => blockId(list[0], j)));
        expect(meta).toMatchObject({
          hasMore: true,
          totals: { pages: 2, blocks: 14 },
          warnings: [
            {
              code: 'page_blocks_truncated',
              message: 'Showing the first 10 linking blocks of 1 source page with more: "Source 001" (11).',
              howToFetchAll: 'Set max_blocks_per_page to 11 (or higher) to get every block of these pages.'
            }
          ]
        });
        expect(meta!.warnings).toHaveLength(1);
      });

      it('cuts at a custom cap, and a cap of 0 keeps each page with no blocks', async () => {
        const some = await run(sources(3, 8), { maxBlocksPerPage: 5 });
        expect(blockCounts(some.results)).toEqual([5, 5, 5]);
        expect(some.meta!.warnings[0].message).toContain('Showing the first 5 linking blocks of 3 source pages with more:');

        const none = await run(sources(2, 4), { maxBlocksPerPage: 0 });
        expect(pageIds(none.results)).toEqual([1, 2]);
        expect(blockCounts(none.results)).toEqual([0, 0]);
        expect(suggestedValues(none.meta, 'max_blocks_per_page')).toEqual([4]);
      });

      it('floors a fractional cap and treats a negative one as 0', async () => {
        expect(blockCounts((await run(sources(1, 6), { maxBlocksPerPage: 2.9 })).results)).toEqual([2]);
        expect(blockCounts((await run(sources(1, 6), { maxBlocksPerPage: -1 })).results)).toEqual([0]);
      });

      it('names at most five pages and counts the rest', async () => {
        const { meta } = await run(sources(8, 12));
        expect(meta!.warnings[0].message).toBe(
          'Showing the first 10 linking blocks of 8 source pages with more: ' +
            '"Source 001" (12), "Source 002" (12), "Source 003" (12), "Source 004" (12), "Source 005" (12) and 3 more.'
        );
      });

      it('asks for the largest page, not for more than it needs', async () => {
        const { meta } = await run([{ id: 1, blocks: 12 }, { id: 2, blocks: 30 }]);
        expect(suggestedValues(meta, 'max_blocks_per_page')).toEqual([30]);
      });
    });

    describe('both caps at once', () => {
      it('cuts pages, then blocks of the pages kept, with both warnings and the full totals', async () => {
        const list = sources(25, 12);
        const { results, meta } = await run(list);
        expect(results).toHaveLength(20);
        expect(totalBlocks(results)).toBe(200);
        expect(meta!.totals).toEqual({ pages: 25, blocks: 300 });
        expect(meta!.hasMore).toBe(true);
        expect(meta!.warnings.map(w => w.code)).toEqual(['pages_truncated', 'page_blocks_truncated']);
        expect(meta!.warnings[1].message).toContain('of 20 source pages with more');
      });
    });

    describe('at the maximum of 100 pages (#61 acceptance criterion)', () => {
      it('suggests no value past 100 when the cut is below the maximum, and says what is left', async () => {
        const { results, meta } = await run(sources(150), { maxPages: 20 });
        expect(results).toHaveLength(20);
        expect(meta!.hasMore).toBe(true);
        expect(suggestedValues(meta, 'max_pages')).toEqual([100]);
        expect(meta!.warnings[0].howToFetchAll).toContain('Set max_pages to 100 (the maximum) to get 100 of 150.');
        expect(meta!.warnings[0].howToFetchAll).toContain('logseq_search_blocks with query "[[Target]]"');
      });

      it('reports the maximum with hasMore false and no value to raise', async () => {
        const { results, meta } = await run(sources(150), { maxPages: 100 });
        expect(results).toHaveLength(100);
        expect(meta!.hasMore).toBe(false);
        expect(meta!.warnings).toHaveLength(1);
        expect(meta!.warnings[0].code).toBe('pages_truncated');
        expect(meta!.warnings[0].message).toContain('max_pages is capped at its maximum of 100, so the rest can\'t be fetched in one call');
        expect(meta!.warnings[0].message).toContain('logseq_search_blocks with query "[[Target]]"');
        expect(meta!.warnings[0]).not.toHaveProperty('howToFetchAll');
        expect(meta!.totals).toEqual({ pages: 150, blocks: 150 });
      });

      it('clamps a value above the maximum to the same result and names the value asked for', async () => {
        const atMax = await run(sources(150), { maxPages: 100 });
        const above = await run(sources(150), { maxPages: 5000 });
        expect(pageIds(above.results)).toEqual(pageIds(atMax.results));
        expect(above.meta!.hasMore).toBe(false);
        expect(above.meta!.warnings[0].message).toContain('capped at its maximum of 100 (5000 was asked for)');
        expect(suggestedValues(above.meta, 'max_pages')).toEqual([]);
      });

      it('returns everything with no warning when there are exactly 100 pages', async () => {
        const { results, meta } = await run(sources(100), { maxPages: 5000 });
        expect(results).toHaveLength(100);
        expect(meta === null || meta.warnings.length === 0).toBe(true);
      });
    });

    describe('at the maximum of 50 blocks per page (#61 acceptance criterion)', () => {
      it('suggests no value past 50 when the cut is below the maximum, and points at get_page for the rest', async () => {
        const { results, meta } = await run([{ id: 1, blocks: 80 }]);
        expect(blockCounts(results)).toEqual([10]);
        expect(meta!.hasMore).toBe(true);
        expect(suggestedValues(meta, 'max_blocks_per_page')).toEqual([50]);
        expect(meta!.warnings[0].howToFetchAll).toBe(
          'Set max_blocks_per_page to 50 (the maximum) to get 50 per page. logseq_get_page with include_children reads a source page whole.'
        );
      });

      it('reports the maximum with hasMore false and no value to raise', async () => {
        const { results, meta } = await run([{ id: 1, blocks: 80 }], { maxBlocksPerPage: 50 });
        expect(blockCounts(results)).toEqual([50]);
        expect(meta!.hasMore).toBe(false);
        expect(meta!.warnings).toHaveLength(1);
        expect(meta!.warnings[0].code).toBe('page_blocks_truncated');
        expect(meta!.warnings[0].message).toContain(
          'max_blocks_per_page is capped at its maximum of 50, so the rest can\'t be fetched in one call. logseq_get_page with include_children reads a source page whole.'
        );
        expect(meta!.warnings[0].message).not.toContain('was asked for');
        expect(meta!.warnings[0]).not.toHaveProperty('howToFetchAll');
      });

      it('clamps a value above the maximum to the same blocks and names the value asked for', async () => {
        const atMax = await run([{ id: 1, blocks: 80 }], { maxBlocksPerPage: 50 });
        const above = await run([{ id: 1, blocks: 80 }], { maxBlocksPerPage: 5000 });
        expect(idsOf(above.results)).toEqual(idsOf(atMax.results));
        expect(above.meta!.warnings[0].message).toContain('capped at its maximum of 50 (5000 was asked for)');
        expect(above.meta!.hasMore).toBe(false);
      });

      it('returns a page of exactly 50 blocks whole at the maximum', async () => {
        const { results, meta } = await run([{ id: 1, blocks: 50 }], { maxBlocksPerPage: 5000 });
        expect(blockCounts(results)).toEqual([50]);
        expect(meta === null || meta.warnings.length === 0).toBe(true);
      });
    });

    describe('the rest of the result', () => {
      it('makes no call because of the caps', async () => {
        const capped = harness(sources(150, 20));
        await getBacklinksWithMeta(capped.client, 'Target');
        const uncapped = harness(sources(150, 20));
        await getBacklinksWithMeta(uncapped.client, 'Target', { maxPages: 100, maxBlocksPerPage: 50 });
        const small = harness(sources(2));
        await getBacklinksWithMeta(small.client, 'Target');
        expect(capped.calls()).toEqual(small.calls());
        expect(uncapped.calls()).toEqual(small.calls());
      });

      it('getBacklinks takes the same caps', async () => {
        expect(pageIds(await getBacklinks(harness(sources(9)).client, 'Target', { maxPages: 3 }))).toEqual([1, 2, 3]);
        expect(pageIds(await getBacklinks(harness(sources(25)).client, 'Target'))).toHaveLength(20);
      });
    });
  });

  it('keeps a null answer from the Editor API as null, with no meta (BR-0011)', async () => {
    const { results, meta } = await getBacklinksWithMeta(editorPath(null).client, 'Target');
    expect(results).toBeNull();
    expect(meta).toBeNull();
  });

  it('keeps resolvedFrom and resolvedAliases next to the cap warning', async () => {
    const { client } = aliasGroupPath(sources(25, 2));
    const { results, meta } = await getBacklinksWithMeta(client, 'Target Alias', { maxPages: 5 });

    expect(results).toHaveLength(5);
    expect(meta!.resolvedFrom).toBeDefined();
    expect(meta!.resolvedAliases).toEqual(['Target', 'Target Alias']);
    expect(meta!.warnings.map(w => w.code)).toEqual(['pages_truncated']);
    expect(meta!.totals).toEqual({ pages: 25, blocks: 50 });
  });

  it('adds the cap warnings after an alias-group warning, and hasMore follows the caps', async () => {
    aliasWarnings.current = [{ code: 'alias_set_truncated', message: 'The alias group is too big.' }];
    try {
      const { meta } = await getBacklinksWithMeta(editorPath(sources(30)).client, 'Target');
      expect(meta!.warnings.map(w => w.code)).toEqual(['alias_set_truncated', 'pages_truncated']);
      expect(meta!.hasMore).toBe(true);

      // An alias warning alone, with the caps not biting: no totals
      const fits = await getBacklinksWithMeta(editorPath(sources(3)).client, 'Target');
      expect(fits.meta!.warnings.map(w => w.code)).toEqual(['alias_set_truncated']);
      expect(fits.meta!.hasMore).toBe(false);
      expect(fits.meta!.totals).toBeUndefined();
    } finally {
      aliasWarnings.current = [];
    }
  });

  it('gives the Editor path and the alias path the same pages, blocks and cap warnings', async () => {
    const list = [...sources(23, 3), { id: 24, blocks: 14 }];
    const editor = await getBacklinksWithMeta(editorPath(list).client, 'Target');
    const grouped = await getBacklinksWithMeta(aliasGroupPath(list).client, 'Target');

    expect(pageIds(grouped.results)).toEqual(pageIds(editor.results));
    expect(blockCounts(grouped.results)).toEqual(blockCounts(editor.results));
    expect(grouped.meta!.warnings.map(w => w.code)).toEqual(editor.meta!.warnings.map(w => w.code));
    expect(grouped.meta!.warnings.map(w => w.message)).toEqual(editor.meta!.warnings.map(w => w.message));
    expect(grouped.meta!.totals).toEqual(editor.meta!.totals);
  });
});
