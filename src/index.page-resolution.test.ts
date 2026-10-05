import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';

/**
 * How name resolution (#41) reaches an MCP caller: an ambiguous name is a
 * structured result, a missing page is an error carrying guidance.
 */
describe('page resolution through MCP', () => {
  const stub = { id: 3, name: 'bob', 'original-name': 'Bob' };
  const sources = [
    [{ id: 1, name: 'robert smith', 'original-name': 'Robert Smith', file: { id: 9 } }, 'alias'],
    [{ id: 2, name: 'robert jones', 'original-name': 'Robert Jones', file: { id: 10 } }, 'alias']
  ];

  afterEach(() => vi.restoreAllMocks());

  async function call(name: string, args: Record<string, unknown>, datalog: (query: string) => unknown) {
    const logseq = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' });
    vi.spyOn(logseq, 'executeDatalogQuery').mockImplementation(async (query: string) => datalog(query) as any);
    vi.spyOn(logseq, 'callAPI').mockResolvedValue([] as any);

    const server = createServer(logseq);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    try {
      return (await mcp.callTool({ name, arguments: args })) as any;
    } finally {
      await mcp.close();
    }
  }

  it.each([
    ['logseq_get_page', { page_name: 'Bob' }],
    ['logseq_get_backlinks', { page_name: 'Bob' }],
    ['logseq_build_context', { topic_name: 'Bob' }],
    ['logseq_get_concept_network', { concept_name: 'Bob' }],
    ['logseq_get_concept_evolution', { concept_name: 'Bob' }],
    ['logseq_search_by_relationship', { topic_a: 'Bob', topic_b: 'Bob', relationship_type: 'references' }]
  ])('%s returns the candidates, not an error, for an alias shared by two pages', async (tool, args) => {
    const result = await call(tool, args, () => [[stub, 'name'], ...sources]);

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ ambiguous: true, pageName: 'Bob', totalCandidates: 2, hasMore: false });
    expect(body.candidates.map((c: any) => [c.name, c.originalName, c.matchedBy])).toEqual([
      ['robert jones', 'Robert Jones', 'alias'],
      ['robert smith', 'Robert Smith', 'alias']
    ]);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0].code).toBe('ambiguous_page');
  });

  it('returns an error with guidance for a name that matches nothing', async () => {
    const result = await call('logseq_get_page', { page_name: 'Nope' }, () => []);

    expect(result.isError).toBe(true);
    const { error } = JSON.parse(result.content[0].text);
    expect(error).toMatch(/^No page "Nope"\./);
    expect(error).toContain('logseq_search_blocks');
    expect(error).toContain('logseq_list_pages');
  });
});
