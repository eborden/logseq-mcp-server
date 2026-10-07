import { describe, it, expect, vi, afterEach } from 'vitest';
import { getConceptEvolution } from './get-concept-evolution.js';
import { LogseqClient } from '../client.js';

/**
 * #249: `group_by: "week"` must give the same key on every host, whatever its time zone. These tests run
 * the tool under zones that have a daylight-saving change, by assigning `process.env.TZ` (Node re-reads it
 * on assignment; the unit suite runs in forked processes, where this works) and restoring it afterwards.
 * The set-up check fails loud if the zone didn't take. A `TZ` set only in the shell would not do: the
 * default `TZ` may be UTC, where the bug is hidden, and a host that can't switch zones must not pass by accident.
 */

const ZONES = ['UTC', 'America/New_York', 'Europe/Berlin', 'Australia/Sydney'] as const;

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const RESOLVED_CONCEPT = [[{ id: 100, name: 'concept', 'original-name': 'Concept' }, 'name']];

/** A client whose concept is mentioned once per given journal day. */
function clientMentionedOn(days: number[]) {
  const tree = days.map((day, i) => ({
    id: i + 1,
    uuid: `u-${i + 1}`,
    content: `Block ${i + 1} about [[Concept]]`,
    page: { id: 1000 + i, name: `day ${day}`, journalDay: day }
  }));
  const callAPI = vi.fn(async (method: string) => {
    if (method === 'logseq.Editor.getPageBlocksTree') return tree;
    if (method === 'logseq.Editor.getPage') return null;
    throw new Error(`unexpected call: ${method}`);
  });
  const executeDatalogQuery = vi.fn(async (query: string) => (query.includes(':in $ ?n') ? RESOLVED_CONCEPT : []));
  return { callAPI, executeDatalogQuery } as unknown as LogseqClient;
}

/** Week key of each day, as the tool reports it. */
async function weekKeysOf(days: number[]): Promise<Map<number, string>> {
  const result = await getConceptEvolution(clientMentionedOn(days), 'Concept', {
    groupBy: 'week',
    maxEntries: 500 // a whole year (366 days) fits under the cap
  });
  const keys = new Map<number, string>();
  for (const [key, blocks] of Object.entries(result.groupedTimeline!)) {
    for (const block of blocks) keys.set(days[block.id - 1], key);
  }
  return keys;
}

/** Every day of `year` as YYYYMMDD, in order, with its day of the year counted from 0 (no `Date` involved). */
function daysOf(year: number): Array<{ day: number; dayOfYear: number }> {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const days: Array<{ day: number; dayOfYear: number }> = [];
  let dayOfYear = 0;
  lengths.forEach((length, m) => {
    for (let d = 1; d <= length; d++) days.push({ day: year * 10000 + (m + 1) * 100 + d, dayOfYear: dayOfYear++ });
  });
  return days;
}

describe.each(ZONES)('getConceptEvolution week keys under TZ=%s', zone => {
  const useZone = () => {
    process.env.TZ = zone;
    // Fail loud if the zone did not take: a zone with daylight saving has a different offset in January and April.
    if (zone !== 'UTC') {
      expect(new Date(2025, 0, 1).getTimezoneOffset()).not.toBe(new Date(2025, 3, 9).getTimezoneOffset());
    }
  };

  it('puts 20250408 in 2025-W14 and 20250409 in 2025-W15 (day 98 from 1 January starts week 15)', async () => {
    useZone();

    const keys = await weekKeysOf([20250408, 20250409]);

    expect(keys.get(20250408)).toBe('2025-W14');
    expect(keys.get(20250409)).toBe('2025-W15');
  });

  it.each([2024, 2025])('keys every day of %i as floor(dayOfYear / 7) + 1', async year => {
    useZone();
    const days = daysOf(year);

    const keys = await weekKeysOf(days.map(d => d.day));

    const expected = new Map(
      days.map(({ day, dayOfYear }) => [day, `${year}-W${(Math.floor(dayOfYear / 7) + 1).toString().padStart(2, '0')}`])
    );
    expect(keys).toEqual(expected);
  });
});
