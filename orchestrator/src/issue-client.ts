// Starts `IssueWorkflow` for one issue (#629). The start is the claim, and it is strict:
// - the workflow ID is built from the issue number alone (issueWorkflowId), so one issue has one ID;
// - workflowIdConflictPolicy FAIL: while a run is open, a second start is refused, never attached to or replaced;
// - workflowIdReusePolicy REJECT_DUPLICATE: once a run has closed (completed, failed, timed out, terminated), the ID
//   cannot start again, so a finished issue is never run twice by a script that was started late.
// Both refusals reach the caller as WorkflowExecutionAlreadyStartedError, and this function answers them as a
// result, not an error: `already_running`, or `already_finished` with how the run closed. To run an issue again after
// a stopped run, a person deletes the closed run first (README, "Recovering a stuck run").
//
// This is the opposite choice from the hello client, which attaches to an open run. Attaching here would let a second
// script appear to claim an issue it does not own.

import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { ISSUE_RUN_TIMEOUT, ISSUE_WORKFLOW_NAME, issueWorkflowId } from './issue-types.ts';
import type { IssueWorkflowInput } from './issue-types.ts';
import type { issueWorkflow } from './workflows/issue.ts';

export type StartOutcome =
  | { readonly status: 'started'; readonly workflowId: string; readonly runId: string }
  | { readonly status: 'already_running'; readonly workflowId: string }
  /** `closedAs` is the status Temporal names: COMPLETED, FAILED, TIMED_OUT, TERMINATED or CANCELLED. */
  | { readonly status: 'already_finished'; readonly workflowId: string; readonly closedAs: string };

export async function startIssueRun(client: Client, taskQueue: string, input: IssueWorkflowInput): Promise<StartOutcome> {
  const workflowId = issueWorkflowId(input.issueNumber);
  try {
    const handle = await client.workflow.start<typeof issueWorkflow>(ISSUE_WORKFLOW_NAME, {
      taskQueue,
      workflowId,
      args: [input],
      workflowExecutionTimeout: ISSUE_RUN_TIMEOUT,
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      workflowIdConflictPolicy: 'FAIL',
    });
    return { status: 'started', workflowId, runId: handle.firstExecutionRunId };
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
      throw error;
    }
    const description = await client.workflow.getHandle(workflowId).describe();
    return description.status.name === 'RUNNING'
      ? { status: 'already_running', workflowId }
      : { status: 'already_finished', workflowId, closedAs: description.status.name };
  }
}
