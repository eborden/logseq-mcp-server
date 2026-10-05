import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';
import { AmbiguousPageError } from './errors.js';

/**
 * Tool results are minified JSON (#42): no indentation or line breaks between
 * tokens, so whitespace never costs tokens. This runs every tool through the MCP
 * server with a nested result and checks each content block.
 *
 * If a handler needs pretty output for a person to read, give it an opt-in
 * parameter and exempt only that call here; the default stays minified.
 * `format: "markdown"` (#43) is that opt-in: its result is plain text, covered by
 * index.format.test.ts and index.format.context.test.ts.
 */

// Nested, with a newline inside a string (which JSON escapes) to tell it from layout whitespace
const NESTED = () => ({ a: { b: [1, { c: 'two\nlines' }], d: null }, e: [] });
const NESTED_META = () => ({ hasMore: false, warnings: [], totals: { n: 1 } });

const mocks = vi.hoisted(() => {
  const nested = () => ({ a: { b: [1, { c: 'two\nlines' }], d: null }, e: [] });
  const withMeta = () => ({ results: [nested()], meta: { hasMore: false, warnings: [], totals: { n: 1 } } });
  return {
    getPage: vi.fn(async () => nested()),
    getPageOutline: vi.fn(async () => nested()),
    getBacklinksWithMeta: vi.fn(async () => withMeta()),
    getBlock: vi.fn(async () => nested()),
    searchBlocksWithMeta: vi.fn(async () => withMeta()),
    queryByProperty: vi.fn(async () => [nested()]),
    getConceptNetwork: vi.fn(async () => nested()),
    searchByRelationship: vi.fn(async () => [nested()]),
    buildContextForTopic: vi.fn(async () => nested()),
    getContextForQuery: vi.fn(async () => nested()),
    queryJournals: vi.fn(async () => nested()),
    getConceptEvolution: vi.fn(async () => nested()),
    getGraphInfo: vi.fn(async () => nested()),
    getCurrentContext: vi.fn(async () => nested()),
    listPages: vi.fn(async () => ({ pages: ['x'], ...nested() })),
  };
});
vi.mock('./tools/get-page.js', () => ({ getPage: mocks.getPage }));
vi.mock('./tools/get-page-outline.js', () => ({ getPageOutline: mocks.getPageOutline }));
vi.mock('./tools/get-backlinks.js', () => ({ getBacklinksWithMeta: mocks.getBacklinksWithMeta }));
vi.mock('./tools/get-block.js', () => ({ getBlock: mocks.getBlock }));
vi.mock('./tools/search-blocks.js', () => ({ searchBlocksWithMeta: mocks.searchBlocksWithMeta }));
vi.mock('./tools/query-by-property.js', () => ({ queryByProperty: mocks.queryByProperty }));
// Keep the modules' constants: the argument schemas take their defaults from them (#60)
vi.mock('./tools/get-concept-network.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  getConceptNetwork: mocks.getConceptNetwork,
}));
vi.mock('./tools/search-by-relationship.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  searchByRelationship: mocks.searchByRelationship,
}));
vi.mock('./tools/build-context.js', () => ({ buildContextForTopic: mocks.buildContextForTopic }));
vi.mock('./tools/get-context-for-query.js', () => ({ getContextForQuery: mocks.getContextForQuery }));
vi.mock('./tools/query-by-date-range.js', () => ({ queryJournals: mocks.queryJournals }));
vi.mock('./tools/get-concept-evolution.js', () => ({ getConceptEvolution: mocks.getConceptEvolution }));
vi.mock('./tools/get-graph-info.js', () => ({ getGraphInfo: mocks.getGraphInfo }));
vi.mock('./tools/get-current-context.js', () => ({ getCurrentContext: mocks.getCurrentContext }));
vi.mock('./tools/list-pages.js', () => ({ listPages: mocks.listPages }));

/** Minimal valid arguments for every tool. */
const CALLS: Record<string, Record<string, unknown>> = {
  logseq_get_page: { page_name: 'x', include_children: true },
  logseq_get_page_outline: { page_name: 'x' },
  logseq_get_backlinks: { page_name: 'x' },
  logseq_get_block: { block_uuid: '00000000-0000-4000-8000-000000000000' },
  logseq_search_blocks: { query: 'x' },
  logseq_query_by_property: { property_key: 'k', property_value: 'v' },
  logseq_get_concept_network: { concept_name: 'x' },
  logseq_search_by_relationship: { topic_a: 'x', topic_b: 'y', relationship_type: 'references' },
  logseq_build_context: { topic_name: 'x' },
  logseq_get_context_for_query: { query: 'x' },
  logseq_query_by_date_range: { last_n: 1 },
  logseq_get_concept_evolution: { concept_name: 'x' },
  logseq_get_graph_info: {},
  logseq_get_current_context: {},
  logseq_list_pages: { name_contains: 'x' },
};

async function withClient<T>(fn: (mcp: Client) => Promise<T>): Promise<T> {
  const server = createServer(new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    return await fn(mcp);
  } finally {
    await mcp.close();
  }
}

/** True when `text` is exactly what `JSON.stringify` writes with no spacing argument. */
const isMinifiedJson = (text: string) => JSON.stringify(JSON.parse(text)) === text;

describe('tool results are minified JSON (#42)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('has a call for every registered tool', async () => {
    const tools = await withClient(mcp => mcp.listTools());
    expect(tools.tools.map(t => t.name).sort()).toEqual(Object.keys(CALLS).sort());
  });

  it.each(Object.entries(CALLS))('%s writes every content block without layout whitespace', async (name, args) => {
    const result = (await withClient(mcp => mcp.callTool({ name, arguments: args }))) as any;

    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeGreaterThan(0);
    for (const block of result.content) {
      expect(isMinifiedJson(block.text), `${name}: ${block.text.slice(0, 60)}`).toBe(true);
      // A raw newline can only be layout: JSON escapes newlines inside strings
      expect(block.text).not.toContain('\n');
    }
  });

  it('checks the guard itself: it rejects pretty-printed JSON', () => {
    expect(isMinifiedJson(JSON.stringify(NESTED()))).toBe(true);
    expect(isMinifiedJson(JSON.stringify(NESTED(), null, 2))).toBe(false);
    expect(isMinifiedJson(JSON.stringify({ meta: NESTED_META() }))).toBe(true);
  });

  it('minifies the error result', async () => {
    mocks.getPage.mockRejectedValueOnce(new Error('boom'));
    const result = (await withClient(mcp => mcp.callTool({ name: 'logseq_get_page', arguments: { page_name: 'x' } }))) as any;

    expect(result.isError).toBe(true);
    expect(isMinifiedJson(result.content[0].text)).toBe(true);
  });

  it('minifies the ambiguous-page result', async () => {
    mocks.getPage.mockRejectedValueOnce(
      new AmbiguousPageError('x', [
        { name: 'x1', originalName: 'X1', reason: 'alias' },
        { name: 'x2', originalName: 'X2', reason: 'alias' },
      ] as any)
    );
    const result = (await withClient(mcp => mcp.callTool({ name: 'logseq_get_page', arguments: { page_name: 'x' } }))) as any;

    expect(isMinifiedJson(result.content[0].text)).toBe(true);
  });
});
