import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConceptEvolution } from './get-concept-evolution.js';
import { LogseqClient } from '../client.js';

/**
 * #249: `group_by: "week"` must give the same key on every host, whatever its time zone.
 *
 * The checks that need no particular zone (the 20250408/20250409 pair and every day of two years) run in
 * this process, under whatever zone the host has, so they also kill mutants under Stryker. The checks
 * under zones with daylight saving run in a child process (`get-concept-evolution.week-tz.child.mjs`) with
 * `TZ` in its environment. Assigning `process.env.TZ` here would not do: Stryker's vitest runner uses
 * worker threads, whose environment is a copy, so the zone would never change and a test of it would
 * either fail or pass by accident. The child checks that the zone took effect and fails loud if not.
 */

const ZONES = ['America/New_York', 'Europe/Berlin', 'Australia/Sydney'] as const;
const CHILD = fileURLToPath(new URL('./get-concept-evolution.week-tz.child.mjs', import.meta.url));
// vite-node comes with vitest and runs the TypeScript source as it is (tsx is not a dependency)
const VITE_NODE = fileURLToPath(new URL('../../node_modules/vite-node/vite-node.mjs', import.meta.url));
const YEARS = [2024, 2025];

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

/** The week key of every day of `years`, from `floor(dayOfYear / 7) + 1`, computed without `Date`. */
const expectedKeys = (years: number[]) =>
  Object.fromEntries(
    years.flatMap(year =>
      daysOf(year).map(({ day, dayOfYear }) => [
        day,
        `${year}-W${(Math.floor(dayOfYear / 7) + 1).toString().padStart(2, '0')}`
      ])
    )
  );

describe('getConceptEvolution week keys, in the host time zone', () => {
  it('puts 20250408 in 2025-W14 and 20250409 in 2025-W15 (day 98 from 1 January starts week 15)', async () => {
    const keys = await weekKeysOf([20250408, 20250409]);

    expect(keys.get(20250408)).toBe('2025-W14');
    expect(keys.get(20250409)).toBe('2025-W15');
  });

  it.each(YEARS)('keys every day of %i as floor(dayOfYear / 7) + 1', async year => {
    const keys = await weekKeysOf(daysOf(year).map(d => d.day));

    expect(Object.fromEntries(keys)).toEqual(expectedKeys([year]));
  });
});

describe.each(ZONES)('getConceptEvolution week keys under TZ=%s (child process)', zone => {
  it('gives the same keys as in UTC for every day of 2024 and 2025', () => {
    const days = YEARS.flatMap(year => daysOf(year).map(d => d.day));

    const child = spawnSync(process.execPath, [VITE_NODE, CHILD], {
      env: { ...process.env, TZ: zone },
      input: JSON.stringify(days),
      encoding: 'utf8',
      timeout: 60000
    });

    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    const { keys } = JSON.parse(child.stdout) as { keys: Record<string, string> };
    expect(keys).toEqual(expectedKeys(YEARS));
    expect([keys['20250408'], keys['20250409']]).toEqual(['2025-W14', '2025-W15']);
  }, 60000);
});
