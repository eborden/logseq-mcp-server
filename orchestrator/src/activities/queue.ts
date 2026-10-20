// The Temporal side of the queue watcher (#723): the two activities that talk to the server, not to GitHub. They run on the
// worker with a Temporal client, because workflow code can neither list executions nor start a workflow that outlives it
// (a child would end with its parent's choices; each `issue-<n>` run must stand alone).
//
// - `listRunningIssues`: the `issueWorkflow` executions that are not closed, by workflow ID, as numbers only. The watcher
//   folds them into `taken` and measures the cap against their count. A held run (waiting for the maintainer's decision or
//   a Needs Input answer) is Running to Temporal, so it counts.
// - `startQueuedRun`: starts `issue-<n>` through `startIssueRun` (src/issue-client.ts), the call `npm run run-issue` makes,
//   with the input `buildRunInput` makes from the same flags. The start is idempotent by workflow ID: a second start of
//   an ID that exists, open or closed, is refused by the server and answered here as `started: false`.
//
// No title, memo, input or other text from a workflow is read or returned. Numbers and one flag come out.

import { ApplicationFailure } from '@temporalio/activity';
import type { Client } from '@temporalio/client';
import { InvalidIssueInputError, ISSUE_WORKFLOW_NAME } from '../issue-types.ts';
import { startIssueRun } from '../issue-client.ts';
import {
  InvalidQueueInputError,
  MAX_RUNNING_READ,
  QUEUE_TOO_MANY_RUNS,
  parseStartQueuedRunInput,
} from '../queue-types.ts';
import type { RunningIssues, StartQueuedRunResult } from '../queue-types.ts';
import { buildRunInput } from '../run-issue-input.ts';

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
    return { started: outcome.status === 'started' };
  }

  return { listRunningIssues, startQueuedRun };
}

export type QueueActivities = ReturnType<typeof createQueueActivities>;
