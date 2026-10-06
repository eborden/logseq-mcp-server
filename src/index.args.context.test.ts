import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';

/**
 * Arguments of the context, evolution, outline and listing tools through the MCP
 * server (#60), with the real tools behind it and only LogSeq mocked: defaults,
 * null and unknown fields give the same calls and output as the explicit defaults.
 * These pin the behaviour from before arguments were parsed with zod.
 */

type ApiCall = [method: string, args: unknown[]];
type Query = [query: string, inputs: unknown[]];

afterEach(() => vi.restoreAllMocks());

const ID_BY_NAME: Record<string, number> = { alice: 1, bob: 2, carol: 3 };

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
    page: { id: 1 },
    parent: { id: 1 },
    ...extra,
  };
}

const JAN = { id: 20, name: 'jan 1st, 2025', 'original-name': 'Jan 1st, 2025', 'journal-day': 20250101, 'journal?': true };
const FEB = { id: 21, name: 'feb 15th, 2025', 'original-name': 'Feb 15th, 2025', 'journal-day': 20250215, 'journal?': true };

/** Two blocks on Alice's page, so a max_blocks of 1 differs from the default. */
const PAGE_BLOCKS = [block(1, 'first about [[Bob]]'), block(2, 'second', { left: { id: 1 } })];

/** Two backlinks from two pages, so max_references and max_related_pages of 1 differ from the default. */
const BACKLINKS = [
  [page('bob'), [block(11, 'Bob mentions [[Alice]]', { page: { id: 2 }, parent: { id: 2 } })]],
  [page('carol'), [block(12, 'Carol mentions [[Alice]]', { page: { id: 3 }, parent: { id: 3 } })]],
];

/** Mentions of Alice on two journal days, so a date filter or grouping changes the result. */
const MENTIONS = [block(31, 'met [[Alice]]', { page: JAN }), block(32, 'again [[Alice]]', { page: FEB })];

const ALL_PAGES = [
  { id: 1, name: 'alice', originalName: 'Alice' },
  { id: 2, name: 'bob', originalName: 'Bob' },
  { id: 20, name: 'jan 1st, 2025', originalName: 'Jan 1st, 2025', 'journal?': true },
];

/** Datalog stub: answers each query by its shape, so tests don't depend on call order. */
function answer(query: string, inputs: unknown[]): unknown {
  if (query.includes(':in $ ?n')) return [[page(String(inputs[0])), 'name']];
  if (query.includes(':block/left :block/parent')) return PAGE_BLOCKS.map(b => [b]);
  if (query.includes('[?block :block/refs ?page]')) return MENTIONS.map(b => [b]);
  if (query.includes('[?block :block/page ?page]')) return PAGE_BLOCKS.map(b => [b]);
  return [];
}

function editor(method: string): unknown {
  switch (method) {
    case 'logseq.Editor.getPageLinkedReferences':
      return BACKLINKS;
    case 'logseq.Editor.getPageBlocksTree':
      return [];
    case 'logseq.Editor.getAllPages':
      return ALL_PAGES;
    case 'logseq.App.getCurrentGraph':
      return { name: 'my graph', path: '/tmp/my-graph', url: 'logseq_local_/tmp/my-graph' };
    case 'logseq.Editor.getCurrentPage':
      return page('alice');
    case 'logseq.Editor.getCurrentBlock':
      return block(1, 'first about [[Bob]]');
    default:
      return null;
  }
}

/** Call one tool with a mocked LogSeq, recording every API call and Datalog query it makes. */
async function call(name: string, args: Record<string, unknown>) {
  const apiCalls: ApiCall[] = [];
  const queries: Query[] = [];
  const logseq = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' });
  vi.spyOn(logseq, 'callAPI').mockImplementation(async (method: string, a: any[] = []) => {
    apiCalls.push([method, a]);
    return editor(method) as any;
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

/** The parsed JSON body of a successful call. */
async function body(name: string, args: Record<string, unknown>) {
  const { result } = await call(name, args);
  expect(result.isError, result.content[0]?.text).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

/**
 * For each tool: valid required arguments, the advertised defaults spelled out, and
 * the optional parameters whose null was already read as absent before zod.
 */
const TOOLS = [
  {
    tool: 'logseq_build_context',
    valid: { topic_name: 'Alice' },
    defaults: {
      max_blocks: 50,
      max_related_pages: 10,
      max_references: 20,
      include_temporal_context: true,
      resolve_refs: false,
      format: 'json',
      compact: false,
    },
    nullable: ['resolve_refs', 'format', 'compact'],
  },
  {
    tool: 'logseq_get_concept_evolution',
    valid: { concept_name: 'Alice' },
    defaults: {},
    nullable: ['start_date', 'end_date', 'group_by'],
  },
  { tool: 'logseq_get_page_outline', valid: { page_name: 'Alice' }, defaults: {}, nullable: [] },
  { tool: 'logseq_list_pages', valid: {}, defaults: {}, nullable: ['name_contains'] },
  { tool: 'logseq_get_graph_info', valid: {}, defaults: {}, nullable: [] },
  { tool: 'logseq_get_current_context', valid: {}, defaults: {}, nullable: [] },
] as const;

describe.each(TOOLS)('$tool arguments', ({ tool, valid, defaults, nullable }) => {
  it('succeeds with only the required arguments', async () => {
    const { result } = await call(tool, valid);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
  });

  it('omitting every option matches the advertised defaults', async () => {
    await expectSame(tool, valid, { ...valid, ...defaults });
  });

  it.each(nullable as readonly string[])('reads %s: null as absent', async param => {
    await expectSame(tool, { ...valid, [param]: null }, valid);
  });

  it('ignores an unknown extra field', async () => {
    await expectSame(tool, { ...valid, future_option: 'x', verbose: true }, valid);
  });
});

describe('the stub graph tells the defaults apart from neighbouring values', () => {
  const CONTEXT = { topic_name: 'Alice' };

  it('build_context: the defaults keep both blocks, references and related pages', async () => {
    const defaults = await body('logseq_build_context', CONTEXT);
    expect(defaults.directBlocks).toHaveLength(2);
    expect(defaults.references).toHaveLength(2);
    expect(defaults.relatedPages).toHaveLength(2);
    expect(defaults.temporalContext).toEqual({ isJournal: false });
    expect(defaults.hasMore).toBe(false);
  });

  it.each([
    [{ max_blocks: 1 }, 'directBlocks'],
    [{ max_references: 1 }, 'references'],
    [{ max_related_pages: 1 }, 'relatedPages'],
  ])('build_context %j keeps one of %s', async (option, field) => {
    const capped = await body('logseq_build_context', { ...CONTEXT, ...option });
    expect(capped[field]).toHaveLength(1);
    expect(capped.hasMore).toBe(true);
  });

  it('build_context include_temporal_context: false drops the temporal context', async () => {
    expect(await body('logseq_build_context', { ...CONTEXT, include_temporal_context: false })).not.toHaveProperty(
      'temporalContext'
    );
  });

  it('get_concept_evolution: no dates or grouping by default; each one changes the result', async () => {
    const defaults = await body('logseq_get_concept_evolution', { concept_name: 'Alice' });
    expect(defaults.summary.totalMentions).toBe(2);
    expect(defaults).not.toHaveProperty('groupedTimeline');
    const later = await body('logseq_get_concept_evolution', { concept_name: 'Alice', start_date: 20250201 });
    expect(later.summary.totalMentions).toBe(1);
    const earlier = await body('logseq_get_concept_evolution', { concept_name: 'Alice', end_date: 20250131 });
    expect(earlier.summary.totalMentions).toBe(1);
    const monthly = await body('logseq_get_concept_evolution', { concept_name: 'Alice', group_by: 'month' });
    expect(Object.keys(monthly.groupedTimeline).sort()).toEqual(['202501', '202502']);
  });

  it('list_pages: no filter by default; name_contains filters', async () => {
    expect((await body('logseq_list_pages', {})).pages).toEqual(['Alice', 'Bob']);
    expect((await body('logseq_list_pages', { name_contains: 'BO' })).pages).toEqual(['Bob']);
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
  ['logseq_build_context', 'topic_name', { topic_name: 'Alice' }],
  ['logseq_get_concept_evolution', 'concept_name', { concept_name: 'Alice' }],
  ['logseq_get_page_outline', 'page_name', { page_name: 'Alice' }],
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
    [NaN, 'NaN'],
    [{ name: 'alice' }, 'an object'],
  ])('rejects %j', async (value, kind) => {
    expect(await rejection(tool, { ...valid, [required]: value })).toMatch(
      new RegExp(`'${required}'.*a string, not ${kind}`, 's')
    );
  });
});

/** Optional parameters of the wrong type: [tool, valid arguments, parameter, value, expected error]. */
const CONTEXT = { topic_name: 'Alice' };
const EVOLUTION = { concept_name: 'Alice' };
const BAD_OPTIONS: ReadonlyArray<readonly [string, Record<string, unknown>, string, unknown, RegExp]> = [
  ['logseq_build_context', CONTEXT, 'max_blocks', '5', /'max_blocks': "5".*a number, not a string.*Example: max_blocks: 5/s],
  ['logseq_build_context', CONTEXT, 'max_blocks', NaN, /'max_blocks': NaN.*a number, not NaN/s],
  ['logseq_build_context', CONTEXT, 'max_blocks', Infinity, /'max_blocks': Infinity.*a number, not Infinity/s],
  ['logseq_build_context', CONTEXT, 'max_blocks', true, /'max_blocks': true.*a number, not a boolean/s],
  ['logseq_build_context', CONTEXT, 'max_related_pages', '10', /'max_related_pages': "10".*a number, not a string/s],
  ['logseq_build_context', CONTEXT, 'max_related_pages', NaN, /'max_related_pages': NaN.*a number, not NaN/s],
  ['logseq_build_context', CONTEXT, 'max_references', '20', /'max_references': "20".*a number, not a string/s],
  ['logseq_build_context', CONTEXT, 'max_references', -Infinity, /'max_references': -Infinity/],
  ['logseq_build_context', CONTEXT, 'include_temporal_context', 'no', /'include_temporal_context': "no".*true or false, not a string/s],
  ['logseq_build_context', CONTEXT, 'include_temporal_context', 0, /'include_temporal_context': 0.*true or false, not a number/s],
  ['logseq_build_context', CONTEXT, 'resolve_refs', 'yes', /'resolve_refs': "yes".*true or false, not a string/s],
  ['logseq_build_context', CONTEXT, 'format', 'html', /'format': "html".*one of "json", "markdown".*Example: format: "markdown"/s],
  ['logseq_build_context', CONTEXT, 'format', 0, /'format': 0.*one of/s],
  ['logseq_build_context', CONTEXT, 'format', 'Markdown', /'format': "Markdown".*one of/s],
  ['logseq_build_context', CONTEXT, 'format', '', /'format': "".*one of/s],
  ['logseq_build_context', CONTEXT, 'compact', 'true', /'compact': "true".*true or false, not a string/s],
  ['logseq_build_context', CONTEXT, 'compact', 'yes', /'compact': "yes".*true or false, not a string.*Example: compact: true/s],
  ['logseq_build_context', CONTEXT, 'compact', 1, /'compact': 1.*true or false, not a number/s],
  ['logseq_get_concept_evolution', EVOLUTION, 'start_date', '20250101', /'start_date': "20250101".*a number, not a string/s],
  ['logseq_get_concept_evolution', EVOLUTION, 'start_date', NaN, /'start_date': NaN.*a number, not NaN/s],
  ['logseq_get_concept_evolution', EVOLUTION, 'start_date', true, /'start_date': true.*a number, not a boolean/s],
  ['logseq_get_concept_evolution', EVOLUTION, 'end_date', '20250131', /'end_date': "20250131".*a number, not a string/s],
  ['logseq_get_concept_evolution', EVOLUTION, 'end_date', Infinity, /'end_date': Infinity.*a number, not Infinity/s],
  ['logseq_get_concept_evolution', EVOLUTION, 'group_by', 'year', /'group_by': "year".*one of "day", "week", "month".*Example: group_by: "month"/s],
  ['logseq_get_concept_evolution', EVOLUTION, 'group_by', 'Month', /'group_by': "Month".*one of/s],
  ['logseq_get_concept_evolution', EVOLUTION, 'group_by', '', /'group_by': "".*one of/s],
  ['logseq_get_concept_evolution', EVOLUTION, 'group_by', 1, /'group_by': 1.*one of/s],
  ['logseq_list_pages', {}, 'name_contains', 5, /'name_contains': 5.*a string, not a number.*Example: name_contains: "..."/s],
  ['logseq_list_pages', {}, 'name_contains', true, /'name_contains': true.*a string, not a boolean/s],
  ['logseq_list_pages', {}, 'name_contains', ['al'], /'name_contains'.*a string, not an array/s],
  ['logseq_list_pages', {}, 'name_contains', { text: 'al' }, /'name_contains'.*a string, not an object/s],
];

describe('wrong-typed options are rejected before calling LogSeq', () => {
  it.each(BAD_OPTIONS)('%s %j: %s = %j', async (tool, valid, param, value, message) => {
    expect(await rejection(tool, { ...valid, [param]: value })).toMatch(message);
  });
});

describe('aliases still fold in before parsing', () => {
  it.each([
    ['logseq_build_context', 'topic_name', 'page_name'],
    ['logseq_get_concept_evolution', 'concept_name', 'name'],
    ['logseq_get_page_outline', 'page_name', 'page'],
  ])(
    '%s: %s takes the %s alias, and a malformed alias value is rejected like the canonical one',
    async (tool, canonical, alias) => {
      await expectSame(tool, { [alias]: 'Alice' }, { [canonical]: 'Alice' });
      expect(await rejection(tool, { [alias]: 5 })).toMatch(new RegExp(`'${canonical}': 5.*a string, not a number`, 's'));
    }
  );
});

describe('null now reads as absent where it used to be a value (#60)', () => {
  it.each([
    ['max_blocks', 'directBlocks'],
    ['max_related_pages', 'relatedPages'],
    ['max_references', 'references'],
  ])('build_context %s: null uses the default (it used to keep none of %s)', async (param, field) => {
    await expectSame('logseq_build_context', { ...CONTEXT, [param]: null }, CONTEXT);
    expect((await body('logseq_build_context', { ...CONTEXT, [param]: null }))[field]).toHaveLength(2);
  });

  it('build_context include_temporal_context: null uses the default true (it used to drop the temporal context)', async () => {
    await expectSame('logseq_build_context', { ...CONTEXT, include_temporal_context: null }, CONTEXT);
    expect((await body('logseq_build_context', { ...CONTEXT, include_temporal_context: null })).temporalContext).toEqual({
      isJournal: false,
    });
  });
});

describe('tools without parameters ignore whatever they are sent', () => {
  it.each(['logseq_get_graph_info', 'logseq_get_current_context'])('%s', async tool => {
    await expectSame(tool, { page_name: 5, format: 'html', limit: null }, {});
  });
});

describe('values that pass the parser keep their old meaning', () => {
  it('build_context: a negative max_blocks still slices from the end (current, not endorsed)', async () => {
    const capped = await body('logseq_build_context', { ...CONTEXT, max_blocks: -1 });
    expect(capped.directBlocks).toHaveLength(1);
    expect(capped.hasMore).toBe(true);
  });

  it('build_context: a fractional max_blocks is cut down to a whole number of blocks', async () => {
    expect((await body('logseq_build_context', { ...CONTEXT, max_blocks: 1.5 })).directBlocks).toHaveLength(1);
  });

  it('list_pages: an empty name_contains is still no filter', async () => {
    await expectSame('logseq_list_pages', { name_contains: '' }, {});
  });

  it('get_concept_evolution: a start_date of 0 is still no bound', async () => {
    await expectSame('logseq_get_concept_evolution', { ...EVOLUTION, start_date: 0 }, EVOLUTION);
  });

  it('get_concept_evolution: a date that is not YYYYMMDD is still compared as given', async () => {
    expect((await body('logseq_get_concept_evolution', { ...EVOLUTION, start_date: 2025 })).summary.totalMentions).toBe(2);
    expect((await body('logseq_get_concept_evolution', { ...EVOLUTION, end_date: 2025 })).summary.totalMentions).toBe(0);
  });
});
