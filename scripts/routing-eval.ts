/**
 * Routing eval (#487): does the model pick the right kind of tool for a question?
 *
 * Usage:
 *   npx tsx scripts/logseq-instance.ts start
 *   npx tsx scripts/routing-eval.ts [--runs 3] [--model sonnet] [--only get,find-keyword-1] [--out <file>]
 *   npx tsx scripts/logseq-instance.ts stop
 *   npx tsx scripts/routing-eval.ts --dry-run     # checks the question file and prints the plan; calls no model
 *
 * Each question in tests/fixtures/routing-eval/questions.json is put N times to a headless Claude Code session
 * (`claude -p`) that has only this repo's server attached, on this worktree's fixture instance. The script records
 * the first `logseq_*` call of each session and the arguments the model sent, and prints aggregates: how often the
 * first call was the right type (get, find, explore, check), the right tool, no call at all, schema errors, and calls
 * per question. It never prints what a tool returned.
 *
 * It costs tokens: one session per question and run, each bounded by --max-calls, --timeout-ms and
 * --max-budget-usd. It stays local like the integration suite (tests/integration/setup.md, "Routing eval").
 *
 * It never contacts the personal LogSeq: the config is LOGSEQ_MCP_CONFIG or this worktree's
 * .logseq-instance/config.json, a config on port 12315 is refused before any network call, and the graph must be
 * the fixture (#90). Raw output of a real run stays out of the repo and off GitHub beyond the aggregates (BR-0001).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { loadConfig, LogseqClient } from './lib/logseq-api.js';
import { RUST_BINARY_ENV, requireRustBinary, rustBinaryPath } from './lib/rust-binary.js';
import {
  aggregate,
  detectSurface,
  MCP_TOOL_PREFIX,
  parseQuestions,
  percent,
  SessionTrace,
  TOOL_TYPES,
  type Aggregates,
  type Question,
  type SessionRecord,
  type SessionStatus,
  type Surface,
} from './lib/routing-eval.js';
import { requireFixtureGraph } from '../tests/integration/helpers/fixture-graph.js';
import { assertNotPersonalLogseq, resolveFixtureConfigPath } from '../tests/integration/helpers/instance-config.js';

const QUESTIONS_PATH = new URL('../tests/fixtures/routing-eval/questions.json', import.meta.url);

interface Options {
  runs: number;
  model: string;
  only: string[];
  out: string | undefined;
  questions: URL | string;
  concurrency: number;
  timeoutMs: number;
  maxCalls: number;
  maxBudgetUsd: number;
  surface: Surface | undefined;
  dryRun: boolean;
}

const USAGE = `Usage: npx tsx scripts/routing-eval.ts [options]
  --runs <n>             sessions per question (default 3)
  --model <id|alias>     the model of every session (default sonnet); the id the host reports is printed
  --only <list>          comma-separated question ids or types (get, find, explore, check)
  --out <file>           write each session's calls and arguments as JSON (local only: never commit or post it)
  --questions <file>     another question file (default tests/fixtures/routing-eval/questions.json)
  --concurrency <n>      sessions at a time (default 2)
  --timeout-ms <ms>      per session (default 120000)
  --max-calls <n>        stop a session after n logseq calls (default 6)
  --max-budget-usd <x>   per session, passed to claude (default 0.5)
  --surface v1|v2        which acceptable-tool list to score against (default: read from the server's tool list)
  --binary <path>        the server binary (default: ${RUST_BINARY_ENV}, else rust/target/debug/logseq-mcp-server)
  --dry-run              check the question file and print the plan; start nothing`;

function positiveInt(flag: string, value: string | undefined, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${flag} must be a whole number from 1 to ${max} (got ${JSON.stringify(value)})`);
  return parsed;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    runs: 3,
    model: 'sonnet',
    only: [],
    out: undefined,
    questions: QUESTIONS_PATH,
    concurrency: 2,
    timeoutMs: 120_000,
    maxCalls: 6,
    maxBudgetUsd: 0.5,
    surface: undefined,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value\n${USAGE}`);
      return next;
    };
    switch (flag) {
      case '--runs':
        options.runs = positiveInt(flag, value(), 20);
        break;
      case '--model':
        options.model = value();
        break;
      case '--only':
        options.only = value().split(',').map(part => part.trim()).filter(Boolean);
        break;
      case '--out':
        options.out = value();
        break;
      case '--questions':
        options.questions = value();
        break;
      case '--concurrency':
        options.concurrency = positiveInt(flag, value(), 4);
        break;
      case '--timeout-ms':
        options.timeoutMs = positiveInt(flag, value(), 900_000);
        break;
      case '--max-calls':
        options.maxCalls = positiveInt(flag, value(), 30);
        break;
      case '--max-budget-usd': {
        const budget = Number(value());
        if (!Number.isFinite(budget) || budget <= 0 || budget > 10) throw new Error('--max-budget-usd must be a number above 0 and at most 10');
        options.maxBudgetUsd = budget;
        break;
      }
      case '--surface': {
        const surface = value();
        if (surface !== 'v1' && surface !== 'v2') throw new Error('--surface must be v1 or v2');
        options.surface = surface;
        break;
      }
      case '--binary':
        process.env[RUST_BINARY_ENV] = value();
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option ${flag}\n${USAGE}`);
    }
  }
  return options;
}

async function loadQuestions(source: URL | string, only: readonly string[]): Promise<Question[]> {
  const all = parseQuestions(JSON.parse(await readFile(source, 'utf8')));
  if (only.length === 0) return all;
  const known = new Set<string>([...all.map(question => question.id), ...TOOL_TYPES]);
  const unknown = only.filter(name => !known.has(name));
  if (unknown.length > 0) throw new Error(`--only names no question id or type: ${unknown.join(', ')}`);
  const picked = all.filter(question => only.includes(question.id) || only.includes(question.expected_type));
  return picked;
}

interface Harness {
  dir: string;
  mcpConfigPath: string;
  cwd: string;
  /** The model host's environment: the caller's, without the server settings, and with memory and CLAUDE.md files off */
  env: Record<string, string>;
}

/**
 * The temp files of a run. The server gets a config of its own, which holds the fixture instance's token (random per
 * `start`), in a 0600 file deleted at the end, and a home directory of its own, so it has no `~/.logseq-mcp/config.json`
 * to fall back on (BR-0001). The host runs from an empty directory so no project file reaches the model.
 */
async function prepareHarness(config: { apiUrl: string; authToken: string }): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'logseq-routing-eval-'));
  const home = join(dir, 'server-home');
  const cwd = join(dir, 'cwd');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const serverConfigPath = join(dir, 'server-config.json');
  await writeFile(serverConfigPath, JSON.stringify({ apiUrl: config.apiUrl, authToken: config.authToken }), { mode: 0o600 });
  const mcpConfigPath = join(dir, 'mcp.json');
  const serverEnv: Record<string, string> = {
    LOGSEQ_MCP_CONFIG: serverConfigPath,
    LOGSEQ_MCP_TIPS: 'on',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
  };
  if (process.platform === 'darwin') serverEnv.CFFIXED_USER_HOME = home;
  await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { logseq: { command: rustBinaryPath(), args: [], env: serverEnv } } }), { mode: 0o600 });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.LOGSEQ_MCP_CONFIG;
  delete env.LOGSEQ_MCP_TIPS;
  delete env.LOGSEQ_MCP_NOW;
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return { dir, mcpConfigPath, cwd, env };
}

interface SessionResult {
  record: SessionRecord;
  model: string | undefined;
  toolNames: string[];
  failure?: string;
}

const children = new Set<ChildProcess>();

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** One headless session: the question on stdin, the stream-json events on stdout. */
function runSession(question: Question, run: number, options: Options, harness: Harness): Promise<SessionResult> {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', options.model,
    '--mcp-config', harness.mcpConfigPath,
    '--strict-mcp-config',
    // Only this server's tools: no built-in tool, skill, user setting or plugin to answer or to steer with
    '--tools', '',
    '--disable-slash-commands',
    '--setting-sources', '',
    '--no-session-persistence',
    '--allowedTools', MCP_TOOL_PREFIX.replace(/__$/, ''),
    '--permission-mode', 'dontAsk',
    '--max-budget-usd', String(options.maxBudgetUsd),
  ];
  return new Promise(resolve => {
    const trace = new SessionTrace();
    const child = spawn('claude', args, { cwd: harness.cwd, env: harness.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    children.add(child);
    let stderr = '';
    let stopped: SessionStatus | undefined;
    const stop = (status: SessionStatus): void => {
      if (stopped) return;
      stopped = status;
      killGroup(child, 'SIGTERM');
      setTimeout(() => killGroup(child, 'SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    child.stderr.on('data', chunk => {
      if (stderr.length < 2000) stderr += String(chunk);
    });
    createInterface({ input: child.stdout }).on('line', line => {
      trace.feed(line);
      if (trace.calls.length >= options.maxCalls) stop('call-cap');
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(question.question);
    child.on('error', error => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ record: { questionId: question.id, run, status: 'failed', calls: [] }, model: undefined, toolNames: [], failure: error.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      children.delete(child);
      let status: SessionStatus = stopped ?? 'ok';
      let failure: string | undefined;
      if (!stopped && (code !== 0 || trace.resultIsError === true) && trace.calls.length === 0) {
        status = 'failed';
        failure = `claude exited with ${code}: ${stderr.trim().split('\n')[0]?.slice(0, 200) ?? ''}`;
      }
      resolve({
        record: { questionId: question.id, run, status, calls: trace.calls, costUsd: trace.costUsd },
        model: trace.model,
        toolNames: trace.toolNames,
        failure,
      });
    });
  });
}

function printAggregates(a: Aggregates, options: Options, models: Set<string>, questionCount: number): void {
  const line = (label: string, value: string) => console.log(`${label.padEnd(26)}${value}`);
  console.log('\nRouting eval');
  line('surface', a.surface);
  line('model', [...models].join(', ') || 'unknown');
  line('questions x runs', `${questionCount} x ${options.runs}`);
  line('sessions counted', `${a.sessions} (${a.failed} failed and left out, ${a.timedOut} timed out, ${a.capped} stopped at ${options.maxCalls} calls)`);
  line('type-correct', `${percent(a.typeCorrect)} (${a.typeCorrect.count}/${a.typeCorrect.of})`);
  line('tool-correct', `${percent(a.toolCorrect)} (${a.toolCorrect.count}/${a.toolCorrect.of})`);
  line('no logseq call', `${percent(a.noCall)} (${a.noCall.count}/${a.noCall.of})`);
  line('schema errors', `${a.schemaErrors.calls} calls in ${a.schemaErrors.sessions} sessions`);
  line('error results', `${a.errorResults}`);
  line('calls per question', `${a.callsPerSession.mean.toFixed(2)} mean, ${a.callsPerSession.max} max`);
  if (a.costUsd) line('cost', `$${a.costUsd.total.toFixed(2)} total, $${a.costUsd.perSession.toFixed(3)} per session`);

  console.log('\nBy intent (type-correct / tool-correct / no call)');
  for (const entry of a.byIntent) {
    console.log(`  ${entry.intent.padEnd(28)}${entry.expected.padEnd(9)}${percent(entry.typeCorrect).padStart(7)}${percent(entry.toolCorrect).padStart(8)}${percent(entry.noCall).padStart(8)}`);
  }

  console.log('\nFirst call by expected type (rows: expected, columns: what the model called first)');
  const columns = [...TOOL_TYPES, 'unknown', 'none'];
  console.log(`  ${''.padEnd(9)}${columns.map(column => column.padStart(9)).join('')}`);
  for (const expected of TOOL_TYPES) {
    const row = a.confusion[expected] ?? {};
    console.log(`  ${expected.padEnd(9)}${columns.map(column => String(row[column] ?? 0).padStart(9)).join('')}`);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const questions = await loadQuestions(options.questions, options.only);
  if (questions.length === 0) throw new Error('No question selected');
  const sessions = questions.length * options.runs;
  console.log(
    `${questions.length} questions x ${options.runs} runs = ${sessions} sessions on model ${options.model}, ` +
      `each at most ${options.maxCalls} logseq calls, ${options.timeoutMs / 1000}s and $${options.maxBudgetUsd} ` +
      `(an upper bound of $${(sessions * options.maxBudgetUsd).toFixed(2)})`
  );
  if (options.dryRun) {
    for (const question of questions) console.log(`  ${question.id.padEnd(20)}${question.expected_type.padEnd(9)}${question.intent}`);
    console.log('Dry run: no instance contacted, no model called.');
    return;
  }

  // Refuse anything but the fixture before the first model call (#90): no config of ~/.logseq-mcp, never port 12315
  const configPath = resolveFixtureConfigPath();
  const config = await loadConfig(configPath);
  assertNotPersonalLogseq(config.apiUrl);
  await requireFixtureGraph(new LogseqClient(config));
  requireRustBinary();

  const harness = await prepareHarness(config);
  const onSignal = () => {
    for (const child of children) killGroup(child, 'SIGTERM');
    void rm(harness.dir, { recursive: true, force: true }).finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const records: SessionRecord[] = [];
  const models = new Set<string>();
  const surfaces = new Set<Surface>();
  const failures: string[] = [];
  try {
    const queue: Array<{ question: Question; run: number }> = [];
    for (let run = 1; run <= options.runs; run++) for (const question of questions) queue.push({ question, run });
    let next = 0;
    let done = 0;
    let aborted = false;
    const worker = async (): Promise<void> => {
      while (!aborted && next < queue.length) {
        const { question, run } = queue[next++];
        const result = await runSession(question, run, options, harness);
        records.push(result.record);
        if (result.model) models.add(result.model);
        if (result.toolNames.length > 0 && !options.surface) {
          try {
            surfaces.add(detectSurface(result.toolNames));
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (result.failure) failures.push(`${question.id} run ${run}: ${result.failure}`);
        done++;
        process.stderr.write(`\r${done}/${queue.length} sessions`);
        // Three failed sessions and no good one: the host or the server is broken, so stop spending
        if (failures.length >= 3 && !records.some(record => record.status !== 'failed')) aborted = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency, queue.length) }, worker));
    process.stderr.write('\n');
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }

  for (const failure of new Set(failures)) console.error(`failed: ${failure}`);
  const surface = options.surface ?? [...surfaces][0];
  if (!surface) throw new Error('No session reported the tool list, so the surface is unknown. Pass --surface v1 or --surface v2.');
  if (surfaces.size > 1) throw new Error('The sessions saw both a v1 and a v2 tool list. Pass --surface to score one.');
  const aggregates = aggregate(surface, questions, records);
  printAggregates(aggregates, options, models, questions.length);
  if (options.out) {
    await writeFile(options.out, JSON.stringify({ surface, models: [...models], aggregates, sessions: records }, null, 2), { mode: 0o600 });
    console.log(`\nWrote ${options.out}. It holds the arguments the model sent: keep it local, never commit or post it.`);
  }
  if (aggregates.failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
