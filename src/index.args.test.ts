import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';

/**
 * Tool arguments through the MCP server (#60): what a converted tool does with
 * its defaults, with fields it doesn't know, and with arguments of the wrong
 * shape. The default cases pin the behavior from before arguments were parsed
 * with zod, so they must keep passing unchanged.
 */

const UUID_A = '11111111-1111-4111-8111-111111111111';
const PAGE = { id: 1, name: 'alice', originalName: 'Alice', file: { id: 5 } };
const PAGE_ROW = { id: 1, name: 'alice', 'original-name': 'Alice', file: { id: 5 } };
const TREE = [{ uuid: UUID_A, content: 'first' }];
const BLOCK = { id: 7, uuid: UUID_A, content: 'parent' };

type ApiCall = [method: string, args: unknown[]];

afterEach(() => vi.restoreAllMocks());

/** Call one tool with a mocked LogSeq, recording every API call and Datalog query it makes. */
async function call(name: string, args: Record<string, unknown>) {
  const apiCalls: ApiCall[] = [];
  const queries: string[] = [];
  const logseq = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' });
  vi.spyOn(logseq, 'callAPI').mockImplementation(async (method: string, a: any[] = []) => {
    apiCalls.push([method, a]);
    if (method === 'logseq.Editor.getPage') return { ...PAGE } as any;
    if (method === 'logseq.Editor.getPageBlocksTree') return TREE as any;
    if (method === 'logseq.Editor.getBlock') return { ...BLOCK } as any;
    if (method === 'logseq.Editor.getPageLinkedReferences') return [] as any;
    return null as any;
  });
  vi.spyOn(logseq, 'executeDatalogQuery').mockImplementation(async (query: string) => {
    queries.push(query);
    return [[{ ...PAGE_ROW }]] as any;
  });
  const server = createServer(logseq, { tips: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    const result = (await mcp.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { result, apiCalls, queries };
  } finally {
    await mcp.close();
  }
}

describe('logseq_get_page arguments', () => {
  it('defaults: no children, no ref resolution, JSON', async () => {
    const { result, apiCalls, queries } = await call('logseq_get_page', { page_name: 'Alice' });
    expect(result.isError).toBeUndefined();
    expect(apiCalls.map(([method]) => method)).toEqual(['logseq.Editor.getPage']);
    expect(queries).toHaveLength(0);
    expect(JSON.parse(result.content[0].text)).toEqual(PAGE);
  });

  it('include_children: true fetches the block tree', async () => {
    const { result, apiCalls } = await call('logseq_get_page', { page_name: 'Alice', include_children: true });
    expect(apiCalls.map(([method]) => method)).toContain('logseq.Editor.getPageBlocksTree');
    expect(JSON.parse(result.content[0].text)).toMatchObject({ children: TREE });
  });

  it('reads null optional arguments as absent', async () => {
    const withNulls = await call('logseq_get_page', { page_name: 'Alice', include_children: null, resolve_refs: null, format: null });
    const plain = await call('logseq_get_page', { page_name: 'Alice' });
    expect(withNulls.result).toEqual(plain.result);
    expect(withNulls.apiCalls).toEqual(plain.apiCalls);
  });

  it('ignores an unknown extra field', async () => {
    const withExtra = await call('logseq_get_page', { page_name: 'Alice', future_option: 'x' });
    const plain = await call('logseq_get_page', { page_name: 'Alice' });
    expect(withExtra.result).toEqual(plain.result);
    expect(withExtra.apiCalls).toEqual(plain.apiCalls);
  });
});

describe('logseq_get_backlinks arguments', () => {
  it('defaults: one resolver query, then the linked references of the resolved page', async () => {
    const { result, apiCalls, queries } = await call('logseq_get_backlinks', { page_name: 'Alice' });
    expect(result.isError).toBeUndefined();
    expect(queries).toHaveLength(1);
    expect(apiCalls).toEqual([['logseq.Editor.getPageLinkedReferences', ['Alice']]]);
    expect(JSON.parse(result.content[0].text)).toEqual([]);
  });

  it('ignores an unknown extra field', async () => {
    const withExtra = await call('logseq_get_backlinks', { page_name: 'Alice', limit: 5 });
    const plain = await call('logseq_get_backlinks', { page_name: 'Alice' });
    expect(withExtra.result).toEqual(plain.result);
    expect(withExtra.apiCalls).toEqual(plain.apiCalls);
  });
});

describe('logseq_get_block arguments', () => {
  it('defaults: the block alone, no ref resolution, JSON', async () => {
    const { result, apiCalls, queries } = await call('logseq_get_block', { block_uuid: UUID_A });
    expect(result.isError).toBeUndefined();
    expect(apiCalls).toEqual([['logseq.Editor.getBlock', [UUID_A]]]);
    expect(queries).toHaveLength(0);
    expect(JSON.parse(result.content[0].text)).toEqual(BLOCK);
  });

  it('include_children: true asks the Editor API for the children', async () => {
    const { apiCalls } = await call('logseq_get_block', { block_uuid: UUID_A, include_children: true });
    expect(apiCalls).toEqual([['logseq.Editor.getBlock', [UUID_A, { includeChildren: true }]]]);
  });

  it('reads null optional arguments as absent', async () => {
    const withNulls = await call('logseq_get_block', { block_uuid: UUID_A, include_children: null, resolve_refs: null, format: null });
    const plain = await call('logseq_get_block', { block_uuid: UUID_A });
    expect(withNulls.result).toEqual(plain.result);
    expect(withNulls.apiCalls).toEqual(plain.apiCalls);
  });

  it('ignores an unknown extra field', async () => {
    const withExtra = await call('logseq_get_block', { block_uuid: UUID_A, page_name: 'Alice' });
    const plain = await call('logseq_get_block', { block_uuid: UUID_A });
    expect(withExtra.result).toEqual(plain.result);
    expect(withExtra.apiCalls).toEqual(plain.apiCalls);
  });
});
