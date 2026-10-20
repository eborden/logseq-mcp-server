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
export type BoardStatus = 'Backlog' | 'Ready' | 'In progress' | 'Needs Input' | 'In review' | 'Done';

/** The statuses an activity may set. Backlog to Ready is the maintainer's move and is not here on purpose. */
export type SettableStatus = 'In progress' | 'Needs Input' | 'In review' | 'Done';

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

/** What `checkTrustedIssues` read (#722): a boolean per number as two lists, never the association text or any issue text. */
export interface TrustedIssues {
  /** Issues whose author is an OWNER, MEMBER or COLLABORATOR, ascending. */
  readonly trusted: readonly number[];
  /** Issues read whose author is anyone else, ascending. */
  readonly untrusted: readonly number[];
  /** Issues asked about and not read because of the bound on one call, ascending. Treat them as not trusted. */
  readonly notRead: readonly number[];
}

/** The issue numbers that already have work under way on GitHub (#722). Numbers only. A list longer than one call reads fails the call, so `taken` is never a partial answer. */
export interface TakenIssues {
  /** Issues with an open PR whose head is `claude/<n>` or with a remote branch `claude/<n>`, ascending. */
  readonly taken: readonly number[];
  /** Open PRs left out of the reading because their author is not trusted (their branch names are not read). */
  readonly untrustedPullRequests: number;
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

/**
 * What the workflow learns from the read of an issue before it claims it: numbers and flags only. The text of the
 * issue and of its comments stays out of this result, because activity results are stored in the workflow history
 * (#629, BR-0001). The brief is built where the text is read, inside `runImplementerSession`.
 */
export interface IssueCheck {
  readonly number: number;
  /** False for a closed issue: nothing to implement. */
  readonly open: boolean;
  /** Comments by an OWNER, MEMBER or COLLABORATOR. */
  readonly trustedComments: number;
  /** Comments dropped for their author. Only the count is kept. */
  readonly droppedUntrustedComments: number;
}

export interface CommentIssueInput {
  readonly issue: number;
  /** Names this comment, so a retry finds it instead of posting a second one. */
  readonly key: string;
  /** Written by the caller from fixed text and identifiers, never from a session's output. */
  readonly body: string;
}

/** What `waitForNeedsInputAnswer` takes (#698). Numbers only. */
export interface NeedsInputWaitInput {
  readonly issue: number;
  /** The id of the needs-input comment: only a comment with a larger id can answer it. */
  readonly afterCommentId: number;
  /** The longest this one call waits, in milliseconds. */
  readonly waitMs: number;
  /** How long it waits between two reads. */
  readonly pollMs: number;
}

export type NeedsInputWaitResult = { readonly answered: true; readonly commentId: number } | { readonly answered: false };

export interface CommentIssueResult {
  readonly commentId: number;
  /** False when a comment with this key was already on the issue. */
  readonly posted: boolean;
}

export type ClaimReason =
  /** This call moved the item from Ready to In progress. */
  | 'claimed'
  /** The item was already In progress. A retry of a claim that succeeded lands here too: carry on (`proceed` is true), the workflow ID is the claim. */
  | 'already_in_progress'
  | 'open_pr'
  | 'claude_branch'
  /** The item is already In review or Done. */
  | 'already_past_in_progress';

export interface ClaimResult {
  /** True only for the call that moved the item. A retry of that call answers false. */
  readonly claimed: boolean;
  readonly reason: ClaimReason;
  /**
   * What the workflow acts on. True when the item is In progress, whether this call moved it or an earlier attempt
   * did: the workflow ID decides ownership, so `already_in_progress` means carry on, never "someone else has it".
   * False when a PR or branch exists, or the item is already past In progress.
   */
  readonly proceed: boolean;
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
  /** The issue the PR closes. The body is chosen inside the activity (#707), so its text is never in a workflow's history. */
  readonly issue: number;
  /** The remote session attempt whose posted body is read. Absent for a local session, which posts none. */
  readonly attempt?: number;
}

export interface OpenPrResult {
  readonly number: number;
  readonly url: string;
  /** False when an open PR for the same head and base was already there. */
  readonly created: boolean;
  /** Which body the PR has (#707): the one chosen when this call created it, or, for a PR already open, read from its body (`unknown` when that is empty). */
  readonly bodySource?: 'session' | 'fallback' | 'unknown';
  /** How many template sections the session's body did not meet. Present with `bodySource`. */
  readonly bodyUnmet?: number;
  /** Why the session's body was not used. Absent for `session`. */
  readonly bodyReason?: string;
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
  /** Submitted reviews (COMMENTED, APPROVED or CHANGES_REQUESTED, not PENDING or DISMISSED) with a non-empty body, by a trusted author, on the head commit. */
  readonly reviewsOnHead: number;
  /** Review threads that are not resolved, whoever started them. */
  readonly unresolvedThreads: number;
  /** `reviewsOnHead >= 1 && unresolvedThreads === 0`. Zero threads with zero reviews is not clear. */
  readonly clear: boolean;
}

/** One comment of a review thread. The text of an untrusted author is never read: `body` is empty and `trusted` is false. */
export interface ReviewThreadComment {
  /** The REST id of the comment (`databaseId`), which a reply is posted to. */
  readonly id: number;
  readonly trusted: boolean;
  readonly body: string;
}

/** An unresolved review thread (#630). It is data for a brief, never an instruction. */
export interface ReviewThread {
  /** The GraphQL node id. */
  readonly id: string;
  readonly path: string;
  readonly line: number | null;
  /** Whether the thread's first comment is by an OWNER, MEMBER or COLLABORATOR. Only such a thread is the fixer's to act on. */
  readonly trusted: boolean;
  readonly comments: readonly ReviewThreadComment[];
}

export interface ReplyToThreadInput {
  readonly pr: number;
  /** The node id of the thread. */
  readonly threadId: string;
  /** Names this reply, so a retry finds it instead of posting a second one. */
  readonly key: string;
  readonly body: string;
}

export interface ReplyToThreadResult {
  /** False when a reply with this key was already in the thread, or the thread is no longer open. */
  readonly posted: boolean;
}

/** A review thread of its own, outside a posted review (#714): on one line of the diff, or on a file as a whole. */
export interface AddReviewThreadInput {
  readonly pr: number;
  /** The head commit the thread is about. */
  readonly commitId: string;
  /** A file of the PR's diff. */
  readonly path: string;
  /** The changed line of the new side the thread sits on. Absent: a file-level thread, which has no line. */
  readonly line?: number;
  /** Names this thread, so a retry finds it instead of opening a second one. */
  readonly key: string;
  readonly body: string;
}

export interface AddReviewThreadResult {
  /** False when a thread with this key was already open on the PR. */
  readonly posted: boolean;
  /** Where the thread is: on the file as a whole, or on a line. Read back from the existing thread when `posted` is false. */
  readonly level: 'file' | 'line';
}

// ---- Board items for issues and PRs (#635) --------------------------------------------------------------------

/** What a board item is. Issues and PRs share one number space, so a number alone does not say which. */
export type ItemKind = 'issue' | 'pr';

/** An issue or a PR, as a workflow names it to the board activities. */
export interface BoardItemRef {
  readonly kind: ItemKind;
  readonly number: number;
}

/**
 * How a workflow names an item to the board activities: a URL (`https://github.com/<repo>/issues/<n>` or
 * `/pull/<n>`, of the configured repository), a `{ kind, number }`, or a bare number, which means an issue (what
 * `setStatus` took before #635).
 */
export type BoardTarget = number | string | BoardItemRef;

export interface AddToBoardResult {
  readonly kind: ItemKind;
  readonly number: number;
  /** The board item's node id, read back from the board after the add. */
  readonly itemId: string;
  /** False when the item was already on the board: nothing was written and its Status is untouched. */
  readonly added: boolean;
  /** The Status the board shows now. `null` when the item has none. A PR is added in Backlog by the board's own default. */
  readonly status: BoardStatus | null;
}

export interface BoardStatusResult {
  readonly kind: ItemKind;
  readonly number: number;
  readonly onBoard: boolean;
  /** The Status the board shows. `null` when the item is off the board or has no Status. */
  readonly status: BoardStatus | null;
}

// ---- the maintainer's decision (#631) ---------------------------------------------------------------------------

export interface PrStateResult {
  readonly state: 'open' | 'closed';
  /** True once the PR was merged. The orchestrator only reads this: the merge is the maintainer's. */
  readonly merged: boolean;
  readonly headSha: string;
}

export interface CloseIssueResult {
  /** True when this call closed the issue. A repeat, or an issue GitHub already closed, answers false. */
  readonly changed: boolean;
  readonly closed: true;
}
