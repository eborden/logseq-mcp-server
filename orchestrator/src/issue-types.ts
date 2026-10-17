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

export interface IssueWorkflowInput {
  readonly issueNumber: number;
  /** Absolute path of the main checkout the worktree is created from. */
  readonly repoDir: string;
  /** Absolute path of the worktree for this issue's session. */
  readonly worktreeDir: string;
  /** The branch the PR targets, for example `main` or `feature/atlas`. The session starts from `origin/<base>`. */
  readonly base: string;
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
  return { issueNumber, repoDir: absolutePath('repoDir', repoDir), worktreeDir: absolutePath('worktreeDir', worktreeDir), base };
}

/** Why a run ended without a PR and without a person having to look. The issue is left as it was found. */
export type SkipReason = 'issue_closed' | 'open_pr' | 'claude_branch' | 'already_past_in_progress';

export type IssueRunResult =
  | {
      readonly outcome: 'in_review';
      readonly issueNumber: number;
      readonly branch: string;
      readonly headSha: string;
      readonly pr: number;
    }
  | { readonly outcome: 'skipped'; readonly issueNumber: number; readonly reason: SkipReason };

/** The steps a run can stop at. Part of the failure comment and of the failure the run ends with. */
export type IssueStep = 'check' | 'claim' | 'confirm_claim' | 'session' | 'open_pr' | 'board_pr' | 'board_issue';

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
    'A person needs to look. Nothing was retried, and nothing was merged or moved on the board past what the steps above did.',
    'The README of the orchestrator says how to recover from each reason.',
  ]
    .filter((line) => line !== '')
    .join('\n\n');
}
