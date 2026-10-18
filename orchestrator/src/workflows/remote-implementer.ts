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
// Anything else (a claim, a failed launch, a push that never settled, a guard refusal) stops for a person.
// Deterministic: no clock, I/O or randomness.

import { proxyActivities } from '@temporalio/workflow';
import type { BranchActivities } from '../activities/branch.ts';
import type { RemoteImplementerActivities } from '../activities/implementer.ts';
import { BRANCH_ACTIVITY_OPTIONS } from '../branch-types.ts';
import {
  ISSUE_STEP_TIMEOUT,
  REMOTE_IMPLEMENTER_ATTEMPTS,
  REMOTE_LAUNCH_FAILED,
  REMOTE_NO_HEAD,
  REMOTE_SESSION_CLAIMED,
  REMOTE_SESSION_TIMED_OUT,
} from '../issue-types.ts';
import type { IssueStep, IssueWorkflowInput, StopReason } from '../issue-types.ts';
import { REMOTE_SESSION_ACTIVITY_OPTIONS } from '../remote-session-policy.ts';

const remote = proxyActivities<RemoteImplementerActivities>({
  ...REMOTE_SESSION_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});
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

/** Runs the remote session and the guard. Returns the guarded sha, on which the PR opens. */
export async function remoteImplementer(ctx: RemoteImplementerContext): Promise<{ readonly headSha: string }> {
  const { input, branch, step, stop } = ctx;
  let headSha: string | undefined;
  // The run's first attempt number (default 1), then at most one more after a session that ended with no push.
  const first = input.attempt ?? 1;
  const last = first + REMOTE_IMPLEMENTER_ATTEMPTS - 1;
  for (let attempt = first; attempt <= last; attempt += 1) {
    const result = await step('session', () => remote.runRemoteImplementerSession({ ...input, attempt }));
    if (result.outcome === 'failed') {
      return await stop('session', result.claim === undefined ? REMOTE_LAUNCH_FAILED : REMOTE_SESSION_CLAIMED);
    }
    if (result.outcome === 'timed_out') {
      if (result.headSha === undefined && attempt < last) {
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
