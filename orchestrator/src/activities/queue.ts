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
// - `listClosedRuns` (#733): the closed runs whose issue is not in Ready, which the Ready-column read never meets (a run that closed
//   after it claimed the issue leaves its item In progress, In review or Needs Input). One bounded visibility list, at most
//   MAX_CLOSED_ROWS_READ rows sorted newest close first here (never trusted to the store), a count only when the list goes past that
//   bound, and the status of at most MAX_CLOSED_NOT_READY runs through the same `readRunStatus`.
//   Read-only: nothing is restarted, deleted or signalled.
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
  MAX_CLOSED_NOT_READY,
  MAX_CLOSED_ROWS_READ,
  MAX_RUNNING_READ,
  QUEUE_TOO_MANY_RUNS,
  isStopStep,
  parseClosedRunsInput,
  parseRunStatusesInput,
  parseStartQueuedRunInput,
} from '../queue-types.ts';
import type { ClosedRuns, RunStatusEntry, RunStatuses, RunningIssues, StartQueuedRunResult } from '../queue-types.ts';
import { buildRunInput } from '../run-issue-input.ts';
import { closedStatusOfName, isParkedStop, stopDetails } from '../run-status.ts';

/** `issue-<n>` as `issueWorkflowId` builds it. */
const ISSUE_WORKFLOW_ID = /^issue-([1-9]\d{0,8})$/;

/**
 * The closed ends a person has to look at: every closed status but Completed, which is a run's own end. No `ORDER BY`: the dev
 * server's visibility store refuses it, so `listClosedRuns` sorts the rows it read by close time itself.
 */
const CLOSED_NOT_READY_QUERY = `WorkflowType = "${ISSUE_WORKFLOW_NAME}" AND ExecutionStatus IN ("Failed", "Terminated", "TimedOut", "Canceled")`;

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
        return {
          issue,
          status: isParkedStop(details) ? 'parked' : 'failed',
          ...(details.reason === undefined ? {} : { stopReason: details.reason }),
          ...(details.step === undefined || !isStopStep(details.step) ? {} : { step: details.step }),
        };
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

  /**
   * The closed runs whose issue is not in the Ready column (#733), newest close first: the visibility list of `issueWorkflow` runs
   * that ended Failed, Terminated, TimedOut or Canceled, passing over the IDs of the numbers it is told (the Ready column, which
   * the Ready path already reports) and any ID that is not `issue-<n>`.
   *
   * The order is made here, not trusted to the store: it reads up to MAX_CLOSED_ROWS_READ rows (it does not stop at the 20 it
   * names), sorts what it read by close time, newest first, and describes the first MAX_CLOSED_NOT_READY of them
   * (`readRunStatus`: one describe, and one result for a Failed run). So which 20 are named never depends on the order the store
   * answers in. The one thing the bound can still cost: with more closed runs than MAX_CLOSED_ROWS_READ, a store that answers
   * oldest first hands over its oldest rows, and the newest runs are among the unread ones, which only `notLookedUp` says.
   *
   * `notLookedUp` is the closed runs of an `issue-<n>` ID the call read and did not name (more than 20 qualified), plus, only when
   * the list went past the row bound, the server's count of the rows beyond it. A list that ran out is exact and asks for no count,
   * so a clean tick never shows a number that two reads of a changing store made up. A failed read throws (BR-0003).
   */
  async function listClosedRuns(raw: unknown): Promise<ClosedRuns> {
    let exclude: ReadonlySet<number>;
    try {
      exclude = new Set(parseClosedRunsInput(raw).exclude);
    } catch (error) {
      if (error instanceof InvalidQueueInputError) {
        throw ApplicationFailure.nonRetryable(error.message, 'InvalidInput');
      }
      throw error;
    }
    // Issue number to the close time of its row, in milliseconds (a row with no close time sorts as the oldest).
    const found = new Map<number, number>();
    let rowsRead = 0;
    let pastBound = false;
    for await (const info of deps.client.workflow.list({ query: CLOSED_NOT_READY_QUERY })) {
      if (rowsRead >= MAX_CLOSED_ROWS_READ) {
        // One more row exists than the bound reads: the list did not run out.
        pastBound = true;
        break;
      }
      rowsRead += 1;
      const match = ISSUE_WORKFLOW_ID.exec(info.workflowId);
      if (match !== null && !exclude.has(Number(match[1]))) {
        const issue = Number(match[1]);
        found.set(issue, Math.max(found.get(issue) ?? 0, info.closeTime?.getTime() ?? 0));
      }
    }
    const newestFirst = [...found].sort((a, b) => b[1] - a[1] || b[0] - a[0]).map(([issue]) => issue);
    const named = newestFirst.slice(0, MAX_CLOSED_NOT_READY);
    let notLookedUp = newestFirst.length - named.length;
    if (pastBound) {
      // The rows past the bound were not read, and the count says how many. The row that proved there was one is at least one of them.
      const { count } = await deps.client.workflow.count(CLOSED_NOT_READY_QUERY);
      notLookedUp += Math.max(1, count - rowsRead);
    }
    const runs: RunStatusEntry[] = [];
    for (const issue of named) {
      const entry = await readRunStatus(issue);
      // A run that is open again, gone, or completed since the list has no closed end to report.
      if (entry !== undefined && entry.status !== 'completed') {
        runs.push(entry);
      }
    }
    return { runs, notLookedUp };
  }

  return { listRunningIssues, startQueuedRun, readRunStatuses, listClosedRuns };
}

export type QueueActivities = ReturnType<typeof createQueueActivities>;
