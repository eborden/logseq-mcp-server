import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';
import { access } from 'fs/promises';
import { loadConfig } from '../../src/config.js';
import { LogseqClient } from '../../src/client.js';
import { queryByDateRange } from '../../src/tools/query-by-date-range.js';
import { getConceptEvolution } from '../../src/tools/get-concept-evolution.js';

/**
 * Integration tests for Temporal Queries Tools
 *
 * These tests require:
 * 1. LogSeq running with HTTP API enabled
 * 2. Config file at ~/.logseq-mcp/config.json
 * 3. Test data in LogSeq graph
 *
 * Tests will be skipped if prerequisites are not met.
 */

describe('Temporal Queries Integration Tests', () => {
  let client: LogseqClient;
  let skipTests = false;
  let skipReason = '';

  beforeAll(async () => {
    try {
      // Check if config file exists
      const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');

      try {
        await access(configPath);
      } catch {
        skipTests = true;
        skipReason = 'Config file not found. See tests/integration/setup.md for setup instructions.';
        return;
      }

      // Load config
      const config = await loadConfig(configPath);
      client = new LogseqClient(config);

      // Test connection to LogSeq
      try {
        await client.callAPI('logseq.App.getCurrentGraph');
      } catch (error) {
        skipTests = true;
        skipReason = `Cannot connect to LogSeq: ${error instanceof Error ? error.message : 'Unknown error'}. Ensure LogSeq is running with HTTP server enabled.`;
      }
    } catch (error) {
      skipTests = true;
      skipReason = `Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  describe('logseq_query_by_date_range', () => {
    it.skipIf(skipTests)('should return date range structure with entries', async () => {
      // Query last 7 days
      const today = new Date();
      const endDate = parseInt(
        today.toISOString().slice(0, 10).replace(/-/g, '')
      );
      const sevenDaysAgo = new Date(today);
      sevenDaysAgo.setDate(today.getDate() - 7);
      const startDate = parseInt(
        sevenDaysAgo.toISOString().slice(0, 10).replace(/-/g, '')
      );

      const result = await queryByDateRange(client, startDate, endDate);

      // Validate structure
      expect(result).toHaveProperty('dateRange');
      expect(result).toHaveProperty('entries');
      expect(result).toHaveProperty('summary');

      // Validate date range
      expect(result.dateRange).toHaveProperty('start');
      expect(result.dateRange).toHaveProperty('end');
      expect(result.dateRange.start).toBe(startDate);
      expect(result.dateRange.end).toBe(endDate);

      // Validate entries array
      expect(Array.isArray(result.entries)).toBe(true);

      // Validate summary
      expect(result.summary).toHaveProperty('totalDays');
      expect(result.summary).toHaveProperty('totalBlocks');
      expect(typeof result.summary.totalDays).toBe('number');
      expect(typeof result.summary.totalBlocks).toBe('number');

      // If there are entries, validate their structure
      if (result.entries.length > 0) {
        const entry = result.entries[0];
        expect(entry).toHaveProperty('date');
        expect(entry).toHaveProperty('page');
        expect(entry).toHaveProperty('blocks');
        expect(typeof entry.date).toBe('number');
        expect(Array.isArray(entry.blocks)).toBe(true);
        expect(entry.page).toHaveProperty('id');
        expect(entry.page).toHaveProperty('name');
      }
    });

    it.skipIf(skipTests)('should filter entries by date range', async () => {
      // Query a specific date range
      const startDate = 20250101;
      const endDate = 20250131;

      const result = await queryByDateRange(client, startDate, endDate);

      // All entries should be within the specified range
      for (const entry of result.entries) {
        expect(entry.date).toBeGreaterThanOrEqual(startDate);
        expect(entry.date).toBeLessThanOrEqual(endDate);
      }

      // Summary should reflect the range
      expect(result.summary.totalDays).toBe(result.entries.length);
    });

    it.skipIf(skipTests)('should filter blocks by search term', async () => {
      // Query with a search term
      const today = new Date();
      const endDate = parseInt(
        today.toISOString().slice(0, 10).replace(/-/g, '')
      );
      const thirtyDaysAgo = new Date(today);
      thirtyDaysAgo.setDate(today.getDate() - 30);
      const startDate = parseInt(
        thirtyDaysAgo.toISOString().slice(0, 10).replace(/-/g, '')
      );

      const searchTerm = 'test';
      const result = await queryByDateRange(
        client,
        startDate,
        endDate,
        searchTerm
      );

      // Validate search term in summary
      expect(result.summary.searchTerm).toBe(searchTerm);

      // If there are entries, all blocks should contain the search term
      for (const entry of result.entries) {
        for (const block of entry.blocks) {
          expect(
            block.content.toLowerCase().includes(searchTerm.toLowerCase())
          ).toBe(true);
        }
      }
    });

    it.skipIf(skipTests)('should return entries sorted by date', async () => {
      // Query a range that should have multiple entries
      const today = new Date();
      const endDate = parseInt(
        today.toISOString().slice(0, 10).replace(/-/g, '')
      );
      const ninetyDaysAgo = new Date(today);
      ninetyDaysAgo.setDate(today.getDate() - 90);
      const startDate = parseInt(
        ninetyDaysAgo.toISOString().slice(0, 10).replace(/-/g, '')
      );

      const result = await queryByDateRange(client, startDate, endDate);

      // Entries should be sorted in ascending order
      for (let i = 1; i < result.entries.length; i++) {
        expect(result.entries[i].date).toBeGreaterThanOrEqual(
          result.entries[i - 1].date
        );
      }
    });

    it.skipIf(skipTests)('should handle empty date range', async () => {
      // Query a future date range with no entries
      const startDate = 20300101;
      const endDate = 20300131;

      const result = await queryByDateRange(client, startDate, endDate);

      // Should return empty entries
      expect(result.entries).toHaveLength(0);
      expect(result.summary.totalDays).toBe(0);
      expect(result.summary.totalBlocks).toBe(0);
    });

    it.skipIf(skipTests)('should throw error for invalid date format', async () => {
      // Test invalid start date
      await expect(
        queryByDateRange(client, 99999999, 20250131)
      ).rejects.toThrow('Invalid date format');

      // Test invalid end date
      await expect(
        queryByDateRange(client, 20250101, 12345)
      ).rejects.toThrow('Invalid date format');
    });

    it.skipIf(skipTests)('should throw error when start date is after end date', async () => {
      await expect(
        queryByDateRange(client, 20250131, 20250101)
      ).rejects.toThrow('Start date must be before or equal to end date');
    });

    it.skipIf(skipTests)('should return journal entries for last 60 days', async () => {
      // Calculate date range
      const today = new Date();
      const sixtyDaysAgo = new Date(today);
      sixtyDaysAgo.setDate(today.getDate() - 60);

      const endDate = parseInt(today.toISOString().slice(0, 10).replace(/-/g, ''));
      const startDate = parseInt(sixtyDaysAgo.toISOString().slice(0, 10).replace(/-/g, ''));

      const result = await queryByDateRange(client, startDate, endDate);

      // Validate structure
      expect(result).toHaveProperty('dateRange');
      expect(result.dateRange.start).toBe(startDate);
      expect(result.dateRange.end).toBe(endDate);
      expect(Array.isArray(result.entries)).toBe(true);

      // Should have at least some entries in the last 60 days
      expect(result.entries.length).toBeGreaterThan(0);

      // Validate all entries are within range
      for (const entry of result.entries) {
        expect(entry.date).toBeGreaterThanOrEqual(startDate);
        expect(entry.date).toBeLessThanOrEqual(endDate);
        expect(entry.page).toBeDefined();
        expect(Array.isArray(entry.blocks)).toBe(true);
      }

      // Entries should be sorted by date
      for (let i = 1; i < result.entries.length; i++) {
        expect(result.entries[i].date).toBeGreaterThanOrEqual(result.entries[i - 1].date);
      }
    });
  });

  describe('logseq_get_concept_evolution', () => {
    it.skipIf(skipTests)('should return concept evolution structure', async () => {
      // Find any page to test with
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        console.warn('No pages found for get_concept_evolution test');
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        console.warn('Could not determine page name');
        return;
      }

      const result = await getConceptEvolution(client, pageName);

      // Validate structure
      expect(result).toHaveProperty('concept');
      expect(result).toHaveProperty('timeline');
      expect(result).toHaveProperty('summary');
      expect(result.concept).toBe(pageName);
      expect(Array.isArray(result.timeline)).toBe(true);

      // Validate summary structure
      expect(result.summary).toHaveProperty('totalMentions');
      expect(result.summary).toHaveProperty('dateRange');
      expect(result.summary).toHaveProperty('journalMentions');
      expect(result.summary).toHaveProperty('nonJournalMentions');
      expect(result.summary.dateRange).toHaveProperty('earliest');
      expect(result.summary.dateRange).toHaveProperty('latest');

      // Validate timeline entries
      if (result.timeline.length > 0) {
        const entry = result.timeline[0];
        expect(entry).toHaveProperty('date');
        expect(entry).toHaveProperty('blocks');
        expect(Array.isArray(entry.blocks)).toBe(true);

        // Date should be number or null
        expect(
          entry.date === null || typeof entry.date === 'number'
        ).toBe(true);
      }
    });

    it.skipIf(skipTests)('should track timeline chronologically', async () => {
      // Find a page with multiple mentions
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        return;
      }

      const result = await getConceptEvolution(client, pageName);

      // Timeline should be sorted chronologically (non-null dates before null)
      let lastDate: number | null = null;
      let seenNull = false;

      for (const entry of result.timeline) {
        if (entry.date === null) {
          seenNull = true;
        } else {
          // If we've seen a null, no more non-null dates should appear
          expect(seenNull).toBe(false);

          // Check ascending order
          if (lastDate !== null) {
            expect(entry.date).toBeGreaterThanOrEqual(lastDate);
          }
          lastDate = entry.date;
        }
      }
    });

    it.skipIf(skipTests)('should filter by date range', async () => {
      // Find a page
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        return;
      }

      // Query with specific date range
      const startDate = 20250101;
      const endDate = 20251231;

      const result = await getConceptEvolution(client, pageName, {
        startDate,
        endDate
      });

      // All timeline entries with dates should be within range
      for (const entry of result.timeline) {
        if (entry.date !== null) {
          expect(entry.date).toBeGreaterThanOrEqual(startDate);
          expect(entry.date).toBeLessThanOrEqual(endDate);
        }
      }
    });

    it.skipIf(skipTests)('should group mentions by day', async () => {
      // Find a page
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        return;
      }

      const result = await getConceptEvolution(client, pageName, {
        groupBy: 'day'
      });

      // Should have groupedTimeline
      expect(result).toHaveProperty('groupedTimeline');
      expect(result.groupedTimeline).toBeDefined();

      if (result.groupedTimeline && result.groupedTimeline.size > 0) {
        // Keys should be date strings (YYYYMMDD format)
        const keys = Array.from(result.groupedTimeline.keys());
        for (const key of keys) {
          expect(/^\d{8}$/.test(key)).toBe(true);
        }

        // Values should be arrays of blocks
        const values = Array.from(result.groupedTimeline.values());
        for (const blocks of values) {
          expect(Array.isArray(blocks)).toBe(true);
        }
      }
    });

    it.skipIf(skipTests)('should group mentions by week', async () => {
      // Find a page
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        return;
      }

      const result = await getConceptEvolution(client, pageName, {
        groupBy: 'week'
      });

      // Should have groupedTimeline
      expect(result).toHaveProperty('groupedTimeline');

      if (result.groupedTimeline && result.groupedTimeline.size > 0) {
        // Keys should be week strings (YYYY-WXX format)
        const keys = Array.from(result.groupedTimeline.keys());
        for (const key of keys) {
          expect(/^\d{4}-W\d{2}$/.test(key)).toBe(true);
        }
      }
    });

    it.skipIf(skipTests)('should group mentions by month', async () => {
      // Find a page
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        return;
      }

      const result = await getConceptEvolution(client, pageName, {
        groupBy: 'month'
      });

      // Should have groupedTimeline
      expect(result).toHaveProperty('groupedTimeline');

      if (result.groupedTimeline && result.groupedTimeline.size > 0) {
        // Keys should be month strings (YYYYMM format)
        const keys = Array.from(result.groupedTimeline.keys());
        for (const key of keys) {
          expect(/^\d{6}$/.test(key)).toBe(true);
        }
      }
    });

    it.skipIf(skipTests)('should handle concepts with no mentions', async () => {
      const result = await getConceptEvolution(
        client,
        'NonExistentConceptForTesting12345'
      );

      // Should return structure with empty results
      expect(result.timeline).toHaveLength(0);
      expect(result.summary.totalMentions).toBe(0);
      expect(result.summary.journalMentions).toBe(0);
      expect(result.summary.nonJournalMentions).toBe(0);
      expect(result.summary.dateRange.earliest).toBeNull();
      expect(result.summary.dateRange.latest).toBeNull();
    });

    it.skipIf(skipTests)('should distinguish journal from non-journal mentions', async () => {
      // Find a page that appears in both journal and non-journal contexts
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        return;
      }

      const result = await getConceptEvolution(client, pageName);

      // Sum of journal and non-journal mentions should equal total
      expect(
        result.summary.journalMentions + result.summary.nonJournalMentions
      ).toBe(result.summary.totalMentions);
    });

    it.skipIf(skipTests)('should track earliest and latest mentions', async () => {
      // Find a page with mentions
      const searchResult = await client.callAPI<any[]>('logseq.DB.q', [
        '[:find (pull ?p [*]) :where [?p :block/name]]'
      ]);

      if (!searchResult || searchResult.length === 0) {
        return;
      }

      const firstPage = searchResult[0];
      const pageName = firstPage.name || firstPage['original-name'];

      if (!pageName) {
        return;
      }

      const result = await getConceptEvolution(client, pageName);

      // If there are journal mentions, earliest and latest should be set
      if (result.summary.journalMentions > 0) {
        expect(result.summary.dateRange.earliest).not.toBeNull();
        expect(result.summary.dateRange.latest).not.toBeNull();

        // Earliest should be <= latest
        if (
          result.summary.dateRange.earliest !== null &&
          result.summary.dateRange.latest !== null
        ) {
          expect(result.summary.dateRange.earliest).toBeLessThanOrEqual(
            result.summary.dateRange.latest
          );
        }

        // Verify against timeline
        const datesFromTimeline = result.timeline
          .filter(entry => entry.date !== null)
          .map(entry => entry.date as number);

        if (datesFromTimeline.length > 0) {
          expect(result.summary.dateRange.earliest).toBe(
            Math.min(...datesFromTimeline)
          );
          expect(result.summary.dateRange.latest).toBe(
            Math.max(...datesFromTimeline)
          );
        }
      } else {
        // No journal mentions, should be null
        expect(result.summary.dateRange.earliest).toBeNull();
        expect(result.summary.dateRange.latest).toBeNull();
      }
    });
  });

  // Display skip reason if tests were skipped
  if (skipTests) {
    it.skip(`Tests skipped: ${skipReason}`, () => {
      // This test is just to display the skip reason
    });
  }
});
