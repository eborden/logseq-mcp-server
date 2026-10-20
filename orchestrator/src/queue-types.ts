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
 * The longest one tick may run, as the schedule's workflow execution timeout. A tick is a handful of reads and starts,
 * each bounded by QUEUE_ACTIVITY_OPTIONS, so ten minutes is generous; the bound keeps a stuck tick from holding the
 * overlap policy (skip) against every later one.
 */
export const QUEUE_TICK_TIMEOUT = '10 minutes';

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
}

export interface ParsedQueueInput {
  readonly cap: number;
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
  return { cap, run: parseRunTemplate(raw) };
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

export interface StartQueuedRunResult {
  /** True when this call started the run. False means the ID `issue-<n>` already exists (open or closed): nothing was started. */
  readonly started: boolean;
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

/** Why a listed Ready issue did not start: the eligibility reasons, then the cap and a run that already used the ID. */
export type TickSkipReason = SkipReason | 'over_cap' | 'id_already_ran';

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
