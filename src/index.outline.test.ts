import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';

/** logseq_get_page_outline through the MCP server (#43). */

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const page = { id: 1, name: 'project atlas', 'original-name': 'Project Atlas', file: { id: 9 } };
const rows = [
  { id: 10, uuid: U(10), content: 'first block', parent: { id: 1 }, left: { id: 1 } },
  { id: 11, uuid: U(11), content: 'second block', parent: { id: 1 }, left: { id: 10 } },
  { id: 20, uuid: U(20), content: 'child', parent: { id: 11 }, left: { id: 11 } },
];

afterEach(() => vi.restoreAllMocks());

async function call(args: Record<string, unknown>, datalog: (query: string) => unknown, options: { tips?: boolean } = {}) {
  const logseq = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' });
  const callAPI = vi.spyOn(logseq, 'callAPI').mockImplementation(async () => null as any);
  const executeDatalogQuery = vi.spyOn(logseq, 'executeDatalogQuery').mockImplementation(async (query: string) => datalog(query) as any);
  const server = createServer(logseq, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    const result = (await mcp.callTool({ name: 'logseq_get_page_outline', arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { result, callAPI, executeDatalogQuery };
  } finally {
    await mcp.close();
  }
}

const datalog = (query: string) => (query.includes(':in $ ?n') ? [[page, 'name']] : rows.map(r => [r]));

describe('logseq_get_page_outline through MCP', () => {
  it('returns the outline as minified JSON, with a tip to read a block', async () => {
    const { result } = await call({ page_name: 'Project Atlas' }, datalog);

    expect(result.isError).toBeUndefined();
    for (const block of result.content) expect(JSON.stringify(JSON.parse(block.text))).toBe(block.text);
    expect(JSON.parse(result.content[0].text)).toEqual({
      page: 'Project Atlas',
      blocks: [
        { uuid: U(10), snippet: 'first block', childCount: 0 },
        { uuid: U(11), snippet: 'second block', childCount: 1 },
      ],
      hasMore: false,
      warnings: [],
      totals: { blocks: 2 },
    });
    expect(JSON.parse(result.content[1].text).meta.tips).toEqual([
      `To read a block and its children: logseq_get_block {"block_uuid":"${U(11)}","include_children":true}.`,
    ]);
  });

  it('adds no tips block when tips are off', async () => {
    const { result } = await call({ page_name: 'Project Atlas' }, datalog, { tips: false });
    expect(result.content).toHaveLength(1);
  });

  it('makes two Datalog calls and no Editor API call', async () => {
    const { executeDatalogQuery, callAPI } = await call({ page_name: 'Project Atlas' }, datalog);
    expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
    expect(callAPI).not.toHaveBeenCalled();
  });

  it('accepts the unadvertised aliases name and page', async () => {
    for (const alias of ['name', 'page']) {
      const { result } = await call({ [alias]: 'Project Atlas' }, datalog);
      expect(result.isError, alias).toBeUndefined();
      expect(JSON.parse(result.content[0].text).page).toBe('Project Atlas');
    }
  });

  it('returns the candidates, not an error, for an ambiguous name', async () => {
    const stub = { id: 3, name: 'bob', 'original-name': 'Bob' };
    const sources = [
      [{ id: 1, name: 'robert smith', 'original-name': 'Robert Smith', file: { id: 9 } }, 'alias'],
      [{ id: 2, name: 'robert jones', 'original-name': 'Robert Jones', file: { id: 10 } }, 'alias'],
    ];
    const { result } = await call({ page_name: 'Bob' }, () => [[stub, 'name'], ...sources]);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ambiguous: true, totalCandidates: 2 });
  });

  it('reports a missing page as an error with guidance', async () => {
    const { result } = await call({ page_name: 'No Such Page' }, () => []);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toContain('logseq_list_pages');
  });
});
