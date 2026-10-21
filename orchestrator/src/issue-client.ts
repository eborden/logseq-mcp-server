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

import { Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { ISSUE_RUN_TIMEOUT, ISSUE_WORKFLOW_NAME, issueWorkflowId, parseIssueWorkflowInput, resumeWorkflowId } from './issue-types.ts';
import type { IssueWorkflowInput, ResumeRefusal, ResumeResolution } from './issue-types.ts';
import type { issueWorkflow } from './workflows/issue.ts';

export type StartOutcome =
  | { readonly status: 'started'; readonly workflowId: string; readonly runId: string }
  | { readonly status: 'already_running'; readonly workflowId: string }
  /** `closedAs` is the status Temporal names: COMPLETED, FAILED, TIMED_OUT, TERMINATED or CANCELLED. */
  | { readonly status: 'already_finished'; readonly workflowId: string; readonly closedAs: string };

export async function startIssueRun(client: Client, taskQueue: string, input: IssueWorkflowInput): Promise<StartOutcome> {
  return await startWithId(client, taskQueue, issueWorkflowId(input.issueNumber), input);
}

async function startWithId(client: Client, taskQueue: string, workflowId: string, input: IssueWorkflowInput): Promise<StartOutcome> {
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

export type ResumeStartOutcome = StartOutcome | { readonly status: 'refused'; readonly reason: ResumeRefusal };

/**
 * Starts a resume run (#747): `IssueWorkflow` entered at the gate of the issue's open PR, with no claim, no session and no new PR.
 * It reads the PR first (`resolve`: GitHub reads only) and refuses with a fixed word, before it starts anything, when the issue
 * is not In review, has no open PR or more than one, or still has its own run open (`run_open`: that run holds the gate and the
 * signal). The head it reads goes into the run's input and its ID (`resumeWorkflowId`), so a second start for the same head is
 * refused by the server (`already_running`, `already_finished`) and a head after another fix gets its own. `base` is the PR's own:
 * the person's flags carry only what the PR cannot say (`input` holds a placeholder base that this replaces).
 */
export async function startResumeRun(
  client: Client,
  taskQueue: string,
  resolve: (issue: number) => Promise<ResumeResolution>,
  input: IssueWorkflowInput,
): Promise<ResumeStartOutcome> {
  if (await issueRunIsOpen(client, input.issueNumber)) {
    return { status: 'refused', reason: 'run_open' };
  }
  const resolved = await resolve(input.issueNumber);
  if (!resolved.ok) {
    return { status: 'refused', reason: resolved.reason };
  }
  const resumeInput = parseIssueWorkflowInput({ ...input, base: resolved.base, resume: { pr: resolved.pr, headSha: resolved.headSha } });
  return await startWithId(client, taskQueue, resumeWorkflowId(input.issueNumber, resolved.headSha), resumeInput);
}

/** Whether `issue-<n>` is running. A run that does not exist, or has closed, is not. Any other failure of the read is thrown. */
async function issueRunIsOpen(client: Client, issue: number): Promise<boolean> {
  try {
    return (await client.workflow.getHandle(issueWorkflowId(issue)).describe()).status.name === 'RUNNING';
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) {
      return false;
    }
    throw error;
  }
}
