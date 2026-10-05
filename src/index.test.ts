import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';

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

    it('lists all 13 tools', async () => {
      expect(await listTools()).toHaveLength(13);
    });

    it('marks every tool read-only with a title (server never writes to LogSeq)', async () => {
      const tools = await listTools();
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint, `${tool.name} must set readOnlyHint: true`).toBe(true);
        expect(tool.annotations?.title, `${tool.name} must set a title`).toBeTruthy();
      }
    });

    it('declares non-destructive, idempotent, closed-world hints on every tool', async () => {
      const tools = await listTools();
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toMatchObject({
          destructiveHint: false,
          idempotentHint: true,
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
});
