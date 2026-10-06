import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';

/**
 * logseq_list_pages through the MCP server (#171): `pages` is `{ name, aliases? }[]`,
 * minified, with the tips and the pages_unavailable warning still in place. Only
 * LogSeq is mocked; every name is made up.
 */
async function call(callAPI: ReturnType<typeof vi.fn>, args: Record<string, unknown>, tips = true) {
  const client = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' });
  (client as any).callAPI = callAPI;
  const server = createServer(client, { tips });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  try {
    return (await mcpClient.callTool({ name: 'logseq_list_pages', arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
  } finally {
    await mcpClient.close();
  }
}

/** Alex declares Alex Rivera and Lexi (a clique of three); Alexandra and Bob are plain. */
const PAGES = [
  { id: 1, name: 'alex', originalName: 'Alex', file: { id: 101 }, alias: [{ id: 2 }, { id: 3 }] },
  { id: 2, name: 'alex rivera', originalName: 'Alex Rivera', alias: [{ id: 1 }, { id: 3 }] },
  { id: 3, name: 'lexi', originalName: 'Lexi', alias: [{ id: 1 }, { id: 2 }] },
  { id: 4, name: 'alexandra', originalName: 'Alexandra', file: { id: 102 } },
  { id: 5, name: 'bob', originalName: 'Bob', file: { id: 103 } },
  { id: 6, name: 'jan 1st, 2025', originalName: 'Jan 1st, 2025', 'journal?': true },
];

describe('logseq_list_pages through MCP (#171)', () => {
  it('returns pages as { name, aliases? }, aliases nested and left off pages without any', async () => {
    const result = await call(vi.fn().mockResolvedValue(PAGES), {});

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      pages: [{ name: 'Alex', aliases: ['Alex Rivera', 'Lexi'] }, { name: 'Alexandra' }, { name: 'Bob' }],
      total: 3,
    });
  });

  it('is minified, with no layout whitespace', async () => {
    const text = (await call(vi.fn().mockResolvedValue(PAGES), {})).content[0].text;

    expect(text).toBe(
      '{"pages":[{"name":"Alex","aliases":["Alex Rivera","Lexi"]},{"name":"Alexandra"},{"name":"Bob"}],"total":3}'
    );
  });

  it('name_contains finds the page by an alias and returns it whole, and the tip opens the canonical page', async () => {
    const result = await call(vi.fn().mockResolvedValue(PAGES), { name_contains: 'RIVERA' });

    expect(JSON.parse(result.content[0].text)).toEqual({
      pages: [{ name: 'Alex', aliases: ['Alex Rivera', 'Lexi'] }],
      total: 1,
    });
    const tip = JSON.parse(result.content[1].text).meta.tips[0] as string;
    expect(tip).toContain('logseq_get_page');
    expect(tip).toContain('"Alex"');
    expect(tip).not.toContain('Rivera');
  });

  it('limit counts pages, not aliases, and total counts canonical pages', async () => {
    const result = await call(vi.fn().mockResolvedValue(PAGES), { limit: 1 }, false);

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      pages: [{ name: 'Alex', aliases: ['Alex Rivera', 'Lexi'] }],
      total: 3,
      hasMore: true,
      warnings: [{ code: 'pages_truncated', message: 'Showing 1 of 3 pages. Page through the rest with offset.' }],
    });
  });

  it('keeps the pages_unavailable warning and the empty list when LogSeq returns null', async () => {
    const callAPI = vi.fn().mockResolvedValue(null);
    const result = await call(callAPI, { name_contains: 'rivera' });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      pages: [],
      total: 0,
      hasMore: false,
      warnings: [{ code: 'pages_unavailable' }],
    });
    expect(callAPI).toHaveBeenCalledTimes(1);
  });

  it('makes one API call, whatever the aliases', async () => {
    const callAPI = vi.fn().mockResolvedValue(PAGES);

    await call(callAPI, { name_contains: 'lex' });

    expect(callAPI).toHaveBeenCalledTimes(1);
    expect(callAPI).toHaveBeenCalledWith('logseq.Editor.getAllPages');
  });
});
