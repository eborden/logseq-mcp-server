import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';

/**
 * `format: "markdown"` through the MCP server (#43): plain text (not JSON-escaped),
 * one content block, the footer carrying warnings and tips, and JSON unchanged when
 * `format` is omitted.
 */

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

type Api = (method: string, args: unknown[]) => unknown;
type Datalog = (query: string) => unknown;

afterEach(() => vi.restoreAllMocks());

async function call(
  name: string,
  args: Record<string, unknown>,
  api: Api = () => null,
  datalog: Datalog = () => [],
  options: { tips?: boolean } = {}
) {
  const logseq = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' });
  vi.spyOn(logseq, 'callAPI').mockImplementation(async (method: string, a: any[] = []) => api(method, a) as any);
  vi.spyOn(logseq, 'executeDatalogQuery').mockImplementation(async (query: string) => datalog(query) as any);
  const server = createServer(logseq, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    return (await mcp.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  } finally {
    await mcp.close();
  }
}

describe('format on logseq_get_page', () => {
  const entity = { id: 1, name: 'alice', originalName: 'Alice', file: { id: 5 }, properties: { type: 'person' } };
  const tree = [
    { id: 10, uuid: UUID_A, content: 'type:: person', 'pre-block?': true },
    { id: 11, uuid: UUID_B, content: 'first\nsecond', children: [{ content: `child ((${UUID_A}))` }] },
  ];
  const api: Api = method => {
    if (method === 'logseq.Editor.getPage') return { ...entity };
    if (method === 'logseq.Editor.getPageBlocksTree') return tree;
    return null;
  };

  it('returns Markdown as one plain text block: properties, then indented bullets, refs kept', async () => {
    const result = await call('logseq_get_page', { page_name: 'Alice', include_children: true, format: 'markdown' }, api, () => [], { tips: false });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe(
      ['# Alice', '', 'type:: person', '', '- first', '  second', `\t- child ((${UUID_A}))`, ''].join('\n')
    );
  });

  it('is not JSON-escaped', async () => {
    const result = await call('logseq_get_page', { page_name: 'Alice', include_children: true, format: 'markdown' }, api);
    expect(result.content[0].text).toContain('\n\t- child');
    expect(() => JSON.parse(result.content[0].text)).toThrow();
  });

  it('puts the tips in the footer, in the same block', async () => {
    const result = await call('logseq_get_page', { page_name: 'Alice', format: 'markdown' }, api);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('\n---\nTips:\n- For its blocks: logseq_get_page {"page_name":"Alice","include_children":true}.');
    expect(result.content[0].text).toContain('logseq_get_backlinks');
  });

  it('renders only the title and properties when children are not requested', async () => {
    const result = await call('logseq_get_page', { page_name: 'Alice', format: 'markdown' }, api, () => [], { tips: false });
    expect(result.content[0].text).toBe('# Alice\n\ntype:: person\n');
  });

  it('shows resolvedContent when resolve_refs is on, and keeps the ((uuid))', async () => {
    const datalog: Datalog = () => [[{ id: 9, uuid: UUID_A, content: 'cited text', page: { id: 1, 'original-name': 'Alice' } }]];
    const result = await call(
      'logseq_get_page',
      { page_name: 'Alice', include_children: true, resolve_refs: true, format: 'markdown' },
      api,
      datalog,
      { tips: false }
    );
    expect(result.content[0].text).toContain(`\t- child ((${UUID_A}))\n\t  [resolved] child cited text`);
  });

  it('notes the page an alias resolved to', async () => {
    const declaring = { id: 1, name: 'project atlas', 'original-name': 'Project Atlas', file: { id: 9 } };
    const stub = { id: 3, name: 'atlas', 'original-name': 'Atlas' };
    const result = await call(
      'logseq_get_page',
      { page_name: 'Atlas', format: 'markdown' },
      (method, a) =>
        method === 'logseq.Editor.getPage' && a[0] === 'project atlas'
          ? { id: 1, name: 'project atlas', originalName: 'Project Atlas', file: { id: 9 } }
          : null,
      () => [[stub, 'name'], [declaring, 'alias']],
      { tips: false }
    );
    expect(result.content[0].text).toBe('# Project Atlas\n\n(resolved from "Atlas", matched by alias)\n');
  });

  it('leaves JSON unchanged when format is omitted or "json"', async () => {
    const omitted = await call('logseq_get_page', { page_name: 'Alice', include_children: true }, api, () => [], { tips: false });
    const json = await call('logseq_get_page', { page_name: 'Alice', include_children: true, format: 'json' }, api, () => [], { tips: false });
    expect(omitted.content[0].text).toBe(json.content[0].text);
    expect(JSON.parse(omitted.content[0].text)).toMatchObject({ originalName: 'Alice', children: tree });
  });

  it('rejects an unknown format with an error, not a silent fallback', async () => {
    const result = await call('logseq_get_page', { page_name: 'Alice', format: 'html' }, api);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toContain("Invalid parameter 'format'");
  });

  it('keeps an ambiguous name a structured result whatever the format', async () => {
    const stub = { id: 3, name: 'bob', 'original-name': 'Bob' };
    const sources = [
      [{ id: 1, name: 'robert smith', 'original-name': 'Robert Smith', file: { id: 9 } }, 'alias'],
      [{ id: 2, name: 'robert jones', 'original-name': 'Robert Jones', file: { id: 10 } }, 'alias'],
    ];
    const result = await call('logseq_get_page', { page_name: 'Bob', format: 'markdown' }, () => null, () => [[stub, 'name'], ...sources]);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ambiguous: true, totalCandidates: 2 });
  });
});

describe('format on logseq_get_block', () => {
  const block = { id: 7, uuid: UUID_A, content: 'parent', children: [{ uuid: UUID_B, content: 'kid' }] };
  const api: Api = method => (method === 'logseq.Editor.getBlock' ? { ...block } : null);

  it('returns the block and its children as Markdown, headed by its uuid', async () => {
    const result = await call('logseq_get_block', { block_uuid: UUID_A, include_children: true, format: 'markdown' }, api);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe(`# Block ((${UUID_A}))\n\n- parent\n\t- kid\n`);
  });

  it('leaves JSON unchanged by default', async () => {
    const result = await call('logseq_get_block', { block_uuid: UUID_A, include_children: true }, api);
    expect(JSON.parse(result.content[0].text)).toEqual(block);
  });

  it('shows resolvedContent below the block when resolve_refs is on', async () => {
    const ref = `((${UUID_B}))`;
    const result = await call(
      'logseq_get_block',
      { block_uuid: UUID_A, resolve_refs: true, format: 'markdown' },
      method => (method === 'logseq.Editor.getBlock' ? { id: 7, uuid: UUID_A, content: `see ${ref}` } : null),
      () => [[{ id: 8, uuid: UUID_B, content: 'cited text', page: { id: 1, 'original-name': 'Alice' } }]]
    );
    expect(result.content[0].text).toBe(`# Block ((${UUID_A}))\n\n- see ${ref}\n  [resolved] see cited text\n`);
  });

  it('reports a missing block as an error whatever the format', async () => {
    const result = await call('logseq_get_block', { block_uuid: UUID_A, format: 'markdown' }, () => null);
    expect(result.isError).toBe(true);
  });
});
