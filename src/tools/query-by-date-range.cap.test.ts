import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_DATE_RANGE_MAX_BLOCKS,
  MAX_DATE_RANGE_BLOCKS,
  queryJournals,
  type DateRangeOptions
} from './query-by-date-range.js';
import { fakeRefGraph, uuidN } from '../../tests/helpers/ref-graph.js';
import type { LogseqClient } from '../client.js';

// A stand-in alias-group warning, so the cap's warning can be seen next to it
const aliasWarnings = vi.hoisted(() => ({ current: [] as Array<{ code: string; message: string }> }));
vi.mock('../utils/alias-set.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/alias-set.js')>()),
  aliasSetWarnings: () => [...aliasWarnings.current]
}));

/** A journal page on day number `day` (made-up YYYYMMDD numbers, not calendar-checked). */
const journalPage = (id: number, day: number) => ({
  id,
  uuid: `page-uuid-${id}`,
  name: `day ${day}`,
  'original-name': `Day ${day}`,
  'journal-day': day,
  'journal?': true
});

const CONCEPT_A = { id: 900, name: 'atlas', 'original-name': 'Atlas' };
const CONCEPT_B = { id: 901, name: 'birch', 'original-name': 'Birch' };

/** A flat block the way the range query pulls it; `left` is the previous sibling, or the parent. */
const flatBlock = (id: number, pageId: number, parent: number, left: number, refs: unknown[] = [], content = `b${id}`) => ({
  id,
  uuid: uuidN(id),
  content,
  format: 'markdown',
  page: { id: pageId },
  parent: { id: parent },
  left: { id: left },
  refs
});

/** One journal day: `days` pages from `first`, each with `perDay` top-level blocks (ids from 1000 * page id). */
function days(count: number, perDay: number, first = 20250101) {
  const pages = Array.from({ length: count }, (_, i) => journalPage(i + 1, first + i));
  const blocks = pages.flatMap(page =>
    Array.from({ length: perDay }, (_, k) => {
      const id = page.id * 1000 + k + 1;
      const previous = k === 0 ? page.id : id - 1;
      return flatBlock(id, page.id, page.id, previous);
    })
  );
  return { pages, blocks };
}

function clientWith(data: { pages: unknown[]; blocks: unknown[] }, extra?: (query: string, inputs: unknown[]) => unknown) {
  const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
    const other = extra?.(query, inputs);
    if (other !== undefined) return other;
    if (query.includes('?alias-mid')) return [];
    return query.includes(':block/page ?page') ? data.blocks.map(b => [b]) : data.pages.map(p => [p]);
  });
  return { client: { executeDatalogQuery } as unknown as LogseqClient, executeDatalogQuery };
}

const range = (count: number, extra: Partial<DateRangeOptions> = {}): DateRangeOptions => ({
  startDate: 20250101,
  endDate: 20250100 + count,
  ...extra
});

const run = async (data: ReturnType<typeof days>, options: DateRangeOptions) =>
  (await queryJournals(clientWith(data).client, options)) as any;

/** Every block in the trees, nested ones included. */
const listed = (blocks: any[]): number => blocks.reduce((sum, b) => sum + 1 + listed(b.children ?? []), 0);
const blocksIn = (result: any) => result.entries.reduce((sum: number, e: any) => sum + listed(e.blocks), 0);
const topLevelIn = (result: any) => result.entries.reduce((sum: number, e: any) => sum + e.blocks.length, 0);

/** Every `Set max_blocks to N` in the result's warnings. */
const suggestedValues = (result: any): number[] =>
  (result.warnings ?? []).flatMap((w: any) =>
    [...(w.howToFetchAll ?? '').matchAll(/Set max_blocks to (\d+)/g)].map(m => Number(m[1]))
  );

const noMeta = (result: any) => {
  expect(Object.keys(result)).not.toContain('hasMore');
  expect(Object.keys(result)).not.toContain('warnings');
  expect(Object.keys(result)).not.toContain('totals');
};

describe('queryJournals max_blocks (#61)', () => {
  it('has a default of 200 and a maximum of 1000', () => {
    expect(DEFAULT_DATE_RANGE_MAX_BLOCKS).toBe(200);
    expect(MAX_DATE_RANGE_BLOCKS).toBe(1000);
  });

  describe('below the cap', () => {
    it('returns every block and adds no meta', async () => {
      const result = await run(days(3, 66), range(3));
      expect(topLevelIn(result)).toBe(198);
      noMeta(result);
    });

    it.each([
      ['full', {}],
      ['slim', { slimResults: true }],
      ['outline', { includeContent: false }],
      ['with a search term', { searchTerm: 'b' }]
    ])('is byte-identical whatever the cap, while every block fits (%s)', async (_label, extra) => {
      const outputs = await Promise.all(
        [undefined, 198, 200, 1000, 5000].map(async maxBlocks =>
          JSON.stringify(await run(days(3, 66), range(3, { ...extra, maxBlocks })))
        )
      );
      expect(new Set(outputs).size).toBe(1);
    });
  });

  describe('at the cap', () => {
    it('returns exactly 200 with no meta at the default', async () => {
      const result = await run(days(4, 50), range(4));
      expect(blocksIn(result)).toBe(200);
      noMeta(result);
    });

    it('returns exactly the cap with no meta at a custom cap', async () => {
      const result = await run(days(2, 3), range(2, { maxBlocks: 6 }));
      expect(blocksIn(result)).toBe(6);
      noMeta(result);
    });
  });

  describe('above the cap', () => {
    it('cuts at the default of 200 and says how to get them all', async () => {
      const result = await run(days(3, 67), range(3)); // 201 blocks
      expect(blocksIn(result)).toBe(200);
      expect(result.hasMore).toBe(true);
      expect(result.totals).toEqual({ blocks: 201, days: 3 });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].code).toBe('blocks_truncated');
      expect(result.warnings[0].message).toBe(
        'Showing 200 of 201 blocks (nested ones counted; oldest day first; the entries end at 20250103).'
      );
      expect(result.warnings[0].howToFetchAll).toBe('Set max_blocks to 201 (or higher) to get all 201.');
    });

    it('cuts at a custom cap and keeps whole days before the cut', async () => {
      const result = await run(days(3, 4), range(3, { maxBlocks: 6 }));
      expect(result.entries.map((e: any) => [e.date, e.blocks.length])).toEqual([
        [20250101, 4],
        [20250102, 2]
      ]);
      expect(result.warnings[0].message).toContain('Showing 6 of 12 blocks');
    });

    it('keeps the days in the same order as without a cap, oldest first', async () => {
      const full = await run(days(5, 3), range(5));
      const cut = await run(days(5, 3), range(5, { maxBlocks: 7 }));
      expect(cut.entries.map((e: any) => e.date)).toEqual([20250101, 20250102, 20250103]);
      expect(cut.entries[0]).toEqual(full.entries[0]);
      expect(cut.entries[1]).toEqual(full.entries[1]);
      expect(cut.entries[2].blocks).toEqual(full.entries[2].blocks.slice(0, 1));
    });

    it('drops the days after the last kept block, empty ones too', async () => {
      const data = days(4, 2);
      data.blocks = data.blocks.filter((b: any) => b.page.id !== 3); // day 3 is empty
      const result = await run(data, range(4, { maxBlocks: 2 }));
      expect(result.entries.map((e: any) => e.date)).toEqual([20250101]);
      expect(result.warnings[0].message).toContain('the entries end at 20250101');
    });

    it('keeps an empty day that comes before the cut', async () => {
      const data = days(3, 2);
      data.blocks = data.blocks.filter((b: any) => b.page.id !== 1); // day 1 is empty
      const result = await run(data, range(3, { maxBlocks: 3 }));
      expect(result.entries.map((e: any) => [e.date, e.blocks.length])).toEqual([
        [20250101, 0],
        [20250102, 2],
        [20250103, 1]
      ]);
    });

    it('returns no entries for a cap of 0 and offers a value to raise it to', async () => {
      const result = await run(days(2, 3), range(2, { maxBlocks: 0 }));
      expect(result.entries).toEqual([]);
      expect(result.warnings[0].message).toBe('Showing 0 of 6 blocks (nested ones counted; oldest day first).');
      expect(suggestedValues(result)).toEqual([6]);
      expect(result.summary.totalBlocks).toBe(6);
    });

    it('floors a fractional cap and treats a negative one as 0', async () => {
      expect(blocksIn(await run(days(1, 5), range(1, { maxBlocks: 2.9 })))).toBe(2);
      expect(blocksIn(await run(days(1, 5), range(1, { maxBlocks: -4 })))).toBe(0);
    });

    it('costs no extra API call', async () => {
      const { client, executeDatalogQuery } = clientWith(days(3, 10));
      await queryJournals(client, range(3, { maxBlocks: 5 }));
      expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe('what a block is: nested blocks count', () => {
    /** One day (page 100): block 1 with children 2 and 3 (3 has child 4), then block 5 with child 6. */
    const nestedDay = () => ({
      pages: [journalPage(100, 20250101)],
      blocks: (
        [
          [1, 100, 100],
          [2, 1, 1],
          [3, 1, 2],
          [4, 3, 3],
          [5, 100, 1],
          [6, 5, 5]
        ] as const
      ).map(([id, parent, left]) => flatBlock(id, 100, parent, left))
    });
    const shape = (blocks: any[]): any[] => blocks.map(b => [b.id, shape(b.children ?? [])]);

    it('keeps the first blocks in document order, a block before its children', async () => {
      const full = await run(nestedDay(), range(1));
      expect(shape(full.entries[0].blocks)).toEqual([
        [1, [[2, []], [3, [[4, []]]]]],
        [5, [[6, []]]]
      ]);
      expect(blocksIn(full)).toBe(6);

      expect(shape((await run(nestedDay(), range(1, { maxBlocks: 1 }))).entries[0].blocks)).toEqual([[1, []]]);
      expect(shape((await run(nestedDay(), range(1, { maxBlocks: 2 }))).entries[0].blocks)).toEqual([[1, [[2, []]]]]);
      expect(shape((await run(nestedDay(), range(1, { maxBlocks: 4 }))).entries[0].blocks)).toEqual([
        [1, [[2, []], [3, [[4, []]]]]]
      ]);
      expect(shape((await run(nestedDay(), range(1, { maxBlocks: 5 }))).entries[0].blocks)).toEqual([
        [1, [[2, []], [3, [[4, []]]]]],
        [5, []]
      ]);
    });

    it('says the cut can leave a block with fewer children, only when a day was cut part-way', async () => {
      const cut = await run(nestedDay(), range(1, { maxBlocks: 2 }));
      expect(cut.warnings[0].message).toContain('nested ones counted');
      expect(cut.hasMore).toBe(true);
      expect(cut.totals).toEqual({ blocks: 6, days: 1 });
    });

    it('counts a search term match with its descendants', async () => {
      const data = nestedDay();
      data.blocks[0] = { ...data.blocks[0], content: 'needle here' };
      const result = await run(data, range(1, { searchTerm: 'needle', maxBlocks: 2 }));
      expect(shape(result.entries[0].blocks)).toEqual([[1, [[2, []]]]]);
      expect(result.totals).toEqual({ blocks: 4, days: 1 });
    });

    it('counts only top-level blocks for the outline, which lists them as snippets', async () => {
      const result = await run(nestedDay(), range(1, { includeContent: false, maxBlocks: 1 }));
      expect(result.entries).toEqual([
        { date: 20250101, pageName: 'Day 20250101', blockCount: 4, snippets: ['b1'] }
      ]);
      expect(result.warnings[0].message).toContain('Showing 1 of 2 blocks (top-level only;');
      expect(result.totals).toEqual({ blocks: 2, days: 1 });
    });

    it('keeps the outline whole when the top-level blocks fit, however many nested ones there are', async () => {
      const result = await run(nestedDay(), range(1, { includeContent: false, maxBlocks: 2 }));
      expect(result.entries[0].blockCount).toBe(6);
      noMeta(result);
    });
  });

  describe('the summary covers every block found', () => {
    const withConcepts = () => {
      const data = days(3, 2);
      data.blocks = data.blocks.map((b: any, i) => ({ ...b, refs: i % 2 === 0 ? [CONCEPT_A] : [CONCEPT_B] }));
      return data;
    };

    it('keeps totalDays, totalBlocks and topConcepts over all of them', async () => {
      const cut = await run(withConcepts(), range(3, { maxBlocks: 2 }));
      const full = await run(withConcepts(), range(3));
      expect(topLevelIn(cut)).toBe(2);
      expect(cut.summary).toEqual(full.summary);
      expect(cut.summary.totalDays).toBe(3);
      expect(cut.summary.totalBlocks).toBe(6);
      expect(cut.summary.topConcepts).toEqual([
        { name: 'Atlas', count: 3, days: 3 },
        { name: 'Birch', count: 3, days: 3 }
      ]);
    });

    it('does the same for the outline', async () => {
      const cut = await run(withConcepts(), range(3, { includeContent: false, maxBlocks: 2 }));
      expect(cut.summary.totalBlocks).toBe(6);
      expect(cut.summary.topConcepts).toHaveLength(2);
    });
  });

  describe('slim output and resolve_refs', () => {
    it('slims only the kept blocks', async () => {
      const result = await run(days(3, 4), range(3, { slimResults: true, maxBlocks: 5 }));
      expect(result.entries.map((e: any) => e.blocks.length)).toEqual([4, 1]);
      expect(result.entries[0].pageName).toBe('Day 20250101');
      expect(result.warnings[0].code).toBe('blocks_truncated');
    });

    const REF_KEPT = uuidN(70);
    const REF_CUT = uuidN(71);
    const refData = () => {
      const data = days(2, 2);
      data.blocks[0] = { ...data.blocks[0], content: `kept ((${REF_KEPT}))` };
      data.blocks[2] = { ...data.blocks[2], content: `cut ((${REF_CUT}))` };
      return data;
    };
    const refGraph = () =>
      fakeRefGraph({
        pages: ['Elsewhere'],
        blocks: [
          { uuid: REF_KEPT, content: 'quoted words', page: 'Elsewhere' },
          { uuid: REF_CUT, content: 'other words', page: 'Elsewhere' }
        ]
      });

    function withRefs(data = refData()) {
      const graph = refGraph();
      const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
        if (query.includes(':block/uuid ?u') || query.includes(':block/name ?n')) {
          return graph.executeDatalogQuery(query, ...inputs);
        }
        return query.includes(':block/page ?page') ? data.blocks.map(b => [b]) : data.pages.map(p => [p]);
      });
      return { client: { executeDatalogQuery } as unknown as LogseqClient, calls: executeDatalogQuery };
    }
    const refQueries = (calls: ReturnType<typeof vi.fn>) =>
      calls.mock.calls.map(([query]) => String(query)).filter(q => q.includes(':block/uuid ?u'));

    it('resolves the kept blocks only, and leaves them exactly as an uncut resolve does', async () => {
      const uncut = (await queryJournals(withRefs().client, range(2, { resolveRefs: true }))) as any;
      const { client, calls } = withRefs();
      const cut = (await queryJournals(client, range(2, { resolveRefs: true, maxBlocks: 2 }))) as any;

      expect(cut.entries).toHaveLength(1);
      expect(cut.entries[0].blocks).toEqual(uncut.entries[0].blocks);
      expect(cut.entries[0].blocks[0].resolvedContent).toContain('quoted words');
      expect(refQueries(calls).length).toBeGreaterThan(0);
      expect(refQueries(calls).every(q => q.includes(REF_KEPT) && !q.includes(REF_CUT))).toBe(true);
    });

    it('keeps the cut warning and totals next to the resolve meta', async () => {
      const { client } = withRefs();
      const cut = (await queryJournals(client, range(2, { resolveRefs: true, maxBlocks: 2 }))) as any;
      expect(cut.warnings.map((w: any) => w.code)).toEqual(['blocks_truncated']);
      expect(cut.totals).toEqual({ blocks: 4, days: 2 });
      expect(cut.hasMore).toBe(true);
    });

    it('makes no resolve query when only the cut blocks hold a ref', async () => {
      const data = days(2, 2);
      data.blocks[2] = { ...data.blocks[2], content: `cut ((${REF_CUT}))` };
      const uncut = withRefs(data);
      await queryJournals(uncut.client, range(2, { resolveRefs: true }));
      expect(refQueries(uncut.calls).length).toBeGreaterThan(0);

      const cut = withRefs(data);
      await queryJournals(cut.client, range(2, { resolveRefs: true, maxBlocks: 2 }));
      expect(refQueries(cut.calls)).toHaveLength(0);
      expect(cut.calls).toHaveBeenCalledTimes(2);
    });
  });

  describe('last_n: newest day first', () => {
    const NOW = new Date(2025, 0, 20);

    it('cuts the older days and says to continue with older ones', async () => {
      const { client } = clientWith(days(5, 4));
      const result = (await queryJournals(client, { lastN: 5, maxBlocks: 6 }, NOW)) as any;
      expect(result.entries.map((e: any) => [e.date, e.blocks.length])).toEqual([
        [20250105, 4],
        [20250104, 2]
      ]);
      expect(result.dateRange).toEqual({ start: 20250101, end: 20250105 });
      expect(result.warnings[0].message).toBe(
        'Showing 6 of 20 blocks (nested ones counted; newest day first; the entries end at 20250104).'
      );
    });

    it('names the older range to query once the total passes the maximum', async () => {
      const { client } = clientWith(days(11, 100));
      const result = (await queryJournals(client, { lastN: 11, maxBlocks: 1000 }, NOW)) as any;
      expect(blocksIn(result)).toBe(1000);
      // ten whole days kept, so nothing repeats and the next day down is 20250101
      expect(result.warnings[0].message).toContain('the entries end at 20250102');
      expect(result.warnings[0].message).toContain('Query start_date 20250101 with end_date 20250101 for the older days, or add a search_term.');
      expect(result.warnings[0].message).not.toContain('repeats');
    });
  });

  describe('at the maximum of 1000 (#61 acceptance criterion)', () => {
    const big = () => days(11, 100); // 1100 blocks

    it('suggests no value past 1000 when the cut is below the maximum', async () => {
      const result = await run(big(), range(11, { maxBlocks: 200 }));
      expect(blocksIn(result)).toBe(200);
      expect(result.hasMore).toBe(true);
      expect(suggestedValues(result)).toEqual([1000]);
      expect(result.warnings[0].howToFetchAll).toContain('Query start_date 20250103 with end_date 20250111 for the later days');
    });

    it('says the maximum was reached, with no howToFetchAll and hasMore false', async () => {
      const result = await run(big(), range(11, { maxBlocks: 1000 }));
      expect(blocksIn(result)).toBe(1000);
      expect(result.hasMore).toBe(false);
      expect(result.totals).toEqual({ blocks: 1100, days: 11 });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].code).toBe('blocks_truncated');
      expect(result.warnings[0].howToFetchAll).toBeUndefined();
      expect(result.warnings[0].message).toContain('Showing 1000 of 1100 blocks');
      expect(result.warnings[0].message).toContain('maximum of 1000');
      expect(result.warnings[0].message).toContain("can't be fetched in one call");
    });

    it('clamps a larger request to 1000 and says what was asked for', async () => {
      const result = await run(big(), range(11, { maxBlocks: 5000 }));
      expect(blocksIn(result)).toBe(1000);
      expect(result.hasMore).toBe(false);
      expect(result.warnings[0].howToFetchAll).toBeUndefined();
      expect(result.warnings[0].message).toContain('5000 was asked for');
    });

    it('returns everything for a larger request when there are 1000 or fewer', async () => {
      const result = await run(days(10, 100), range(10, { maxBlocks: 5000 }));
      expect(blocksIn(result)).toBe(1000);
      noMeta(result);
    });

    it('never offers a value above 1000 for any cap', async () => {
      for (const maxBlocks of [0, 1, 500, 999, 1000, 1001, 100_000]) {
        const result = await run(days(12, 100), range(12, { maxBlocks }));
        expect(blocksIn(result)).toBeLessThanOrEqual(1000);
        for (const value of suggestedValues(result)) expect(value).toBeLessThanOrEqual(1000);
      }
    });
  });

  // What a narrower date range reaches: whole days after the cut, never part of one day
  describe('what narrower dates can reach', () => {
    it('names the day to continue from and says it repeats its kept blocks when it was cut part-way', async () => {
      const result = await run(days(11, 100), range(11, { maxBlocks: 1000, startDate: 20250101, endDate: 20250111 }));
      // 1000 blocks end exactly on day 10, so the cut falls between days and nothing repeats
      expect(result.warnings[0].message).toContain('the entries end at 20250110');
      expect(result.warnings[0].message).toContain('Query start_date 20250111 with end_date 20250111 for the later days, or add a search_term.');
      expect(result.warnings[0].message).not.toContain('repeats');
      expect(result.warnings[0].message).not.toContain('narrowest');
    });

    it('repeats the day that was split, and says a day is the narrowest range', async () => {
      const data = days(3, 400); // 1200 blocks; the cut at 1000 falls inside day 3
      const result = await run(data, range(3, { maxBlocks: 1000 }));
      expect(result.entries.map((e: any) => e.blocks.length)).toEqual([400, 400, 200]);
      const message = result.warnings[0].message;
      expect(message).toContain('the entries end at 20250103');
      expect(message).toContain('Query start_date 20250103 with end_date 20250103 for the later days (that day repeats its kept blocks), or add a search_term.');
      expect(message).toContain("A day is the narrowest date range, so a day with more than 1000 blocks can't be fetched whole.");
      expect(message).toContain('The last kept block may show fewer children than it has.');
    });

    it('does not claim a children cut for the outline, which has no children', async () => {
      const data = days(3, 400);
      const result = await run(data, range(3, { includeContent: false, maxBlocks: 1000 }));
      expect(result.warnings[0].message).toContain('the entries end at 20250103');
      expect(result.warnings[0].message).not.toContain('fewer children');
    });

    it('offers no resume day when the cap keeps nothing', async () => {
      const result = await run(days(11, 100), range(11, { maxBlocks: 0 }));
      expect(result.warnings[0].message).toBe('Showing 0 of 1100 blocks (nested ones counted; oldest day first).');
      expect(result.warnings[0].howToFetchAll).toContain('Narrow the dates or last_n, or add a search_term.');
      expect(result.warnings[0].howToFetchAll).not.toContain('Query start_date');
    });

    it('uses the range the caller gave, not the days that have a journal', async () => {
      const result = await run(days(11, 100), { startDate: 20250101, endDate: 20250131, maxBlocks: 200 });
      expect(result.warnings[0].howToFetchAll).toContain('start_date 20250103 with end_date 20250131');
    });
  });

  describe('with other meta', () => {
    const jordan = { id: 800, name: 'jordan', 'original-name': 'Jordan' };
    const rivera = { id: 801, name: 'jordan rivera', 'original-name': 'Jordan Rivera' };
    const jordanData = (perDay: number) => {
      const data = days(2, perDay);
      data.blocks = data.blocks.map((b: any) => ({ ...b, content: `Jordan note ${b.id}` }));
      return data;
    };
    const aliasClient = (data: ReturnType<typeof days>) =>
      clientWith(data, query => (query.includes('?alias-mid') ? [[jordan, jordan], [jordan, rivera]] : undefined));

    it('adds the cap warning after an alias warning, with no extra API call', async () => {
      aliasWarnings.current = [{ code: 'alias_set_truncated', message: 'The alias group is too big.' }];
      try {
        const { client, executeDatalogQuery } = aliasClient(jordanData(5));
        const result = (await queryJournals(client, range(2, { maxBlocks: 3, searchTerm: 'Jordan' }))) as any;
        expect(result.warnings.map((w: any) => w.code)).toEqual(['alias_set_truncated', 'blocks_truncated']);
        expect(result.hasMore).toBe(true);
        expect(result.resolvedAliases).toEqual(['Jordan', 'Jordan Rivera']);
        // pages, blocks, and the one alias-group lookup for the search term
        expect(executeDatalogQuery).toHaveBeenCalledTimes(3);
      } finally {
        aliasWarnings.current = [];
      }
    });

    it('keeps an alias warning alone, with no totals, when nothing is cut', async () => {
      aliasWarnings.current = [{ code: 'alias_set_truncated', message: 'The alias group is too big.' }];
      try {
        const result = (await queryJournals(aliasClient(jordanData(2)).client, range(2, { searchTerm: 'Jordan' }))) as any;
        expect(result.warnings.map((w: any) => w.code)).toEqual(['alias_set_truncated']);
        expect(Object.keys(result)).not.toContain('totals');
      } finally {
        aliasWarnings.current = [];
      }
    });
  });
});
