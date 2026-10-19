// The implementer step of a run with `executor: 'remote'` (#673, plan #643). The order differs from the local path, because a
// remote session pushes its own `claude/<n>` branch and the worker cannot stop it:
//
//   session   `runRemoteImplementerSession` (role implementer, attempt n): fires a remote session and waits for its push
//   guard     `guardRemoteBranch`: fetches the branch and runs the HISTORY and NET checks on the fetched tip, which must be the
//             sha the session reported, before the PR opens. There is no `pushBranch` on this path.
//   delete    a guard verdict that refuses the branch (protected path, empty, too big, special file) deletes the remote
//             branch with the worker's own credential (`deleteRemoteBranch`, idempotent), then stops the run with one keyed
//             comment: counts and the reason class only. A branch that moved, or is gone, is stopped on and not deleted:
//             no PR is ever opened on a sha that was not guarded.
//
// The attempt counter lives here, in workflow state, and starts at the run's `attempt` (default 1). A session that ended with no push at all (the cap passed) gets one more
// attempt, which fires a new session because the marker key carries the attempt; a retry of the same attempt re-attaches.
// A session that stopped for a person (a needs-input comment, #697) parks the run (#698): one keyed comment, the board item to
// Needs Input, then a bounded wait for a trusted comment newer than the question. The answer fires attempt n+1 and the run
// carries on into the guard and the PR. A park does not spend the no-push budget; a run parks at most MAX_NEEDS_INPUT_PARKS
// times, and a third needs-input, or no answer within the limit (`NeedsInputTimeout`), stops the run.
// Anything else (a claim, a failed launch, a push that never settled, a guard refusal) stops for a person.
// Deterministic: no clock, I/O or randomness.

import { log, proxyActivities } from '@temporalio/workflow';
import type { GithubActivities } from '../activities/github.ts';
import type { BranchActivities } from '../activities/branch.ts';
import type { RemoteImplementerActivities } from '../activities/implementer.ts';
import { BRANCH_ACTIVITY_OPTIONS } from '../branch-types.ts';
import {
  DEFAULT_NEEDS_INPUT_TIMEOUT_MS,
  ISSUE_STEP_TIMEOUT,
  MAX_ATTEMPT,
  MAX_NEEDS_INPUT_PARKS,
  NEEDS_INPUT,
  NEEDS_INPUT_BOARD_STATUS,
  NEEDS_INPUT_POLL_MS,
  NEEDS_INPUT_TIMEOUT,
  NEEDS_INPUT_WAIT_CHUNK_MS,
  REMOTE_IMPLEMENTER_ATTEMPTS,
  REMOTE_LAUNCH_FAILED,
  REMOTE_NO_HEAD,
  REMOTE_SESSION_CLAIMED,
  REMOTE_SESSION_TIMED_OUT,
  needsInputParkComment,
  needsInputParkCommentKey,
  issueWorkflowId,
} from '../issue-types.ts';
import type { IssueStep, IssueWorkflowInput, StopReason } from '../issue-types.ts';
import { BOARD_ACTIVITY_OPTIONS } from '../board-policy.ts';
import { GITHUB_ACTIVITY_OPTIONS, NEEDS_INPUT_WAIT_OPTIONS } from '../github-policy.ts';
import { REMOTE_SESSION_ACTIVITY_OPTIONS } from '../remote-session-policy.ts';

const remote = proxyActivities<RemoteImplementerActivities>({
  ...REMOTE_SESSION_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});
const github = proxyActivities<Pick<GithubActivities, 'commentIssue'>>({
  ...GITHUB_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});
const board = proxyActivities<Pick<GithubActivities, 'setStatus'>>({
  ...BOARD_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});
const waiting = proxyActivities<Pick<GithubActivities, 'waitForNeedsInputAnswer'>>(NEEDS_INPUT_WAIT_OPTIONS);
const branches = proxyActivities<Pick<BranchActivities, 'guardRemoteBranch' | 'deleteRemoteBranch'>>({
  ...BRANCH_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});

/** The guard answers that mean "this branch must not be published". Anything else (a failed read, a timeout, unreadable git output) is a fault in the reading, says nothing about the diff, and never deletes: the delete cannot be undone. */
export const GUARD_REFUSALS: readonly string[] = ['ProtectedPath', 'DiffTooLarge', 'EmptyDiff', 'SpecialFile'];

export interface RemoteImplementerContext {
  readonly input: IssueWorkflowInput;
  readonly branch: string;
  readonly step: <T>(name: IssueStep, call: () => Promise<T>) => Promise<T>;
  readonly stop: (step: IssueStep, reason: StopReason, detail?: string) => Promise<never>;
  /** The reason word of a failed activity (issue.ts). */
  readonly reasonOf: (error: unknown) => StopReason;
  readonly isCancellation: (error: unknown) => boolean;
  /** The counts line of a guard refusal, or undefined when the failure carries none. */
  readonly countsOf: (error: unknown) => string | undefined;
}

/** Moves the issue's board item for a park, and tells nobody if it cannot: a board fault never fails or unparks a run (#698). */
async function moveBoard(issue: number, status: typeof NEEDS_INPUT_BOARD_STATUS | 'In progress', isCancellation_: (error: unknown) => boolean): Promise<void> {
  try {
    await board.setStatus({ kind: 'issue', number: issue }, status);
  } catch (error) {
    if (isCancellation_(error)) {
      throw error;
    }
    // Identifiers only: the issue, the wanted status and the reason word. The run goes on.
    log.warn('park board move skipped', { issue, status, reason: error instanceof Error ? error.name : 'unknown' });
  }
}

/** Waits, in bounded chunks, for a trusted answer newer than the needs-input comment. True when one came, false when the limit passed. */
async function awaitAnswer(ctx: RemoteImplementerContext, afterCommentId: number, limitMs: number): Promise<boolean> {
  for (let left = limitMs; left > 0; ) {
    const waitMs = Math.min(left, NEEDS_INPUT_WAIT_CHUNK_MS);
    const result = await ctx.step('park', () =>
      waiting.waitForNeedsInputAnswer({ issue: ctx.input.issueNumber, afterCommentId, waitMs, pollMs: Math.min(NEEDS_INPUT_POLL_MS, waitMs) }),
    );
    if (result.answered) {
      return true;
    }
    left -= waitMs;
  }
  return false;
}

/**
 * Runs the remote session and the guard. Returns the guarded sha, on which the PR opens.
 *
 * Two counters, kept apart: `noPush` counts sessions that ended with no push (budget REMOTE_IMPLEMENTER_ATTEMPTS), and `parks`
 * counts the waits for a person's answer (budget MAX_NEEDS_INPUT_PARKS). A park spends none of the first. Each session, after
 * either, is the next attempt number, so it has a new session key and cannot attach to an earlier session.
 */
export async function remoteImplementer(ctx: RemoteImplementerContext): Promise<{ readonly headSha: string }> {
  const { input, branch, step, stop } = ctx;
  let headSha: string | undefined;
  let attempt = input.attempt ?? 1;
  let noPush = 0;
  let parks = 0;
  for (;;) {
    const result = await step('session', () => remote.runRemoteImplementerSession({ ...input, attempt }));
    if (result.outcome === 'failed') {
      return await stop('session', result.claim === undefined ? REMOTE_LAUNCH_FAILED : REMOTE_SESSION_CLAIMED);
    }
    if (result.outcome === 'needs_input') {
      const detail = result.commentId === undefined ? undefined : `The session left a needs-input comment (id ${result.commentId}) on this issue.`;
      // Without the comment's id nothing can be "newer than" it, and a third needs-input or no attempt number left means no more waiting.
      if (result.commentId === undefined || parks >= MAX_NEEDS_INPUT_PARKS || attempt >= MAX_ATTEMPT) {
        return await stop('session', NEEDS_INPUT, detail);
      }
      parks += 1;
      const limitMs = input.needsInputTimeoutMs ?? DEFAULT_NEEDS_INPUT_TIMEOUT_MS;
      await step('park', () => github.commentIssue({ issue: input.issueNumber, key: needsInputParkCommentKey(attempt), body: needsInputParkComment(issueWorkflowId(input.issueNumber), attempt, limitMs) }));
      await moveBoard(input.issueNumber, NEEDS_INPUT_BOARD_STATUS, ctx.isCancellation);
      if (!(await awaitAnswer(ctx, result.commentId, limitMs))) {
        return await stop('park', NEEDS_INPUT_TIMEOUT, `No trusted comment answered the needs-input comment (id ${result.commentId}) within the limit, so the run stopped.`);
      }
      await moveBoard(input.issueNumber, 'In progress', ctx.isCancellation);
      attempt += 1;
      continue;
    }
    if (result.outcome === 'timed_out') {
      if (result.headSha === undefined && noPush + 1 < REMOTE_IMPLEMENTER_ATTEMPTS) {
        noPush += 1;
        attempt += 1;
        continue;
      }
      return await stop('session', REMOTE_SESSION_TIMED_OUT);
    }
    headSha = result.headSha;
    break;
  }
  if (headSha === undefined) {
    return await stop('session', REMOTE_NO_HEAD);
  }
  const tip = headSha;

  try {
    const guarded = await branches.guardRemoteBranch({ repoDir: input.repoDir, branch, headSha: tip, base: input.base });
    return { headSha: guarded.headSha };
  } catch (error) {
    if (ctx.isCancellation(error)) {
      throw error;
    }
    const reason = ctx.reasonOf(error);
    if (!GUARD_REFUSALS.includes(reason)) {
      // Moved, missing, or the guard could not run: nothing says the branch is bad, so it is left for a person.
      return await stop('guard', reason);
    }
    await step('guard', () => branches.deleteRemoteBranch({ repoDir: input.repoDir, branch }));
    const counts = ctx.countsOf(error);
    return await stop('guard', reason, [`The remote branch \`${branch}\` was deleted and no pull request was opened.`, counts ?? ''].filter((line) => line !== '').join(' '));
  }
}
