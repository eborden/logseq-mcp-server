import { describe, it, expect, beforeAll, vi } from 'vitest';
import { isDeepStrictEqual } from 'util';
import { LogseqClient } from '../../src/client.js';
import { PageEntity, BlockEntity } from '../../src/types.js';
import { queryByDateRange } from '../../src/tools/query-by-date-range.js';
import { getConceptEvolution } from '../../src/tools/get-concept-evolution.js';
import { formatLogseqDate } from '../../src/utils/date-utils.js';
import { connectFixture, FIXTURE_JOURNAL_DAYS, laterJournalDays } from './helpers/fixture-client.js';

/**
 * Integration tests for query_by_date_range and get_concept_evolution against the fixture graph.
 *
 * The fixture's journals are dated 2024 and 2025 (tests/fixtures/README.md, "Journals, tasks,
 * tags and nesting"), so fixed windows give exact results. LogSeq also makes today's journal when
 * the graph opens; a window that reaches the present adds those days, read from the graph.
 * Read-only.
 */

/** The seven January 2025 journals, with their top-level block counts */
const JANUARY = [
  [20250102, 3], [20250106, 3], [20250107, 3], [20250108, 4], [20250110, 2], [20250113, 3], [20250115, 2],
];

describe('Temporal Queries Integration Tests', () => {
  let client: LogseqClient;

  beforeAll(async () => {
    ({ client } = await connectFixture());
  });

  describe('logseq_query_by_date_range', () => {
    it('should return date range structure with entries', async () => {
      const result = await queryByDateRange(client, 20250101, 20250131);

      expect(result.dateRange).toEqual({ start: 20250101, end: 20250131 });
      expect(result.entries.map(e => [e.date, e.blocks.length])).toEqual(JANUARY);
      expect(result.summary).toMatchObject({ totalDays: 7, totalBlocks: 20 });
      for (const entry of result.entries as Array<{ date: number; page: any }>) {
        expect(entry.page['journal-day'] ?? entry.page.journalDay).toBe(entry.date);
        expect(typeof entry.page.name).toBe('string');
      }
    });

    it('starts and ends a window on the given days, across a year boundary', async () => {
      const result = await queryByDateRange(client, 20241231, 20250106);

      expect(result.entries.map(e => e.date)).toEqual([20241231, 20250102, 20250106]);
      expect(result.summary.totalDays).toBe(3);
    });

    it('should filter blocks by search term', async () => {
      const result = await queryByDateRange(client, 20250101, 20250131, 'test');

      expect(result.summary.searchTerm).toBe('test');
      // Only "NOW Write the test plan for the importer" in January
      expect(result.entries.map(e => [e.date, e.blocks.length])).toEqual([[20250108, 1]]);
      expect(result.entries[0].blocks[0].content.toLowerCase().includes('test')).toBe(true);
    });

    it('should return entries sorted by date', async () => {
      const result = await queryByDateRange(client, 20240101, 20251231);

      expect(result.entries.map(e => e.date)).toEqual(FIXTURE_JOURNAL_DAYS);
    });

    describe('matches the Editor API crawl it replaced', () => {
      // Reference implementation: getAllPages, then one getPageBlocksTree per journal day.
      async function crawlJournals(startDate: number, endDate: number) {
        const allPages = (await client.callAPI<PageEntity[]>('logseq.Editor.getAllPages')) || [];
        const journals = allPages
          .filter(p => p['journal?'] && p.journalDay && p.journalDay >= startDate && p.journalDay <= endDate)
          .sort((a, b) => a.journalDay! - b.journalDay!);
        const days: Array<{ date: number; blocks: BlockEntity[] }> = [];
        for (const page of journals) {
          const blocks = (await client.callAPI<BlockEntity[]>('logseq.Editor.getPageBlocksTree', [page.name])) || [];
          days.push({ date: page.journalDay!, blocks });
        }
        return days;
      }

      // Tree shape as [id, level, children] so a mismatch reports ids, not content.
      const shape = (blocks: BlockEntity[]): unknown[] =>
        blocks.map(b => [b.id, b.level, shape(b.children || [])]);
      const countAll = (blocks: BlockEntity[]): number =>
        blocks.reduce((n, b) => n + 1 + countAll(b.children || []), 0);

      it('returns the same days, block counts, ids and nesting order per day', async () => {
        // Every fixture journal, including the hub's 32-block one and Jan 6th's three levels
        const expected = await crawlJournals(20240101, 20251231);
        const actual = await queryByDateRange(client, 20240101, 20251231);

        expect(expected.map(d => d.date)).toEqual(FIXTURE_JOURNAL_DAYS);
        expect(actual.entries.map(e => e.date)).toEqual(expected.map(d => d.date));
        for (let i = 0; i < expected.length; i++) {
          const entry = actual.entries[i] as { date: number; blocks: BlockEntity[] };
          expect(countAll(entry.blocks), `total blocks for day index ${i}`).toBe(countAll(expected[i].blocks));
          expect(entry.blocks.length, `top-level blocks for day index ${i}`).toBe(expected[i].blocks.length);
          expect(shape(entry.blocks), `tree shape for day index ${i}`).toEqual(shape(expected[i].blocks));
          expect(isDeepStrictEqual(entry.blocks, expected[i].blocks), `full block data for day index ${i}`).toBe(true);
        }
      });

      it('uses at most 2 API calls however long the range is', async () => {
        const spy = vi.spyOn(client, 'callAPI');
        try {
          await queryByDateRange(client, 20000101, 20991231);
          expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
        } finally {
          spy.mockRestore();
        }
      });
    });

    it('should handle empty date range', async () => {
      // The fixture holds no journal before 2024
      const result = await queryByDateRange(client, 20230101, 20231231);

      expect(result.entries).toHaveLength(0);
      expect(result.summary.totalDays).toBe(0);
      expect(result.summary.totalBlocks).toBe(0);
    });

    it('should throw error for invalid date format', async () => {
      await expect(
        queryByDateRange(client, 99999999, 20250131)
      ).rejects.toThrow(/Invalid parameter.*start_date/);

      await expect(
        queryByDateRange(client, 20250101, 12345)
      ).rejects.toThrow(/Invalid parameter.*end_date/);
    });

    it('should throw error when start date is after end date', async () => {
      await expect(
        queryByDateRange(client, 20250131, 20250101)
      ).rejects.toThrow(/Invalid parameter.*date_range/);
    });

    it('a window that ends today holds only the journals LogSeq made, not the fixture\'s', async () => {
      const today = new Date();
      const sixtyDaysAgo = new Date(today);
      sixtyDaysAgo.setDate(today.getDate() - 60);
      const [startDate, endDate] = [formatLogseqDate(sixtyDaysAgo), formatLogseqDate(today)];

      const result = await queryByDateRange(client, startDate, endDate);
      const later = await laterJournalDays(client);

      expect(result.dateRange).toEqual({ start: startDate, end: endDate });
      expect(result.entries.map(e => e.date)).toEqual(later.filter(day => day >= startDate && day <= endDate));
    });
  });

  describe('logseq_get_concept_evolution', () => {
    it('should return concept evolution structure', async () => {
      const result = await getConceptEvolution(client, 'Bob');

      expect(result.concept).toBe('Bob');
      // Journal days in order, then the non-journal mentions under null
      expect(result.timeline.map(t => [t.date, t.blocks.length])).toEqual([
        [20250106, 2], [20250107, 1], [20250110, 1], [20250115, 1], [null, 11],
      ]);
      expect(result.summary).toEqual({
        totalMentions: 16,
        dateRange: { earliest: 20250106, latest: 20250115 },
        journalMentions: 5,
        nonJournalMentions: 11,
      });
    });

    it('should filter by date range', async () => {
      const result = await getConceptEvolution(client, 'Bob', { startDate: 20250101, endDate: 20250110 });

      // Jan 15th falls outside; non-journal mentions have no date and stay
      expect(result.timeline.map(t => t.date)).toEqual([20250106, 20250107, 20250110, null]);
      expect(result.summary).toMatchObject({ totalMentions: 15, journalMentions: 4, nonJournalMentions: 11 });
      expect(result.summary.dateRange).toEqual({ earliest: 20250106, latest: 20250110 });
    });

    it('should group mentions by day', async () => {
      const result = await getConceptEvolution(client, 'Bob', { groupBy: 'day' });

      expect(Object.fromEntries(Object.entries(result.groupedTimeline!).map(([k, v]) => [k, v.length]))).toEqual({
        '20250106': 2, '20250107': 1, '20250110': 1, '20250115': 1,
      });
    });

    it('should group mentions by week', async () => {
      const result = await getConceptEvolution(client, 'Bob', { groupBy: 'week' });

      // Weeks count 7-day blocks from January 1st, not ISO weeks: Jan 6th and 7th are week 1
      expect(Object.fromEntries(Object.entries(result.groupedTimeline!).map(([k, v]) => [k, v.length]))).toEqual({
        '2025-W01': 3, '2025-W02': 1, '2025-W03': 1,
      });
    });

    it('should group mentions by month', async () => {
      const result = await getConceptEvolution(client, 'Bob', { groupBy: 'month' });

      expect(Object.fromEntries(Object.entries(result.groupedTimeline!).map(([k, v]) => [k, v.length]))).toEqual({
        '202501': 5,
      });
    });

    it('should return an empty timeline for an existing page nothing mentions', async () => {
      // `archive`: the namespace parent of `archive/old plans`, with no file, blocks, refs or aliases
      const result = await getConceptEvolution(client, 'archive');

      expect(result.resolvedFrom).toBeUndefined();
      expect(result.timeline).toHaveLength(0);
      expect(result.summary).toEqual({
        totalMentions: 0,
        dateRange: { earliest: null, latest: null },
        journalMentions: 0,
        nonJournalMentions: 0,
      });
    });

    it('should throw guidance for a concept that is not a page', async () => {
      await expect(
        getConceptEvolution(client, 'NonExistentConceptForTesting12345')
      ).rejects.toThrow(/^No page "NonExistentConceptForTesting12345"\./);
    });

    it('counts journal and non-journal mentions of a page that has no file', async () => {
      // `Carol` is only a link target: two journals and two pages mention her
      const result = await getConceptEvolution(client, 'carol');

      expect(result.timeline.map(t => [t.date, t.blocks.length])).toEqual([[20250106, 1], [20250108, 1], [null, 2]]);
      expect(result.summary).toEqual({
        totalMentions: 4,
        dateRange: { earliest: 20250106, latest: 20250108 },
        journalMentions: 2,
        nonJournalMentions: 2,
      });
    });
  });
});
