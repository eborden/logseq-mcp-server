// The second half of IssueWorkflow (#630, parent plan #625): from an open PR to "gate clear, waiting for the
// maintainer". CLAUDE.md "Code review" steps 1 to 5, foundations 4.6 and 4.8.
//
// What it does, in order, until it returns or stops:
//   review   a fresh reviewer session on the PR's current head (never the author's session), then ONE review with its
//            inline comments, posted by an activity (event COMMENT, never APPROVE or REQUEST_CHANGES)
//   gate     `getGateStatus`, then the pure `gateClear` (src/gate.ts): at least one review on the head and no unresolved
//            thread. No model is involved. Zero threads with zero reviews on the head is not clear.
//   threads  the open threads. A thread is the fixer's to act on when its first comment is by a trusted author and the
//            reviewer has not accepted a reply on it. With none left, the run ends (below).
//   fix      at most `maxFixRounds` rounds: a fixer session, `guardBranch`, `pushBranch` (the session cannot push), the
//            replies posted by an activity, then back to `review` on the new head. That review is the closing review
//            the gate needs: a push moves the head, and a review on an older commit never counts.
//
// It ends in one of three ways. `gate_clear`: waiting for the maintainer. `waiting_for_threads`: every open thread is
// one the reviewer accepted or one the loop may not act on, and only a person resolves a thread, so the gate stays not
// clear until then (the run says so in one comment and records the accepted ids). A stop (`stop`, from issue.ts): a
// failed step, `MaxRoundsReached`, `HeadMismatch` or `ReviewNotCounted`, each with one keyed comment and a Failed run.
// The total time is bounded by the scope in issue.ts, each step by its own timeout, retries by their policies.
//
// It never merges, never labels, never approves, and never resolves a thread: there is no activity for that, and
// the invariant test in test/review-loop.test.ts keeps it so. History carries identifiers and counts: a PR number, a
// SHA, thread ids, counts. The text of reviews, threads, findings and replies stays inside the activities.

import { proxyActivities, sleep } from '@temporalio/workflow';
import type { GithubActivities } from '../activities/github.ts';
import type { BranchActivities } from '../activities/branch.ts';
import type { ReviewActivities } from '../activities/review.ts';
import { BRANCH_ACTIVITY_OPTIONS } from '../branch-types.ts';
import { onExecutor } from './executor.ts';
import { gateClear } from '../gate.ts';
import { ISSUE_STEP_TIMEOUT, issueWorkflowId, waitingForThreadsComment } from '../issue-types.ts';
import type { IssueRunResult, IssueStep, IssueWorkflowInput, StopReason } from '../issue-types.ts';
import { DEFAULT_MAX_FIX_ROUNDS, GATE_READS, GATE_READ_WAIT, REVIEW_GITHUB_ACTIVITY_OPTIONS, REVIEW_SESSION_ACTIVITY_OPTIONS } from '../review-policy.ts';
import type { ReviewStepInput } from '../review-types.ts';
import type { GateStatus } from '../types.ts';

const sessions = proxyActivities<Pick<ReviewActivities, 'runReviewerSession' | 'runFixerSession'>>({
  ...REVIEW_SESSION_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});
const reviewGithub = proxyActivities<
  Pick<ReviewActivities, 'postSessionReview' | 'postFixerReplies' | 'listOpenThreads'> & Pick<GithubActivities, 'getGateStatus' | 'commentIssue'>
>({
  ...REVIEW_GITHUB_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});
const branches = proxyActivities<Pick<BranchActivities, 'guardBranch' | 'pushBranch'>>({
  ...BRANCH_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});

export interface ReviewLoopContext {
  readonly input: IssueWorkflowInput;
  readonly pr: number;
  readonly branch: string;
  /** The tip the implementer's branch was pushed at, which the PR opened on. */
  readonly headSha: string;
  /** Runs one activity call; a failure of it ends the run at `name` (issue.ts). */
  readonly step: <T>(name: IssueStep, call: () => Promise<T>) => Promise<T>;
  /** Ends the run with one comment on the issue and a Failed workflow (issue.ts). */
  readonly stop: (step: IssueStep, reason: StopReason) => Promise<never>;
}

export async function reviewLoop(context: ReviewLoopContext): Promise<IssueRunResult> {
  const { input, pr, branch, step, stop } = context;
  const maxRounds = input.maxFixRounds ?? DEFAULT_MAX_FIX_ROUNDS;
  let head = context.headSha;
  /** Fixer rounds finished. */
  let round = 0;
  /** Threads the reviewer accepted a reply on, in the order it said so. Ids only. */
  const accepted = new Set<string>();

  const stepInput = (): ReviewStepInput => ({
    pr,
    issue: input.issueNumber,
    repoDir: input.repoDir,
    worktreeDir: input.worktreeDir,
    base: input.base,
    headSha: head,
    round,
    acceptedThreadIds: [...accepted],
  });

  /**
   * Reads the gate until it shows the head just reviewed and a review or a thread on it (GitHub can lag a push, and
   * can lag a review it just accepted), a bounded number of times. After the last read, a head that is not ours stops
   * the run; the right head with nothing counted on it is returned for the caller to stop on.
   */
  async function readGate(): Promise<GateStatus> {
    let status: GateStatus | undefined;
    for (let read = 1; read <= GATE_READS; read += 1) {
      status = await step('gate', () => reviewGithub.getGateStatus(pr));
      if (status.headSha === head && (status.reviewsOnHead > 0 || status.unresolvedThreads > 0)) {
        return status;
      }
      if (read < GATE_READS) {
        await sleep(GATE_READ_WAIT);
      }
    }
    return status?.headSha === head ? status : await stop('gate', 'HeadMismatch');
  }

  for (;;) {
    // A fresh session and a new review on the head as it is now: after a push this is the closing review of the round.
    const reviewed = await onExecutor(input.executor, 'review_session', stop, () => step('review_session', () => sessions.runReviewerSession(stepInput())));
    for (const id of reviewed.acceptedThreadIds) {
      accepted.add(id);
    }
    const posted = await step('review_post', () => reviewGithub.postSessionReview(stepInput()));

    const gate = await readGate();
    if (gateClear(gate)) {
      return { outcome: 'gate_clear', issueNumber: input.issueNumber, branch, headSha: head, pr, fixRounds: round, reviewsOnHead: gate.reviewsOnHead, advisory: posted.advisory, advisoryOmitted: posted.omitted };
    }
    if (gate.unresolvedThreads === 0) {
      // No thread is open, yet no review counts on the head: the review just posted is not being counted. Looping
      // would post another and another, so a person looks.
      return await stop('gate', 'ReviewNotCounted');
    }

    const open = (await step('threads', () => reviewGithub.listOpenThreads(pr))).threads;
    const actionable = open.filter((thread) => thread.trusted && !accepted.has(thread.id));
    if (actionable.length === 0) {
      const acceptedOpen = open.filter((thread) => accepted.has(thread.id)).map((thread) => thread.id);
      await step('threads', () =>
        reviewGithub.commentIssue({
          issue: input.issueNumber,
          key: `waiting-threads-${pr}`,
          body: waitingForThreadsComment(issueWorkflowId(input.issueNumber), pr, open.length, acceptedOpen, posted.advisory, posted.omitted),
        }),
      );
      return { outcome: 'waiting_for_threads', issueNumber: input.issueNumber, branch, headSha: head, pr, fixRounds: round, acceptedThreadIds: acceptedOpen, openThreads: open.length, advisory: posted.advisory, advisoryOmitted: posted.omitted };
    }
    if (round >= maxRounds) {
      return await stop('review_loop', 'MaxRoundsReached');
    }

    const fixed = await onExecutor(input.executor, 'fix_session', stop, () => step('fix_session', () => sessions.runFixerSession(stepInput())));
    if (fixed.moved) {
      // The session cannot push: the diff is checked first (protected paths, size), then the one push, with fixed argv.
      const checked = await step('fix_guard', () => branches.guardBranch({ repoDir: input.repoDir, branch, headSha: fixed.headSha, base: input.base }));
      await step('fix_push', () => branches.pushBranch({ repoDir: input.repoDir, branch, headSha: checked.headSha, base: input.base }));
      head = checked.headSha;
    }
    await step('fix_reply', () => reviewGithub.postFixerReplies(stepInput()));
    round += 1;
  }
}
