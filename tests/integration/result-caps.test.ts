import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LogseqClient } from '../../src/client.js';
import { createServer } from '../../src/index.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, searchBlocksWithMeta } from '../../src/tools/search-blocks.js';
import { DEFAULT_MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS } from '../../src/tools/get-context-for-query.js';
import { DEFAULT_LIST_PAGES_LIMIT, MAX_LIST_PAGES_LIMIT } from '../../src/tools/list-pages.js';
import { DEFAULT_MAX_ENTRIES, MAX_ENTRIES } from '../../src/tools/get-concept-evolution.js';
import { DEFAULT_DATE_RANGE_MAX_BLOCKS, MAX_DATE_RANGE_BLOCKS } from '../../src/tools/query-by-date-range.js';
import {
  DEFAULT_MAX_BLOCKS_PER_PAGE,
  DEFAULT_MAX_PAGES,
  MAX_BLOCKS_PER_PAGE,
  MAX_PAGES,
} from '../../src/tools/get-backlinks.js';
import { connectFixture, FIXTURE_JOURNAL_DAYS } from './helpers/fixture-client.js';

/**
 * Result caps hold against a real graph (#61): no tool returns more than its
 * maximum, whatever the caller asks for, and a cut is reported in meta. One
 * describe block per capped tool; later cap PRs add theirs here.
 *
 * Against the fixture graph. Read-only. Its ~494 blocks (478 of them with the letter e) are fewer than
 * search_blocks' maximum of 500, so through MCP only the cut below the maximum
 * and the clamp can be seen; the cut at the maximum runs through
 * searchBlocksWithMeta with a lower maxLimit, the same code with a smaller
 * bound. The keyword `neighbour` matches 190 blocks (the hub fixture), past
 * get_context_for_query's maximum of 100. list_pages needs more than 200
 * non-journal pages, which the hub fixture's pages supply. Assertions on page
 * names compare booleans or counts, so a failure prints no names from the graph.
 * get_concept_evolution's maximum of 500 mentions is out of reach: the hub page has
 * ~140 mentions, the most of any fixture page. Through MCP only the default cut and
 * the clamp can be seen; the cut at 500 is covered by the unit tests, which feed the
 * tool 600 mentions.
 * query_by_date_range's default of 200 blocks and maximum of 1000 are out of reach the
 * same way: the fixture's journals hold well under 200 blocks. The test passes small
 * caps through MCP (the same code, a smaller bound), and the unit tests feed the tool
 * 1,100 blocks for the cut at the maximum.
 * get_backlinks' maximums of 100 pages and 50 blocks per page are out of reach the same way:
 * the hub has 61 source pages and no page has more than 12 linking blocks. Through MCP the
 * default cuts, the values below the maximum and the clamp can be seen; the cut at each
 * maximum is covered by the unit tests, which feed the tool 150 pages and 80 blocks.
 */

interface Meta {
  hasMore: boolean;
  warnings: Array<{ code: string; message: string; howToFetchAll?: string }>;
  totals?: Record<string, number>;
}

describe('result caps (#61)', () => {
  let mcp: Client;
  let client: LogseqClient;

  beforeAll(async () => {
    ({ client } = await connectFixture());
    const server = createServer(client, { tips: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcp = new Client({ name: 'result-caps-test', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  });

  afterAll(async () => {
    await mcp?.close();
  });

  async function call(name: string, args: Record<string, unknown>) {
    const result = (await mcp.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    return result;
  }

  /** Every `Set <param> to N` in a warning names a value within the maximum. */
  function expectNoSuggestionPast(meta: Meta, param: string, max: number) {
    for (const warning of meta.warnings) {
      for (const match of (warning.howToFetchAll ?? '').matchAll(new RegExp(`Set ${param} to (\\d+)`, 'g'))) {
        expect(Number(match[1]), `${warning.code} suggests ${param} past ${max}`).toBeLessThanOrEqual(max);
      }
    }
  }

  describe('logseq_search_blocks limit (max 500)', () => {
    // "e" is in all but 16 of the fixture's blocks (478 of ~494). The crowded topic's blocks avoid it on
    // purpose to keep this margin: see "The crowded topic" in tests/fixtures/README.md
    const QUERY = 'e';
    let matches: number;

    async function search(limit?: number) {
      const args = limit === undefined ? { query: QUERY } : { query: QUERY, limit };
      const result = await call('logseq_search_blocks', args);
      // A null API response sends no meta block; say so instead of a bare JSON.parse error
      expect(result.content, `limit ${limit ?? 'default'}: results block plus meta block`).toHaveLength(2);
      return {
        text: result.content[0].text,
        results: JSON.parse(result.content[0].text) as unknown[],
        meta: (JSON.parse(result.content[1].text) as { meta: Meta }).meta,
      };
    }

    beforeAll(async () => {
      const { meta } = await searchBlocksWithMeta(client, QUERY, 0);
      matches = meta!.totals!.matches;
      // Every block bar 16 (the fixture holds ~494): computed, so a new fixture block does not break it
      expect(matches, 'too few fixture blocks hold the letter e to see the default cut').toBeGreaterThan(DEFAULT_SEARCH_LIMIT);
      expect(
        matches,
        `${matches} blocks hold the letter e, and this test needs fewer than ${MAX_SEARCH_LIMIT}. ` +
          'New fixture blocks must avoid the letter e: see "The crowded topic" in tests/fixtures/README.md'
      ).toBeLessThan(MAX_SEARCH_LIMIT);
    });

    it('the default cuts below the maximum and says which limit gets the rest', async () => {
      const { results, meta } = await search();

      expect(results).toHaveLength(DEFAULT_SEARCH_LIMIT);
      expect(meta.totals).toEqual({ matches });
      expect(meta.hasMore).toBe(true);
      expect(meta.warnings.map(w => w.code)).toEqual(['results_truncated']);
      expect(meta.warnings[0].howToFetchAll).toMatch(new RegExp(`^Set limit to ${matches}\\b`));
      expectNoSuggestionPast(meta, 'limit', MAX_SEARCH_LIMIT);
    });

    it('the maximum returns every match, and a limit above it clamps to the same blocks', async () => {
      const atMax = await search(MAX_SEARCH_LIMIT);
      const above = await search(1000);

      expect(atMax.results).toHaveLength(matches);
      expect(atMax.meta).toMatchObject({ hasMore: false, warnings: [], totals: { matches } });
      expect(above.text).toBe(atMax.text);
      expect(above.meta).toEqual(atMax.meta);
    });

    it('a cut at the maximum is a warning with nothing to raise', async () => {
      // The fixture has fewer blocks than 500, so a lower bound stands in for it
      const max = 100;
      for (const limit of [max, 1000]) {
        const { results, meta } = await searchBlocksWithMeta(client, QUERY, limit, false, false, max);

        expect(results, `limit ${limit}`).toHaveLength(max);
        expect(meta!.hasMore).toBe(false);
        expect(meta!.warnings).toHaveLength(1);
        expect(meta!.warnings[0].code).toBe('results_truncated');
        expect(meta!.warnings[0].message).toContain(`maximum of ${max}`);
        expect(meta!.warnings[0].howToFetchAll).toBeUndefined();
      }
    });
  });

  describe('logseq_get_context_for_query max_search_results (max 100)', () => {
    // The query names no [[topic]], so the tool falls back to a keyword search
    const QUERY = 'neighbour';
    const VALUES: Array<number | undefined> = [undefined, MAX_SEARCH_RESULTS, 1000];

    interface QueryBody extends Meta {
      searchResults?: unknown[];
    }

    async function ask(query: string, max?: number): Promise<QueryBody> {
      const args = max === undefined ? { query } : { query, max_search_results: max };
      return JSON.parse((await call('logseq_get_context_for_query', args)).content[0].text) as QueryBody;
    }

    /** Hits before the cut: the length when nothing was cut, else the count the warning names. */
    function totalHits(body: QueryBody): number {
      const cut = body.warnings.find(w => w.code === 'search_results_truncated');
      if (!cut) return body.searchResults!.length;
      const match = cut.message.match(/^Showing \d+ of (\d+) keyword hits/);
      expect(match, `search_results_truncated message names the total: ${cut.message}`).not.toBeNull();
      return Number(match![1]);
    }

    it('never returns more than the maximum, reports every cut, and clamps to the same hits', { timeout: 180_000 }, async () => {
      const query = QUERY;
      expect(totalHits(await ask(query, 1))).toBe(190);

      const hitsAt = new Map<number | undefined, string>();
      for (const max of VALUES) {
        const body = await ask(query!, max);
        const label = `max_search_results ${max ?? 'default'}`;
        const effective = Math.min(max ?? DEFAULT_MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
        const total = totalHits(body);
        hitsAt.set(max, JSON.stringify(body.searchResults));

        expect(Array.isArray(body.searchResults), label).toBe(true);
        expect(body.searchResults!.length, label).toBeLessThanOrEqual(MAX_SEARCH_RESULTS);
        expect(body.searchResults!.length, label).toBe(Math.min(effective, total));
        expect(total, label).toBe(190);
        expectNoSuggestionPast(body, 'max_search_results', MAX_SEARCH_RESULTS);
        expect(body.warnings.map(w => w.code), label).toEqual(['search_results_truncated']);

        if (effective === MAX_SEARCH_RESULTS) {
          // Cut at the maximum: the warning is the signal, and nothing can be raised
          expect(body.hasMore, label).toBe(false);
          expect(body.warnings[0].message).toContain(`maximum of ${MAX_SEARCH_RESULTS}`);
          expect(body.warnings[0].howToFetchAll).toBeUndefined();
        } else {
          // The default slice, which used to be silent: raising max_search_results gets more
          expect(body.hasMore, label).toBe(true);
          expect(body.warnings[0].howToFetchAll).toMatch(/^Set max_search_results to \d+/);
        }
      }
      // Above the maximum the caller gets exactly the hits the maximum gives
      expect(hitsAt.get(1000)).toBe(hitsAt.get(MAX_SEARCH_RESULTS));
    });
  });

  describe('logseq_list_pages limit and offset (default 200, max 1000)', () => {
    interface ListBody extends Partial<Meta> {
      pages: string[];
      total: number;
    }

    async function list(args: Record<string, unknown>): Promise<ListBody> {
      return JSON.parse((await call('logseq_list_pages', args)).content[0].text) as ListBody;
    }

    /** Same names in the same order. Compared as a boolean so a failure prints no page names. */
    const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

    it('cuts at the default, clamps to the maximum, and pages through every page with offset', { timeout: 120_000 }, async () => {
      const first = await list({});
      expect(first.warnings?.map(w => w.code) ?? [], 'a page list is available').not.toContain('pages_unavailable');
      expect(
        first.total,
        `The graph has ${first.total} non-journal pages, no more than the default of ${DEFAULT_LIST_PAGES_LIMIT}, ` +
          'so the cap was never tested. Use a graph with more pages; see tests/integration/setup.md'
      ).toBeGreaterThan(DEFAULT_LIST_PAGES_LIMIT);

      // The default: 200 pages, the cut reported, and the next offset named
      expect(first.pages.length).toBe(DEFAULT_LIST_PAGES_LIMIT);
      expect(first.hasMore).toBe(true);
      expect(first.warnings!.map(w => w.code)).toEqual(['pages_truncated']);
      expect(first.warnings![0].howToFetchAll).toContain(`offset to ${DEFAULT_LIST_PAGES_LIMIT} for the next page`);
      expectNoSuggestionPast(first as Meta, 'limit', MAX_LIST_PAGES_LIMIT);

      // At and above the maximum: never more than 1000, and the same pages either way
      const atMax = await list({ limit: MAX_LIST_PAGES_LIMIT });
      const above = await list({ limit: 5000 });
      for (const [label, body] of [['limit 1000', atMax], ['limit 5000', above]] as const) {
        expect(body.pages.length, label).toBe(Math.min(MAX_LIST_PAGES_LIMIT, first.total));
        expect(body.total, `${label}: total counts every page`).toBe(first.total);
        if (first.total > MAX_LIST_PAGES_LIMIT) {
          expectNoSuggestionPast(body as Meta, 'limit', MAX_LIST_PAGES_LIMIT);
          // Cut at the maximum: the next offset still fetches the rest
          expect(body.hasMore, label).toBe(true);
          expect(body.warnings![0].message, label).toContain(`maximum of ${MAX_LIST_PAGES_LIMIT}`);
          expect(body.warnings![0].howToFetchAll, label).toBe(`Set offset to ${MAX_LIST_PAGES_LIMIT} for the next page.`);
        } else {
          expect(body.hasMore, label).toBeUndefined();
          expect(body.warnings, label).toBeUndefined();
        }
      }
      expect(same(above.pages, atMax.pages), 'limit 5000 returns the pages limit 1000 does').toBe(true);
      expect(same(first.pages, atMax.pages.slice(0, DEFAULT_LIST_PAGES_LIMIT)), 'the default page is the first 200').toBe(true);

      // Following each warning's offset visits every page once, and the last page has no warning
      const seen: string[] = [];
      let offset = 0;
      for (let calls = 0; calls < 50; calls++) {
        const body = await list({ limit: MAX_LIST_PAGES_LIMIT, offset });
        expect(body.total, `offset ${offset}: total counts every page`).toBe(first.total);
        seen.push(...body.pages);
        if (!body.hasMore) {
          expect(body.warnings, `offset ${offset}: the last page has no warning`).toBeUndefined();
          break;
        }
        offset = Number(body.warnings![0].howToFetchAll!.match(/Set offset to (\d+) for the next page/)![1]);
      }
      expect(seen.length, 'paging returns every page').toBe(first.total);
      expect(new Set(seen).size, 'paging returns no page twice').toBe(first.total);
    });
  });

  describe('logseq_get_concept_evolution max_entries (default 100, max 500)', () => {
    // The hub page's own blocks plus every block that links it
    const CONCEPT = 'hub central';

    interface EvolutionBody extends Partial<Meta> {
      timeline: Array<{ date: number | null; blocks: unknown[] }>;
      summary: { totalMentions: number };
    }

    async function evolve(max?: number): Promise<{ text: string; body: EvolutionBody }> {
      const args = max === undefined ? { concept_name: CONCEPT } : { concept_name: CONCEPT, max_entries: max };
      const text = (await call('logseq_get_concept_evolution', args)).content[0].text;
      return { text, body: JSON.parse(text) as EvolutionBody };
    }

    const mentions = (body: EvolutionBody) => body.timeline.reduce((sum, entry) => sum + entry.blocks.length, 0);

    it('never returns more than the cap, reports every cut, and clamps to the same mentions', async () => {
      const atMax = await evolve(MAX_ENTRIES);
      const total = mentions(atMax.body);
      expect(
        total,
        `The hub page has ${total} mentions, not more than the default of ${DEFAULT_MAX_ENTRIES}, ` +
          'so the cap was never tested. See tests/fixtures/README.md'
      ).toBeGreaterThan(DEFAULT_MAX_ENTRIES);
      expect(total, 'the fixture must stay under the maximum for this test to see every mention').toBeLessThan(MAX_ENTRIES);

      // At the maximum nothing is cut, so there is no meta at all
      expect(atMax.body.summary.totalMentions).toBe(total);
      expect(atMax.body.warnings).toBeUndefined();
      expect(atMax.body.hasMore).toBeUndefined();

      // A value above the maximum is clamped to it, not rejected
      expect((await evolve(5000)).text).toBe(atMax.text);

      for (const max of [undefined, 1, 50, DEFAULT_MAX_ENTRIES, 101, total - 1]) {
        const { body } = await evolve(max);
        const label = `max_entries ${max ?? 'default'}`;
        const effective = Math.min(max ?? DEFAULT_MAX_ENTRIES, MAX_ENTRIES);
        expect(mentions(body), label).toBe(effective);
        expect(mentions(body), label).toBeLessThanOrEqual(MAX_ENTRIES);
        expect(body.summary.totalMentions, `${label}: the summary counts every mention`).toBe(total);
        expect(body.totals, label).toEqual({ mentions: total });
        expect(body.warnings!.map(w => w.code), label).toEqual(['entries_truncated']);
        // Below the maximum the warning says which value gets the rest, and it is within the maximum
        expect(body.hasMore, label).toBe(true);
        expect(body.warnings![0].howToFetchAll, label).toMatch(new RegExp(`^Set max_entries to ${total}\\b`));
        expectNoSuggestionPast(body as Meta, 'max_entries', MAX_ENTRIES);
      }

      // At the cap exactly, nothing is cut
      const exact = await evolve(total);
      expect(exact.text).toBe(atMax.text);
    });
  });

  describe('logseq_query_by_date_range max_blocks (default 200, max 1000)', () => {
    interface SlimNode {
      uuid: string;
      children?: SlimNode[];
    }
    interface RangeBody extends Partial<Meta> {
      dateRange: { start: number; end: number };
      entries: Array<{ date: number; blocks: SlimNode[]; snippets?: string[] }>;
      summary: { totalDays: number; totalBlocks: number };
    }

    // Every fixture journal, and nothing LogSeq adds for today
    const START = Math.min(...FIXTURE_JOURNAL_DAYS);
    const END = Math.max(...FIXTURE_JOURNAL_DAYS);

    async function range(max?: number, extra: Record<string, unknown> = {}) {
      const args = { start_date: START, end_date: END, ...(max === undefined ? {} : { max_blocks: max }), ...extra };
      const text = (await call('logseq_query_by_date_range', args)).content[0].text;
      return { text, body: JSON.parse(text) as RangeBody };
    }

    /** Every block uuid of the trees in document order: a block, then its children. */
    const flatten = (blocks: SlimNode[]): string[] => blocks.flatMap(b => [b.uuid, ...flatten(b.children ?? [])]);
    const uuidsOf = (body: RangeBody) => body.entries.flatMap(e => flatten(e.blocks));

    it('never returns more blocks than the cap, reports every cut, and clamps to the same blocks', async () => {
      const atMax = await range(MAX_DATE_RANGE_BLOCKS);
      const all = uuidsOf(atMax.body);
      const total = all.length;
      const days = atMax.body.entries.length;
      expect(total, 'the fixture journals hold too few blocks to test a cap. See tests/fixtures/README.md').toBeGreaterThan(5);
      expect(total, 'the fixture journals must stay under the maximum for this test to see every block').toBeLessThanOrEqual(
        MAX_DATE_RANGE_BLOCKS
      );
      expect(atMax.body.entries.some(e => e.blocks.some(b => (b.children ?? []).length > 0)), 'no nested block to count').toBe(true);

      // At the maximum nothing is cut, so there is no meta at all
      expect(atMax.body.warnings).toBeUndefined();
      expect(atMax.body.hasMore).toBeUndefined();
      expect(atMax.body.totals).toBeUndefined();

      // A value above the maximum is clamped to it, not rejected
      expect((await range(5000)).text).toBe(atMax.text);

      for (const max of [undefined, 1, 2, 5, Math.floor(total / 2), total - 1, total, total + 1]) {
        const { text, body } = await range(max);
        const label = `max_blocks ${max ?? 'default'}`;
        const effective = Math.min(max ?? DEFAULT_DATE_RANGE_MAX_BLOCKS, MAX_DATE_RANGE_BLOCKS);
        expect(uuidsOf(body).length, label).toBe(Math.min(effective, total));
        expect(uuidsOf(body).length, label).toBeLessThanOrEqual(MAX_DATE_RANGE_BLOCKS);

        if (effective >= total) {
          expect(text, `${label}: nothing is cut, so the result is the full one`).toBe(atMax.text);
          continue;
        }
        // The first blocks in document order, with the summary and the queried range unchanged
        expect(uuidsOf(body), label).toEqual(all.slice(0, effective));
        expect(body.summary, `${label}: the summary covers every block`).toEqual(atMax.body.summary);
        expect(body.dateRange, label).toEqual(atMax.body.dateRange);
        expect(body.totals, label).toEqual({ blocks: total, days });
        expect(body.warnings!.map(w => w.code), label).toEqual(['blocks_truncated']);
        // Below the maximum the warning says which value gets the rest, and it is within the maximum
        expect(body.hasMore, label).toBe(true);
        expect(body.warnings![0].howToFetchAll, label).toMatch(new RegExp(`^Set max_blocks to ${total}\\b`));
        expectNoSuggestionPast(body as Meta, 'max_blocks', MAX_DATE_RANGE_BLOCKS);

        // The warning names the last day kept, and a query from that day reaches everything after the cut
        const lastDay = body.entries[body.entries.length - 1]?.date;
        if (lastDay === undefined) continue;
        expect(body.warnings![0].message, label).toContain(`the entries end at ${lastDay}`);
        const resumed = (await range(MAX_DATE_RANGE_BLOCKS, { start_date: lastDay })).body;
        const expected = atMax.body.entries.filter(e => e.date >= lastDay).flatMap(e => flatten(e.blocks));
        expect(uuidsOf(resumed), `${label}: resuming at the last kept day`).toEqual(expected);

        // The same query at the same cap must move forward, or the advice could loop: it reaches
        // blocks the first call did not return, unless the last kept day alone filled the cap
        const keptBefore = uuidsOf({ ...body, entries: body.entries.slice(0, -1) }).length;
        const again = uuidsOf((await range(max, { start_date: lastDay })).body);
        if (keptBefore > 0) {
          const seen = new Set(uuidsOf(body));
          expect(again.some(uuid => !seen.has(uuid)), `${label}: resuming at the same cap reaches new blocks`).toBe(true);
        } else {
          expect(again, `${label}: the first day alone fills the cap, so resuming there repeats it`).toEqual(uuidsOf(body));
        }

        // A kept block that lost children is marked, and the warning names the marker exactly then
        const marked = JSON.stringify(body.entries).includes('"childrenTruncated":true');
        expect(body.warnings![0].message.includes('childrenTruncated'), `${label}: warning matches the marks`).toBe(marked);
      }
    });

    it('counts top-level blocks for the outline, and the summary still covers every block', async () => {
      const atMax = await range(MAX_DATE_RANGE_BLOCKS, { include_content: false });
      const snippets = (body: RangeBody) => body.entries.reduce((sum, e) => sum + (e.snippets?.length ?? 0), 0);
      const topLevel = snippets(atMax.body);
      expect(topLevel, 'the fixture journals hold too few top-level blocks to test a cap').toBeGreaterThan(3);
      expect(atMax.body.warnings).toBeUndefined();

      for (const max of [1, 2, topLevel - 1]) {
        const { body } = await range(max, { include_content: false });
        expect(snippets(body), `max_blocks ${max}`).toBe(max);
        expect(body.summary, `max_blocks ${max}`).toEqual(atMax.body.summary);
        expect(body.totals, `max_blocks ${max}`).toEqual({ blocks: topLevel, days: atMax.body.entries.length });
        expect(body.warnings![0].code, `max_blocks ${max}`).toBe('blocks_truncated');
        expect(body.warnings![0].message, `max_blocks ${max}`).toContain('top-level only');
      }
    });
  });

  describe('logseq_get_backlinks max_pages and max_blocks_per_page (default 20 and 10, max 100 and 50)', () => {
    // The hub: 61 source pages (60 pages and a journal), 66 blocks, none of them over 2 per page.
    // The crowded topic: 2 source pages, one with 12 linking blocks and one with 2. A project
    // with an alias takes the alias-group query (#69) instead of the Editor call.
    const HUB = 'hub central';
    const CROWDED = 'popular topic';
    const ALIASED = 'project atlas';

    type BacklinkTuple = [{ id: number; name?: string }, Array<{ uuid: string }>];
    interface BacklinksBody {
      text: string;
      results: BacklinkTuple[];
      /** The second content block's meta, absent when the tool sent none */
      meta?: Partial<Meta>;
    }

    async function backlinks(page: string, maxPages?: number, maxBlocksPerPage?: number): Promise<BacklinksBody> {
      const args = {
        page_name: page,
        ...(maxPages === undefined ? {} : { max_pages: maxPages }),
        ...(maxBlocksPerPage === undefined ? {} : { max_blocks_per_page: maxBlocksPerPage }),
      };
      const result = await call('logseq_get_backlinks', args);
      return {
        text: result.content[0].text,
        results: JSON.parse(result.content[0].text) as BacklinkTuple[],
        meta: result.content[1] ? (JSON.parse(result.content[1].text) as { meta: Partial<Meta> }).meta : undefined,
      };
    }

    const blockUuids = (results: BacklinkTuple[]) => results.map(([, blocks]) => blocks.map(b => b.uuid));
    const codes = (body: BacklinksBody) => (body.meta?.warnings ?? []).map(w => w.code);

    it('never returns more pages than max_pages, keeps the same first pages, and reports every cut', async () => {
      const full = await backlinks(HUB, MAX_PAGES);
      const total = full.results.length;
      const blocks = blockUuids(full.results).flat().length;
      expect(total, 'the hub fixture needs more source pages than the default cap. See tests/fixtures/README.md').toBeGreaterThan(DEFAULT_MAX_PAGES);
      expect(total, 'the hub fixture must stay under the maximum for this test to see every page').toBeLessThanOrEqual(MAX_PAGES);
      // Nothing is cut, so the maximum sends no warning and no totals
      expect(codes(full)).toEqual([]);
      expect(full.meta?.totals).toBeUndefined();
      expect(full.meta?.hasMore ?? false).toBe(false);

      // A value above the maximum is clamped to it, not rejected
      expect((await backlinks(HUB, 5000)).text).toBe(full.text);

      for (const max of [undefined, 0, 1, 5, DEFAULT_MAX_PAGES, total - 1, total, total + 1, MAX_PAGES]) {
        const body = await backlinks(HUB, max);
        const label = `max_pages ${max ?? 'default'}`;
        const effective = Math.min(max ?? DEFAULT_MAX_PAGES, MAX_PAGES);
        expect(body.results.length, label).toBeLessThanOrEqual(MAX_PAGES);
        expect(body.results.length, label).toBe(Math.min(effective, total));
        // The first pages of the full list, in its order, with their blocks
        expect(blockUuids(body.results), label).toEqual(blockUuids(full.results).slice(0, effective));

        if (effective >= total) {
          expect(body.text, `${label}: nothing is cut, so the result is the full one`).toBe(full.text);
          expect(codes(body), label).toEqual([]);
          continue;
        }
        expect(codes(body), label).toEqual(['pages_truncated']);
        expect(body.meta!.totals, label).toEqual({ pages: total, blocks });
        // Below the maximum the warning says which value gets the rest, and it is within the maximum
        expect(body.meta!.hasMore, label).toBe(true);
        expect(body.meta!.warnings![0].howToFetchAll, label).toMatch(new RegExp(`^Set max_pages to ${total}\\b`));
        expectNoSuggestionPast(body.meta as Meta, 'max_pages', MAX_PAGES);
        // The order is not a ranking, and the per-page cap is a separate one
        expect(body.meta!.warnings![0].message, label).toContain('the first ones listed, not ranked');
        expect(body.meta!.warnings![0].message, label).toContain('Blocks per page are capped separately by max_blocks_per_page.');
      }
    });

    it('never returns more blocks per page than max_blocks_per_page, keeps the first blocks, and reports every cut', async () => {
      const full = await backlinks(CROWDED, undefined, MAX_BLOCKS_PER_PAGE);
      const counts = full.results.map(([, blocks]) => blocks.length).sort((a, b) => b - a);
      expect(counts[0], 'the crowded topic needs a source page with more than the default cap. See tests/fixtures/README.md').toBeGreaterThan(
        DEFAULT_MAX_BLOCKS_PER_PAGE
      );
      expect(counts[0], 'the crowded topic must stay under the maximum for this test to see every block').toBeLessThanOrEqual(MAX_BLOCKS_PER_PAGE);
      expect(counts.length, 'the crowded topic needs a second, smaller source page').toBeGreaterThan(1);
      expect(codes(full)).toEqual([]);
      const largest = counts[0];
      const totalBlocks = counts.reduce((a, b) => a + b, 0);

      expect((await backlinks(CROWDED, undefined, 5000)).text).toBe(full.text);

      for (const max of [undefined, 0, 1, counts[1], DEFAULT_MAX_BLOCKS_PER_PAGE, largest - 1, largest, largest + 1, MAX_BLOCKS_PER_PAGE]) {
        const body = await backlinks(CROWDED, undefined, max);
        const label = `max_blocks_per_page ${max ?? 'default'}`;
        const effective = Math.min(max ?? DEFAULT_MAX_BLOCKS_PER_PAGE, MAX_BLOCKS_PER_PAGE);
        expect(body.results.length, `${label}: every source page stays`).toBe(full.results.length);
        for (const [i, uuids] of blockUuids(body.results).entries()) {
          expect(uuids.length, label).toBeLessThanOrEqual(MAX_BLOCKS_PER_PAGE);
          expect(uuids, label).toEqual(blockUuids(full.results)[i].slice(0, effective));
        }

        if (effective >= largest) {
          expect(body.text, `${label}: nothing is cut, so the result is the full one`).toBe(full.text);
          expect(codes(body), label).toEqual([]);
          continue;
        }
        expect(codes(body), label).toEqual(['page_blocks_truncated']);
        expect(body.meta!.totals, label).toEqual({ pages: full.results.length, blocks: totalBlocks });
        expect(body.meta!.hasMore, label).toBe(true);
        expect(body.meta!.warnings![0].howToFetchAll, label).toBe(
          `Set max_blocks_per_page to ${largest} (or higher) to get every block of these pages.`
        );
        expectNoSuggestionPast(body.meta as Meta, 'max_blocks_per_page', MAX_BLOCKS_PER_PAGE);
      }
    });

    it('both caps together cut pages first, then the blocks of the pages kept', async () => {
      const full = await backlinks(CROWDED, MAX_PAGES, MAX_BLOCKS_PER_PAGE);
      const body = await backlinks(CROWDED, 1, 1);

      expect(body.results).toHaveLength(1);
      expect(blockUuids(body.results)).toEqual([blockUuids(full.results)[0].slice(0, 1)]);
      expect(codes(body)).toEqual(['pages_truncated', 'page_blocks_truncated']);
      expect(body.meta!.totals).toEqual({
        pages: full.results.length,
        blocks: blockUuids(full.results).flat().length,
      });
    });

    it('caps a page with aliases the same way, through the alias-group query', async () => {
      const full = await backlinks(ALIASED, MAX_PAGES, MAX_BLOCKS_PER_PAGE);
      const pages = full.results.length;
      const blocks = blockUuids(full.results).flat().length;
      expect(pages, 'the aliased project needs more than 3 source pages. See tests/fixtures/README.md').toBeGreaterThan(3);
      expect(full.meta?.warnings ?? [], 'the maximums cut nothing').toEqual([]);

      const fewer = await backlinks(ALIASED, 3);
      expect(blockUuids(fewer.results)).toEqual(blockUuids(full.results).slice(0, 3));
      expect(codes(fewer)).toEqual(['pages_truncated']);
      expect(fewer.meta!.totals).toEqual({ pages, blocks });
      expect(fewer.meta!.hasMore).toBe(true);
      expect((fewer.meta as { resolvedAliases?: string[] }).resolvedAliases, 'the alias group is still reported').toBeDefined();

      expect(blocks, 'the aliased project needs a source page with more than one linking block. See tests/fixtures/README.md').toBeGreaterThan(pages);
      const one = await backlinks(ALIASED, undefined, 1);
      expect(blockUuids(one.results)).toEqual(blockUuids(full.results).map(uuids => uuids.slice(0, 1)));
      expect(codes(one)).toEqual(['page_blocks_truncated']);
    });
  });
});
