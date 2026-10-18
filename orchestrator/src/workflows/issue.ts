// IssueWorkflow (#629 and #630, parent plan #625): one Ready issue to an open PR that is In review on the board, then
// the reviewer, a bounded fix loop and the merge gate (review-loop.ts). The merge is the maintainer's.
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
// Steps, in order. A permanent failure at any of them comments on the issue (once, keyed by the step and the reason) and ends the
// run as a Failed workflow: a failed premise is never retried.
//   check        checkIssue: a trusted-author read; a closed issue is skipped
//   claim        claimIssue: acts on `proceed`, never on `claimed` alone
//   confirm      the board shows In progress (the claim's own write is not read back by the claim)
//   session      runImplementerSession: the brief, then one `claude -p` session on the branch `claude/<n>`
//                (`executor: remote`: remote-implementer.ts, where the guard runs on the fetched branch, a refusal deletes it, no push)
//   guard        guardBranch: the diff has no protected path, is not empty and is not huge (counts only)
//   push         pushBranch: the only push, with fixed argv; the session cannot push
//   open_pr      openPr
//   board_pr     addToBoard, setStatus In review, getBoardStatus: the PR is In review with no manual step
//   board_issue  setStatus In review for the issue, getBoardStatus
//   review loop  the second half, in review-loop.ts (#630): reviews, a bounded fix loop and the gate.
//   decision     the third part, in decision.ts (#631): the `maintainerDecision` signal, held until the gate is clear,
//                the decision comment, then the merge the maintainer makes, Done, and the issue's closed check.
//                `awaitDecision: false` ends the run after the review loop, as #630 did.
// It never merges, never labels, never resolves a thread and never moves an item to Ready or Backlog.

import {
  ApplicationFailure,
  CancellationScope,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import type { GithubActivities } from '../activities/github.ts';
import type { BranchActivities } from '../activities/branch.ts';
import type { ImplementerActivities } from '../activities/implementer.ts';
import { BOARD_ACTIVITY_OPTIONS } from '../board-policy.ts';
import { IMPLEMENTER_ACTIVITY_OPTIONS } from '../claude-session-policy.ts';
import { BRANCH_ACTIVITY_OPTIONS } from '../branch-types.ts';
import { GITHUB_ACTIVITY_OPTIONS } from '../github-policy.ts';
import { DEFAULT_REVIEW_LOOP_TIMEOUT_MS } from '../review-policy.ts';
import { maintainerDecisionSignal } from '../approval-types.ts';
import { createDecisionInbox, decisionStage } from './decision.ts';
import { onExecutor } from './executor.ts';
import { failureReason, guardCounts } from './failure-reason.ts';
import { remoteImplementer } from './remote-implementer.ts';
import { reviewLoop } from './review-loop.ts';
import {
  BOARD_CONFIRM_READS,
  BOARD_CONFIRM_WAIT,
  ISSUE_STEP_TIMEOUT,
  ISSUE_STOPPED_FAILURE,
  InvalidIssueInputError,
  NO_COMMENT_FAILURES,
  REMOTE_BRANCH_MOVED,
  issueBranch,
  issueWorkflowId,
  parseIssueWorkflowInput,
  pullRequestBody,
  pullRequestTitle,
  stopComment,
  stopCommentKey,
} from '../issue-types.ts';
import type { IssueRunResult, IssueStep, SkipReason, StopReason } from '../issue-types.ts';
import type { BoardItemRef, SessionExitStatus, SettableStatus } from '../types.ts';

const github = proxyActivities<Pick<GithubActivities, 'checkIssue' | 'claimIssue' | 'openPr' | 'commentIssue' | 'getPrState'>>({
  ...GITHUB_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});
const board = proxyActivities<Pick<GithubActivities, 'addToBoard' | 'getBoardStatus' | 'setStatus'>>({
  ...BOARD_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});
const implementer = proxyActivities<ImplementerActivities>({
  ...IMPLEMENTER_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});
const branches = proxyActivities<BranchActivities>({
  ...BRANCH_ACTIVITY_OPTIONS,
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

export async function issueWorkflow(rawInput: unknown): Promise<IssueRunResult> {
  // Registered before the first await, so a decision signalled early is kept (held until the gate clears, #631).
  const inbox = createDecisionInbox();
  setHandler(maintainerDecisionSignal, inbox.receive);

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
  async function stop(step: IssueStep, reason: StopReason, detail?: string): Promise<never> {
    if (!NO_COMMENT_FAILURES.includes(reason)) {
      try {
        await github.commentIssue({ issue, key: stopCommentKey(step, reason), body: stopComment(workflowId, step, reason, pr, detail) });
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

  // Where the guard sits depends on the executor (#673). Local: the session cannot push, so the guard reads the local branch and
  // `pushBranch` publishes it. Remote: the session pushed its own branch, so the guard runs on the fetched tip before the PR
  // opens, a refusal deletes the branch, and there is no push.
  let checked: { readonly headSha: string };
  if (input.executor === 'remote') {
    checked = await remoteImplementer({ input, branch, step, stop, reasonOf: failureReason, isCancellation, countsOf: guardCounts });
  } else {
    const session = await onExecutor(input.executor, 'session', stop, () => step('session', () => implementer.runImplementerSession(input)));
    if (session.exitStatus !== 'success') {
      return await stop('session', SESSION_STOP_REASONS[session.exitStatus]);
    }

    // The session cannot push. The diff is checked first (protected paths, size), then the one push, with fixed argv.
    checked = await step('guard', () => branches.guardBranch({ repoDir: input.repoDir, branch, headSha: session.headSha, base: input.base }));
    await step('push', () => branches.pushBranch({ repoDir: input.repoDir, branch, headSha: checked.headSha, base: input.base }));
  }

  const opened = await step('open_pr', () =>
    github.openPr({ head: branch, base: input.base, title: pullRequestTitle(issue), body: pullRequestBody(issue, branch) }),
  );
  pr = opened.number;

  // Remote only (#673): the session cannot be stopped, so the branch can move between the guard's last read and the PR's
  // creation. The PR carries whatever the tip was then, so its head is read back and must be the guarded sha.
  if (input.executor === 'remote') {
    const seen = await step('guard', () => github.getPrState(opened.number));
    if (seen.headSha !== checked.headSha) {
      return await stop('guard', REMOTE_BRANCH_MOVED, `The branch moved after the guard, so the pull request #${opened.number} is on a commit that was not checked. The branch was not deleted.`);
    }
  }

  const prItem: BoardItemRef = { kind: 'pr', number: opened.number };
  await step('board_pr', () => board.addToBoard(prItem));
  await step('board_pr', () => board.setStatus(prItem, 'In review'));
  await confirmStatus('board_pr', prItem, 'In review');

  const issueItem: BoardItemRef = { kind: 'issue', number: issue };
  await step('board_issue', () => board.setStatus(issueItem, 'In review'));
  await confirmStatus('board_issue', issueItem, 'In review');

  // The second half (#630): reviews, the fix loop and the gate, bounded in total time. At the limit the running step is
  // cancelled (its session is stopped) and the run stops with one comment. A cancel of the whole workflow passes through.
  let timedOut = false;
  const loopScope = new CancellationScope();
  const timerScope = new CancellationScope();
  void timerScope.run(() => sleep(input.reviewLoopTimeoutMs ?? DEFAULT_REVIEW_LOOP_TIMEOUT_MS)).then(
    () => {
      timedOut = true;
      loopScope.cancel();
    },
    () => undefined,
  );
  let looped: IssueRunResult;
  try {
    looped = await loopScope.run(() => reviewLoop({ input, pr: opened.number, branch, headSha: checked.headSha, step, stop }));
  } catch (error) {
    if (timedOut && isCancellation(error)) {
      return await CancellationScope.nonCancellable(() => stop('review_loop', 'ReviewLoopTimeout'));
    }
    throw error;
  } finally {
    timerScope.cancel();
  }
  // The third part (#631): wait for the maintainer's decision, then the merge. `awaitDecision: false` ends the run here.
  if (input.awaitDecision === false) {
    return looped;
  }
  return await decisionStage({ input, pr: opened.number, inbox, step, stop, ...('fixRounds' in looped ? { fixRounds: looped.fixRounds } : {}) });
}
