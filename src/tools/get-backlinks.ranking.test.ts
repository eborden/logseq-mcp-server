import { describe, it, expect, vi } from 'vitest';
import { capBacklinks, fetchBacklinks, getBacklinksWithMeta, rankBacklinks, type Backlink as BacklinkTuple } from './get-backlinks.js';
import { resolveAliasSet } from '../utils/alias-set.js';
import { LogseqClient } from '../client.js';
import type { BlockEntity, PageEntity } from '../types.js';

/**
 * Source pages come most-linking first, ties by lowercase page name and then id (#178), on
 * the Editor path and on the alias-group path, before and after any cut. Made-up pages only.
 */

interface Source {
  id: number;
  /** Lowercase page name; the shown name is its upper-case twin */
  name: string;
  blocks: number;
}

const blockId = (source: Source, j: number) => source.id * 1000 + j;

/** What the Editor API's getPageLinkedReferences returns: one [page, blocks] tuple per source page */
const editorTuples = (list: Source[]) =>
  list.map(source => [
    { id: source.id, name: source.name, originalName: source.name.toUpperCase() },
    Array.from({ length: source.blocks }, (_, j) => ({
      id: blockId(source, j),
      uuid: `block-${blockId(source, j)}`,
      content: `Link ${j} [[Target]]`,
      page: { id: source.id }
    }))
  ]);

interface Harness {
  client: LogseqClient;
  /** Every API call made, Editor and Datalog */
  calls: () => number;
}

/** A page with no alias: the backlinks come from the Editor API call */
function editorPath(list: Source[] | null): Harness {
  const callAPI = vi.fn().mockResolvedValue(list === null ? null : editorTuples(list));
  const executeDatalogQuery = vi.fn().mockResolvedValue([[{ id: 1, name: 'target', 'original-name': 'Target' }, 'name']]);
  return {
    client: { callAPI, executeDatalogQuery } as unknown as LogseqClient,
    calls: () => callAPI.mock.calls.length + executeDatalogQuery.mock.calls.length
  };
}

const target = { id: 1, name: 'target', 'original-name': 'Target', file: { id: 900 }, alias: [{ id: 2 }] };
const alias = { id: 2, name: 'target alias', 'original-name': 'Target Alias', alias: [{ id: 1 }] };
const member = (p: typeof target | typeof alias) => ({ id: p.id, name: p.name, 'original-name': p['original-name'] });

/** A page with an alias: the backlinks come from one Datalog query over the group (#69) */
function aliasGroupPath(list: Source[] | null): Harness {
  const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
    if (query.includes(':in $ ?n')) return inputs[0] === 'target alias' ? [[alias, 'name'], [target, 'alias']] : [[target, 'name']];
    if (query.includes('?start')) return [[1, member(target)], [1, member(alias)]];
    if (query.includes(':block/path-refs')) {
      if (list === null) return null;
      // Rows in no particular order
      return [...list]
        .reverse()
        .flatMap(source =>
          Array.from({ length: source.blocks }, (_, j) => [
            {
              id: blockId(source, j),
              uuid: `block-${blockId(source, j)}`,
              content: `Link ${j} [[Target]]`,
              page: { id: source.id, name: source.name, 'original-name': source.name.toUpperCase() }
            }
          ])
        );
    }
    throw new Error(`unexpected query: ${query}`);
  });
  const callAPI = vi.fn();
  return {
    client: { callAPI, executeDatalogQuery } as unknown as LogseqClient,
    calls: () => callAPI.mock.calls.length + executeDatalogQuery.mock.calls.length
  };
}

const paths: Array<[string, (list: Source[] | null) => Harness]> = [
  ['the Editor API path', editorPath],
  ['the alias group Datalog path (#69)', aliasGroupPath]
];

type Tuple = [{ id?: number; name?: string } | null, Array<{ id: number }>];
const names = (results: Tuple[] | null) => (results ?? []).map(([page]) => page?.name);
const ids = (results: Tuple[] | null) => (results ?? []).map(([page]) => page?.id);
const counts = (results: Tuple[] | null) => (results ?? []).map(([, blocks]) => blocks.length);

// Listed in an order that is neither by count nor by name
const MIXED: Source[] = [
  { id: 10, name: 'delta', blocks: 1 },
  { id: 11, name: 'alpha', blocks: 2 },
  { id: 12, name: 'echo', blocks: 5 },
  { id: 13, name: 'bravo', blocks: 1 },
  { id: 14, name: 'charlie', blocks: 5 },
  { id: 15, name: 'foxtrot', blocks: 3 }
];
const RANKED = ['charlie', 'echo', 'foxtrot', 'alpha', 'bravo', 'delta'];

describe('get_backlinks ranks source pages by linking blocks (#178)', () => {
  describe.each(paths)('%s', (_label, harness) => {
    const run = (list: Source[], caps?: Parameters<typeof getBacklinksWithMeta>[2]) =>
      getBacklinksWithMeta(harness(list).client, 'Target', caps);

    it('orders pages by block count, most first, ties by page name, with no cap in play', async () => {
      const { results, meta } = await run(MIXED, { maxPages: 100, maxBlocksPerPage: 50 });
      expect(names(results)).toEqual(RANKED);
      expect(counts(results)).toEqual([5, 5, 3, 2, 1, 1]);
      expect(meta === null || meta.warnings.length === 0).toBe(true);
    });

    it('gives the same order at the defaults when nothing is cut', async () => {
      expect(names((await run(MIXED)).results)).toEqual(RANKED);
    });

    it('breaks a tie of count and name by page id', async () => {
      const { results } = await run([
        { id: 30, name: 'same', blocks: 2 },
        { id: 7, name: 'same', blocks: 2 },
        { id: 20, name: 'same', blocks: 2 }
      ]);
      expect(ids(results)).toEqual([7, 20, 30]);
    });

    it('does not depend on the order the fetch listed the pages in', async () => {
      const forward = await run(MIXED);
      const backward = await run([...MIXED].reverse());
      expect(JSON.stringify(backward.results)).toBe(JSON.stringify(forward.results));
    });

    it('keeps the most-linking pages at the max_pages cut, not the first listed', async () => {
      const { results, meta } = await run(MIXED, { maxPages: 3 });
      expect(names(results)).toEqual(['charlie', 'echo', 'foxtrot']);
      expect(meta!.totals).toEqual({ pages: 6, blocks: 17 });
      expect(meta!.warnings[0].code).toBe('pages_truncated');
    });

    it('names the ranking and where the cut fell in the pages_truncated warning', async () => {
      const { meta } = await run(MIXED, { maxPages: 4 });
      const [warning] = meta!.warnings;
      expect(warning.message).toBe(
        'Showing 4 of 6 source pages, ranked by linking blocks (most first, ties by page name). ' +
          'The last page kept has 2 linking blocks, the first dropped page has 1. ' +
          'Blocks per page are capped separately by max_blocks_per_page.'
      );
      expect(warning.message).not.toContain('not ranked');
      expect(warning.howToFetchAll).toBe('Set max_pages to 6 (or higher) to get all 6.');
    });

    it('says so when the cut falls inside a tie', async () => {
      const { meta } = await run(MIXED, { maxPages: 5 });
      expect(meta!.warnings[0].message).toContain('The last page kept has 1 linking block, the first dropped page has 1.');
    });

    it('keeps a smaller cap as a prefix of a larger one', async () => {
      const small = names((await run(MIXED, { maxPages: 2 })).results);
      const large = names((await run(MIXED, { maxPages: 4 })).results);
      expect(large.slice(0, 2)).toEqual(small);
      expect(large).toEqual(RANKED.slice(0, 4));
    });

    it('keeps the order of blocks within a page', async () => {
      const { results } = await run([{ id: 1, name: 'solo', blocks: 4 }]);
      expect(results![0][1].map(b => b.id)).toEqual([1000, 1001, 1002, 1003]);
    });

    it('ranks by the count before the per-page cut, and names the cut pages in rank order', async () => {
      const { results, meta } = await run(MIXED, { maxBlocksPerPage: 2 });
      expect(names(results)).toEqual(RANKED);
      expect(counts(results)).toEqual([2, 2, 2, 2, 1, 1]);
      const warning = meta!.warnings.find(w => w.code === 'page_blocks_truncated')!;
      expect(warning.message).toContain('"CHARLIE" (5), "ECHO" (5), "FOXTROT" (3)');
    });

    it('makes the same calls whether or not the ranking is cut: it costs none', async () => {
      const cut = harness(MIXED);
      await getBacklinksWithMeta(cut.client, 'Target', { maxPages: 2 });
      const whole = harness(MIXED);
      await getBacklinksWithMeta(whole.client, 'Target', { maxPages: 100 });
      expect(cut.calls()).toBe(whole.calls());
    });
  });

  it('leaves a null Editor answer null, with no meta (BR-0011)', async () => {
    const { results, meta } = await getBacklinksWithMeta(editorPath(null).client, 'Target');
    expect(results).toBeNull();
    expect(meta).toBeNull();
  });
});

describe('rankBacklinks and capBacklinks', () => {
  type Backlink = BacklinkTuple;
  const page = (id: number, name: string) => ({ id, name }) as unknown as PageEntity;
  const blocks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }) as BlockEntity);
  const pageIds = (list: Backlink[]) => list.map(([p]) => p?.id);

  it('sorts a copy: the input is not mutated', () => {
    const input: Backlink[] = [[page(1, 'b'), blocks(1)], [page(2, 'a'), blocks(3)]];
    expect(pageIds(rankBacklinks(input))).toEqual([2, 1]);
    expect(pageIds(input)).toEqual([1, 2]);
  });

  it('compares names in plain character order, not by locale', () => {
    const input: Backlink[] = [[page(1, 'b'), blocks(1)], [page(2, 'a-b'), blocks(1)], [page(3, 'a b'), blocks(1)], [page(4, 'a'), blocks(1)]];
    expect(pageIds(rankBacklinks(input))).toEqual([4, 3, 2, 1]);
  });

  it('ranks a tuple with no page by the page of its first block', () => {
    const orphan = (id: number, name: string): Backlink => [
      null,
      [{ id: 1, page: { id, name } } as unknown as BlockEntity]
    ];
    const ranked = rankBacklinks([orphan(2, 'b'), orphan(1, 'a')]);
    expect(ranked.map(([, b]) => (b[0].page as unknown as { id: number }).id)).toEqual([1, 2]);
  });

  it('returns a result that fits both caps ranked, with no warning and no totals', () => {
    const out = capBacklinks([[page(1, 'b'), blocks(1)], [page(2, 'a'), blocks(2)]], 'target');
    expect(pageIds(out.results)).toEqual([2, 1]);
    expect(out.warnings).toEqual([]);
    expect(out.totals).toBeUndefined();
  });

  it('is deterministic whatever order it is given', () => {
    const list: Backlink[] = Array.from({ length: 12 }, (_, i): Backlink => [page(i + 1, `p${i % 4}`), blocks(i % 3)]);
    const shuffled = [...list].sort((a, b) => ((a[0]!.id! * 7) % 11) - ((b[0]!.id! * 7) % 11));
    expect(pageIds(rankBacklinks(shuffled))).toEqual(pageIds(rankBacklinks(list)));
  });
});

describe('fetchBacklinks stays unranked, so build_context keeps its order (#178)', () => {
  it('returns the Editor API tuples in the order LogSeq gave them', async () => {
    const raw = (await fetchBacklinks(editorPath(MIXED).client, 'target')) as unknown as Tuple[];
    expect(names(raw)).toEqual(MIXED.map(s => s.name));
  });

  it('returns the alias group by name, as before', async () => {
    const { client } = aliasGroupPath(MIXED);
    const aliasSet = await resolveAliasSet(client, target as never);
    const raw = (await fetchBacklinks(client, 'target', aliasSet)) as unknown as Tuple[];
    expect(names(raw)).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']);
  });
});

describe('a source page with no name or entity does not break the per-page warning (#190 review)', () => {
  type Backlink = BacklinkTuple;
  type BlockPage = { id: number; name?: string; originalName?: string };
  const block = (id: number, page?: BlockPage) =>
    ({ id, uuid: `b-${id}`, content: 'x [[Target]]', page }) as unknown as BlockEntity;
  const orphan = (blockCount: number, page?: BlockPage): Backlink => [
    null as unknown as PageEntity,
    Array.from({ length: blockCount }, (_, j) => block(j + 1, page))
  ];
  const warningOf = (out: { warnings: Array<{ code: string; message: string }> }) =>
    out.warnings.find(w => w.code === 'page_blocks_truncated')!.message;

  it("names a page-less tuple by its first block's page (capBacklinks)", () => {
    const out = capBacklinks([orphan(3, { id: 5, name: 'solo', originalName: 'Solo' })], 'target', { maxBlocksPerPage: 1 });
    expect(out.results[0][1]).toHaveLength(1);
    expect(warningOf(out)).toContain('"Solo" (3)');
  });

  it("falls back to the first block's page id, then to a neutral label", () => {
    expect(warningOf(capBacklinks([orphan(3, { id: 5 })], 'target', { maxBlocksPerPage: 1 }))).toContain('"5" (3)');
    expect(warningOf(capBacklinks([orphan(3)], 'target', { maxBlocksPerPage: 1 }))).toContain('"unknown page" (3)');
  });

  it('works through the Editor path, which can return a tuple with no page', async () => {
    const callAPI = vi.fn().mockResolvedValue([orphan(3, { id: 5, name: 'solo' })]);
    const executeDatalogQuery = vi.fn().mockResolvedValue([[{ id: 1, name: 'target', 'original-name': 'Target' }, 'name']]);
    const client = { callAPI, executeDatalogQuery } as unknown as LogseqClient;
    const { results, meta } = await getBacklinksWithMeta(client, 'Target', { maxBlocksPerPage: 1 });
    expect(results![0][1]).toHaveLength(1);
    expect(meta!.warnings.find(w => w.code === 'page_blocks_truncated')!.message).toContain('"solo" (3)');
  });

  it('works through the alias group path when the blocks name their page by id only', async () => {
    // The group query's rows carry a page with just an id; the tuple's page is that bare entity
    const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
      if (query.includes(':in $ ?n')) return inputs[0] === 'target alias' ? [[alias, 'name'], [target, 'alias']] : [[target, 'name']];
      if (query.includes('?start')) return [[1, member(target)], [1, member(alias)]];
      if (query.includes(':block/path-refs')) return [1, 2, 3].map(id => [{ id, uuid: `b-${id}`, content: 'x', page: { id: 77 } }]);
      throw new Error(`unexpected query: ${query}`);
    });
    const client = { callAPI: vi.fn(), executeDatalogQuery } as unknown as LogseqClient;
    const { results, meta } = await getBacklinksWithMeta(client, 'Target', { maxBlocksPerPage: 1 });
    expect(results![0][1]).toHaveLength(1);
    expect(meta!.warnings.find(w => w.code === 'page_blocks_truncated')!.message).toContain('"77" (3)');
  });
});
