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
      'Set limit to 500 (the maximum) to get 500 of 900. Narrow the query to see the rest.'
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
      pages: pages(200).map(p => p.originalName),
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
        message: 'Showing 200 of 250 pages.',
        howToFetchAll: 'Set limit to 250 (or higher) to get all 250. Set offset to 200 for the next page.',
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

    expect(body).toEqual({ pages: pages(1500).slice(1000).map(p => p.originalName), total: 1500 });
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
        message: 'Showing 100 of 150 mentions (oldest first, undated last).',
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
