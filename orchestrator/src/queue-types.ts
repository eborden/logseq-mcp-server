// Shapes and bounds of the queue watcher (#723, parent plan #721), in one place that workflow code, the activities and the
// scripts may all import: this file imports nothing from Node. Everything the watcher records is an issue number, a count
// or a fixed word (BR-0001): never a title, a body, a comment or a message.

import type { ActivityOptions } from '@temporalio/workflow';
import { NON_RETRYABLE_GITHUB_FAILURES } from './github-policy.ts';
import { InvalidIssueInputError, parseIssueWorkflowInput } from './issue-types.ts';
import type { Executor, HostIntegrationMode } from './issue-types.ts';
import type { SkipReason } from './queue-policy.ts';

/** The workflow's registered name. The schedule starts it by this name. */
export const QUEUE_WATCHER_WORKFLOW_NAME = 'queueWatcher';

/** The one Schedule that starts the watcher. One ID, so a second `create` is refused instead of stacking a second watcher. */
export const QUEUE_SCHEDULE_ID = 'queue-watcher';

// ---- the cap --------------------------------------------------------------------------------------------------

/** The most runs in flight when the input names no cap. Held runs count (#721): the cap protects remote-session cost and the host slot. */
export const DEFAULT_QUEUE_CAP = 3;
export const MIN_QUEUE_CAP = 1;
export const MAX_QUEUE_CAP = 10;

// ---- the tick interval ------------------------------------------------------------------------------------------

/** The board read is GraphQL through `gh`, so a shorter interval costs rate limit (plan #721). */
export const DEFAULT_TICK_MS = 5 * 60_000;
export const MIN_TICK_MS = 60_000;
export const MAX_TICK_MS = 60 * 60_000;

/**
 * The longest one tick may run, as the schedule's workflow execution timeout. The overlap policy (skip) holds every later
 * tick back while one runs, so this is also the longest a stuck tick can hold the schedule.
 *
 * The sum of the activity retry bounds is far longer than this: one failing read can take 3 attempts of 2 minutes plus
 * backoff (about 6 minutes 15 seconds), a tick makes 4 reads, and then one start attempt per eligible issue (up to 50).
 * Sizing the execution timeout to that would hold the schedule for hours, so the tick bounds itself instead: the workflow
 * gives up at QUEUE_TICK_DEADLINE_MS and returns a failed report (`TickDeadline`, the step it was in), and the execution
 * timeout sits a margin above that deadline, so Temporal never kills a tick before it has answered. A start cut off by the
 * deadline may still have happened; the next tick finds the run open and counts it (`already_running`).
 */
export const QUEUE_TICK_TIMEOUT_MS = 10 * 60_000;
export const QUEUE_TICK_TIMEOUT = '10 minutes';
export const QUEUE_TICK_DEADLINE_MS = 8 * 60_000;
/** The deadline of a tick may be set shorter in the input, for tests; it is never longer than QUEUE_TICK_DEADLINE_MS. */
export const MIN_TICK_DEADLINE_MS = 1_000;
/** The failure type word of a tick that hit its deadline. */
export const TICK_DEADLINE_REASON = 'TickDeadline';

// ---- the activities ------------------------------------------------------------------------------------------

/** Failure types of the queue activities that a retry cannot fix, on top of the GitHub ones. */
export const QUEUE_TOO_MANY_RUNS = 'TooManyRuns';

/**
 * What every activity of a tick gets (amendment of #723): `checkTrustedIssues` makes up to 50 sequential requests and
 * `listTakenIssues` up to a few pages of each list, so two minutes fit with room, and three attempts bound a broken read
 * (Temporal's default is unlimited). A failed tick is only a missed tick: the next one reads again.
 */
export const QUEUE_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: '2 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    nonRetryableErrorTypes: [...NON_RETRYABLE_GITHUB_FAILURES, QUEUE_TOO_MANY_RUNS],
  },
};

/** Most `issueWorkflow` executions `listRunningIssues` reads. A longer list fails the call: an undercount would let the cap be exceeded. */
export const MAX_RUNNING_READ = 200;

// ---- the input -------------------------------------------------------------------------------------------------

export class InvalidQueueInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidQueueInputError';
  }
}

/**
 * What every started run is built from, besides its issue number: the fields `npm run run-issue` takes as flags
 * (`buildRunInput`, src/run-issue-input.ts). The worktree directory is derived per issue there, as `run-issue` does.
 */
export interface QueueRunTemplate {
  /** Absolute path of the main checkout the worktrees are made from. */
  readonly repoDir: string;
  /** The branch each PR targets. */
  readonly base: string;
  readonly hostIntegration?: HostIntegrationMode;
  readonly executor?: Executor;
}

/** The watcher's input, as the schedule stores it. */
export interface QueueWatcherInput extends QueueRunTemplate {
  /** The most runs in flight. Absent means DEFAULT_QUEUE_CAP. */
  readonly cap?: number;
  /** The tick's own deadline in milliseconds, from MIN_TICK_DEADLINE_MS to QUEUE_TICK_DEADLINE_MS. Absent means the latter. Short values are for tests. */
  readonly tickDeadlineMs?: number;
}

export interface ParsedQueueInput {
  readonly cap: number;
  readonly deadlineMs: number;
  readonly run: QueueRunTemplate;
}

/** Parses the watcher's input at its boundary (foundations 4.2). The message never quotes a value. */
export function parseQueueWatcherInput(raw: unknown): ParsedQueueInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidQueueInputError('input must be an object');
  }
  const capRaw: unknown = 'cap' in raw ? raw.cap : undefined;
  const cap = capRaw === undefined ? DEFAULT_QUEUE_CAP : capRaw;
  if (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < MIN_QUEUE_CAP || cap > MAX_QUEUE_CAP) {
    throw new InvalidQueueInputError(`cap must be a whole number from ${MIN_QUEUE_CAP} to ${MAX_QUEUE_CAP}`);
  }
  const deadlineRaw: unknown = 'tickDeadlineMs' in raw ? raw.tickDeadlineMs : undefined;
  const deadlineMs = deadlineRaw === undefined ? QUEUE_TICK_DEADLINE_MS : deadlineRaw;
  if (typeof deadlineMs !== 'number' || !Number.isSafeInteger(deadlineMs) || deadlineMs < MIN_TICK_DEADLINE_MS || deadlineMs > QUEUE_TICK_DEADLINE_MS) {
    throw new InvalidQueueInputError(`tickDeadlineMs must be a whole number from ${MIN_TICK_DEADLINE_MS} to ${QUEUE_TICK_DEADLINE_MS}`);
  }
  return { cap, deadlineMs, run: parseRunTemplate(raw) };
}

/**
 * The run template of a watcher input or a start request. The run input parser is the one the workflow uses, so a template
 * that passes here builds a valid `IssueWorkflowInput` for any issue number (the probe's number and worktree stand in for them).
 */
export function parseRunTemplate(raw: object): QueueRunTemplate {
  const fields: Record<string, unknown> = {};
  for (const name of ['repoDir', 'base', 'hostIntegration', 'executor']) {
    fields[name] = name in raw ? Reflect.get(raw, name) : undefined;
  }
  let probe;
  try {
    probe = parseIssueWorkflowInput({ issueNumber: 1, worktreeDir: fields['repoDir'], ...fields });
  } catch (error) {
    if (error instanceof InvalidIssueInputError) {
      throw new InvalidQueueInputError(error.message);
    }
    throw error;
  }
  return {
    repoDir: probe.repoDir,
    base: probe.base,
    ...(probe.hostIntegration === undefined ? {} : { hostIntegration: probe.hostIntegration }),
    ...(probe.executor === undefined ? {} : { executor: probe.executor }),
  };
}

// ---- the activity shapes -----------------------------------------------------------------------------------

/** The `issueWorkflow` executions that are not closed, as numbers only. */
export interface RunningIssues {
  /** Issue numbers of the open runs whose workflow ID is `issue-<n>`, ascending and without repeats. */
  readonly running: readonly number[];
  /** Open `issueWorkflow` executions with any other ID. They hold a slot but name no issue. */
  readonly otherRuns: number;
}

export interface StartQueuedRunInput {
  readonly issue: number;
  readonly run: QueueRunTemplate;
}

/**
 * What `startQueuedRun` found, as `startIssueRun` tells it. The watcher needs the three apart: an `already_running` run is open
 * and holds a slot (a start whose result was lost and is retried lands here too, as does a run the list had not shown yet), and an
 * `already_finished` one is closed and holds none.
 */
export interface StartQueuedRunResult {
  readonly status: 'started' | 'already_running' | 'already_finished';
}

/** Parses a start request at the activity's boundary. */
export function parseStartQueuedRunInput(raw: unknown): StartQueuedRunInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidQueueInputError('input must be an object');
  }
  const issue: unknown = 'issue' in raw ? raw.issue : undefined;
  if (typeof issue !== 'number' || !Number.isSafeInteger(issue) || issue < 1 || issue > 999_999_999) {
    throw new InvalidQueueInputError('issue must be a positive whole number');
  }
  const run: unknown = 'run' in raw ? raw.run : undefined;
  if (typeof run !== 'object' || run === null || Array.isArray(run)) {
    throw new InvalidQueueInputError('run must be an object');
  }
  return { issue, run: parseRunTemplate(run) };
}

// ---- the tick report ----------------------------------------------------------------------------------------

/**
 * Why a listed Ready issue did not start: the eligibility reasons, then the cap, an open run the start found (`already_running`:
 * it holds a slot) and a closed one (`id_already_ran`: it holds none).
 */
export type TickSkipReason = SkipReason | 'over_cap' | 'already_running' | 'id_already_ran';

export interface TickSkip {
  readonly number: number;
  readonly reason: TickSkipReason;
}

/** Where a failed tick stopped. Nothing is started after a failed read. */
export type TickFailureStep = 'list_ready' | 'list_taken' | 'list_running' | 'check_trusted' | 'start';

/** Most skipped issues one report names. The rest are counted in `skippedNotReported`, never dropped silently (BR-0006). */
export const MAX_TICK_SKIPS_REPORTED = 100;

/** One tick, as the workflow returns it. Numbers, counts and fixed words only. */
export interface TickReport {
  /** `failed` means a read or a start failed after its retries: see `failure`. The tick starts nothing after a failed read. */
  readonly outcome: 'ok' | 'failed';
  readonly cap: number;
  /** Runs in flight when the tick read them, before it started any: every `issueWorkflow` that is not closed, held ones too. */
  readonly inFlight: number;
  /** Issues this tick started, ascending. */
  readonly started: readonly number[];
  readonly skipped: readonly TickSkip[];
  /** Skipped issues the report left out because of the bound on `skipped`. */
  readonly skippedNotReported: number;
  /** Ready issues whose author the tick did not read (the page cap of `checkTrustedIssues`). They are treated as untrusted. */
  readonly trustNotRead: number;
  readonly failure?: { readonly step: TickFailureStep; readonly reason: string };
}
