import { describe, it, expect, vi } from 'vitest';
import { queryJournals } from './query-by-date-range.js';
import { DATE_PRESETS } from '../utils/date-presets.js';
import { LogseqClient } from '../client.js';

// Datalog pull shapes: kebab-case keys, refs as `{id}`.
function journalPage(id: number, day: number, label = `Day ${day}`) {
  return {
    id,
    uuid: `page-uuid-${id}`,
    name: label.toLowerCase(),
    'original-name': label,
    'journal-day': day,
    'journal?': true
  };
}

function block(id: number, pageId: number, parentId: number, leftId: number, content: string) {
  return {
    id,
    uuid: `block-uuid-${id}`,
    content,
    format: 'markdown',
    page: { id: pageId },
    parent: { id: parentId },
    left: { id: leftId }
  };
}

/** Client whose Datalog calls resolve to `pages` first, then `blocks`. */
function mockClient(pages: any[], blocks: any[] = []) {
  const executeDatalogQuery = vi
    .fn()
    .mockResolvedValueOnce(pages.map(p => [p]))
    .mockResolvedValueOnce(blocks.map(b => [b]));
  return { client: { executeDatalogQuery } as unknown as LogseqClient, executeDatalogQuery };
}

/** A client that must never be called. */
function unusedClient() {
  const executeDatalogQuery = vi.fn();
  return { client: { executeDatalogQuery } as unknown as LogseqClient, executeDatalogQuery };
}

// Wednesday 2025-01-15, local time
const NOW = new Date(2025, 0, 15, 12, 30);

describe('queryJournals: choosing the range', () => {
  describe('exactly one of explicit dates, last_n or preset', () => {
    it('rejects no selection at all, without querying', async () => {
      const { client, executeDatalogQuery } = unusedClient();

      await expect(queryJournals(client, {}, NOW)).rejects.toThrow(/Invalid parameter 'date selection'.*Exactly one of/s);
      await expect(queryJournals(client, { searchTerm: 'x', slimResults: true }, NOW)).rejects.toThrow(/Exactly one of/);
      expect(executeDatalogQuery).not.toHaveBeenCalled();
    });

    it.each([
      ['explicit dates and last_n', { startDate: 20250101, endDate: 20250105, lastN: 3 }, /start_date\/end_date and last_n/],
      ['explicit dates and a preset', { startDate: 20250101, endDate: 20250105, preset: 'today' }, /start_date\/end_date and preset/],
      ['last_n and a preset', { lastN: 3, preset: 'today' }, /last_n and preset/],
      ['all three', { startDate: 20250101, endDate: 20250105, lastN: 3, preset: 'today' }, /start_date\/end_date and last_n and preset/],
      ['one explicit date and last_n', { startDate: 20250101, lastN: 3 }, /start_date\/end_date and last_n/],
    ])('rejects %s, without querying', async (_label, selection, message) => {
      const { client, executeDatalogQuery } = unusedClient();

      await expect(queryJournals(client, selection, NOW)).rejects.toThrow(message);
      expect(executeDatalogQuery).not.toHaveBeenCalled();
    });

    it('treats null like an omitted value', async () => {
      const { client } = mockClient([]);

      const result = await queryJournals(client, { startDate: null as any, endDate: null as any, preset: 'today' }, NOW);

      expect(result.dateRange).toEqual({ start: 20250115, end: 20250115 });
    });

    it.each([
      ['only start_date', { startDate: 20250101 }, /start_date|end_date/, 'end_date'],
      ['only end_date', { endDate: 20250105 }, /start_date|end_date/, 'start_date'],
    ])('rejects %s and names the missing one', async (_label, selection, _re, missing) => {
      const { client, executeDatalogQuery } = unusedClient();

      await expect(queryJournals(client, selection, NOW)).rejects.toThrow(
        new RegExp(`Invalid parameter '${missing}'`)
      );
      expect(executeDatalogQuery).not.toHaveBeenCalled();
    });
  });

  describe('explicit dates', () => {
    it('keeps the existing validation errors', async () => {
      const { client, executeDatalogQuery } = unusedClient();

      await expect(queryJournals(client, { startDate: 99999999, endDate: 20251120 }, NOW)).rejects.toThrow(/Invalid parameter.*start_date/);
      await expect(queryJournals(client, { startDate: 20251115, endDate: 20251399 }, NOW)).rejects.toThrow(/Invalid parameter.*end_date/);
      await expect(queryJournals(client, { startDate: 20250105, endDate: 20250101 }, NOW)).rejects.toThrow(/date_range/);
      expect(executeDatalogQuery).not.toHaveBeenCalled();
    });

    it('does not use now: the range and the order are what the caller gave', async () => {
      const { client, executeDatalogQuery } = mockClient(
        [journalPage(2, 20250103), journalPage(1, 20250101)],
        [block(10, 1, 1, 1, 'one'), block(20, 2, 2, 2, 'three')]
      );

      const result = await queryJournals(client, { startDate: 20250101, endDate: 20250131 }, new Date(2030, 5, 5));

      expect(result.dateRange).toEqual({ start: 20250101, end: 20250131 });
      expect(result.entries.map(e => e.date)).toEqual([20250101, 20250103]);
      expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe('preset', () => {
    it.each(['', 'Today', 'last week', 'tomorrow', 'next_week'])('rejects the unknown preset %j and lists the valid ones', async (bad) => {
      const { client, executeDatalogQuery } = unusedClient();

      const attempt = queryJournals(client, { preset: bad }, NOW);

      await expect(attempt).rejects.toThrow(/Invalid parameter 'preset'/);
      await expect(attempt).rejects.toThrow(new RegExp(DATE_PRESETS.join(', ')));
      expect(executeDatalogQuery).not.toHaveBeenCalled();
    });

    it('rejects a preset that is not a string', async () => {
      const { client } = unusedClient();

      await expect(queryJournals(client, { preset: 7 as any }, NOW)).rejects.toThrow(/Invalid parameter 'preset'/);
    });

    it('queries the resolved range as :in inputs and uses 2 calls', async () => {
      const { client, executeDatalogQuery } = mockClient(
        [journalPage(1, 20250107)],
        [block(10, 1, 1, 1, 'Entry')]
      );

      const result = await queryJournals(client, { preset: 'last_week' }, NOW);

      expect(result.dateRange).toEqual({ start: 20250106, end: 20250112 });
      expect(result.entries.map(e => e.date)).toEqual([20250107]);
      expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
      for (const [query, ...inputs] of executeDatalogQuery.mock.calls) {
        expect(query).toContain(':in $ ?start ?end');
        expect(inputs).toEqual([20250106, 20250112]);
      }
    });

    it('returns the same result as the equivalent explicit range', async () => {
      const pages = [journalPage(1, 20250107), journalPage(2, 20250109)];
      const blocks = [block(10, 1, 1, 1, 'Mon entry'), block(20, 2, 2, 2, 'Wed entry')];

      const viaPreset = await queryJournals(mockClient(pages, blocks).client, { preset: 'last_week' }, NOW);
      const viaDates = await queryJournals(
        mockClient(pages, blocks).client,
        { startDate: 20250106, endDate: 20250112 },
        NOW
      );

      expect(viaPreset).toEqual(viaDates);
    });

    it.each(DATE_PRESETS)('%s makes at most 2 calls', async (preset) => {
      const { client, executeDatalogQuery } = mockClient([journalPage(1, 20250115)], [block(10, 1, 1, 1, 'Entry')]);

      await queryJournals(client, { preset }, NOW);

      expect(executeDatalogQuery.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('skips the blocks query when no journal exists in the period', async () => {
      const { client, executeDatalogQuery } = mockClient([]);

      const result = await queryJournals(client, { preset: 'yesterday' }, NOW);

      expect(result.entries).toEqual([]);
      expect(result.dateRange).toEqual({ start: 20250114, end: 20250114 });
      expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    });

    it('resolves against the injected now across a year boundary', async () => {
      const { client } = mockClient([]);

      const result = await queryJournals(client, { preset: 'last_month' }, new Date(2025, 0, 2));

      expect(result.dateRange).toEqual({ start: 20241201, end: 20241231 });
    });
  });

  describe('last_n', () => {
    it.each([0, -1, -100, 1.5, NaN, Infinity, '3' as any, true as any])('rejects last_n=%s, without querying', async (bad) => {
      const { client, executeDatalogQuery } = unusedClient();

      await expect(queryJournals(client, { lastN: bad }, NOW)).rejects.toThrow(/Invalid parameter 'last_n'/);
      expect(executeDatalogQuery).not.toHaveBeenCalled();
    });

    it('returns the N newest journals, newest first, skipping missing days', async () => {
      // Gaps: no pages for most days between these
      const { client } = mockClient(
        [journalPage(1, 20241220), journalPage(5, 20250114), journalPage(3, 20250102), journalPage(4, 20250108), journalPage(2, 20241231)],
        [
          block(11, 1, 1, 1, 'oldest'),
          block(12, 2, 2, 2, 'b'),
          block(13, 3, 3, 3, 'c'),
          block(14, 4, 4, 4, 'd'),
          block(15, 5, 5, 5, 'newest')
        ]
      );

      const result = await queryJournals(client, { lastN: 3 }, NOW);

      expect(result.entries.map(e => e.date)).toEqual([20250114, 20250108, 20250102]);
      expect(result.dateRange).toEqual({ start: 20250102, end: 20250114 });
      expect(result.summary).toMatchObject({ totalDays: 3, totalBlocks: 3 });
      expect((result.entries[0] as any).blocks[0].content).toBe('newest');
    });

    it('returns every journal when N is larger than the number that exist', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101), journalPage(2, 20250110)],
        [block(11, 1, 1, 1, 'a'), block(12, 2, 2, 2, 'b')]
      );

      const result = await queryJournals(client, { lastN: 500 }, NOW);

      expect(result.entries.map(e => e.date)).toEqual([20250110, 20250101]);
      expect(result.dateRange).toEqual({ start: 20250101, end: 20250110 });
    });

    it('handles N=1', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101), journalPage(2, 20250110)],
        [block(12, 2, 2, 2, 'b')]
      );

      const result = await queryJournals(client, { lastN: 1 }, NOW);

      expect(result.entries.map(e => e.date)).toEqual([20250110]);
    });

    it('has no duplicate dates', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101), journalPage(2, 20250102), journalPage(3, 20250103)],
        []
      );

      const result = await queryJournals(client, { lastN: 3 }, NOW);
      const dates = result.entries.map(e => e.date);

      expect(new Set(dates).size).toBe(dates.length);
    });

    it('returns an empty result with one call when no journal exists', async () => {
      const { client, executeDatalogQuery } = mockClient([]);

      const result = await queryJournals(client, { lastN: 5 }, NOW);

      expect(result.entries).toEqual([]);
      expect(result.dateRange).toEqual({ start: 0, end: 0 });
      expect(result.summary).toEqual({ totalDays: 0, totalBlocks: 0, searchTerm: undefined });
      expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    });

    it('makes 2 calls: pages up to today, then one blocks query over the kept span', async () => {
      const pages = Array.from({ length: 40 }, (_, i) => journalPage(i + 1, 20241201 + i, `P${i}`));
      const { client, executeDatalogQuery } = mockClient(pages, []);
      const callAPI = vi.fn();
      (client as any).callAPI = callAPI;

      await queryJournals(client, { lastN: 7 }, NOW);

      expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
      expect(callAPI).not.toHaveBeenCalled();

      const [pagesQuery, ...pagesInputs] = executeDatalogQuery.mock.calls[0];
      expect(pagesQuery).toContain(':in $ ?latest');
      expect(pagesQuery).toContain('[?page :block/name]');
      expect(pagesInputs).toEqual([20250115]); // today, so future-dated journals are not "recent"

      const [blocksQuery, ...blocksInputs] = executeDatalogQuery.mock.calls[1];
      expect(blocksQuery).toContain('(pull ?block [*])');
      // The 7 newest of days 20241201..20241240 (ids ascend with the day)
      expect(blocksInputs).toEqual([20241234, 20241240]);
    });

    it('counts calls the same however large N is', async () => {
      const pages = Array.from({ length: 60 }, (_, i) => journalPage(i + 1, 20241101 + i));
      const { client, executeDatalogQuery } = mockClient(pages, []);

      await queryJournals(client, { lastN: 50 }, NOW);

      expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
    });

    it('applies search_term to the kept journals and drops days with no match', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101), journalPage(2, 20250102), journalPage(3, 20250103)],
        [block(11, 1, 1, 1, 'alpha'), block(12, 2, 2, 2, 'beta'), block(13, 3, 3, 3, 'alpha again')]
      );

      const result = await queryJournals(client, { lastN: 3, searchTerm: 'alpha' }, NOW);

      expect(result.entries.map(e => e.date)).toEqual([20250103, 20250101]);
    });

    it('returns page names only in slim mode', async () => {
      const { client } = mockClient([journalPage(1, 20250101, 'Day One')], [block(11, 1, 1, 1, 'a')]);

      const result: any = await queryJournals(client, { lastN: 1, slimResults: true }, NOW);

      expect(result.entries[0]).toMatchObject({ date: 20250101, pageName: 'Day One' });
      expect(result.entries[0]).not.toHaveProperty('page');
    });
  });
});

describe('queryJournals: include_content', () => {
  const pages = [journalPage(1, 20250101, 'Day One'), journalPage(2, 20250102, 'Day Two')];
  const blocks = [
    block(10, 1, 1, 1, 'First top-level block'),
    block(11, 1, 10, 10, 'Child of first'),
    block(12, 1, 11, 11, 'Grandchild'),
    block(13, 1, 1, 10, 'Second top-level block\nwith a second line'),
    block(20, 2, 2, 2, 'x'.repeat(200)),
  ];

  it('returns counts and snippets instead of blocks', async () => {
    const { client } = mockClient(pages, blocks);

    const result: any = await queryJournals(client, { startDate: 20250101, endDate: 20250102, includeContent: false }, NOW);

    expect(result.entries[0]).toEqual({
      date: 20250101,
      pageName: 'Day One',
      blockCount: 4,
      snippets: ['First top-level block', 'Second top-level block']
    });
    expect(result.entries[1].blockCount).toBe(1);
    expect(result.entries[1].snippets[0]).toHaveLength(80);
    expect(result.entries[1].snippets[0].endsWith('...')).toBe(true);
    expect(result.entries[0]).not.toHaveProperty('blocks');
    expect(result.entries[0]).not.toHaveProperty('page');
    expect(result.summary).toEqual({ totalDays: 2, totalBlocks: 3, searchTerm: undefined });
  });

  it('makes the same 2 calls', async () => {
    const { client, executeDatalogQuery } = mockClient(pages, blocks);

    await queryJournals(client, { startDate: 20250101, endDate: 20250102, includeContent: false }, NOW);

    expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
  });

  it('works with last_n and a preset', async () => {
    const viaLastN: any = await queryJournals(mockClient(pages, blocks).client, { lastN: 2, includeContent: false }, NOW);
    const viaPreset: any = await queryJournals(
      mockClient(pages, blocks).client,
      { preset: 'this_year', includeContent: false },
      new Date(2025, 5, 1)
    );

    expect(viaLastN.entries.map((e: any) => e.date)).toEqual([20250102, 20250101]);
    expect(viaPreset.entries.map((e: any) => e.date)).toEqual([20250101, 20250102]);
  });

  it('takes precedence over slim_results', async () => {
    const { client } = mockClient(pages, blocks);

    const result: any = await queryJournals(
      client,
      { startDate: 20250101, endDate: 20250102, includeContent: false, slimResults: true },
      NOW
    );

    expect(result.entries[0]).toHaveProperty('blockCount');
  });

  it('is the default: full results when include_content is true or omitted', async () => {
    const { client } = mockClient(pages, blocks);

    const result: any = await queryJournals(client, { startDate: 20250101, endDate: 20250102, includeContent: true }, NOW);

    expect(result.entries[0]).toHaveProperty('page');
    expect(result.entries[0]).toHaveProperty('blocks');
  });
});
