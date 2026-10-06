import { describe, it, expect, beforeAll } from 'vitest';
import { access } from 'fs/promises';
import { loadConfig, resolveConfigPath } from '../../src/config.js';
import { LogseqClient } from '../../src/client.js';
import { DatalogQueryBuilder } from '../../src/datalog/queries.js';
import {
  queryJournals,
  BUILT_IN_CONCEPTS,
  DateRangeResult,
  TopConcept
} from '../../src/tools/query-by-date-range.js';
import { BlockEntity } from '../../src/types.js';

/**
 * Integration tests for summary.topConcepts on query_by_date_range.
 *
 * Read-only. Checks invariants of the roll-up against the same result's blocks and
 * against page lookups, and never asserts on or prints concept names or counts:
 * every assertion is on a boolean, so a failure message can't echo graph data.
 *
 * Requires LogSeq running with the HTTP API enabled, ~/.logseq-mcp/config.json,
 * and journals whose last 7 days link to at least a few pages.
 * See tests/integration/setup.md.
 */

const SETUP_HINT = 'See tests/integration/setup.md';

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
    const configPath = resolveConfigPath();
    try {
      await access(configPath);
    } catch {
      throw new Error(`Config file not found at ~/.logseq-mcp/config.json. ${SETUP_HINT}`);
    }
    client = new LogseqClient(await loadConfig(configPath));
    try {
      await client.callAPI('logseq.App.getCurrentGraph');
    } catch (error) {
      throw new Error(
        `Cannot connect to LogSeq HTTP API: ${error instanceof Error ? error.message : 'Unknown error'}\n${SETUP_HINT}`
      );
    }

    result = (await queryJournals(client, { lastN: 7, topConceptsLimit: 50 })) as DateRangeResult;
    concepts = result.summary.topConcepts ?? [];
  });

  async function pageIdOf(name: string): Promise<number | undefined> {
    const { query, inputs } = DatalogQueryBuilder.getPage(name);
    const rows = await client.executeDatalogQuery<Array<[any]>>(query, ...inputs);
    const page = rows?.[0]?.[0];
    return page?.id ?? page?.['db/id'];
  }

  it('is found, with the journals it summarises', () => {
    expect(
      result.entries.length,
      `No journal pages found. The graph needs journals. ${SETUP_HINT}`
    ).toBeGreaterThan(0);
    expect(
      concepts.length,
      `The last 7 journals link to no pages, so topConcepts is empty. Link a few pages in recent journals. ${SETUP_HINT}`
    ).toBeGreaterThan(0);
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
        const { query, inputs } = DatalogQueryBuilder.getPage(c.name);
        const rows = await client.executeDatalogQuery<Array<[any]>>(query, ...inputs);
        const page = rows?.[0]?.[0];
        return page != null && page['journal?'] !== true && page['journal-day'] == null;
      })
    );
    expect(lookups.every(Boolean), 'a journal page, or a page that does not exist, is listed').toBe(true);
  });

  it('counts match the blocks in the same result (the first few concepts)', async () => {
    for (const concept of concepts.slice(0, 5)) {
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
    const outline = await queryJournals(client, { lastN: 7, topConceptsLimit: 50, includeContent: false });

    expect(
      JSON.stringify(outline.summary.topConcepts) === JSON.stringify(concepts),
      'the outline summary differs from the full one'
    ).toBe(true);
  });

  it('applies top_concepts_limit as a prefix of the ranking, and 0 leaves it out', async () => {
    const top3 = await queryJournals(client, { lastN: 7, topConceptsLimit: 3 });
    const none = await queryJournals(client, { lastN: 7, topConceptsLimit: 0 });

    expect(top3.summary.topConcepts!.length).toBe(Math.min(3, concepts.length));
    expect(
      JSON.stringify(top3.summary.topConcepts) === JSON.stringify(concepts.slice(0, 3)),
      'the limited list is not a prefix of the longer one'
    ).toBe(true);
    expect(none.summary).not.toHaveProperty('topConcepts');
  });

  it('works over an explicit range and a preset', async () => {
    const { start, end } = result.dateRange;
    const explicit = await queryJournals(client, { startDate: start, endDate: end, topConceptsLimit: 50 });
    const preset = await queryJournals(client, { preset: 'last_week' });

    expect(
      JSON.stringify(explicit.summary.topConcepts) === JSON.stringify(concepts),
      'an explicit range over the same journals gives a different roll-up'
    ).toBe(true);
    expect(Array.isArray(preset.summary.topConcepts)).toBe(true);
  });
});
