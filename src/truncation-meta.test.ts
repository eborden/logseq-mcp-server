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
      totals: { matches: 1 }
    });
  });

  it('adds no meta block when the API returns null', async () => {
    const callAPI = vi.fn().mockResolvedValueOnce(null);

    const result = await callTool(callAPI, 'logseq_search_blocks', { query: 'k' });

    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0].text)).toBeNull();
  });
});
