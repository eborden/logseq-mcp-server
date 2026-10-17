// Shapes of the `runClaudeSession` activity (#627), parsed at each trust boundary (foundations 4.2): the input
// that comes from workflow code, and the output of the `claude` process. A session's text output is untrusted
// (it can carry anything a page or an issue told the model), so only a few typed fields are read from it and the
// text itself is never returned, logged or put in an error message.
//
// This file imports nothing from Node, so workflow code may import its types.

export interface SessionInput {
  /** Absolute path of the main checkout the worktree is created from. */
  readonly repoDir: string;
  /** Absolute path of the worktree to create for the session. */
  readonly worktreeDir: string;
  /** The branch to create in the worktree. It is also the idempotency key: one branch, one session. */
  readonly branch: string;
  /** The ref the branch starts from, for example `origin/main`. */
  readonly baseRef: string;
  /** The brief. Passed to `claude` as one argv element, never through a shell. */
  readonly prompt: string;
}

/**
 * How the session ended, as far as this activity can tell.
 * - `success`: the session ran, exited 0 and reported no error.
 * - `error`: the session ran and exited non-zero, or reported `is_error`, or timed out.
 * - `interrupted`: the branch holds a session that started and never finished (a killed worker, a cancel). It may
 *   still be running. No second session was started.
 * - `claimed`: an attempt created this branch and died before it recorded starting a session (or is doing so
 *   right now). No session ran, and none was started now. Nothing here can tell a dead attempt from a live
 *   one, so the workflow or an operator decides (README, "Recovering a stuck branch").
 * - `existing`: the branch (or an open PR's branch) existed and this activity did not create it, so nothing here
 *   says how its session ended. No second session was started.
 */
export type SessionExitStatus = 'success' | 'error' | 'interrupted' | 'claimed' | 'existing';

export interface SessionResult {
  readonly branch: string;
  /** The tip of the branch after the session. */
  readonly headSha: string;
  readonly exitStatus: SessionExitStatus;
}

export const EXIT_STATUSES: readonly SessionExitStatus[] = ['success', 'error', 'interrupted', 'claimed', 'existing'];

export const MAX_PROMPT_CHARS = 100_000;
const MAX_PATH_CHARS = 1024;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// Conservative on purpose: git allows more, but a narrower rule rules out options, whitespace and ref syntax
// (`..`, `@{`, `~`, `^`, `:`) without leaning on git to reject them. The first character is never a dash.
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export class InvalidSessionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSessionInputError';
  }
}

/** A session's output that does not have the shape this activity needs. The message never quotes the output. */
export class MalformedSessionOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedSessionOutputError';
  }
}

export function isSha(value: string): boolean {
  return SHA.test(value);
}

function isRefName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    REF_NAME.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock') &&
    !value.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
  );
}

function absolutePath(name: string, value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > MAX_PATH_CHARS || value.includes('\0')) {
    throw new InvalidSessionInputError(`${name} must be an absolute path`);
  }
  return value;
}

/** Parses untrusted activity input into a SessionInput, or throws InvalidSessionInputError naming the first bad field. */
export function parseSessionInput(raw: unknown): SessionInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new InvalidSessionInputError('input must be an object');
  }
  // Safe: raw is a non-null object here, and every field is type-checked below before it is used.
  const { repoDir, worktreeDir, branch, baseRef, prompt } = raw as Record<string, unknown>;
  const checkedRepoDir = absolutePath('repoDir', repoDir);
  const checkedWorktreeDir = absolutePath('worktreeDir', worktreeDir);
  if (!isRefName(branch)) {
    throw new InvalidSessionInputError('branch must be a plain branch name (letters, digits, dots, dashes, underscores, slashes)');
  }
  if (!isRefName(baseRef)) {
    throw new InvalidSessionInputError('baseRef must be a plain ref name (letters, digits, dots, dashes, underscores, slashes)');
  }
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > MAX_PROMPT_CHARS || prompt.includes('\0')) {
    throw new InvalidSessionInputError(`prompt must be 1 to ${MAX_PROMPT_CHARS} characters`);
  }
  return { repoDir: checkedRepoDir, worktreeDir: checkedWorktreeDir, branch, baseRef, prompt };
}

/** What the activity reads from the stdout of `claude -p --output-format json`. The model's text is left out. */
export interface ClaudeOutput {
  readonly isError: boolean;
}

/** Parses the session's stdout. Throws MalformedSessionOutputError without quoting any of it. */
export function parseClaudeOutput(stdout: string): ClaudeOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new MalformedSessionOutputError('the session did not print one JSON document');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MalformedSessionOutputError('the session output is not a JSON object');
  }
  const type: unknown = 'type' in parsed ? parsed.type : undefined;
  const isError: unknown = 'is_error' in parsed ? parsed.is_error : undefined;
  if (type !== 'result') {
    throw new MalformedSessionOutputError('the session output is not a result document');
  }
  if (typeof isError !== 'boolean') {
    throw new MalformedSessionOutputError('the session output has no boolean is_error');
  }
  return { isError };
}

function isExitStatus(value: unknown): value is SessionExitStatus {
  return EXIT_STATUSES.some((status) => status === value);
}

/** Parses a result that came back untyped (for example from a start by activity name). */
export function parseSessionResult(raw: unknown): SessionResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new MalformedSessionOutputError('result must be an object');
  }
  const branch: unknown = 'branch' in raw ? raw.branch : undefined;
  const headSha: unknown = 'headSha' in raw ? raw.headSha : undefined;
  const exitStatus: unknown = 'exitStatus' in raw ? raw.exitStatus : undefined;
  if (!isRefName(branch) || typeof headSha !== 'string' || !isSha(headSha) || !isExitStatus(exitStatus)) {
    throw new MalformedSessionOutputError('result has a malformed branch, headSha or exitStatus');
  }
  return { branch, headSha, exitStatus };
}

// ---- GitHub activities (#628) ---------------------------------------------------------------------------------

/** The board's Status column, in flow order (CLAUDE.md "Board statuses"). */
export type BoardStatus = 'Backlog' | 'Ready' | 'In progress' | 'In review' | 'Done';

/** The statuses an activity may set. Backlog to Ready is the maintainer's move and is not here on purpose. */
export type SettableStatus = 'In progress' | 'In review' | 'Done';

export interface BlockedReadyIssue {
  readonly number: number;
  /** Numbers of the issues that block it and are still open. */
  readonly openBlockers: readonly number[];
}

/** Only numbers: a title is text from an issue's author and no session should receive it from a list. */
export interface ReadyIssues {
  /** Ready items with no open blocked-by edge, in board order. */
  readonly ready: readonly number[];
  readonly blocked: readonly BlockedReadyIssue[];
}

export interface IssueComment {
  readonly id: number;
  /** The author's GitHub login. */
  readonly author: string;
  readonly createdAt: string;
  readonly body: string;
}

/** An issue as a session may read it. Text from an author who is not an OWNER, MEMBER or COLLABORATOR never gets here. */
export interface IssueView {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly author: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly comments: readonly IssueComment[];
  /** How many comments were dropped for their author. Only the count is kept, never the text. */
  readonly droppedUntrustedComments: number;
}

export type ClaimReason =
  /** This call moved the item from Ready to In progress. */
  | 'claimed'
  /** The item was already In progress. A retry of a claim that succeeded lands here too, so the workflow ID (not this flag) is the claim. */
  | 'already_in_progress'
  | 'open_pr'
  | 'claude_branch'
  /** The item is already In review or Done. */
  | 'already_past_in_progress';

export interface ClaimResult {
  readonly claimed: boolean;
  readonly reason: ClaimReason;
}

export interface SetStatusResult {
  /** False when the item already had the status. */
  readonly changed: boolean;
  readonly status: SettableStatus;
}

export interface OpenPrInput {
  /** A branch named `claude/<issue>` or `claude/<issue>-<slug>`. */
  readonly head: string;
  readonly base: string;
  readonly title: string;
  /** Filled from `.github/pull_request_template.md` by the caller. */
  readonly body: string;
}

export interface OpenPrResult {
  readonly number: number;
  readonly url: string;
  /** False when an open PR for the same head and base was already there. */
  readonly created: boolean;
}

export interface ReviewComment {
  readonly path: string;
  readonly line: number;
  readonly side: 'LEFT' | 'RIGHT';
  readonly body: string;
}

export interface PostReviewInput {
  readonly pr: number;
  /** The head commit the review is about. */
  readonly commitId: string;
  /** Names this review, so a retry finds it instead of posting a second one. */
  readonly idempotencyKey: string;
  /** Must not be empty: the gate counts only reviews with a body. */
  readonly body: string;
  readonly comments: readonly ReviewComment[];
}

export interface PostReviewResult {
  readonly reviewId: number;
  /** False when a review with this key was already on the PR. */
  readonly posted: boolean;
}

export interface GateStatus {
  readonly headSha: string;
  /** Reviews with a non-empty body, by a trusted author, on the head commit. */
  readonly reviewsOnHead: number;
  /** Review threads that are not resolved, whoever started them. */
  readonly unresolvedThreads: number;
  /** `reviewsOnHead >= 1 && unresolvedThreads === 0`. Zero threads with zero reviews is not clear. */
  readonly clear: boolean;
}
