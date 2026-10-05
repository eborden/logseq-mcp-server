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

  it('warns when compact skipped resolve_refs, in JSON and in the Markdown footer (#80)', async () => {
    const json = await call('logseq_build_context', { topic_name: 'Project Atlas', compact: true, resolve_refs: true }, api, datalog);
    const warning = JSON.parse(json.content[0].text).warnings.find((w: any) => w.code === 'resolve_refs_ignored_in_compact');
    expect(warning.message).toContain('compact output has no block bodies');
    expect(warning.message).toContain('Set compact to false');
    expect(warning.message).toContain('logseq_get_block');
    // Advice only: nothing more to fetch with a parameter, so hasMore stays false
    expect(JSON.parse(json.content[0].text).hasMore).toBe(false);

    const md = await call(
      'logseq_build_context',
      { topic_name: 'Project Atlas', compact: true, resolve_refs: true, format: 'markdown' },
      api,
      datalog
    );
    expect(md.content[0].text).toContain('---\nWarnings:\n- resolve_refs_ignored_in_compact: compact output has no block bodies');
  });

  it('does not warn about resolve_refs when compact is off, or when resolve_refs is off', async () => {
    const codes = async (args: Record<string, unknown>) =>
      JSON.parse((await call('logseq_build_context', { topic_name: 'Project Atlas', ...args }, api, datalog)).content[0].text).warnings.map(
        (w: any) => w.code
      );
    expect(await codes({ compact: true })).not.toContain('resolve_refs_ignored_in_compact');
    expect(await codes({ resolve_refs: true })).not.toContain('resolve_refs_ignored_in_compact');
  });

  it('rejects a non-boolean compact', async () => {
    const result = await call('logseq_build_context', { topic_name: 'Project Atlas', compact: 'yes' }, api, datalog);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toContain("Invalid parameter 'compact'");
  });
});

describe('format and compact on logseq_get_context_for_query', () => {
  const page = { id: 1, name: 'project atlas', 'original-name': 'Project Atlas', file: { id: 5 } };
  const blocks = [{ id: 11, uuid: U(11), content: 'top one\nsecond line', parent: { id: 1 }, left: { id: 1 }, page: { id: 1 } }];
  const datalog: Datalog = query => (query.includes(':in $ ?n') ? [[page, 'name']] : blocks.map(b => [b]));
  const api: Api = () => null;

  /** Only "Project Atlas" exists; the resolver and the namespace-leaf lookup find nothing for other names. */
  const onlyAtlas: Datalog = query => {
    if (query.includes(':in $ ?suffix')) return [];
    if (query.includes(':in $ ?n')) return [[page, 'name']];
    return datalog(query);
  };

  it('renders each topic one heading level down, and warns about one it skipped', async () => {
    const calls: string[] = [];
    const result = await call(
      'logseq_get_context_for_query',
      { query: 'about [[Project Atlas]] and [[Missing]]', format: 'markdown' },
      api,
      query => {
        calls.push(query);
        // The first resolver query is for "Project Atlas"; the second, for "Missing", finds nothing
        const resolverCalls = calls.filter(q => q.includes(':in $ ?n')).length;
        return query.includes(':in $ ?n') && resolverCalls > 1 ? [] : onlyAtlas(query);
      }
    );
    const text = result.content[0].text;
    expect(result.content).toHaveLength(1);
    expect(text.startsWith('# Context for: about [[Project Atlas]] and [[Missing]]\n\nTopics: [[Project Atlas]], [[Missing]]\n\n## Project Atlas\n')).toBe(true);
    expect(text).toContain('### Blocks (1)\n\n- top one\n  second line');
    expect(text).toContain('---\nWarnings:\n- topic_not_found: No page found for topic "Missing"; it was skipped.');
  });

  it('keeps JSON unchanged by default and compacts on request', async () => {
    const plain = await call('logseq_get_context_for_query', { query: 'about [[Project Atlas]]' }, api, datalog);
    expect(JSON.parse(plain.content[0].text).contexts[0].directBlocks[0]).toHaveProperty('content');

    const compact = await call('logseq_get_context_for_query', { query: 'about [[Project Atlas]]', compact: true }, api, datalog);
    const body = JSON.parse(compact.content[0].text);
    expect(body.contexts[0].directBlocks).toEqual([{ uuid: U(11), snippet: 'top one' }]);
    expect(compact.content[0].text).not.toContain('second line');
  });

  describe('keyword search hits (a query with no topic)', () => {
    const alice = { id: 2, name: 'alice', 'original-name': 'Alice' };
    const hit = { id: 31, uuid: U(31), content: 'widgets are great\nmore on widgets', page: { id: 2, name: 'alice', 'original-name': 'Alice' } };
    const searchApi: Datalog = query => {
      if (query.includes('re-pattern')) return [[hit]];
      if (query.includes('ground')) return [[alice]];
      return [];
    };

    it('Markdown hits carry the block ((uuid)) and the page, so a follow-up call is possible (#80)', async () => {
      const result = await call('logseq_get_context_for_query', { query: 'about widgets', format: 'markdown' }, api, searchApi);
      expect(result.content[0].text).toContain(`- widgets are great ((${U(31)})) (in [[Alice]])\n  more on widgets`);
    });

    it('compact Markdown hits carry the same handle', async () => {
      const result = await call('logseq_get_context_for_query', { query: 'about widgets', format: 'markdown', compact: true }, api, searchApi);
      expect(result.content[0].text).toContain(`- widgets are great ((${U(31)})) (in [[Alice]])\n`);
      expect(result.content[0].text).not.toContain('more on widgets');
    });

    it('JSON hits are unchanged: no page lookup, no context', async () => {
      const queries: string[] = [];
      const result = await call('logseq_get_context_for_query', { query: 'about widgets' }, api, query => {
        queries.push(query);
        return searchApi(query);
      });
      expect(queries.filter(q => q.includes('ground'))).toHaveLength(0);
      expect(JSON.parse(result.content[0].text).searchResults[0]).not.toHaveProperty('context');
    });
  });

  it('compact markdown shows snippets and uuids', async () => {
    const result = await call('logseq_get_context_for_query', { query: 'about [[Project Atlas]]', format: 'markdown', compact: true }, api, datalog);
    expect(result.content[0].text).toContain(`- top one ((${U(11)}))`);
    expect(result.content[0].text).not.toContain('second line');
  });
});

describe('format on logseq_get_concept_network', () => {
  const root = { id: 1, name: 'project atlas', 'original-name': 'Project Atlas', file: { id: 5 } };
  // [sourceId, connectedId, name, originalName, isJournal, relType, count]
  const rows = [[1, 2, 'alice', 'Alice', false, 'outbound', 3]];
  const datalog: Datalog = query => (query.includes(':in $ ?n') ? [[root, 'name']] : rows);

  it('returns the network as Markdown with the cap warning in the footer', async () => {
    const result = await call(
      'logseq_get_concept_network',
      { concept_name: 'Project Atlas', max_depth: 1, max_nodes: 1, format: 'markdown' },
      () => null,
      datalog
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text.startsWith('# Concept network: [[Project Atlas]]\n\n(no linked pages)\n')).toBe(true);
    expect(result.content[0].text).toContain('---\nWarnings:\n- network_truncated:');
    expect(result.content[0].text).toContain('hasMore: true');
  });

  it('lists the pages and links', async () => {
    const result = await call('logseq_get_concept_network', { concept_name: 'Project Atlas', max_depth: 1, format: 'markdown' }, () => null, datalog);
    expect(result.content[0].text).toBe(
      '# Concept network: [[Project Atlas]]\n\n## Depth 1 (1)\n\n[[Alice]]\n\n## Links (1)\n\n- [[Project Atlas]] -> [[Alice]] (3)\n'
    );
  });

  it('keeps JSON unchanged by default', async () => {
    const result = await call('logseq_get_concept_network', { concept_name: 'Project Atlas', max_depth: 1 }, () => null, datalog);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      concept: 'Project Atlas',
      nodes: [{ id: 1, name: 'Project Atlas', depth: 0 }, { id: 2, name: 'Alice', depth: 1 }],
      truncated: false,
    });
  });
});
