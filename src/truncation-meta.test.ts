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
