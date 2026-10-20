// Shapes and bounds of `IssueWorkflow` (#629), in one place that workflow code and the client may both import: this
// file imports nothing from Node. Everything the workflow records in its history is an identifier, a number, a SHA or
// a status (BR-0001): no issue text, no comment text, no model output.

/** The workflow's registered name. The client starts it by this name or by the function; both are the same string. */
export const ISSUE_WORKFLOW_NAME = 'issueWorkflow';

/**
 * The workflow ID is the claim (#628 review): `claimIssue` is read, then write, and an activity cannot see whether
 * another workflow runs for the issue, so exactly one workflow may exist per issue number, and the server rejects a
 * second one. The ID is derived from the number alone.
 */
export function issueWorkflowId(issueNumber: number): string {
  return `issue-${issueNumber}`;
}

/** The branch the implementer works on, derived from the issue number alone so every retry finds the same one. */
export function issueBranch(issueNumber: number): string {
  return `claude/${issueNumber}`;
}

/**
 * The longest the whole run may take. The client sets it as the workflow execution timeout. Before the gate nothing caps
 * the run as a whole except the step bound (2 hours each) and the review loop's own timer; after it, the maintainer's
 * decision and the merge each get at most MAX_DECISION_TIMEOUT_MS (10 days, #631), so 21 days covers the longest wait
 * the input can ask for with room for the work before it, without a park. A run may also park for a person's answer (#698) at most
 * MAX_NEEDS_INPUT_PARKS times, each for at most MAX_NEEDS_INPUT_TIMEOUT_MS (14 days), so the whole run is limited to 50 days.
 */
export const ISSUE_RUN_TIMEOUT = '50 days';
/** The longest any one step may take, retries included (`scheduleToCloseTimeout` of its activities). */
export const ISSUE_STEP_TIMEOUT = '2 hours';
/** How many times the workflow reads the board to confirm an item shows a Status it was just given, and the wait between. */
export const BOARD_CONFIRM_READS = 3;
export const BOARD_CONFIRM_WAIT = '5 seconds';

import {
  MAX_DECISION_POLL_MS,
  MAX_DECISION_TIMEOUT_MS,
  MIN_DECISION_POLL_MS,
  MIN_DECISION_TIMEOUT_MS,
} from './approval-types.ts';
import type { HostIntegrationState } from './integration-policy.ts';
import { MAX_FIX_ROUNDS_LIMIT, MAX_REVIEW_LOOP_TIMEOUT_MS, MIN_REVIEW_LOOP_TIMEOUT_MS } from './review-policy.ts';

export interface IssueWorkflowInput {
  readonly issueNumber: number;
  /** Absolute path of the main checkout the worktree is created from. */
  readonly repoDir: string;
  /** Absolute path of the worktree for this issue's session. */
  readonly worktreeDir: string;
  /** The branch the PR targets, for example `main` or `feature/atlas`. The session starts from `origin/<base>`. */
  readonly base: string;
  /** The most fixer rounds of the review loop. Absent means DEFAULT_MAX_FIX_ROUNDS (src/review-policy.ts). */
  readonly maxFixRounds?: number;
  /** The longest the review loop may take, in milliseconds. Absent means DEFAULT_REVIEW_LOOP_TIMEOUT_MS. */
  readonly reviewLoopTimeoutMs?: number;
  /**
   * False ends the run where #630 ended it: at the gate, with no wait for the maintainer. Absent means true: the run
   * waits for the `maintainerDecision` signal (#631). The tests of the review loop use false.
   */
  readonly awaitDecision?: boolean;
  /** The longest the run waits for the decision, and again for the merge, in milliseconds. Absent means DEFAULT_DECISION_TIMEOUT_MS. */
  readonly decisionTimeoutMs?: number;
  /** How often the run reads GitHub while it waits, in milliseconds. Absent means DEFAULT_DECISION_POLL_MS. */
  readonly decisionPollMs?: number;
  /**
   * `auto` runs the host integration check at the gate when the change needs it (#648, plan #643) and holds the gate until
   * the head shows `success`. `off` (the default when absent) leaves the run exactly as it was before this field existed.
   */
  readonly hostIntegration?: HostIntegrationMode;
  /**
   * Where the model sessions (implementer, reviewer, fixer) run (#671, plan #643). `local` (the default when absent) is v1,
   * unchanged. `remote` runs the implementer (#673), the reviewer (#674) and the fixer (#675) remotely.
   */
  readonly executor?: Executor;
  /**
   * The first attempt number of the remote implementer step (#673), a positive whole number; absent means 1. It is part of the
   * marker key of `runRemoteSession`, so a re-run after a guard refusal starts at the next number and fires fresh instead of
   * re-attaching to the old session. The in-run counter for a dead session goes on from here. Ignored by `local`.
   */
  readonly attempt?: number;
  /** The longest one park for a person's answer waits, in milliseconds (#698). Absent means DEFAULT_NEEDS_INPUT_TIMEOUT_MS. */
  readonly needsInputTimeoutMs?: number;
}

export type HostIntegrationMode = 'auto' | 'off';

export type Executor = 'local' | 'remote';

/** The stop reason of a run that asked for `executor: 'remote'` while no remote session activity is wired. */
export const REMOTE_EXECUTOR_UNAVAILABLE = 'RemoteExecutorUnavailable';

/** The note a run leaves when it could not hide a remote reviewer's raw findings comment (#674). Identifiers and counts only. */
export function findingsCommentNotHiddenComment(workflowId: string, pr: number, round: number): string {
  return [
    `The orchestrator (workflow \`${workflowId}\`) posted its review of PR #${pr} (round ${round}), but could not hide the remote reviewer's raw findings comment on that PR.`,
    'The review is posted and the run goes on. A person can hide that comment by hand: it is the one that starts with the orchestrator-findings marker.',
  ].join('\n\n');
}
/** Stop reasons of the remote implementer step (#673). Identifiers only. */
export const REMOTE_SESSION_CLAIMED = 'RemoteSessionClaimed';
export const REMOTE_LAUNCH_FAILED = 'RemoteLaunchFailed';
export const REMOTE_SESSION_TIMED_OUT = 'RemoteSessionTimedOut';
/** The remote implementer stopped for a person and said so in a needs-input comment (#697). */
export const NEEDS_INPUT = 'NeedsInput';
export const REMOTE_NO_HEAD = 'RemoteSessionNoHead';
/** The park for a person's answer ended with no answer within the limit (#698). */
export const NEEDS_INPUT_TIMEOUT = 'NeedsInputTimeout';

/** The most times one run parks for an answer. A third needs-input stops the run as `NeedsInput`. */
export const MAX_NEEDS_INPUT_PARKS = 2;
/** How long a park waits by default, and the bounds of the run input `needsInputTimeoutMs`. */
export const DEFAULT_NEEDS_INPUT_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
export const MIN_NEEDS_INPUT_TIMEOUT_MS = 1_000;
export const MAX_NEEDS_INPUT_TIMEOUT_MS = 14 * 24 * 60 * 60_000;
/** How often the wait reads the issue's comments, and how long one wait activity runs before the workflow asks again (keeps the history short). */
export const NEEDS_INPUT_POLL_MS = 5 * 60_000;
export const NEEDS_INPUT_WAIT_CHUNK_MS = 60 * 60_000;

/** The board status a parked run shows. The option is looked up by name on the board. */
export const NEEDS_INPUT_BOARD_STATUS = 'Needs Input';

/** The key of the one comment a park posts: the issue's attempt number makes a second park post its own. */
export function needsInputParkCommentKey(attempt: number): string {
  return `needs-input-park-${attempt}`;
}

/** The text of the park comment. Fixed words and identifiers only: it never repeats the session's question. */
export function needsInputParkComment(workflowId: string, attempt: number, timeoutMs: number): string {
  const days = Math.max(1, Math.round(timeoutMs / (24 * 60 * 60_000)));
  return [
    `The orchestrator (workflow \`${workflowId}\`) is waiting for an answer: the session of attempt ${attempt} stopped with a question for a person.`,
    `A comment on this issue answers it. The run reads this issue about every ${NEEDS_INPUT_POLL_MS / 60_000} minutes, and the next comment by a trusted author (OWNER, MEMBER or COLLABORATOR) that is newer than the session's question starts attempt ${attempt + 1}. The run waits at most ${days} day${days === 1 ? '' : 's'}, then stops.`,
  ].join('\n\n');
}
export const REMOTE_BRANCH_MOVED = 'BranchMoved';
/** The stop reason of a remote fixer whose push the guard refuses (#675). The push cannot be undone by the worker: the branch is left for a person. */
export const FIXER_PUSH_REJECTED = 'FixerPushRejected';

/**
 * The detail of the stop comment for a fixer push the guard refused (#675): the reason class (a fixed word) and the counts line
 * the guard gave, never a path. The worker cannot delete or reset a PR's branch, so the text says the branch was left as it is.
 */
export function fixerPushRejectedDetail(branch: string, pr: number, round: number, refusal: string, counts: string | undefined): string {
  return [
    `The remote fixer's push to \`${branch}\` (PR #${pr}, fix round ${round + 1}) was refused by the guard (${refusal}), after it was already on the PR. No review was posted for that commit and no reply was posted.`,
    counts ?? '',
    `The branch was left as it is. A person has to look at the new commits and reset \`${branch}\` to the last reviewed head.`,
  ]
    .filter((line) => line !== '')
    .join(' ');
}

/** The largest `attempt` a run may start at: a marker key per attempt is a git config entry, so the number stays small. */
export const MAX_ATTEMPT = 99;

/** What `run-issue --attempt <n>` adds to the run input: no field without the flag. Anything but a positive whole number is refused. */
export function attemptForFlag(flag: string | undefined): { readonly attempt?: number } {
  if (flag === undefined) {
    return {};
  }
  const attempt = /^[1-9][0-9]{0,2}$/.test(flag) ? Number(flag) : 0;
  if (attempt < 1 || attempt > MAX_ATTEMPT) {
    throw new InvalidIssueInputError(`--attempt must be a whole number from 1 to ${MAX_ATTEMPT}`);
  }
  return { attempt };
}

/** The most remote implementer sessions one run starts: the first, and one more after a session that ended with no push. */
export const REMOTE_IMPLEMENTER_ATTEMPTS = 2;

/** What `run-issue --executor <value>` adds to the run input: no field without the flag (the default is local). Any value but `local` and `remote` is refused. */
export function executorForFlag(flag: string | undefined): { readonly executor?: Executor } {
  if (flag === undefined) {
    return {};
  }
  if (flag !== 'local' && flag !== 'remote') {
    throw new InvalidIssueInputError('--executor must be local or remote');
  }
  return { executor: flag };
}

/** What `run-issue --host-integration` adds to the run input: `auto` with the flag, no field without it (the default is off). */
export function hostIntegrationForFlag(flag: boolean): { readonly hostIntegration?: 'auto' } {
  return flag ? { hostIntegration: 'auto' } : {};
}

export class InvalidIssueInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIssueInputError';
  }
}

const MAX_PATH_CHARS = 1024;
const BASE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

function absolutePath(name: string, value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > MAX_PATH_CHARS || value.includes('\0')) {
    throw new InvalidIssueInputError(`${name} must be an absolute path`);
  }
  return value;
}

/** Parses the workflow's input at its boundary (foundations 4.2). The message never quotes a value. */
export function parseIssueWorkflowInput(raw: unknown): IssueWorkflowInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidIssueInputError('input must be an object');
  }
  const issueNumber: unknown = 'issueNumber' in raw ? raw.issueNumber : undefined;
  const repoDir: unknown = 'repoDir' in raw ? raw.repoDir : undefined;
  const worktreeDir: unknown = 'worktreeDir' in raw ? raw.worktreeDir : undefined;
  const base: unknown = 'base' in raw ? raw.base : undefined;
  if (typeof issueNumber !== 'number' || !Number.isSafeInteger(issueNumber) || issueNumber < 1 || issueNumber > 999_999_999) {
    throw new InvalidIssueInputError('issueNumber must be a positive whole number');
  }
  if (typeof base !== 'string' || !BASE_REF.test(base) || base.includes('..') || base.includes('//') || base.endsWith('/') || base.endsWith('.lock')) {
    throw new InvalidIssueInputError('base must be a plain branch name');
  }
  const maxFixRounds = optionalWholeNumber(raw, 'maxFixRounds', 1, MAX_FIX_ROUNDS_LIMIT);
  const reviewLoopTimeoutMs = optionalWholeNumber(raw, 'reviewLoopTimeoutMs', MIN_REVIEW_LOOP_TIMEOUT_MS, MAX_REVIEW_LOOP_TIMEOUT_MS);
  const decisionTimeoutMs = optionalWholeNumber(raw, 'decisionTimeoutMs', MIN_DECISION_TIMEOUT_MS, MAX_DECISION_TIMEOUT_MS);
  const decisionPollMs = optionalWholeNumber(raw, 'decisionPollMs', MIN_DECISION_POLL_MS, MAX_DECISION_POLL_MS);
  const awaitDecision: unknown = 'awaitDecision' in raw ? raw.awaitDecision : undefined;
  if (awaitDecision !== undefined && typeof awaitDecision !== 'boolean') {
    throw new InvalidIssueInputError('awaitDecision must be true or false');
  }
  const hostIntegration: unknown = 'hostIntegration' in raw ? raw.hostIntegration : undefined;
  if (hostIntegration !== undefined && hostIntegration !== 'auto' && hostIntegration !== 'off') {
    throw new InvalidIssueInputError('hostIntegration must be auto or off');
  }
  const executor: unknown = 'executor' in raw ? raw.executor : undefined;
  if (executor !== undefined && executor !== 'local' && executor !== 'remote') {
    throw new InvalidIssueInputError('executor must be local or remote');
  }
  const attempt = optionalWholeNumber(raw, 'attempt', 1, MAX_ATTEMPT);
  const needsInputTimeoutMs = optionalWholeNumber(raw, 'needsInputTimeoutMs', MIN_NEEDS_INPUT_TIMEOUT_MS, MAX_NEEDS_INPUT_TIMEOUT_MS);
  return {
    issueNumber,
    repoDir: absolutePath('repoDir', repoDir),
    worktreeDir: absolutePath('worktreeDir', worktreeDir),
    base,
    ...(maxFixRounds === undefined ? {} : { maxFixRounds }),
    ...(reviewLoopTimeoutMs === undefined ? {} : { reviewLoopTimeoutMs }),
    ...(awaitDecision === undefined ? {} : { awaitDecision }),
    ...(decisionTimeoutMs === undefined ? {} : { decisionTimeoutMs }),
    ...(decisionPollMs === undefined ? {} : { decisionPollMs }),
    ...(hostIntegration === undefined ? {} : { hostIntegration }),
    ...(executor === undefined ? {} : { executor }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(needsInputTimeoutMs === undefined ? {} : { needsInputTimeoutMs }),
  };
}

function optionalWholeNumber(raw: object, name: string, min: number, max: number): number | undefined {
  const value: unknown = name in raw ? Reflect.get(raw, name) : undefined;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new InvalidIssueInputError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

/** Why a run ended without a PR and without a person having to look. The issue is left as it was found. */
export type SkipReason = 'issue_closed' | 'open_pr' | 'claude_branch' | 'already_past_in_progress';

/**
 * How a run that got a PR ends without a failure (#630). Both are "waiting for the maintainer": the workflow never merges.
 * - `gate_clear`: at least one review on the PR's head and no unresolved thread.
 * - `waiting_for_threads`: every open thread is one the reviewer accepted a reply on (`acceptedThreadIds`) or one the
 *   loop may not act on (an untrusted author's). Only a person resolves a thread, so the gate stays not clear until then.
 * Identifiers and counts only: no review or thread text is ever in a result.
 */
/** Where the PR's body came from (#707): the session's own, or the one generated from the template. Counts and a reason word only. */
export interface PrBodyReport {
  /** `unknown`: the PR was already open and its body is empty or was not reported. */
  readonly source: 'session' | 'fallback' | 'unknown';
  /** How many template sections the session's body did not meet. */
  readonly unmet: number;
  readonly reason?: string;
}

/** What a run ends with. `prBody` (#707) is on every result of a run that opened a PR. */
export type IssueRunResult = IssueRunOutcome & { readonly prBody?: PrBodyReport };

export type IssueRunOutcome =
  | {
      readonly outcome: 'gate_clear';
      readonly issueNumber: number;
      readonly branch: string;
      readonly headSha: string;
      readonly pr: number;
      readonly fixRounds: number;
      readonly reviewsOnHead: number;
      /** Findings of the last review that sit in its body, not in a thread: they do not hold the gate. Counts only. */
      readonly advisory: number;
      /** Advisory findings that did not fit the review body's bound. */
      readonly advisoryOmitted: number;
      /** Remote reviewer rounds whose raw findings comment could not be hidden (#674). Present only for `executor: 'remote'`. The review was posted. */
      readonly rawCommentsNotHidden?: number;
    }
  | {
      readonly outcome: 'waiting_for_threads';
      readonly issueNumber: number;
      readonly branch: string;
      readonly headSha: string;
      readonly pr: number;
      readonly fixRounds: number;
      readonly acceptedThreadIds: readonly string[];
      readonly openThreads: number;
      readonly advisory: number;
      readonly advisoryOmitted: number;
      /** Remote reviewer rounds whose raw findings comment could not be hidden (#674). Present only for `executor: 'remote'`. The review was posted. */
      readonly rawCommentsNotHidden?: number;
    }
  | { readonly outcome: 'skipped'; readonly issueNumber: number; readonly reason: SkipReason }
  /** The maintainer asked for changes (#631). The run commented and stopped; nothing else moved. */
  | {
      readonly outcome: 'changes_requested';
      readonly issueNumber: number;
      readonly pr: number;
      readonly headSha: string;
      readonly ignoredSignals: number;
    }
  /** No decision came in time (#631), or the gate never cleared. The run commented on the PR and stopped. Never an approval. */
  | { readonly outcome: 'decision_timeout'; readonly issueNumber: number; readonly pr: number; readonly headSha: string; readonly ignoredSignals: number }
  /** The maintainer approved, the PR was merged by them, and the run moved the PR and the issue to Done and checked the issue is closed (#631). */
  | {
      readonly outcome: 'merged';
      readonly issueNumber: number;
      readonly pr: number;
      readonly headSha: string;
      /** True when the issue was still open after the PR merged and the run closed it. */
      readonly issueClosedByRun: boolean;
      /** False when the maintainer merged without sending a decision: the run noted that on the PR and carried on to Done. */
      readonly decisionRecorded: boolean;
      readonly ignoredSignals: number;
    }
  /** The maintainer approved and the PR did not merge in time (#631). Nothing was moved to Done. */
  | { readonly outcome: 'merge_timeout'; readonly issueNumber: number; readonly pr: number; readonly headSha: string; readonly ignoredSignals: number };

/** The steps a run can stop at. Part of the failure comment and of the failure the run ends with. */
export type IssueStep =
  | 'check'
  | 'claim'
  | 'confirm_claim'
  | 'session'
  | 'park'
  | 'guard'
  | 'push'
  | 'open_pr'
  | 'board_pr'
  | 'board_issue'
  | 'review_session'
  | 'review_post'
  | 'gate'
  | 'threads'
  | 'fix_session'
  | 'fix_guard'
  | 'fix_push'
  | 'fix_reply'
  | 'host_integration'
  | 'review_loop'
  | 'decision_gate'
  | 'decision_comment'
  | 'merge_wait'
  | 'board_done'
  | 'issue_close';

/**
 * The key of the comment a stop leaves: the step and the reason, both identifiers. With the reason in it, a restarted
 * run that stops at the same step for a different reason still comments, and the same step and reason post once.
 */
export function stopCommentKey(step: IssueStep, reason: StopReason): string {
  return `stopped-${step}-${reason}`;
}

/** The type of the failure a stopped run ends with, so a client or an operator can tell it from a crash. */
export const ISSUE_STOPPED_FAILURE = 'IssueStopped';

/** Failures after which nobody should comment on the issue: it is not ours to talk on, or it is not there. */
export const NO_COMMENT_FAILURES: readonly string[] = ['UntrustedAuthor', 'NotFound'];

export type StopReason = string;

/** The text of the comment a stopped run leaves. Fixed words and identifiers only. */
export function stopComment(workflowId: string, step: IssueStep, reason: StopReason, pr: number | undefined, detail?: string): string {
  return [
    `The orchestrator stopped this run (workflow \`${workflowId}\`) at the step \`${step}\` with the reason \`${reason}\`.`,
    pr === undefined ? '' : `A pull request is open for it: #${pr}.`,
    detail ?? '',
    'A person needs to look. The run has stopped and will not try this step again by itself.',
    'The README of the orchestrator says how to recover from each reason.',
  ]
    .filter((line) => line !== '')
    .join('\n\n');
}

/** The title of the PR the workflow opens: identifiers only. The session's own account of the work is its status comment on the issue. */
export function pullRequestTitle(issueNumber: number): string {
  return `Implement issue #${issueNumber}`;
}

/**
 * The comment a run leaves when every open thread is one it may not act on (#630). Fixed words, counts and thread ids:
 * the workflow never resolves a thread, so this says what a person has to do.
 */
export function waitingForThreadsComment(
  workflowId: string,
  pr: number,
  openThreads: number,
  acceptedThreadIds: readonly string[],
  advisory: number,
  advisoryOmitted: number,
): string {
  return [
    `The orchestrator's review loop (workflow \`${workflowId}\`) has ended for #${pr}, and the merge gate is not clear: ${openThreads} review thread${openThreads === 1 ? ' is' : 's are'} still open.`,
    acceptedThreadIds.length === 0
      ? 'The reviewer accepted the reply on none of them. The ones left are not an author the loop may act on.'
      : `The reviewer accepted the reply on ${acceptedThreadIds.length} of them (thread ids: ${acceptedThreadIds.map((id) => `\`${id}\``).join(', ')}). The others are not an author the loop may act on.`,
    advisory === 0
      ? ''
      : `The last review also has ${advisory + advisoryOmitted} advisory finding${advisory + advisoryOmitted === 1 ? '' : 's'} in its body (${advisoryOmitted} of them not listed there), that could not become a thread (a file the commit does not change, or a thread GitHub did not take). They open no thread, so they do not hold the gate: read the review.`,
    'Only a person resolves a review thread: the workflow never does. Once the threads are resolved, the gate is clear if a review is on the head commit.',
  ]
    .filter((paragraph) => paragraph !== '')
    .join('\n\n');
}

// ---- the exit statements on the PR (#715) ---------------------------------------------------------------------------
//
// A reader of the PR cannot tell from the PR alone whether it is ready to merge, so the run says so on the PR where its
// state changes: the gate is clear for a head, the gate is held by open threads, or the run stopped. Every statement is
// built from counts, SHAs and ids and fixed words (no review, thread or model text), says it is a gate result and not an
// approval, and is keyed so a replay or a retry posts it once. The workflow never decides anything: the maintainer does.

/** What the `host/integration` status showed for the head when the gate cleared. */
export type GateHostLine =
  /** The run did not ask for the check (`hostIntegration` is `off` or absent). */
  | { readonly kind: 'off' }
  /** The run asked for it and the change does not need it. */
  | { readonly kind: 'not_required' }
  /** The check is required and its status was read. */
  | { readonly kind: 'checked'; readonly state: HostIntegrationState; readonly counts?: { readonly passed: number; readonly failed: number } };

export interface GateClearFacts {
  readonly workflowId: string;
  readonly issue: number;
  readonly pr: number;
  readonly headSha: string;
  readonly fixRounds: number;
  readonly reviewsOnHead: number;
  readonly unresolvedThreads: number;
  readonly host: GateHostLine;
  /**
   * Findings of the last review that sit in its body, not in a thread. `undefined` when that review was not on this head (the
   * head moved after the review loop): the statement then says the count is not known for this head.
   */
  readonly advisory: number | undefined;
  /** Advisory findings that did not fit the review body. `undefined` together with `advisory`. */
  readonly advisoryOmitted: number | undefined;
}

/** The key of the gate-clear statement: the PR and the head, so a push gets its own and a retry posts once. */
export function gateClearCommentKey(pr: number, headSha: string): string {
  return `gate-clear-${pr}-${headSha}`;
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function hostLine(host: GateHostLine): string {
  switch (host.kind) {
    case 'off':
      return 'host/integration: not asked for in this run.';
    case 'not_required':
      return 'host/integration: not required for this change.';
    case 'checked':
      return host.counts === undefined
        ? `host/integration: ${host.state}.`
        : `host/integration: ${host.state} (${host.counts.passed} passed, ${host.counts.failed} failed).`;
  }
}

/**
 * The gate-clear statement (#715). Counts, ids and fixed words only. It says this is a gate result and not an approval,
 * and how the maintainer decides. It carries the head, so a statement for an older commit is visibly stale.
 */
export function gateClearComment(facts: GateClearFacts): string {
  const advisory = facts.advisory === undefined || facts.advisoryOmitted === undefined ? undefined : facts.advisory + facts.advisoryOmitted;
  return [
    `**Gate clear** for head \`${facts.headSha}\` of #${facts.pr}, recorded by the orchestrator (workflow \`${facts.workflowId}\`). This is a gate result and not an approval: the orchestrator never approves, merges, labels or resolves anything.`,
    [
      `At this head: ${countOf(facts.reviewsOnHead, 'review')} on the head, ${countOf(facts.unresolvedThreads, 'unresolved review thread')}, ${countOf(facts.fixRounds, 'fix round')} used.`,
      hostLine(facts.host),
      advisory === undefined
        ? 'Advisory findings: not known for this head. The last review that counted them was on an earlier head, so read the reviews on this head.'
        : advisory === 0
          ? 'Advisory findings in the last review: none.'
          : `Advisory findings in the last review: ${advisory} (${facts.advisoryOmitted} not listed in its body). They are in the body of the last review on this head, not in a thread, and they do not hold the gate: read that review.`,
    ].join('\n'),
    `The maintainer decides. From the orchestrator directory, \`npm run signal -- ${facts.issue} approved\` records an approval, and \`npm run signal -- ${facts.issue} changes_requested --message "..."\` asks for changes. The run reads the gate again before it uses a decision.`,
    'A push moves the head and makes this statement stale. The next time the gate is clear on a new head, a new statement is posted for that commit.',
  ].join('\n\n');
}

/** The key of the statement for a gate held by open threads: one per PR and head. */
export function gateHeldCommentKey(pr: number, headSha: string): string {
  return `gate-held-${pr}-${headSha}`;
}

/**
 * The statement for `waiting_for_threads` on the PR (#715): what holds the gate, as counts and thread ids. The issue keeps its
 * own, longer comment. Only a person resolves a thread.
 */
export function gateHeldComment(
  workflowId: string,
  pr: number,
  headSha: string,
  openThreads: number,
  acceptedThreadIds: readonly string[],
  /** Whether the decision stage runs after the review loop (`awaitDecision` is not `false`). */
  decisionStageRuns: boolean,
): string {
  return [
    `**Gate not clear** for head \`${headSha}\` of #${pr}, recorded by the orchestrator (workflow \`${workflowId}\`). This is a gate result and not an approval.`,
    `What holds it: ${countOf(openThreads, 'open review thread')}, ${acceptedThreadIds.length} of them with a reply the reviewer accepted${acceptedThreadIds.length === 0 ? '' : ` (thread ids: ${acceptedThreadIds.map((id) => `\`${id}\``).join(', ')})`}. The loop cannot act on the rest.`,
    decisionStageRuns
      ? 'Only a person resolves a review thread. The run keeps reading the gate, and when it is clear on a head it posts a gate-clear statement for that head.'
      : 'Only a person resolves a review thread. This run ends here and does not read the gate again, so it will post no gate-clear statement: a new run is needed once the threads are resolved.',
  ].join('\n\n');
}

/** The key of the stop line on the PR: the step and the reason, as for the issue's stop comment. */
export function stopPrCommentKey(step: IssueStep, reason: StopReason): string {
  return `stopped-pr-${step}-${reason}`;
}

/** One line on the PR for a stop (#715): the reason and the step. The issue holds the detail. */
export function stopPrComment(workflowId: string, step: IssueStep, reason: StopReason, issue: number): string {
  return `The orchestrator stopped this run (workflow \`${workflowId}\`) at the step \`${step}\` with the reason \`${reason}\`. This is not an approval and the gate is not decided. A person needs to look: the detail is on issue #${issue}.`;
}
