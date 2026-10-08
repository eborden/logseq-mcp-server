import { describe, it, expect, beforeAll } from 'vitest';
import { isDeepStrictEqual } from 'util';
import { LogseqClient } from '../../src/client.js';
import { queryJournals } from './helpers/tools.js';
import { DateRangeResult } from '../../src/tools/query-by-date-range.js';
import { formatLogseqDate } from '../../src/utils/date-utils.js';
import { connectFixture, FIXTURE_JOURNAL_DAYS, laterJournalDays } from './helpers/fixture-client.js';

/**
 * Integration tests for last_n, presets and include_content on query_by_date_range.
 *
 * Read-only, against the fixture graph. Its journals are dated 2024 and 2025, and
 * LogSeq adds today's journal when the graph opens, so anything counted back from
 * today (last_n, today, year_to_date) is computed from the journal days the graph
 * holds after the fixture's last one (`laterJournalDays`).
 */

describe('query_by_date_range: last_n, presets and include_content', () => {
  let client: LogseqClient;
  /** Every journal day in the graph, newest first */
  let newestFirst: number[];
  /** Journal days LogSeq made (today's), oldest first */
  let later: number[];

  beforeAll(async () => {
    ({ client } = await connectFixture());
    later = await laterJournalDays(client);
    newestFirst = [...later, ...FIXTURE_JOURNAL_DAYS].sort((a, b) => b - a);
  });

  describe('last_n', () => {
    it('returns at most N entries, newest first, with no duplicate dates', async () => {
      const result = (await queryJournals(client, { lastN: 3 })) as DateRangeResult;

      const dates = result.entries.map(e => e.date);
      expect(dates).toEqual(newestFirst.slice(0, 3));
      expect(new Set(dates).size === dates.length, 'duplicate journal dates').toBe(true);
      expect(
        dates.every((d, i) => i === 0 || dates[i - 1] > d),
        'entries are not strictly newest first'
      ).toBe(true);
      expect(dates.every(d => Number.isInteger(d) && d > 19000101 && d < 21000101)).toBe(true);
    });

    it('never returns a journal dated after today', async () => {
      const today = formatLogseqDate(new Date());

      const result = (await queryJournals(client, { lastN: 5 })) as DateRangeResult;

      expect(result.entries.every(e => e.date <= today), 'a future-dated journal was returned').toBe(true);
    });

    it('matches an explicit range over the same span', async () => {
      const viaLastN = (await queryJournals(client, { lastN: 3 })) as DateRangeResult;
      expect(viaLastN.entries).toHaveLength(3);

      const { start, end } = viaLastN.dateRange;
      const viaDates = (await queryJournals(client, { startDate: start, endDate: end })) as DateRangeResult;

      // Same journals, same block content; only the order (and the page's attribute set) differs
      const strip = (r: DateRangeResult) =>
        [...r.entries]
          .sort((a, b) => a.date - b.date)
          .map(e => ({ date: e.date, pageId: e.page.id, blocks: e.blocks }));
      expect(isDeepStrictEqual(strip(viaLastN), strip(viaDates)), 'last_n and the explicit range disagree').toBe(true);
    });

    it('returns every journal when N is huge', async () => {
      const result = (await queryJournals(client, { lastN: 1_000_000, includeContent: false })) as any;

      expect(result.entries.map((e: any) => e.date)).toEqual(newestFirst);
    });

    it('rejects last_n of 0 before touching the graph', async () => {
      await expect(queryJournals(client, { lastN: 0 })).rejects.toThrow(/Invalid parameter 'last_n'/);
    });
  });

  describe('preset', () => {
    // Fixed moment, so the comparison never depends on when the suite runs.
    const now = new Date(2025, 0, 15, 12, 0); // a Wednesday

    it('last_week matches the equivalent explicit Monday-to-Sunday range', async () => {
      const viaPreset = await queryJournals(client, { preset: 'last_week' }, now);
      const viaDates = await queryJournals(client, { startDate: 20250106, endDate: 20250112 }, now);

      expect(isDeepStrictEqual(viaPreset, viaDates), 'preset and explicit range disagree').toBe(true);
      expect(viaPreset.dateRange).toEqual({ start: 20250106, end: 20250112 });
      expect((viaPreset as DateRangeResult).entries.map(e => e.date)).toEqual([20250106, 20250107, 20250108, 20250110]);
    });

    it('this_month matches the equivalent explicit range', async () => {
      const viaPreset = await queryJournals(client, { preset: 'this_month' }, now);
      const viaDates = await queryJournals(client, { startDate: 20250101, endDate: 20250131 }, now);

      expect(isDeepStrictEqual(viaPreset, viaDates), 'preset and explicit range disagree').toBe(true);
      expect((viaPreset as DateRangeResult).entries).toHaveLength(7);
    });

    it('today and yesterday resolve against the real clock without error', async () => {
      const today = (await queryJournals(client, { preset: 'today' })) as DateRangeResult;
      const yesterday = (await queryJournals(client, { preset: 'yesterday' })) as DateRangeResult;

      expect(today.entries.map(e => e.date)).toEqual(later.filter(day => day === today.dateRange.end));
      expect(yesterday.entries.map(e => e.date)).toEqual(later.filter(day => day === yesterday.dateRange.end));
      expect(yesterday.dateRange.end).toBeLessThan(today.dateRange.end);
    });

    it('year_to_date ends today and returns entries oldest first', async () => {
      const result = (await queryJournals(client, { preset: 'year_to_date' })) as DateRangeResult;

      expect(result.dateRange.end).toBe(formatLogseqDate(new Date()));
      const dates = result.entries.map(e => e.date);
      // The fixture's journals are all from earlier years
      expect(dates).toEqual(later.filter(day => day >= result.dateRange.start && day <= result.dateRange.end));
      expect(dates.every((d, i) => i === 0 || dates[i - 1] < d), 'entries are not oldest first').toBe(true);
    });
  });

  describe('include_content: false', () => {
    it('returns the same days and block totals as the full result', async () => {
      const full = (await queryJournals(client, { lastN: 5 })) as DateRangeResult;
      const outline = (await queryJournals(client, { lastN: 5, includeContent: false })) as any;

      expect(outline.entries.map((e: any) => e.date)).toEqual(newestFirst.slice(0, 5));
      expect(outline.entries.map((e: any) => e.date)).toEqual(full.entries.map(e => e.date));
      expect(outline.summary).toEqual(full.summary);
      for (const [i, entry] of outline.entries.entries()) {
        expect(entry.snippets.length).toBe(full.entries[i].blocks.length);
        expect(entry.blockCount).toBeGreaterThanOrEqual(entry.snippets.length);
        expect(entry.snippets.every((s: string) => s.length <= 80)).toBe(true);
      }
    });
  });
});
