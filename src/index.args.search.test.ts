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

const ID_BY_NAME: Record<string, number> = { alice: 1, bob: 2, carol: 3, dave: 4, erin: 5 };
const NAME_BY_ID = Object.fromEntries(Object.entries(ID_BY_NAME).map(([name, id]) => [id, name]));

/**
 * Outbound links of a small chain, so depth, caps and distance change the result:
 * alice -> bob, carol; bob -> dave; dave -> erin. Erin is 3 hops from Alice, so the
 * default max_depth (2) and max_distance (2) stop one hop short of her, alice's two
 * links exceed a max_fanout of 1, and the 4 pages within depth 2 exceed a max_nodes of 2.
 */
const LINKS: Record<number, number[]> = { 1: [2, 3], 2: [4], 4: [5] };

/** The ids a query binds to `variable` with `DatalogQueryBuilder.groundIds`. */
function groundedIds(query: string, variable: string): number[] {
  const end = query.indexOf(`]) [?${variable} ...]]`);
  const start = query.lastIndexOf('[(ground [', end);
  if (end < 0 || start < 0) return [];
  return query.slice(start + '[(ground ['.length, end).split(' ').filter(Boolean).map(Number);
}

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

/** Blocks with a `status` property, as LogSeq stores them: numbers and booleans are not strings. */
const PROPERTY_BLOCKS = [
  block(1, 'status:: active', { properties: { status: 'active' } }),
  block(4, 'status:: 1', { properties: { status: 1 } }),
  block(5, 'status:: 1', { properties: { status: '1' } }),
  block(6, 'status:: true', { properties: { status: true } }),
];

/** Datalog stub: answers each query by its shape, so tests don't depend on call order. */
function answer(query: string, inputs: unknown[]): unknown {
  if (query.includes(':in $ ?n')) return [[page(String(inputs[0])), 'name']];
  if (query.includes(':find ?source ?connected')) {
    // DatalogQueryBuilder.connectedPages: [source, connected, name, original-name, journal?, direction, count]
    return groundedIds(query, 'source').flatMap(source =>
      (LINKS[source] ?? []).map(target => {
        const { name, 'original-name': originalName } = page(NAME_BY_ID[target]);
        return [source, target, name, originalName, false, 'outbound', 1];
      })
    );
  }
  if (query.includes(':find ?neighbor')) {
    // DatalogQueryBuilder.neighborPages: one row per page linked to or from the frontier
    const frontier = groundedIds(query, 'p');
    const neighbours = Object.entries(LINKS).flatMap(([from, tos]) =>
      tos.flatMap(to => (frontier.includes(Number(from)) ? [to] : frontier.includes(to) ? [Number(from)] : []))
    );
    return [...new Set(neighbours)].map(id => [id]);
  }
  if (query.includes(':block/properties')) {
    // Like the query: a property matches when its value, as text, equals the input
    return PROPERTY_BLOCKS.filter(b => String(b.properties.status) === inputs[1]).map(b => [b]);
  }
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
    // Erin is 3 hops away, so the default max_distance (2) is told apart from 1 and 3
    valid: { topic_a: 'Alice', topic_b: 'Erin', relationship_type: 'connected-within' },
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

describe('the stub graph tells the defaults apart from neighbouring values', () => {
  const body = async (name: string, args: Record<string, unknown>) => {
    const { result, queries } = await call(name, args);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    return { body: JSON.parse(result.content[0].text), queries: queries.length };
  };

  it('get_concept_network: the defaults reach 4 pages at depth 2, and each nearby value differs', async () => {
    const defaults = await body('logseq_get_concept_network', { concept_name: 'Alice' });
    expect(defaults.body.nodes.map((n: { name: string }) => n.name).sort()).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
    expect(defaults.body.truncated).toBe(false);
    for (const other of [{ max_depth: 1 }, { max_depth: 3 }, { max_nodes: 2 }, { max_fanout: 1 }]) {
      expect(await body('logseq_get_concept_network', { concept_name: 'Alice', ...other }), JSON.stringify(other)).not.toEqual(defaults);
    }
  });

  it('search_by_relationship: the default walks 2 hops and stops short of a page 3 hops away', async () => {
    const args = { topic_a: 'Alice', topic_b: 'Erin', relationship_type: 'connected-within' };
    const defaults = await body('logseq_search_by_relationship', args);
    expect(defaults.body.query.maxDistance).toBe(2);
    expect((await body('logseq_search_by_relationship', { ...args, max_distance: 1 })).queries).toBeLessThan(defaults.queries);
    expect((await body('logseq_search_by_relationship', { ...args, max_distance: 3 })).queries).toBeGreaterThan(defaults.queries);
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

/** The error text of a rejected call, after checking it made no call to LogSeq. */
async function rejection(name: string, args: Record<string, unknown>): Promise<string> {
  const { result, apiCalls, queries } = await call(name, args);
  expect(result.isError).toBe(true);
  expect(apiCalls).toEqual([]);
  expect(queries).toEqual([]);
  return JSON.parse(result.content[0].text).error;
}

/** Each required string parameter, with the arguments of a valid call. */
const REQUIRED: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
  ['logseq_search_blocks', 'query', { query: 'alice' }],
  ['logseq_query_by_property', 'property_key', { property_key: 'status', property_value: 'active' }],
  ['logseq_get_concept_network', 'concept_name', { concept_name: 'Alice' }],
  ['logseq_get_context_for_query', 'query', { query: 'about [[Alice]]' }],
  ['logseq_search_by_relationship', 'topic_a', { topic_a: 'Alice', topic_b: 'Bob', relationship_type: 'references' }],
  ['logseq_search_by_relationship', 'topic_b', { topic_a: 'Alice', topic_b: 'Bob', relationship_type: 'references' }],
];

describe.each(REQUIRED)('%s rejects a bad %s before calling LogSeq', (tool, required, valid) => {
  it('reports it missing, also when sent as null', async () => {
    const { [required]: _dropped, ...rest } = valid;
    for (const args of [rest, { ...rest, [required]: null }]) {
      const error = await rejection(tool, args);
      expect(error).toContain(`Invalid parameter '${required}': missing`);
      expect(error).toContain('a string (required)');
      expect(error).toContain(`Example: ${required}: "..."`);
    }
  });

  it.each([
    [['alice'], 'an array'],
    [true, 'a boolean'],
    [5, 'a number'],
    [-1, 'a number'],
    [NaN, 'NaN'],
    [Infinity, 'Infinity'],
    [{ text: 'alice' }, 'an object'],
  ])('rejects %j', async (value, kind) => {
    expect(await rejection(tool, { ...valid, [required]: value })).toMatch(
      new RegExp(`'${required}'.*a string, not ${kind}`, 's')
    );
  });
});

/** Optional parameters of the wrong type: [tool, valid arguments, parameter, value, expected error]. */
const SEARCH = { query: 'alice' };
const PROPERTY = { property_key: 'status', property_value: 'active' };
const NETWORK = { concept_name: 'Alice' };
const RELATIONSHIP = { topic_a: 'Alice', topic_b: 'Bob', relationship_type: 'connected-within' };
const CONTEXT = { query: 'about [[Alice]] and [[Bob]]' };
const RANGE = { last_n: 1 };
const BAD_OPTIONS: ReadonlyArray<readonly [string, Record<string, unknown>, string, unknown, RegExp]> = [
  ['logseq_search_blocks', SEARCH, 'limit', '5', /'limit': "5".*a number, not a string/s],
  ['logseq_search_blocks', SEARCH, 'limit', NaN, /'limit': NaN.*a number, not NaN/s],
  ['logseq_search_blocks', SEARCH, 'limit', Infinity, /'limit': Infinity.*a number, not Infinity/s],
  ['logseq_search_blocks', SEARCH, 'limit', -Infinity, /'limit': -Infinity.*a number, not -Infinity/s],
  ['logseq_search_blocks', SEARCH, 'include_context', 'yes', /'include_context': "yes".*true or false, not a string/s],
  ['logseq_search_blocks', SEARCH, 'include_context', 1, /'include_context': 1.*true or false, not a number/s],
  ['logseq_search_blocks', SEARCH, 'slim_results', 'false', /'slim_results': "false".*true or false, not a string/s],
  ['logseq_search_blocks', SEARCH, 'slim_results', 0, /'slim_results': 0.*true or false, not a number/s],
  ['logseq_query_by_property', PROPERTY, 'slim_results', 'no', /'slim_results': "no".*true or false, not a string/s],
  ['logseq_query_by_property', PROPERTY, 'slim_results', NaN, /'slim_results': NaN/],
  ['logseq_get_concept_network', NETWORK, 'max_depth', '2', /'max_depth': "2".*a number, not a string/s],
  ['logseq_get_concept_network', NETWORK, 'max_depth', NaN, /'max_depth': NaN.*a number, not NaN/s],
  ['logseq_get_concept_network', NETWORK, 'max_depth', Infinity, /'max_depth': Infinity.*a number, not Infinity/s],
  ['logseq_get_concept_network', NETWORK, 'max_depth', -Infinity, /'max_depth': -Infinity/],
  ['logseq_get_concept_network', NETWORK, 'max_nodes', '50', /'max_nodes': "50".*a number, not a string/s],
  ['logseq_get_concept_network', NETWORK, 'max_nodes', NaN, /'max_nodes': NaN.*a number, not NaN/s],
  ['logseq_get_concept_network', NETWORK, 'max_nodes', Infinity, /'max_nodes': Infinity/],
  ['logseq_get_concept_network', NETWORK, 'max_fanout', NaN, /'max_fanout': NaN.*a number, not NaN/s],
  ['logseq_get_concept_network', NETWORK, 'max_fanout', true, /'max_fanout': true.*a number, not a boolean/s],
  ['logseq_get_concept_network', NETWORK, 'max_fanout', -Infinity, /'max_fanout': -Infinity/],
  ['logseq_get_concept_network', NETWORK, 'expand_journals', 'true', /'expand_journals': "true".*true or false, not a string/s],
  ['logseq_get_concept_network', NETWORK, 'expand_journals', 1, /'expand_journals': 1.*true or false, not a number/s],
  ['logseq_get_concept_network', NETWORK, 'format', 'html', /'format': "html".*one of "json", "markdown"/s],
  ['logseq_get_concept_network', NETWORK, 'format', 0, /'format': 0/],
  ['logseq_search_by_relationship', RELATIONSHIP, 'relationship_type', 'friends', /'relationship_type': "friends".*one of "references", "referenced-by", "in-pages-linking-to", "connected-within".*Example: relationship_type: "connected-within"/s],
  ['logseq_search_by_relationship', RELATIONSHIP, 'relationship_type', 'References', /'relationship_type': "References".*one of/s],
  ['logseq_search_by_relationship', RELATIONSHIP, 'relationship_type', 1, /'relationship_type': 1.*one of/s],
  ['logseq_search_by_relationship', RELATIONSHIP, 'max_distance', '2', /'max_distance': "2".*a number, not a string/s],
  ['logseq_search_by_relationship', RELATIONSHIP, 'max_distance', NaN, /'max_distance': NaN.*a number, not NaN/s],
  ['logseq_search_by_relationship', RELATIONSHIP, 'max_distance', Infinity, /'max_distance': Infinity/],
  ['logseq_search_by_relationship', RELATIONSHIP, 'max_distance', -Infinity, /'max_distance': -Infinity/],
  ['logseq_get_context_for_query', CONTEXT, 'max_topics', '5', /'max_topics': "5".*a number, not a string/s],
  ['logseq_get_context_for_query', CONTEXT, 'max_topics', NaN, /'max_topics': NaN.*a number, not NaN/s],
  ['logseq_get_context_for_query', CONTEXT, 'max_topics', Infinity, /'max_topics': Infinity/],
  ['logseq_get_context_for_query', CONTEXT, 'max_search_results', '20', /'max_search_results': "20".*a number, not a string/s],
  ['logseq_get_context_for_query', CONTEXT, 'max_search_results', NaN, /'max_search_results': NaN.*a number, not NaN/s],
  ['logseq_get_context_for_query', CONTEXT, 'max_search_results', -Infinity, /'max_search_results': -Infinity/],
  ['logseq_get_context_for_query', CONTEXT, 'format', 'html', /'format': "html".*one of "json", "markdown"/s],
  ['logseq_get_context_for_query', CONTEXT, 'compact', 'yes', /'compact': "yes".*true or false, not a string.*Example: compact: true/s],
  ['logseq_get_context_for_query', CONTEXT, 'compact', 1, /'compact': 1.*true or false, not a number/s],
  ['logseq_query_by_date_range', { end_date: 20250107 }, 'start_date', '20250101', /'start_date': "20250101".*a number, not a string/s],
  ['logseq_query_by_date_range', { end_date: 20250107 }, 'start_date', NaN, /'start_date': NaN.*a number, not NaN/s],
  ['logseq_query_by_date_range', { start_date: 20250101 }, 'end_date', Infinity, /'end_date': Infinity/],
  ['logseq_query_by_date_range', {}, 'last_n', '7', /'last_n': "7".*a number, not a string/s],
  ['logseq_query_by_date_range', {}, 'last_n', NaN, /'last_n': NaN.*a number, not NaN/s],
  ['logseq_query_by_date_range', {}, 'preset', 'tomorrow', /'preset': "tomorrow".*one of "today", "yesterday"/s],
  ['logseq_query_by_date_range', {}, 'preset', 5, /'preset': 5.*one of/s],
  ['logseq_query_by_date_range', RANGE, 'search_term', 5, /'search_term': 5.*a string, not a number/s],
  ['logseq_query_by_date_range', RANGE, 'search_term', ['alice'], /'search_term'.*a string, not an array/s],
  ['logseq_query_by_date_range', RANGE, 'slim_results', 'true', /'slim_results': "true".*true or false, not a string/s],
  ['logseq_query_by_date_range', RANGE, 'include_content', 'no', /'include_content': "no".*true or false, not a string/s],
  ['logseq_query_by_date_range', RANGE, 'include_content', 0, /'include_content': 0.*true or false, not a number/s],
  ['logseq_query_by_date_range', RANGE, 'top_concepts_limit', '10', /'top_concepts_limit': "10".*a number, not a string/s],
  ['logseq_query_by_date_range', RANGE, 'top_concepts_limit', NaN, /'top_concepts_limit': NaN.*a number, not NaN/s],
  ['logseq_query_by_date_range', RANGE, 'resolve_refs', 'yes', /'resolve_refs': "yes".*true or false, not a string/s],
];

describe('logseq_search_by_relationship relationship_type is required', () => {
  it('reports it missing, also when sent as null, with the values it takes', async () => {
    const { relationship_type: _dropped, ...rest } = RELATIONSHIP;
    for (const args of [rest, { ...rest, relationship_type: null }]) {
      const error = await rejection('logseq_search_by_relationship', args);
      expect(error).toContain("Invalid parameter 'relationship_type': missing");
      expect(error).toContain('"connected-within"');
    }
  });
});

describe('logseq_get_concept_network still folds an alias in before parsing', () => {
  it('name: reaches concept_name', async () => {
    await expectSame('logseq_get_concept_network', { name: 'Alice' }, NETWORK);
  });

  it('a malformed alias value is rejected like the canonical one', async () => {
    expect(await rejection('logseq_get_concept_network', { name: 5 })).toMatch(/'concept_name': 5.*a string, not a number/s);
  });
});

describe('wrong-typed options are rejected before calling LogSeq', () => {
  it.each(BAD_OPTIONS)('%s %j: %s = %j', async (tool, valid, param, value, message) => {
    expect(await rejection(tool, { ...valid, [param]: value })).toMatch(message);
  });
});

describe('null now reads as absent where it used to be a value (#60)', () => {
  it('get_context_for_query max_topics: null uses the default 5 topics (it used to use none)', async () => {
    await expectSame('logseq_get_context_for_query', { ...CONTEXT, max_topics: null }, CONTEXT);
    const { result } = await call('logseq_get_context_for_query', { ...CONTEXT, max_topics: null });
    expect(JSON.parse(result.content[0].text).contexts).toHaveLength(2);
  });

  it('get_context_for_query max_search_results: null uses the default 20 (it used to return none)', async () => {
    const keywords = { query: 'about widgets' };
    await expectSame('logseq_get_context_for_query', { ...keywords, max_search_results: null }, keywords);
    const { result } = await call('logseq_get_context_for_query', { ...keywords, max_search_results: null });
    expect(JSON.parse(result.content[0].text).searchResults).toHaveLength(3);
  });

  it('query_by_date_range top_concepts_limit: null uses the default 10 (it used to be an error)', async () => {
    await expectSame('logseq_query_by_date_range', { ...RANGE, top_concepts_limit: null }, RANGE);
  });

  it('query_by_date_range search_term: null is no search (summary.searchTerm used to echo null)', async () => {
    await expectSame('logseq_query_by_date_range', { ...RANGE, search_term: null }, RANGE);
    const { result } = await call('logseq_query_by_date_range', { ...RANGE, search_term: null });
    expect(JSON.parse(result.content[0].text).summary).not.toHaveProperty('searchTerm');
  });

  it('search_blocks limit: null uses the default limit (it used to return no blocks)', async () => {
    await expectSame('logseq_search_blocks', { ...SEARCH, limit: null }, SEARCH);
    const { result } = await call('logseq_search_blocks', { ...SEARCH, limit: null });
    expect(JSON.parse(result.content[0].text)).toHaveLength(3);
  });
});

describe('numbers that pass the parser keep their old meaning', () => {
  it('search_blocks: a limit of 0 returns no blocks and reports the matches', async () => {
    const { result } = await call('logseq_search_blocks', { ...SEARCH, limit: 0 });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual([]);
    expect(JSON.parse(result.content[1].text).meta).toMatchObject({ hasMore: true, totals: { matches: 3 } });
  });


  it.each([
    ['logseq_search_blocks', { ...SEARCH, limit: -1 }, 'limit', 0],
    ['logseq_get_concept_network', { ...NETWORK, max_depth: 0 }, 'max_depth', 1],
    ['logseq_get_concept_network', { ...NETWORK, max_depth: -1 }, 'max_depth', 1],
    ['logseq_search_by_relationship', { ...RELATIONSHIP, max_distance: 0 }, 'max_distance', 1],
    ['logseq_search_by_relationship', { ...RELATIONSHIP, max_distance: -1 }, 'max_distance', 1],
    ['logseq_get_context_for_query', { ...CONTEXT, max_topics: 0 }, 'max_topics', 1],
    ['logseq_get_context_for_query', { ...CONTEXT, max_topics: -1 }, 'max_topics', 1],
    ['logseq_query_by_date_range', { last_n: 0 }, 'last_n', 1],
    ['logseq_query_by_date_range', { last_n: -1 }, 'last_n', 1],
    ['logseq_query_by_date_range', { ...RANGE, top_concepts_limit: -1 }, 'top_concepts_limit', 0],
  ] as const)('%s %j is rejected by the parser as below its minimum, before any call (#293)', async (tool, args, param, minimum) => {
    expect(await rejection(tool, args)).toContain(
      `Invalid parameter '${param}': ${(args as Record<string, unknown>)[param]}\n\nExpected: at least ${minimum}\nExample: ${param}: ${minimum}`
    );
  });

  it.each([
    [{ start_date: 2025, end_date: 20250107 }, 'start_date'],
    [{ last_n: 1, preset: 'today' }, 'date selection'],
  ])('query_by_date_range: %j is still rejected by the tool, before any call', async (args, param) => {
    expect(await rejection('logseq_query_by_date_range', args)).toContain(`Invalid parameter '${param}'`);
  });

  it.each([
    [{ last_n: 2.5 }, 'last_n'],
    [{ ...RANGE, top_concepts_limit: 2.5 }, 'top_concepts_limit'],
  ])('query_by_date_range: %j is rejected by the parser as a fraction, before any call (#293)', async (args, param) => {
    expect(await rejection('logseq_query_by_date_range', args)).toContain(
      `Invalid parameter '${param}': 2.5\n\nExpected: an integer, not a fraction`
    );
  });

  it('search_blocks: a fractional limit is rejected before any call, not cut down (#293)', async () => {
    expect(await rejection('logseq_search_blocks', { ...SEARCH, limit: 2.5 })).toContain(
      "Invalid parameter 'limit': 2.5\n\nExpected: an integer, not a fraction"
    );
  });
});

describe('logseq_query_by_property property_value: a string, number or boolean, matched as text (#60)', () => {
  /** The value input the one Datalog query was sent, and the uuids of the blocks it matched. */
  async function matching(value: unknown) {
    const { result, queries } = await call('logseq_query_by_property', { ...PROPERTY, property_value: value });
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(queries).toHaveLength(1);
    const blocks: Array<{ uuid: string }> = JSON.parse(result.content[0].text);
    return { input: queries[0][1][1], uuids: blocks.map(b => b.uuid) };
  }

  it('1 and "1" send the same text and match the same blocks', async () => {
    const number = await matching(1);
    const text = await matching('1');
    expect(number.input).toBe('1');
    expect(number).toEqual(text);
    expect(number.uuids).toHaveLength(2);
  });

  it('true and "true" send the same text and match the same blocks, not the 1s', async () => {
    const boolean = await matching(true);
    const text = await matching('true');
    expect(boolean.input).toBe('true');
    expect(boolean).toEqual(text);
    expect(boolean.uuids).toHaveLength(1);
    expect(boolean.uuids).not.toEqual(expect.arrayContaining((await matching(1)).uuids));
  });

  it('a string still matches as before', async () => {
    expect(await matching('active')).toEqual({ input: 'active', uuids: [PROPERTY_BLOCKS[0].uuid] });
  });

  it('reports it missing, also when sent as null, naming the three types', async () => {
    for (const args of [{ property_key: 'status' }, { property_key: 'status', property_value: null }]) {
      const error = await rejection('logseq_query_by_property', args);
      expect(error).toContain("Invalid parameter 'property_value': missing");
      expect(error).toContain('a string, a number or a boolean (required)');
      expect(error).toContain('Example: property_value: "..."');
    }
  });

  it.each([
    [['active'], 'an array'],
    [{ status: 'active' }, 'an object'],
    [NaN, 'NaN'],
    [Infinity, 'Infinity'],
  ])('rejects %j', async (value, kind) => {
    expect(await rejection('logseq_query_by_property', { ...PROPERTY, property_value: value })).toMatch(
      new RegExp(`'property_value'.*a string, a number or a boolean, not ${kind}`, 's')
    );
  });
});
