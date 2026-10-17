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

/** The longest the whole run may take. The client sets it as the workflow execution timeout. */
export const ISSUE_RUN_TIMEOUT = '8 hours';
/** The longest any one step may take, retries included (`scheduleToCloseTimeout` of its activities). */
export const ISSUE_STEP_TIMEOUT = '2 hours';
/** How many times the workflow reads the board to confirm an item shows a Status it was just given, and the wait between. */
export const BOARD_CONFIRM_READS = 3;
export const BOARD_CONFIRM_WAIT = '5 seconds';

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
  return {
    issueNumber,
    repoDir: absolutePath('repoDir', repoDir),
    worktreeDir: absolutePath('worktreeDir', worktreeDir),
    base,
    ...(maxFixRounds === undefined ? {} : { maxFixRounds }),
    ...(reviewLoopTimeoutMs === undefined ? {} : { reviewLoopTimeoutMs }),
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
export type IssueRunResult =
  | {
      readonly outcome: 'gate_clear';
      readonly issueNumber: number;
      readonly branch: string;
      readonly headSha: string;
      readonly pr: number;
      readonly fixRounds: number;
      readonly reviewsOnHead: number;
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
    }
  | { readonly outcome: 'skipped'; readonly issueNumber: number; readonly reason: SkipReason };

/** The steps a run can stop at. Part of the failure comment and of the failure the run ends with. */
export type IssueStep =
  | 'check'
  | 'claim'
  | 'confirm_claim'
  | 'session'
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
  | 'review_loop';

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
export function stopComment(workflowId: string, step: IssueStep, reason: StopReason, pr: number | undefined): string {
  return [
    `The orchestrator stopped this run (workflow \`${workflowId}\`) at the step \`${step}\` with the reason \`${reason}\`.`,
    pr === undefined ? '' : `A pull request is open for it: #${pr}.`,
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
 * The body of the PR the workflow opens, in the sections of `.github/pull_request_template.md`. The workflow knows
 * only identifiers, so it fills what it knows and points at the rest: the implementer session wrote its account (what
 * changed, what it verified and could not verify, its open questions) as a status comment on the issue.
 */
export function pullRequestBody(issueNumber: number, branch: string): string {
  return [
    '## What changed',
    `Opened by the orchestrator for issue #${issueNumber} (workflow \`${issueWorkflowId(issueNumber)}\`) from the branch \`${branch}\`, which an implementer session wrote and pushed.`,
    '',
    `Closes #${issueNumber}`,
    '',
    '## Design',
    "See the issue and the implementer session's status comment on it. The orchestrator does not summarize the work.",
    '',
    '## Assumptions',
    `See the session's status comment on #${issueNumber}.`,
    '',
    '## Failure behavior',
    "See the diff and the session's status comment.",
    '',
    '## Preserved on purpose / questions',
    'None recorded by the orchestrator.',
    '',
    '## New concepts',
    'None recorded by the orchestrator.',
    '',
    '## Test plan',
    '- [ ] Not verified by the orchestrator. A reviewer checks what the issue names, and the maintainer decides the merge.',
    '',
    '## Roll back',
    'Revert the merge commit.',
    '',
  ].join('\n');
}

/**
 * The comment a run leaves when every open thread is one it may not act on (#630). Fixed words, counts and thread ids:
 * the workflow never resolves a thread, so this says what a person has to do.
 */
export function waitingForThreadsComment(workflowId: string, pr: number, openThreads: number, acceptedThreadIds: readonly string[]): string {
  return [
    `The orchestrator's review loop (workflow \`${workflowId}\`) has ended for #${pr}, and the merge gate is not clear: ${openThreads} review thread${openThreads === 1 ? ' is' : 's are'} still open.`,
    acceptedThreadIds.length === 0
      ? 'The reviewer accepted the reply on none of them. The ones left are not an author the loop may act on.'
      : `The reviewer accepted the reply on ${acceptedThreadIds.length} of them (thread ids: ${acceptedThreadIds.map((id) => `\`${id}\``).join(', ')}). The others are not an author the loop may act on.`,
    'Only a person resolves a review thread: the workflow never does. Once the threads are resolved, the gate is clear if a review is on the head commit.',
  ].join('\n\n');
}
