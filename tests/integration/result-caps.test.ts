import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { findBlocksWithMeta } from './helpers/tools.js';
import {
  DEFAULT_DATE_RANGE_MAX_BLOCKS,
  DEFAULT_FIND_PAGES_LIMIT,
  DEFAULT_MAX_REFERENCES,
  DEFAULT_PROPERTY_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_DATE_RANGE_BLOCKS,
  MAX_FIND_PAGES_LIMIT,
  MAX_PROPERTY_LIMIT,
  MAX_SEARCH_LIMIT,
} from './helpers/caps.js';
import { connectFixture, FIXTURE_JOURNAL_DAYS } from './helpers/fixture-client.js';
import { connectMcp } from './helpers/server-under-test.js';

/**
 * Result caps hold against a real graph (#61): no tool returns more than its
 * maximum, whatever the caller asks for, and a cut is reported in meta. One
 * describe block per capped tool; later cap PRs add theirs here.
 *
 * Where a maximum is out of reach of the fixture (below), the cut at it is held by the Rust server's own tests: the
 * parity cases in rust/tests/data/parity/ feed a mock more rows than the fixture holds (for example `limit at the maximum
 * with matches left` in find-blocks.json, 520 matches, and `limit at the maximum with matches left` in find-blocks.json, 520
 * source pages), and the Rust unit tests do the same (rust/src/tools/explore_timeline/cap.rs, 1,001 blocks;
 * rust/src/truncation.rs). They replaced the TypeScript unit tests, which fed 600 matches, 1,100 blocks, 150 pages
 * and 80 blocks.
 *
 * Against the fixture graph. Read-only. Its ~504 blocks (478 of them with the letter e) are fewer than
 * find_blocks' maximum of 500, so through MCP only the cut below the maximum
 * and the clamp can be seen; the cut at the maximum is the parity cases' (#356 dropped the integration test that
 * lowered the maximum, which only a direct call to the TypeScript function could do). find_pages needs more than 200
 * non-journal pages, which the hub fixture's pages supply. Assertions on page
 * names compare booleans or counts, so a failure prints no names from the graph.
 * explore_timeline's default of 200 blocks and maximum of 1000 are out of reach for the hub page too (about 140
 * mentions, the most of any fixture page) and the cut at 1000 is covered by the Rust unit tests.
 * With a period alone they are out of reach the
 * same way: the fixture's journals hold well under 200 blocks. The test passes small
 * caps through MCP (the same code, a smaller bound), and the Rust unit tests feed the tool
 * 1,001 blocks for the cut at the maximum.
 * explore_context's references have no maximum, only the character budget (#485), which the parity cases hold with larger
 * stubs (`over the character budget the references that fit are kept and references_offset reads on`). Its references are
 * ranked by linking blocks (#178), so the pages a cut keeps are the same names on every run.
 * find_blocks' default of 100 and maximum of 500 are out of reach for a property filter, and for a page with links_to,
 * too: no property value sits on more than a few fixture blocks, and no pair of fixture pages returns more than a
 * dozen. Through MCP small limits stand in for the default, and the parity cases (`limit at the maximum with
 * matches left`, `pages cut: limit past the maximum`) hold the cut at the maximum.
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
    mcp = await connectMcp(client, { tips: false });
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
      for (const match of (warning.howToFetchAll ?? '').matchAll(new RegExp(`[Ss]et ${param} to (\\d+)`, 'g'))) {
        expect(Number(match[1]), `${warning.code} suggests ${param} past ${max}`).toBeLessThanOrEqual(max);
      }
    }
  }

  describe('logseq_find_blocks limit (max 500) with a text filter', () => {
    // "e" is in all but 26 of the fixture's blocks (478 of ~504). The crowded topic's and the roll-ups' blocks avoid it on
    // purpose to keep this margin: see "The crowded topic" in tests/fixtures/README.md
    const QUERY = 'e';
    let matches: number;

    async function search(limit?: number) {
      const args = limit === undefined ? { text: QUERY } : { text: QUERY, limit };
      const result = await call('logseq_find_blocks', args);
      // A null API response sends no meta block; say so instead of a bare JSON.parse error
      expect(result.content, `limit ${limit ?? 'default'}: results block plus meta block`).toHaveLength(2);
      return {
        text: result.content[0].text,
        metaText: result.content[1].text,
        results: JSON.parse(result.content[0].text) as unknown[],
        meta: (JSON.parse(result.content[1].text) as { meta: Meta }).meta,
      };
    }

    beforeAll(async () => {
      const { meta } = await findBlocksWithMeta(client, { text: QUERY }, { limit: 0 });
      matches = meta!.totals!.matches;
      // Every block bar 26 (the fixture holds ~504): computed, so a new fixture block does not break it
      expect(matches, 'too few fixture blocks hold the letter e to see the default cut').toBeGreaterThan(DEFAULT_SEARCH_LIMIT);
      expect(
        matches,
        `${matches} blocks hold the letter e, and this test needs fewer than ${MAX_SEARCH_LIMIT}. ` +
          'New fixture blocks must avoid the letter e: see "The crowded topic" in tests/fixtures/README.md'
      ).toBeLessThan(MAX_SEARCH_LIMIT);
    });

    it('the default cuts below the maximum and offers the raise that fits the character budget, which returns that many hits', async () => {
      const { results, meta } = await search();

      expect(results).toHaveLength(DEFAULT_SEARCH_LIMIT);
      expect(meta.totals).toEqual({ matches });
      expect(meta.warnings.map(w => w.code)).toEqual(['results_truncated']);
      // Every match is ~60,000 characters (#506), so "get all" would be cut: the next page leads, and the raise offered
      // is the most that fits. hasMore is true because a parameter really fetches that many
      const sizeCut = (await search(MAX_SEARCH_LIMIT)).results.length;
      expect(sizeCut).toBeGreaterThan(DEFAULT_SEARCH_LIMIT);
      expect(sizeCut).toBeLessThan(matches);
      expect(meta.hasMore).toBe(true);
      const how = meta.warnings[0].howToFetchAll!;
      expect(how).toMatch(new RegExp(`^Set offset to ${DEFAULT_SEARCH_LIMIT} for the next page\\. Or set limit to \\d+ to get \\d+ of ${matches}\\.`));
      expect(how).not.toMatch(/get all/);
      expectNoSuggestionPast(meta, 'limit', MAX_SEARCH_LIMIT);
      // The size cut's own warning is longer than a limit cut's, so it keeps a hit or two fewer than the raise offered
      const fitting = Number(how.match(/Or set limit to (\d+) to get/)![1]);
      expect(fitting).toBeGreaterThanOrEqual(sizeCut);
      expect(fitting).toBeLessThanOrEqual(sizeCut + 3);

      // Following it returns that many hits with no size cut, and the next limit up is cut back to about the same count
      const raised = await search(fitting);
      expect(raised.results).toHaveLength(fitting);
      expect(raised.meta.warnings.map(w => w.code)).not.toContain('result_size_truncated');
      const beyond = await search(fitting + 1);
      expect(beyond.results.length).toBeLessThanOrEqual(fitting);
      expect(beyond.results.length).toBeGreaterThanOrEqual(fitting - 3);
      expect(beyond.meta.warnings.map(w => w.code)).toEqual(['result_size_truncated']);
    });

    it('the maximum asks for every match, the character budget cuts it, and a limit above it clamps to the same blocks', async () => {
      const atMax = await search(MAX_SEARCH_LIMIT);
      const above = await search(1000);

      // The count cap cuts nothing here (matches < 500). Every match is ~60,000 characters, past the budget (#506),
      // so the one cut is the size cut: it says so alone, names the total, offers no larger limit, and names the next
      // page, so hasMore is true
      const sent = [...atMax.text].length + [...atMax.metaText].length;
      expect(sent, 'the budget is in characters').toBeLessThanOrEqual(30000);
      // ...and it keeps what fits: a regression that over-cuts keeps far fewer than the ~160 hits of 30,000 characters
      expect(sent, 'the cut keeps the most hits that fit').toBeGreaterThanOrEqual(29000);
      expect(atMax.results.length).toBeLessThan(matches);
      expect(atMax.meta).toMatchObject({ hasMore: true, totals: { matches } });
      expect(atMax.meta.warnings.map(w => w.code)).toEqual(['result_size_truncated']);
      expect(atMax.meta.warnings[0].howToFetchAll).toBe(`Set offset to ${atMax.results.length} for the next page.`);
      expect(atMax.meta.warnings[0].message).toMatch(new RegExp(`^Showing ${atMax.results.length} of ${matches} matching blocks`));
      expect(above.text).toBe(atMax.text);
      expect(above.meta).toEqual(atMax.meta);
    });
  });

  describe('logseq_find_pages limit and offset (default 200, max 1000)', () => {
    interface ListBody extends Partial<Meta> {
      pages: Array<{ name: string; aliases?: string[] }>;
      total: number;
    }

    async function list(args: Record<string, unknown>): Promise<ListBody> {
      return JSON.parse((await call('logseq_find_pages', args)).content[0].text) as ListBody;
    }

    /** Same names in the same order. Compared as a boolean so a failure prints no page names. */
    const same = (a: ListBody['pages'], b: ListBody['pages']) => JSON.stringify(a) === JSON.stringify(b);

    it('cuts at the default, clamps to the maximum, and pages through every page with offset', { timeout: 120_000 }, async () => {
      const first = await list({});
      expect(first.warnings?.map(w => w.code) ?? [], 'a page list is available').not.toContain('pages_unavailable');
      expect(
        first.total,
        `The graph has ${first.total} non-journal pages, no more than the default of ${DEFAULT_FIND_PAGES_LIMIT}, ` +
          'so the cap was never tested. Use a graph with more pages; see tests/integration/setup.md'
      ).toBeGreaterThan(DEFAULT_FIND_PAGES_LIMIT);

      // The default: 200 pages, the cut reported, and the next offset named
      expect(first.pages.length).toBe(DEFAULT_FIND_PAGES_LIMIT);
      expect(first.hasMore).toBe(true);
      expect(first.warnings!.map(w => w.code)).toEqual(['pages_truncated']);
      expect(first.warnings![0].howToFetchAll).toContain(`offset to ${DEFAULT_FIND_PAGES_LIMIT} for the next page`);
      expectNoSuggestionPast(first as Meta, 'limit', MAX_FIND_PAGES_LIMIT);

      // At and above the maximum: never more than 1000, and the same pages either way
      const atMax = await list({ limit: MAX_FIND_PAGES_LIMIT });
      const above = await list({ limit: 5000 });
      for (const [label, body] of [['limit 1000', atMax], ['limit 5000', above]] as const) {
        expect(body.pages.length, label).toBe(Math.min(MAX_FIND_PAGES_LIMIT, first.total));
        expect(body.total, `${label}: total counts every page`).toBe(first.total);
        if (first.total > MAX_FIND_PAGES_LIMIT) {
          expectNoSuggestionPast(body as Meta, 'limit', MAX_FIND_PAGES_LIMIT);
          // Cut at the maximum: the next offset still fetches the rest
          expect(body.hasMore, label).toBe(true);
          expect(body.warnings![0].message, label).toContain(`maximum of ${MAX_FIND_PAGES_LIMIT}`);
          expect(body.warnings![0].howToFetchAll, label).toBe(`Set offset to ${MAX_FIND_PAGES_LIMIT} for the next page.`);
        } else {
          expect(body.hasMore, label).toBeUndefined();
          expect(body.warnings, label).toBeUndefined();
        }
      }
      expect(same(above.pages, atMax.pages), 'limit 5000 returns the pages limit 1000 does').toBe(true);
      expect(same(first.pages, atMax.pages.slice(0, DEFAULT_FIND_PAGES_LIMIT)), 'the default page is the first 200').toBe(true);

      // Following each warning's offset visits every page once, and the last page has no warning
      const seen: string[] = [];
      let offset = 0;
      for (let calls = 0; calls < 50; calls++) {
        const body = await list({ limit: MAX_FIND_PAGES_LIMIT, offset });
        expect(body.total, `offset ${offset}: total counts every page`).toBe(first.total);
        seen.push(...body.pages.map(page => page.name));
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

  describe('logseq_explore_timeline with a page, max_blocks (default 200, max 1000)', () => {
    // The hub page's own blocks plus every block that links it
    const PAGE = 'hub central';

    interface PageBody extends Partial<Meta> {
      page: string;
      entries: Array<{ date: number | null; blocks: Array<{ uuid: string; children?: unknown[] }> }>;
      summary: { totalDays: number; totalBlocks: number };
    }

    async function timeline(max?: number): Promise<{ text: string; body: PageBody }> {
      const args = max === undefined ? { page: PAGE } : { page: PAGE, max_blocks: max };
      const text = (await call('logseq_explore_timeline', args)).content[0].text;
      return { text, body: JSON.parse(text) as PageBody };
    }

    /** Every block of the entries, nested ones counted: the unit `max_blocks` cuts in. */
    const count = (blocks: Array<{ children?: unknown[] }>): number =>
      blocks.reduce((sum, block) => sum + 1 + count((block.children ?? []) as Array<{ children?: unknown[] }>), 0);
    const kept = (body: PageBody) => body.entries.reduce((sum, entry) => sum + count(entry.blocks), 0);

    it('never returns more blocks than the cap, reports every cut, clamps to the same blocks and offers only a way that reads on', async () => {
      const atMax = await timeline(MAX_DATE_RANGE_BLOCKS);
      const total = kept(atMax.body);
      expect(
        total,
        `The hub page has ${total} blocks, not more than the default of ${DEFAULT_DATE_RANGE_MAX_BLOCKS}, so the cap was never tested. See tests/fixtures/README.md`
      ).toBeGreaterThan(100);
      expect(total, 'the fixture must stay under the maximum for this test to see every block').toBeLessThan(MAX_DATE_RANGE_BLOCKS);
      expect(atMax.text.length, 'the budget is in characters').toBeLessThanOrEqual(30000);
      // With no period the dated days come first and the blocks on non-journal pages last, in an entry with no date
      const dates = atMax.body.entries.map(entry => entry.date);
      expect(dates.slice(0, -1).every(date => date !== null)).toBe(true);
      expect(dates.at(-1)).toBeNull();

      // A value above the maximum is clamped to it, not rejected
      expect((await timeline(5000)).text).toBe(atMax.text);

      for (const max of [1, 50, 100, total - 1]) {
        const { body } = await timeline(max);
        const label = `max_blocks ${max}`;
        expect(kept(body), label).toBeLessThanOrEqual(max);
        expect(body.summary.totalBlocks, `${label}: the summary counts every block found`).toBe(atMax.body.summary.totalBlocks);
        const codes = body.warnings!.map(warning => warning.code);
        expect(codes[0], label).toBe('blocks_truncated');
        expect(body.totals!.blocks, label).toBeGreaterThanOrEqual(total);
        // a way on is named only when a call reads on; `max_blocks` is never raised past the maximum
        expect(body.hasMore, label).toBe(body.warnings!.some(warning => warning.howToFetchAll !== undefined));
        expectNoSuggestionPast(body as Meta, 'max_blocks', MAX_DATE_RANGE_BLOCKS);
        for (const warning of body.warnings!) {
          expect(warning.howToFetchAll ?? '', `${label}: no search_term`).not.toContain('search_term');
        }
      }

      // At the cap exactly, the count cap cuts nothing
      expect((await timeline(total)).text).toBe(atMax.text);
    });
  });

  describe('logseq_explore_timeline with a period, max_blocks (default 200, max 1000)', () => {
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
      const text = (await call('logseq_explore_timeline', args)).content[0].text;
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
        // Below the maximum the warning leads with paging (#187), and suggests no raise past the maximum
        expect(body.hasMore, label).toBe(true);
        const how = body.warnings![0].howToFetchAll!;
        expect(how, label).toMatch(
          /^(Call again with start_date \d+, the same end_date \(\d+\) and the same max_blocks|To read it whole, call again with start_date \d+, end_date \d+ and max_blocks \d+\.)/
        );
        expect(how, label).not.toContain('Set max_blocks');
        expectNoSuggestionPast(body as Meta, 'max_blocks', MAX_DATE_RANGE_BLOCKS);

        // The warning names the last day kept
        const lastDay = body.entries[body.entries.length - 1]?.date;
        if (lastDay === undefined) continue;
        expect(body.warnings![0].message, label).toContain(`the entries end at ${lastDay}`);

        // Follow the warning literally, call by call: the start_date it names, the same end of the range
        // and the same max_blocks (or the day alone at the count it names). Every call must reach blocks
        // not yet seen, so the advice can't loop, and the calls together must read every block.
        const everything = atMax.body.entries.flatMap(e => flatten(e.blocks));
        const seen = new Set(uuidsOf(body));
        let warning = body.warnings![0];
        let calls = 1;
        while (warning.howToFetchAll) {
          expect(++calls, `${label}: following the warning ends`).toBeLessThanOrEqual(everything.length + 1);
          const how = warning.howToFetchAll;
          const alone = /To read it whole, call again with start_date (\d+), end_date (\d+) and max_blocks (\d+)\./.exec(how);
          const paged = /^Call again with start_date (\d+), the same end_date \((\d+)\) and the same max_blocks/.exec(how);
          expect(alone ?? paged, `${label}: a call the warning names: ${how}`).not.toBeNull();
          const before = seen.size;
          let next: RangeBody | undefined;
          if (alone) {
            const day = (await range(Number(alone[3]), { start_date: Number(alone[1]), end_date: Number(alone[2]) })).body;
            expect(day.warnings, `${label}: the day alone at max_blocks ${alone[3]} is whole`).toBeUndefined();
            uuidsOf(day).forEach(uuid => seen.add(uuid));
            const then = /Then continue with start_date (\d+), the same end_date \((\d+)\) and max_blocks (\d+)/.exec(how);
            if (then) next = (await range(Number(then[3]), { start_date: Number(then[1]), end_date: Number(then[2]) })).body;
          } else {
            expect(Number(paged![2]), `${label}: the same end_date`).toBe(END);
            next = (await range(max, { start_date: Number(paged![1]), end_date: Number(paged![2]) })).body;
          }
          if (next) uuidsOf(next).forEach(uuid => seen.add(uuid));
          expect(seen.size, `${label}: the call reaches blocks not seen before`).toBeGreaterThan(before);
          if (!next) break;
          if (!next.warnings) break;
          warning = next.warnings[0];
        }
        expect([...seen].sort(), `${label}: following the warning reads every block`).toEqual([...everything].sort());

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

  describe('logseq_explore_context max_references and references_offset (default 20 and 0)', () => {
    // The hub: 66 references on 61 source pages (60 pages and a journal), none over 2 per page.
    // The crowded topic: 14 references on 2 source pages, one with 12 linking blocks and one with 2. A project
    // with an alias takes the alias-group query (#69) instead of the Editor call.
    // References are ranked by the blocks of their source page, most first, ties by lowercase page name (#178), so
    // the order is the same on every run and the tests below assert it by name.
    const HUB = 'hub central';
    const CROWDED = 'popular topic';
    const ALIASED = 'project atlas';

    interface ContextBody extends Meta {
      references: Array<{ block: { uuid: string }; sourcePage: { name?: string } }>;
      totals: { blocks: number; relatedPages: number; references: number };
    }

    /** The references only: the blocks and the related pages are left out unless the test asks for them. */
    async function references(page: string, args: Record<string, unknown> = {}): Promise<{ text: string; body: ContextBody }> {
      const result = await call('logseq_explore_context', { page, max_blocks: 0, max_related_pages: 0, ...args });
      return { text: result.content[0].text, body: JSON.parse(result.content[0].text) as ContextBody };
    }

    const uuids = (body: ContextBody) => body.references.map(reference => reference.block.uuid);
    const pageNames = (body: ContextBody) => body.references.map(reference => reference.sourcePage.name);
    const cut = (body: ContextBody) => body.warnings.filter(warning => warning.code === 'references_truncated');
    const pad = (n: number) => String(n).padStart(2, '0');
    const range = (prefix: string, from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${pad(from + i)}`);

    it('ranks the hub by linking blocks, ties by page name, and keeps the top of that ranking at the default cut', async () => {
      const { body: full } = await references(HUB, { max_references: 500 });
      expect(full.references).toHaveLength(66);
      // Most first, and within a count by lowercase name (code-unit order), whatever order LogSeq listed them in
      const perPage = new Map<string | undefined, number>();
      for (const name of pageNames(full)) perPage.set(name, (perPage.get(name) ?? 0) + 1);
      const counts = [...perPage.values()];
      expect(counts, 'a page links with all its blocks together, the busiest page first').toEqual([...counts].sort((a, b) => b - a));
      expect(counts.slice(0, 6), 'five pages link the hub twice, the rest once').toEqual([2, 2, 2, 2, 2, 1]);
      const names = [...perPage.keys()];
      const onceEach = names.slice(5);
      expect(onceEach, 'pages with one linking block are in name order').toEqual([...onceEach].sort((a, b) => (a! < b! ? -1 : a! > b! ? 1 : 0)));

      // The default 20 are named by the ranking, not by LogSeq's order
      const { body } = await references(HUB);
      expect(body.references).toHaveLength(DEFAULT_MAX_REFERENCES);
      expect(pageNames(body)).toEqual([
        ...range('neighbour-in-', 1, 5).flatMap(name => [name, name]),
        'jun 17th, 2024',
        ...range('neighbour-both-', 1, 9),
      ]);
      expect(uuids(body)).toEqual(uuids(full).slice(0, DEFAULT_MAX_REFERENCES));
      expect(cut(body)).toHaveLength(1);
      expect(cut(body)[0].message).toBe('Showing 20 of 66 references. Page through the rest with references_offset.');
    });

    it('pages through the references with references_offset, every page the next slice of the same ranking', async () => {
      const { body: full } = await references(HUB, { max_references: 500 });
      expect(full.totals.references).toBe(66);
      // Nothing is cut at the largest cap, so there is no warning about the references
      expect(cut(full)).toEqual([]);

      for (const size of [1, 7, DEFAULT_MAX_REFERENCES, 65, 66, 100]) {
        const joined: string[] = [];
        let offset = 0;
        let pages = 0;
        for (;;) {
          const { body } = await references(HUB, { max_references: size, references_offset: offset });
          const label = `max_references ${size} at offset ${offset}`;
          expect(body.totals.references, label).toBe(66);
          expect(body.references.length, label).toBe(Math.min(size, 66 - offset));
          joined.push(...uuids(body));
          pages++;
          offset += body.references.length;
          if (offset >= 66) {
            expect(cut(body), `${label}: the last page has no warning about the references`).toEqual([]);
            break;
          }
          // Every other page says where the next one starts, and only that page of the rest is named
          expect(cut(body), label).toHaveLength(1);
          expect(body.hasMore, label).toBe(true);
          expect(cut(body)[0].howToFetchAll, label).toMatch(new RegExp(`^Set references_offset to ${offset} for the next page\\.`));
        }
        expect(joined, `max_references ${size}: the pages join into the full ranking, nothing skipped or repeated`).toEqual(uuids(full));
        expect(pages, `max_references ${size}`).toBe(Math.ceil(66 / size));
      }
    });

    it('reads nothing, and says nothing was cut, from the last reference on, and a cap of 0 only offers the raise', async () => {
      for (const references_offset of [66, 67, 5000]) {
        const { body } = await references(HUB, { references_offset });
        expect(body.references, `offset ${references_offset}`).toEqual([]);
        expect(body.totals.references).toBe(66);
        expect(cut(body), `offset ${references_offset}`).toEqual([]);
      }
      const { body } = await references(HUB, { max_references: 0 });
      expect(body.references).toEqual([]);
      expect(cut(body)).toHaveLength(1);
      expect(cut(body)[0].howToFetchAll).toBe('Set max_references to 66 (or higher) to get all 66.');
    });

    it('puts the page with the most linking blocks first, and pages its blocks like any others', async () => {
      const { body: full } = await references(CROWDED, { max_references: 500 });
      expect(pageNames(full).filter(name => name === 'busy source').length, 'the crowded topic needs a source page with 12 linking blocks. See tests/fixtures/README.md').toBe(12);
      expect(pageNames(full).filter(name => name === 'light source')).toHaveLength(2);
      // Ranked: the page with 12 linking blocks comes before the one with 2, at every cap
      expect(pageNames(full)).toEqual([...Array(12).fill('busy source'), ...Array(2).fill('light source')]);
      expect(cut(full)).toEqual([]);
      // The default cap holds all 14, so nothing is cut; a smaller one pages
      expect(cut((await references(CROWDED)).body)).toEqual([]);
      const first = await references(CROWDED, { max_references: 10 });
      const second = await references(CROWDED, { max_references: 10, references_offset: 10 });
      expect([...uuids(first.body), ...uuids(second.body)]).toEqual(uuids(full));
      expect(pageNames(second.body)).toEqual(['busy source', 'busy source', 'light source', 'light source']);
      expect(cut(first.body)[0].howToFetchAll).toMatch(/^Set references_offset to 10 for the next page\./);
      expect(cut(second.body)).toEqual([]);
    });

    it('ranks a page with aliases across the whole group, through the alias-group query', async () => {
      const { body: full } = await references(ALIASED, { max_references: 500 });
      const pages = new Set(pageNames(full)).size;
      expect(full.references.length, 'the aliased project needs more references than source pages. See tests/fixtures/README.md').toBeGreaterThan(pages);
      expect(pages, 'the aliased project needs more than 3 source pages. See tests/fixtures/README.md').toBeGreaterThan(3);
      expect(cut(full)).toEqual([]);

      // Ranked by linking blocks across the whole alias group: 7, 3, 2, 2, then single blocks by name
      const perPage = new Map<string | undefined, number>();
      for (const name of pageNames(full)) perPage.set(name, (perPage.get(name) ?? 0) + 1);
      expect([...perPage.values()].slice(0, 4)).toEqual([7, 3, 2, 2]);
      expect([...perPage.keys()].slice(0, 3)).toEqual(['jan 6th, 2025', 'jan 15th, 2025', 'jan 13th, 2025']);

      const fewer = await references(ALIASED, { max_references: 12 });
      expect(uuids(fewer.body)).toEqual(uuids(full).slice(0, 12));
      expect(cut(fewer.body)[0].message).toBe('Showing 12 of 24 references. Page through the rest with references_offset.');
      expect((fewer.body as { resolvedAliases?: string[] }).resolvedAliases, 'the alias group is still reported').toBeDefined();
      const rest = await references(ALIASED, { max_references: 12, references_offset: 12 });
      expect([...uuids(fewer.body), ...uuids(rest.body)]).toEqual(uuids(full));
    });
  });

  // Filters whose matches are few: no fixture property value sits on more than a handful of blocks, and the crowded
  // topic's pair of pages (tests/fixtures/README.md) on no more than a dozen. So the default of 100 and the maximum of
  // 500 are out of reach. Through MCP small limits see the same code with a smaller bound, and the clamp shows above
  // the maximum; the cut at 500 is covered by the parity cases (`property: limit at the maximum with matches left`,
  // `pages cut: limit past the maximum`).
  describe.each([
    { label: 'a property filter', filter: { property: 'type', value: 'project' }, needs: 'blocks with type:: project' },
    { label: 'a page and links_to', filter: { page: 'busy source', links_to: ['popular topic'] }, needs: 'blocks on busy source that link popular topic' },
  ])('logseq_find_blocks limit (default 100, max 500) with $label', ({ filter, needs }) => {

    interface SearchBody {
      text: string;
      results: Array<{ uuid: string }>;
      meta: Partial<Meta>;
    }

    async function bySearch(limit?: number): Promise<SearchBody> {
      const result = await call('logseq_find_blocks', { ...filter, ...(limit === undefined ? {} : { limit }) });
      return {
        text: result.content[0].text,
        results: JSON.parse(result.content[0].text) as Array<{ uuid: string }>,
        meta: (JSON.parse(result.content[1].text) as { meta: Partial<Meta> }).meta,
      };
    }

    const uuids = (body: SearchBody) => body.results.map(block => block.uuid);

    it('never returns more blocks than limit, keeps the same first blocks, and reports every cut', async () => {
      const full = await bySearch(MAX_PROPERTY_LIMIT);
      const total = full.results.length;
      expect(total, `the fixture needs at least 3 ${needs} to see a cut. See tests/fixtures/README.md`).toBeGreaterThanOrEqual(3);
      expect(total, 'the fixture must stay under the default cap for the default to return every match').toBeLessThanOrEqual(DEFAULT_PROPERTY_LIMIT);
      // Nothing is cut, so the maximum sends no warning, and a meta with the total (it is always sent)
      expect(full.meta.warnings).toEqual([]);
      expect(full.meta.totals).toEqual({ matches: total });

      // The default and a value above the maximum are the full result, byte for byte
      expect((await bySearch()).text).toBe(full.text);
      expect((await bySearch(5000)).text).toBe(full.text);

      for (const limit of [0, 1, 2, total - 1, total, total + 1, DEFAULT_PROPERTY_LIMIT]) {
        const body = await bySearch(limit);
        const label = `limit ${limit}`;
        expect(body.results.length, label).toBeLessThanOrEqual(MAX_PROPERTY_LIMIT);
        expect(body.results.length, label).toBe(Math.min(limit, total));
        // The first blocks of the full list, in its order
        expect(uuids(body), label).toEqual(uuids(full).slice(0, limit));

        if (limit >= total) {
          expect(body.text, `${label}: nothing is cut, so the result is the full one`).toBe(full.text);
          expect(body.meta.warnings, label).toEqual([]);
          continue;
        }
        expect(body.meta.warnings!.map(w => w.code), label).toEqual(['results_truncated']);
        expect(body.meta.totals, label).toEqual({ matches: total });
        // The next page leads, and the raise is the alternative; with nothing shown there is no next page
        expect(body.meta.hasMore, label).toBe(true);
        expect(body.meta.warnings![0].howToFetchAll, label).toBe(
          limit === 0
            ? `Set limit to ${total} (or higher) to get all ${total}.`
            : `Set offset to ${limit} for the next page. Or set limit to ${total} (or higher) to get all ${total} in one call.`
        );
        expectNoSuggestionPast(body.meta as Meta, 'limit', MAX_PROPERTY_LIMIT);
        expect(body.meta.warnings![0].message, label).toContain(`Showing ${limit} of ${total} matching blocks`);
      }
    });
  });
});
