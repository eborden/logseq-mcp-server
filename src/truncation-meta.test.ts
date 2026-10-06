import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';

/**
 * End to end through the MCP server (#40): tools that return a bare array keep
 * it as the first content block and add `{ meta }` as a second block.
 */
async function callTool(callAPI: ReturnType<typeof vi.fn>, name: string, args: Record<string, unknown>) {
  const client = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' });
  (client as any).callAPI = callAPI;
  const server = createServer(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  try {
    return (await mcpClient.callTool({ name, arguments: args })) as any;
  } finally {
    await mcpClient.close();
  }
}

const blockRow = (id: number) => [{ id, uuid: `u${id}`, content: 'k', page: { id: 1, name: 'a', 'original-name': 'A' } }];

describe('logseq_search_blocks meta block', () => {
  it('keeps the array as the first block and adds a meta block when cut off', async () => {
    const callAPI = vi.fn().mockResolvedValueOnce(Array.from({ length: 6 }, (_, i) => blockRow(i + 1)));

    const result = await callTool(callAPI, 'logseq_search_blocks', { query: 'k', limit: 2 });

    expect(result.content).toHaveLength(2);
    const results = JSON.parse(result.content[0].text);
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(2);
    expect(JSON.parse(result.content[1].text).meta).toMatchObject({
      hasMore: true,
      totals: { matches: 6 },
      warnings: [{ code: 'results_truncated', howToFetchAll: 'Set limit to 6 (or higher) to get all 6.' }]
    });
  });

  it('reports hasMore false under the limit', async () => {
    const callAPI = vi.fn().mockResolvedValueOnce([blockRow(1)]);

    const result = await callTool(callAPI, 'logseq_search_blocks', { query: 'k' });

    expect(JSON.parse(result.content[0].text)).toHaveLength(1);
    expect(JSON.parse(result.content[1].text).meta).toEqual({
      hasMore: false,
      warnings: [],
      totals: { matches: 1 },
      tips: [expect.stringContaining('logseq_build_context {"topic_name":"A"}')]
    });
  });

  it('adds no meta block when the API returns null', async () => {
    const callAPI = vi.fn().mockResolvedValueOnce(null);

    const result = await callTool(callAPI, 'logseq_search_blocks', { query: 'k' });

    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0].text)).toBeNull();
  });
});

describe('logseq_search_blocks maximum limit (#61)', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => blockRow(i + 1));
  const search = (n: number, args: Record<string, unknown>) =>
    callTool(vi.fn().mockResolvedValueOnce(rows(n)), 'logseq_search_blocks', { query: 'k', ...args });

  it('clamps a limit above 500 and reports the maximum, with hasMore false', async () => {
    const result = await search(700, { limit: 1000 });

    expect(result.isError).toBeUndefined();
    const results = JSON.parse(result.content[0].text);
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(500);
    const { meta } = JSON.parse(result.content[1].text);
    expect(meta).toMatchObject({ hasMore: false, totals: { matches: 700 } });
    expect(meta.warnings).toHaveLength(1);
    expect(meta.warnings[0].code).toBe('results_truncated');
    expect(meta.warnings[0].message).toContain('capped at its maximum of 500 (1000 was asked for)');
    expect(meta.warnings[0]).not.toHaveProperty('howToFetchAll');
  });

  it('reports the maximum at limit 500 too', async () => {
    const result = await search(501, { limit: 500 });

    expect(JSON.parse(result.content[0].text)).toHaveLength(500);
    const { meta } = JSON.parse(result.content[1].text);
    expect(meta.hasMore).toBe(false);
    expect(meta.warnings[0].message).toContain('capped at its maximum of 500,');
  });

  it('never suggests a limit past the maximum', async () => {
    const result = await search(900, {});

    const { meta } = JSON.parse(result.content[1].text);
    expect(meta.hasMore).toBe(true);
    expect(meta.warnings[0].howToFetchAll).toBe(
      'Set limit to 500 (the maximum) to get 500 of 900. A result this large may be saved to a file by the host instead of shown; the server can\'t tell. Narrow the query to see the rest.'
    );
  });

  it('adds no warning when every match fits under a limit above the maximum', async () => {
    const result = await search(500, { limit: 1000 });

    expect(JSON.parse(result.content[0].text)).toHaveLength(500);
    const { meta } = JSON.parse(result.content[1].text);
    expect(meta).toMatchObject({ hasMore: false, warnings: [], totals: { matches: 500 } });
  });

  it('leaves the first content block unchanged within the maximum', async () => {
    // Under the maximum the cap never bites: the same search at 500 or 1000 gives the same array
    const at500 = await search(320, { limit: 500 });
    const at1000 = await search(320, { limit: 1000 });
    const atDefault = await search(80, {});

    expect(at1000.content[0].text).toBe(at500.content[0].text);
    expect(JSON.parse(at500.content[0].text)).toHaveLength(320);
    expect(JSON.parse(atDefault.content[0].text)).toHaveLength(80);
    expect(at1000.content[1].text).toBe(at500.content[1].text);
  });
});

describe('logseq_list_pages pages_unavailable warning (#64)', () => {
  it('delivers the warning in the result object when getAllPages returns null', async () => {
    const callAPI = vi.fn().mockResolvedValueOnce(null);

    const result = await callTool(callAPI, 'logseq_list_pages', {});

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ pages: [], total: 0, hasMore: false });
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0].code).toBe('pages_unavailable');
    expect(body.warnings[0].message).toContain('logseq_get_graph_info');
  });

  it('sends no warning when getAllPages returns an empty array', async () => {
    const callAPI = vi.fn().mockResolvedValueOnce([]);

    const result = await callTool(callAPI, 'logseq_list_pages', {});

    expect(JSON.parse(result.content[0].text)).toEqual({ pages: [], total: 0 });
  });
});

describe('logseq_list_pages limit and offset (#61)', () => {
  const pages = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const name = `p${String(i).padStart(4, '0')}`;
      return { id: i + 1, uuid: `u${i}`, name, originalName: name };
    });
  const list = (n: number, args: Record<string, unknown> = {}) =>
    callTool(vi.fn().mockResolvedValue(pages(n)), 'logseq_list_pages', args);

  it('returns the same object as before at 200 or fewer pages, whatever the limit', async () => {
    const atDefault = await list(200);
    expect(JSON.parse(atDefault.content[0].text)).toEqual({
      pages: pages(200).map(p => ({ name: p.originalName })),
      total: 200,
    });
    for (const limit of [200, 1000, 5000]) {
      expect((await list(200, { limit })).content[0].text, `limit ${limit}`).toBe(atDefault.content[0].text);
    }
  });

  it('cuts at the default 200 and reports it in the result object', async () => {
    const body = JSON.parse((await list(250)).content[0].text);

    expect(body.pages).toHaveLength(200);
    expect(body).toMatchObject({ total: 250, hasMore: true });
    expect(body.warnings).toEqual([
      {
        code: 'pages_truncated',
        message: 'Showing 200 of 250 pages. Page through the rest with offset.',
        howToFetchAll: 'Set offset to 200 for the next page. Or set limit to 250 (or higher) to get all 250 in one call.',
      },
    ]);
  });

  it('clamps a limit above 1000 and keeps hasMore true with the next offset', async () => {
    const at1000 = await list(1500, { limit: 1000 });
    const at5000 = await list(1500, { limit: 5000 });
    const body = JSON.parse(at5000.content[0].text);

    expect(body.pages).toHaveLength(1000);
    expect(body.pages).toEqual(JSON.parse(at1000.content[0].text).pages);
    expect(body.hasMore).toBe(true);
    expect(body.warnings[0].message).toContain('maximum of 1000 (5000 was asked for)');
    expect(body.warnings[0].howToFetchAll).toBe('Set offset to 1000 for the next page.');
  });

  it('returns the last page with no warning, and total still counts every page', async () => {
    const body = JSON.parse((await list(1500, { limit: 1000, offset: 1000 })).content[0].text);

    expect(body).toEqual({ pages: pages(1500).slice(1000).map(p => ({ name: p.originalName })), total: 1500 });
  });
});

describe('logseq_get_context_for_query keyword-hit maximum (#61)', () => {
  // The query names no topic, so the keyword search ("widgets") is the only call
  const hitRow = (id: number) => [{ id, uuid: `u${id}`, content: `widgets ${id}`, page: { id: 1 } }];
  const rows = (n: number) => Array.from({ length: n }, (_, i) => hitRow(i + 1));
  const ask = (n: number, args: Record<string, unknown> = {}) =>
    callTool(vi.fn().mockResolvedValueOnce(rows(n)).mockResolvedValue([]), 'logseq_get_context_for_query', {
      query: 'about widgets',
      ...args,
    });

  it('reports the slice at the default 20 in the result object', async () => {
    const result = await ask(30);

    expect(result.content).toHaveLength(1);
    const body = JSON.parse(result.content[0].text);
    expect(body.searchResults).toHaveLength(20);
    expect(body.hasMore).toBe(true);
    expect(body.warnings).toEqual([
      {
        code: 'search_results_truncated',
        message: 'Showing 20 of 30 keyword hits.',
        howToFetchAll: 'Set max_search_results to 30 (or higher) to get all 30.',
      },
    ]);
  });

  it('clamps a value above 100 and reports the maximum, with hasMore false', async () => {
    const result = await ask(250, { max_search_results: 1000 });

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.searchResults).toHaveLength(100);
    expect(body.hasMore).toBe(false);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0].code).toBe('search_results_truncated');
    expect(body.warnings[0].message).toContain('capped at its maximum of 100 (1000 was asked for)');
    expect(body.warnings[0]).not.toHaveProperty('howToFetchAll');
  });

  it('leaves the result unchanged when every hit fits', async () => {
    const atDefault = await ask(20);
    const atMax = await ask(20, { max_search_results: 100 });
    const above = await ask(20, { max_search_results: 1000 });

    const body = JSON.parse(atDefault.content[0].text);
    expect(body.searchResults).toHaveLength(20);
    expect(body).toMatchObject({ hasMore: false, warnings: [] });
    expect(atMax.content[0].text).toBe(atDefault.content[0].text);
    expect(above.content[0].text).toBe(atDefault.content[0].text);
  });

  it('keeps the warning under compact and in the Markdown footer', async () => {
    const compact = JSON.parse((await ask(250, { max_search_results: 100, compact: true })).content[0].text);
    expect(compact.searchResults).toHaveLength(100);
    expect(compact.warnings.map((w: { code: string }) => w.code)).toEqual(['search_results_truncated']);

    const markdown = (await ask(250, { max_search_results: 100, format: 'markdown' })).content[0].text;
    expect(markdown).toContain('## Search results (100)');
    expect(markdown).toContain(
      '- search_results_truncated: Showing 100 of 250 keyword hits: max_search_results is capped'
    );
    expect(markdown).not.toContain('hasMore: true');
  });
});

describe('logseq_get_concept_evolution max_entries (#61)', () => {
  // The concept page resolves by name; `n` journal blocks link it (the mentions query)
  const evolve = (n: number, args: Record<string, unknown> = {}) => {
    const callAPI = vi.fn(async (method: string, params: unknown[]) => {
      if (method === 'logseq.DB.datascriptQuery') {
        if (String(params[0]).includes(':in $ ?n')) {
          return [[{ id: 100, name: 'concept', 'original-name': 'Concept' }, 'name']];
        }
        return Array.from({ length: n }, (_, i) => [
          { id: i + 1, content: `m${i}`, page: { id: 500 + i, 'journal-day': 20240101 + i } },
        ]);
      }
      return method === 'logseq.Editor.getPageBlocksTree' ? [] : { id: 100, name: 'concept' };
    });
    return callTool(callAPI, 'logseq_get_concept_evolution', { concept_name: 'Concept', ...args });
  };

  it('cuts at the default 100 and reports it in the result object', async () => {
    const body = JSON.parse((await evolve(150)).content[0].text);

    expect(body.timeline).toHaveLength(100);
    expect(body).toMatchObject({ hasMore: true, totals: { mentions: 150 } });
    expect(body.summary.totalMentions).toBe(150);
    expect(body.warnings).toEqual([
      {
        code: 'entries_truncated',
        message: 'Showing 100 of 150 mentions (oldest first, undated last; the timeline ends at 20240200).',
        howToFetchAll: 'Set max_entries to 150 (or higher) to get all 150.',
      },
    ]);
  });

  it('clamps a value above 500 and reports the maximum, with hasMore false', async () => {
    const result = await evolve(600, { max_entries: 5000 });

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.timeline).toHaveLength(500);
    expect(body.hasMore).toBe(false);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0].code).toBe('entries_truncated');
    expect(body.warnings[0].message).toContain('capped at its maximum of 500 (5000 was asked for)');
    expect(body.warnings[0]).not.toHaveProperty('howToFetchAll');
  });

  it('leaves the result unchanged when every mention fits', async () => {
    const atDefault = await evolve(100);
    const atMax = await evolve(100, { max_entries: 500 });
    const above = await evolve(100, { max_entries: 5000 });

    const body = JSON.parse(atDefault.content[0].text);
    expect(body.timeline).toHaveLength(100);
    expect(Object.keys(body)).not.toContain('warnings');
    expect(Object.keys(body)).not.toContain('totals');
    expect(atMax.content[0].text).toBe(atDefault.content[0].text);
    expect(above.content[0].text).toBe(atDefault.content[0].text);
  });

  it('rejects a max_entries that is not a number', async () => {
    const result = await evolve(3, { max_entries: 'many' });

    expect(result.isError).toBe(true);
  });
});

describe('logseq_query_by_date_range max_blocks (#61)', () => {
  // `n` journal days of `perDay` top-level blocks each, on made-up day numbers from 20250101
  const dateRange = (n: number, perDay: number, args: Record<string, unknown> = {}) => {
    const pages = Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      name: `day ${20250101 + i}`,
      'original-name': `Day ${20250101 + i}`,
      'journal-day': 20250101 + i,
      'journal?': true,
    }));
    const blocks = pages.flatMap(page =>
      Array.from({ length: perDay }, (_, k) => {
        const id = page.id * 1000 + k + 1;
        return {
          id,
          uuid: `u${id}`,
          content: `b${id}`,
          page: { id: page.id },
          parent: { id: page.id },
          left: { id: k === 0 ? page.id : id - 1 },
        };
      })
    );
    const callAPI = vi.fn(async (_method: string, params: unknown[]) =>
      String(params[0]).includes(':block/page ?page') ? blocks.map(b => [b]) : pages.map(p => [p])
    );
    return callTool(callAPI, 'logseq_query_by_date_range', {
      start_date: 20250101,
      end_date: 20250100 + n,
      ...args,
    });
  };
  const entryBlocks = (body: any) => body.entries.reduce((sum: number, e: any) => sum + e.blocks.length, 0);

  it('cuts at the default 200 and reports it in the result object', async () => {
    const result = await dateRange(3, 70);
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(entryBlocks(body)).toBe(200);
    expect(body).toMatchObject({ hasMore: true, totals: { blocks: 210, days: 3 } });
    expect(body.summary).toMatchObject({ totalDays: 3, totalBlocks: 210 });
    expect(body.warnings).toEqual([
      {
        code: 'blocks_truncated',
        message: 'Showing 200 of 210 blocks (nested ones counted; oldest day first; the entries end at 20250103).',
        howToFetchAll:
          'Call again with start_date 20250103, the same end_date (20250103) and the same max_blocks ' +
          'to read the rest of day 20250103 (it repeats its kept blocks), or add a search_term.',
      },
    ]);
  });

  it('clamps a value above 1000, reports the maximum, and pages on with hasMore true', async () => {
    const result = await dateRange(11, 100, { max_blocks: 5000 });

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(entryBlocks(body)).toBe(1000);
    expect(body.hasMore).toBe(true);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0].code).toBe('blocks_truncated');
    expect(body.warnings[0].message).toContain('capped at its maximum of 1000 (5000 was asked for)');
    expect(body.warnings[0].howToFetchAll).toContain('Call again with start_date 20250111');
    expect(body.warnings[0].howToFetchAll).not.toContain('Set max_blocks');
  });

  it('counts top-level blocks for include_content false', async () => {
    const body = JSON.parse((await dateRange(3, 70, { include_content: false, max_blocks: 100 })).content[0].text);

    expect(body.entries.reduce((sum: number, e: any) => sum + e.snippets.length, 0)).toBe(100);
    expect(body.warnings[0].message).toContain('Showing 100 of 210 blocks (top-level only;');
  });

  it('leaves the result unchanged when every block fits', async () => {
    const atDefault = await dateRange(4, 50);
    const atMax = await dateRange(4, 50, { max_blocks: 1000 });
    const above = await dateRange(4, 50, { max_blocks: 5000 });

    const body = JSON.parse(atDefault.content[0].text);
    expect(entryBlocks(body)).toBe(200);
    expect(Object.keys(body)).not.toContain('warnings');
    expect(Object.keys(body)).not.toContain('totals');
    expect(atMax.content[0].text).toBe(atDefault.content[0].text);
    expect(above.content[0].text).toBe(atDefault.content[0].text);
  });

  it('rejects a max_blocks that is not a number', async () => {
    const result = await dateRange(2, 2, { max_blocks: 'many' });

    expect(result.isError).toBe(true);
  });
});

describe('logseq_get_backlinks max_pages and max_blocks_per_page (#61)', () => {
  // The page resolves by name with no alias; `pages` source pages of `perPage` linking blocks each,
  // as the Editor API's linked references return them
  const backlinks = (pages: number, perPage: number, args: Record<string, unknown> = {}) => {
    const tuples = Array.from({ length: pages }, (_, i) => [
      { id: 100 + i, name: `source ${i}`, originalName: `Source ${i}` },
      Array.from({ length: perPage }, (_, k) => ({ id: (100 + i) * 1000 + k, uuid: `u${i}-${k}`, content: `link [[Alice]]`, page: { id: 100 + i } })),
    ]);
    const callAPI = vi.fn(async (method: string) =>
      method === 'logseq.DB.datascriptQuery' ? [[{ id: 1, name: 'alice', 'original-name': 'Alice' }, 'name']] : tuples
    );
    return callTool(callAPI, 'logseq_get_backlinks', { page_name: 'Alice', ...args });
  };
  const blocksIn = (results: any[]) => results.reduce((sum: number, [, blocks]: any) => sum + blocks.length, 0);

  it('keeps the array as the first block, cut at 20 pages of 10, and reports both cuts in a second block', async () => {
    const result = await backlinks(25, 12);

    expect(result.content).toHaveLength(2);
    const results = JSON.parse(result.content[0].text);
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(20);
    expect(blocksIn(results)).toBe(200);
    expect(JSON.parse(result.content[1].text).meta).toMatchObject({
      hasMore: true,
      totals: { pages: 25, blocks: 300 },
      warnings: [
        {
          code: 'pages_truncated',
          message: 'Showing 20 of 25 source pages, ranked by linking blocks (most first, ties by page name). The last page kept has 12 linking blocks, the first dropped page has 12. Blocks per page are capped separately by max_blocks_per_page.',
          howToFetchAll: 'Set max_pages to 25 (or higher) to get all 25.',
        },
        {
          code: 'page_blocks_truncated',
          howToFetchAll: 'Set max_blocks_per_page to 12 (or higher) to get every block of these pages.',
        },
      ],
    });
  });

  it('clamps max_pages above 100 and reports the maximum, with hasMore false', async () => {
    const result = await backlinks(120, 1, { max_pages: 5000 });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toHaveLength(100);
    const { meta } = JSON.parse(result.content[1].text);
    expect(meta.hasMore).toBe(false);
    expect(meta.warnings).toHaveLength(1);
    expect(meta.warnings[0].code).toBe('pages_truncated');
    expect(meta.warnings[0].message).toContain('capped at its maximum of 100 (5000 was asked for)');
    expect(meta.warnings[0]).not.toHaveProperty('howToFetchAll');
  });

  it('clamps max_blocks_per_page above 50 and reports the maximum, with hasMore false', async () => {
    const result = await backlinks(1, 60, { max_blocks_per_page: 5000 });

    expect(result.isError).toBeUndefined();
    expect(blocksIn(JSON.parse(result.content[0].text))).toBe(50);
    const { meta } = JSON.parse(result.content[1].text);
    expect(meta.hasMore).toBe(false);
    expect(meta.warnings).toHaveLength(1);
    expect(meta.warnings[0].code).toBe('page_blocks_truncated');
    expect(meta.warnings[0].message).toContain('capped at its maximum of 50 (5000 was asked for)');
    expect(meta.warnings[0]).not.toHaveProperty('howToFetchAll');
  });

  it('adds no cap meta, and the same array, when both caps hold everything', async () => {
    const atDefault = await backlinks(20, 10);
    const atMax = await backlinks(20, 10, { max_pages: 100, max_blocks_per_page: 50 });
    const above = await backlinks(20, 10, { max_pages: 5000, max_blocks_per_page: 5000 });

    expect(JSON.parse(atDefault.content[0].text)).toHaveLength(20);
    // What follows the array is the tips block (on by default) and nothing about the caps
    expect(Object.keys(JSON.parse(atDefault.content[1].text).meta)).toEqual(['tips']);
    expect(atMax.content).toEqual(atDefault.content);
    expect(above.content).toEqual(atDefault.content);
  });

  it('rejects a max_pages that is not a number', async () => {
    expect((await backlinks(2, 2, { max_pages: 'many' })).isError).toBe(true);
    expect((await backlinks(2, 2, { max_blocks_per_page: 'many' })).isError).toBe(true);
  });
});

describe('logseq_query_by_property limit (#61)', () => {
  // `n` blocks carrying the property, all on one made-up page, as the one Datalog query returns them
  const byProperty = (n: number, args: Record<string, unknown> = {}) => {
    const callAPI = vi.fn(async () => Array.from({ length: n }, (_, i) => [blockRow(i + 1)[0]]));
    return callTool(callAPI, 'logseq_query_by_property', { property_key: 'status', property_value: 'active', ...args });
  };

  it('keeps the array as the first block, cut at 100, and reports the cut in a second block', async () => {
    const result = await byProperty(130);

    expect(result.content).toHaveLength(2);
    const results = JSON.parse(result.content[0].text);
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(100);
    expect(JSON.parse(result.content[1].text).meta).toMatchObject({
      hasMore: true,
      totals: { matches: 130 },
      warnings: [
        {
          code: 'results_truncated',
          message: 'Showing 100 of 130 matching blocks (the first ones listed, not ranked).',
          howToFetchAll: 'Set limit to 130 (or higher) to get all 130.',
        },
      ],
    });
  });

  it('honours limit and returns the rest on request', async () => {
    expect(JSON.parse((await byProperty(130, { limit: 5 })).content[0].text)).toHaveLength(5);
    expect(JSON.parse((await byProperty(130, { limit: 130 })).content[0].text)).toHaveLength(130);
  });

  it('clamps limit above 500 and reports the maximum, with hasMore false', async () => {
    const result = await byProperty(600, { limit: 5000 });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toHaveLength(500);
    const { meta } = JSON.parse(result.content[1].text);
    expect(meta.hasMore).toBe(false);
    expect(meta.totals).toEqual({ matches: 600 });
    expect(meta.warnings).toHaveLength(1);
    expect(meta.warnings[0].code).toBe('results_truncated');
    expect(meta.warnings[0].message).toContain('capped at its maximum of 500 (5000 was asked for)');
    expect(meta.warnings[0]).not.toHaveProperty('howToFetchAll');
  });

  it('adds no cap meta, and the same array, when everything fits', async () => {
    const atDefault = await byProperty(100);
    const explicit = await byProperty(100, { limit: 100 });
    const atMax = await byProperty(100, { limit: 500 });
    const above = await byProperty(100, { limit: 5000 });

    expect(JSON.parse(atDefault.content[0].text)).toHaveLength(100);
    // What follows the array is the tips block (on by default) and nothing about the cap
    expect(Object.keys(JSON.parse(atDefault.content[1].text).meta)).toEqual(['tips']);
    expect(explicit.content).toEqual(atDefault.content);
    expect(atMax.content).toEqual(atDefault.content);
    expect(above.content).toEqual(atDefault.content);
  });

  it('rejects a limit that is not a number', async () => {
    expect((await byProperty(2, { limit: 'many' })).isError).toBe(true);
  });
});

describe('logseq_search_by_relationship limit (#61)', () => {
  // A mock of the HTTP API: the resolver answers each topic with a page that has a file and no alias,
  // the connected-within hop finds topic B, and any other Datalog query is the data query,
  // which returns `n` blocks. The result is an object, so meta sits in it, not in a second block.
  const pages: Record<string, any> = {
    '"alice"': { id: 9, name: 'alice', 'original-name': 'Alice', file: { id: 900 } },
    '"bob"': { id: 10, name: 'bob', 'original-name': 'Bob', file: { id: 900 } },
  };
  const relationship = (n: number, args: Record<string, unknown> = {}) => {
    const callAPI = vi.fn(async (method: string, params: unknown[]) => {
      if (method === 'logseq.Editor.getPageBlocksTree') {
        return Array.from({ length: Math.ceil(n / 2) }, (_, i) => ({ id: 1000 + i, content: `Block ${i}` }));
      }
      const [query, ...inputs] = params as string[];
      if (query.includes(':in $ ?n')) return [[pages[inputs[0]], 'name']];
      if (query.includes('?neighbor')) return [[10]];
      return Array.from({ length: n }, (_, i) => blockRow(i + 1));
    });
    return callTool(callAPI, 'logseq_search_by_relationship', {
      topic_a: 'Alice',
      topic_b: 'Bob',
      relationship_type: 'references',
      ...args,
    });
  };
  const body = (result: any) => JSON.parse(result.content[0].text);

  it('cuts results at 50 by default, reports it in the object, and sends no second block', async () => {
    const result = await relationship(80);

    expect(result.content).toHaveLength(1);
    const parsed = body(result);
    expect(parsed.results).toHaveLength(50);
    expect(parsed).toMatchObject({
      hasMore: true,
      totals: { blocks: 80 },
      warnings: [
        {
          code: 'results_truncated',
          message: 'Showing 50 of 80 matching blocks (the first ones listed, not ranked).',
          howToFetchAll: 'Set limit to 80 (or higher) to get all 80.',
        },
      ],
    });
  });

  // connected-within returns both pages' trees, `n / 2` top-level blocks each, so 80 in all
  it.each(['references', 'referenced-by', 'in-pages-linking-to', 'connected-within'])(
    'honours limit for %s and returns the rest on request',
    async type => {
      expect(body(await relationship(80, { relationship_type: type, limit: 5 })).results).toHaveLength(5);
      expect(body(await relationship(80, { relationship_type: type, limit: 80 })).results).toHaveLength(80);
    }
  );

  it('clamps limit above 500 and reports the maximum, with hasMore false', async () => {
    const result = await relationship(600, { limit: 5000 });

    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed.results).toHaveLength(500);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.totals).toEqual({ blocks: 600 });
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0].code).toBe('results_truncated');
    expect(parsed.warnings[0].message).toContain('capped at its maximum of 500 (5000 was asked for)');
    expect(parsed.warnings[0]).not.toHaveProperty('howToFetchAll');
  });

  it('adds nothing to the result when everything fits, whatever limit is passed', async () => {
    const atDefault = await relationship(50);
    const explicit = await relationship(50, { limit: 50 });
    const atMax = await relationship(50, { limit: 500 });
    const above = await relationship(50, { limit: 5000 });

    expect(body(atDefault).results).toHaveLength(50);
    expect(body(atDefault)).toMatchObject({ hasMore: false, warnings: [] });
    expect(body(atDefault)).not.toHaveProperty('totals');
    expect(explicit.content).toEqual(atDefault.content);
    expect(atMax.content).toEqual(atDefault.content);
    expect(above.content).toEqual(atDefault.content);
  });

  it('rejects a limit that is not a number', async () => {
    expect((await relationship(2, { limit: 'many' })).isError).toBe(true);
  });
});
