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

  async function call(
    name: string,
    args: Record<string, unknown>,
    datalog: (query: string) => unknown,
    api: (method: string, args: unknown[]) => unknown = () => []
  ) {
    const logseq = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' });
    vi.spyOn(logseq, 'executeDatalogQuery').mockImplementation(async (query: string) => datalog(query) as any);
    vi.spyOn(logseq, 'callAPI').mockImplementation(async (method: string, a: any[] = []) => api(method, a) as any);

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

  it('warns that the candidate list was cut, and how to narrow the search', async () => {
    const many = Array.from({ length: 13 }, (_, i) => [
      { id: 100 + i, name: `team ${i}/atlas`, 'original-name': `Team ${i}/Atlas`, file: { id: 1 } },
      'alias'
    ]);

    const result = await call('logseq_get_page', { page_name: 'Atlas' }, () => many);

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ ambiguous: true, totalCandidates: 13, hasMore: false, totals: { candidates: 13 } });
    expect(body.candidates).toHaveLength(10);
    expect(body.warnings.map((w: any) => w.code)).toEqual(['ambiguous_page', 'candidates_truncated']);
    expect(body.warnings[1].message).toContain("can't be fetched in one call");
    expect(body.warnings[1].message).toContain('logseq_list_pages');
  });

  describe('resolvedFrom reaches the caller for a name that was not an exact match', () => {
    const declaring = { id: 1, name: 'project atlas', 'original-name': 'Project Atlas', file: { id: 9 } };
    const viaAlias = (query: string) => (query.includes(':in $ ?n') ? [[declaring, 'alias']] : []);
    const resolvedFrom = { name: 'Atlas', matchedBy: 'alias', resolvedTo: 'Project Atlas' };

    it('get_backlinks puts it in the meta block, after the unchanged array', async () => {
      const result = await call('logseq_get_backlinks', { page_name: 'Atlas' }, viaAlias);

      expect(JSON.parse(result.content[0].text)).toEqual([]);
      const meta = result.content.map((c: any) => JSON.parse(c.text)).find((b: any) => b.meta)?.meta;
      expect(meta.resolvedFrom).toEqual(resolvedFrom);
    });

    it('get_backlinks adds no meta block for an exact name', async () => {
      const result = await call('logseq_get_backlinks', { page_name: 'Atlas' }, query =>
        query.includes(':in $ ?n') ? [[{ ...declaring, name: 'atlas' }, 'name']] : []
      );

      const metas = result.content.map((c: any) => JSON.parse(c.text)).filter((b: any) => b?.meta?.resolvedFrom);
      expect(metas).toEqual([]);
    });

    it('get_concept_evolution puts it in the result', async () => {
      const result = await call('logseq_get_concept_evolution', { concept_name: 'Atlas' }, viaAlias);

      expect(JSON.parse(result.content[0].text).resolvedFrom).toEqual(resolvedFrom);
    });

    it('search_by_relationship puts it in the result, keyed by topic', async () => {
      const result = await call(
        'logseq_search_by_relationship',
        { topic_a: 'Atlas', topic_b: 'Atlas', relationship_type: 'references' },
        viaAlias
      );

      expect(JSON.parse(result.content[0].text).resolvedFrom).toEqual({ topicA: resolvedFrom, topicB: resolvedFrom });
    });
  });

  describe('a name given under a parameter alias (#44) goes through resolution (#41)', () => {
    const declaring = { id: 1, name: 'project atlas', 'original-name': 'Project Atlas', file: { id: 9 } };
    const viaAlias = (query: string) => (query.includes(':in $ ?n') ? [[declaring, 'alias']] : []);
    // Editor.getPage: nothing answers to "atlas", the declaring page answers to its own name
    const editor = (method: string, args: unknown[]) =>
      method === 'logseq.Editor.getPage'
        ? args[0] === 'project atlas'
          ? { id: 1, name: 'project atlas', originalName: 'Project Atlas', file: { id: 9 } }
          : null
        : [];

    it.each([
      ['logseq_get_page', 'name'],
      ['logseq_get_page', 'page']
    ])('%s: %s reaches page_name and the page is resolved', async (tool, alias) => {
      const result = await call(tool, { [alias]: 'Atlas' }, viaAlias, editor);

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.name).toBe('project atlas');
      expect(body.resolvedFrom).toEqual({ name: 'Atlas', matchedBy: 'alias', resolvedTo: 'Project Atlas' });
    });

    it('logseq_get_backlinks: name is resolved, and the meta block says so', async () => {
      const result = await call('logseq_get_backlinks', { name: 'Atlas' }, viaAlias, editor);

      const meta = result.content.map((c: any) => JSON.parse(c.text)).find((b: any) => b?.meta)?.meta;
      expect(meta.resolvedFrom).toMatchObject({ name: 'Atlas', matchedBy: 'alias' });
    });

    it.each([
      ['logseq_build_context', 'page'],
      ['logseq_get_concept_network', 'name'],
      ['logseq_get_concept_evolution', 'page']
    ])('%s: %s reaches the concept/topic name and the page is resolved', async (tool, alias) => {
      const result = await call(tool, { [alias]: 'Atlas' }, viaAlias, editor);

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).resolvedFrom).toMatchObject({ name: 'Atlas', matchedBy: 'alias' });
    });

    it('an alias-supplied name that is ambiguous returns the candidates', async () => {
      const result = await call('logseq_get_page', { name: 'Bob' }, () => [[stub, 'name'], ...sources]);

      expect(JSON.parse(result.content[0].text)).toMatchObject({ ambiguous: true, pageName: 'Bob', totalCandidates: 2 });
    });

    it('an alias-supplied name that matches nothing is a not-found error with guidance', async () => {
      const result = await call('logseq_get_page', { name: 'Nope' }, () => [], () => null);

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toMatch(/^No page "Nope"\./);
    });
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
