import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { getPageQuery } from './helpers/page-queries.js';
import { queryJournals } from './helpers/tools.js';
import { BUILT_IN_CONCEPTS } from './helpers/caps.js';
import type { BlockEntity, DateRangeResult, TopConcept } from './helpers/types.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Integration tests for summary.topConcepts on query_by_date_range, against the fixture graph.
 *
 * Read-only. The window is January 2025: seven fixture journals that link 11 pages. The ranking
 * is asserted exactly, and its invariants are checked against the same result's blocks and against
 * page lookups.
 */

/** January 2025, with room for every concept */
const JANUARY = { startDate: 20250101, endDate: 20250131, topConceptsLimit: 50 };

/** Every page the January journals link, ranked by count, then days, then name */
const JANUARY_CONCEPTS = [
  { name: 'project atlas', count: 8, days: 6 },
  { name: 'project borealis', count: 6, days: 5 },
  { name: 'Bob', count: 5, days: 4 },
  { name: 'Alice', count: 3, days: 3 },
  { name: 'atlas', count: 2, days: 2 },
  { name: 'Carol', count: 2, days: 2 },
  { name: 'meeting', count: 2, days: 2 },
  { name: 'bird watching', count: 1, days: 1 },
  { name: 'moving', count: 1, days: 1 },
  { name: 'project cascade', count: 1, days: 1 },
  { name: 'weekly review', count: 1, days: 1 },
];

/** Ids referenced by each block in these trees (nested blocks included). */
function* walk(blocks: BlockEntity[]): Generator<BlockEntity> {
  for (const block of blocks) {
    yield block;
    yield* walk(block.children ?? []);
  }
}

describe('query_by_date_range: summary.topConcepts', () => {
  let client: LogseqClient;
  let result: DateRangeResult;
  let concepts: TopConcept[];

  beforeAll(async () => {
    ({ client } = await connectFixture());

    result = (await queryJournals(client, JANUARY)) as DateRangeResult;
    concepts = result.summary.topConcepts ?? [];
  });

  async function pageIdOf(name: string): Promise<number | undefined> {
    const { query, inputs } = getPageQuery(name);
    const rows = await client.executeDatalogQuery<Array<[any]>>(query, ...inputs);
    const page = rows?.[0]?.[0];
    return page?.id ?? page?.['db/id'];
  }

  it('ranks every page the January journals link', () => {
    expect(result.entries).toHaveLength(7);
    // Task markers and the priority page are built-ins, and left out
    expect(concepts).toEqual(JANUARY_CONCEPTS);
  });

  it('is sorted by count, then days, then name', () => {
    const sorted = concepts.every((c, i) => {
      if (i === 0) return true;
      const p = concepts[i - 1];
      if (p.count !== c.count) return p.count > c.count;
      if (p.days !== c.days) return p.days > c.days;
      return p.name.toLowerCase() <= c.name.toLowerCase();
    });
    expect(sorted, 'topConcepts is not ordered by count desc, days desc, name').toBe(true);
  });

  it('has count >= days >= 1, and days within the returned days', () => {
    expect(concepts.every(c => c.days >= 1), 'a concept has fewer than 1 day').toBe(true);
    expect(concepts.every(c => c.count >= c.days), 'a concept has more days than mentions').toBe(true);
    expect(
      concepts.every(c => c.days <= result.entries.length),
      'a concept spans more days than were returned'
    ).toBe(true);
    expect(concepts.every(c => typeof c.name === 'string' && c.name.length > 0), 'a concept has no name').toBe(true);
    expect(new Set(concepts.map(c => c.name)).size === concepts.length, 'duplicate concepts').toBe(true);
  });

  it('contains no built-in markers', () => {
    expect(
      concepts.every(c => !BUILT_IN_CONCEPTS.has(c.name.toLowerCase())),
      'a built-in page such as a task marker is listed'
    ).toBe(true);
  });

  it('contains no journal pages', async () => {
    const lookups = await Promise.all(
      concepts.map(async c => {
        const { query, inputs } = getPageQuery(c.name);
        const rows = await client.executeDatalogQuery<Array<[any]>>(query, ...inputs);
        const page = rows?.[0]?.[0];
        return page != null && page['journal?'] !== true && page['journal-day'] == null;
      })
    );
    expect(lookups.every(Boolean), 'a journal page, or a page that does not exist, is listed').toBe(true);
  });

  it('counts match the blocks in the same result', async () => {
    for (const concept of concepts) {
      const id = await pageIdOf(concept.name);
      expect(id !== undefined, 'a listed concept has no page').toBe(true);

      let count = 0;
      const dates = new Set<number>();
      for (const entry of result.entries) {
        for (const block of walk(entry.blocks)) {
          if ((block.refs ?? []).some(ref => ref.id === id)) {
            count += 1;
            dates.add(entry.date);
          }
        }
      }
      expect(count === concept.count, 'count differs from the blocks that reference the page').toBe(true);
      expect(dates.size === concept.days, 'days differs from the journal days that reference the page').toBe(true);
    }
  });

  it('gives the same roll-up with include_content: false', async () => {
    const outline = await queryJournals(client, { ...JANUARY, includeContent: false });

    expect(
      JSON.stringify(outline.summary.topConcepts) === JSON.stringify(concepts),
      'the outline summary differs from the full one'
    ).toBe(true);
  });

  it('applies top_concepts_limit as a prefix of the ranking, and 0 leaves it out', async () => {
    const top3 = await queryJournals(client, { ...JANUARY, topConceptsLimit: 3 });
    const none = await queryJournals(client, { ...JANUARY, topConceptsLimit: 0 });

    expect(top3.summary.topConcepts).toEqual(JANUARY_CONCEPTS.slice(0, 3));
    expect(
      JSON.stringify(top3.summary.topConcepts) === JSON.stringify(concepts.slice(0, 3)),
      'the limited list is not a prefix of the longer one'
    ).toBe(true);
    expect(none.summary).not.toHaveProperty('topConcepts');
  });

  it('works over a preset covering the same journals', async () => {
    const preset = await queryJournals(client, { preset: 'this_month', topConceptsLimit: 50 }, new Date(2025, 0, 15, 12, 0));

    expect(preset.summary.topConcepts).toEqual(JANUARY_CONCEPTS);
  });
});
