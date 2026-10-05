import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';
import { DEFAULT_MAX_FANOUT, DEFAULT_MAX_NODES } from './tools/get-concept-network.js';

const { getConceptNetworkMock } = vi.hoisted(() => ({
  getConceptNetworkMock: vi.fn(async (_client: unknown, concept: string) => ({
    concept,
    nodes: [],
    edges: [],
    truncated: false,
  })),
}));
vi.mock('./tools/get-concept-network.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./tools/get-concept-network.js')>()),
  getConceptNetwork: getConceptNetworkMock,
}));

describe('MCP Server', () => {
  it('should create a server instance', () => {
    const server = createServer();
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
    expect(typeof server.setRequestHandler).toBe('function');
  });

  describe('tool annotations', () => {
    async function listTools() {
      const server = createServer(new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
      await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
      try {
        return (await mcpClient.listTools()).tools;
      } finally {
        await mcpClient.close();
      }
    }

    it('lists all 15 tools', async () => {
      expect(await listTools()).toHaveLength(15);
    });

    it('marks every tool read-only with a title (server never writes to LogSeq)', async () => {
      const tools = await listTools();
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint, `${tool.name} must set readOnlyHint: true`).toBe(true);
        expect(tool.annotations?.title, `${tool.name} must set a title`).toBeTruthy();
      }
    });

    /**
     * Tools whose result depends on live UI state rather than graph content, so they
     * are read-only but not idempotent. Every other tool must be idempotent.
     */
    const NON_IDEMPOTENT_TOOLS = ['logseq_get_current_context'];

    it('declares non-destructive, idempotent, closed-world hints on every other tool', async () => {
      const tools = await listTools();
      for (const tool of tools.filter(t => !NON_IDEMPOTENT_TOOLS.includes(t.name))) {
        expect(tool.annotations, tool.name).toMatchObject({
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      }
    });

    it('marks UI-state tools non-idempotent but still read-only and closed-world', async () => {
      const tools = await listTools();
      for (const name of NON_IDEMPOTENT_TOOLS) {
        const tool = tools.find(t => t.name === name);
        expect(tool, `${name} must be registered`).toBeDefined();
        expect(tool!.annotations, name).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        });
      }
    });
  });

  describe('client errors reach the MCP caller', () => {
    const config = { apiUrl: 'http://localhost:12315', authToken: 'test-token-123' };
    const realFetch = global.fetch;

    afterEach(() => {
      global.fetch = realFetch;
      vi.restoreAllMocks();
    });

    async function callTool() {
      const server = createServer(new LogseqClient(config));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
      await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
      try {
        return await mcpClient.callTool({ name: 'logseq_list_pages', arguments: {} }) as any;
      } finally {
        await mcpClient.close();
      }
    }

    it('returns isError with the actionable message for a rejected token', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' }) as any;

      const result = await callTool();

      expect(result.isError).toBe(true);
      const { error } = JSON.parse(result.content[0].text);
      expect(error).toContain('rejected the auth token');
      expect(error).toContain('authToken');
      expect(error).not.toContain(config.authToken);
    });

    it('returns isError with the actionable message for a timeout', async () => {
      global.fetch = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')) as any;

      const result = await callTool();

      expect(result.isError).toBe(true);
      const { error } = JSON.parse(result.content[0].text);
      expect(error).toContain('did not respond within 30000ms');
      expect(error).toContain('timeoutMs');
    });

    it('returns isError with the actionable message when LogSeq is not running', async () => {
      const refused = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
      global.fetch = vi.fn().mockRejectedValue(refused) as any;

      const result = await callTool();

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toContain('Cannot connect to LogSeq');
    });
  });

  describe('logseq_get_concept_network caps', () => {
    async function call(args: Record<string, unknown>) {
      const server = createServer(new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
      await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
      try {
        return await mcpClient.callTool({ name: 'logseq_get_concept_network', arguments: args });
      } finally {
        await mcpClient.close();
      }
    }

    afterEach(() => getConceptNetworkMock.mockClear());

    it('exposes max_nodes, max_fanout and expand_journals in the schema', async () => {
      const server = createServer(new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
      await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
      try {
        const tool = (await mcpClient.listTools()).tools.find(t => t.name === 'logseq_get_concept_network');
        expect(Object.keys(tool!.inputSchema.properties!)).toEqual(
          expect.arrayContaining(['max_nodes', 'max_fanout', 'expand_journals'])
        );
      } finally {
        await mcpClient.close();
      }
    });

    it('passes the advertised defaults when no caps are given, the same as the tool defaults (#60)', async () => {
      await call({ concept_name: 'Alice' });
      expect(getConceptNetworkMock).toHaveBeenCalledWith(expect.anything(), 'Alice', 2, {
        maxNodes: DEFAULT_MAX_NODES,
        maxFanout: DEFAULT_MAX_FANOUT,
        expandJournals: false,
      });
      expect([DEFAULT_MAX_NODES, DEFAULT_MAX_FANOUT]).toEqual([50, 15]);
    });

    it('passes caps and expand_journals through', async () => {
      await call({ concept_name: 'Alice', max_depth: 1, max_nodes: 120, max_fanout: 40, expand_journals: true });
      expect(getConceptNetworkMock).toHaveBeenCalledWith(expect.anything(), 'Alice', 1, {
        maxNodes: 120,
        maxFanout: 40,
        expandJournals: true,
      });
    });

    it('clamps caps to their maximums', async () => {
      await call({ concept_name: 'Alice', max_depth: 9, max_nodes: 10_000, max_fanout: 10_000 });
      expect(getConceptNetworkMock).toHaveBeenCalledWith(expect.anything(), 'Alice', 3, {
        maxNodes: 500,
        maxFanout: 100,
        expandJournals: false,
      });
    });
  });
});
