import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';
import { PARAM_ALIASES, resolveParamAliases } from './utils/param-aliases.js';

const mocks = vi.hoisted(() => ({
  getPage: vi.fn(async () => ({ name: 'x' })),
  getPageOutline: vi.fn(async () => ({ page: 'x', blocks: [] })),
  getBacklinks: vi.fn(async () => ({ results: [], meta: null })),
  getBlock: vi.fn(async () => ({ uuid: 'x' })),
  buildContextForTopic: vi.fn(async () => ({ topic: 'x' })),
  getConceptNetwork: vi.fn(async () => ({ nodes: [], edges: [] })),
  getConceptEvolution: vi.fn(async () => ({ timeline: [] })),
}));
vi.mock('./tools/get-page.js', () => ({ getPage: mocks.getPage }));
vi.mock('./tools/get-page-outline.js', () => ({ getPageOutline: mocks.getPageOutline }));
vi.mock('./tools/get-backlinks.js', () => ({ getBacklinksWithMeta: mocks.getBacklinks }));
vi.mock('./tools/get-block.js', () => ({ getBlock: mocks.getBlock }));
// Keep the module's constants: the argument schemas take their defaults from them (#60)
vi.mock('./tools/build-context.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  buildContextForTopic: mocks.buildContextForTopic,
}));
// Keep the module's constants: the argument schemas take their defaults from them (#60)
vi.mock('./tools/get-concept-network.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  getConceptNetwork: mocks.getConceptNetwork,
}));
vi.mock('./tools/get-concept-evolution.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  getConceptEvolution: mocks.getConceptEvolution,
}));

/** The tool function each aliased MCP tool calls, and which argument index holds the aliased value. */
const TARGETS: Record<string, { fn: ReturnType<typeof vi.fn>; argIndex: number }> = {
  logseq_get_page: { fn: mocks.getPage, argIndex: 1 },
  logseq_get_page_outline: { fn: mocks.getPageOutline, argIndex: 1 },
  logseq_get_backlinks: { fn: mocks.getBacklinks, argIndex: 1 },
  logseq_get_block: { fn: mocks.getBlock, argIndex: 1 },
  logseq_build_context: { fn: mocks.buildContextForTopic, argIndex: 1 },
  logseq_get_concept_network: { fn: mocks.getConceptNetwork, argIndex: 1 },
  logseq_get_concept_evolution: { fn: mocks.getConceptEvolution, argIndex: 1 },
};

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

const aliasCases = Object.entries(PARAM_ALIASES).flatMap(([tool, params]) =>
  Object.entries(params).flatMap(([canonical, aliases]) =>
    aliases.map(alias => ({ tool, canonical, alias }))
  )
);

describe('parameter aliases (#44)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('covers every aliased tool in the test table', () => {
    expect(Object.keys(TARGETS).sort()).toEqual(Object.keys(PARAM_ALIASES).sort());
  });

  describe('resolveParamAliases', () => {
    it('maps an alias to its canonical name and drops the alias key', () => {
      expect(resolveParamAliases('logseq_get_page', { name: 'Alice', include_children: true })).toEqual({
        page_name: 'Alice',
        include_children: true,
      });
    });

    it('leaves canonical-only args untouched', () => {
      const args = { page_name: 'Alice' };
      expect(resolveParamAliases('logseq_get_page', args)).toEqual({ page_name: 'Alice' });
    });

    it('accepts an alias given the same value as the canonical name', () => {
      expect(resolveParamAliases('logseq_get_page', { page_name: 'Alice', name: 'Alice' })).toEqual({
        page_name: 'Alice',
      });
    });

    it('accepts two aliases that agree', () => {
      expect(resolveParamAliases('logseq_get_page', { name: 'Alice', page: 'Alice' })).toEqual({
        page_name: 'Alice',
      });
    });

    it('throws InvalidParameterError when an alias and the canonical name differ', () => {
      expect(() => resolveParamAliases('logseq_get_page', { page_name: 'Alice', name: 'Bob' })).toThrow(
        /Invalid parameter 'name'.*'page_name'/s
      );
      try {
        resolveParamAliases('logseq_get_page', { page_name: 'Alice', name: 'Bob' });
      } catch (error) {
        expect((error as Error).name).toBe('InvalidParameterError');
      }
    });

    it('throws when two aliases differ and there is no canonical value', () => {
      expect(() => resolveParamAliases('logseq_build_context', { name: 'Alice', page: 'Bob' })).toThrow(
        /Invalid parameter 'page'/
      );
    });

    it('ignores null and undefined aliases', () => {
      expect(resolveParamAliases('logseq_get_page', { page_name: 'Alice', name: null, page: undefined })).toEqual({
        page_name: 'Alice',
      });
    });

    it('passes tools without aliases through, and never maps parameters that mean different things', () => {
      const args = { name: 'x', topic_a: 'A', topic_b: 'B' };
      expect(resolveParamAliases('logseq_search_by_relationship', args)).toBe(args);
      expect(resolveParamAliases('logseq_get_block', { block_uuid: 'u1', page: 'Alice' })).toEqual({
        block_uuid: 'u1',
        page: 'Alice',
      });
      expect(resolveParamAliases('logseq_get_page', undefined)).toBeUndefined();
    });
  });

  describe('through MCP', () => {
    it.each(aliasCases)('$tool: $alias reaches $canonical', async ({ tool, alias }) => {
      const { fn, argIndex } = TARGETS[tool];
      const result = await withClient(mcp => mcp.callTool({ name: tool, arguments: { [alias]: 'Alice' } }));
      expect((result as any).isError).toBeFalsy();
      expect(fn).toHaveBeenCalledTimes(1);
      expect((fn.mock.calls[0] as unknown[])[argIndex]).toBe('Alice');
    });

    it('rejects conflicting values with an InvalidParameterError message and does not call the tool', async () => {
      const result = (await withClient(mcp =>
        mcp.callTool({ name: 'logseq_get_page', arguments: { page_name: 'Alice', page: 'Bob' } })
      )) as any;
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toContain("Invalid parameter 'page'");
      expect(mocks.getPage).not.toHaveBeenCalled();
    });

    it('keeps the canonical name required for every aliased tool, so an alias is never the contract', async () => {
      const tools = await withClient(async mcp => (await mcp.listTools()).tools);
      for (const [tool, params] of Object.entries(PARAM_ALIASES)) {
        const schema = tools.find(t => t.name === tool)!.inputSchema as any;
        for (const canonical of Object.keys(params)) {
          expect(schema.required, `${tool} requires ${canonical}`).toContain(canonical);
        }
      }
    });

    it('does not advertise aliases in any input schema', async () => {
      const tools = await withClient(async mcp => (await mcp.listTools()).tools);
      for (const { tool, alias } of aliasCases) {
        const schema = tools.find(t => t.name === tool)!.inputSchema as any;
        expect(Object.keys(schema.properties), `${tool} lists ${alias}`).not.toContain(alias);
      }
    });
  });
});
