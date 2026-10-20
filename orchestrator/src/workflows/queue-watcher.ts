// QueueWatcher (#723, parent plan #721): one tick of the Ready-queue watcher. A Temporal Schedule starts it every few
// minutes (overlap policy skip, src/queue-schedule.ts); it reads which Ready issues may start, counts the runs in flight
// and starts `issueWorkflow` for the lowest-numbered eligible issues, up to the cap, then returns a report of the tick.
//
// Workflow code is deterministic: no clock, no I/O, no randomness. Every side effect is an activity, each bounded by
// QUEUE_ACTIVITY_OPTIONS, and the history carries issue numbers and counts only (BR-0001): no title, label or text of any
// issue. The eligibility rule is the pure `eligibleIssues` (src/queue-policy.ts); the GitHub reads are the #722 activities.
//
// Steps, in order. A failed read fails the tick, never an empty or partial queue (BR-0003): nothing starts after it, and the
// report says which step and the failure's type word.
//   list_ready     listReadyIssues: the Ready column and its open blockers (more than 50 items fails)
//   list_taken     listTakenIssues: open PRs and `claude/<n>` branches (a list over its page bound fails)
//   list_running   listRunningIssues: the `issueWorkflow` executions that are not closed. Their IDs join `taken`, and their
//                  count is what the cap is measured against, so a run held for a decision or a Needs Input answer keeps its slot.
//   check_trusted  checkTrustedIssues, asked about the unblocked, untaken Ready numbers in ascending order, so the lowest
//                  are read first. A number it did not read (`notRead`) is not trusted this tick and is counted in the report.
//   start          startQueuedRun for each eligible issue in ascending order while a slot is free. The workflow ID `issue-<n>`
//                  is the claim: a start of an ID that exists is a skip (`id_already_ran`), not a failure, and it does not
//                  use a slot. An issue that did not fit is skipped as `over_cap`.
// It never merges, approves, labels, resolves a thread or moves a board item: it reads, and it starts runs.

import { ApplicationFailure, isCancellation, proxyActivities } from '@temporalio/workflow';
import type { GithubActivities } from '../activities/github.ts';
import type { QueueActivities } from '../activities/queue.ts';
import { InvalidQueueInputError, MAX_TICK_SKIPS_REPORTED, QUEUE_ACTIVITY_OPTIONS, parseQueueWatcherInput } from '../queue-types.ts';
import type { ParsedQueueInput, TickFailureStep, TickReport, TickSkip } from '../queue-types.ts';
import { eligibleIssues } from '../queue-policy.ts';
import type { TrustedIssues } from '../types.ts';
import { failureReason } from './failure-reason.ts';

const github = proxyActivities<Pick<GithubActivities, 'listReadyIssues' | 'checkTrustedIssues' | 'listTakenIssues'>>(QUEUE_ACTIVITY_OPTIONS);
const queue = proxyActivities<QueueActivities>(QUEUE_ACTIVITY_OPTIONS);

const NOTHING_TO_CHECK: TrustedIssues = { trusted: [], untrusted: [], notRead: [] };

function failedReport(input: ParsedQueueInput, step: TickFailureStep, reason: string, fields: Partial<TickReport> = {}): TickReport {
  return { outcome: 'failed', cap: input.cap, inFlight: 0, started: [], skipped: [], skippedNotReported: 0, trustNotRead: 0, ...fields, failure: { step, reason } };
}

export async function queueWatcher(rawInput: unknown): Promise<TickReport> {
  let input: ParsedQueueInput;
  try {
    input = parseQueueWatcherInput(rawInput);
  } catch (error) {
    if (error instanceof InvalidQueueInputError) {
      throw ApplicationFailure.nonRetryable(error.message, 'InvalidInput');
    }
    throw error;
  }

  let step: TickFailureStep = 'list_ready';
  let listed;
  let taken;
  let running;
  let trust = NOTHING_TO_CHECK;
  try {
    listed = await github.listReadyIssues();
    step = 'list_taken';
    taken = await github.listTakenIssues();
    step = 'list_running';
    running = await queue.listRunningIssues();
    const takenNow = new Set([...taken.taken, ...running.running]);
    // Blocked issues are skipped before trust is looked at, and a taken one too, so neither costs a request.
    const toCheck = listed.ready.filter((number) => !takenNow.has(number)).sort((a, b) => a - b);
    if (toCheck.length > 0) {
      step = 'check_trusted';
      trust = await github.checkTrustedIssues(toCheck);
    }
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    return failedReport(input, step, failureReason(error));
  }

  const inFlight = running.running.length + running.otherRuns;
  const eligibility = eligibleIssues(listed, [...taken.taken, ...running.running], trust.trusted);
  // A number the trust read did not reach is not in `trusted`, so the rule already skips it as `untrusted`.
  const slots = Math.max(0, input.cap - inFlight);

  const started: number[] = [];
  const skipped: TickSkip[] = [...eligibility.skipped];
  let failure: TickReport['failure'];
  for (const number of eligibility.eligible) {
    if (failure !== undefined) {
      break;
    }
    if (started.length >= slots) {
      skipped.push({ number, reason: 'over_cap' });
      continue;
    }
    try {
      const result = await queue.startQueuedRun({ issue: number, run: input.run });
      if (result.started) {
        started.push(number);
      } else {
        skipped.push({ number, reason: 'id_already_ran' });
      }
    } catch (error) {
      if (isCancellation(error)) {
        throw error;
      }
      failure = { step: 'start', reason: failureReason(error) };
    }
  }

  skipped.sort((a, b) => a.number - b.number);
  return {
    outcome: failure === undefined ? 'ok' : 'failed',
    cap: input.cap,
    inFlight,
    started,
    skipped: skipped.slice(0, MAX_TICK_SKIPS_REPORTED),
    skippedNotReported: eligibility.skippedNotReported + Math.max(0, skipped.length - MAX_TICK_SKIPS_REPORTED),
    trustNotRead: trust.notRead.length,
    ...(failure === undefined ? {} : { failure }),
  };
}
