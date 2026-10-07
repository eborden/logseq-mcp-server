import { describe, it, expect, vi } from 'vitest';
import { queryJournals, MAX_DATE_RANGE_BLOCKS } from './query-by-date-range.js';
import { InvalidParameterError } from '../errors.js';
import { DATE_PRESETS } from '../utils/date-presets.js';
import { LARGE_RESULT_NOTE } from '../utils/result-meta.js';
import type { LogseqClient } from '../client.js';

// Wednesday 2025-01-15, local time
const NOW = new Date(2025, 0, 15, 12, 30);

const journalPage = (id: number, day: number) => ({
  id,
  uuid: `page-uuid-${id}`,
  name: `day ${day}`,
  'original-name': `Day ${day}`,
  'journal-day': day,
  'journal?': true
});

/**
 * A top-level block the way the range query pulls it. `content` and `refs` are left off
 * when omitted, since LogSeq leaves a key off a block that has none.
 */
const topBlock = (id: number, pageId: number, left: number, content?: string, refs?: unknown[]) => ({
  id,
  uuid: `block-uuid-${id}`,
  ...(content === undefined ? {} : { content }),
  format: 'markdown',
  page: { id: pageId },
  parent: { id: pageId },
  left: { id: left },
  ...(refs === undefined ? {} : { refs })
});

/** The cells the first column of each Datalog row holds; `null` is a row whose entity is absent. */
interface Data {
  pages: unknown[];
  blocks: unknown[];
}

/** A client that answers the journal-page query, the block query and the alias-group query by their text. */
function fakeClient(data: Data, group: Array<{ id: number; name: string; 'original-name': string }> = []) {
  const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
    if (query.includes('?alias-mid')) {
      const start = group.find(page => page.name === inputs[0]);
      return start ? group.map(page => [start, page]) : [];
    }
    return (query.includes(':block/page ?page') ? data.blocks : data.pages).map(cell => [cell]);
  });
  return { client: { executeDatalogQuery } as unknown as LogseqClient, executeDatalogQuery };
}

/** A client that must never be called. */
function unusedClient() {
  const executeDatalogQuery = vi.fn();
  return { client: { executeDatalogQuery } as unknown as LogseqClient, executeDatalogQuery };
}

/** Journal days from 20250101 holding `counts[i]` top-level blocks each. */
function daysOf(counts: number[]): Data {
  const pages = counts.map((_, i) => journalPage(i + 1, 20250101 + i));
  const blocks = pages.flatMap((page, i) =>
    Array.from({ length: counts[i] }, (_, k) => {
      const id = page.id * 10_000 + k + 1;
      return topBlock(id, page.id, k === 0 ? page.id : id - 1, `b${id}`);
    })
  );
  return { pages, blocks };
}

const run = async (data: Data, options: Parameters<typeof queryJournals>[1]) =>
  (await queryJournals(fakeClient(data).client, options, NOW)) as any;

const blockIds = (result: any): number[] =>
  result.entries.flatMap((entry: any) => entry.blocks.map((block: any) => block.id));

/** The message an InvalidParameterError built from these arguments carries. */
const invalid = (...args: ConstructorParameters<typeof InvalidParameterError>) =>
  new InvalidParameterError(...args);

describe('queryJournals: what the validation errors say', () => {
  it('names the three ways to choose a range when none is given', async () => {
    const { client } = unusedClient();

    await expect(queryJournals(client, {}, NOW)).rejects.toThrow(
      invalid(
        'date selection',
        'none given',
        'Exactly one of: start_date with end_date, last_n, or preset',
        'last_n: 7, or preset: "last_week", or start_date: 20251115 with end_date: 20251120'
      )
    );
  });

  it('names the groups given together, and what to do about it', async () => {
    const { client } = unusedClient();

    await expect(queryJournals(client, { startDate: 20250101, lastN: 3 }, NOW)).rejects.toThrow(
      invalid(
        'date selection',
        'start_date/end_date and last_n',
        'Exactly one of: start_date with end_date, last_n, or preset (not several together)',
        'last_n: 7'
      )
    );
  });

  it.each([0, -2, 2.5])('says what last_n must be when it is %s', async lastN => {
    const { client, executeDatalogQuery } = unusedClient();

    await expect(queryJournals(client, { lastN }, NOW)).rejects.toThrow(
      invalid('last_n', String(lastN), 'A whole number of journal pages, 1 or more', 'last_n: 7')
    );
    expect(executeDatalogQuery).not.toHaveBeenCalled();
  });

  it('lists the presets and shows one when the preset is unknown', async () => {
    const { client } = unusedClient();

    await expect(queryJournals(client, { preset: 'weekly' }, NOW)).rejects.toThrow(
      invalid('preset', 'weekly', `One of: ${DATE_PRESETS.join(', ')}`, 'preset: "last_week"')
    );
  });

  it.each([
    ['end_date', { startDate: 20250101 }],
    ['start_date', { endDate: 20250105 }]
  ])('says %s is missing when only the other bound is given', async (missing, selection) => {
    const { client, executeDatalogQuery } = unusedClient();

    await expect(queryJournals(client, selection, NOW)).rejects.toThrow(
      invalid(
        missing,
        'missing',
        'Both start_date and end_date when choosing an explicit range',
        'start_date: 20251115, end_date: 20251120'
      )
    );
    expect(executeDatalogQuery).not.toHaveBeenCalled();
  });

  it('says what a valid start_date is, with an example', async () => {
    const { client } = unusedClient();

    await expect(queryJournals(client, { startDate: 99999999, endDate: 20251120 }, NOW)).rejects.toThrow(
      invalid(
        'start_date',
        99999999,
        'Date in YYYYMMDD format (8 digits, valid year/month/day)',
        '20251115 for November 15, 2025'
      )
    );
  });

  it('says what a valid end_date is, with an example', async () => {
    const { client } = unusedClient();

    await expect(queryJournals(client, { startDate: 20251115, endDate: 20251399 }, NOW)).rejects.toThrow(
      invalid(
        'end_date',
        20251399,
        'Date in YYYYMMDD format (8 digits, valid year/month/day)',
        '20251120 for November 20, 2025'
      )
    );
  });

  it('names both dates and the order they must be in when the range runs backwards', async () => {
    const { client } = unusedClient();

    await expect(queryJournals(client, { startDate: 20250105, endDate: 20250101 }, NOW)).rejects.toThrow(
      invalid(
        'date_range',
        '20250105 to 20250101',
        'start_date must be before or equal to end_date',
        'start_date: 20251115, end_date: 20251120'
      )
    );
  });

  it.each([-1, 1.5])('says what top_concepts_limit must be when it is %s', async topConceptsLimit => {
    const { client, executeDatalogQuery } = unusedClient();

    await expect(queryJournals(client, { lastN: 3, topConceptsLimit }, NOW)).rejects.toThrow(
      invalid(
        'top_concepts_limit',
        String(topConceptsLimit),
        'A whole number, 0 or more (0 leaves topConcepts out)',
        'top_concepts_limit: 10'
      )
    );
    expect(executeDatalogQuery).not.toHaveBeenCalled();
  });
});

describe('queryJournals: the edges of a valid YYYYMMDD date', () => {
  // The first and last day the format allows: year 1900..2100, month 1..12, day 1..31
  it.each([19000101, 21001231])('accepts %i as the start and as the end', async day => {
    const asStart = await queryJournals(fakeClient({ pages: [], blocks: [] }).client, { startDate: day, endDate: 21001231 }, NOW);
    const asEnd = await queryJournals(fakeClient({ pages: [], blocks: [] }).client, { startDate: 19000101, endDate: day }, NOW);

    expect(asStart.dateRange).toEqual({ start: day, end: 21001231 });
    expect(asEnd.dateRange).toEqual({ start: 19000101, end: day });
  });

  it.each([
    ['year 1899', 18991231],
    ['year 2101', 21010101],
    ['month 0', 20250015],
    ['month 13', 20251315],
    ['day 0', 20250100],
    ['day 32', 20250132]
  ])('rejects %s, as the start and as the end', async (_label, day) => {
    const { client, executeDatalogQuery } = unusedClient();

    await expect(queryJournals(client, { startDate: day, endDate: 20251231 }, NOW)).rejects.toThrow(
      /^Invalid parameter 'start_date'/
    );
    await expect(queryJournals(client, { startDate: 20250101, endDate: day }, NOW)).rejects.toThrow(
      /^Invalid parameter 'end_date'/
    );
    expect(executeDatalogQuery).not.toHaveBeenCalled();
  });
});

describe('queryJournals: rows LogSeq answers with an absent entity', () => {
  it('skips a journal row whose page is null', async () => {
    const page = journalPage(1, 20250101);
    const data: Data = { pages: [null, page], blocks: [topBlock(10, 1, 1, 'kept')] };

    const result = await run(data, { startDate: 20250101, endDate: 20250105 });

    expect(result.entries.map((entry: any) => entry.date)).toEqual([20250101]);
    expect(blockIds(result)).toEqual([10]);
  });

  it('skips a block row whose block is null', async () => {
    const data: Data = { pages: [journalPage(1, 20250101)], blocks: [null, topBlock(10, 1, 1, 'kept')] };

    const result = await run(data, { startDate: 20250101, endDate: 20250105 });

    expect(blockIds(result)).toEqual([10]);
    expect(result.summary).toMatchObject({ totalDays: 1, totalBlocks: 1 });
  });
});

describe('queryJournals: a block with no content', () => {
  const page = journalPage(1, 20250101);
  const bare = topBlock(10, 1, 1); // LogSeq leaves `content` off an empty block
  const written = topBlock(11, 1, 10, 'written here');

  it('shows an empty snippet in the outline', async () => {
    const result = await run({ pages: [page], blocks: [bare, written] }, { startDate: 20250101, endDate: 20250105, includeContent: false });

    expect(result.entries[0].snippets).toEqual(['', 'written here']);
  });

  it('matches no search term', async () => {
    // the term is in the second block's text only
    const result = await run({ pages: [page], blocks: [bare, written] }, { startDate: 20250101, endDate: 20250105, searchTerm: 'here' });

    expect(blockIds(result)).toEqual([11]);
  });
});

describe('queryJournals: the snippet of a block in the outline', () => {
  const outlineSnippets = async (...contents: string[]) => {
    const page = journalPage(1, 20250101);
    const blocks = contents.map((content, i) => topBlock(10 + i, 1, i === 0 ? 1 : 9 + i, content));
    const result = await run({ pages: [page], blocks }, { startDate: 20250101, endDate: 20250105, includeContent: false });
    return result.entries[0].snippets as string[];
  };

  it('keeps a first line of exactly 80 characters whole and shortens one of 81 to 77 plus an ellipsis', async () => {
    const [exact, over] = await outlineSnippets('a'.repeat(80), 'b'.repeat(81));

    expect(exact).toBe('a'.repeat(80));
    expect(over).toBe(`${'b'.repeat(77)}...`);
  });

  it('trims the first line before measuring and returning it', async () => {
    // 70 characters of text in 85 of line: only the trimmed length is under 80
    const [padded, indented] = await outlineSnippets(`   ${'c'.repeat(70)}${' '.repeat(12)}\nsecond line`, '\t indented');

    expect(padded).toBe('c'.repeat(70));
    expect(indented).toBe('indented');
  });
});

describe('queryJournals: search_term on a page with aliases only follows the group', () => {
  const jordan = { id: 1, name: 'jordan', 'original-name': 'Jordan' };
  const jordanRivera = { id: 2, name: 'jordan rivera', 'original-name': 'Jordan Rivera' };
  const atlas = { id: 7, name: 'atlas', 'original-name': 'Atlas' };
  const group = [jordan, jordanRivera];

  it('does not match a block that references some other page', async () => {
    const data: Data = {
      pages: [journalPage(50, 20250101)],
      blocks: [
        topBlock(10, 50, 50, 'Met Jordan', [jordan]),
        topBlock(11, 50, 10, 'Sync on the roadmap', [atlas]),
        topBlock(12, 50, 11, 'Notes', [jordanRivera]), // matches by its ref alone
        topBlock(13, 50, 12, 'Lunch', [])
      ]
    };

    const result: any = await queryJournals(
      fakeClient(data, group).client,
      { startDate: 20250101, endDate: 20250101, searchTerm: 'Jordan' },
      NOW
    );

    expect(blockIds(result)).toEqual([10, 12]);
    expect(result.resolvedAliases).toEqual(['Jordan', 'Jordan Rivera']);
  });

  it('does not match a block whose only ref is to another page, even when the text names nobody', async () => {
    const data: Data = {
      pages: [journalPage(50, 20250101)],
      blocks: [topBlock(11, 50, 50, 'Sync on the roadmap', [atlas])]
    };

    const result: any = await queryJournals(
      fakeClient(data, group).client,
      { startDate: 20250101, endDate: 20250101, searchTerm: 'Jordan' },
      NOW
    );

    expect(result.entries).toEqual([]);
    expect(result.summary).toMatchObject({ totalDays: 0, totalBlocks: 0 });
  });
});

describe('queryJournals: the blocks_truncated warning at its boundaries', () => {
  it('offers the exact total when a cap of 0 cuts exactly the maximum', async () => {
    const result = await run(daysOf([500, 500]), { startDate: 20250101, endDate: 20250102, maxBlocks: 0 });

    expect(result.entries).toEqual([]);
    expect(result.totals).toEqual({ blocks: 1000, days: 2 });
    expect(result.warnings[0].howToFetchAll).toBe(`Set max_blocks to 1000 (or higher) to get all 1000. ${LARGE_RESULT_NOTE}`);
  });

  it('offers the maximum, not the total, when a cap of 0 cuts more than the maximum', async () => {
    const result = await run(daysOf([500, 501]), { startDate: 20250101, endDate: 20250102, maxBlocks: 0 });

    expect(result.warnings[0].howToFetchAll).toBe(
      `Set max_blocks to ${MAX_DATE_RANGE_BLOCKS} (the maximum) to get ${MAX_DATE_RANGE_BLOCKS} of 1001. ` +
        `Narrow the dates or last_n, or add a search_term. ${LARGE_RESULT_NOTE}`
    );
  });

  describe('a cut inside a day that fits the cap', () => {
    // 3 blocks on day 1, then a day of N: with a cap of 5, 2 of the N are kept
    it.each([
      ['fewer blocks than the cap', 4],
      ['exactly as many blocks as the cap', 5]
    ])('pages from that day, naming the later days, when it holds %s and another day follows', async (_label, size) => {
      const result = await run(daysOf([3, size, 2]), { startDate: 20250101, endDate: 20250103, maxBlocks: 5 });

      expect(result.entries.map((entry: any) => entry.blocks.length)).toEqual([3, 2]);
      expect(result.warnings[0].howToFetchAll).toBe(
        'Call again with start_date 20250102, the same end_date (20250103) and the same max_blocks ' +
          'to read the later days (day 20250102 repeats its kept blocks), or add a search_term.'
      );
    });

    it('reads the rest of that day when it holds exactly as many blocks as the cap and is the last one', async () => {
      const result = await run(daysOf([3, 5]), { startDate: 20250101, endDate: 20250102, maxBlocks: 5 });

      expect(result.entries.map((entry: any) => entry.blocks.length)).toEqual([3, 2]);
      expect(result.warnings[0].howToFetchAll).toBe(
        'Call again with start_date 20250102, the same end_date (20250102) and the same max_blocks ' +
          'to read the rest of day 20250102 (it repeats its kept blocks), or add a search_term.'
      );
    });
  });

  describe('a day alone that fits the maximum but not the cap', () => {
    it('reads the day whole when it holds exactly the maximum, rather than calling it unfetchable', async () => {
      const result = await run(daysOf([1000]), { startDate: 20250101, endDate: 20250101 });

      expect(result.entries.map((entry: any) => entry.blocks.length)).toEqual([200]);
      expect(result.warnings[0].message).toBe(
        'Showing 200 of 1000 blocks (nested ones counted; oldest day first; the entries end at 20250101). ' +
          'Day 20250101 alone holds 1000 blocks, more than 200, so a query from it returns the same blocks at this max_blocks.'
      );
      expect(result.warnings[0].howToFetchAll).toBe(
        'To read it whole, call again with start_date 20250101, end_date 20250101 and max_blocks 1000. ' +
          `${LARGE_RESULT_NOTE} If it comes back saved, read the day in pieces with a search_term.`
      );
    });

    it('ends the advice at the search_term when no day follows', async () => {
      const result = await run(daysOf([300]), { startDate: 20250101, endDate: 20250101 });

      expect(result.warnings[0].howToFetchAll).toBe(
        'To read it whole, call again with start_date 20250101, end_date 20250101 and max_blocks 300. ' +
          `${LARGE_RESULT_NOTE} If it comes back saved, read the day in pieces with a search_term.`
      );
    });
  });

  describe('a cut at the maximum', () => {
    it('does not say what was asked for when the request was exactly the maximum', async () => {
      const result = await run(daysOf(Array(11).fill(100)), { startDate: 20250101, endDate: 20250111, maxBlocks: 1000 });

      expect(result.warnings[0].message).toBe(
        'Showing 1000 of 1100 blocks (nested ones counted; oldest day first; the entries end at 20250110): ' +
          "max_blocks is capped at its maximum of 1000, so the rest can't be fetched in one call."
      );
    });

    it('says what was asked for when the request was above the maximum', async () => {
      const result = await run(daysOf(Array(11).fill(100)), { startDate: 20250101, endDate: 20250111, maxBlocks: 1001 });

      expect(result.warnings[0].message).toBe(
        'Showing 1000 of 1100 blocks (nested ones counted; oldest day first; the entries end at 20250110): ' +
          "max_blocks is capped at its maximum of 1000 (1001 was asked for), so the rest can't be fetched in one call."
      );
    });

    it('has no howToFetchAll key at all when nothing is left to fetch', async () => {
      const result = await run(daysOf([1100]), { startDate: 20250101, endDate: 20250101, maxBlocks: 1000 });

      expect(Object.keys(result.warnings[0])).toEqual(['code', 'message']);
      expect(result.hasMore).toBe(false);
    });
  });
});
