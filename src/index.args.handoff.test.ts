import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';

/**
 * What each handler hands its tool function (#60): the
 * defaults, every clamp at and above its limit, and the values that pass through
 * unclamped (negative and fractional numbers). The tool functions are mocked, so
 * these pin the handler alone. The clamps are safeguards: `max_depth` <= 3,
 * `max_nodes` <= 500, `max_fanout` <= 100.
 */

const mocks = vi.hoisted(() => ({
  searchBlocksWithMeta: vi.fn(async () => ({ results: [], meta: null })),
  queryByProperty: vi.fn(async () => []),
  getConceptNetwork: vi.fn(async () => ({ nodes: [], edges: [], truncated: false })),
  searchByRelationship: vi.fn(async () => ({ results: [] })),
  getContextForQuery: vi.fn(async () => ({
    query: 'q',
    extractedTopics: [],
    contexts: [],
    warnings: [],
    hasMore: false,
    summary: { totalTopics: 0, totalBlocks: 0, totalPages: 0 },
  })),
  queryJournals: vi.fn(async () => ({ entries: [] })),
  buildContextForTopic: vi.fn(async () => ({
    topic: 't',
    mainPage: { id: 1, name: 't' },
    directBlocks: [],
    relatedPages: [],
    references: [],
    summary: { totalBlocks: 0, totalRelatedPages: 0, totalReferences: 0, pageProperties: {} },
    totals: { blocks: 0, relatedPages: 0, references: 0 },
    warnings: [],
    hasMore: false,
  })),
  getConceptEvolution: vi.fn(async () => ({ concept: 'c', timeline: [] })),
  getPageOutline: vi.fn(async () => ({ page: 'p', blocks: [] })),
  listPages: vi.fn(async () => ({ pages: [], total: 0 })),
}));

vi.mock('./tools/search-blocks.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  searchBlocksWithMeta: mocks.searchBlocksWithMeta,
}));
vi.mock('./tools/query-by-property.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  queryByProperty: mocks.queryByProperty,
}));
vi.mock('./tools/get-concept-network.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  getConceptNetwork: mocks.getConceptNetwork,
}));
vi.mock('./tools/search-by-relationship.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  searchByRelationship: mocks.searchByRelationship,
}));
vi.mock('./tools/get-context-for-query.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  getContextForQuery: mocks.getContextForQuery,
}));
vi.mock('./tools/query-by-date-range.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  queryJournals: mocks.queryJournals,
}));

vi.mock('./tools/build-context.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  buildContextForTopic: mocks.buildContextForTopic,
}));
vi.mock('./tools/get-concept-evolution.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  getConceptEvolution: mocks.getConceptEvolution,
}));
vi.mock('./tools/get-page-outline.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  getPageOutline: mocks.getPageOutline,
}));
vi.mock('./tools/list-pages.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  listPages: mocks.listPages,
}));

beforeEach(() => vi.clearAllMocks());

/** The arguments (after the client) the handler passed to its tool function. */
async function handedOff(name: string, args: Record<string, unknown>, mock: { mock: { calls: unknown[][] } }) {
  const server = createServer(new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' }), { tips: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    const result = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError, result.content[0]?.text).toBeUndefined();
  } finally {
    await mcp.close();
  }
  expect(mock.mock.calls).toHaveLength(1);
  return mock.mock.calls[0].slice(1);
}

describe('logseq_get_concept_network hand-off', () => {
  const network = (args: Record<string, unknown>) =>
    handedOff('logseq_get_concept_network', { concept_name: 'Alice', ...args }, mocks.getConceptNetwork);

  it('defaults: depth 2, journals as leaves', async () => {
    const [name, depth, options] = await network({});
    expect(name).toBe('Alice');
    expect(depth).toBe(2);
    expect(options).toMatchObject({ expandJournals: false });
  });

  it('defaults come from the schema: the same 50 nodes and 15 per page the tool applies (#60)', async () => {
    const [, , options] = await network({});
    expect(options).toEqual({ maxNodes: 50, maxFanout: 15, expandJournals: false });
  });

  it('reads null caps as absent (#60): they used to reach the tool as 0, a network of one page', async () => {
    const [, depth, options] = await network({ max_depth: null, max_nodes: null, max_fanout: null });
    expect(depth).toBe(2);
    expect(options).toEqual({ maxNodes: 50, maxFanout: 15, expandJournals: false });
  });

  it.each([
    [3, 3],
    [4, 3],
    [100, 3],
    [0, 0],
    [-1, -1],
    [1.5, 1.5],
  ])('max_depth %j reaches the tool as %j (clamped to 3, not raised)', async (value, expected) => {
    const [, depth] = await network({ max_depth: value });
    expect(depth).toBe(expected);
  });

  it.each([
    [500, 500],
    [501, 500],
    [10_000, 500],
    [1, 1],
    [0, 0],
    [-5, -5],
    [2.5, 2.5],
  ])('max_nodes %j reaches the tool as %j (clamped to 500; the tool floors it at 1)', async (value, expected) => {
    const [, , options] = await network({ max_nodes: value });
    expect((options as { maxNodes: unknown }).maxNodes).toBe(expected);
  });

  it.each([
    [100, 100],
    [101, 100],
    [1, 1],
    [-1, -1],
    [2.5, 2.5],
  ])('max_fanout %j reaches the tool as %j (clamped to 100; the tool floors it at 1)', async (value, expected) => {
    const [, , options] = await network({ max_fanout: value });
    expect((options as { maxFanout: unknown }).maxFanout).toBe(expected);
  });

  it('expand_journals: true is passed on', async () => {
    const [, , options] = await network({ expand_journals: true });
    expect(options).toMatchObject({ expandJournals: true });
  });
});

describe('logseq_search_by_relationship hand-off', () => {
  const relationship = (args: Record<string, unknown>) =>
    handedOff(
      'logseq_search_by_relationship',
      { topic_a: 'Alice', topic_b: 'Bob', relationship_type: 'connected-within', ...args },
      mocks.searchByRelationship
    );

  it('defaults: max_distance 2', async () => {
    expect(await relationship({})).toEqual(['Alice', 'Bob', 'connected-within', 2]);
  });

  it.each([0, -1, 1.5, 3, 10])('max_distance %j passes through (it has no clamp)', async value => {
    const [, , , distance] = await relationship({ max_distance: value });
    expect(distance).toBe(value);
  });

  it.each(['references', 'referenced-by', 'in-pages-linking-to', 'connected-within'])(
    'relationship_type %j passes through',
    async type => {
      const [, , passed] = await relationship({ relationship_type: type });
      expect(passed).toBe(type);
    }
  );
});

describe('logseq_search_blocks hand-off', () => {
  const search = (args: Record<string, unknown>) =>
    handedOff('logseq_search_blocks', { query: 'alice', ...args }, mocks.searchBlocksWithMeta);

  it('defaults: no limit (the tool uses 100), no context, slim', async () => {
    expect(await search({})).toEqual(['alice', undefined, false, true]);
  });

  it.each([5, 0, -1, 2.5, 100_000])('limit %j passes through (it has no clamp)', async value => {
    const [, limit] = await search({ limit: value });
    expect(limit).toBe(value);
  });

  it('include_context and slim_results are passed on', async () => {
    expect(await search({ include_context: true, slim_results: false })).toEqual(['alice', undefined, true, false]);
  });
});

describe('logseq_query_by_property hand-off', () => {
  it('defaults: slim', async () => {
    expect(
      await handedOff('logseq_query_by_property', { property_key: 'status', property_value: 'active' }, mocks.queryByProperty)
    ).toEqual(['status', 'active', true]);
  });

  it('slim_results: false is passed on', async () => {
    expect(
      await handedOff(
        'logseq_query_by_property',
        { property_key: 'status', property_value: 'active', slim_results: false },
        mocks.queryByProperty
      )
    ).toEqual(['status', 'active', false]);
  });
});

describe('logseq_get_context_for_query hand-off', () => {
  const context = (args: Record<string, unknown>) =>
    handedOff('logseq_get_context_for_query', { query: 'about [[Alice]]', ...args }, mocks.getContextForQuery);

  it.each([
    [{ max_topics: 3 }, { maxTopics: 3 }],
    [{ max_topics: -1 }, { maxTopics: -1 }],
    [{ max_topics: 2.5 }, { maxTopics: 2.5 }],
    [{ max_search_results: 50 }, { maxSearchResults: 50 }],
    [{ max_search_results: -1 }, { maxSearchResults: -1 }],
  ])('%j passes through as %j (no clamp)', async (args, expected) => {
    const [, options] = await context(args);
    expect(options).toMatchObject(expected);
  });

  it('defaults come from the schema: the same 5 topics and 20 hits the tool applies (#60)', async () => {
    const [, options] = await context({});
    expect(options).toEqual({ maxTopics: 5, maxSearchResults: 20, hitPages: false });
  });

  it('asks for hit pages only for Markdown', async () => {
    const [, json] = await context({});
    expect(json).toMatchObject({ hitPages: false });
    vi.clearAllMocks();
    const [, markdown] = await context({ format: 'markdown' });
    expect(markdown).toMatchObject({ hitPages: true });
  });
});

describe('logseq_query_by_date_range hand-off', () => {
  const range = (args: Record<string, unknown>) => handedOff('logseq_query_by_date_range', args, mocks.queryJournals);

  it('defaults: slim, with content, no ref resolution', async () => {
    const [options] = await range({ last_n: 7 });
    expect(options).toMatchObject({ lastN: 7, slimResults: true, includeContent: true, resolveRefs: false });
  });

  it('defaults come from the schema: the same 10 top concepts the tool applies (#60)', async () => {
    const [options] = await range({ last_n: 7 });
    expect(options).toMatchObject({ topConceptsLimit: 10 });
  });

  it('passes each selection and option on unchanged', async () => {
    const [options] = await range({
      start_date: 20250101,
      end_date: 20250107,
      search_term: 'alice',
      slim_results: false,
      include_content: false,
      top_concepts_limit: 0,
      resolve_refs: true,
    });
    expect(options).toEqual({
      startDate: 20250101,
      endDate: 20250107,
      lastN: undefined,
      preset: undefined,
      searchTerm: 'alice',
      slimResults: false,
      includeContent: false,
      topConceptsLimit: 0,
      resolveRefs: true,
    });
  });

  it('passes a preset on', async () => {
    const [options] = await range({ preset: 'last_week' });
    expect(options).toMatchObject({ preset: 'last_week' });
  });

  it.each([
    [{ last_n: -1 }, { lastN: -1 }],
    [{ last_n: 2.5 }, { lastN: 2.5 }],
    [{ top_concepts_limit: -1, last_n: 1 }, { topConceptsLimit: -1 }],
  ])('%j reaches the tool as %j, which owns the range checks', async (args, expected) => {
    const [options] = await range(args);
    expect(options).toMatchObject(expected);
  });
});

describe('logseq_build_context hand-off', () => {
  const context = (args: Record<string, unknown>) =>
    handedOff('logseq_build_context', { topic_name: 'Alice', ...args }, mocks.buildContextForTopic);

  it.each([
    [{ max_blocks: 5 }, { maxBlocks: 5 }],
    [{ max_blocks: 0 }, { maxBlocks: 0 }],
    [{ max_blocks: -1 }, { maxBlocks: -1 }],
    [{ max_blocks: 2.5 }, { maxBlocks: 2.5 }],
    [{ max_blocks: 100_000 }, { maxBlocks: 100_000 }],
    [{ max_related_pages: 0 }, { maxRelatedPages: 0 }],
    [{ max_related_pages: -1 }, { maxRelatedPages: -1 }],
    [{ max_related_pages: 1_000 }, { maxRelatedPages: 1_000 }],
    [{ max_references: 0 }, { maxReferences: 0 }],
    [{ max_references: -1 }, { maxReferences: -1 }],
    [{ max_references: 1_000 }, { maxReferences: 1_000 }],
    [{ include_temporal_context: false }, { includeTemporalContext: false }],
    [{ include_temporal_context: true }, { includeTemporalContext: true }],
  ])('%j passes through as %j (no clamp)', async (args, expected) => {
    const [name, options] = await context(args);
    expect(name).toBe('Alice');
    expect(options).toMatchObject(expected);
  });

  it('resolve_refs: true is passed on, but not with compact, which warns instead', async () => {
    const [, plain] = await context({ resolve_refs: true });
    expect(plain).toMatchObject({ resolveRefs: true });
    vi.clearAllMocks();
    const [, compact] = await context({ resolve_refs: true, compact: true });
    expect(compact).toMatchObject({ resolveRefs: false });
  });
});

describe('logseq_get_concept_evolution hand-off', () => {
  const evolution = (args: Record<string, unknown>) =>
    handedOff('logseq_get_concept_evolution', { concept_name: 'Alice', ...args }, mocks.getConceptEvolution);

  it('defaults: no dates and no grouping', async () => {
    expect(await evolution({})).toEqual(['Alice', { startDate: undefined, endDate: undefined, groupBy: undefined }]);
  });

  it.each(['day', 'week', 'month'])('group_by %j passes through', async groupBy => {
    const [, options] = await evolution({ group_by: groupBy });
    expect(options).toMatchObject({ groupBy });
  });

  it.each([
    [{ start_date: 20250101, end_date: 20250131 }, { startDate: 20250101, endDate: 20250131 }],
    [{ start_date: 0 }, { startDate: 0 }],
    [{ end_date: -1 }, { endDate: -1 }],
    [{ start_date: 2025 }, { startDate: 2025 }],
  ])('%j passes through as %j (the tool does no range checks)', async (args, expected) => {
    const [, options] = await evolution(args);
    expect(options).toMatchObject(expected);
  });
});

describe('logseq_get_page_outline and logseq_list_pages hand-off', () => {
  it('get_page_outline passes the page name on', async () => {
    expect(await handedOff('logseq_get_page_outline', { page_name: 'Alice' }, mocks.getPageOutline)).toEqual(['Alice']);
  });

  it('list_pages: no filter by default, and name_contains is passed on', async () => {
    expect(await handedOff('logseq_list_pages', {}, mocks.listPages)).toEqual([{ nameContains: undefined }]);
    vi.clearAllMocks();
    expect(await handedOff('logseq_list_pages', { name_contains: 'al' }, mocks.listPages)).toEqual([{ nameContains: 'al' }]);
  });

  it('list_pages: an empty name_contains is passed on, and the tool reads it as no filter', async () => {
    expect(await handedOff('logseq_list_pages', { name_contains: '' }, mocks.listPages)).toEqual([{ nameContains: '' }]);
  });
});
