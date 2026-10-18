// A test-only workflow that runs the review loop on its own against real branch and review activities (#675). The `step` and
// `stop` it hands the loop do what issue.ts's do, including the stop comment, so a test can read the comment a stop leaves.

import { ApplicationFailure, isCancellation, proxyActivities } from '@temporalio/workflow';
import type { GithubActivities } from '../../src/activities/github.ts';
import { ISSUE_STOPPED_FAILURE, issueWorkflowId, stopComment, stopCommentKey } from '../../src/issue-types.ts';
import type { IssueRunResult, IssueStep, IssueWorkflowInput, StopReason } from '../../src/issue-types.ts';
import { failureReason } from '../../src/workflows/failure-reason.ts';
import { reviewLoop } from '../../src/workflows/review-loop.ts';

const github = proxyActivities<Pick<GithubActivities, 'commentIssue'>>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 1 } });

export interface RemoteFixerLoopArgs {
  readonly input: IssueWorkflowInput;
  readonly headSha: string;
}

export async function remoteFixerLoopWorkflow(args: RemoteFixerLoopArgs): Promise<IssueRunResult> {
  const { input } = args;
  const pr = 77;

  async function stop(step: IssueStep, reason: StopReason, detail?: string): Promise<never> {
    await github.commentIssue({ issue: input.issueNumber, key: stopCommentKey(step, reason), body: stopComment(issueWorkflowId(input.issueNumber), step, reason, pr, detail) });
    throw ApplicationFailure.nonRetryable(`stopped at ${step}: ${reason}`, ISSUE_STOPPED_FAILURE, step, reason, pr);
  }

  return await reviewLoop({
    input,
    pr,
    branch: `claude/${input.issueNumber}`,
    headSha: args.headSha,
    step: async (name, call) => {
      try {
        return await call();
      } catch (error) {
        if (isCancellation(error)) {
          throw error;
        }
        return await stop(name, failureReason(error));
      }
    },
    stop,
  });
}
