import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertOutPathSafe, claudeArgs, DEFAULT_MODEL, hostEnv, LIMITS, parseOptions, prepareHarness } from '../../scripts/lib/routing-eval-host.js';
import { parseSavedRun, reconcile, SAVED_RUN_VERSION, scoringHash, textHash } from '../../scripts/lib/routing-eval-saved.js';
import {
  aggregate,
  callType,
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
  type ToolType,
} from '../../scripts/lib/routing-eval.js';

/** The question file and the arithmetic behind scripts/routing-eval.ts (#487). The runner itself needs a model and an instance. */

const root = join(__dirname, '..', '..');
const questionsPath = join(root, 'tests', 'fixtures', 'routing-eval', 'questions.json');
const questions = parseQuestions(JSON.parse(readFileSync(questionsPath, 'utf8')));

describe('tests/fixtures/routing-eval/questions.json', () => {
  it('holds 33 to 40 questions, at least 3 of every type', () => {
    // 11 intents x 3, plus 3 for page-names (#514) and the boundary questions (#511)
    expect(questions.length).toBeGreaterThanOrEqual(33);
    expect(questions.length).toBeLessThanOrEqual(40);
    for (const type of TOOL_TYPES) {
      expect(questions.filter(question => question.expected_type === type).length, type).toBeGreaterThanOrEqual(3);
    }
  });

  it('holds at least 3 questions for every intent #487 lists', () => {
    // The minimum is per intent, not per type (#511). These are the 11 intents of #487's "Cover every type" list.
    const listed = [
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
    ];
    expect(listed).toHaveLength(11);
    for (const intent of listed) {
      expect(questions.filter(question => question.intent === intent).length, intent).toBeGreaterThanOrEqual(3);
    }
  });

  it('covers the intents beyond #487\'s list, each with one expected type so a report row can show it', () => {
    // The boundary intents are split by direction (#511 review), so a find miss and an explore hit don't pool into one row.
    const counts: Record<string, number> = { 'find-boundary': 1, 'explore-boundary': 2 };
    for (const [intent, count] of Object.entries(counts)) expect(questions.filter(question => question.intent === intent).length, intent).toBe(count);
    // page-names is outside #487's list of 11 but gets the same minimum (#514): a fuzzy name, an exact check across names, a property ask
    expect(questions.filter(question => question.intent === 'page-names').length, 'page-names').toBeGreaterThanOrEqual(3);
    for (const intent of new Set(questions.map(question => question.intent))) {
      expect(new Set(questions.filter(question => question.intent === intent).map(question => question.expected_type)).size, `${intent} mixes expected types`).toBe(1);
    }
  });

  it('keeps the ground-truth questions exactly as ADR-0037 settles them, each accepting one type only', () => {
    // The pin: widening a question's accepted types, changing its expected type, or dropping the mark fails here (#511).
    // find-boundary-1 is a list of hits (find). The two explore ones read like a find but ask what something is or how it connects.
    // The wording is pinned too: a reworded ground-truth question is a different question, so it takes an edit here and a new baseline run.
    const pinned: Record<string, { type: ToolType; intent: string; text: string }> = {
      'find-boundary-1': { type: 'find', intent: 'find-boundary', text: 'Where does project atlas come up in my notes?' },
      'explore-boundary-1': { type: 'explore', intent: 'explore-boundary', text: 'Where does Bob stand on project atlas?' },
      'explore-boundary-2': { type: 'explore', intent: 'explore-boundary', text: 'Where does project borealis stand, going by my notes?' },
    };
    const marked = questions.filter(question => question.ground_truth === true);
    expect(marked.map(question => question.id).sort()).toEqual(Object.keys(pinned).sort());
    for (const question of marked) {
      expect(question.expected_type, question.id).toBe(pinned[question.id].type);
      expect(question.question, question.id).toBe(pinned[question.id].text);
      expect(question.ground_truth_reason, question.id).toContain('ADR-0037');
      expect(question.intent, question.id).toBe(pinned[question.id].intent);
      for (const [surface, tools] of [['v1', question.v1_tools], ['v2', question.v2_tools]] as const) {
        for (const tool of tools) {
          // No tool of another type, and none typed by mode (search_by_relationship), so the accepted type is exactly one
          expect(SURFACE_TOOL_TYPES[surface][tool], `${question.id} ${tool}`).toBe(pinned[question.id].type);
          expect(tool, question.id).not.toBe('logseq_search_by_relationship');
        }
      }
    }
  });

  it('rejects a ground-truth question that widens its accepted types or leaves out its reason', () => {
    const base = { id: 'q', intent: 'i', expected_type: 'find', question: 'Q?', v1_tools: ['logseq_search_blocks'], v2_tools: ['logseq_find_blocks'], ground_truth: true, ground_truth_reason: 'ADR-0037' };
    const parse = (extra: Record<string, unknown>) => parseQuestions({ version: 1, questions: [{ ...base, ...extra }] });
    expect(() => parse({})).not.toThrow();
    expect(() => parse({ v1_tools: ['logseq_search_blocks', 'logseq_build_context'] })).toThrow('expects find');
    expect(() => parse({ v2_tools: ['logseq_explore_context'] })).toThrow('expects find');
    expect(() => parse({ ground_truth_reason: undefined })).toThrow('ground_truth_reason');
    expect(() => parse({ ground_truth: undefined })).toThrow('not marked ground_truth');
    expect(() => parse({ ground_truth: false })).toThrow('true or absent');
    // The mode-typed tool is explore work only in one mode, so an ordinary question may list it and a ground-truth one may not
    const explore = { ...base, expected_type: 'explore', v1_tools: ['logseq_search_by_relationship'], v2_tools: ['logseq_explore_network'] };
    expect(() => parseQuestions({ version: 1, questions: [{ ...explore, ground_truth: undefined, ground_truth_reason: undefined }] })).not.toThrow();
    expect(() => parseQuestions({ version: 1, questions: [explore] })).toThrow('expects explore');
  });

  it('asks in the user\'s words, never with a tool\'s own verb', () => {
    // A question that says "search", "find", "open" or "check" hands the model the tool name (#504 review)
    const verbs = /\b(search|searches|find|finds|open|opens|fetch|fetches|verify|verifies|check|checks|get|gets|list|lists|read|query|queries|look up|lookup)\b/i;
    for (const question of questions) expect(question.question.match(verbs)?.[0], question.id).toBeUndefined();
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

describe('the tool-type maps against ADR-0037', () => {
  // The surface table: | type | `logseq_tool` | takes | replaces |
  const adr = readFileSync(join(root, 'docs', 'adr', '0037-tool-taxonomy-get-find-explore-check.md'), 'utf8');
  const rows = adr
    .split('\n')
    .filter(line => /^\| (get|find|explore|check) \| `logseq_[a-z_]+` \|/.test(line))
    .map(line => {
      const cells = line.split(' | ').map(cell => cell.replace(/^\||\|$/g, '').trim());
      return { type: cells[0] as ToolType, tool: cells[1].replace(/`/g, ''), replaces: [...cells[cells.length - 1].matchAll(/`([a-z_]+)`/g)].map(match => match[1]) };
    });

  it('finds the ten v2 rows', () => {
    expect(rows.map(row => row.tool).sort()).toEqual(Object.keys(SURFACE_TOOL_TYPES.v2).sort());
  });

  it('gives each v2 tool the type of its row', () => {
    for (const row of rows) expect(SURFACE_TOOL_TYPES.v2[row.tool], row.tool).toBe(row.type);
  });

  it('gives each v1 tool the type of the tool that replaces it, but for search_by_relationship, which splits by mode', () => {
    const replacedBy = new Map<string, ToolType[]>();
    for (const row of rows) {
      for (const name of row.replaces) {
        const v1 = `logseq_${name}`;
        if (SURFACE_TOOL_TYPES.v1[v1] !== undefined) replacedBy.set(v1, [...(replacedBy.get(v1) ?? []), row.type]);
      }
    }
    // Every v1 tool is named in some row, and the row's type is its type
    expect([...replacedBy.keys()].sort()).toEqual(Object.keys(SURFACE_TOOL_TYPES.v1).sort());
    for (const [v1, types] of replacedBy) {
      if (v1 === 'logseq_search_by_relationship') {
        // The `references` mode goes to find_blocks and `connected-within` to explore_network (callType types the call by mode)
        expect(new Set(types), v1).toEqual(new Set<ToolType>(['find', 'explore']));
      } else {
        expect(types, v1).toEqual([SURFACE_TOOL_TYPES.v1[v1]]);
      }
    }
  });
});

describe('the runner stays on the fixture', () => {
  const runner = readFileSync(join(root, 'scripts', 'routing-eval.ts'), 'utf8');
  const main = runner.slice(runner.indexOf('async function main'));

  it('refuses a personal or non-fixture graph before it builds the harness or starts a session', () => {
    const order = ['resolveFixtureConfigPath(', 'assertNotPersonalLogseq(config.apiUrl)', 'requireFixtureGraph(', 'prepareHarness(', 'runSession('].map(token => main.indexOf(token));
    expect(order.every(index => index >= 0), `all five calls in main: ${order}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('has no fallback to the personal config', () => {
    expect(runner).not.toMatch(/resolveConfigPath\b/);
    expect(runner).not.toContain("'.logseq-mcp'");
    expect(runner).not.toContain('logseq-mcp/config.json');
  });

  it('checks --out before any session starts', () => {
    expect(main.indexOf('assertOutPathSafe(')).toBeGreaterThanOrEqual(0);
    expect(main.indexOf('assertOutPathSafe(')).toBeLessThan(main.indexOf('runSession('));
  });
});

describe('the options and the host (scripts/lib/routing-eval-host.ts)', () => {
  it('pins the default model id, not a floating alias', () => {
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5-5');
    expect(parseOptions([]).model).toBe(DEFAULT_MODEL);
    expect(parseOptions(['--model', 'x']).model).toBe('x');
  });

  it('bounds the run: every option has a maximum, and the total spend has a small default', () => {
    expect(parseOptions([])).toMatchObject({ runs: 3, concurrency: 2, maxCalls: 6, maxBudgetUsd: 0.15, maxTotalUsd: 3 });
    const limits: Array<[string, number]> = [
      ['--runs', LIMITS.runs],
      ['--concurrency', LIMITS.concurrency],
      ['--timeout-ms', LIMITS.timeoutMs],
      ['--max-calls', LIMITS.maxCalls],
      ['--max-budget-usd', LIMITS.maxBudgetUsd],
      ['--max-total-usd', LIMITS.maxTotalUsd],
    ];
    for (const [flag, max] of limits) {
      expect(() => parseOptions([flag, String(max)]), `${flag} at its maximum`).not.toThrow();
      expect(() => parseOptions([flag, String(max + 1)]), `${flag} past its maximum`).toThrow(flag);
      expect(() => parseOptions([flag, '0']), `${flag} at zero`).toThrow(flag);
      expect(() => parseOptions([flag, 'abc']), `${flag} not a number`).toThrow(flag);
      expect(() => parseOptions([flag]), `${flag} with no value`).toThrow('needs a value');
    }
    expect(() => parseOptions(['--runs', '1.5'])).toThrow('whole number');
    expect(() => parseOptions(['--surface', 'v3'])).toThrow('v1 or v2');
    expect(() => parseOptions(['--nope'])).toThrow('Unknown option');
  });

  it('starts every session with no built-in tool, no other server, no settings and no saved session', () => {
    const args = claudeArgs({ model: 'm', maxBudgetUsd: 0.1 }, '/tmp/mcp.json');
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after('--tools')).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--no-session-persistence');
    expect(after('--setting-sources')).toBe('');
    expect(after('--mcp-config')).toBe('/tmp/mcp.json');
    expect(after('--allowedTools')).toBe('mcp__logseq');
    expect(after('--permission-mode')).toBe('dontAsk');
    expect(after('--max-budget-usd')).toBe('0.1');
    expect(after('--model')).toBe('m');
  });

  it('gives the host no personal server config, and turns CLAUDE.md files and memory off', () => {
    const env = hostEnv({ LOGSEQ_MCP_CONFIG: '/home/me/.logseq-mcp/config.json', LOGSEQ_MCP_TIPS: 'off', LOGSEQ_MCP_NOW: '1', PATH: '/bin' });
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });

  it('writes the server config and the MCP config as 0600 files with a home of their own', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'routing-eval-test-'));
    try {
      const harness = await prepareHarness({ apiUrl: 'http://127.0.0.1:12399', authToken: 'fixture-token' }, '/bin/server', parent, 'darwin');
      for (const path of [harness.serverConfigPath, harness.mcpConfigPath]) expect((await stat(path)).mode & 0o777, path).toBe(0o600);
      const mcp = JSON.parse(await readFile(harness.mcpConfigPath, 'utf8')) as { mcpServers: Record<string, { command: string; env: Record<string, string> }> };
      const server = mcp.mcpServers.logseq;
      expect(server.command).toBe('/bin/server');
      expect(server.env.LOGSEQ_MCP_CONFIG).toBe(harness.serverConfigPath);
      expect(server.env.HOME).not.toBe(process.env.HOME);
      expect(server.env.HOME).toContain(harness.dir);
      expect(server.env.CFFIXED_USER_HOME).toBe(server.env.HOME);
      expect(JSON.parse(await readFile(harness.serverConfigPath, 'utf8'))).toEqual({ apiUrl: 'http://127.0.0.1:12399', authToken: 'fixture-token' });
      expect(harness.cwd.startsWith(harness.dir)).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('refuses an --out path inside the repo that git does not ignore', () => {
    const repo = '/repo';
    const none = () => false;
    expect(() => assertOutPathSafe('/repo/routing.json', repo, none)).toThrow('git does not ignore it');
    expect(() => assertOutPathSafe('/repo/sub/dir/out.json', repo, none)).toThrow('inside the repo');
    expect(() => assertOutPathSafe('/repo/.logseq-instance/x.json', repo, path => path.includes('.logseq-instance'))).not.toThrow();
    expect(() => assertOutPathSafe('/tmp/outside.json', repo, none)).not.toThrow();
    expect(() => assertOutPathSafe('/repo-sibling/out.json', repo, none)).not.toThrow();
  });

  // The patterns that make a path under .logseq-instance/ or named routing-eval-*.json safe are held by
  // tests/guards/repo-hygiene.test.ts (RAW_OUTPUT_RULES).
});

describe('the saved run (scripts/lib/routing-eval-saved.ts)', () => {
  const sample = questions.slice(0, 3);
  const session = (questionId: string, extra: Record<string, unknown> = {}) => ({ questionId, run: 1, status: 'ok', calls: [], ...extra });
  const saved = (sessions: unknown[], extra: Record<string, unknown> = {}) => ({
    version: SAVED_RUN_VERSION,
    surface: 'v1',
    models: ['m'],
    textHash: textHash(questions),
    scoringHash: scoringHash(questions),
    planned: sessions.length,
    stoppedEarly: false,
    sessions,
    ...extra,
  });

  it('hashes the question texts and the scoring apart', () => {
    const changedList = questions.map((question, i) => (i === 0 ? { ...question, v1_tools: [...question.v1_tools, 'logseq_list_pages'] } : question));
    const changedText = questions.map((question, i) => (i === 0 ? { ...question, question: question.question + ' Please.' } : question));
    expect(scoringHash(changedList)).not.toBe(scoringHash(questions));
    expect(textHash(changedList)).toBe(textHash(questions));
    expect(textHash(changedText)).not.toBe(textHash(questions));
    expect(scoringHash(changedText)).toBe(scoringHash(questions));
    expect(scoringHash([...questions].reverse())).toBe(scoringHash(questions));
  });

  it('parses a file at the boundary instead of casting it', () => {
    expect(parseSavedRun(saved([session('a', { costUsd: 0.5 })])).sessions).toHaveLength(1);
    expect(() => parseSavedRun(null)).toThrow('not an object');
    expect(() => parseSavedRun(saved([], { version: 1 }))).toThrow('version');
    expect(() => parseSavedRun(saved([], { surface: 'v3' }))).toThrow('surface');
    expect(() => parseSavedRun(saved([], { textHash: undefined }))).toThrow('hashes');
    expect(() => parseSavedRun(saved([], { planned: -1 }))).toThrow('planned');
    expect(() => parseSavedRun(saved([], { stoppedEarly: 'no' }))).toThrow('stoppedEarly');
    expect(() => parseSavedRun(saved([{ questionId: 'a', run: 1, status: 'ok' }]))).toThrow('calls');
    expect(() => parseSavedRun(saved([session('a', { status: 'weird' })]))).toThrow('status');
    expect(() => parseSavedRun(saved([session('a', { run: 0 })]))).toThrow('run');
    expect(() => parseSavedRun(saved([session('a', { calls: [{ tool: 'x' }] })]))).toThrow('isError');
    expect(() => parseSavedRun(saved([session('a', { costUsd: 'free' })]))).toThrow('cost');
  });

  it('reconciles a run with the questions: strays fail, missing sessions are named, a list change is flagged', () => {
    const ids = sample.map(question => question.id);
    const full = parseSavedRun(saved(ids.map(id => session(id))));
    const ok = reconcile(full, sample, questions, true);
    expect(ok.unanswered).toEqual([]);
    expect(ok.scoringChanged).toBe(false);

    const partial = parseSavedRun(saved([session(ids[0])]));
    expect(reconcile(partial, sample, questions, true).unanswered).toEqual([ids[1], ids[2]]);

    const stray = parseSavedRun(saved([session(ids[0]), session('gone')]));
    expect(() => reconcile(stray, questions, questions, false)).toThrow('gone');
    // --only narrows both sides on purpose
    expect(reconcile(stray, sample, questions, true).sessions).toHaveLength(1);

    const loosened = questions.map((question, i) => (i === 0 ? { ...question, v1_tools: [...question.v1_tools, 'logseq_list_pages'] } : question));
    expect(reconcile(full, sample, loosened, true).scoringChanged).toBe(true);

    const reworded = questions.map((question, i) => (i === 0 ? { ...question, question: 'Something else?' } : question));
    expect(() => reconcile(full, sample, reworded, true)).toThrow('texts or ids changed');
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

  it('types search_by_relationship by its mode: connected-within is explore work, the others find blocks', () => {
    expect(callType('logseq_search_by_relationship', { topic_a: 'a', topic_b: 'b', relationship_type: 'connected-within' })).toBe('explore');
    expect(callType('logseq_search_by_relationship', { topic_a: 'a', topic_b: 'b', relationship_type: 'references' })).toBe('find');
    expect(callType('logseq_search_by_relationship', null)).toBe('find');
    expect(callType('logseq_get_page', { relationship_type: 'connected-within' })).toBe('get');
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

  it('scores a connected-within call as explore, so it answers a how-do-they-connect question', () => {
    const connect: Question[] = [
      { id: 'c', intent: 'connect', expected_type: 'explore', question: 'Q', v1_tools: ['logseq_get_concept_network', 'logseq_search_by_relationship'], v2_tools: ['logseq_explore_network'] },
    ];
    const within = { tool: 'logseq_search_by_relationship', arguments: { relationship_type: 'connected-within' }, isError: false, schemaError: false };
    const references = { ...within, arguments: { relationship_type: 'references' } };
    const result = aggregate('v1', connect, [
      { questionId: 'c', run: 1, status: 'ok', calls: [within] },
      { questionId: 'c', run: 2, status: 'ok', calls: [references] },
    ]);
    expect(result.typeCorrect).toEqual({ count: 1, of: 2 });
    expect(result.toolCorrect).toEqual({ count: 1, of: 2 });
  });

  it('refuses a session of a question it does not know', () => {
    expect(() => aggregate('v1', sample, [{ questionId: 'zzz', run: 1, status: 'ok', calls: [] }])).toThrow('zzz');
  });
});
