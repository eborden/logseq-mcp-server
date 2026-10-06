import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';
import { buildTips } from './utils/tips.js';

const mocks = vi.hoisted(() => ({
  searchBlocksWithMeta: vi.fn(),
  getPage: vi.fn(),
  getBacklinks: vi.fn(),
  getBlock: vi.fn(),
}));
vi.mock('./tools/search-blocks.js', () => ({ searchBlocksWithMeta: mocks.searchBlocksWithMeta }));
vi.mock('./tools/get-page.js', () => ({ getPage: mocks.getPage }));
vi.mock('./tools/get-backlinks.js', () => ({ getBacklinks: mocks.getBacklinks }));
vi.mock('./tools/get-block.js', () => ({ getBlock: mocks.getBlock }));
// The real buildTips, wrapped so a test can see which arguments it was given (#60)
vi.mock('./utils/tips.js', async importOriginal => {
  const tips = await importOriginal<typeof import('./utils/tips.js')>();
  return { ...tips, buildTips: vi.fn(tips.buildTips) };
});

const QUOTED = 'say "hi" \\ there';

async function call(name: string, args: Record<string, unknown>, options?: { tips?: boolean }) {
  const server = createServer(new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' }), options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  try {
    return (await mcpClient.callTool({ name, arguments: args })) as any;
  } finally {
    await mcpClient.close();
  }
}

describe('next-step tips through MCP (#44)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchBlocksWithMeta.mockResolvedValue({
      results: [{ uuid: 'u1', content: 'hit', pageName: QUOTED }],
      meta: { hasMore: false, warnings: [], totals: { matches: 1 } },
    });
    mocks.getPage.mockResolvedValue({ name: 'alice', originalName: 'Alice' });
    mocks.getBacklinks.mockResolvedValue([]);
    mocks.getBlock.mockResolvedValue({ uuid: 'u1' });
  });

  it('merges search tips into the existing meta block and leaves the results block alone', async () => {
    const result = await call('logseq_search_blocks', { query: 'hit' });

    expect(result.content).toHaveLength(2);
    expect(JSON.parse(result.content[0].text)).toEqual([{ uuid: 'u1', content: 'hit', pageName: QUOTED }]);
    const { meta } = JSON.parse(result.content[1].text);
    expect(meta).toMatchObject({ hasMore: false, warnings: [], totals: { matches: 1 } });
    expect(meta.tips).toHaveLength(1);
  });

  it('gives no "No match" tip for limit: 0, which returns [] although blocks matched', async () => {
    mocks.searchBlocksWithMeta.mockResolvedValue({
      results: [],
      meta: { hasMore: true, warnings: [], totals: { matches: 3 } },
    });
    const result = await call('logseq_search_blocks', { query: 'hit', limit: 0 });
    const { meta } = JSON.parse(result.content[1].text);
    expect(meta.totals.matches).toBe(3);
    expect(meta).not.toHaveProperty('tips');
  });

  it('builds the suggested call with JSON.stringify, so a name with quotes survives', async () => {
    const result = await call('logseq_search_blocks', { query: 'hit' });
    const [tip] = JSON.parse(result.content[1].text).meta.tips as string[];

    expect(tip).toContain(`logseq_build_context ${JSON.stringify({ topic_name: QUOTED })}`);
    const json = tip.slice(tip.indexOf('{'), tip.lastIndexOf('}') + 1);
    expect(JSON.parse(json)).toEqual({ topic_name: QUOTED });
  });

  it('adds a meta-only block after a tool that has no meta, with the primary block unchanged', async () => {
    const result = await call('logseq_get_page', { page_name: 'alice' });

    expect(result.content).toHaveLength(2);
    expect(JSON.parse(result.content[0].text)).toEqual({ name: 'alice', originalName: 'Alice' });
    const { meta } = JSON.parse(result.content[1].text);
    expect(Object.keys(meta)).toEqual(['tips']);
    expect(meta.tips.join('\n')).toContain('logseq_get_backlinks {"page_name":"Alice"}');
  });

  it('applies tips to a call made with an alias, using the canonical argument', async () => {
    const result = await call('logseq_get_page', { name: 'alice' });
    expect(result.content[1].text).toContain('logseq_get_backlinks');
  });

  it('builds tips from the parsed arguments: alias folded, null dropped, defaults filled, unknown fields gone (#60)', async () => {
    await call('logseq_get_page', { page: 'alice', include_children: null, verbose: true });
    expect(buildTips).toHaveBeenCalledTimes(1);
    const [tool, args] = vi.mocked(buildTips).mock.calls[0];
    expect(tool).toBe('logseq_get_page');
    expect(args).toStrictEqual({ page_name: 'alice', include_children: false, resolve_refs: false });
  });

  it('adds no block for a tool with no next step', async () => {
    const result = await call('logseq_get_block', { block_uuid: 'u1' });
    expect(result.content).toHaveLength(1);
  });

  it('adds no block for an error result', async () => {
    mocks.getPage.mockRejectedValue(new Error('boom'));
    const result = await call('logseq_get_page', { page_name: 'alice' });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
  });

  describe('when tips are disabled', () => {
    it('leaves the search meta block without tips', async () => {
      const result = await call('logseq_search_blocks', { query: 'hit' }, { tips: false });
      expect(result.content).toHaveLength(2);
      expect(JSON.parse(result.content[1].text).meta).not.toHaveProperty('tips');
    });

    it('adds no block after get_page', async () => {
      const result = await call('logseq_get_page', { page_name: 'alice' }, { tips: false });
      expect(result.content).toHaveLength(1);
    });

    it('still emits tips when the option is omitted or true', async () => {
      expect((await call('logseq_get_page', { page_name: 'alice' })).content).toHaveLength(2);
      expect((await call('logseq_get_page', { page_name: 'alice' }, { tips: true })).content).toHaveLength(2);
    });
  });
});
