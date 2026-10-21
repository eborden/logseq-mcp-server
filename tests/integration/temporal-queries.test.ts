import { describe, it, expect, beforeAll, vi } from 'vitest';
import { isDeepStrictEqual } from 'util';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import type { PageEntity, BlockEntity } from './helpers/types.js';
import { exploreTimeline } from './helpers/tools.js';
import { formatLogseqDate } from './helpers/dates.js';
import { connectFixture, FIXTURE_JOURNAL_DAYS, laterJournalDays } from './helpers/fixture-client.js';

/**
 * Integration tests for logseq_explore_timeline against the fixture graph: a period alone (the old query_by_date_range)
 * and a page, with or without a period (the old get_concept_evolution).
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

  describe('logseq_explore_timeline with a period', () => {
    it('should return date range structure with entries', async () => {
      const result = await exploreTimeline(client, { startDate: 20250101, endDate: 20250131 });

      expect(result.page).toBeUndefined();
      expect(result.dateRange).toEqual({ start: 20250101, end: 20250131 });
      expect(result.entries.map(e => [e.date, e.blocks.length])).toEqual(JANUARY);
      expect(result.summary).toMatchObject({ totalDays: 7, totalBlocks: 20 });
      for (const entry of result.entries as Array<{ date: number; page: any }>) {
        expect(entry.page['journal-day'] ?? entry.page.journalDay).toBe(entry.date);
        expect(typeof entry.page.name).toBe('string');
      }
    });

    it('starts and ends a window on the given days, across a year boundary', async () => {
      const result = await exploreTimeline(client, { startDate: 20241231, endDate: 20250106 });

      expect(result.entries.map(e => e.date)).toEqual([20241231, 20250102, 20250106]);
      expect(result.summary.totalDays).toBe(3);
    });

    it('should return entries sorted by date', async () => {
      const result = await exploreTimeline(client, { startDate: 20240101, endDate: 20251231 });

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
        const actual = await exploreTimeline(client, { startDate: 20240101, endDate: 20251231 });

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
          await exploreTimeline(client, { startDate: 20000101, endDate: 20991231 });
          expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
        } finally {
          spy.mockRestore();
        }
      });
    });

    it('should handle empty date range', async () => {
      // The fixture holds no journal before 2024
      const result = await exploreTimeline(client, { startDate: 20230101, endDate: 20231231 });

      expect(result.entries).toHaveLength(0);
      expect(result.summary.totalDays).toBe(0);
      expect(result.summary.totalBlocks).toBe(0);
    });

    it('should throw error for invalid date format', async () => {
      await expect(
        exploreTimeline(client, { startDate: 99999999, endDate: 20250131 })
      ).rejects.toThrow(/Invalid parameter.*start_date/);

      await expect(
        exploreTimeline(client, { startDate: 20250101, endDate: 12345 })
      ).rejects.toThrow(/Invalid parameter.*end_date/);
    });

    it('should throw error when start date is after end date', async () => {
      await expect(
        exploreTimeline(client, { startDate: 20250131, endDate: 20250101 })
      ).rejects.toThrow(/Invalid parameter.*date_range/);
    });

    it('refuses a call with neither a page nor a period, and says what it takes', async () => {
      await expect(exploreTimeline(client, {})).rejects.toThrow(/Invalid parameter 'page or period': none given/);
      await expect(exploreTimeline(client, { groupBy: 'week' })).rejects.toThrow(/Invalid parameter 'page or period'/);
    });

    it('a window that ends today holds only the journals LogSeq made, not the fixture\'s', async () => {
      const today = new Date();
      const sixtyDaysAgo = new Date(today);
      sixtyDaysAgo.setDate(today.getDate() - 60);
      const [startDate, endDate] = [formatLogseqDate(sixtyDaysAgo), formatLogseqDate(today)];

      const result = await exploreTimeline(client, { startDate, endDate });
      const later = await laterJournalDays(client);

      expect(result.dateRange).toEqual({ start: startDate, end: endDate });
      expect(result.entries.map(e => e.date)).toEqual(later.filter(day => day >= startDate && day <= endDate));
    });
  });

  describe('logseq_explore_timeline with a page', () => {
    it('should return the page over time: its days oldest first, the blocks on non-journal pages last', async () => {
      const result = await exploreTimeline(client, { page: 'Bob' });

      expect(result.page).toBe('Bob');
      // Journal days in order, then the non-journal mentions under null
      expect(result.entries.map(t => [t.date, t.blocks.length])).toEqual([
        [20250106, 2], [20250107, 1], [20250110, 1], [20250115, 1], [null, 11],
      ]);
      expect(result.summary).toMatchObject({ totalDays: 4, totalBlocks: 16 });
      // With no period, the range is the span of the dated blocks
      expect(result.dateRange).toEqual({ start: 20250106, end: 20250115 });
    });

    it('a period bounds the days and leaves out the blocks on non-journal pages', async () => {
      const result = await exploreTimeline(client, { page: 'Bob', startDate: 20250101, endDate: 20250110 });

      // Jan 15th falls outside; the non-journal mentions have no day in the period
      expect(result.entries.map(t => t.date)).toEqual([20250106, 20250107, 20250110]);
      expect(result.summary).toMatchObject({ totalDays: 3, totalBlocks: 4 });
      expect(result.dateRange).toEqual({ start: 20250101, end: 20250110 });
    });

    it('takes last_n as calendar days ending today, so the fixture\'s days are out of reach', async () => {
      const result = await exploreTimeline(client, { page: 'Bob', lastN: 7 });

      expect(result.entries).toEqual([]);
      expect(result.dateRange.end).toBe(formatLogseqDate(new Date()));
    });

    it('should join the days by day, which is the default', async () => {
      const result = await exploreTimeline(client, { page: 'Bob', groupBy: 'day' });

      expect(result.entries.map(t => [t.date, t.blocks.length])).toEqual([
        [20250106, 2], [20250107, 1], [20250110, 1], [20250115, 1], [null, 11],
      ]);
    });

    it('should join mentions by week', async () => {
      const result = await exploreTimeline(client, { page: 'Bob', groupBy: 'week' });

      // ISO weeks, Monday to Sunday (#660): Jan 6th, 7th and 10th are week 2
      expect(result.entries.map(t => [t.period ?? t.date, t.blocks.length])).toEqual([
        ['2025-W02', 4], ['2025-W03', 1], [null, 11],
      ]);
    });

    it('should join mentions by month', async () => {
      const result = await exploreTimeline(client, { page: 'Bob', groupBy: 'month' });

      expect(result.entries.map(t => [t.period ?? t.date, t.blocks.length])).toEqual([['202501', 5], [null, 11]]);
    });

    it('should return no entries for an existing page nothing mentions', async () => {
      // `archive`: the namespace parent of `archive/old plans`, with no file, blocks, refs or aliases
      const result = await exploreTimeline(client, { page: 'archive' });

      expect(result.resolvedFrom).toBeUndefined();
      expect(result.entries).toHaveLength(0);
      expect(result.dateRange).toBeUndefined();
      expect(result.summary).toMatchObject({ totalDays: 0, totalBlocks: 0 });
    });

    it('should throw guidance for a page that does not exist', async () => {
      await expect(
        exploreTimeline(client, { page: 'NonExistentConceptForTesting12345' })
      ).rejects.toThrow(/^No page "NonExistentConceptForTesting12345"\./);
    });

    it('counts journal and non-journal mentions of a page that has no file', async () => {
      // `Carol` is only a link target: two journals and two pages mention her
      const result = await exploreTimeline(client, { page: 'carol' });

      expect(result.entries.map(t => [t.date, t.blocks.length])).toEqual([[20250106, 1], [20250108, 1], [null, 2]]);
      expect(result.summary).toMatchObject({ totalDays: 2, totalBlocks: 4 });
      expect(result.dateRange).toEqual({ start: 20250106, end: 20250108 });
    });

    it('rolls up what the mentions link, without the page itself', async () => {
      const result = await exploreTimeline(client, { page: 'carol', slimResults: true });

      const names = (result.summary.topConcepts as Array<{ name: string }>).map(concept => concept.name.toLowerCase());
      expect(names).not.toContain('carol');
    });
  });
});
