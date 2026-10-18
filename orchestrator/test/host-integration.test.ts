// The host integration activity (#647) with a fake command runner: no LogSeq, no cargo, no npm and no real git are
// needed, and nothing here calls the model or GitHub. The fake answers by the fixed step name of each command, writes
// the files a real run would (the worktree, the reporter's JSON, the porcelain output) and records every call, so a
// test can assert the order of the steps and that `stop` and the removal ran. Every name is made up. The real run, on
// the maintainer's Mac against the fixture instance, is not exercised here.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { ApplicationFailure, CancelledFailure } from '@temporalio/activity';
import { MockActivityEnvironment } from '@temporalio/testing';
import { createHostIntegrationActivities, createProcessRunner, hostCommandEnv, parseReportCounts } from '../src/activities/host-integration.ts';
import type { CommandResult, CommandRunner, CommandSpec } from '../src/activities/host-integration.ts';
import type { HostIntegrationResult } from '../src/host-integration-policy.ts';
import { ConfigError, loadHostConfig } from '../src/config.ts';
import {
  HOST_INTEGRATION_ACTIVITY_OPTIONS,
  HOST_INTEGRATION_OUTCOMES,
  HOST_START_TO_CLOSE_MS,
  HOST_TASK_QUEUE_NAME,
  parseHostIntegrationInput,
} from '../src/host-integration-policy.ts';

const SHA = 'a'.repeat(40);
const INPUT = { pr: 77, headSha: SHA, base: 'main' };
// What a real run's output could contain: a page name and a block quote from a graph. It must never come back.
const GRAPH_TEXT = 'Alice met Bob on [[project atlas]] 20250101';

const OK: CommandResult = { code: 0, timedOut: false, aborted: false };

type Handler = (spec: CommandSpec, signal: AbortSignal | undefined) => CommandResult | Promise<CommandResult> | undefined;

class FakeRunner implements CommandRunner {
  readonly calls: CommandSpec[] = [];
  readonly overrides = new Map<string, Handler>();
  report = { numPassedTests: 12, numFailedTests: 0 };
  integrationCode = 0;
  porcelain = '';

  get steps(): string[] {
    return this.calls.map((call) => call.step);
  }

  on(step: string, handler: Handler): void {
    this.overrides.set(step, handler);
  }

  async run(spec: CommandSpec, signal?: AbortSignal): Promise<CommandResult> {
    this.calls.push(spec);
    await writeFile(spec.outputFile, `${GRAPH_TEXT}\n`, { flag: 'a' });
    const override = this.overrides.get(spec.step)?.(spec, signal);
    if (override !== undefined) {
      return override;
    }
    switch (spec.step) {
      case 'worktree_add': {
        await mkdir(spec.args[spec.args.indexOf('--detach') + 1] ?? '', { recursive: true });
        return OK;
      }
      case 'integration': {
        const flag = spec.args.find((arg) => arg.startsWith('--outputFile='));
        await writeFile((flag ?? '').slice('--outputFile='.length), JSON.stringify({ ...this.report, testResults: [{ name: GRAPH_TEXT }] }));
        return { code: this.integrationCode, timedOut: false, aborted: false };
      }
      case 'fixture_status':
        await writeFile(spec.outputFile, this.porcelain);
        return OK;
      case 'worktree_remove':
        await rm(spec.args[spec.args.length - 1] ?? '', { recursive: true, force: true });
        return OK;
      default:
        return OK;
    }
  }
}

let root: string;
let runner: FakeRunner;
let logged: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'host-integration-test-'));
  runner = new FakeRunner();
  logged = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function activities(extra: { limits?: { runDeadlineMs?: number; now?: () => number } } = {}) {
  return createHostIntegrationActivities({
    repoDir: join(root, 'repo'),
    workRoot: join(root, 'work'),
    runner,
    log: (line) => logged.push(line),
    env: { PATH: '/usr/bin', HOME: '/home/x', GITHUB_TOKEN: 'ghp_secret', LOGSEQ_MCP_CONFIG: '/home/x/.logseq-mcp/config.json' },
    limits: { heartbeatIntervalMs: 10, ...extra.limits },
  });
}

const run = (input: unknown = INPUT, attempt = 1, a = activities()): Promise<HostIntegrationResult> =>
  new MockActivityEnvironment({ attempt }).run(a.runHostIntegration, input);
const runDir = (pr = 77) => join(root, 'work', `pr-${pr}`);

async function gone(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch {
    return true;
  }
}

function indexOfStep(step: string): number {
  return runner.steps.indexOf(step);
}

test('a passing run returns the counts, runs the steps in order and cleans up', async () => {
  const result = await run();
  assert.deepEqual(result, { outcome: 'pass', passed: 12, failed: 0 });
  assert.deepEqual(
    runner.steps.filter((step) => !['worktree_prune'].includes(step)),
    ['fetch', 'head_present', 'worktree_add', 'merge', 'npm_ci', 'cargo_build', 'instance_start', 'integration', 'instance_stop', 'fixture_status', 'worktree_remove'],
  );
  assert.ok(await gone(runDir()), 'the worktree and the output are removed');
  const integration = runner.calls.find((call) => call.step === 'integration');
  assert.deepEqual(integration?.args.slice(0, 3), ['run', 'test:integration', '--']);
  assert.ok(integration?.args.includes('--reporter=json'));
  assert.ok(runner.calls.every((call) => !call.cwd.startsWith(join(root, 'repo')) || ['fetch', 'head_present', 'worktree_add', 'worktree_remove', 'worktree_prune'].includes(call.step)), 'only git setup and removal touch the working copy');
  assert.ok(runner.calls.filter((call) => call.step !== 'worktree_remove' && call.step !== 'worktree_prune' && call.step !== 'fetch' && call.step !== 'head_present' && call.step !== 'worktree_add').every((call) => call.cwd.startsWith(join(runDir(), 'tree'))));
});

test('the commands get an allowlisted environment: no token, no LogSeq config path', async () => {
  await run();
  for (const call of runner.calls) {
    assert.equal(call.env['GITHUB_TOKEN'], undefined);
    assert.equal(call.env['LOGSEQ_MCP_CONFIG'], undefined);
    assert.equal(call.env['PATH'], '/usr/bin');
  }
  assert.deepEqual(hostCommandEnv({ PATH: '/bin', ORCHESTRATOR_GH_TOKEN: 'x', HOME: '' }), { PATH: '/bin', GIT_TERMINAL_PROMPT: '0' });
});

test('a failing suite is returned as fail with its counts, and is not retried', async () => {
  runner.report = { numPassedTests: 10, numFailedTests: 2 };
  runner.integrationCode = 1;
  assert.deepEqual(await run(INPUT, 1), { outcome: 'fail', passed: 10, failed: 2 });
  assert.equal(runner.steps.filter((step) => step === 'integration').length, 1);
  assert.ok(indexOfStep('instance_stop') > indexOfStep('integration'));
  assert.ok(await gone(runDir()));
  assert.equal(HOST_INTEGRATION_ACTIVITY_OPTIONS.retry?.maximumAttempts, 2);
});

test('a non-zero exit with no failed test is still a fail', async () => {
  runner.integrationCode = 1;
  assert.deepEqual(await run(), { outcome: 'fail', passed: 12, failed: 0 });
});

test('a report that counts no test at all is a setup error, never a pass and never a 0/0 fail', async () => {
  runner.report = { numPassedTests: 0, numFailedTests: 0 };
  assert.deepEqual(await run(), { outcome: 'setup_error', passed: 0, failed: 0 });
  runner.integrationCode = 1;
  assert.deepEqual(await run(), { outcome: 'setup_error', passed: 0, failed: 0 });
  assert.ok(runner.steps.includes('instance_stop'));
  assert.ok(await gone(runDir()));
});

test('a registered but missing worktree is pruned before the new one is added, with no run directory present', async () => {
  assert.ok(await gone(runDir()));
  await run();
  const prune = indexOfStep('worktree_prune');
  assert.ok(prune >= 0 && prune < indexOfStep('worktree_add'), 'pruned before worktree add');
  assert.ok(prune < indexOfStep('fetch'));
});

test('the heartbeat is sent at the start and on the interval, and stops when the run ends', async () => {
  let beats = 0;
  runner.on('cargo_build', () => new Promise<CommandResult>((resolve) => setTimeout(() => resolve(OK), 80)));
  const environment = new MockActivityEnvironment({ attempt: 1 });
  environment.on('heartbeat', () => {
    beats += 1;
  });
  await environment.run(activities().runHostIntegration, INPUT);
  assert.ok(beats >= 3, `expected a heartbeat at the start and on the interval, got ${beats}`);
  const after = beats;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(beats, after, 'no heartbeat after the run returned');
});

test('a merge conflict is `conflict`: no install, no instance, no suite', async () => {
  runner.on('merge', () => ({ code: 1, timedOut: false, aborted: false }));
  assert.deepEqual(await run(), { outcome: 'conflict', passed: 0, failed: 0 });
  assert.deepEqual(runner.steps.filter((step) => ['npm_ci', 'cargo_build', 'instance_start', 'integration', 'instance_stop'].includes(step)), []);
  assert.ok(runner.steps.includes('merge_head'));
  assert.ok(await gone(runDir()));
});

test('a merge that failed without a conflict is a setup error, not a conflict', async () => {
  runner.on('merge', () => ({ code: 128, timedOut: false, aborted: false }));
  runner.on('merge_head', () => ({ code: 1, timedOut: false, aborted: false }));
  assert.deepEqual(await run(), { outcome: 'setup_error', passed: 0, failed: 0 });
  assert.ok(!runner.steps.includes('npm_ci'));
});

test('a dirty committed fixture is `fixture_dirty`, with the counts', async () => {
  runner.porcelain = '?? tests/fixtures/graph/logseq/bak/\n';
  assert.deepEqual(await run(), { outcome: 'fixture_dirty', passed: 12, failed: 0 });
  assert.ok(indexOfStep('fixture_status') > indexOfStep('instance_stop'), 'checked after the instance stopped');
  assert.ok(await gone(runDir()));
});

test('the fixture check wins over a failing suite', async () => {
  runner.porcelain = ' M tests/fixtures/graph/logseq/config.edn\n';
  runner.integrationCode = 1;
  runner.report = { numPassedTests: 3, numFailedTests: 1 };
  assert.deepEqual(await run(), { outcome: 'fixture_dirty', passed: 3, failed: 1 });
});

test('a suite that wrote no report is a setup error, not a pass', async () => {
  runner.on('integration', async (spec) => {
    void spec;
    return { code: 1, timedOut: false, aborted: false };
  });
  assert.deepEqual(await run(), { outcome: 'setup_error', passed: 0, failed: 0 });
  assert.ok(runner.steps.includes('instance_stop'));
});

test('stop and the worktree removal run after a failed instance start', async () => {
  runner.on('instance_start', () => ({ code: 1, timedOut: false, aborted: false }));
  assert.deepEqual(await run(INPUT, 2), { outcome: 'setup_error', passed: 0, failed: 0 });
  assert.ok(runner.steps.includes('instance_stop'));
  assert.ok(!runner.steps.includes('integration'));
  assert.ok(await gone(runDir()));
});

test('stop and the worktree removal run after a timeout of the suite', async () => {
  runner.on('integration', () => ({ code: null, timedOut: true, aborted: false }));
  assert.deepEqual(await run(), { outcome: 'setup_error', passed: 0, failed: 0 });
  assert.ok(indexOfStep('instance_stop') > indexOfStep('integration'));
  assert.ok(await gone(runDir()));
  assert.equal(runner.steps.filter((step) => step === 'integration').length, 1, 'a timeout is not retried inside the activity');
});

test('stop and the worktree removal run after a cancellation, which is rethrown', async () => {
  let reached: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  runner.on('integration', (_spec, signal) => {
    reached();
    return new Promise<CommandResult>((resolve) => {
      signal?.addEventListener('abort', () => resolve({ code: null, timedOut: false, aborted: true }), { once: true });
    });
  });
  const environment = new MockActivityEnvironment({ attempt: 1 });
  const pending = environment.run(activities().runHostIntegration, INPUT);
  await started;
  environment.cancel();
  await assert.rejects(pending, (error: unknown) => error instanceof CancelledFailure);
  assert.ok(indexOfStep('instance_stop') > indexOfStep('integration'));
  assert.ok(runner.steps.includes('worktree_remove'));
  assert.ok(await gone(runDir()));
  const stop = runner.calls.find((call) => call.step === 'instance_stop');
  assert.ok(stop !== undefined);
});

test('stop runs even when the runner itself throws during the suite', async () => {
  runner.on('integration', () => {
    throw new Error('spawn failed');
  });
  assert.deepEqual(await run(), { outcome: 'setup_error', passed: 0, failed: 0 });
  assert.ok(runner.steps.includes('instance_stop'));
  assert.ok(await gone(runDir()));
});

test('a stale worktree of the same PR is stopped and removed before the new run', async () => {
  await mkdir(join(runDir(), 'tree'), { recursive: true });
  await writeFile(join(runDir(), 'tree', 'left-over.txt'), 'old');
  await mkdir(join(runDir(), 'out'), { recursive: true });
  const result = await run();
  assert.equal(result.outcome, 'pass');
  const firstRemove = indexOfStep('worktree_remove');
  assert.ok(indexOfStep('instance_stop') < firstRemove);
  assert.ok(firstRemove < indexOfStep('fetch'), 'the stale tree is gone before anything is fetched');
  assert.equal(runner.steps.filter((step) => step === 'worktree_add').length, 1);
  assert.ok(await gone(runDir()));
});

test('a bad input is refused with no command run', async () => {
  const bad: unknown[] = [
    undefined,
    null,
    [],
    {},
    { ...INPUT, pr: 0 },
    { ...INPUT, pr: 1.5 },
    { ...INPUT, pr: '7' },
    { ...INPUT, headSha: 'abc123' },
    { ...INPUT, headSha: 'A'.repeat(40) },
    { ...INPUT, headSha: `${SHA} --foo` },
    { ...INPUT, base: '--upload-pack=x' },
    { ...INPUT, base: 'main..other' },
    { ...INPUT, base: 'a b' },
    { ...INPUT, base: 'main/' },
    { ...INPUT, base: 'x.lock' },
    { ...INPUT, base: 'main;rm' },
  ];
  for (const input of bad) {
    await assert.rejects(new MockActivityEnvironment().run(activities().runHostIntegration, input), (error: unknown) => {
      assert.ok(error instanceof ApplicationFailure);
      assert.equal(error.type, 'InvalidInput');
      assert.equal(error.nonRetryable, true);
      return true;
    });
  }
  assert.deepEqual(runner.calls, []);
  assert.ok(await gone(runDir()));
});

test('a good input parses', () => {
  assert.deepEqual(parseHostIntegrationInput({ ...INPUT, base: 'feature/temporal-orchestrator' }), { ...INPUT, base: 'feature/temporal-orchestrator' });
});

test('the result carries integers and one fixed word, and no output text reaches it or the log', async () => {
  const results = [await run()];
  runner.porcelain = `?? ${GRAPH_TEXT}\n`;
  results.push(await run());
  runner.porcelain = '';
  runner.integrationCode = 1;
  results.push(await run());
  for (const result of results) {
    assert.deepEqual(Object.keys(result).sort(), ['failed', 'outcome', 'passed']);
    assert.ok(HOST_INTEGRATION_OUTCOMES.includes(result.outcome));
    assert.ok(Number.isInteger(result.passed) && Number.isInteger(result.failed));
    assert.ok(!JSON.stringify(result).includes('Alice'));
  }
  assert.ok(logged.length > 0);
  for (const entry of logged) {
    assert.match(entry, /^host-integration pr=77 step=[a-z_]+ exit=(\d+|timeout|error|deadline|cancelled)$/);
    assert.ok(!entry.includes('Alice') && !entry.includes('atlas'));
  }
});

test('a setup failure before the suite is retried once: thrown on attempt 1, `setup_error` on attempt 2', async () => {
  runner.on('npm_ci', () => ({ code: 1, timedOut: false, aborted: false }));
  await assert.rejects(run(INPUT, 1), /stopped at npm_ci/);
  assert.ok(await gone(runDir()), 'cleaned up before the retry');
  assert.deepEqual(await run(INPUT, 2), { outcome: 'setup_error', passed: 0, failed: 0 });
  assert.ok(!runner.steps.includes('instance_start'));
});

test('a failing suite is never thrown, on any attempt', async () => {
  runner.integrationCode = 1;
  runner.report = { numPassedTests: 1, numFailedTests: 1 };
  assert.equal((await run(INPUT, 1)).outcome, 'fail');
  assert.equal((await run(INPUT, 2)).outcome, 'fail');
});

test('a spent deadline starts no command but still cleans up', async () => {
  const result = await run(INPUT, 1, activities({ limits: { runDeadlineMs: 0 } }));
  assert.deepEqual(result, { outcome: 'setup_error', passed: 0, failed: 0 });
  assert.ok(!runner.steps.includes('fetch'));
  assert.ok(!runner.steps.includes('instance_start'));
  assert.ok(runner.steps.includes('worktree_remove'));
});

test('each command is cut to what is left of the deadline', async () => {
  await run();
  assert.ok(runner.calls.every((call) => call.timeoutMs > 0 && call.timeoutMs <= HOST_START_TO_CLOSE_MS));
});

test('the policy routes to the host queue and the host worker is off unless HOST_TASK_QUEUE is set', () => {
  assert.equal(HOST_INTEGRATION_ACTIVITY_OPTIONS.taskQueue, HOST_TASK_QUEUE_NAME);
  assert.equal(HOST_TASK_QUEUE_NAME, 'host');
  assert.equal(loadHostConfig({}), undefined);
  assert.equal(loadHostConfig({ HOST_TASK_QUEUE: '  ' }), undefined);
  assert.deepEqual(loadHostConfig({ HOST_TASK_QUEUE: 'host' }), { taskQueue: 'host', repoDir: undefined });
  assert.deepEqual(loadHostConfig({ HOST_TASK_QUEUE: '1', HOST_REPO_DIR: '/work/repo' }), { taskQueue: 'host', repoDir: '/work/repo' });
  assert.deepEqual(loadHostConfig({ HOST_TASK_QUEUE: 'true' }), { taskQueue: 'host', repoDir: undefined });
  assert.throws(() => loadHostConfig({ HOST_TASK_QUEUE: 'other' }), ConfigError);
  assert.throws(() => loadHostConfig({ HOST_TASK_QUEUE: 'host', HOST_REPO_DIR: 'relative' }), ConfigError);
  // HOST_REPO_DIR alone does not turn the worker on.
  assert.equal(loadHostConfig({ HOST_REPO_DIR: '/work/repo' }), undefined);
});

test('the reporter counts are parsed strictly', () => {
  assert.deepEqual(parseReportCounts('{"numPassedTests":3,"numFailedTests":0,"x":[]}'), { passed: 3, failed: 0 });
  for (const text of ['', 'nope', '[]', '{}', '{"numPassedTests":"3","numFailedTests":0}', '{"numPassedTests":3,"numFailedTests":-1}', '{"numPassedTests":1.5,"numFailedTests":0}', '{"numPassedTests":3}']) {
    assert.equal(parseReportCounts(text), undefined, text);
  }
});

// ---- the default runner, with node as the command -------------------------------------------------------------

function nodeSpec(script: string, timeoutMs: number, outputFile: string): CommandSpec {
  return { step: 'probe', command: process.execPath, args: ['-e', script], cwd: root, env: { PATH: process.env['PATH'] ?? '' }, timeoutMs, outputFile };
}

test('the process runner appends output to the file and returns only how the command ended', async () => {
  const file = join(root, 'out.txt');
  const result = await createProcessRunner().run(nodeSpec('console.log("hello"); process.exit(3)', 10_000, file));
  assert.deepEqual(result, { code: 3, timedOut: false, aborted: false });
  assert.equal(await readFile(file, 'utf-8'), 'hello\n');
});

test('the process runner stops a command at its timeout and on abort', async () => {
  const forever = 'setInterval(() => {}, 1000)';
  const timedOut = await createProcessRunner().run(nodeSpec(forever, 200, join(root, 'a.txt')));
  assert.equal(timedOut.timedOut, true);
  assert.notEqual(timedOut.code, 0);

  const controller = new AbortController();
  const pending = createProcessRunner().run(nodeSpec(forever, 60_000, join(root, 'b.txt')), controller.signal);
  setTimeout(() => controller.abort(), 200);
  const aborted = await pending;
  assert.equal(aborted.aborted, true);

  const missing = await createProcessRunner().run({ ...nodeSpec('', 1000, join(root, 'c.txt')), command: join(root, 'no-such-command') });
  assert.equal(missing.code, null);
});
