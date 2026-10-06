import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  searchBlocks,
  searchBlocksWithMeta,
  SearchBlocksResult,
  SlimSearchBlocksResult
} from './search-blocks.js';
import { LogseqClient } from '../client.js';
import { searchBlocksArgs } from '../tool-args.js';

// Rows as logseq.DB.datascriptQuery returns them for (pull ?b [* {:block/page [...]}]):
// one-element tuples, kebab-case keys, page pulled inline.
function block(id: number, content: string, pageId: number, pageName: string, originalName: string, extra: object = {}) {
  return [{
    id,
    uuid: `block-uuid-${id}`,
    content,
    format: 'markdown',
    page: { id: pageId, name: pageName, 'original-name': originalName },
    parent: { id: pageId },
    left: { id: pageId },
    ...extra
  }];
}

// Full page as pulled with [*]
function fullPage(id: number, name: string, originalName: string, extra: object = {}) {
  return [{
    id,
    uuid: `page-uuid-${id}`,
    name,
    'original-name': originalName,
    'created-at': 1,
    'updated-at': 2,
    ...extra
  }];
}

describe('searchBlocks', () => {
  let client: LogseqClient;
  let callAPI: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token' } as any);
    callAPI = vi.fn();
    (client as any).callAPI = callAPI;
  });

  describe('query', () => {
    it('makes one datascriptQuery call with the pattern as an EDN-encoded :in input', async () => {
      callAPI.mockResolvedValueOnce([block(1, 'Alice met Bob', 10, 'my page', 'My Page')]);

      await searchBlocks(client, 'Alice');

      expect(callAPI).toHaveBeenCalledTimes(1);
      const [method, args] = callAPI.mock.calls[0];
      expect(method).toBe('logseq.DB.datascriptQuery');
      expect(args).toHaveLength(2);
      expect(args[0]).toContain(':in $ ?pattern');
      expect(args[0]).toContain('[(re-pattern ?pattern) ?re]');
      expect(args[0]).toContain('[(re-find ?re ?c)]');
      expect(args[0]).not.toContain('Alice');
      expect(args[1]).toBe('"(?i)Alice"');
    });

    it('does not call getAllPages or getPageBlocksTree', async () => {
      callAPI.mockResolvedValueOnce([]);

      await searchBlocks(client, 'anything');

      const methods = callAPI.mock.calls.map(c => c[0]);
      expect(methods).not.toContain('logseq.Editor.getAllPages');
      expect(methods).not.toContain('logseq.Editor.getPageBlocksTree');
    });

    it('escapes regex metacharacters, then EDN-encodes the input', async () => {
      callAPI.mockResolvedValueOnce([]);

      await searchBlocks(client, 'c++');

      // regex layer: c\+\+  ->  EDN layer: backslashes doubled inside the string literal
      expect(callAPI.mock.calls[0][1][1]).toBe('"(?i)c\\\\+\\\\+"');
    });

    it('double-escapes a search containing quotes and backslashes', async () => {
      callAPI.mockResolvedValueOnce([]);

      await searchBlocks(client, 'say "hi" a\\b');

      const encoded = callAPI.mock.calls[0][1][1];
      expect(JSON.parse(encoded)).toBe('(?i)say "hi" a\\\\b');
    });
  });

  describe('results', () => {
    it('returns the matching blocks with page info inline', async () => {
      callAPI.mockResolvedValueOnce([block(1, 'Test search term', 100, 'test page', 'Test Page')]);

      const result = await searchBlocks(client, 'search term');

      expect(result).toHaveLength(1);
      expect(result![0].content).toBe('Test search term');
      expect(result![0].uuid).toBe('block-uuid-1');
      expect(result![0].page).toMatchObject({ id: 100, name: 'test page', 'original-name': 'Test Page' });
    });

    it('keeps block properties, marker and level', async () => {
      callAPI.mockResolvedValueOnce([
        block(1, 'Block with properties', 10, 'p', 'P', { properties: { status: 'done' }, marker: 'DONE', level: 2 })
      ]);

      const result = await searchBlocks(client, 'properties');

      expect(result![0].properties).toEqual({ status: 'done' });
      expect(result![0].marker).toBe('DONE');
      expect(result![0].level).toBe(2);
    });

    it('returns an empty array when nothing matches', async () => {
      callAPI.mockResolvedValueOnce([]);

      const result = await searchBlocks(client, 'nonexistent');

      expect(result).toEqual([]);
      expect(callAPI).toHaveBeenCalledTimes(1);
    });

    it('returns an empty array with includeContext when nothing matches, without a page lookup', async () => {
      callAPI.mockResolvedValueOnce([]);

      const result = await searchBlocks(client, 'nonexistent', 10, true);

      expect(result).toEqual([]);
      expect(callAPI).toHaveBeenCalledTimes(1);
    });

    it('returns null when the API returns null', async () => {
      callAPI.mockResolvedValueOnce(null);

      expect(await searchBlocks(client, 'test')).toBeNull();
    });

    it('propagates errors from the API client', async () => {
      callAPI.mockRejectedValue(new Error('Failed to connect to LogSeq API'));

      await expect(searchBlocks(client, 'search term')).rejects.toThrow('Failed to connect to LogSeq API');
    });

    it('ignores rows without string content', async () => {
      callAPI.mockResolvedValueOnce([
        [{ id: 1, uuid: 'u1', page: { id: 1 } }],
        block(2, 'real block', 1, 'p', 'P')
      ]);

      const result = await searchBlocks(client, 'real');

      expect(result!.map(b => b.id)).toEqual([2]);
    });
  });

  describe('limit and ordering', () => {
    it('sorts newest first (highest block id), regardless of API order', async () => {
      callAPI.mockResolvedValueOnce([
        block(30, 'k', 3, 'zeta', 'Zeta'),
        block(12, 'k', 1, 'alpha', 'Alpha'),
        block(31, 'k', 3, 'zeta', 'Zeta'),
        block(11, 'k', 1, 'alpha', 'Alpha'),
        block(20, 'k', 2, 'mid', 'Mid')
      ]);

      const result = await searchBlocks(client, 'k');

      expect(result!.map(b => b.id)).toEqual([31, 30, 20, 12, 11]);
    });

    it('is deterministic for any input order', async () => {
      const rows = [
        block(5, 'k', 2, 'beta', 'Beta'),
        block(3, 'k', 1, 'alpha', 'Alpha'),
        block(4, 'k', 2, 'beta', 'Beta')
      ];
      callAPI.mockResolvedValueOnce([...rows]).mockResolvedValueOnce([...rows].reverse());

      const first = await searchBlocks(client, 'k');
      const second = await searchBlocks(client, 'k');

      expect(first!.map(b => b.id)).toEqual(second!.map(b => b.id));
    });

    it('slices to limit after sorting (keeps the newest)', async () => {
      callAPI.mockResolvedValueOnce([
        block(4, 'k', 2, 'beta', 'Beta'),
        block(3, 'k', 1, 'alpha', 'Alpha'),
        block(2, 'k', 1, 'alpha', 'Alpha'),
        block(5, 'k', 3, 'gamma', 'Gamma')
      ]);

      const result = await searchBlocks(client, 'k', 2);

      expect(result!.map(b => b.id)).toEqual([5, 4]);
    });

    it('returns an empty array for limit 0', async () => {
      callAPI.mockResolvedValueOnce([block(1, 'k', 1, 'a', 'A')]);

      expect(await searchBlocks(client, 'k', 0)).toEqual([]);
    });

    it('defaults to a limit of 100', async () => {
      callAPI.mockResolvedValueOnce(
        Array.from({ length: 150 }, (_, i) => block(i + 1, 'k', 1, 'a', 'A'))
      );

      const result = await searchBlocks(client, 'k');

      expect(result).toHaveLength(100);
    });

    it('makes a single call regardless of how many blocks match', async () => {
      callAPI.mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, i) => block(i + 1, 'k', (i % 50) + 1, `page ${i % 50}`, `Page ${i % 50}`))
      );

      await searchBlocks(client, 'k', 10);

      expect(callAPI).toHaveBeenCalledTimes(1);
    });
  });

  describe('truncation meta (#40)', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => block(i + 1, 'k', 1, 'a', 'A'));

    it('has no warning and hasMore false when under the limit', async () => {
      callAPI.mockResolvedValueOnce(rows(3));

      const { results, meta } = await searchBlocksWithMeta(client, 'k', 10);

      expect(results).toHaveLength(3);
      expect(meta).toEqual({ hasMore: false, warnings: [], totals: { matches: 3 } });
    });

    it('has no warning when the match count equals the limit', async () => {
      callAPI.mockResolvedValueOnce(rows(5));

      const { meta } = await searchBlocksWithMeta(client, 'k', 5);

      expect(meta!.hasMore).toBe(false);
      expect(meta!.warnings).toEqual([]);
    });

    it('warns with the real total and the limit to use when over the limit', async () => {
      callAPI.mockResolvedValueOnce(rows(12));

      const { results, meta } = await searchBlocksWithMeta(client, 'k', 5);

      expect(results).toHaveLength(5);
      expect(meta).toEqual({
        hasMore: true,
        totals: { matches: 12 },
        warnings: [
          {
            code: 'results_truncated',
            message: 'Showing 5 of 12 matching blocks.',
            howToFetchAll: 'Set limit to 12 (or higher) to get all 12.'
          }
        ]
      });
    });

    it('counts only blocks with string content in the total', async () => {
      callAPI.mockResolvedValueOnce([...rows(4), [{ id: 99, page: { id: 1 } }]]);

      const { meta } = await searchBlocksWithMeta(client, 'k', 2);

      expect(meta!.totals).toEqual({ matches: 4 });
    });

    it('warns for limit 0', async () => {
      callAPI.mockResolvedValueOnce(rows(2));

      const { meta } = await searchBlocksWithMeta(client, 'k', 0);

      expect(meta!.hasMore).toBe(true);
    });

    it('returns null results and no meta when the API returns null', async () => {
      callAPI.mockResolvedValueOnce(null);

      expect(await searchBlocksWithMeta(client, 'k')).toEqual({ results: null, meta: null });
    });

    it('keeps the same call count with and without truncation', async () => {
      callAPI.mockResolvedValueOnce(rows(500));

      await searchBlocksWithMeta(client, 'k', 10);

      expect(callAPI).toHaveBeenCalledTimes(1);
    });

    it('leaves searchBlocks returning the bare array', async () => {
      callAPI.mockResolvedValueOnce(rows(12));

      const result = await searchBlocks(client, 'k', 5);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(5);
    });
  });

  describe('maximum limit (#61)', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => block(i + 1, 'k', 1, 'a', 'A'));
    const maxReached = (total: number, asked = '') => ({
      code: 'results_truncated',
      message:
        `Showing 500 of ${total} matching blocks: limit is capped at its maximum of 500${asked}, ` +
        "so the rest can't be fetched in one call. Narrow the query to see the rest."
    });

    it('is 500, with a default of 100, as the limit parameter advertises', () => {
      expect(MAX_SEARCH_LIMIT).toBe(500);
      expect(DEFAULT_SEARCH_LIMIT).toBe(100);
      expect(searchBlocksArgs.shape.limit.description).toContain(
        `(default: ${DEFAULT_SEARCH_LIMIT}, max: ${MAX_SEARCH_LIMIT})`
      );
    });

    it('returns every match and no warning when matches fit under the maximum', async () => {
      callAPI.mockResolvedValueOnce(rows(500));

      const { results, meta } = await searchBlocksWithMeta(client, 'k', 1000);

      expect(results).toHaveLength(500);
      expect(meta).toEqual({ hasMore: false, warnings: [], totals: { matches: 500 } });
    });

    it('stops at the maximum with limit 500, hasMore false and no howToFetchAll', async () => {
      callAPI.mockResolvedValueOnce(rows(501));

      const { results, meta } = await searchBlocksWithMeta(client, 'k', 500);

      expect(results).toHaveLength(500);
      expect(results!.map(b => b.id).slice(0, 2)).toEqual([501, 500]);
      expect(meta).toEqual({ hasMore: false, totals: { matches: 501 }, warnings: [maxReached(501)] });
    });

    it('clamps a limit above the maximum and names the value asked for', async () => {
      callAPI.mockResolvedValueOnce(rows(800));

      const { results, meta } = await searchBlocksWithMeta(client, 'k', 1000);

      expect(results).toHaveLength(500);
      expect(meta).toEqual({
        hasMore: false,
        totals: { matches: 800 },
        warnings: [maxReached(800, ' (1000 was asked for)')]
      });
      expect(meta!.warnings[0].howToFetchAll).toBeUndefined();
    });

    it('suggests the maximum, not the total, when the total is above it', async () => {
      callAPI.mockResolvedValueOnce(rows(800));

      const { results, meta } = await searchBlocksWithMeta(client, 'k');

      expect(results).toHaveLength(100);
      expect(meta).toEqual({
        hasMore: true,
        totals: { matches: 800 },
        warnings: [
          {
            code: 'results_truncated',
            message: 'Showing 100 of 800 matching blocks.',
            howToFetchAll: 'Set limit to 500 (the maximum) to get 500 of 800. A result this large may be saved to a file by the host instead of shown; the server can\'t tell. Narrow the query to see the rest.'
          }
        ]
      });
    });

    it('keeps the plain warning when the total is at most the maximum', async () => {
      callAPI.mockResolvedValueOnce(rows(500));

      const { meta } = await searchBlocksWithMeta(client, 'k', 100);

      expect(meta!.warnings).toEqual([
        {
          code: 'results_truncated',
          message: 'Showing 100 of 500 matching blocks.',
          howToFetchAll: 'Set limit to 500 (or higher) to get all 500. A result this large may be saved to a file by the host instead of shown; the server can\'t tell.'
        }
      ]);
    });

    it('says a large result may be saved to a file only for a raise past 200 matches (#196)', async () => {
      callAPI.mockResolvedValueOnce(rows(200));
      const small = await searchBlocksWithMeta(client, 'k', 100, false, true);
      expect(small.meta!.warnings[0].howToFetchAll).toBe('Set limit to 200 (or higher) to get all 200.');

      callAPI.mockResolvedValueOnce(rows(201));
      const large = await searchBlocksWithMeta(client, 'k', 100, false, true);
      expect(large.meta!.warnings[0].howToFetchAll).toBe(
        "Set limit to 201 (or higher) to get all 201. A result this large may be saved to a file by the host instead of shown; the server can't tell."
      );
    });

    it('scales the threshold for include_context and slim_results false, from measured sizes (#196)', async () => {
      const note = "A result this large may be saved to a file by the host instead of shown; the server can't tell.";
      const howAt = async (total: number, includeContext: boolean, slim: boolean) => {
        callAPI.mockResolvedValueOnce(rows(total));
        if (includeContext) callAPI.mockResolvedValue([]);
        const { meta } = await searchBlocksWithMeta(client, 'k', 10, includeContext, slim);
        return meta!.warnings[0].howToFetchAll;
      };
      // [include_context, slim_results, most matches with no note]: 200, 120, 125 and 65
      for (const [ctx, slim, edge] of [[false, true, 200], [true, true, 120], [false, false, 125], [true, false, 65]] as const) {
        const label = `include_context ${ctx}, slim ${slim}`;
        expect(await howAt(edge, ctx, slim), label).toBe(`Set limit to ${edge} (or higher) to get all ${edge}.`);
        expect(await howAt(edge + 1, ctx, slim), label).toBe(`Set limit to ${edge + 1} (or higher) to get all ${edge + 1}. ${note}`);
      }
    });

    it('makes one call at the maximum, as under it', async () => {
      callAPI.mockResolvedValueOnce(rows(800));

      await searchBlocksWithMeta(client, 'k', 1000);

      expect(callAPI).toHaveBeenCalledTimes(1);
    });

    it('looks up context pages only for the blocks kept at the maximum', async () => {
      callAPI.mockResolvedValueOnce(Array.from({ length: 600 }, (_, i) => block(i + 1, 'k', i + 1, `p${i + 1}`, `P${i + 1}`)));
      callAPI.mockResolvedValueOnce([]);

      await searchBlocksWithMeta(client, 'k', 1000, true);

      // Pages 600..101 belong to the 500 newest blocks; 100..1 were cut
      const kept = Array.from({ length: 500 }, (_, i) => 600 - i).join(' ');
      expect(callAPI.mock.calls[1][1][0]).toContain(`[(ground [${kept}]) [?p ...]]`);
    });

    it('leaves searchBlocks without a maximum for internal callers', async () => {
      callAPI.mockResolvedValueOnce(rows(800));

      expect(await searchBlocks(client, 'k', 1000)).toHaveLength(800);
    });
  });

  describe('includeContext', () => {
    it('does not include context by default and makes no page lookup', async () => {
      callAPI.mockResolvedValueOnce([block(1, 'plain', 10, 'test page', 'Test Page')]);

      const result = await searchBlocks(client, 'plain');

      expect(result![0]).not.toHaveProperty('context');
      expect(callAPI).toHaveBeenCalledTimes(1);
    });

    it('adds page, references and tags using one batched page lookup', async () => {
      callAPI
        .mockResolvedValueOnce([
          block(1, 'See [[Project Atlas]] and [[Alice]] #planning #q1', 10, 'page a', 'Page A'),
          block(2, 'Another #planning note', 20, 'page b', 'Page B'),
          block(3, 'Third on page a', 10, 'page a', 'Page A')
        ])
        .mockResolvedValueOnce([fullPage(10, 'page a', 'Page A'), fullPage(20, 'page b', 'Page B')]);

      const result = await searchBlocks(client, 'o', 10, true);

      // 1 search + 1 batched page lookup, not one per block
      expect(callAPI).toHaveBeenCalledTimes(2);
      const [method, args] = callAPI.mock.calls[1];
      expect(method).toBe('logseq.DB.datascriptQuery');
      expect(args).toHaveLength(1);
      expect(args[0]).toContain('[(ground [10 20]) [?p ...]]');

      expect(result![2].context!.references).toEqual(['Project Atlas', 'Alice']);
      expect(result![2].context!.tags).toEqual(['planning', 'q1']);
      expect(result![2].context!.page).toMatchObject({ id: 10, name: 'page a', originalName: 'Page A' });
      // newest first: block 3 (page a), block 2 (page b), block 1 (page a)
      expect(result!.map(b => b.id)).toEqual([3, 2, 1]);
      expect(result![0].context!.page.id).toBe(10);
      expect(result![1].context!.page).toMatchObject({ id: 20, originalName: 'Page B' });
      expect(result![2].context!.page.id).toBe(10);
    });

    it('converts pulled page keys to the camelCase PageEntity shape', async () => {
      callAPI
        .mockResolvedValueOnce([block(1, 'x', 10, 'jan 1st, 2025', 'Jan 1st, 2025')])
        .mockResolvedValueOnce([fullPage(10, 'jan 1st, 2025', 'Jan 1st, 2025', { 'journal?': true, 'journal-day': 20250101 })]);

      const result = await searchBlocks(client, 'x', 10, true);

      const page = result![0].context!.page;
      expect(page.originalName).toBe('Jan 1st, 2025');
      expect(page.journalDay).toBe(20250101);
      expect(page.createdAt).toBe(1);
      expect(page.updatedAt).toBe(2);
    });

    it('skips context for a block whose page was not found', async () => {
      callAPI
        .mockResolvedValueOnce([block(1, 'x', 10, 'a', 'A')])
        .mockResolvedValueOnce([]);

      const result = await searchBlocks(client, 'x', 10, true);

      expect(result![0]).not.toHaveProperty('context');
      expect(result![0].content).toBe('x');
    });

    it('gives no context to a block with no page, and looks pages up once for the rest', async () => {
      callAPI
        .mockResolvedValueOnce([
          block(1, 'x', 10, 'a', 'A'),
          block(2, 'x', 0, '', '', { page: undefined })
        ])
        .mockResolvedValueOnce([fullPage(10, 'a', 'A')]);

      const result = (await searchBlocks(client, 'x', 10, true))!;

      // Newest first: the page-less block 2 comes before block 1
      expect(result.map(r => r.id)).toEqual([2, 1]);
      expect(result[0]).not.toHaveProperty('context');
      expect(result[1].context?.page.id).toBe(10);
      // One search, one batched page lookup, and it asks only for the page that exists
      expect(callAPI).toHaveBeenCalledTimes(2);
      expect(callAPI.mock.calls[1][1][0]).toContain('[(ground [10]) [?p ...]]');
    });

    it('only looks up pages for blocks inside the limit', async () => {
      callAPI
        .mockResolvedValueOnce([
          block(1, 'x', 10, 'a', 'A'),
          block(2, 'x', 20, 'b', 'B'),
          block(3, 'x', 30, 'c', 'C')
        ])
        .mockResolvedValueOnce([fullPage(30, 'c', 'C')]);

      await searchBlocks(client, 'x', 1, true);

      expect(callAPI.mock.calls[1][1][0]).toContain('[(ground [30]) [?p ...]]');
    });
  });

  describe('slim results mode', () => {
    it('returns slim blocks with the page name from the inline pull', async () => {
      callAPI.mockResolvedValueOnce([
        block(1, 'Slim [[Alice]] #tag', 10, 'test page', 'Test Page', { marker: 'TODO' })
      ]);

      const result = await searchBlocks(client, 'slim', 10, false, true);

      expect(callAPI).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        {
          uuid: 'block-uuid-1',
          content: 'Slim [[Alice]] #tag',
          pageName: 'Test Page',
          marker: 'TODO',
          tags: ['tag'],
          pageRefs: ['Alice']
        }
      ]);
    });

    it('returns slim results with slim context when both flags are set', async () => {
      callAPI
        .mockResolvedValueOnce([block(1, 'Context [[Bob]] #tag', 10, 'test page', 'Test Page')])
        .mockResolvedValueOnce([fullPage(10, 'test page', 'Test Page', { properties: { type: 'project' } })]);

      const result = (await searchBlocks(client, 'context', 10, true, true))!;

      expect(result).toHaveLength(1);
      expect(result[0].pageName).toBe('Test Page');
      expect(result[0].context).toEqual({
        page: { name: 'test page', originalName: 'Test Page', properties: { type: 'project' } },
        references: ['Bob'],
        tags: ['tag']
      });
      // Slim drops fields like uuid, ids and timestamps from the page
      expect(result[0].context!.page).not.toHaveProperty('uuid');
      expect(result[0].context!.page).not.toHaveProperty('id');
    });

    it('includes journal metadata in slim context for journal pages', async () => {
      callAPI
        .mockResolvedValueOnce([block(1, 'entry', 10, 'jan 1st, 2025', 'Jan 1st, 2025')])
        .mockResolvedValueOnce([fullPage(10, 'jan 1st, 2025', 'Jan 1st, 2025', { 'journal?': true, 'journal-day': 20250101 })]);

      const result = (await searchBlocks(client, 'entry', 10, true, true))!;

      expect(result[0].context!.page).toMatchObject({ isJournal: true, journalDate: 20250101 });
    });

    it('omits empty fields in slim results', async () => {
      callAPI.mockResolvedValueOnce([block(1, 'Simple block', 10, 'p', 'P')]);

      const result = (await searchBlocks(client, 'simple', 10, false, true))!;

      expect(result[0]).not.toHaveProperty('tags');
      expect(result[0]).not.toHaveProperty('pageRefs');
      expect(result[0]).not.toHaveProperty('marker');
      expect(result[0]).not.toHaveProperty('properties');
    });

    it('omits empty references and tags from slim context (#42)', async () => {
      callAPI
        .mockResolvedValueOnce([
          block(1, 'No links here', 10, 'p', 'P'),
          block(2, 'Only [[Bob]]', 10, 'p', 'P'),
          block(3, 'Only #tag', 10, 'p', 'P')
        ])
        .mockResolvedValueOnce([fullPage(10, 'p', 'P')]);

      const result = (await searchBlocks(client, 'x', 10, true, true))!;
      const byContent = new Map(result.map(r => [r.content, r.context]));

      expect(byContent.get('No links here')).toEqual({ page: { name: 'p', originalName: 'P' } });
      expect(byContent.get('Only [[Bob]]')).toEqual({ page: { name: 'p', originalName: 'P' }, references: ['Bob'] });
      expect(byContent.get('Only #tag')).toEqual({ page: { name: 'p', originalName: 'P' }, tags: ['tag'] });
    });

    it('keeps empty references and tags in full context, unchanged', async () => {
      callAPI
        .mockResolvedValueOnce([block(1, 'No links here', 10, 'p', 'P')])
        .mockResolvedValueOnce([fullPage(10, 'p', 'P')]);

      const result = (await searchBlocks(client, 'x', 10, true, false))!;

      expect(result[0].context).toMatchObject({ references: [], tags: [] });
    });

    it('returns full results when slimResults is false', async () => {
      callAPI.mockResolvedValueOnce([block(1, 'Full block', 10, 'p', 'P')]);

      const result = (await searchBlocks(client, 'full', 10, false, false))!;

      expect(result[0]).toHaveProperty('id', 1);
      expect(result[0]).toHaveProperty('parent');
      expect(result[0]).toHaveProperty('left');
      expect(result[0]).not.toHaveProperty('pageName');
    });
  });
});
