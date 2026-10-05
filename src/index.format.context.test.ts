import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';

/**
 * `format` and `compact` on the context tools through the MCP server (#43):
 * build_context, get_context_for_query and get_concept_network.
 */

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Api = (method: string, args: unknown[]) => unknown;
type Datalog = (query: string) => unknown;

afterEach(() => vi.restoreAllMocks());

async function call(name: string, args: Record<string, unknown>, api: Api = () => null, datalog: Datalog = () => []) {
  const logseq = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' });
  vi.spyOn(logseq, 'callAPI').mockImplementation(async (method: string, a: any[] = []) => api(method, a) as any);
  vi.spyOn(logseq, 'executeDatalogQuery').mockImplementation(async (query: string) => datalog(query) as any);
  const server = createServer(logseq);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    return (await mcp.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  } finally {
    await mcp.close();
  }
}

describe('format and compact on logseq_build_context', () => {
  const page = { id: 1, name: 'project atlas', 'original-name': 'Project Atlas', properties: { type: 'project' }, file: { id: 5 } };
  const blocks = [
    { id: 11, uuid: U(11), content: 'top one\nsecond line', parent: { id: 1 }, left: { id: 1 }, page: { id: 1 } },
    { id: 12, uuid: U(12), content: `child ((${U(99)}))`, parent: { id: 11 }, left: { id: 11 }, page: { id: 1 } },
  ];
  const backlinks = [
    [{ id: 2, name: 'alice', 'original-name': 'Alice' }, [{ id: 21, uuid: U(21), content: 'mentions atlas\nmore detail' }]],
  ];
  const datalog: Datalog = query => (query.includes(':in $ ?n') ? [[page, 'name']] : blocks.map(b => [b]));
  const api: Api = method => (method === 'logseq.Editor.getPageLinkedReferences' ? backlinks : null);

  it('returns the whole context as Markdown: blocks as a tree, references grouped by source page', async () => {
    const result = await call('logseq_build_context', { topic_name: 'Project Atlas', format: 'markdown' }, api, datalog);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe(
      [
        '# Project Atlas',
        '',
        'type:: project',
        '',
        '## Blocks (2)',
        '',
        '- top one',
        '  second line',
        `\t- child ((${U(99)}))`,
        '',
        '## Related pages (1)',
        '',
        '[[Alice]]',
        '',
        '## References (1)',
        '',
        '### [[Alice]]',
        '',
        '- mentions atlas',
        '  more detail',
        '',
      ].join('\n')
    );
  });

  it('keeps JSON unchanged by default', async () => {
    const result = await call('logseq_build_context', { topic_name: 'Project Atlas' }, api, datalog);
    const body = JSON.parse(result.content[0].text);
    expect(body.directBlocks).toHaveLength(2);
    expect(body.directBlocks[0]).toHaveProperty('content');
    expect(body.mainPage).toHaveProperty('properties');
    expect(result.content).toHaveLength(1);
  });

  it('puts a truncation warning in the footer, with the parameter to raise', async () => {
    const result = await call('logseq_build_context', { topic_name: 'Project Atlas', max_blocks: 1, format: 'markdown' }, api, datalog);
    expect(result.content[0].text).toContain(
      '---\nWarnings:\n- blocks_truncated: Showing 1 of 2 blocks. Set max_blocks to 2 (or higher) to get all 2.\nhasMore: true'
    );
    expect(result.content[0].text).toContain('## Blocks (1 of 2)');
  });

  it('compact markdown shows snippets and uuids instead of bodies', async () => {
    const result = await call('logseq_build_context', { topic_name: 'Project Atlas', format: 'markdown', compact: true }, api, datalog);
    const text = result.content[0].text;
    expect(text).toContain(`- top one ((${U(11)}))\n\t- child ((${U(99)})) ((${U(12)}))`);
    expect(text).toContain(`### [[Alice]]\n\n- mentions atlas ((${U(21)}))`);
    expect(text).not.toContain('second line');
    expect(text).not.toContain('more detail');
  });

  it('compact JSON has uuids and snippets, and keeps hasMore and warnings', async () => {
    const result = await call('logseq_build_context', { topic_name: 'Project Atlas', compact: true, max_blocks: 1 }, api, datalog);
    const body = JSON.parse(result.content[0].text);
    expect(body.directBlocks).toEqual([{ uuid: expect.any(String), snippet: expect.any(String) }]);
    expect(body.references).toEqual([
      { block: { uuid: U(21), snippet: 'mentions atlas' }, sourcePage: { id: 2, name: 'alice', originalName: 'Alice' } },
    ]);
    expect(body.hasMore).toBe(true);
    expect(body.warnings[0].code).toBe('blocks_truncated');
    expect(result.content[0].text).not.toContain('more detail');
  });

  it('compact skips ref resolution: there are no bodies to resolve in', async () => {
    const queries: string[] = [];
    await call('logseq_build_context', { topic_name: 'Project Atlas', compact: true, resolve_refs: true }, api, query => {
      queries.push(query);
      return datalog(query);
    });
    // The resolver and the blocks query only; no ref-target queries
    expect(queries).toHaveLength(2);
  });

  it('rejects a non-boolean compact', async () => {
    const result = await call('logseq_build_context', { topic_name: 'Project Atlas', compact: 'yes' }, api, datalog);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toContain("Invalid parameter 'compact'");
  });
});
