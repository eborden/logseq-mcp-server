import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aggregate,
  detectSurface,
  isSchemaError,
  logseqToolName,
  parseQuestions,
  SessionTrace,
  SURFACE_TOOL_TYPES,
  TOOL_TYPES,
  toolType,
  type Question,
  type SessionRecord,
} from '../../scripts/lib/routing-eval.js';

/** The question file and the arithmetic behind scripts/routing-eval.ts (#487). The runner itself needs a model and an instance. */

const root = join(__dirname, '..', '..');
const questionsPath = join(root, 'tests', 'fixtures', 'routing-eval', 'questions.json');
const questions = parseQuestions(JSON.parse(readFileSync(questionsPath, 'utf8')));

describe('tests/fixtures/routing-eval/questions.json', () => {
  it('holds 24 to 30 questions, at least 3 of every type', () => {
    expect(questions.length).toBeGreaterThanOrEqual(24);
    expect(questions.length).toBeLessThanOrEqual(30);
    for (const type of TOOL_TYPES) {
      expect(questions.filter(question => question.expected_type === type).length, type).toBeGreaterThanOrEqual(3);
    }
  });

  it('covers each kind of question the issue lists', () => {
    const intents = new Set(questions.map(question => question.intent));
    for (const intent of [
      'page-by-name',
      'block-by-uuid',
      'this-page',
      'keyword',
      'property-value',
      'blocks-linking-two-pages',
      'topic',
      'how-two-pages-connect',
      'change-over-time',
      'what-happened-in-a-period',
      'proposed-link-pass',
    ]) {
      expect(intents.has(intent), intent).toBe(true);
    }
  });

  it('names a block uuid only when the fixture graph holds it', () => {
    const files = ['pages', 'journals'].flatMap(dir =>
      readdirSync(join(root, 'tests', 'fixtures', 'graph', dir)).map(name => readFileSync(join(root, 'tests', 'fixtures', 'graph', dir, name), 'utf8'))
    );
    const graph = files.join('\n');
    for (const question of questions) {
      for (const uuid of question.question.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []) {
        // The check-links questions quote a uuid inside a ref; it still has to be a fixture block
        expect(graph.includes(uuid), `${question.id}: ${uuid}`).toBe(true);
      }
    }
  });

  it('lists, for each question, tools of its own type on both surfaces', () => {
    // parseQuestions throws for a tool that is not on the surface or has another type; this pins that it does
    const base = { id: 'q', intent: 'i', expected_type: 'get', question: 'Q?', v1_tools: ['logseq_get_page'], v2_tools: ['logseq_get_page'] };
    expect(() => parseQuestions({ version: 1, questions: [base] })).not.toThrow();
    expect(() => parseQuestions({ version: 1, questions: [{ ...base, v1_tools: ['logseq_search_blocks'] }] })).toThrow('expects get');
    expect(() => parseQuestions({ version: 1, questions: [{ ...base, v2_tools: ['logseq_get_page_outline'] }] })).toThrow('not a v2 tool');
    expect(() => parseQuestions({ version: 1, questions: [base, base] })).toThrow('used twice');
    expect(() => parseQuestions({ version: 1, questions: [{ ...base, expected_type: 'read' }] })).toThrow('expected_type');
  });

  it('knows the type of every tool the recorded tool list holds', () => {
    // The recorded list moves from the v1 names to the v2 ones, one rename per PR (#500); either way the eval knows each
    const recorded = JSON.parse(readFileSync(join(root, 'rust', 'tests', 'data', 'parity', 'tool-list.json'), 'utf8')) as Array<{ name: string }>;
    expect(recorded.length).toBeGreaterThan(0);
    for (const { name } of recorded) expect(toolType(name), name).toBeDefined();
  });
});

describe('the runner stays on the fixture', () => {
  const runner = readFileSync(join(root, 'scripts', 'routing-eval.ts'), 'utf8');

  it('resolves its config like the integration tests and refuses the personal port', () => {
    expect(runner).toContain('resolveFixtureConfigPath()');
    expect(runner).toContain('assertNotPersonalLogseq(config.apiUrl)');
    expect(runner).toContain('requireFixtureGraph(');
    // No fallback to the personal config: it would be a path string or a default-config helper
    expect(runner).not.toMatch(/resolveConfigPath\b/);
    expect(runner).not.toContain("'.logseq-mcp'");
  });
});

describe('tool types', () => {
  it('knows the 16 v1 tools and the 10 v2 tools', () => {
    expect(Object.keys(SURFACE_TOOL_TYPES.v1)).toHaveLength(16);
    expect(Object.keys(SURFACE_TOOL_TYPES.v2)).toHaveLength(10);
    expect(Object.keys(SURFACE_TOOL_TYPES.v2).every(name => /^logseq_(get|find|explore|check)_/.test(name))).toBe(true);
    expect(toolType('logseq_query_by_date_range')).toBe('explore');
    expect(toolType('logseq_find_blocks')).toBe('find');
    expect(toolType('logseq_nope')).toBeUndefined();
  });

  it('reads the surface from the marker tools, and asks for a flag on a mix', () => {
    expect(detectSurface(['logseq_search_blocks', 'logseq_get_page'])).toBe('v1');
    expect(detectSurface(['logseq_find_blocks', 'logseq_get_page'])).toBe('v2');
    expect(() => detectSurface(['logseq_get_page'])).toThrow('--surface');
  });

  it('strips the MCP prefix and ignores other servers', () => {
    expect(logseqToolName('mcp__logseq__logseq_get_page')).toBe('logseq_get_page');
    expect(logseqToolName('mcp__other__x')).toBeUndefined();
    expect(logseqToolName('Bash')).toBeUndefined();
  });
});

function line(value: unknown): string {
  return JSON.stringify(value);
}

describe('SessionTrace', () => {
  const init = line({ type: 'system', subtype: 'init', model: 'claude-test-1', tools: ['mcp__logseq__logseq_search_blocks', 'Bash'] });

  it('keeps the logseq calls with their arguments, and only whether a result was a schema error', () => {
    const trace = new SessionTrace();
    for (const event of [
      init,
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'a', name: 'mcp__logseq__logseq_get_page', input: { topic_name: 'x' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: [{ type: 'text', text: "Invalid parameter 'page_name': missing\n\nExpected: string" }] }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'mcp__logseq__logseq_search_blocks', input: { query: 'importer' } }, { type: 'tool_use', id: 'c', name: 'Read', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'SECRET RESULT TEXT' }] } }),
      line({ type: 'result', is_error: false, total_cost_usd: 0.0123 }),
      'not json',
      '',
    ]) {
      trace.feed(event);
    }
    expect(trace.model).toBe('claude-test-1');
    expect(trace.toolNames).toEqual(['logseq_search_blocks']);
    expect(trace.calls).toEqual([
      { tool: 'logseq_get_page', arguments: { topic_name: 'x' }, isError: true, schemaError: true },
      { tool: 'logseq_search_blocks', arguments: { query: 'importer' }, isError: false, schemaError: false },
    ]);
    expect(JSON.stringify(trace)).not.toContain('SECRET RESULT TEXT');
    expect(trace.costUsd).toBe(0.0123);
    expect(trace.resultIsError).toBe(false);
  });

  it('does not count a failed lookup as a schema error', () => {
    expect(isSchemaError("Invalid parameter 'page_name': missing")).toBe(true);
    expect(isSchemaError('InputValidationError: bad')).toBe(true);
    expect(isSchemaError('No page "x". Closest: y.')).toBe(false);
    expect(isSchemaError('LogSeq API error: Invalid parameter in the middle')).toBe(false);
  });
});

describe('aggregate', () => {
  const sample: Question[] = [
    { id: 'g', intent: 'page', expected_type: 'get', question: 'Q', v1_tools: ['logseq_get_page'], v2_tools: ['logseq_get_page'] },
    { id: 'f', intent: 'keyword', expected_type: 'find', question: 'Q', v1_tools: ['logseq_search_blocks'], v2_tools: ['logseq_find_blocks'] },
  ];
  const call = (tool: string, schemaError = false) => ({ tool, arguments: {}, isError: schemaError, schemaError });

  it('scores the first call by type and by tool, and counts a session with no call as wrong in both', () => {
    const records: SessionRecord[] = [
      { questionId: 'g', run: 1, status: 'ok', calls: [call('logseq_get_page')], costUsd: 0.1 },
      { questionId: 'g', run: 2, status: 'ok', calls: [call('logseq_get_page_outline'), call('logseq_get_page')], costUsd: 0.3 },
      { questionId: 'f', run: 1, status: 'ok', calls: [call('logseq_build_context', true), call('logseq_search_blocks')] },
      { questionId: 'f', run: 2, status: 'ok', calls: [] },
      { questionId: 'f', run: 3, status: 'failed', calls: [] },
    ];
    const result = aggregate('v1', sample, records);
    expect(result.sessions).toBe(4);
    expect(result.failed).toBe(1);
    expect(result.typeCorrect).toEqual({ count: 2, of: 4 });
    expect(result.toolCorrect).toEqual({ count: 1, of: 4 });
    expect(result.noCall).toEqual({ count: 1, of: 4 });
    expect(result.schemaErrors).toEqual({ calls: 1, sessions: 1 });
    expect(result.callsPerSession).toEqual({ mean: 1.25, max: 2 });
    expect(result.confusion).toEqual({ get: { get: 2 }, find: { explore: 1, none: 1 } });
    expect(result.byIntent.find(entry => entry.intent === 'keyword')?.typeCorrect).toEqual({ count: 0, of: 2 });
    expect(result.costUsd?.total).toBeCloseTo(0.4, 10);
    expect(result.costUsd?.perSession).toBeCloseTo(0.2, 10);
  });

  it('scores a v2 session against the v2 tools', () => {
    const records: SessionRecord[] = [{ questionId: 'f', run: 1, status: 'ok', calls: [call('logseq_find_blocks')] }];
    expect(aggregate('v2', sample, records).toolCorrect).toEqual({ count: 1, of: 1 });
    expect(aggregate('v1', sample, records).toolCorrect).toEqual({ count: 0, of: 1 });
    expect(aggregate('v1', sample, records).typeCorrect).toEqual({ count: 1, of: 1 });
  });

  it('refuses a session of a question it does not know', () => {
    expect(() => aggregate('v1', sample, [{ questionId: 'zzz', run: 1, status: 'ok', calls: [] }])).toThrow('zzz');
  });
});
