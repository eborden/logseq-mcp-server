import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LogseqClient } from '../../src/client.js';
import { createServer } from '../../src/index.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, searchBlocksWithMeta } from '../../src/tools/search-blocks.js';
import { DEFAULT_MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS } from '../../src/tools/get-context-for-query.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Result caps hold against a real graph (#61): no tool returns more than its
 * maximum, whatever the caller asks for, and a cut is reported in meta. One
 * describe block per capped tool; later cap PRs add theirs here.
 *
 * Against the fixture graph. Read-only. Its ~480 blocks are fewer than
 * search_blocks' maximum of 500, so through MCP only the cut below the maximum
 * and the clamp can be seen; the cut at the maximum runs through
 * searchBlocksWithMeta with a lower maxLimit, the same code with a smaller
 * bound. The keyword `neighbour` matches 190 blocks (the hub fixture), past
 * get_context_for_query's maximum of 100.
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
    // "e" is in all but two of the fixture's blocks
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
      // Every block bar two (the fixture holds ~480): computed, so a new fixture block does not break it
      expect(matches).toBeGreaterThan(DEFAULT_SEARCH_LIMIT);
      expect(matches).toBeLessThan(MAX_SEARCH_LIMIT);
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
});
