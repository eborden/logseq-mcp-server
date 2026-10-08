import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';
import { DATE_PRESETS } from './utils/date-presets.js';

describe('logseq_query_by_date_range through MCP', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  async function withClient<T>(fn: (mcp: Client) => Promise<T>): Promise<T> {
    const server = createServer(new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
    try {
      return await fn(mcpClient);
    } finally {
      await mcpClient.close();
    }
  }

  it('declares last_n, preset (with its values) and include_content, and requires nothing', async () => {
    const tool = await withClient(async mcp =>
      (await mcp.listTools()).tools.find(t => t.name === 'logseq_query_by_date_range')
    );

    const schema: any = tool!.inputSchema;
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['start_date', 'end_date', 'last_n', 'preset', 'include_content'])
    );
    expect(schema.properties.preset.enum).toEqual([...DATE_PRESETS]);
    expect(schema.required).toBeUndefined();
  });

  it('declares top_concepts_limit with a default of 10', async () => {
    const tool = await withClient(async mcp =>
      (await mcp.listTools()).tools.find(t => t.name === 'logseq_query_by_date_range')
    );

    const schema: any = tool!.inputSchema;
    expect(schema.properties.top_concepts_limit).toMatchObject({ type: 'integer', default: 10 });
  });

  it('returns isError for a bad top_concepts_limit without calling LogSeq', async () => {
    global.fetch = vi.fn() as any;

    const result: any = await withClient(mcp =>
      mcp.callTool({ name: 'logseq_query_by_date_range', arguments: { last_n: 3, top_concepts_limit: -1 } })
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toContain('top_concepts_limit');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['no selection', {}],
    ['two selections', { last_n: 3, preset: 'today' }],
    ['a bad preset', { preset: 'tomorrow' }],
    ['last_n of 0', { last_n: 0 }],
  ])('returns isError for %s without calling LogSeq', async (_label, args) => {
    global.fetch = vi.fn() as any;

    const result: any = await withClient(mcp =>
      mcp.callTool({ name: 'logseq_query_by_date_range', arguments: args })
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toContain('Invalid parameter');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
