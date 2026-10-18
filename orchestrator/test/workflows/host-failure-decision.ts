// A test-only workflow that runs the decision stage on its own (#676): the hold loop, the host check, the fixer round a failure
// on the fixture starts, and the review of the new head. The `step` and `stop` it hands the stage do what issue.ts's do,
// including the stop comment, so a test can read the comment a stop leaves.

import { ApplicationFailure, isCancellation, proxyActivities, setHandler } from '@temporalio/workflow';
import type { GithubActivities } from '../../src/activities/github.ts';
import { maintainerDecisionSignal } from '../../src/approval-types.ts';
import { ISSUE_STOPPED_FAILURE, issueWorkflowId, stopComment, stopCommentKey } from '../../src/issue-types.ts';
import type { IssueRunResult, IssueStep, IssueWorkflowInput, StopReason } from '../../src/issue-types.ts';
import { createDecisionInbox, decisionStage } from '../../src/workflows/decision.ts';
import { failureReason } from '../../src/workflows/failure-reason.ts';

const github = proxyActivities<Pick<GithubActivities, 'commentIssue'>>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 1 } });

export interface HostFailureDecisionArgs {
  readonly input: IssueWorkflowInput;
  readonly pr: number;
  /** Fixer rounds the review loop is taken to have used already. */
  readonly fixRounds: number;
}

export async function hostFailureDecisionWorkflow(args: HostFailureDecisionArgs): Promise<IssueRunResult> {
  const { input, pr } = args;
  const inbox = createDecisionInbox();
  setHandler(maintainerDecisionSignal, inbox.receive);

  async function stop(step: IssueStep, reason: StopReason, detail?: string): Promise<never> {
    await github.commentIssue({ issue: input.issueNumber, key: stopCommentKey(step, reason), body: stopComment(issueWorkflowId(input.issueNumber), step, reason, pr, detail) });
    throw ApplicationFailure.nonRetryable(`stopped at ${step}: ${reason}`, ISSUE_STOPPED_FAILURE, step, reason, pr);
  }

  return await decisionStage({
    input,
    pr,
    inbox,
    fixRounds: args.fixRounds,
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
