import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';
import { access } from 'fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../../src/config.js';
import { LogseqClient } from '../../src/client.js';
import { createServer } from '../../src/index.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from '../../src/tools/search-blocks.js';
import { DEFAULT_MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS } from '../../src/tools/get-context-for-query.js';

/**
 * Result caps hold against a real graph (#61): no tool returns more than its
 * maximum, whatever the caller asks for, and a cut is reported in meta. One
 * describe block per capped tool; later cap PRs add theirs here.
 *
 * Property-based: the query is a common letter, so any graph of a realistic
 * size matches more blocks than the maximum. Read-only.
 *
 * Needs LogSeq running; see tests/integration/setup.md.
 */

interface Meta {
  hasMore: boolean;
  warnings: Array<{ code: string; message: string; howToFetchAll?: string }>;
  totals?: Record<string, number>;
}

describe('result caps (#61)', () => {
  let mcp: Client;

  beforeAll(async () => {
    const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');
    try {
      await access(configPath);
    } catch {
      throw new Error(
        'Config file not found at ~/.logseq-mcp/config.json. See tests/integration/setup.md for setup instructions.'
      );
    }
    const client = new LogseqClient(await loadConfig(configPath));
    try {
      await client.callAPI('logseq.App.getCurrentGraph');
    } catch (error) {
      throw new Error(
        `Cannot connect to LogSeq HTTP API: ${error instanceof Error ? error.message : 'Unknown error'}. ` +
          'Ensure LogSeq is running with the HTTP server enabled. See tests/integration/setup.md'
      );
    }
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
    // A one-letter search returns most of the graph, so each call takes seconds:
    // one query, the default, the maximum and one value above it.
    const QUERY = 'e';
    const LIMITS: Array<number | undefined> = [undefined, MAX_SEARCH_LIMIT, 1000];

    it('never returns more than the maximum, reports every cut, and clamps to the same blocks', { timeout: 120_000 }, async () => {
      let overMax = 0;
      const firstBlock = new Map<number | undefined, string>();
      for (const limit of LIMITS) {
        const args = limit === undefined ? { query: QUERY } : { query: QUERY, limit };
        const result = await call('logseq_search_blocks', args);
        const label = `limit ${limit ?? 'default'}`;
        // A null API response sends no meta block; say so instead of a bare JSON.parse error
        expect(result.content, `${label}: results block plus meta block`).toHaveLength(2);
        firstBlock.set(limit, result.content[0].text);
        const results = JSON.parse(result.content[0].text);
        const { meta } = JSON.parse(result.content[1].text) as { meta: Meta };
        const effective = Math.min(limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
        const matches = meta.totals!.matches;

        expect(Array.isArray(results), label).toBe(true);
        expect(results.length, label).toBeLessThanOrEqual(MAX_SEARCH_LIMIT);
        expect(results.length, label).toBe(Math.min(effective, matches));
        expectNoSuggestionPast(meta, 'limit', MAX_SEARCH_LIMIT);

        if (matches <= results.length) {
          // Nothing cut: no warning
          expect(meta, label).toMatchObject({ hasMore: false, warnings: [] });
        } else if (effective === MAX_SEARCH_LIMIT) {
          // Cut at the maximum: the warning is the signal, and nothing can be raised
          overMax++;
          expect(meta.hasMore, label).toBe(false);
          expect(meta.warnings, label).toHaveLength(1);
          expect(meta.warnings[0].code).toBe('results_truncated');
          expect(meta.warnings[0].message).toContain(`maximum of ${MAX_SEARCH_LIMIT}`);
          expect(meta.warnings[0].howToFetchAll).toBeUndefined();
        } else {
          // Cut below the maximum: raising limit gets more
          expect(meta.hasMore, label).toBe(true);
          expect(meta.warnings[0].howToFetchAll).toMatch(/^Set limit to \d+/);
        }
      }
      expect(
        overMax,
        `A one-letter search matched no more than ${MAX_SEARCH_LIMIT} blocks, so the maximum was never tested. ` +
          'Use a graph with more content; see tests/integration/setup.md'
      ).toBeGreaterThan(0);
      // Above the maximum the caller gets exactly the blocks the maximum gives
      expect(firstBlock.get(1000)).toBe(firstBlock.get(MAX_SEARCH_LIMIT));
    });
  });

  describe('logseq_get_context_for_query max_search_results (max 100)', () => {
    // The query names no [[topic]], so the tool falls back to a keyword search.
    // Keywords must be over 3 letters and not stop words; these common English
    // words are tried in turn until one matches more blocks than the maximum.
    const CANDIDATES = ['that', 'this', 'have', 'from', 'will'];
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
      let query: string | undefined;
      for (const candidate of CANDIDATES) {
        if (totalHits(await ask(candidate, 1)) > MAX_SEARCH_RESULTS) {
          query = candidate;
          break;
        }
      }
      expect(
        query,
        `No keyword of ${JSON.stringify(CANDIDATES)} matched more than ${MAX_SEARCH_RESULTS} blocks, so the maximum ` +
          'was never tested. Use a graph with more content; see tests/integration/setup.md'
      ).toBeDefined();

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
        expect(total, label).toBeGreaterThan(MAX_SEARCH_RESULTS);
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
