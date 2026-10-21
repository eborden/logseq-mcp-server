// Shapes and bounds of the queue watcher (#723, parent plan #721), in one place that workflow code, the activities and the
// scripts may all import: this file imports nothing from Node. Everything the watcher records is an issue number, a count
// or a fixed word (BR-0001): never a title, a body, a comment or a message.

import type { ActivityOptions } from '@temporalio/workflow';
import { NON_RETRYABLE_GITHUB_FAILURES } from './github-policy.ts';
import { InvalidIssueInputError, parseIssueWorkflowInput } from './issue-types.ts';
import type { Executor, HostIntegrationMode, IssueStep } from './issue-types.ts';
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

/** One minute, the shortest allowed: ready work starts within a minute. The board read is the filtered Ready query, a handful of GraphQL points a tick, plus REST reads that grow with the Ready column, so a shorter interval costs rate limit (plan #721). */
export const DEFAULT_TICK_MS = 60_000;
export const MIN_TICK_MS = 60_000;
export const MAX_TICK_MS = 60 * 60_000;

/**
 * The longest one tick may run, as the schedule's workflow execution timeout. The overlap policy (skip) holds every later
 * tick back while one runs, so this is also the longest a stuck tick can hold the schedule.
 *
 * The sum of the activity retry bounds is far longer than this: one failing read can take 3 attempts of 2 minutes plus
 * backoff (about 6 minutes 15 seconds), a tick makes 4 reads, then one start attempt per eligible issue (up to 50), then 2 more
 * reads (`readRunStatuses` and `listClosedRuns`, each describing up to 20 runs one after another inside one activity).
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

// ---- closed runs (#724) ----------------------------------------------------------------------------------------

/**
 * How a closed `issueWorkflow` run ended, as a fixed word. `parked` is a run that stopped to wait for a person's answer and
 * got none (a Failed run at the step `park`, or at `session` with `NeedsInput`); a parked run that is still waiting is open and
 * holds a slot. `completed` is the run's own end, whatever its outcome.
 */
export type ClosedRunStatus = 'failed' | 'parked' | 'terminated' | 'timed_out' | 'cancelled' | 'completed';

/**
 * What a skipped Ready issue with a closed run reports: the status words, except that `completed` becomes `completed_but_open`.
 * The issue is in the Ready list, so it is still open and still Ready: the run finished and the merge did not close the issue.
 * `id_already_ran` is a closed run the tick did not read.
 */
export type ClosedRunReason = 'id_already_ran' | 'failed' | 'parked' | 'terminated' | 'timed_out' | 'cancelled' | 'completed_but_open';

/** Every closed-run reason, in the order a report lists its counts. */
export const CLOSED_RUN_REASONS: readonly ClosedRunReason[] = ['failed', 'parked', 'terminated', 'timed_out', 'cancelled', 'completed_but_open', 'id_already_ran'];

/**
 * Most closed runs one tick reads the status of. Each read is a call to the Temporal server, so a tick makes at most this
 * many, and the skips that carry a status name at most this many issues. The rest keep `id_already_ran` and are counted in
 * `closedRuns.notLookedUp` (BR-0006: a cap reports what it cut). The lowest numbers are read first.
 */
export const MAX_RUN_STATUS_LOOKUPS = 20;

/**
 * Closed runs whose issue is not in Ready (#733). The run closed after it claimed the issue (or the item left Ready some other
 * way), so the Ready-column read above never meets it. One more bounded read per tick: the visibility list of closed
 * `issueWorkflow` runs, newest first, and the status of at most MAX_CLOSED_NOT_READY of them, which is the same read and the same
 * bound as the Ready case. A `completed` run is not looked for: it is the normal end, and a merged PR leaves nothing to say.
 */
export const MAX_CLOSED_NOT_READY = MAX_RUN_STATUS_LOOKUPS;

/** Most visibility rows one tick reads for it, whatever their issue: the rows of Ready issues and of IDs that are not `issue-<n>` are read and passed over. The rest are counted, not read, and a store that answers oldest first can leave the newest runs among them. */
export const MAX_CLOSED_ROWS_READ = 200;

/** The Ready numbers `listClosedRuns` is told to pass over: at most 50 from `listReadyIssues`, with room to spare. */
export const MAX_CLOSED_EXCLUDED = 100;

/** The reasons a closed run outside Ready can have: the closed ends a person has to look at. The same words as in a Ready skip. */
export type ClosedNotReadyReason = 'failed' | 'parked' | 'terminated' | 'timed_out' | 'cancelled';

/** Every such reason, in the order a report lists its counts. */
export const CLOSED_NOT_READY_REASONS: readonly ClosedNotReadyReason[] = ['failed', 'parked', 'terminated', 'timed_out', 'cancelled'];

export function closedRunReason(status: ClosedRunStatus): ClosedRunReason {
  return status === 'completed' ? 'completed_but_open' : status;
}

/**
 * What a person does about a run that stopped at a step: start it again, carry on by hand because a restart cannot recover it,
 * or fix the PR by hand and re-gate its new head with the resume entry point (#747).
 */
export type StopRecovery = 'restart' | 'by_hand' | 'resume';

/**
 * Where each step a run can stop at leaves the run, and so whether a restart recovers it. The step decides, not the reason:
 * reason words are shared across steps (`SessionError` is a stop at `session` and at `review_session`).
 *
 * `restart`: the steps up to and including `board_issue`. A restart finds the claim answering `already_in_progress` (the item
 * is still In progress) and carries on: a finished session is not run again and an open PR is found (README, "Recovering a
 * stuck run": the `open_pr`, `board_pr` and `board_issue` rows). `guard` is here too, though a remote run can stop at it with
 * the PR already open (`BranchMoved` after the PR opened): its README rows send the person through "Recovering from an orphan
 * remote branch" first, and the restart follows that.
 *
 * `by_hand`: the steps of the review loop and the maintainer's decision. The PR is open and the issue is In review, so a
 * restart ends `skipped` at the claim (`already_past_in_progress`) and never reaches them (README, "Recovering: a stopped
 * review loop is finished by hand"). A `Record` over `IssueStep`, so a new step does not compile until it is placed here.
 *
 * `resume` (#747): the steps whose stop a person mends on the PR and then re-gates with `npm run run-issue -- --issue <n> --resume`
 * (README, "Resuming a stopped gate"): the host integration check, the fix round that comes with it, the resume run's own
 * read, and `decision_comment` (the gate-clear statement or the decision comment failed to post: a re-gate posts it again, keyed).
 * A restart still ends `skipped`, so the advice is the sentence `resumeAdvice` builds, not the restart commands. `decision_gate`
 * stays `by_hand` although a failed read there is recoverable too: the advice is keyed on the step, and the step is shared with
 * `PrClosedUnmerged`, where a resume would be refused (`no_open_pr`). A stop at the other `by_hand` steps (a reviewer that never
 * posted, the loop's own bounds, the merge steps) is not one the resume enters at: it starts at the gate and runs no reviewer
 * or fixer of its own, so those stay by hand.
 */
export const STOP_STEP_RECOVERY: Readonly<Record<IssueStep, StopRecovery>> = {
  check: 'restart',
  claim: 'restart',
  confirm_claim: 'restart',
  session: 'restart',
  park: 'restart',
  guard: 'restart',
  push: 'restart',
  open_pr: 'restart',
  board_pr: 'restart',
  board_issue: 'restart',
  resume: 'resume',
  review_session: 'by_hand',
  review_post: 'by_hand',
  gate: 'by_hand',
  threads: 'by_hand',
  fix_session: 'resume',
  fix_guard: 'resume',
  fix_push: 'resume',
  fix_reply: 'resume',
  host_integration: 'resume',
  review_loop: 'by_hand',
  decision_gate: 'by_hand',
  decision_comment: 'resume',
  merge_wait: 'by_hand',
  board_done: 'by_hand',
  issue_close: 'by_hand',
};

/** True for a step a run can stop at (an `IssueStep`). Any other word a failure's details hold is dropped. */
export function isStopStep(step: string): step is IssueStep {
  return Object.hasOwn(STOP_STEP_RECOVERY, step);
}

/** The fixed text a report gives for a stop at a `by_hand` step of STOP_STEP_RECOVERY. */
export const PR_BY_HAND_TEXT =
  'the PR is already open, so a restart would end skipped: carry on by hand (README, "Recovering a stuck run" and "Recovering: a stopped review loop is finished by hand")';

/**
 * The fixed text a report gives for a stop at a `resume` step of STOP_STEP_RECOVERY (#747): the number of the issue and fixed words.
 * The PR is open and the issue is In review, so a restart would end skipped; the resume entry point re-gates the PR's current head.
 */
export function resumeAdvice(issue: number): string {
  return `the PR is already open, so a restart would end skipped: fix the PR by hand and have its new head reviewed, then re-gate it with "npm run run-issue -- --issue ${issue} --resume" (add --host-integration if the stopped run had it; if a resume already ran for this head, delete its closed run first; README, "Resuming a stopped gate")`;
}

/** What a person does about a closed run: two commands to run in order, or a fixed sentence, or nothing to say. */
export interface RestartAdvice {
  readonly restart?: readonly string[];
  readonly instead?: string;
}

/**
 * What a person does for a closed run, from fixed text and the issue number. A closed run holds its ID (`REJECT_DUPLICATE`),
 * so `run-issue` alone is refused: the run is deleted first (README, "Recovering a stuck run"), and the two commands are
 * separate strings so each can be pasted as it is. `--attempt` does not get round the held ID. It sets the remote
 * implementer's first attempt number, so a parked run (always a remote run) is started again with `--executor remote` and the
 * next attempt (`<k>`: one more than the attempt in the question comment's marker, which the report does not hold). The
 * schedule's other flags (`--base`, `--repo-dir`, `--host-integration`) are the person's to add. A stop at a step after the PR
 * is open (`by_hand` in STOP_STEP_RECOVERY) has no command, only the sentence. A run with no step (a failure that is not a
 * stop) gets the commands. The watcher never runs any of it.
 */
export function restartAdvice(issue: number, reason: ClosedRunReason, stopStep?: string): RestartAdvice {
  if (reason === 'id_already_ran' || reason === 'completed_but_open') {
    return {};
  }
  if (stopStep !== undefined && isStopStep(stopStep) && STOP_STEP_RECOVERY[stopStep] === 'resume') {
    return { instead: resumeAdvice(issue) };
  }
  if (stopStep !== undefined && isStopStep(stopStep) && STOP_STEP_RECOVERY[stopStep] === 'by_hand') {
    return { instead: PR_BY_HAND_TEXT };
  }
  const remove = `temporal workflow delete --workflow-id issue-${issue}`;
  const run = reason === 'parked' ? `npm run run-issue -- --issue ${issue} --executor remote --attempt <k>` : `npm run run-issue -- --issue ${issue}`;
  return { restart: [remove, run] };
}

/** What `readRunStatuses` is asked: closed runs' issue numbers, at most MAX_RUN_STATUS_LOOKUPS. */
export interface RunStatusesInput {
  readonly issues: readonly number[];
}

/** One closed run's status, as numbers and fixed words (BR-0001). `stopReason` is only ever one of the orchestrator's own words. */
export interface RunStatusEntry {
  readonly issue: number;
  readonly status: ClosedRunStatus;
  readonly stopReason?: string;
  /** The step a stopped run ended at, when its failure named one (a plain lowercase word). The report chooses restart or by-hand from it. */
  readonly step?: string;
}

/** The statuses `readRunStatuses` found. An issue whose run is open again, gone or unreadable has no entry. */
export interface RunStatuses {
  readonly runs: readonly RunStatusEntry[];
}

/** Parses a status request at the activity's boundary. */
export function parseRunStatusesInput(raw: unknown): RunStatusesInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidQueueInputError('input must be an object');
  }
  const issues: unknown = 'issues' in raw ? raw.issues : undefined;
  if (!Array.isArray(issues) || issues.length < 1 || issues.length > MAX_RUN_STATUS_LOOKUPS) {
    throw new InvalidQueueInputError(`issues must be a list of 1 to ${MAX_RUN_STATUS_LOOKUPS} numbers`);
  }
  const numbers: number[] = [];
  for (const issue of issues as unknown[]) {
    if (typeof issue !== 'number' || !Number.isSafeInteger(issue) || issue < 1 || issue > 999_999_999) {
      throw new InvalidQueueInputError('every issue must be a positive whole number');
    }
    numbers.push(issue);
  }
  return { issues: [...new Set(numbers)].sort((a, b) => a - b) };
}

/** What `listClosedRuns` is asked: the issue numbers of the Ready column (blocked ones too), whose closed runs the Ready path already reports. */
export interface ClosedRunsInput {
  readonly exclude: readonly number[];
}

/** What `listClosedRuns` found (#733). */
export interface ClosedRuns {
  /** Closed runs of issues that are not in Ready, newest first, at most MAX_CLOSED_NOT_READY, as numbers and fixed words (BR-0001). */
  readonly runs: readonly RunStatusEntry[];
  /**
   * Closed runs the call did not look at (BR-0006): runs of an `issue-<n>` ID it read and did not name because more than
   * MAX_CLOSED_NOT_READY qualified, plus, only when the list went past MAX_CLOSED_ROWS_READ rows, the server's count of the rows
   * beyond the bound (at least 1). A list that ran out gives an exact number and asks for no count. The rows past the bound can
   * include a Ready issue's run or an ID that is not `issue-<n>`, so then it is an upper bound.
   */
  readonly notLookedUp: number;
}

/** Parses a closed-runs request at the activity's boundary. An empty list is fine: no Ready issue to pass over. */
export function parseClosedRunsInput(raw: unknown): ClosedRunsInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidQueueInputError('input must be an object');
  }
  const exclude: unknown = 'exclude' in raw ? raw.exclude : undefined;
  if (!Array.isArray(exclude) || exclude.length > MAX_CLOSED_EXCLUDED) {
    throw new InvalidQueueInputError(`exclude must be a list of at most ${MAX_CLOSED_EXCLUDED} numbers`);
  }
  const numbers: number[] = [];
  for (const issue of exclude as unknown[]) {
    if (typeof issue !== 'number' || !Number.isSafeInteger(issue) || issue < 1 || issue > 999_999_999) {
      throw new InvalidQueueInputError('every excluded issue must be a positive whole number');
    }
    numbers.push(issue);
  }
  return { exclude: [...new Set(numbers)].sort((a, b) => a - b) };
}

// ---- the tick report----------------------------------------------------------------------------------------

/**
 * Why a listed Ready issue did not start: the eligibility reasons, then the cap, an open run the start found (`already_running`:
 * it holds a slot) and a closed one. A closed run holds no slot. It is `id_already_ran` when the tick did not read how it closed
 * (more than MAX_RUN_STATUS_LOOKUPS of them, or the read answered nothing), and otherwise one of the other `ClosedRunReason` words (#724).
 */
export type TickSkipReason = SkipReason | 'over_cap' | 'already_running' | ClosedRunReason;

export interface TickSkip {
  readonly number: number;
  readonly reason: TickSkipReason;
  /** The stop reason the closed run recorded, when it is one of the orchestrator's own fixed words (src/run-status.ts). Never a message. */
  readonly stopReason?: string;
  /** The two commands a person runs, in order, for a closed run a restart recovers: fixed text and the issue number (`restartAdvice`). */
  readonly restart?: readonly string[];
  /** What a person does instead when a restart would not recover the run (`PR_BY_HAND_TEXT`, or `resumeAdvice` for a stop the resume entry point re-gates). */
  readonly instead?: string;
}

/** Where a failed tick stopped. Nothing is started after a failed read. */
export type TickFailureStep = 'list_ready' | 'list_taken' | 'list_running' | 'check_trusted' | 'start' | 'run_status' | 'list_closed';

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
  /** The closed runs the start found (#724). Absent when there were none. */
  readonly closedRuns?: ClosedRunsReport;
  /** The closed runs whose issue is not in Ready (#733). Absent when there are none and the tick left none unread. */
  readonly closedNotReady?: ClosedNotReadyReport;
  readonly failure?: { readonly step: TickFailureStep; readonly reason: string };
}

/** Counts per reason of the Ready issues whose `issue-<n>` run is closed, and how many the tick did not read. The skips name the issues. */
export interface ClosedRunsReport {
  /** Only the reasons that occurred, in the order of CLOSED_RUN_REASONS. `id_already_ran` counts the ones whose status was not read. */
  readonly counts: Readonly<Partial<Record<ClosedRunReason, number>>>;
  /** Closed runs the tick did not ask about: over MAX_RUN_STATUS_LOOKUPS, or after a failure that came before the read. */
  readonly notLookedUp: number;
}

/** One closed run whose issue is not in Ready: the same fields, words and advice as the skip of a closed run in the Ready column (#733). */
export interface ClosedRunNote {
  readonly number: number;
  readonly reason: ClosedNotReadyReason;
  /** The stop reason the run recorded, when it is one of the orchestrator's own fixed words. Never a message. */
  readonly stopReason?: string;
  /** The two commands a person runs, in order, when a restart recovers the run (`restartAdvice`). */
  readonly restart?: readonly string[];
  /** What a person does instead when a restart would not recover it (`PR_BY_HAND_TEXT`, or `resumeAdvice` for a stop the resume entry point re-gates). */
  readonly instead?: string;
}

/** The closed runs outside the Ready column (#733): what the tick read, bounded, and how much it did not. */
export interface ClosedNotReadyReport {
  /** The count of the runs named in `runs` per reason: only the reasons that occurred, in the order of CLOSED_NOT_READY_REASONS. */
  readonly counts: Readonly<Partial<Record<ClosedNotReadyReason, number>>>;
  /** At most MAX_CLOSED_NOT_READY runs, newest first. */
  readonly runs: readonly ClosedRunNote[];
  /** Closed runs the tick did not look at (`ClosedRuns.notLookedUp`). */
  readonly notLookedUp: number;
}
