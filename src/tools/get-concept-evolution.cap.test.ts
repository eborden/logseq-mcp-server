import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_MAX_ENTRIES, MAX_ENTRIES, getConceptEvolution } from './get-concept-evolution.js';
import { LogseqClient } from '../client.js';

// A stand-in alias-group warning, so the cap's warning can be seen next to it
const aliasWarnings = vi.hoisted(() => ({ current: [] as Array<{ code: string; message: string }> }));
vi.mock('../utils/alias-set.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/alias-set.js')>()),
  aliasSetWarnings: () => [...aliasWarnings.current]
}));

/** The resolver's answer: the concept page matched by its exact name. */
const RESOLVED_CONCEPT = [[{ id: 100, name: 'concept', 'original-name': 'Concept' }, 'name']];

/** `n` mentions on consecutive days from 20240101 (day numbers, not real calendar dates). */
const dated = (n: number, firstId = 1) =>
  Array.from({ length: n }, (_, i) => ({
    id: firstId + i,
    content: `Mention ${firstId + i} of [[Concept]]`,
    page: { journalDay: 20240101 + i, name: `day ${i}` }
  }));

/** `n` mentions on pages that are not journals. */
const undated = (n: number, firstId = 10_000) =>
  Array.from({ length: n }, (_, i) => ({
    id: firstId + i,
    content: `Note ${firstId + i} about [[Concept]]`,
    page: { name: `note ${i}` }
  }));

function clientWith(blocks: unknown[]) {
  const callAPI = vi.fn().mockResolvedValueOnce(blocks);
  const executeDatalogQuery = vi
    .fn()
    .mockResolvedValueOnce(RESOLVED_CONCEPT)
    .mockResolvedValueOnce([]);
  return { callAPI, executeDatalogQuery } as unknown as LogseqClient;
}

type Result = Awaited<ReturnType<typeof getConceptEvolution>>;

const mentionsIn = (result: Result) => result.timeline.reduce((sum, entry) => sum + entry.blocks.length, 0);

/** Every `Set max_entries to N` in the result's warnings. */
function suggestedValues(result: Result): number[] {
  return (result.warnings ?? []).flatMap(w =>
    [...(w.howToFetchAll ?? '').matchAll(/Set max_entries to (\d+)/g)].map(m => Number(m[1]))
  );
}

describe('getConceptEvolution max_entries (#61)', () => {
  it('has a default of 100 and a maximum of 500', () => {
    expect(DEFAULT_MAX_ENTRIES).toBe(100);
    expect(MAX_ENTRIES).toBe(500);
  });

  describe('below the cap', () => {
    it('returns every mention and adds no meta', async () => {
      const result = await getConceptEvolution(clientWith(dated(99)), 'Concept');
      expect(mentionsIn(result)).toBe(99);
      expect(result.summary.totalMentions).toBe(99);
      expect(Object.keys(result)).not.toContain('hasMore');
      expect(Object.keys(result)).not.toContain('warnings');
      expect(Object.keys(result)).not.toContain('totals');
    });

    it('is byte-identical whatever the cap, while every mention fits', async () => {
      const outputs = await Promise.all(
        [undefined, 99, 100, 500, 5000].map(async maxEntries =>
          JSON.stringify(await getConceptEvolution(clientWith(dated(99)), 'Concept', { maxEntries, groupBy: 'week' }))
        )
      );
      expect(new Set(outputs).size).toBe(1);
    });
  });

  describe('at the cap', () => {
    it('returns exactly the cap with no meta at the default', async () => {
      const result = await getConceptEvolution(clientWith(dated(DEFAULT_MAX_ENTRIES)), 'Concept');
      expect(mentionsIn(result)).toBe(100);
      expect(Object.keys(result)).not.toContain('hasMore');
      expect(Object.keys(result)).not.toContain('warnings');
      expect(Object.keys(result)).not.toContain('totals');
    });

    it('returns exactly the cap with no meta at a custom cap', async () => {
      const result = await getConceptEvolution(clientWith(dated(7)), 'Concept', { maxEntries: 7 });
      expect(mentionsIn(result)).toBe(7);
      expect(Object.keys(result)).not.toContain('warnings');
    });
  });

  describe('above the cap', () => {
    it('cuts at the default of 100 and says how to get them all', async () => {
      const result = await getConceptEvolution(clientWith(dated(101)), 'Concept');
      expect(mentionsIn(result)).toBe(100);
      expect(result.hasMore).toBe(true);
      expect(result.totals).toEqual({ mentions: 101 });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0].code).toBe('entries_truncated');
      expect(result.warnings![0].message).toContain('Showing 100 of 101 mentions');
      expect(result.warnings![0].howToFetchAll).toContain('Set max_entries to 101');
    });

    it('cuts at a custom cap', async () => {
      const result = await getConceptEvolution(clientWith(dated(10)), 'Concept', { maxEntries: 4 });
      expect(mentionsIn(result)).toBe(4);
      expect(result.warnings![0].message).toContain('Showing 4 of 10 mentions');
      expect(result.warnings![0].howToFetchAll).toContain('Set max_entries to 10');
    });

    it('keeps the oldest mentions and drops undated ones first', async () => {
      const blocks = [...undated(2), ...dated(5).reverse()];
      const result = await getConceptEvolution(clientWith(blocks), 'Concept', { maxEntries: 4 });
      expect(result.timeline.map(e => e.date)).toEqual([20240101, 20240102, 20240103, 20240104]);
      expect(mentionsIn(result)).toBe(4);
    });

    it('keeps undated mentions after the dated ones when the cap reaches them', async () => {
      const blocks = [...undated(3), ...dated(2)];
      const result = await getConceptEvolution(clientWith(blocks), 'Concept', { maxEntries: 4 });
      expect(result.timeline.map(e => [e.date, e.blocks.length])).toEqual([
        [20240101, 1],
        [20240102, 1],
        [null, 2]
      ]);
    });

    it('splits one day across the cut', async () => {
      const sameDay = [1, 2, 3].map(id => ({ id, content: `Mention ${id}`, page: { journalDay: 20240101 } }));
      const result = await getConceptEvolution(clientWith(sameDay), 'Concept', { maxEntries: 2 });
      expect(result.timeline).toHaveLength(1);
      expect(result.timeline[0].blocks.map(b => b.id)).toEqual([1, 2]);
    });

    it('groups only the mentions kept', async () => {
      const result = await getConceptEvolution(clientWith(dated(20)), 'Concept', { maxEntries: 3, groupBy: 'day' });
      expect(Object.keys(result.groupedTimeline!)).toEqual(['20240101', '20240102', '20240103']);
    });

    it('still summarises every mention found', async () => {
      const blocks = [...dated(6), ...undated(2)];
      const result = await getConceptEvolution(clientWith(blocks), 'Concept', { maxEntries: 3 });
      expect(result.summary).toEqual({
        totalMentions: 8,
        dateRange: { earliest: 20240101, latest: 20240106 },
        journalMentions: 6,
        nonJournalMentions: 2
      });
      expect(result.totals).toEqual({ mentions: 8 });
    });

    it('adds the cap warning after an alias warning, with no extra API call', async () => {
      aliasWarnings.current = [{ code: 'alias_set_truncated', message: 'The alias group is too big.' }];
      try {
        const client = clientWith(dated(6));
        const result = await getConceptEvolution(client, 'Concept', { maxEntries: 2 });
        expect(result.warnings!.map(w => w.code)).toEqual(['alias_set_truncated', 'entries_truncated']);
        expect(result.hasMore).toBe(true);
        expect(client.callAPI).toHaveBeenCalledTimes(2);
        expect(client.executeDatalogQuery).toHaveBeenCalledTimes(2);
      } finally {
        aliasWarnings.current = [];
      }
    });

    it('keeps an alias warning alone, with no totals, when nothing is cut', async () => {
      aliasWarnings.current = [{ code: 'alias_set_truncated', message: 'The alias group is too big.' }];
      try {
        const result = await getConceptEvolution(clientWith(dated(3)), 'Concept', { maxEntries: 5 });
        expect(result.warnings!.map(w => w.code)).toEqual(['alias_set_truncated']);
        expect(result.hasMore).toBe(false);
        expect(Object.keys(result)).not.toContain('totals');
      } finally {
        aliasWarnings.current = [];
      }
    });

    it('returns no mentions for a cap of 0 and offers a value to raise it to', async () => {
      const result = await getConceptEvolution(clientWith(dated(3)), 'Concept', { maxEntries: 0 });
      expect(result.timeline).toEqual([]);
      expect(result.warnings![0].message).toContain('Showing 0 of 3 mentions');
      expect(suggestedValues(result)).toEqual([3]);
    });

    it('floors a fractional cap and treats a negative one as 0', async () => {
      expect(mentionsIn(await getConceptEvolution(clientWith(dated(5)), 'Concept', { maxEntries: 2.9 }))).toBe(2);
      expect(mentionsIn(await getConceptEvolution(clientWith(dated(5)), 'Concept', { maxEntries: -4 }))).toBe(0);
    });
  });

  describe('at the maximum of 500 (#61 acceptance criterion)', () => {
    it('suggests no value past 500 when the cut is below the maximum', async () => {
      const result = await getConceptEvolution(clientWith(dated(600)), 'Concept', { maxEntries: 100 });
      expect(mentionsIn(result)).toBe(100);
      expect(result.hasMore).toBe(true);
      expect(suggestedValues(result)).toEqual([500]);
      expect(result.warnings![0].howToFetchAll).toContain('start_date');
    });

    it('says the maximum was reached, with no howToFetchAll and hasMore false', async () => {
      const result = await getConceptEvolution(clientWith(dated(600)), 'Concept', { maxEntries: 500 });
      expect(mentionsIn(result)).toBe(500);
      expect(result.hasMore).toBe(false);
      expect(result.totals).toEqual({ mentions: 600 });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0].code).toBe('entries_truncated');
      expect(result.warnings![0].howToFetchAll).toBeUndefined();
      expect(result.warnings![0].message).toContain('Showing 500 of 600 mentions');
      expect(result.warnings![0].message).toContain('maximum of 500');
      expect(result.warnings![0].message).toContain("can't be fetched in one call");
      expect(result.warnings![0].message).toContain('start_date');
    });

    it('clamps a larger request to 500 and says what was asked for', async () => {
      const result = await getConceptEvolution(clientWith(dated(600)), 'Concept', { maxEntries: 5000 });
      expect(mentionsIn(result)).toBe(500);
      expect(result.hasMore).toBe(false);
      expect(result.warnings![0].howToFetchAll).toBeUndefined();
      expect(result.warnings![0].message).toContain('5000 was asked for');
    });

    it('returns everything for a larger request when there are 500 or fewer', async () => {
      const result = await getConceptEvolution(clientWith(dated(500)), 'Concept', { maxEntries: 5000 });
      expect(mentionsIn(result)).toBe(500);
      expect(Object.keys(result)).not.toContain('warnings');
    });

    it('never offers a value above 500 for any cap', async () => {
      for (const maxEntries of [0, 1, 250, 499, 500, 501, 100_000]) {
        const result = await getConceptEvolution(clientWith(dated(700)), 'Concept', { maxEntries });
        expect(mentionsIn(result)).toBeLessThanOrEqual(500);
        for (const value of suggestedValues(result)) expect(value).toBeLessThanOrEqual(500);
      }
    });
  });

  // The date filter keeps every block with no journal day, so dates never narrow
  // undated mentions, and the cut drops those first
  describe('what the dates can reach', () => {
    it('does not promise dates help when more than 500 undated mentions are cut at the maximum', async () => {
      const result = await getConceptEvolution(clientWith(undated(600)), 'Concept', {
        maxEntries: 500,
        startDate: 20240101,
        endDate: 20241231
      });
      const warning = result.warnings![0];
      expect(mentionsIn(result)).toBe(500);
      expect(result.hasMore).toBe(false);
      expect(warning.howToFetchAll).toBeUndefined();
      expect(warning.message).toContain('Showing 500 of 600 mentions');
      expect(warning.message).toContain('ignore start_date and end_date');
      expect(warning.message).toContain("can't reach the rest");
      expect(warning.message).not.toMatch(/see the rest|Set start_date/);
      expect(warning.message).not.toContain('timeline ends at');
    });

    it('says the same when undated mentions are cut below the maximum and no dated one is', async () => {
      const result = await getConceptEvolution(clientWith([...dated(2), ...undated(600)]), 'Concept', { maxEntries: 100 });
      expect(result.warnings![0].howToFetchAll).toContain('ignore start_date and end_date');
      expect(result.warnings![0].howToFetchAll).not.toContain('Set start_date');
      expect(suggestedValues(result)).toEqual([500]);
    });

    it('offers dates for the dated mentions and says undated ones ignore them', async () => {
      const result = await getConceptEvolution(clientWith(dated(600)), 'Concept', { maxEntries: 100 });
      expect(result.warnings![0].howToFetchAll).toContain('Set start_date to 20240200 for later dated mentions');
      expect(result.warnings![0].howToFetchAll).toContain('Mentions on non-journal pages ignore the dates');
    });

    it('offers dates without a resume day when the cap keeps no mention', async () => {
      const result = await getConceptEvolution(clientWith(dated(600)), 'Concept', { maxEntries: 0 });
      expect(result.warnings![0].message).not.toContain('timeline ends at');
      expect(result.warnings![0].howToFetchAll).toContain('Narrow start_date and end_date to see dated mentions');
    });
  });

  describe('where the timeline ends', () => {
    it('names the last kept day in the message', async () => {
      // dated(n) runs from 20240101 in steps of one (day numbers, not calendar dates)
      const result = await getConceptEvolution(clientWith(dated(150)), 'Concept');
      expect(result.warnings![0].message).toBe(
        'Showing 100 of 150 mentions (oldest first, undated last; the timeline ends at 20240200).'
      );
      expect(result.timeline[result.timeline.length - 1].date).toBe(20240200);
    });

    it('names it at the maximum too, with how to resume', async () => {
      const result = await getConceptEvolution(clientWith(dated(600)), 'Concept', { maxEntries: 500 });
      expect(result.warnings![0].message).toContain('the timeline ends at 20240600');
      expect(result.warnings![0].message).toContain('Set start_date to 20240600');
      expect(result.warnings![0].message).toContain('that day repeats its kept blocks');
    });

    it('names a day that is split across the cut', async () => {
      const sameDay = [1, 2, 3].map(id => ({ id, content: `Mention ${id}`, page: { journalDay: 20240301 } }));
      const result = await getConceptEvolution(clientWith(sameDay), 'Concept', { maxEntries: 2 });
      expect(result.timeline[0].blocks).toHaveLength(2);
      expect(result.warnings![0].message).toContain('the timeline ends at 20240301');
    });

    it('names no day when the timeline ends on undated mentions', async () => {
      const result = await getConceptEvolution(clientWith([...dated(2), ...undated(3)]), 'Concept', { maxEntries: 4 });
      expect(result.warnings![0].message).toBe('Showing 4 of 5 mentions (oldest first, undated last).');
    });

    it('names no day when the cap keeps nothing', async () => {
      const result = await getConceptEvolution(clientWith(dated(3)), 'Concept', { maxEntries: 0 });
      expect(result.warnings![0].message).toBe('Showing 0 of 3 mentions (oldest first, undated last).');
    });
  });
});
