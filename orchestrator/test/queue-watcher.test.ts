// The queue watcher (#723, plan #721) against a real Temporal server (an in-memory dev server on a free port) and no
// real service. No test calls GitHub, the model or LogSeq. Every name is made up (issue 11, repo dir /work/repo).
//
// Three layers:
// - the pure parts: the input, the cap bounds, the interval, the script's arguments;
// - the `queueWatcher` workflow with FAKE activities that model the GitHub reads and the Temporal side, so every number
//   of a tick (started, skipped with its reason, the cap, a failed read) is exact;
// - the `queueWatcher` workflow with the REAL client activities (src/activities/queue.ts) and a stand-in `issueWorkflow`
//   that stays open until signalled, as a run held at the gate does, so the start, the visibility list and the idempotency
//   of the workflow ID are the server's own. The Schedule and the `npm run queue` script run against the same server.
//
// The dev server is not the time-skipping test server (its download is blocked in the cloud), so the waits are real but
// short, and the tests poll for what they expect with a deadline.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ApplicationFailure } from '@temporalio/activity';
import { ScheduleOverlapPolicy, WorkflowFailedError } from '@temporalio/client';
import type { Client } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import type { WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { createQueueActivities } from '../src/activities/queue.ts';
import { maintainerDecisionSignal } from '../src/approval-types.ts';
import { loadServerConfig } from '../src/config.ts';
import { startDevServer } from '../src/dev-server.ts';
import { ISSUE_WORKFLOW_NAME, issueWorkflowId } from '../src/issue-types.ts';
import type { IssueWorkflowInput } from '../src/issue-types.ts';
import { changeQueueSchedule, createQueueSchedule, parseEvery, parseQueueArgs } from '../src/queue-schedule.ts';
import type { QueueFlags } from '../src/queue-schedule.ts';
import {
  DEFAULT_QUEUE_CAP,
  InvalidQueueInputError,
  MAX_QUEUE_CAP,
  MAX_TICK_SKIPS_REPORTED,
  MIN_TICK_DEADLINE_MS,
  QUEUE_ACTIVITY_OPTIONS,
  QUEUE_TICK_DEADLINE_MS,
  QUEUE_TICK_TIMEOUT,
  QUEUE_TICK_TIMEOUT_MS,
  QUEUE_SCHEDULE_ID,
  QUEUE_WATCHER_WORKFLOW_NAME,
  TICK_DEADLINE_REASON,
  parseQueueWatcherInput,
  parseStartQueuedRunInput,
} from '../src/queue-types.ts';
import type { QueueRunTemplate, RunningIssues, StartQueuedRunInput, StartQueuedRunResult, TickReport } from '../src/queue-types.ts';
import type { BlockedReadyIssue, ReadyIssues, TakenIssues, TrustedIssues } from '../src/types.ts';
import { forbiddenCalls } from './invariants.ts';
import { freePort } from './support.ts';

const execFileAsync = promisify(execFile);

const WORKFLOWS_PATH = fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url));
const STUB_WORKFLOWS_PATH = fileURLToPath(new URL('./workflows/queue-stub.ts', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const ORCHESTRATOR_DIR = fileURLToPath(new URL('../', import.meta.url));

const RUN: QueueRunTemplate = { repoDir: '/work/repo', base: 'main' };
const CANARY = 'canary text that must never reach a report';

// ---- the pure parts ----------------------------------------------------------------------------------------------

test('the watcher input defaults the cap to 3, bounds it from 1 to 10 and keeps only the run template', () => {
  assert.equal(DEFAULT_QUEUE_CAP, 3);
  assert.deepEqual(parseQueueWatcherInput(RUN), { cap: 3, deadlineMs: QUEUE_TICK_DEADLINE_MS, run: RUN });
  assert.equal(parseQueueWatcherInput({ ...RUN, tickDeadlineMs: MIN_TICK_DEADLINE_MS }).deadlineMs, MIN_TICK_DEADLINE_MS);
  for (const bad of [0, 999, QUEUE_TICK_DEADLINE_MS + 1, 1.5, '1000']) {
    assert.throws(() => parseQueueWatcherInput({ ...RUN, tickDeadlineMs: bad }), /tickDeadlineMs must be a whole number/, String(bad));
  }
  assert.deepEqual(parseQueueWatcherInput({ ...RUN, cap: 1 }).cap, 1);
  assert.deepEqual(parseQueueWatcherInput({ ...RUN, cap: MAX_QUEUE_CAP }).cap, 10);
  assert.deepEqual(parseQueueWatcherInput({ ...RUN, hostIntegration: 'auto', executor: 'remote', extra: 'dropped' }).run, { ...RUN, hostIntegration: 'auto', executor: 'remote' });
  for (const bad of [0, 11, 2.5, -1, '3', null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => parseQueueWatcherInput({ ...RUN, cap: bad }), /cap must be a whole number from 1 to 10/, String(bad));
  }
  for (const bad of [undefined, null, 'x', [], 3]) {
    assert.throws(() => parseQueueWatcherInput(bad), InvalidQueueInputError);
  }
  assert.throws(() => parseQueueWatcherInput({ ...RUN, repoDir: 'relative/dir' }), /repoDir must be an absolute path/);
  assert.throws(() => parseQueueWatcherInput({ ...RUN, base: 'a..b' }), /base must be a plain branch name/);
  assert.throws(() => parseQueueWatcherInput({ ...RUN, executor: 'cloud' }), /executor must be local or remote/);
  assert.throws(() => parseQueueWatcherInput({ ...RUN, hostIntegration: 'yes' }), /hostIntegration must be auto or off/);
});

test('a start request is parsed at the boundary: a positive issue number and a valid run template', () => {
  assert.deepEqual(parseStartQueuedRunInput({ issue: 12, run: RUN }), { issue: 12, run: RUN });
  for (const bad of [{ issue: 0, run: RUN }, { issue: 1.5, run: RUN }, { issue: '12', run: RUN }, { run: RUN }, { issue: 12 }, { issue: 12, run: 'x' }, null]) {
    assert.throws(() => parseStartQueuedRunInput(bad), InvalidQueueInputError, JSON.stringify(bad));
  }
});

test('every activity of a tick has a start-to-close timeout of about two minutes and a bounded retry', () => {
  assert.equal(QUEUE_ACTIVITY_OPTIONS.startToCloseTimeout, '2 minutes');
  assert.equal(QUEUE_ACTIVITY_OPTIONS.retry?.maximumAttempts, 3);
  assert.ok(QUEUE_ACTIVITY_OPTIONS.retry?.nonRetryableErrorTypes?.includes('TooLarge'));
  assert.ok(QUEUE_ACTIVITY_OPTIONS.retry?.nonRetryableErrorTypes?.includes('TooManyRuns'));
});

test('the tick bounds itself below its execution timeout, and the timeout is the one the schedule sets', () => {
  assert.equal(QUEUE_TICK_TIMEOUT_MS, 10 * 60_000);
  assert.equal(QUEUE_TICK_TIMEOUT, '10 minutes');
  // The execution timeout sits a margin above the deadline, so Temporal never kills a tick before it has answered with a report.
  assert.ok(QUEUE_TICK_DEADLINE_MS + 60_000 <= QUEUE_TICK_TIMEOUT_MS, 'a margin of at least a minute above the deadline');
  // Why the tick needs its own deadline: the retry bounds of its activities add up to far more than the execution timeout.
  const attempts = QUEUE_ACTIVITY_OPTIONS.retry?.maximumAttempts ?? 0;
  const oneActivityWorstMs = attempts * 2 * 60_000 + 5_000 + 10_000;
  assert.ok(4 * oneActivityWorstMs > QUEUE_TICK_TIMEOUT_MS, 'four failing reads alone outlast the execution timeout');
});

test('the tick interval takes minutes or hours, from 1 minute to 1 hour, and defaults to 5 minutes', () => {
  assert.equal(parseEvery(undefined), 5 * 60_000);
  assert.equal(parseEvery('1m'), 60_000);
  assert.equal(parseEvery('15m'), 15 * 60_000);
  assert.equal(parseEvery('1h'), 60 * 60_000);
  for (const bad of ['30s', '0m', '61m', '2h', '5', 'm', '5 m', '-5m', '1.5h', '']) {
    assert.throws(() => parseEvery(bad), /--every must be/, bad);
  }
});

const FLAGS: QueueFlags = { cap: undefined, every: undefined, base: undefined, repoDir: undefined, hostIntegration: false, executor: undefined };

test('the script arguments: create takes the flags, the other commands take none, nothing else is a command', () => {
  const created = parseQueueArgs(['create'], { ...FLAGS, repoDir: '/work/repo' });
  assert.deepEqual(created, { command: 'create', input: { repoDir: '/work/repo', base: 'main' }, everyMs: 300_000 });
  assert.deepEqual(parseQueueArgs(['create'], { ...FLAGS, repoDir: '/work/repo', cap: '2', every: '10m', base: 'feature/atlas', hostIntegration: true, executor: 'local' }), {
    command: 'create',
    input: { cap: 2, repoDir: '/work/repo', base: 'feature/atlas', hostIntegration: 'auto', executor: 'local' },
    everyMs: 600_000,
  });
  for (const command of ['pause', 'resume', 'delete']) {
    assert.deepEqual(parseQueueArgs([command], FLAGS), { command });
    assert.throws(() => parseQueueArgs([command], { ...FLAGS, cap: '2' }), /takes no flags/, command);
  }
  for (const bad of [[], ['start'], ['create', 'pause'], ['CREATE']]) {
    assert.throws(() => parseQueueArgs(bad, FLAGS), /usage: queue/, JSON.stringify(bad));
  }
  for (const cap of ['0', '11', 'x', '2.5', '-1', '']) {
    assert.throws(() => parseQueueArgs(['create'], { ...FLAGS, repoDir: '/work/repo', cap }), /cap must be/, cap);
  }
  assert.throws(() => parseQueueArgs(['create'], { ...FLAGS, repoDir: '/work/repo', executor: 'cloud' }), /--executor must be local or remote/);
  assert.throws(() => parseQueueArgs(['create'], { ...FLAGS, repoDir: '/work/repo', every: '30s' }), /--every must be/);
});

// ---- a server, and a model of the world ---------------------------------------------------------------------------

let env: TestWorkflowEnvironment;
let client: Client;
let address: string;
let fakesBundle: WorkflowBundleWithSourceMap;
let stubBundle: WorkflowBundleWithSourceMap;
const workers: { worker: Worker; running: Promise<void> }[] = [];

const FAKE_QUEUE = 'queue-watcher-fakes';
const REAL_QUEUE = 'queue-watcher-real';
const NO_WORKER_QUEUE = 'queue-watcher-no-worker';

/** What GitHub and the Temporal side answer in one test. Replaced before each test that uses it. */
class World {
  ready: number[] = [];
  blocked: BlockedReadyIssue[] = [];
  taken: number[] = [];
  untrusted = new Set<number>();
  /** How many numbers `checkTrustedIssues` reads in one call; the rest are `notRead`. */
  trustLimit = 50;
  running: number[] = [];
  otherRuns = 0;
  /** Issue numbers whose `issue-<n>` ID exists (the server rejects a second start): open when also in `running`, closed otherwise. */
  everStarted = new Set<number>();
  /** The list of running runs answers empty, as a visibility store that has not caught up. */
  hideRunning = false;
  /** Issue numbers whose first start does its side effect and then fails, as a worker that dies before the result is recorded. */
  loseResultOnce = new Set<number>();
  /** Activity name to a delay in milliseconds before it answers. */
  delays = new Map<string, number>();
  /** Activity name (or `startQueuedRun:<n>`) to the failure it throws. */
  failures = new Map<string, ApplicationFailure>();
  readonly trustReads: number[][] = [];
  readonly startCalls: StartQueuedRunInput[] = [];
}

let world = new World();

function failIf(name: string): void {
  const failure = world.failures.get(name);
  if (failure !== undefined) {
    throw failure;
  }
}

function fakeGithubReads() {
  return {
    listReadyIssues: async (): Promise<ReadyIssues> => {
      failIf('listReadyIssues');
      return { ready: [...world.ready], blocked: world.blocked };
    },
    listTakenIssues: async (): Promise<TakenIssues> => {
      const delay = world.delays.get('listTakenIssues');
      if (delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      failIf('listTakenIssues');
      return { taken: [...world.taken], untrustedPullRequests: 0 };
    },
    checkTrustedIssues: async (issues: readonly number[]): Promise<TrustedIssues> => {
      failIf('checkTrustedIssues');
      world.trustReads.push([...issues]);
      const sorted = [...issues].sort((a, b) => a - b);
      const read = sorted.slice(0, world.trustLimit);
      return { trusted: read.filter((n) => !world.untrusted.has(n)), untrusted: read.filter((n) => world.untrusted.has(n)), notRead: sorted.slice(world.trustLimit) };
    },
  };
}

function fakeQueueActivities() {
  return {
    listRunningIssues: async (): Promise<RunningIssues> => {
      failIf('listRunningIssues');
      return { running: world.hideRunning ? [] : [...world.running].sort((a, b) => a - b), otherRuns: world.otherRuns };
    },
    startQueuedRun: async (input: StartQueuedRunInput): Promise<StartQueuedRunResult> => {
      world.startCalls.push(input);
      failIf('startQueuedRun');
      failIf(`startQueuedRun:${input.issue}`);
      if (world.running.includes(input.issue)) {
        return { status: 'already_running' };
      }
      if (world.everStarted.has(input.issue)) {
        return { status: 'already_finished' };
      }
      world.everStarted.add(input.issue);
      world.running.push(input.issue);
      if (world.loseResultOnce.delete(input.issue)) {
        throw new Error('simulated: the worker died after the start, before its result was recorded');
      }
      return { status: 'started' };
    },
  };
}

before(async () => {
  const port = await freePort();
  env = await startDevServer({ port, cliPath: loadServerConfig(process.env).cliPath });
  client = env.client;
  address = `127.0.0.1:${port}`;
  fakesBundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH });
  stubBundle = await bundleWorkflowCode({ workflowsPath: STUB_WORKFLOWS_PATH });
  const fakes = await Worker.create({
    connection: env.nativeConnection,
    namespace: 'default',
    taskQueue: FAKE_QUEUE,
    workflowBundle: fakesBundle,
    activities: { ...fakeGithubReads(), ...fakeQueueActivities() },
    maxCachedWorkflows: 0,
  });
  workers.push({ worker: fakes, running: fakes.run() });
  const real = await Worker.create({
    connection: env.nativeConnection,
    namespace: 'default',
    taskQueue: REAL_QUEUE,
    workflowBundle: stubBundle,
    activities: { ...fakeGithubReads(), ...createQueueActivities({ client, taskQueue: REAL_QUEUE }) },
    maxCachedWorkflows: 0,
  });
  workers.push({ worker: real, running: real.run() });
});

after(async () => {
  for (const { worker } of workers) {
    worker.shutdown();
  }
  await Promise.allSettled(workers.map(({ running }) => running));
  await env?.teardown();
});

let ticks = 0;
const lastTickId = (): string => `queue-tick-${ticks}`;

async function tick(queue: string, input: object = { ...RUN, cap: 3 }): Promise<TickReport> {
  ticks += 1;
  const report: unknown = await client.workflow.execute(QUEUE_WATCHER_WORKFLOW_NAME, {
    taskQueue: queue,
    workflowId: `queue-tick-${ticks}`,
    args: [input],
    workflowExecutionTimeout: '2 minutes',
  });
  return report as TickReport;
}

const fakeTick = (input?: object): Promise<TickReport> => tick(FAKE_QUEUE, input);

// ---- layer 1: the tick arithmetic, with fake reads ----------------------------------------------------------------

test('cap 3, 5 eligible issues, none in flight: the lowest 3 start and 2 are reported over the cap', async () => {
  world = new World();
  world.ready = [15, 12, 11, 14, 13];

  const report = await fakeTick();

  assert.deepEqual(report, {
    outcome: 'ok',
    cap: 3,
    inFlight: 0,
    started: [11, 12, 13],
    skipped: [
      { number: 14, reason: 'over_cap' },
      { number: 15, reason: 'over_cap' },
    ],
    skippedNotReported: 0,
    trustNotRead: 0,
  });
  assert.deepEqual(world.startCalls.map((call) => call.issue), [11, 12, 13], 'started in issue-number order');
  assert.deepEqual(world.startCalls[0]?.run, RUN, 'every start carries the run template of the watcher input');
  assert.deepEqual(world.trustReads, [[11, 12, 13, 14, 15]], 'the trust read is asked in ascending order');
});

test('with 2 runs in flight and cap 3, only 1 issue starts', async () => {
  world = new World();
  world.ready = [11, 12, 13];
  world.running = [101, 102];

  const report = await fakeTick();

  assert.equal(report.inFlight, 2);
  assert.deepEqual(report.started, [11]);
  assert.deepEqual(report.skipped, [
    { number: 12, reason: 'over_cap' },
    { number: 13, reason: 'over_cap' },
  ]);
});

test('a full cap starts nothing, and a configured cap of 10 starts up to 10', async () => {
  world = new World();
  world.ready = [11, 12];
  world.running = [101, 102, 103];
  const full = await fakeTick();
  assert.deepEqual(full.started, []);
  assert.deepEqual(full.skipped.map((skip) => skip.reason), ['over_cap', 'over_cap']);
  assert.equal(world.startCalls.length, 0);

  world = new World();
  world.ready = Array.from({ length: 12 }, (_, index) => 20 + index);
  const wide = await fakeTick({ ...RUN, cap: 10 });
  assert.equal(wide.cap, 10);
  assert.deepEqual(wide.started, [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  assert.deepEqual(wide.skipped, [
    { number: 30, reason: 'over_cap' },
    { number: 31, reason: 'over_cap' },
  ]);
});

test('a run open for a person (any open issue run) holds its slot, whatever its ID, and a running ID is taken', async () => {
  world = new World();
  world.ready = [11, 12, 13];
  world.running = [11];
  world.otherRuns = 1;

  const report = await fakeTick();

  assert.equal(report.inFlight, 2, 'one run for issue 11 and one with another ID');
  assert.deepEqual(report.started, [12]);
  assert.deepEqual(report.skipped, [
    { number: 11, reason: 'taken' },
    { number: 13, reason: 'over_cap' },
  ]);
  assert.deepEqual(world.trustReads, [[12, 13]], 'a taken issue costs no trust read');
});

test('blocked, taken and untrusted issues are skipped with their reason and never start', async () => {
  world = new World();
  world.ready = [20, 21, 22];
  world.blocked = [{ number: 23, openBlockers: [5] }];
  world.taken = [21];
  world.untrusted = new Set([22]);

  const report = await fakeTick();

  assert.deepEqual(report.started, [20]);
  assert.deepEqual(report.skipped, [
    { number: 21, reason: 'taken' },
    { number: 22, reason: 'untrusted' },
    { number: 23, reason: 'blocked' },
  ]);
  assert.deepEqual(world.trustReads, [[20, 22]]);
});

test('an issue whose ID already ran is skipped with that reason and does not use a slot', async () => {
  world = new World();
  world.ready = [11, 12, 13, 14];
  world.everStarted.add(11);

  const report = await fakeTick({ ...RUN, cap: 2 });

  assert.deepEqual(report.started, [12, 13]);
  assert.deepEqual(report.skipped, [
    { number: 11, reason: 'id_already_ran' },
    { number: 14, reason: 'over_cap' },
  ]);
});

test('a second tick right after the first starts nothing new for the same issues', async () => {
  world = new World();
  world.ready = [11, 12, 13, 14];
  const first = await fakeTick();
  assert.deepEqual(first.started, [11, 12, 13]);

  const second = await fakeTick();
  assert.deepEqual(second.started, []);
  assert.deepEqual(second.skipped, [
    { number: 11, reason: 'taken' },
    { number: 12, reason: 'taken' },
    { number: 13, reason: 'taken' },
    { number: 14, reason: 'over_cap' },
  ]);
  assert.equal(world.running.length, 3);
});

test('a run list that lags still cannot push the open runs past the cap: an open run the start finds holds a slot', async () => {
  world = new World();
  world.ready = [11, 12, 13, 14];
  const first = await fakeTick();
  assert.deepEqual(first.started, [11, 12, 13]);

  // The visibility store has not caught up, so the list shows no run and the tick sees 3 free slots. The server's refusal of
  // each ID answers `already_running`, and the three refused starts use the three slots, so the fourth issue does not start.
  world.hideRunning = true;
  const stale = await fakeTick();
  assert.equal(stale.inFlight, 0);
  assert.deepEqual(stale.started, []);
  assert.deepEqual(stale.skipped, [
    { number: 11, reason: 'already_running' },
    { number: 12, reason: 'already_running' },
    { number: 13, reason: 'already_running' },
    { number: 14, reason: 'over_cap' },
  ]);
  assert.deepEqual(world.running.sort((a, b) => a - b), [11, 12, 13], 'never more open runs than the cap');
});

test('a start whose result was lost and is retried finds its own run open, and the cap still holds', async () => {
  world = new World();
  world.ready = [11, 12, 13, 14];
  // The first start of 11 creates the run, then its result is lost; the activity is retried and the server refuses the ID.
  world.loseResultOnce.add(11);

  const report = await fakeTick();

  assert.equal(report.outcome, 'ok');
  assert.deepEqual(report.started, [12, 13]);
  assert.deepEqual(report.skipped, [
    { number: 11, reason: 'already_running' },
    { number: 14, reason: 'over_cap' },
  ]);
  assert.deepEqual(world.running.sort((a, b) => a - b), [11, 12, 13], 'three open runs at cap 3, not four');
  assert.deepEqual(world.startCalls.map((call) => call.issue), [11, 11, 12, 13], 'the lost start was retried once');
});

test('every activity of a tick runs with the bounded options: a start-to-close of 2 minutes and 3 attempts (the history shows it)', async () => {
  world = new World();
  world.ready = [11];
  await fakeTick();

  const history = await client.workflow.getHandle(lastTickId()).fetchHistory();
  const scheduled = (history.events ?? []).flatMap((event) => (event.activityTaskScheduledEventAttributes === undefined || event.activityTaskScheduledEventAttributes === null ? [] : [event.activityTaskScheduledEventAttributes]));
  assert.deepEqual(scheduled.map((attributes) => attributes.activityType?.name), ['listReadyIssues', 'listTakenIssues', 'listRunningIssues', 'checkTrustedIssues', 'startQueuedRun']);
  for (const attributes of scheduled) {
    assert.equal(Number(attributes.startToCloseTimeout?.seconds), 120, String(attributes.activityType?.name));
    assert.equal(attributes.retryPolicy?.maximumAttempts, 3, String(attributes.activityType?.name));
  }
  // And the source passes the options to both proxies, so a change that drops them cannot hide behind the constant.
  const source = await readFile(join(SRC_DIR, 'workflows/queue-watcher.ts'), 'utf8');
  assert.equal((source.match(/proxyActivities<[^\n]*>\(QUEUE_ACTIVITY_OPTIONS\)/g) ?? []).length, 2);
});

test('a tick that is still working at its deadline returns a failed report with the step it was in, and starts nothing', async () => {
  world = new World();
  world.ready = [11, 12];
  world.delays.set('listTakenIssues', 4_000);

  const report = await fakeTick({ ...RUN, tickDeadlineMs: 1_000 });

  assert.equal(report.outcome, 'failed');
  assert.deepEqual(report.failure, { step: 'list_taken', reason: TICK_DEADLINE_REASON });
  assert.deepEqual(report.started, []);
  assert.equal(world.startCalls.length, 0);
});

test('a failed read fails the tick, names the step and the failure type, and starts nothing', async () => {
  const steps = {
    listReadyIssues: 'list_ready',
    listTakenIssues: 'list_taken',
    listRunningIssues: 'list_running',
    checkTrustedIssues: 'check_trusted',
  } as const;
  for (const [activity, step] of Object.entries(steps)) {
    world = new World();
    world.ready = [11, 12];
    world.failures.set(activity, ApplicationFailure.nonRetryable(CANARY, 'TooLarge'));

    const report = await fakeTick();

    assert.equal(report.outcome, 'failed', activity);
    assert.deepEqual(report.failure, { step, reason: 'TooLarge' }, activity);
    assert.deepEqual(report.started, [], activity);
    assert.equal(world.startCalls.length, 0, `${activity}: nothing started after a failed read`);
    assert.equal(JSON.stringify(report).includes(CANARY), false, 'the failure message is not in the report');
  }
});

test('a start that fails after its retries ends the tick: the earlier starts are reported, the later issues are not attempted', async () => {
  world = new World();
  world.ready = [11, 12, 13];
  world.failures.set('startQueuedRun:12', ApplicationFailure.nonRetryable(CANARY, 'ServerUnavailable'));

  const report = await fakeTick();

  assert.equal(report.outcome, 'failed');
  assert.deepEqual(report.started, [11]);
  assert.deepEqual(report.failure, { step: 'start', reason: 'ServerUnavailable' });
  assert.deepEqual(world.startCalls.map((call) => call.issue), [11, 12]);
  assert.equal(JSON.stringify(report).includes(CANARY), false);
});

test('Ready numbers the trust read did not reach are untrusted this tick, counted, and never start', async () => {
  world = new World();
  world.ready = [14, 11, 13, 12];
  world.trustLimit = 2;

  const report = await fakeTick({ ...RUN, cap: 10 });

  assert.deepEqual(report.started, [11, 12], 'the lowest numbers were read first');
  assert.deepEqual(report.skipped, [
    { number: 13, reason: 'untrusted' },
    { number: 14, reason: 'untrusted' },
  ]);
  assert.equal(report.trustNotRead, 2);
});

test('an empty Ready column is a quiet tick: nothing is read for trust and nothing starts', async () => {
  world = new World();

  const report = await fakeTick();

  assert.deepEqual(report, { outcome: 'ok', cap: 3, inFlight: 0, started: [], skipped: [], skippedNotReported: 0, trustNotRead: 0 });
  assert.deepEqual(world.trustReads, []);
});

test('a long skip list is bounded and the rest is counted, never dropped silently', async () => {
  world = new World();
  world.blocked = Array.from({ length: MAX_TICK_SKIPS_REPORTED + 20 }, (_, index) => ({ number: 1000 + index, openBlockers: [1] }));

  const report = await fakeTick();

  assert.equal(report.skipped.length, MAX_TICK_SKIPS_REPORTED);
  assert.equal(report.skippedNotReported, 20);
  assert.deepEqual(report.skipped[0], { number: 1000, reason: 'blocked' });
});

test('a bad watcher input fails the workflow before any read, as InvalidInput', async () => {
  world = new World();
  for (const bad of [{ ...RUN, cap: 11 }, { ...RUN, cap: 0 }, { cap: 3 }, 'x']) {
    await assert.rejects(
      tick(FAKE_QUEUE, bad as object),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowFailedError);
        assert.ok(error.cause instanceof Error);
        assert.equal((error.cause as { type?: string }).type, 'InvalidInput');
        return true;
      },
      JSON.stringify(bad),
    );
  }
  assert.equal(world.startCalls.length, 0);
});

// ---- layer 2: the real client activities and real executions ------------------------------------------------------

async function openIssueRuns(): Promise<number[]> {
  const found: number[] = [];
  for await (const info of client.workflow.list({ query: `WorkflowType = "${ISSUE_WORKFLOW_NAME}" AND ExecutionStatus = "Running"` })) {
    found.push(Number(/^issue-(\d+)$/.exec(info.workflowId)?.[1] ?? NaN));
  }
  return found.sort((a, b) => a - b);
}

async function until(what: string, ready: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Sends the stand-in run its release signal and returns the input it was started with. */
async function release(workflowId: string): Promise<IssueWorkflowInput> {
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(maintainerDecisionSignal, { decision: 'approved', at: '2025-01-01' });
  return (await handle.result()) as IssueWorkflowInput;
}

test('real runs: held runs count toward the cap, a second tick starts nothing new, and a closed run is skipped as id_already_ran', async () => {
  world = new World();
  world.ready = [501, 502, 503, 504, 505];
  const input = { ...RUN, cap: 3, hostIntegration: 'auto' };

  const first = await tick(REAL_QUEUE, input);
  assert.deepEqual(first.started, [501, 502, 503]);
  assert.deepEqual(first.skipped, [
    { number: 504, reason: 'over_cap' },
    { number: 505, reason: 'over_cap' },
  ]);
  for (const issue of first.started) {
    assert.equal((await client.workflow.getHandle(issueWorkflowId(issue)).describe()).status.name, 'RUNNING');
  }
  await until('the three runs to be listed', async () => (await openIssueRuns()).length === 3);

  // The three runs are held (the stand-in waits like a run at the gate), so they hold their slots.
  const second = await tick(REAL_QUEUE, input);
  assert.equal(second.inFlight, 3);
  assert.deepEqual(second.started, []);
  assert.deepEqual(second.skipped, [
    { number: 501, reason: 'taken' },
    { number: 502, reason: 'taken' },
    { number: 503, reason: 'taken' },
    { number: 504, reason: 'over_cap' },
    { number: 505, reason: 'over_cap' },
  ]);

  // The run input is the one `npm run run-issue` builds (buildRunInput): the template, and the derived worktree.
  const closedInput = await release(issueWorkflowId(501));
  assert.deepEqual(closedInput, {
    issueNumber: 501,
    repoDir: '/work/repo',
    worktreeDir: '/work/repo/.claude/worktrees/issue-501',
    base: 'main',
    hostIntegration: 'auto',
  });

  // 501 closed and its slot is free: 504 starts. 501 is still Ready here and its ID ran, so it is skipped without a slot.
  await until('the closed run to leave the list', async () => (await openIssueRuns()).length === 2);
  const third = await tick(REAL_QUEUE, input);
  assert.equal(third.inFlight, 2);
  assert.deepEqual(third.started, [504]);
  assert.deepEqual(third.skipped, [
    { number: 501, reason: 'id_already_ran' },
    { number: 502, reason: 'taken' },
    { number: 503, reason: 'taken' },
    { number: 505, reason: 'over_cap' },
  ]);

  for (const issue of [502, 503, 504]) {
    await release(issueWorkflowId(issue));
  }
});

test('the start activity is idempotent by workflow ID, and a bad request is refused as InvalidInput', async () => {
  const activities = createQueueActivities({ client, taskQueue: REAL_QUEUE });

  assert.deepEqual(await activities.startQueuedRun({ issue: 601, run: RUN }), { status: 'started' });
  assert.deepEqual(await activities.startQueuedRun({ issue: 601, run: RUN }), { status: 'already_running' }, 'open: a second start is refused and says the run is open');
  const startedWith = await release(issueWorkflowId(601));
  assert.equal(startedWith.issueNumber, 601);
  assert.equal('hostIntegration' in startedWith, false, 'no host integration unless the template asks');
  assert.deepEqual(await activities.startQueuedRun({ issue: 601, run: RUN }), { status: 'already_finished' }, 'closed: the ID still cannot start again, and says it is closed');

  await assert.rejects(activities.startQueuedRun({ issue: 0, run: RUN }), (error: unknown) => error instanceof ApplicationFailure && error.type === 'InvalidInput');
  await assert.rejects(activities.startQueuedRun({ issue: 602, run: { ...RUN, base: 'a..b' } }), (error: unknown) => error instanceof ApplicationFailure && error.type === 'InvalidInput');
});

test('the in-flight list holds every open issue run, one with another ID too, and none that closed', async () => {
  const activities = createQueueActivities({ client, taskQueue: REAL_QUEUE });
  await activities.startQueuedRun({ issue: 702, run: RUN });
  await activities.startQueuedRun({ issue: 701, run: RUN });
  await client.workflow.start(ISSUE_WORKFLOW_NAME, { taskQueue: REAL_QUEUE, workflowId: 'not-an-issue-id', args: [{}] });
  await until('the three runs to be listed', async () => (await openIssueRuns()).length === 3);

  assert.deepEqual(await activities.listRunningIssues(), { running: [701, 702], otherRuns: 1 });

  await release(issueWorkflowId(701));
  await release('not-an-issue-id');
  await until('the closed runs to leave the list', async () => (await openIssueRuns()).length === 1);
  assert.deepEqual(await activities.listRunningIssues(), { running: [702], otherRuns: 0 });
  await release(issueWorkflowId(702));
});

// ---- the Schedule and the script ----------------------------------------------------------------------------------

test('create makes one Schedule with overlap policy skip, running; a second create changes nothing', async () => {
  const input = { ...RUN, cap: 2 };
  const created = await createQueueSchedule(client, NO_WORKER_QUEUE, input, 600_000);
  assert.deepEqual(created, { status: 'created', scheduleId: QUEUE_SCHEDULE_ID, everyMs: 600_000, cap: 2 });

  try {
    const description = await client.schedule.getHandle(QUEUE_SCHEDULE_ID).describe();
    assert.equal(description.policies.overlap, ScheduleOverlapPolicy.SKIP);
    assert.equal(description.state.paused, false);
    assert.equal(description.action.type, 'startWorkflow');
    assert.equal(description.action.workflowType, QUEUE_WATCHER_WORKFLOW_NAME);
    assert.equal(description.action.taskQueue, NO_WORKER_QUEUE);
    assert.deepEqual(description.action.args, [input]);
    assert.deepEqual(description.spec.intervals?.map((interval) => interval.every), [600_000]);

    assert.deepEqual(await createQueueSchedule(client, NO_WORKER_QUEUE, { ...RUN, cap: 9 }, 60_000), { status: 'already_exists', scheduleId: QUEUE_SCHEDULE_ID });
    const unchanged = await client.schedule.getHandle(QUEUE_SCHEDULE_ID).describe();
    assert.deepEqual(unchanged.action.args, [input], 'the existing schedule keeps its cap');
  } finally {
    await changeQueueSchedule(client, 'delete');
  }
});

test('pause, resume and delete change the Schedule, and a missing one is reported, not an error', async () => {
  assert.deepEqual(await changeQueueSchedule(client, 'pause'), { status: 'not_found', scheduleId: QUEUE_SCHEDULE_ID });
  assert.deepEqual(await changeQueueSchedule(client, 'resume'), { status: 'not_found', scheduleId: QUEUE_SCHEDULE_ID });
  assert.deepEqual(await changeQueueSchedule(client, 'delete'), { status: 'not_found', scheduleId: QUEUE_SCHEDULE_ID });

  await createQueueSchedule(client, NO_WORKER_QUEUE, RUN, 300_000);
  const handle = client.schedule.getHandle(QUEUE_SCHEDULE_ID);
  assert.deepEqual(await changeQueueSchedule(client, 'pause'), { status: 'paused', scheduleId: QUEUE_SCHEDULE_ID });
  assert.equal((await handle.describe()).state.paused, true);
  assert.deepEqual(await changeQueueSchedule(client, 'resume'), { status: 'resumed', scheduleId: QUEUE_SCHEDULE_ID });
  assert.equal((await handle.describe()).state.paused, false);
  assert.deepEqual(await changeQueueSchedule(client, 'delete'), { status: 'deleted', scheduleId: QUEUE_SCHEDULE_ID });
  assert.deepEqual(await changeQueueSchedule(client, 'delete'), { status: 'not_found', scheduleId: QUEUE_SCHEDULE_ID });
});

async function runScript(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(process.execPath, ['--import', 'tsx', 'src/queue.ts', ...args], {
    cwd: ORCHESTRATOR_DIR,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', TEMPORAL_ADDRESS: address, TASK_QUEUE: NO_WORKER_QUEUE },
    timeout: 60_000,
  });
}

test('npm run queue: create, pause, resume and delete work against the server, and a bad flag stops before it connects', async () => {
  const created = JSON.parse((await runScript('create', '--cap', '2', '--every', '10m')).stdout) as { status: string; cap: number; everyMs: number };
  assert.deepEqual(created, { status: 'created', scheduleId: QUEUE_SCHEDULE_ID, everyMs: 600_000, cap: 2 });
  try {
    const handle = client.schedule.getHandle(QUEUE_SCHEDULE_ID);
    const description = await handle.describe();
    assert.equal(description.policies.overlap, ScheduleOverlapPolicy.SKIP, 'the create script sets the overlap policy skip');
    assert.equal(description.state.paused, false);
    assert.equal((description.action.args?.[0] as { cap: number; base: string }).cap, 2);
    assert.equal((description.action.args?.[0] as { cap: number; base: string }).base, 'main');

    assert.deepEqual(JSON.parse((await runScript('pause')).stdout), { status: 'paused', scheduleId: QUEUE_SCHEDULE_ID });
    assert.equal((await handle.describe()).state.paused, true);
    assert.deepEqual(JSON.parse((await runScript('resume')).stdout), { status: 'resumed', scheduleId: QUEUE_SCHEDULE_ID });
    assert.equal((await handle.describe()).state.paused, false);

    const again = await runScript('create');
    assert.deepEqual(JSON.parse(again.stdout), { status: 'already_exists', scheduleId: QUEUE_SCHEDULE_ID });
    assert.match(again.stderr, /already exists; nothing was changed/);
  } finally {
    assert.deepEqual(JSON.parse((await runScript('delete')).stdout), { status: 'deleted', scheduleId: QUEUE_SCHEDULE_ID });
  }
  await assert.rejects(client.schedule.getHandle(QUEUE_SCHEDULE_ID).describe());

  await assert.rejects(runScript('create', '--cap', '11'), (error: unknown) => /cap must be a whole number from 1 to 10/.test(String((error as { stderr?: string }).stderr)));
  await assert.rejects(runScript('start'), (error: unknown) => /usage: queue/.test(String((error as { stderr?: string }).stderr)));
  await assert.rejects(client.schedule.getHandle(QUEUE_SCHEDULE_ID).describe(), 'a refused create made no schedule');
});

// ---- the invariants, read from the code ----------------------------------------------------------------------------

async function sourceFiles(root: string): Promise<{ name: string; text: string }[]> {
  const found: { name: string; text: string }[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sourceFiles(path)));
    } else if (entry.name.endsWith('.ts')) {
      found.push({ name: path.slice(SRC_DIR.length), text: await readFile(path, 'utf8') });
    }
  }
  return found;
}

const QUEUE_FILES = ['workflows/queue-watcher.ts', 'activities/queue.ts', 'queue-types.ts', 'queue-schedule.ts', 'queue.ts'];

test('the watcher and its script never merge, approve, label, resolve a thread or move a board item, and only read the GitHub queue', async () => {
  const sources = await sourceFiles(SRC_DIR);
  assert.deepEqual(forbiddenCalls(sources), []);
  for (const name of QUEUE_FILES) {
    assert.ok(sources.some((file) => file.name === name), `${name} is scanned`);
  }
  for (const name of QUEUE_FILES) {
    const text = sources.find((file) => file.name === name)?.text ?? '';
    // No GitHub write by name, no board activity, and no signal, cancel or terminate to a run that exists (the decision is the maintainer's).
    assert.doesNotMatch(text.replace(/^\s*\/\/.*$/gm, ''), /setStatus|claimIssue|commentIssue|addToBoard|postReview|closeIssue|maintainerDecision|\.signal\(|\.terminate\(|\.cancel\(|signalWithStart/, name);
  }
  const workflow = sources.find((file) => file.name === 'workflows/queue-watcher.ts')?.text ?? '';
  assert.match(workflow, /Pick<GithubActivities, 'listReadyIssues' \| 'checkTrustedIssues' \| 'listTakenIssues'>/);
  // The watcher's activities are registered by the worker.
  assert.match(sources.find((file) => file.name === 'workflows/index.ts')?.text ?? '', /queueWatcher/);
});
