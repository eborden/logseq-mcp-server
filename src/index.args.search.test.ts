import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';

/**
 * Arguments of the search and relationship tools through the MCP server (#60),
 * with the real tools behind it and only LogSeq mocked: defaults, null, and
 * unknown fields give the same calls and output as the explicit defaults.
 * These pin the behavior from before arguments were parsed with zod.
 */

type ApiCall = [method: string, args: unknown[]];
type Query = [query: string, inputs: unknown[]];

afterEach(() => vi.restoreAllMocks());

const ID_BY_NAME: Record<string, number> = { alice: 1, bob: 2 };

function page(name: string) {
  const id = ID_BY_NAME[name] ?? 9;
  return { id, name, 'original-name': name.replace(/^./, c => c.toUpperCase()), file: { id: 50 + id } };
}

function block(id: number, content: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    uuid: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    content,
    format: 'markdown',
    page: { id: 10, name: 'my page', 'original-name': 'My Page' },
    parent: { id: 10 },
    ...extra,
  };
}

const JOURNAL = {
  id: 20,
  name: 'jan 1st, 2025',
  'original-name': 'Jan 1st, 2025',
  'journal-day': 20250101,
  'journal?': true,
};

/** Datalog stub: answers each query by its shape, so tests don't depend on call order. */
function answer(query: string, inputs: unknown[]): unknown {
  if (query.includes(':in $ ?n')) return [[page(String(inputs[0])), 'name']];
  if (query.includes(':block/properties')) return [[block(1, 'status:: active', { properties: { status: 'active' } })]];
  if (query.includes(':block/journal-day') && query.includes(':block/name') && !query.includes(':block/page ?page')) {
    return [[JOURNAL]];
  }
  if (query.includes(':block/journal-day')) {
    return [[block(30, 'Met [[Alice]] about widgets', { page: { id: 20 }, parent: { id: 20 } })]];
  }
  if (query.includes('re-pattern')) {
    return [[block(1, 'alice and the widgets')], [block(2, 'more widgets for alice')], [block(3, 'alice widgets again')]];
  }
  return [];
}

/** Call one tool with a mocked LogSeq, recording every API call and Datalog query it makes. */
async function call(name: string, args: Record<string, unknown>) {
  const apiCalls: ApiCall[] = [];
  const queries: Query[] = [];
  const logseq = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' });
  vi.spyOn(logseq, 'callAPI').mockImplementation(async (method: string, a: any[] = []) => {
    apiCalls.push([method, a]);
    if (method === 'logseq.Editor.getPageLinkedReferences') return [] as any;
    if (method === 'logseq.Editor.getPageBlocksTree') return [] as any;
    return null as any;
  });
  vi.spyOn(logseq, 'executeDatalogQuery').mockImplementation(async (query: string, ...inputs: unknown[]) => {
    queries.push([query, inputs]);
    return answer(query, inputs) as any;
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

/** The two calls behave the same: same result, same LogSeq calls and queries. */
async function expectSame(name: string, a: Record<string, unknown>, b: Record<string, unknown>) {
  const left = await call(name, a);
  const right = await call(name, b);
  expect(left.result.isError, left.result.content[0]?.text).toBeUndefined();
  expect(left.result).toEqual(right.result);
  expect(left.apiCalls).toEqual(right.apiCalls);
  expect(left.queries).toEqual(right.queries);
}

/**
 * For each tool: valid required arguments, the advertised defaults spelled out, and
 * the optional parameters whose null was already read as absent before zod.
 */
const TOOLS = [
  {
    tool: 'logseq_search_blocks',
    valid: { query: 'alice' },
    defaults: { include_context: false, slim_results: true },
    nullable: ['include_context', 'slim_results'],
  },
  {
    tool: 'logseq_query_by_property',
    valid: { property_key: 'status', property_value: 'active' },
    defaults: { slim_results: true },
    nullable: ['slim_results'],
  },
  {
    tool: 'logseq_get_concept_network',
    valid: { concept_name: 'Alice' },
    defaults: { max_depth: 2, max_nodes: 50, max_fanout: 15, expand_journals: false, format: 'json' },
    nullable: ['max_depth', 'expand_journals', 'format'],
  },
  {
    tool: 'logseq_search_by_relationship',
    valid: { topic_a: 'Alice', topic_b: 'Bob', relationship_type: 'connected-within' },
    defaults: { max_distance: 2 },
    nullable: ['max_distance'],
  },
  {
    tool: 'logseq_get_context_for_query',
    valid: { query: 'about [[Alice]] and [[Bob]]' },
    defaults: { max_topics: 5, max_search_results: 20, format: 'json', compact: false },
    nullable: ['format', 'compact'],
  },
  {
    tool: 'logseq_query_by_date_range',
    valid: { last_n: 1 },
    defaults: { slim_results: true, include_content: true, top_concepts_limit: 10, resolve_refs: false },
    nullable: ['slim_results', 'include_content', 'resolve_refs', 'start_date', 'end_date', 'preset'],
  },
] as const;

describe.each(TOOLS)('$tool arguments', ({ tool, valid, defaults, nullable }) => {
  it('omitting every option matches the advertised defaults', async () => {
    await expectSame(tool, valid, { ...valid, ...defaults });
  });

  it.each(nullable)('reads %s: null as absent', async param => {
    await expectSame(tool, { ...valid, [param]: null }, valid);
  });

  it('ignores an unknown extra field', async () => {
    await expectSame(tool, { ...valid, future_option: 'x', verbose: true }, valid);
  });
});

describe('defaults reach the tools', () => {
  it('search_blocks returns every match under the default limit', async () => {
    const { result } = await call('logseq_search_blocks', { query: 'alice' });
    expect(JSON.parse(result.content[0].text)).toHaveLength(3);
  });

  it('get_context_for_query keyword search keeps its default of 20 results', async () => {
    const { result } = await call('logseq_get_context_for_query', { query: 'about widgets' });
    expect(JSON.parse(result.content[0].text).searchResults).toHaveLength(3);
    await expectSame('logseq_get_context_for_query', { query: 'about widgets' }, { query: 'about widgets', max_search_results: 20 });
  });

  it('query_by_date_range returns the journal with its blocks', async () => {
    const { result } = await call('logseq_query_by_date_range', { last_n: 1 });
    expect(JSON.parse(result.content[0].text).entries).toHaveLength(1);
  });
});
