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
//                  is the claim, and the start answers what it found:
//                    started           a new run: it holds a slot
//                    already_running   an open run (a start whose result was lost and is retried, or a run the list had not shown
//                                      yet): it holds a slot too, so the cap holds even then
//                    already_finished  a closed run: skipped as `id_already_ran`, no slot
//                  An issue that did not fit is skipped as `over_cap`.
// The whole tick has a deadline (QUEUE_TICK_DEADLINE_MS, src/queue-types.ts): a tick still working at it returns a failed report
// (`TickDeadline` and the step it was in) instead of being killed by the execution timeout with no report.
// It never merges, approves, labels, resolves a thread or moves a board item: it reads, and it starts runs.

import { ApplicationFailure, CancellationScope, isCancellation, proxyActivities } from '@temporalio/workflow';
import type { GithubActivities } from '../activities/github.ts';
import type { QueueActivities } from '../activities/queue.ts';
import { InvalidQueueInputError, MAX_TICK_SKIPS_REPORTED, QUEUE_ACTIVITY_OPTIONS, TICK_DEADLINE_REASON, parseQueueWatcherInput } from '../queue-types.ts';
import type { ParsedQueueInput, TickFailureStep, TickReport, TickSkip } from '../queue-types.ts';
import { eligibleIssues } from '../queue-policy.ts';
import type { TrustedIssues } from '../types.ts';
import { failureReason } from './failure-reason.ts';

const github = proxyActivities<Pick<GithubActivities, 'listReadyIssues' | 'checkTrustedIssues' | 'listTakenIssues'>>(QUEUE_ACTIVITY_OPTIONS);
const queue = proxyActivities<QueueActivities>(QUEUE_ACTIVITY_OPTIONS);

const NOTHING_TO_CHECK: TrustedIssues = { trusted: [], untrusted: [], notRead: [] };

/** What the tick has done so far, so a deadline can report it. */
interface Progress {
  step: TickFailureStep;
  inFlight: number;
  readonly started: number[];
}

function failedReport(cap: number, step: TickFailureStep, reason: string, fields: Partial<TickReport> = {}): TickReport {
  return { outcome: 'failed', cap, inFlight: 0, started: [], skipped: [], skippedNotReported: 0, trustNotRead: 0, ...fields, failure: { step, reason } };
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

  const progress: Progress = { step: 'list_ready', inFlight: 0, started: [] };
  try {
    return await CancellationScope.withTimeout(input.deadlineMs, () => tick(input, progress));
  } catch (error) {
    // The workflow's own cancellation is not the deadline: it passes through.
    if (!isCancellation(error) || CancellationScope.current().consideredCancelled) {
      throw error;
    }
    return failedReport(input.cap, progress.step, TICK_DEADLINE_REASON, { inFlight: progress.inFlight, started: [...progress.started] });
  }
}

async function tick(input: ParsedQueueInput, progress: Progress): Promise<TickReport> {
  let listed;
  let taken;
  let running;
  let trust = NOTHING_TO_CHECK;
  try {
    listed = await github.listReadyIssues();
    progress.step = 'list_taken';
    taken = await github.listTakenIssues();
    progress.step = 'list_running';
    running = await queue.listRunningIssues();
    const takenNow = new Set([...taken.taken, ...running.running]);
    // Blocked issues are skipped before trust is looked at, and a taken one too, so neither costs a request.
    const toCheck = listed.ready.filter((number) => !takenNow.has(number)).sort((a, b) => a - b);
    if (toCheck.length > 0) {
      progress.step = 'check_trusted';
      trust = await github.checkTrustedIssues(toCheck);
    }
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    return failedReport(input.cap, progress.step, failureReason(error));
  }

  const inFlight = running.running.length + running.otherRuns;
  progress.inFlight = inFlight;
  progress.step = 'start';
  const eligibility = eligibleIssues(listed, [...taken.taken, ...running.running], trust.trusted);
  // A number the trust read did not reach is not in `trusted`, so the rule already skips it as `untrusted`.
  const slots = Math.max(0, input.cap - inFlight);

  const started = progress.started;
  // Runs the start found already open. They hold a slot like a run this tick created, so a lost start result (retried, then
  // answered `already_running`) or a list that lagged cannot push the open runs past the cap.
  let alreadyOpen = 0;
  const skipped: TickSkip[] = [...eligibility.skipped];
  let failure: TickReport['failure'];
  for (const number of eligibility.eligible) {
    if (failure !== undefined) {
      break;
    }
    if (started.length + alreadyOpen >= slots) {
      skipped.push({ number, reason: 'over_cap' });
      continue;
    }
    try {
      const result = await queue.startQueuedRun({ issue: number, run: input.run });
      if (result.status === 'started') {
        started.push(number);
      } else if (result.status === 'already_running') {
        alreadyOpen += 1;
        skipped.push({ number, reason: 'already_running' });
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
    started: [...started],
    skipped: skipped.slice(0, MAX_TICK_SKIPS_REPORTED),
    skippedNotReported: eligibility.skippedNotReported + Math.max(0, skipped.length - MAX_TICK_SKIPS_REPORTED),
    trustNotRead: trust.notRead.length,
    ...(failure === undefined ? {} : { failure }),
  };
}
