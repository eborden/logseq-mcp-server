// A test-only workflow that runs the review loop on its own (#674). `issueWorkflow` cannot reach the loop with
// `executor: 'remote'` until a remote implementer exists, so the remote review branch is driven from here. The
// step and stop it hands the loop do what issue.ts's do, without the issue comment.

import { ApplicationFailure, isCancellation } from '@temporalio/workflow';
import type { IssueRunResult, IssueStep, IssueWorkflowInput, StopReason } from '../../src/issue-types.ts';
import { reviewLoop } from '../../src/workflows/review-loop.ts';

const HEAD = 'a'.repeat(40);

async function stop(step: IssueStep, reason: StopReason): Promise<never> {
  throw ApplicationFailure.nonRetryable(`stopped at ${step}: ${reason}`, 'IssueStopped', step, reason);
}

export async function remoteReviewLoopWorkflow(input: IssueWorkflowInput): Promise<IssueRunResult> {
  return await reviewLoop({
    input,
    pr: 77,
    branch: 'claude/123',
    headSha: HEAD,
    step: async (name, call) => {
      try {
        return await call();
      } catch (error) {
        if (isCancellation(error)) {
          throw error;
        }
        const cause = error instanceof Error && 'cause' in error ? error.cause : undefined;
        return await stop(name, cause instanceof ApplicationFailure && typeof cause.type === 'string' ? cause.type : 'ActivityFailed');
      }
    },
    stop,
  });
}
