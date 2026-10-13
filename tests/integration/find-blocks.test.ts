import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { findBlocks, findBlocksWithMeta } from './helpers/tools.js';
import { InvalidParameterError } from './helpers/errors.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * find_blocks (#491): the filters that combine (text, property with value, a period), and offset, against the
 * fixture graph, with exact counts from known pages (tests/fixtures/README.md, "Journals, tasks, tags and nesting" and
 * "Properties"). The journals those counts come from are all dated 2025 or earlier, so no assertion depends on today.
 * Read-only.
 *
 * "importer" is on 11 blocks: 7 in journals (Jan 2nd 1, Jan 6th 2, Jan 8th 2, Jan 10th 1, Jan 15th 1) and 4 on pages.
 */

interface Hit {
  id: number;
  uuid: string;
  content: string;
  page: { id: number; name: string; 'original-name'?: string };
}

describe('find_blocks: text, property and period together', () => {
  let client: LogseqClient;

  beforeAll(async () => {
    ({ client } = await connectFixture());
  });

  const found = async (filters: Parameters<typeof findBlocks>[1], paging: Parameters<typeof findBlocks>[2] = {}) =>
    (await findBlocks(client, filters, paging)) as Hit[];
  const pageNames = (hits: Hit[]) => hits.map(hit => hit.page.name).sort();

  describe('a period', () => {
    it('limits the search to the blocks on the journal pages of the days, ends included', async () => {
      // Jan 2nd (1) and Jan 6th (2)
      expect(pageNames(await found({ text: 'importer', startDate: 20250102, endDate: 20250106 }))).toEqual([
        'jan 2nd, 2025',
        'jan 6th, 2025',
        'jan 6th, 2025',
      ]);
      // Jan 8th (2) and Jan 10th (1)
      expect(pageNames(await found({ text: 'importer', startDate: 20250107, endDate: 20250110 }))).toEqual([
        'jan 10th, 2025',
        'jan 8th, 2025',
        'jan 8th, 2025',
      ]);
      expect(await found({ text: 'importer', startDate: 20250101, endDate: 20250131 })).toHaveLength(7);
      // a single day is the range of one
      expect(pageNames(await found({ text: 'importer', startDate: 20250115, endDate: 20250115 }))).toEqual(['jan 15th, 2025']);
    });

    it('is a filter on its own: every block on the journals of the days', async () => {
      const day = await found({ startDate: 20250108, endDate: 20250108 });
      expect(day).toHaveLength(4);
      expect(new Set(pageNames(day))).toEqual(new Set(['jan 8th, 2025']));
      // the seven journals of January: 3 + 8 + 3 + 4 + 5 + 3 + 4 blocks
      expect(await found({ startDate: 20250101, endDate: 20250131 })).toHaveLength(30);
    });

    it('finds nothing in a span with no journals, and no page of a non-journal day', async () => {
      expect(await found({ text: 'importer', startDate: 20241201, endDate: 20241230 })).toEqual([]);
      expect(await found({ startDate: 20250201, endDate: 20250202 })).toEqual([]);
    });

    it('counts every day back from today for last_n, so a count that reaches January 2025 finds its journals', async () => {
      // 36,500 days is about a century back from any day this test can run on, so the result does not depend on today
      const hits = await found({ text: 'importer', lastN: 36_500 });
      expect(hits).toHaveLength(7);
      expect(new Set(pageNames(hits))).toEqual(new Set(['jan 2nd, 2025', 'jan 6th, 2025', 'jan 8th, 2025', 'jan 10th, 2025', 'jan 15th, 2025']));
    });

    it('matches no block of a non-journal page, whatever its text', async () => {
      const everywhere = await found({ text: 'importer' });
      const onJournals = await found({ text: 'importer', lastN: 36_500 });
      expect(everywhere).toHaveLength(11);
      expect(onJournals).toHaveLength(7);
      const journalUuids = new Set(onJournals.map(hit => hit.uuid));
      for (const hit of everywhere.filter(hit => !journalUuids.has(hit.uuid))) {
        expect(hit.page.name, 'a block that is not on a journal').not.toMatch(/, \d{4}$/);
      }
    });

    it('reports a period chosen no way, two ways, by half or backwards as an invalid parameter, before any call', async () => {
      await expect(findBlocks(client, { text: 'importer', startDate: 20250101 })).rejects.toThrow(InvalidParameterError);
      await expect(findBlocks(client, { text: 'importer', startDate: 20250107, endDate: 20250101 })).rejects.toThrow(InvalidParameterError);
      await expect(findBlocks(client, { text: 'importer', lastN: 3, preset: 'today' })).rejects.toThrow(InvalidParameterError);
      await expect(findBlocks(client, { text: 'importer', startDate: 20250231, endDate: 20250301 })).rejects.toThrow(InvalidParameterError);
    });
  });

  describe('filters that AND together', () => {
    it('keeps the blocks that match every filter and only those', async () => {
      // the block `A text value` carries status:: testing, and no other block does
      const both = await found({ text: 'text value', property: 'status', value: 'testing' });
      expect(both).toHaveLength(1);
      expect(both[0].content).toBe('A text value\nstatus:: testing');
      expect(await found({ text: 'a block no one wrote', property: 'status', value: 'testing' })).toEqual([]);
      expect(await found({ text: 'text value', property: 'status', value: 'doing-nothing' })).toEqual([]);
      // a property on a block of a non-journal page never matches a period
      expect(await found({ property: 'status', value: 'testing', startDate: 20250101, endDate: 20250131 })).toEqual([]);
      expect(await found({ text: 'importer', property: 'status', value: 'testing' })).toEqual([]);
    });

    it('makes one query whatever the filters, and a text of regex characters is plain text', async () => {
      for (const filters of [
        { text: 'importer' },
        { property: 'status', value: 'testing' },
        { startDate: 20250101, endDate: 20250131 },
        { text: 'importer', property: 'type', value: 'project', startDate: 20250101, endDate: 20250131 },
        { text: 'a.b (c) [d] ^$|?*+{}', lastN: 36_500 },
      ]) {
        const { meta } = await findBlocksWithMeta(client, filters);
        expect(meta.warnings, JSON.stringify(filters)).toEqual([]);
      }
    });

    it('finds a scheduled task by its SCHEDULED: line, which the skills rely on, and a property wildcard finds nothing', async () => {
      // 4 blocks carry a SCHEDULED: line: Jan 2nd and Jan 8th on journals, and two on `schedule cases`
      const scheduled = await found({ text: 'SCHEDULED:' });
      expect(scheduled).toHaveLength(4);
      expect(scheduled.every(hit => hit.content.includes('SCHEDULED: <'))).toBe(true);
      expect(pageNames(scheduled)).toEqual(['jan 2nd, 2025', 'jan 8th, 2025', 'schedule cases', 'schedule cases']);
      // beside a period only the journal ones stay
      expect(pageNames(await found({ text: 'SCHEDULED:', startDate: 20250101, endDate: 20250131 }))).toEqual(['jan 2nd, 2025', 'jan 8th, 2025']);
      // `scheduled` is no property and `*` is no wildcard: the value is an exact string
      expect(await found({ property: 'scheduled', value: '*' })).toEqual([]);
    });

    it('refuses a call with no filter at all, and a property without a value, as an invalid parameter', async () => {
      await expect(findBlocks(client, {})).rejects.toThrow(InvalidParameterError);
      await expect(findBlocks(client, { text: '' })).rejects.toThrow(InvalidParameterError);
      await expect(findBlocks(client, { property: 'status' })).rejects.toThrow(InvalidParameterError);
      await expect(findBlocks(client, { text: 'importer', value: 'x' })).rejects.toThrow(InvalidParameterError);
    });
  });

  describe('offset', () => {
    it('pages through a result newest first, with no hit on two pages and none lost', async () => {
      const all = await found({ text: 'importer' });
      expect(all).toHaveLength(11);
      const ids = all.map(hit => hit.id);
      expect(ids, 'newest first').toEqual([...ids].sort((a, b) => b - a));

      const pages: Hit[][] = [];
      for (const offset of [0, 4, 8]) {
        const { results, meta } = await findBlocksWithMeta(client, { text: 'importer' }, { limit: 4, offset });
        pages.push(results as Hit[]);
        expect(meta.totals, 'the total counts every match, skipped ones included').toEqual({ matches: 11 });
        if (offset < 8) {
          expect(meta.hasMore).toBe(true);
          expect(meta.warnings[0].howToFetchAll).toMatch(new RegExp(`^Set offset to ${offset + 4} for the next page\\.`));
        } else {
          expect(meta.hasMore, 'the last page is whole').toBe(false);
          expect(meta.warnings).toEqual([]);
        }
      }
      expect(pages.map(page => page.length)).toEqual([4, 4, 3]);
      expect(pages.flat().map(hit => hit.id)).toEqual(ids);
    });

    it('reads nothing at or past the last match, and says so without calling it a miss', async () => {
      for (const offset of [11, 12, 500]) {
        const { results, meta } = await findBlocksWithMeta(client, { text: 'importer' }, { offset });
        expect(results, `offset ${offset}`).toEqual([]);
        expect(meta, `offset ${offset}`).toMatchObject({ hasMore: false, warnings: [], totals: { matches: 11 } });
      }
    });

    it('pages a period and a property result the same way', async () => {
      const first = await findBlocksWithMeta(client, { startDate: 20250101, endDate: 20250131 }, { limit: 10 });
      const second = await findBlocksWithMeta(client, { startDate: 20250101, endDate: 20250131 }, { limit: 10, offset: 10 });
      const third = await findBlocksWithMeta(client, { startDate: 20250101, endDate: 20250131 }, { limit: 10, offset: 20 });
      const ids = [first, second, third].flatMap(page => (page.results as Hit[]).map(hit => hit.id));
      expect(ids).toHaveLength(30);
      expect(new Set(ids).size).toBe(30);
      expect(second.meta.warnings[0].message).toMatch(/^Showing 10 of 20 matching blocks from offset 10\./);
      expect(third.meta.warnings).toEqual([]);

      const byType = await findBlocksWithMeta(client, { property: 'type', value: 'project' }, { limit: 1, offset: 1 });
      expect((byType.results as Hit[]).length).toBe(1);
      expect(byType.meta.totals).toEqual({ matches: 3 });
    });
  });
});
