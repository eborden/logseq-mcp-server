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
import { ScheduleOverlapPolicy, WorkflowFailedError, WorkflowNotFoundError } from '@temporalio/client';
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
  CLOSED_RUN_REASONS,
  MAX_RUN_STATUS_LOOKUPS,
  closedRunReason,
  parseRunStatusesInput,
  PR_BY_HAND_STOP_REASONS,
  PR_BY_HAND_TEXT,
  restartAdvice,
} from '../src/queue-types.ts';
import type {
  QueueRunTemplate,
  RunStatusEntry,
  RunStatuses,
  RunStatusesInput,
  RunningIssues,
  StartQueuedRunInput,
  StartQueuedRunResult,
  TickReport,
} from '../src/queue-types.ts';
import { KNOWN_STOP_REASONS, closedStatusOfName, isParkedStop, stopDetails } from '../src/run-status.ts';
import type { BlockedReadyIssue, ReadyIssues, TakenIssues, TrustedIssues } from '../src/types.ts';
import { forbiddenCalls } from './invariants.ts';
import { freePort } from './support.ts';
import { STUB_FAILURE_MESSAGE, stubFinishSignal } from './workflows/queue-stub.ts';

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

test('a status request is parsed at the boundary: 1 to 20 positive issue numbers, sorted and without repeats', () => {
  assert.equal(MAX_RUN_STATUS_LOOKUPS, 20);
  assert.deepEqual(parseRunStatusesInput({ issues: [13, 11, 13, 12] }), { issues: [11, 12, 13] });
  const twenty = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.equal(parseRunStatusesInput({ issues: twenty }).issues.length, 20);
  for (const bad of [{ issues: [] }, { issues: [...twenty, 21] }, { issues: [0] }, { issues: [1.5] }, { issues: ['12'] }, { issues: 12 }, { issues: [1_000_000_000] }, {}, null, 'x', []]) {
    assert.throws(() => parseRunStatusesInput(bad), InvalidQueueInputError, JSON.stringify(bad));
  }
});

test('a closed run is a fixed word; a completed one is completed_but_open because its issue is still Ready and open', () => {
  assert.deepEqual(CLOSED_RUN_REASONS, ['failed', 'parked', 'terminated', 'timed_out', 'cancelled', 'completed_but_open', 'id_already_ran']);
  assert.equal(closedRunReason('completed'), 'completed_but_open');
  for (const status of ['failed', 'parked', 'terminated', 'timed_out', 'cancelled'] as const) {
    assert.equal(closedRunReason(status), status);
  }
  // Temporal's own names for the closed ends; a run that is open, or continued as new, is not a closed end.
  assert.deepEqual(['COMPLETED', 'FAILED', 'TERMINATED', 'TIMED_OUT', 'CANCELLED', 'RUNNING', 'CONTINUED_AS_NEW', 'UNSPECIFIED', 'x'].map(closedStatusOfName), ['completed', 'failed', 'terminated', 'timed_out', 'cancelled', undefined, undefined, undefined, undefined]);
});

/** The two commands a person runs for issue `n`, in order, as the report gives them. */
const restartOf = (n: number, run = `npm run run-issue -- --issue ${n}`): string[] => [`temporal workflow delete --workflow-id issue-${n}`, run];
const PARKED_RUN = (n: number): string => `npm run run-issue -- --issue ${n} --executor remote --attempt <k>`;

test('the commands for a closed run are fixed text and the issue number, as two strings to paste in order: delete the run first, because a closed run holds its ID', () => {
  for (const reason of ['failed', 'terminated', 'timed_out', 'cancelled'] as const) {
    assert.deepEqual(restartAdvice(12, reason), { restart: restartOf(12) }, reason);
  }
  assert.deepEqual(restartAdvice(12, 'failed', 'SessionError'), { restart: restartOf(12) }, 'a stop that a restart recovers');
  assert.deepEqual(restartAdvice(12, 'parked', 'NeedsInputTimeout'), { restart: restartOf(12, PARKED_RUN(12)) }, 'a parked run is a remote run: it starts again with --executor remote and the next attempt number');
  for (const command of restartOf(12, PARKED_RUN(12))) {
    assert.doesNotMatch(command, /,| then /, 'one command per string, nothing to split before pasting');
  }
  assert.deepEqual(restartAdvice(12, 'completed_but_open'), {}, 'a finished run is not restarted: a person looks at why the issue is still open');
  assert.deepEqual(restartAdvice(12, 'id_already_ran'), {});
});

test('a stop with the PR already open gets the by-hand sentence and no command, one case per reason', () => {
  assert.deepEqual([...PR_BY_HAND_STOP_REASONS], ['MaxRoundsReached', 'ReviewLoopTimeout', 'ReviewNotCounted', 'HeadMismatch', 'MalformedFindings', 'FindingsTooLarge', 'DiffUnreadable', 'FixerPushRejected']);
  for (const reason of PR_BY_HAND_STOP_REASONS) {
    assert.deepEqual(restartAdvice(12, 'failed', reason), { instead: PR_BY_HAND_TEXT }, reason);
    assert.ok(KNOWN_STOP_REASONS.has(reason), `${reason} is a word the report may name`);
  }
  assert.match(PR_BY_HAND_TEXT, /^the PR is open and a restart would end skipped: finish the PR by hand/);
});

test('a stop reason is reported only when it is one of the orchestrator words; a step only as a plain lowercase word', () => {
  assert.deepEqual(stopDetails(['review_loop', 'MaxRoundsReached', 7]), { step: 'review_loop', reason: 'MaxRoundsReached' });
  assert.deepEqual(stopDetails(['session', 'NeedsInput', undefined]), { step: 'session', reason: 'NeedsInput' });
  assert.deepEqual(stopDetails(['review_loop', 'a sentence with spaces']), { step: 'review_loop' });
  assert.deepEqual(stopDetails(['review_loop', 'SomeNewWord']), { step: 'review_loop' });
  assert.deepEqual(stopDetails(['Not A Step', 'MaxRoundsReached']), { reason: 'MaxRoundsReached' });
  assert.deepEqual(stopDetails([42, { text: CANARY }]), {});
  for (const bad of [undefined, null, 'x', 7, {}]) {
    assert.deepEqual(stopDetails(bad), {});
  }
  assert.equal(isParkedStop({ step: 'park', reason: 'NeedsInputTimeout' }), true);
  // A fault at the park step (the park comment or the wait failed after its retries) asked no question: it is failed, not parked.
  assert.equal(isParkedStop({ step: 'park' }), false);
  assert.equal(isParkedStop({ step: 'park', reason: 'ActivityFailed' }), false);
  assert.equal(isParkedStop({ step: 'park', reason: 'GitHubRateLimitExhausted' }), false);
  assert.equal(isParkedStop({ step: 'session', reason: 'NeedsInput' }), true);
  assert.equal(isParkedStop({ step: 'session', reason: 'SessionError' }), false);
  assert.equal(isParkedStop({ step: 'review_loop', reason: 'MaxRoundsReached' }), false);
  assert.equal(isParkedStop({}), false);
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
const BROKEN_QUEUE = 'queue-watcher-broken-client';

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
  /** How a closed run ended, by issue number (#724). An issue with no entry gets no answer from the status read. */
  runStatuses = new Map<number, RunStatusEntry>();
  readonly trustReads: number[][] = [];
  readonly startCalls: StartQueuedRunInput[] = [];
  readonly statusReads: number[][] = [];
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
    readRunStatuses: async (input: RunStatusesInput): Promise<RunStatuses> => {
      const delay = world.delays.get('readRunStatuses');
      if (delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      failIf('readRunStatuses');
      world.statusReads.push([...input.issues]);
      return { runs: input.issues.flatMap((issue) => world.runStatuses.get(issue) ?? []) };
    },
  };
}

/**
 * What the broken client throws from the status read of a run (#724): a Temporal server that is unreachable or a run deleted
 * under the read. Each is a function of the issue's workflow ID and of how many times that handle method was called for it, so a
 * test can break one run and leave the others alone. The start of an issue already calls `describe()` once (it asks how the
 * closed run ended), so a fault meant for the status read starts at the second call.
 */
const faults: { describe?: (workflowId: string, nth: number) => Error | undefined; result?: (workflowId: string, nth: number) => Error | undefined } = {};
const faultCalls = new Map<string, number>();
function faultFor(kind: 'describe' | 'result', workflowId: string): Error | undefined {
  const key = `${kind}:${workflowId}`;
  const nth = (faultCalls.get(key) ?? 0) + 1;
  faultCalls.set(key, nth);
  return faults[kind]?.(workflowId, nth);
}

/** The real client, except that `describe()` and `result()` of a handle throw what `faults` says. The list and the start are the real ones. */
function brokenClient(): Client {
  const workflow = {
    list: (...args: Parameters<Client['workflow']['list']>) => client.workflow.list(...args),
    start: (...args: Parameters<Client['workflow']['start']>) => client.workflow.start(...args),
    getHandle: (workflowId: string, runId?: string) => {
      const handle = client.workflow.getHandle(workflowId, runId);
      return {
        describe: async () => {
          const fault = faultFor('describe', workflowId);
          if (fault !== undefined) {
            throw fault;
          }
          return await handle.describe();
        },
        result: async () => {
          const fault = faultFor('result', workflowId);
          if (fault !== undefined) {
            throw fault;
          }
          return await handle.result();
        },
      };
    },
  };
  return { workflow } as unknown as Client;
}

/** A failure the Temporal client does not make a status of: not a workflow failure and not a missing run. Non-retryable, so the test does not wait out retries. */
const serverDown = (): Error => ApplicationFailure.nonRetryable(CANARY, 'ServerUnavailable');

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
  const broken = await Worker.create({
    connection: env.nativeConnection,
    namespace: 'default',
    taskQueue: BROKEN_QUEUE,
    workflowBundle: stubBundle,
    activities: { ...fakeGithubReads(), ...createQueueActivities({ client: brokenClient(), taskQueue: BROKEN_QUEUE }) },
    maxCachedWorkflows: 0,
  });
  workers.push({ worker: broken, running: broken.run() });
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

// ---- closed runs, by how they ended (#724) -----------------------------------------------------------------------------

/** A Ready issue whose ID already ran, and how the run ended; two fresh issues beside it start as usual. */
async function closedRunTick(issue: number, entry: RunStatusEntry | undefined): Promise<TickReport> {
  world = new World();
  world.ready = [issue, 90, 91];
  world.everStarted.add(issue);
  if (entry !== undefined) {
    world.runStatuses.set(issue, entry);
  }
  return await fakeTick();
}

test('a Ready issue with a failed run is skipped as failed, with its stop reason and the commands; the watcher starts nothing for it', async () => {
  const report = await closedRunTick(11, { issue: 11, status: 'failed', stopReason: 'SessionError' });

  assert.equal(report.outcome, 'ok');
  assert.deepEqual(report.started, [90, 91], 'a closed run holds no slot');
  assert.deepEqual(report.skipped, [{ number: 11, reason: 'failed', stopReason: 'SessionError', restart: restartOf(11) }]);
  assert.deepEqual(report.closedRuns, { counts: { failed: 1 }, notLookedUp: 0 });
  assert.deepEqual(world.statusReads, [[11]]);
  assert.deepEqual(world.startCalls.filter((call) => call.issue === 11).length, 1, 'the one start that found the closed run, and no restart');
  assert.equal(world.running.includes(11), false);
});

test('a failed run that recorded no stop reason of the orchestrator is failed without one', async () => {
  const report = await closedRunTick(11, { issue: 11, status: 'failed' });

  assert.deepEqual(report.skipped, [{ number: 11, reason: 'failed', restart: restartOf(11) }]);
});

test('a failed run that stopped with the PR open is reported with its reason and the by-hand sentence, and no command', async () => {
  const report = await closedRunTick(11, { issue: 11, status: 'failed', stopReason: 'MaxRoundsReached' });

  assert.deepEqual(report.started, [90, 91]);
  assert.deepEqual(report.skipped, [{ number: 11, reason: 'failed', stopReason: 'MaxRoundsReached', instead: PR_BY_HAND_TEXT }]);
  assert.equal('restart' in (report.skipped[0] ?? {}), false);
});

test('a Ready issue with a parked run is reported as parked, with the commands that start it again as a remote run at a next attempt', async () => {
  const report = await closedRunTick(11, { issue: 11, status: 'parked', stopReason: 'NeedsInputTimeout' });

  assert.deepEqual(report.started, [90, 91]);
  assert.deepEqual(report.skipped, [{ number: 11, reason: 'parked', stopReason: 'NeedsInputTimeout', restart: restartOf(11, PARKED_RUN(11)) }]);
  assert.deepEqual(report.closedRuns, { counts: { parked: 1 }, notLookedUp: 0 });
});

test('a Ready issue with a completed run is reported as completed_but_open: the merge did not close the issue', async () => {
  const report = await closedRunTick(11, { issue: 11, status: 'completed' });

  assert.deepEqual(report.started, [90, 91]);
  assert.deepEqual(report.skipped, [{ number: 11, reason: 'completed_but_open' }], 'no command: a person looks at why the issue is still open');
  assert.deepEqual(report.closedRuns, { counts: { completed_but_open: 1 }, notLookedUp: 0 });
});

test('a Ready issue with a terminated run is reported as terminated, with the command', async () => {
  const report = await closedRunTick(11, { issue: 11, status: 'terminated' });

  assert.deepEqual(report.skipped, [{ number: 11, reason: 'terminated', restart: restartOf(11) }]);
  assert.deepEqual(report.closedRuns, { counts: { terminated: 1 }, notLookedUp: 0 });
});

test('a timed out run and a cancelled run are named for what they are, not as failed', async () => {
  for (const status of ['timed_out', 'cancelled'] as const) {
    const report = await closedRunTick(11, { issue: 11, status });

    assert.deepEqual(report.skipped, [{ number: 11, reason: status, restart: restartOf(11) }], status);
    assert.deepEqual(report.closedRuns, { counts: { [status]: 1 }, notLookedUp: 0 }, status);
  }
});

test('a closed run the status read has no answer for keeps id_already_ran, and is counted under it', async () => {
  const report = await closedRunTick(11, undefined);

  assert.deepEqual(report.skipped, [{ number: 11, reason: 'id_already_ran' }]);
  assert.deepEqual(report.closedRuns, { counts: { id_already_ran: 1 }, notLookedUp: 0 });
});

test('a stop reason that is not a plain word is dropped by the workflow, whatever an activity answers', async () => {
  const report = await closedRunTick(11, { issue: 11, status: 'failed', stopReason: `${CANARY} with spaces` });

  assert.equal(report.skipped[0]?.reason, 'failed');
  assert.equal('stopReason' in (report.skipped[0] ?? {}), false);
  assert.equal(JSON.stringify(report).includes(CANARY), false);
});

test('more closed runs than the lookup cap: the lowest are read, the rest keep id_already_ran and the report says how many it did not read', async () => {
  world = new World();
  const closed = Array.from({ length: MAX_RUN_STATUS_LOOKUPS + 5 }, (_, index) => 100 + index);
  world.ready = [...closed].reverse();
  for (const issue of closed) {
    world.everStarted.add(issue);
    world.runStatuses.set(issue, { issue, status: 'failed', stopReason: 'MaxRoundsReached' });
  }

  const report = await fakeTick({ ...RUN, cap: 1 });

  assert.deepEqual(world.statusReads, [closed.slice(0, MAX_RUN_STATUS_LOOKUPS)], 'one read, for the lowest 20');
  assert.deepEqual(report.started, [], 'every start found a closed run');
  assert.equal(report.skipped.length, 25);
  assert.deepEqual(report.skipped.filter((skip) => skip.reason === 'failed').map((skip) => skip.number), closed.slice(0, MAX_RUN_STATUS_LOOKUPS), 'at most 20 issue numbers are named');
  assert.deepEqual(report.skipped.filter((skip) => skip.reason === 'id_already_ran'), closed.slice(MAX_RUN_STATUS_LOOKUPS).map((number) => ({ number, reason: 'id_already_ran' })));
  assert.deepEqual(report.closedRuns, { counts: { failed: 20, id_already_ran: 5 }, notLookedUp: 5 });
  assert.equal(report.outcome, 'ok');
});

test('closed runs of several kinds are counted per reason, in a fixed order', async () => {
  world = new World();
  world.ready = [11, 12, 13, 14, 15];
  for (const [issue, status] of [[11, 'completed'], [12, 'failed'], [13, 'failed'], [14, 'parked']] as const) {
    world.everStarted.add(issue);
    world.runStatuses.set(issue, { issue, status });
  }
  world.everStarted.add(15);

  const report = await fakeTick({ ...RUN, cap: 5 });

  assert.deepEqual(Object.entries(report.closedRuns?.counts ?? {}), [['failed', 2], ['parked', 1], ['completed_but_open', 1], ['id_already_ran', 1]]);
  assert.deepEqual(report.skipped.map((skip) => [skip.number, skip.reason]), [[11, 'completed_but_open'], [12, 'failed'], [13, 'failed'], [14, 'parked'], [15, 'id_already_ran']]);
});

test('a status read that fails after its retries fails the tick at run_status: the starts stay reported, the skips stay id_already_ran, the message stays out', async () => {
  world = new World();
  world.ready = [11, 90];
  world.everStarted.add(11);
  world.failures.set('readRunStatuses', ApplicationFailure.nonRetryable(CANARY, 'TooLarge'));

  const report = await fakeTick();

  assert.equal(report.outcome, 'failed');
  assert.deepEqual(report.failure, { step: 'run_status', reason: 'TooLarge' });
  assert.deepEqual(report.started, [90]);
  assert.deepEqual(report.skipped, [{ number: 11, reason: 'id_already_ran' }]);
  assert.deepEqual(report.closedRuns, { counts: { id_already_ran: 1 }, notLookedUp: 1 });
  assert.equal(JSON.stringify(report).includes(CANARY), false);
});

test('a start that fails ends the tick before any status read: the first failure is the one reported, and the closed run is counted as not looked up', async () => {
  world = new World();
  world.ready = [11, 12, 13];
  world.everStarted.add(11);
  world.runStatuses.set(11, { issue: 11, status: 'failed', stopReason: 'SessionError' });
  world.failures.set('startQueuedRun:12', ApplicationFailure.nonRetryable(CANARY, 'ServerUnavailable'));

  const report = await fakeTick();

  assert.equal(report.outcome, 'failed');
  assert.deepEqual(report.failure, { step: 'start', reason: 'ServerUnavailable' });
  assert.deepEqual(world.statusReads, [], 'no status read after a failed start');
  assert.deepEqual(report.skipped, [{ number: 11, reason: 'id_already_ran' }]);
  assert.deepEqual(report.closedRuns, { counts: { id_already_ran: 1 }, notLookedUp: 1 });
});

test('the status read is covered by the tick deadline: a tick still in it at the deadline reports run_status and what it started', async () => {
  world = new World();
  world.ready = [11, 90];
  world.everStarted.add(11);
  world.delays.set('readRunStatuses', 4_000);

  const report = await fakeTick({ ...RUN, tickDeadlineMs: 1_500 });

  assert.equal(report.outcome, 'failed');
  assert.deepEqual(report.failure, { step: 'run_status', reason: TICK_DEADLINE_REASON });
  assert.deepEqual(report.started, [90]);
});

test('a tick that read a closed run schedules the status read with the same bounded options as every other activity', async () => {
  world = new World();
  world.ready = [11];
  world.everStarted.add(11);
  await fakeTick();

  const history = await client.workflow.getHandle(lastTickId()).fetchHistory();
  const scheduled = (history.events ?? []).flatMap((event) => (event.activityTaskScheduledEventAttributes === undefined || event.activityTaskScheduledEventAttributes === null ? [] : [event.activityTaskScheduledEventAttributes]));
  assert.deepEqual(scheduled.map((attributes) => attributes.activityType?.name), ['listReadyIssues', 'listTakenIssues', 'listRunningIssues', 'checkTrustedIssues', 'startQueuedRun', 'readRunStatuses']);
  for (const attributes of scheduled) {
    assert.equal(Number(attributes.startToCloseTimeout?.seconds), 120, String(attributes.activityType?.name));
    assert.equal(attributes.retryPolicy?.maximumAttempts, 3, String(attributes.activityType?.name));
  }
  assert.equal(world.statusReads.length, 1, 'one read for the tick, not one per issue');
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

test('real runs: held runs count toward the cap, a second tick starts nothing new, and a closed run is skipped without a slot (#724: read as completed_but_open, not id_already_ran)', async () => {
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

  // 501 closed and its slot is free: 504 starts. 501 is still Ready here and its ID ran, so it is skipped without a slot. Its run
  // completed, so since #724 the report says `completed_but_open` (the merge did not close the issue) where #723 said `id_already_ran`.
  await until('the closed run to leave the list', async () => (await openIssueRuns()).length === 2);
  const third = await tick(REAL_QUEUE, input);
  assert.equal(third.inFlight, 2);
  assert.deepEqual(third.started, [504]);
  assert.deepEqual(third.skipped, [
    { number: 501, reason: 'completed_but_open' },
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

// ---- closed runs, read from real executions (#724) --------------------------------------------------------------------

/** Starts the stand-in run of `issue` and ends it the way `how` names (queue-stub.ts), waiting until it has closed. */
async function startAndFinish(activities: ReturnType<typeof createQueueActivities>, issue: number, how: string): Promise<void> {
  assert.deepEqual(await activities.startQueuedRun({ issue, run: RUN }), { status: 'started' });
  const handle = client.workflow.getHandle(issueWorkflowId(issue));
  await handle.signal(stubFinishSignal, how);
  await handle.result().catch(() => undefined);
}

test('the status read tells each way a real run closed, in fixed words, and never reads a failure message', async () => {
  const activities = createQueueActivities({ client, taskQueue: REAL_QUEUE });
  await startAndFinish(activities, 801, 'complete');
  await startAndFinish(activities, 802, 'stop:review_loop:MaxRoundsReached');
  await startAndFinish(activities, 803, 'stop:park:NeedsInputTimeout');
  await startAndFinish(activities, 804, 'stop:session:NeedsInput');
  await startAndFinish(activities, 805, 'crash');
  await startAndFinish(activities, 806, 'stop:review_loop:a sentence with spaces');
  await startAndFinish(activities, 807, 'stop:review_loop:SomeNewWord');
  await startAndFinish(activities, 808, 'stop:guard:ProtectedPath');
  await startAndFinish(activities, 814, 'stop:park:ActivityFailed');

  assert.deepEqual(await activities.startQueuedRun({ issue: 809, run: RUN }), { status: 'started' });
  await client.workflow.getHandle(issueWorkflowId(809)).terminate(STUB_FAILURE_MESSAGE);
  assert.deepEqual(await activities.startQueuedRun({ issue: 810, run: RUN }), { status: 'started' });
  const cancelled = client.workflow.getHandle(issueWorkflowId(810));
  await cancelled.cancel();
  await cancelled.result().catch(() => undefined);
  // A run that hits its execution timeout: started by hand with a short one, as the activity's own start has 50 days.
  await client.workflow.start(ISSUE_WORKFLOW_NAME, { taskQueue: REAL_QUEUE, workflowId: issueWorkflowId(811), args: [{ issueNumber: 811 }], workflowExecutionTimeout: '1 second' });
  await until('the short run to time out', async () => (await client.workflow.getHandle(issueWorkflowId(811)).describe()).status.name === 'TIMED_OUT');
  // Still open: not a closed run, so no answer. Never started: gone, so no answer.
  assert.deepEqual(await activities.startQueuedRun({ issue: 812, run: RUN }), { status: 'started' });

  const found = await activities.readRunStatuses({ issues: [814, 812, 813, 811, 810, 809, 808, 807, 806, 805, 804, 803, 802, 801] });

  assert.deepEqual(found, {
    runs: [
      { issue: 801, status: 'completed' },
      { issue: 802, status: 'failed', stopReason: 'MaxRoundsReached' },
      { issue: 803, status: 'parked', stopReason: 'NeedsInputTimeout' },
      { issue: 804, status: 'parked', stopReason: 'NeedsInput' },
      { issue: 805, status: 'failed' },
      { issue: 806, status: 'failed' },
      { issue: 807, status: 'failed' },
      { issue: 808, status: 'failed', stopReason: 'ProtectedPath' },
      { issue: 809, status: 'terminated' },
      { issue: 810, status: 'cancelled' },
      { issue: 811, status: 'timed_out' },
      { issue: 814, status: 'failed', stopReason: 'ActivityFailed' }, // a fault at the park step asked no question: not parked
    ],
  });
  assert.equal(JSON.stringify(found).includes(STUB_FAILURE_MESSAGE), false, 'no message of a failure reaches the answer');

  await assert.rejects(activities.readRunStatuses({ issues: [] }), (error: unknown) => error instanceof ApplicationFailure && error.type === 'InvalidInput');
  await assert.rejects(activities.readRunStatuses({ issues: Array.from({ length: MAX_RUN_STATUS_LOOKUPS + 1 }, (_, index) => index + 1) }), (error: unknown) => error instanceof ApplicationFailure && error.type === 'InvalidInput');

  await release(issueWorkflowId(812));
});

test('real runs: a tick names a failed, a parked and a completed run by how they ended, restarts none of them, and keeps the history to numbers and fixed words', async () => {
  const activities = createQueueActivities({ client, taskQueue: REAL_QUEUE });
  await startAndFinish(activities, 901, 'complete');
  await startAndFinish(activities, 902, 'stop:review_loop:MaxRoundsReached');
  await startAndFinish(activities, 903, 'stop:park:NeedsInputTimeout');
  world = new World();
  world.ready = [901, 902, 903, 904];

  const report = await tick(REAL_QUEUE, { ...RUN, cap: 3 });

  assert.equal(report.outcome, 'ok');
  assert.deepEqual(report.started, [904]);
  assert.deepEqual(report.skipped, [
    { number: 901, reason: 'completed_but_open' },
    { number: 902, reason: 'failed', stopReason: 'MaxRoundsReached', instead: PR_BY_HAND_TEXT },
    { number: 903, reason: 'parked', stopReason: 'NeedsInputTimeout', restart: restartOf(903, PARKED_RUN(903)) },
  ]);
  assert.deepEqual(report.closedRuns, { counts: { failed: 1, parked: 1, completed_but_open: 1 }, notLookedUp: 0 });
  for (const [issue, status] of [[901, 'COMPLETED'], [902, 'FAILED'], [903, 'FAILED']] as const) {
    assert.equal((await client.workflow.getHandle(issueWorkflowId(issue)).describe()).status.name, status, `issue ${issue} was not started again`);
  }
  assert.deepEqual(await openIssueRuns(), [904]);

  const history = await client.workflow.getHandle(lastTickId()).fetchHistory();
  assert.equal(JSON.stringify(history).includes(STUB_FAILURE_MESSAGE), false, 'no failure message in the tick history');
  assert.equal(JSON.stringify(report).includes(STUB_FAILURE_MESSAGE), false);

  await release(issueWorkflowId(904));
});

/** Runs `body` with the broken client's faults set, and clears them after. */
async function withFaults(set: typeof faults, body: () => Promise<void>): Promise<void> {
  faultCalls.clear();
  Object.assign(faults, set);
  try {
    await body();
  } finally {
    delete faults.describe;
    delete faults.result;
    faultCalls.clear();
  }
}

test('a status read that cannot read a run from the server fails the tick at run_status: an infrastructure error is never read as a status (BR-0003)', async () => {
  const activities = createQueueActivities({ client, taskQueue: REAL_QUEUE });
  await startAndFinish(activities, 1001, 'stop:review_loop:SessionError');
  await startAndFinish(activities, 1003, 'stop:session:SessionError');
  const ids = { describe: issueWorkflowId(1001), result: issueWorkflowId(1003) };
  const cases: { what: string; issues: number[]; set: typeof faults; started: number[]; notLookedUp: number; counts: object }[] = [
    { what: 'describe() fails', issues: [1001, 1002], set: { describe: (id: string, nth: number) => (id === ids.describe && nth >= 2 ? serverDown() : undefined) }, started: [1002], notLookedUp: 1, counts: { id_already_ran: 1 } },
    { what: 'result() of a Failed run fails with a non-workflow error', issues: [1003], set: { result: (id: string) => (id === ids.result ? serverDown() : undefined) }, started: [], notLookedUp: 1, counts: { id_already_ran: 1 } },
  ];
  for (const { what, issues, set, started, notLookedUp, counts } of cases) {
    world = new World();
    world.ready = issues;
    await withFaults(set, async () => {
      const report = await tick(BROKEN_QUEUE, { ...RUN, cap: 3 });

      assert.equal(report.outcome, 'failed', what);
      assert.deepEqual(report.failure, { step: 'run_status', reason: 'ServerUnavailable' }, what);
      assert.deepEqual(report.started, started, `${what}: the starts stay reported`);
      assert.deepEqual(report.skipped.filter((skip) => skip.reason === 'id_already_ran').map((skip) => skip.number), issues.filter((issue) => !started.includes(issue)), what);
      assert.deepEqual(report.closedRuns, { counts, notLookedUp }, what);
      assert.equal(JSON.stringify(report).includes(CANARY), false, 'the failure message is not in the report');
    });
  }
  for (const issue of [1002]) {
    await release(issueWorkflowId(issue));
  }
});

test('a run deleted between the describe and the result is no entry, and the other runs are still read', async () => {
  const activities = createQueueActivities({ client, taskQueue: REAL_QUEUE });
  await startAndFinish(activities, 1004, 'stop:review_loop:SessionError');
  await startAndFinish(activities, 1005, 'stop:review_loop:SessionError');
  world = new World();
  world.ready = [1004, 1005];

  await withFaults({ result: (id) => (id === issueWorkflowId(1004) ? new WorkflowNotFoundError('simulated: deleted', id, undefined) : undefined) }, async () => {
    const report = await tick(BROKEN_QUEUE, { ...RUN, cap: 3 });

    assert.equal(report.outcome, 'ok', 'a deleted run is not a failure');
    assert.deepEqual(report.skipped, [
      { number: 1004, reason: 'id_already_ran' },
      { number: 1005, reason: 'failed', stopReason: 'SessionError', restart: restartOf(1005) },
    ]);
    assert.deepEqual(report.closedRuns, { counts: { failed: 1, id_already_ran: 1 }, notLookedUp: 0 });
  });
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

test('every reason a workflow stops with by name is a word the status read may report, so a new one cannot be dropped from a report unseen (#724)', async () => {
  const sources = (await sourceFiles(SRC_DIR)).filter((file) => file.name.startsWith('workflows/'));
  const found = new Set<string>();
  for (const file of sources) {
    for (const match of file.text.matchAll(/\bstop\(\s*'[a-z_]+',\s*'([A-Z][A-Za-z0-9]+)'/g)) {
      found.add(match[1] ?? '');
    }
  }
  for (const match of (sources.find((file) => file.name === 'workflows/failure-reason.ts')?.text ?? '').matchAll(/return '([A-Z][A-Za-z0-9]+)'/g)) {
    found.add(match[1] ?? '');
  }
  assert.ok(found.size >= 10, `expected the stop reasons of the workflows, found ${found.size}`);
  assert.deepEqual([...found].filter((reason) => !KNOWN_STOP_REASONS.has(reason)), []);
  for (const word of KNOWN_STOP_REASONS) {
    assert.match(word, /^[A-Za-z][A-Za-z0-9]{0,63}$/, 'a reason is a plain type word');
  }
});

test('the status read goes on the same activity proxy and options as the other tick activities, and reads no history, query, update or memo', async () => {
  const sources = await sourceFiles(SRC_DIR);
  const workflow = sources.find((file) => file.name === 'workflows/queue-watcher.ts')?.text ?? '';
  assert.match(workflow, /queue\.readRunStatuses\(/);
  assert.match(workflow, /const queue = proxyActivities<QueueActivities>\(QUEUE_ACTIVITY_OPTIONS\)/);
  const activity = (sources.find((file) => file.name === 'activities/queue.ts')?.text ?? '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(activity, /\.fetchHistory\(|\.query\(|\.executeUpdate\(|\.startUpdate\(|memo/i);
});
