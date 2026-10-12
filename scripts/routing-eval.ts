/**
 * Routing eval (#487): does the model pick the right kind of tool for a question?
 *
 * Usage:
 *   npx tsx scripts/logseq-instance.ts start
 *   npx tsx scripts/routing-eval.ts [--runs 3] [--only get,find-keyword-1] [--out .logseq-instance/routing-v1.json]
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
 * --max-budget-usd, and the run by --max-total-usd. It stays local like the integration suite
 * (tests/integration/setup.md, "Routing eval").
 *
 * It never contacts the personal LogSeq: the config is LOGSEQ_MCP_CONFIG or this worktree's
 * .logseq-instance/config.json, a config on port 12315 is refused before any model call, and the graph must be
 * the fixture (#90). Raw output of a real run stays out of the repo and off GitHub beyond the aggregates (BR-0001).
 *
 * The pure parts are in scripts/lib/routing-eval*.ts, which tests/guards/routing-eval.test.ts runs.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadConfig, LogseqClient } from './lib/logseq-api.js';
import { RUST_BINARY_ENV, requireRustBinary, rustBinaryPath } from './lib/rust-binary.js';
import {
  aggregate,
  detectSurface,
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
import { assertOutPathSafe, claudeArgs, hostEnv, parseOptions, prepareHarness, USAGE, type Harness, type Options } from './lib/routing-eval-host.js';
import { parseSavedRun, reconcile, SAVED_RUN_VERSION, scoringHash, textHash } from './lib/routing-eval-saved.js';
import { requireFixtureGraph } from '../tests/integration/helpers/fixture-graph.js';
import { assertNotPersonalLogseq, resolveFixtureConfigPath } from '../tests/integration/helpers/instance-config.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_QUESTIONS = join(repoRoot, 'tests', 'fixtures', 'routing-eval', 'questions.json');

function select(all: readonly Question[], only: readonly string[]): Question[] {
  if (only.length === 0) return [...all];
  const known = new Set<string>([...all.map(question => question.id), ...TOOL_TYPES]);
  const unknown = only.filter(name => !known.has(name));
  if (unknown.length > 0) throw new Error(`--only names no question id or type: ${unknown.join(', ')}`);
  return all.filter(question => only.includes(question.id) || only.includes(question.expected_type));
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
function runSession(question: Question, run: number, options: Options, harness: Harness, env: Record<string, string>): Promise<SessionResult> {
  return new Promise(resolve => {
    const trace = new SessionTrace();
    const child = spawn('claude', claudeArgs(options, harness.mcpConfigPath), { cwd: harness.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
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
    const done = (status: SessionStatus, failure?: string): void => {
      clearTimeout(timer);
      children.delete(child);
      resolve({
        record: { questionId: question.id, run, status, calls: status === 'failed' ? [] : trace.calls, costUsd: trace.costUsd },
        model: trace.model,
        toolNames: trace.toolNames,
        failure,
      });
    };
    child.on('error', error => done('failed', error.message));
    child.on('close', code => {
      // The server never attached (the init event lists no logseq tool): the harness broke, not the model's choice
      if (trace.toolNames.length === 0) {
        done('failed', stopped ? `${stopped} before the server attached` : `the server never attached (claude exited ${code}): ${stderr.trim().split('\n')[0]?.slice(0, 200) ?? ''}`);
      } else if (!stopped && (code !== 0 || trace.resultIsError === true) && trace.calls.length === 0) {
        done('failed', `claude exited ${code}: ${stderr.trim().split('\n')[0]?.slice(0, 200) ?? ''}`);
      } else {
        done(stopped ?? 'ok');
      }
    });
  });
}

interface RunInfo {
  planned: number;
  runs: number;
  stoppedEarly: boolean;
  models: Set<string>;
  questionCount: number;
}

function printAggregates(a: Aggregates, options: Options, info: RunInfo): void {
  const line = (label: string, value: string) => console.log(`${label.padEnd(26)}${value}`);
  console.log('\nRouting eval');
  line('surface', a.surface);
  line('model', [...info.models].join(', ') || 'unknown');
  line('questions x runs', `${info.questionCount} x ${info.runs}`);
  line('sessions counted', `${a.sessions} of ${info.planned} planned (${a.failed} failed and left out, ${a.timedOut} timed out, ${a.capped} stopped at ${options.maxCalls} calls)`);
  if (a.failed > 0 || info.stoppedEarly || a.sessions < info.planned) {
    console.log('INCOMPLETE: the rates below are over the counted sessions only. Do not post this as a baseline; fix the cause and re-run.');
  }
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

async function rescore(options: Options, selected: Question[], all: Question[], file: string): Promise<void> {
  const saved = parseSavedRun(JSON.parse(await readFile(file, 'utf8')));
  const reconciled = reconcile(saved, selected, all, options.only.length > 0);
  if (reconciled.scoringChanged) {
    console.log('NOTE: the scoring lists or expected types differ from the ones this run was scored with. This is a rescore under the current lists.');
  } else {
    console.log('The scoring lists and expected types are the ones this run was scored with.');
  }
  if (reconciled.unanswered.length > 0) {
    console.log(`NOT SCORED: no saved session for ${reconciled.unanswered.length} question(s): ${reconciled.unanswered.join(', ')}`);
    process.exitCode = 1;
  }
  const runs = Math.max(1, ...reconciled.sessions.map(session => session.run));
  const surface = options.surface ?? saved.surface;
  const result = aggregate(surface, selected, reconciled.sessions);
  const planned = options.only.length > 0 ? reconciled.sessions.length : saved.planned;
  printAggregates(result, options, { planned, runs, stoppedEarly: saved.stoppedEarly, models: new Set(saved.models), questionCount: selected.length });
  if (saved.stoppedEarly || result.failed > 0) process.exitCode = 1;
}

/** `git check-ignore -q` exits 0 for an ignored path and 1 for one that is not */
function gitIgnores(absolute: string): boolean {
  try {
    execFileSync('git', ['-C', repoRoot, 'check-ignore', '-q', absolute], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const all = parseQuestions(JSON.parse(await readFile(options.questions ?? DEFAULT_QUESTIONS, 'utf8')));
  const questions = select(all, options.only);
  if (questions.length === 0) throw new Error('No question selected');
  if (options.out) assertOutPathSafe(options.out, repoRoot, gitIgnores);
  if (options.rescore) return rescore(options, questions, all, options.rescore);

  const planned = questions.length * options.runs;
  console.log(
    `${questions.length} questions x ${options.runs} runs = ${planned} sessions on model ${options.model}, each at most ` +
      `${options.maxCalls} logseq calls, ${options.timeoutMs / 1000}s and $${options.maxBudgetUsd}; the run stops starting ` +
      `sessions at $${options.maxTotalUsd} in all (worst case $${Math.min(planned * options.maxBudgetUsd, options.maxTotalUsd + options.concurrency * options.maxBudgetUsd).toFixed(2)})`
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
  if (options.binary) process.env[RUST_BINARY_ENV] = options.binary;
  requireRustBinary();

  const harness = await prepareHarness(config, rustBinaryPath());
  const env = hostEnv(process.env);
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
  let spent = 0;
  let stoppedEarly = false;
  try {
    const queue: Array<{ question: Question; run: number }> = [];
    for (let run = 1; run <= options.runs; run++) for (const question of questions) queue.push({ question, run });
    let next = 0;
    let done = 0;
    const worker = async (): Promise<void> => {
      while (!stoppedEarly && next < queue.length) {
        const { question, run } = queue[next++];
        const result = await runSession(question, run, options, harness, env);
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
        spent += result.record.costUsd ?? 0;
        done++;
        process.stderr.write(`\r${done}/${queue.length} sessions, $${spent.toFixed(2)}`);
        // The spend cap, and three failed sessions with no good one (the host or the server is broken): stop starting sessions
        if (spent >= options.maxTotalUsd) stoppedEarly = true;
        if (failures.length >= 3 && !records.some(record => record.status !== 'failed')) stoppedEarly = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency, queue.length) }, worker));
    process.stderr.write('\n');
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
  stoppedEarly = stoppedEarly && records.length < planned;

  for (const failure of new Set(failures)) console.error(`failed: ${failure}`);
  const surface = options.surface ?? [...surfaces][0];
  if (!surface) throw new Error('No session reported the tool list, so the surface is unknown. Pass --surface v1 or --surface v2.');
  if (surfaces.size > 1) throw new Error('The sessions saw both a v1 and a v2 tool list. Pass --surface to score one.');
  const aggregates = aggregate(surface, questions, records);
  printAggregates(aggregates, options, { planned, runs: options.runs, stoppedEarly, models, questionCount: questions.length });
  if (stoppedEarly) console.log(`STOPPED EARLY: ${records.length} of ${planned} sessions ran (spent $${spent.toFixed(2)} against --max-total-usd ${options.maxTotalUsd}, or the host kept failing).`);
  if (options.out) {
    const saved = { version: SAVED_RUN_VERSION, surface, models: [...models], textHash: textHash(all), scoringHash: scoringHash(all), planned, stoppedEarly, aggregates, sessions: records };
    await writeFile(options.out, JSON.stringify(saved, null, 2), { mode: 0o600 });
    console.log(`\nWrote ${options.out}. It holds the arguments the model sent: keep it local, never commit or post it.`);
  }
  if (aggregates.failed > 0 || stoppedEarly) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
