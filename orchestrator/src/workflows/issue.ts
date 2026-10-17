// IssueWorkflow (#629, parent plan #625): one Ready issue to an open PR that is In review on the board. The first half
// of the loop; the reviewer, the fix loop and the gate are #630, and the merge is the maintainer's.
//
// Workflow code is deterministic: no clock, no I/O, no randomness. Every side effect is an activity, each activity is
// bounded (timeouts and a maximum number of attempts, from the policy files), and the history carries identifiers
// only: numbers, SHAs, statuses (BR-0001). The text of the issue is read and put in the brief inside
// `runImplementerSession`, so it never passes through here.
//
// The workflow ID is the claim (issueWorkflowId): the client starts one workflow per issue number and the server
// rejects a second (src/issue-client.ts). `claimIssue` is read, then write, and cannot see another workflow, so that
// ID, not the board, keeps two runs off one issue.
//
// Steps, in order. A permanent failure at any of them comments on the issue (once, keyed by the step) and ends the
// run as a Failed workflow: a failed premise is never retried.
//   check        checkIssue: a trusted-author read; a closed issue is skipped
//   claim        claimIssue: acts on `proceed`, never on `claimed` alone
//   confirm      the board shows In progress (the claim's own write is not read back by the claim)
//   session      runImplementerSession: the brief, then one `claude -p` session on the branch `claude/<n>`
//   open_pr      openPr
//   board_pr     addToBoard, setStatus In review, getBoardStatus: the PR is In review with no manual step
//   board_issue  setStatus In review for the issue, getBoardStatus
// It never merges, never labels, never resolves a thread and never moves an item to Ready or Backlog.

import {
  ActivityFailure,
  ApplicationFailure,
  TimeoutFailure,
  isCancellation,
  proxyActivities,
  sleep,
} from '@temporalio/workflow';
import type { GithubActivities } from '../activities/github.ts';
import type { ImplementerActivities } from '../activities/implementer.ts';
import { BOARD_ACTIVITY_OPTIONS } from '../board-policy.ts';
import { CLAUDE_SESSION_ACTIVITY_OPTIONS } from '../claude-session-policy.ts';
import { GITHUB_ACTIVITY_OPTIONS } from '../github-policy.ts';
import {
  BOARD_CONFIRM_READS,
  BOARD_CONFIRM_WAIT,
  ISSUE_STEP_TIMEOUT,
  ISSUE_STOPPED_FAILURE,
  InvalidIssueInputError,
  NO_COMMENT_FAILURES,
  issueBranch,
  issueWorkflowId,
  parseIssueWorkflowInput,
  pullRequestBody,
  pullRequestTitle,
  stopComment,
} from '../issue-types.ts';
import type { IssueRunResult, IssueStep, SkipReason, StopReason } from '../issue-types.ts';
import type { BoardItemRef, SessionExitStatus, SettableStatus } from '../types.ts';

const github = proxyActivities<Pick<GithubActivities, 'checkIssue' | 'claimIssue' | 'openPr' | 'commentIssue'>>({
  ...GITHUB_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});
const board = proxyActivities<Pick<GithubActivities, 'addToBoard' | 'getBoardStatus' | 'setStatus'>>({
  ...BOARD_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});
const implementer = proxyActivities<ImplementerActivities>({
  ...CLAUDE_SESSION_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});

/** What a session that did not finish with `success` means. Each needs a person: nothing here starts a second session. */
const SESSION_STOP_REASONS: Readonly<Record<Exclude<SessionExitStatus, 'success'>, StopReason>> = {
  error: 'SessionError',
  interrupted: 'SessionInterrupted',
  claimed: 'SessionClaimed',
  existing: 'SessionExistingBranch',
};

const SKIP_REASONS: readonly string[] = ['open_pr', 'claude_branch', 'already_past_in_progress'];

function isSkipReason(reason: string): reason is SkipReason {
  return SKIP_REASONS.includes(reason);
}

/** The type of the failure under an activity failure, as a plain word. Never the message: it can name a path or a PR. */
function failureReason(error: unknown): StopReason {
  const cause = error instanceof ActivityFailure ? error.cause : error;
  if (cause instanceof ApplicationFailure && typeof cause.type === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(cause.type)) {
    return cause.type;
  }
  if (cause instanceof TimeoutFailure) {
    return 'ActivityTimeout';
  }
  return 'ActivityFailed';
}

export async function issueWorkflow(rawInput: unknown): Promise<IssueRunResult> {
  let input;
  try {
    input = parseIssueWorkflowInput(rawInput);
  } catch (error) {
    if (error instanceof InvalidIssueInputError) {
      throw ApplicationFailure.nonRetryable(error.message, 'InvalidInput');
    }
    throw error;
  }
  const issue = input.issueNumber;
  const workflowId = issueWorkflowId(issue);
  const branch = issueBranch(issue);
  let pr: number | undefined;

  /** Ends the run: one comment on the issue (unless it is not ours to comment on), then a Failed workflow. */
  async function stop(step: IssueStep, reason: StopReason): Promise<never> {
    if (!NO_COMMENT_FAILURES.includes(reason)) {
      try {
        await github.commentIssue({ issue, key: `stopped-${step}`, body: stopComment(workflowId, step, reason, pr) });
      } catch (commentError) {
        if (isCancellation(commentError)) {
          throw commentError;
        }
        // The stop matters more than the comment: the run still ends Failed, with the reason in its failure.
      }
    }
    throw ApplicationFailure.nonRetryable(`stopped at ${step}: ${reason}`, ISSUE_STOPPED_FAILURE, step, reason, pr);
  }

  /** Runs one activity call; any failure of it ends the run at `step`, and a cancellation passes through. */
  async function step<T>(name: IssueStep, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (isCancellation(error)) {
        throw error;
      }
      return await stop(name, failureReason(error));
    }
  }

  /** Reads the board (not trusting the write) until it shows `wanted`, a bounded number of times. */
  async function confirmStatus(name: IssueStep, target: BoardItemRef, wanted: SettableStatus): Promise<void> {
    for (let read = 1; read <= BOARD_CONFIRM_READS; read += 1) {
      const seen = await step(name, () => board.getBoardStatus(target));
      if (seen.onBoard && seen.status === wanted) {
        return;
      }
      if (read < BOARD_CONFIRM_READS) {
        await sleep(BOARD_CONFIRM_WAIT);
      }
    }
    return await stop(name, 'BoardDisagrees');
  }

  const check = await step('check', () => github.checkIssue(issue));
  if (!check.open) {
    return { outcome: 'skipped', issueNumber: issue, reason: 'issue_closed' };
  }

  // Act on `proceed`: a retry of a claim that already moved the item answers `claimed: false, proceed: true`.
  const claim = await step('claim', () => github.claimIssue(issue));
  if (!claim.proceed) {
    return isSkipReason(claim.reason)
      ? { outcome: 'skipped', issueNumber: issue, reason: claim.reason }
      : await stop('claim', 'UnexpectedClaimAnswer');
  }
  await confirmStatus('confirm_claim', { kind: 'issue', number: issue }, 'In progress');

  const session = await step('session', () => implementer.runImplementerSession(input));
  if (session.exitStatus !== 'success') {
    return await stop('session', SESSION_STOP_REASONS[session.exitStatus]);
  }

  const opened = await step('open_pr', () =>
    github.openPr({ head: branch, base: input.base, title: pullRequestTitle(issue), body: pullRequestBody(issue, branch) }),
  );
  pr = opened.number;

  const prItem: BoardItemRef = { kind: 'pr', number: opened.number };
  await step('board_pr', () => board.addToBoard(prItem));
  await step('board_pr', () => board.setStatus(prItem, 'In review'));
  await confirmStatus('board_pr', prItem, 'In review');

  const issueItem: BoardItemRef = { kind: 'issue', number: issue };
  await step('board_issue', () => board.setStatus(issueItem, 'In review'));
  await confirmStatus('board_issue', issueItem, 'In review');

  return { outcome: 'in_review', issueNumber: issue, branch: session.branch, headSha: session.headSha, pr: opened.number };
}
