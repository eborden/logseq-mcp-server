// The Temporal side of the queue watcher (#723): the two activities that talk to the server, not to GitHub. They run on the
// worker with a Temporal client, because workflow code can neither list executions nor start a workflow that outlives it
// (a child would end with its parent's choices; each `issue-<n>` run must stand alone).
//
// - `listRunningIssues`: the `issueWorkflow` executions that are not closed, by workflow ID, as numbers only. The watcher
//   folds them into `taken` and measures the cap against their count. A held run (waiting for the maintainer's decision or
//   a Needs Input answer) is Running to Temporal, so it counts.
// - `startQueuedRun`: starts `issue-<n>` through `startIssueRun` (src/issue-client.ts), the call `npm run run-issue` makes,
//   with the input `buildRunInput` makes from the same flags. The start is idempotent by workflow ID: a second start of
//   an ID that exists is refused by the server and answered here as `already_running` (open) or `already_finished` (closed),
//   so the watcher can count an open run against the cap and skip a closed one.
// - `readRunStatuses` (#724): how each of a few closed runs ended, as a fixed word and, for a stopped run, its stop reason when
//   that is one of the orchestrator's own words (src/run-status.ts). The watcher asks about the closed runs it skipped, at most
//   MAX_RUN_STATUS_LOOKUPS a tick, so the read is bounded: it describes each run and reads the failure of a Failed one, nothing else.
//
// No title, memo, input or other text from a workflow is read or returned. Numbers, fixed words and one flag come out. A Failed
// run's message is never put in a result, and the details of its failure only through `stopDetails`, which keeps fixed words.

import { ApplicationFailure } from '@temporalio/activity';
import { WorkflowFailedError, WorkflowNotFoundError } from '@temporalio/client';
import type { Client } from '@temporalio/client';
import { InvalidIssueInputError, ISSUE_STOPPED_FAILURE, ISSUE_WORKFLOW_NAME, issueWorkflowId } from '../issue-types.ts';
import { startIssueRun } from '../issue-client.ts';
import {
  InvalidQueueInputError,
  MAX_RUNNING_READ,
  QUEUE_TOO_MANY_RUNS,
  parseRunStatusesInput,
  parseStartQueuedRunInput,
} from '../queue-types.ts';
import type { RunStatusEntry, RunStatuses, RunningIssues, StartQueuedRunResult } from '../queue-types.ts';
import { buildRunInput } from '../run-issue-input.ts';
import { closedStatusOfName, isParkedStop, stopDetails } from '../run-status.ts';

/** `issue-<n>` as `issueWorkflowId` builds it. */
const ISSUE_WORKFLOW_ID = /^issue-([1-9]\d{0,8})$/;

export interface QueueActivityDeps {
  readonly client: Client;
  readonly taskQueue: string;
}

export function createQueueActivities(deps: QueueActivityDeps) {
  async function listRunningIssues(): Promise<RunningIssues> {
    const running = new Set<number>();
    let otherRuns = 0;
    let read = 0;
    // `ExecutionStatus = "Running"` is every execution that is not closed. Visibility can lag a start by a moment; the
    // start itself is idempotent by ID, so a run the list misses cannot be started twice.
    for await (const info of deps.client.workflow.list({ query: `WorkflowType = "${ISSUE_WORKFLOW_NAME}" AND ExecutionStatus = "Running"` })) {
      read += 1;
      if (read > MAX_RUNNING_READ) {
        // An undercount would let the cap be exceeded, so a longer list fails the call (BR-0003, foundations 4.6).
        throw ApplicationFailure.nonRetryable(`more than ${MAX_RUNNING_READ} issue runs are open, more than one call reads`, QUEUE_TOO_MANY_RUNS);
      }
      const match = ISSUE_WORKFLOW_ID.exec(info.workflowId);
      if (match === null) {
        otherRuns += 1;
      } else {
        running.add(Number(match[1]));
      }
    }
    return { running: [...running].sort((a, b) => a - b), otherRuns };
  }

  async function startQueuedRun(raw: unknown): Promise<StartQueuedRunResult> {
    let input;
    try {
      const request = parseStartQueuedRunInput(raw);
      input = buildRunInput({
        issue: String(request.issue),
        base: request.run.base,
        repoDir: request.run.repoDir,
        worktreeDir: undefined,
        hostIntegration: request.run.hostIntegration === 'auto',
        executor: request.run.executor,
      });
    } catch (error) {
      if (error instanceof InvalidQueueInputError || error instanceof InvalidIssueInputError) {
        throw ApplicationFailure.nonRetryable(error.message, 'InvalidInput');
      }
      throw error;
    }
    const outcome = await startIssueRun(deps.client, deps.taskQueue, input);
    return { status: outcome.status };
  }

  /** One closed run's status, or undefined when it is not closed (it started again), is gone (deleted since the start) or has no closed end. */
  async function readRunStatus(issue: number): Promise<RunStatusEntry | undefined> {
    const workflowId = issueWorkflowId(issue);
    let description;
    try {
      description = await deps.client.workflow.getHandle(workflowId).describe();
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return undefined;
      }
      throw error;
    }
    const status = closedStatusOfName(description.status.name);
    if (status === undefined) {
      return undefined;
    }
    if (status !== 'failed') {
      return { issue, status };
    }
    // A Failed run's result is its failure. Only `IssueStopped` (the orchestrator's own stop) is read for details, and only
    // fixed words come out of them. Any other failure is `failed` with no reason. A run deleted since the `describe` is gone, as
    // there: no entry. Any other error that is not a workflow failure is an infrastructure error: it is thrown, never read as a
    // status (BR-0003).
    try {
      await deps.client.workflow.getHandle(workflowId, description.runId).result();
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return undefined;
      }
      if (!(error instanceof WorkflowFailedError)) {
        throw error;
      }
      const cause = error.cause;
      if (cause instanceof ApplicationFailure && cause.type === ISSUE_STOPPED_FAILURE) {
        const details = stopDetails(cause.details);
        return { issue, status: isParkedStop(details) ? 'parked' : 'failed', ...(details.reason === undefined ? {} : { stopReason: details.reason }) };
      }
    }
    return { issue, status: 'failed' };
  }

  async function readRunStatuses(raw: unknown): Promise<RunStatuses> {
    let issues: readonly number[];
    try {
      issues = parseRunStatusesInput(raw).issues;
    } catch (error) {
      if (error instanceof InvalidQueueInputError) {
        throw ApplicationFailure.nonRetryable(error.message, 'InvalidInput');
      }
      throw error;
    }
    const runs: RunStatusEntry[] = [];
    for (const issue of issues) {
      const entry = await readRunStatus(issue);
      if (entry !== undefined) {
        runs.push(entry);
      }
    }
    return { runs };
  }

  return { listRunningIssues, startQueuedRun, readRunStatuses };
}

export type QueueActivities = ReturnType<typeof createQueueActivities>;
