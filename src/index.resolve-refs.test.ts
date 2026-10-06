import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';

const mocks = vi.hoisted(() => ({
  getPage: vi.fn(async () => ({ name: 'x' })),
  getBlock: vi.fn(async () => ({ uuid: 'x' })),
  buildContextForTopic: vi.fn(async () => ({ topic: 'x' })),
  queryJournals: vi.fn(async () => ({ entries: [] })),
}));
vi.mock('./tools/get-page.js', () => ({ getPage: mocks.getPage }));
vi.mock('./tools/get-block.js', () => ({ getBlock: mocks.getBlock }));
// Keep the module's constants: the argument schemas take their defaults from them (#60)
vi.mock('./tools/build-context.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  buildContextForTopic: mocks.buildContextForTopic,
}));
vi.mock('./tools/query-by-date-range.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  queryJournals: mocks.queryJournals,
}));

const WITH_RESOLVE_REFS = [
  'logseq_get_page',
  'logseq_get_block',
  'logseq_build_context',
  'logseq_query_by_date_range',
];

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

describe('resolve_refs through MCP', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is declared as a boolean defaulting to false on exactly the four tools', async () => {
    const tools = await withClient(async mcp => (await mcp.listTools()).tools);
    const declaring = tools.filter(t => 'resolve_refs' in ((t.inputSchema as any).properties ?? {}));
    expect(declaring.map(t => t.name).sort()).toEqual([...WITH_RESOLVE_REFS].sort());
    for (const tool of declaring) {
      expect((tool.inputSchema as any).properties.resolve_refs).toMatchObject({ type: 'boolean', default: false });
      expect((tool.inputSchema as any).required ?? []).not.toContain('resolve_refs');
    }
  });

  // Arguments are parsed with zod (#60): a non-boolean is rejected instead of read as off
  it.each([
    ['logseq_get_page', { page_name: 'p' }, () => mocks.getPage, (c: any[]) => c[3]],
    ['logseq_get_block', { block_uuid: 'u' }, () => mocks.getBlock, (c: any[]) => c[3]],
    ['logseq_build_context', { topic_name: 't' }, () => mocks.buildContextForTopic, (c: any[]) => c[2]],
    ['logseq_query_by_date_range', { last_n: 1 }, () => mocks.queryJournals, (c: any[]) => c[1]],
  ])('%s passes resolve_refs on, off by default, and rejects a non-boolean', async (name, args, getMock, pick) => {
    const rejected = await withClient(async mcp => {
      await mcp.callTool({ name, arguments: args });
      await mcp.callTool({ name, arguments: { ...args, resolve_refs: true } });
      return (await mcp.callTool({ name, arguments: { ...args, resolve_refs: 'yes' } })) as any;
    });
    const calls = (getMock() as any).mock.calls;
    expect(calls).toHaveLength(2);
    expect(pick(calls[0]).resolveRefs).toBe(false);
    expect(pick(calls[1]).resolveRefs).toBe(true);
    expect(rejected.isError).toBe(true);
    expect(JSON.parse(rejected.content[0].text).error).toContain("Invalid parameter 'resolve_refs'");
  });
});
