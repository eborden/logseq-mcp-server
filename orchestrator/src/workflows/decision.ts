// The third part of IssueWorkflow (#631, parent plan #625): from "the review loop ended" to the merge the maintainer
// makes, with the maintainer's decision as a signal. CLAUDE.md "Merge policy" and "Verification before merge",
// foundations 4.2, 4.5 and 4.8.
//
// What it does, in order:
//   hold      read the PR (`getPrState`) and the merge gate (`getGateStatus`, then the pure `gateClear`) until it is clear. A decision that
//             arrived earlier is HELD in the inbox, not applied and not rejected: it is used only on a clear gate. A
//             gate that is still open (a thread nobody resolved) is read again every `decisionPollMs`.
//   wait      on a clear gate with no decision, wait for the `maintainerDecision` signal, at no cost, up to the
//             decision timeout. A decision that arrives is checked against the gate once more before it is used, so
//             a thread opened in the meantime holds it again.
//   comment   one PR comment per PR (keyed) with the decision, its date, the maintainer's own message quoted, and what
//             the PR changes that only the maintainer decides (golden results, ceilings, ADRs, business rules).
//   changes_requested ends the run there. approved goes on:
//   merge     reads the PR until it shows merged. It never merges. A PR closed unmerged, or a head that moved after the
//             approval (an approval does not survive a push), stops the run with one comment on the issue.
//   done      PR and issue to Done with a read-back (the #635 activities), then the issue is checked closed and closed
//             if not: a PR merged into a branch other than the default does not close its issue.
//
// The maintainer may merge on GitHub and send no signal. The PR's state is read on every pass, so a merged PR goes
// to Done and the closed check with one comment saying no decision was recorded, and a PR closed unmerged stops the run.
// A decision binds to the head the gate reads clear, not to the head the maintainer saw when they sent it.
//
// The first time the gate is clear for a head, the run posts ONE gate-clear statement on the PR (#715): counts and ids, the
// signal command, and the words "not an approval". A push makes it stale (it names its head); the next clear gate on a new head
// posts a new one. The statement is not a decision and changes nothing the gate requires.
//
// A resume run (#747) is the same hold loop with `stopAtGateClear`: it returns right after the statement. See issue.ts.
//
// A timeout never approves. At the decision timeout the run comments on the PR and ends `decision_timeout`.
//
// The inbox keeps the FIRST well-formed decision. A malformed payload and every later signal change nothing; they are
// only counted (`ignoredSignals`), so a duplicate is harmless and a second, different word cannot undo the first.
//
// Workflow code is deterministic. `Date.now()` is Temporal's replayed clock, used only to keep one deadline. History
// carries identifiers, numbers and the maintainer's own message (it travels in the signal), never review text (BR-0001).

import { condition, proxyActivities, sleep } from '@temporalio/workflow';
import type { GithubActivities } from '../activities/github.ts';
import {
  DEFAULT_DECISION_POLL_MS,
  DEFAULT_DECISION_TIMEOUT_MS,
  decisionComment,
  decisionCommentKey,
  decisionTimeoutComment,
  decisionTimeoutCommentKey,
  mergeTimeoutComment,
  mergeTimeoutCommentKey,
  mergedWithoutDecisionComment,
  mergedWithoutDecisionKey,
  parseMaintainerDecision,
} from '../approval-types.ts';
import type { MaintainerDecision } from '../approval-types.ts';
import { BOARD_ACTIVITY_OPTIONS } from '../board-policy.ts';
import { gateClear } from '../gate.ts';
import type { GateCounts } from '../gate.ts';
import { GITHUB_ACTIVITY_OPTIONS } from '../github-policy.ts';
import { createHostIntegrationGate } from './host-integration.ts';
import { reviewLoop } from './review-loop.ts';
import type { HostFailureSummary } from '../host-integration-policy.ts';
import { DEFAULT_MAX_FIX_ROUNDS } from '../review-policy.ts';
import { BOARD_CONFIRM_READS, BOARD_CONFIRM_WAIT, ISSUE_STEP_TIMEOUT, gateClearComment, gateClearCommentKey, issueBranch, issueWorkflowId } from '../issue-types.ts';
import type { GateHostLine, IssueRunResult, IssueStep, IssueWorkflowInput, StopReason } from '../issue-types.ts';
import type { BoardItemRef, SettableStatus } from '../types.ts';

const github = proxyActivities<
  Pick<GithubActivities, 'getGateStatus' | 'getPrState' | 'getPrChanges' | 'getHostIntegration' | 'checkIssue' | 'closeIssue' | 'commentIssue'>
>({
  ...GITHUB_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});
const board = proxyActivities<Pick<GithubActivities, 'getBoardStatus' | 'setStatus'>>({
  ...BOARD_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});

/** Where the signal handler leaves the decision. Created at the start of the run, so an early signal is kept. */
export interface DecisionInbox {
  /** The signal handler. Never throws: a payload that does not parse is counted and changes nothing. */
  readonly receive: (raw: unknown) => void;
  readonly decision: () => MaintainerDecision | undefined;
  readonly ignored: () => number;
}

export function createDecisionInbox(): DecisionInbox {
  let kept: MaintainerDecision | undefined;
  let ignored = 0;
  return {
    receive: (raw) => {
      if (kept !== undefined) {
        ignored += 1;
        return;
      }
      try {
        kept = parseMaintainerDecision(raw);
      } catch {
        ignored += 1;
      }
    },
    decision: () => kept,
    ignored: () => ignored,
  };
}

export interface DecisionContext {
  readonly input: IssueWorkflowInput;
  readonly pr: number;
  readonly inbox: DecisionInbox;
  /** Fixer rounds the review loop used (#676): the host failure round counts against the same `maxFixRounds`. Default 0. */
  readonly fixRounds?: number;
  /** Where the PR body came from (#708), carried into a host failure review round. */
  readonly bodySource?: 'session' | 'fallback' | 'unknown';
  /** Advisory findings of the review loop's last review (#715), for the gate-clear statement. Counts only. Default 0. */
  readonly advisory?: number;
  readonly advisoryOmitted?: number;
  /** The id of the review those counts come from (#718), linked in the gate-clear statement. Carried with the counts and `advisoryHead`. */
  readonly advisoryReviewId?: number;
  /** The head the review those counts come from was on (the review loop's `headSha`). The counts are said only for that head. */
  readonly advisoryHead?: string;
  /**
   * A resume run (#747): the hold loop is the same, but the run ends at the first clear gate, after the gate-clear statement for that
   * head, with `resumed_gate_clear`. It waits for no decision and moves nothing to Done: the run it replaces is closed, so no signal
   * could reach this one. A merge the maintainer makes while it holds is still seen and finished as for any run. Absent: as before.
   */
  readonly stopAtGateClear?: boolean;
  /** The ID of the run, for the statements it posts. Absent: `issue-<n>`. A resume run has its own (#747). */
  readonly workflowId?: string;
  /** Runs one activity call; a failure of it ends the run at `name` (issue.ts). */
  readonly step: <T>(name: IssueStep, call: () => Promise<T>) => Promise<T>;
  /** Ends the run with one comment on the issue and a Failed workflow (issue.ts). */
  readonly stop: (step: IssueStep, reason: StopReason, detail?: string) => Promise<never>;
}

export async function decisionStage(context: DecisionContext): Promise<IssueRunResult> {
  const { input, pr, inbox, step, stop } = context;
  const issue = input.issueNumber;
  const workflowId = context.workflowId ?? issueWorkflowId(issue);
  const timeoutMs = input.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
  const pollMs = Math.min(input.decisionPollMs ?? DEFAULT_DECISION_POLL_MS, timeoutMs);
  const prItem: BoardItemRef = { kind: 'pr', number: pr };
  const issueItem: BoardItemRef = { kind: 'issue', number: issue };

  /** Reads the board until it shows `wanted`, a bounded number of times (the same rule as issue.ts). */
  async function confirmStatus(target: BoardItemRef, wanted: SettableStatus): Promise<void> {
    for (let read = 1; read <= BOARD_CONFIRM_READS; read += 1) {
      const seen = await step('board_done', () => board.getBoardStatus(target));
      if (seen.onBoard && seen.status === wanted) {
        return;
      }
      if (read < BOARD_CONFIRM_READS) {
        await sleep(BOARD_CONFIRM_WAIT);
      }
    }
    return await stop('board_done', 'BoardDisagrees');
  }

  // The host integration check (#648): only with `hostIntegration: 'auto'`. Absent or `off`, nothing below calls it.
  // A failure on a fixture run goes to one remote fixer round of the review loop, which counts against `maxFixRounds` with the rounds
  // the review loop already used. Local executor: no fixer, every failure stops for a person as before.
  let fixRoundsUsed = context.fixRounds ?? 0;
  // The advisory counts of the last review, for the gate-clear statement (#715). A host failure round posts a newer review.
  let advisory = context.advisory ?? 0;
  let advisoryOmitted = context.advisoryOmitted ?? 0;
  let advisoryHead = context.advisoryHead;
  let advisoryReviewId = context.advisoryReviewId;
  const maxFixRounds = input.maxFixRounds ?? DEFAULT_MAX_FIX_ROUNDS;
  // A resume run (#747) never starts a fixer: the fixer works on `claude/<n>`, and the PR being re-gated may be on another branch.
  const fixHostFailure =
    input.executor === 'remote' && context.stopAtGateClear !== true
      ? async (failedHead: string, summary: HostFailureSummary): Promise<boolean> => {
          if (fixRoundsUsed >= maxFixRounds) {
            return false;
          }
          const looped = await reviewLoop({ input, pr, branch: issueBranch(issue), headSha: failedHead, step, stop, startRound: fixRoundsUsed, hostFailure: summary, ...(context.bodySource === undefined ? {} : { bodySource: context.bodySource }) });
          // The loop reports the rounds it used; a round ran either way, so it is counted at least once.
          fixRoundsUsed = 'fixRounds' in looped ? looped.fixRounds : fixRoundsUsed + 1;
          if ('advisory' in looped) {
            advisory = looped.advisory;
            advisoryOmitted = looped.advisoryOmitted;
            advisoryReviewId = looped.lastReviewId;
            advisoryHead = looped.headSha;
          }
          return true;
        }
      : undefined;
  const hostGate = input.hostIntegration === 'auto' ? createHostIntegrationGate({ pr, base: input.base, step, stop, ...(fixHostFailure === undefined ? {} : { fix: fixHostFailure }) }) : undefined;

  // ---- hold and wait: until the gate is clear and a decision is in hand, or the PR is merged without one -----------
  const decideBy = Date.now() + timeoutMs;
  let decision: MaintainerDecision | undefined;
  let head = '';
  let merged = false;
  /** Heads the gate-clear statement was posted for in this run (#715). The comment's key makes a repeat harmless as well. */
  const statedFor = new Set<string>();
  for (;;) {
    // Only a decision already in hand BEFORE this pass's gate read may be used on it: one that arrived during the read
    // is checked against a fresh read.
    const heldBefore = inbox.decision();
    const gate = await step('decision_gate', () => github.getGateStatus(pr));
    // The maintainer merges on GitHub and may send no signal: the PR's state is read on every pass, not only after an approval.
    const seen = await step('decision_gate', () => github.getPrState(pr));
    head = seen.headSha;
    if (seen.merged) {
      merged = true;
      decision = inbox.decision();
      break;
    }
    if (seen.state === 'closed') {
      return await stop('decision_gate', 'PrClosedUnmerged');
    }
    const left = decideBy - Date.now();
    // A head that the review settled (a review on it, no open thread) is the one the host check is for, once per head.
    // The status is read for the gate's own head, so a pass on an earlier head never clears a later one.
    let judged: GateCounts = gate;
    let host: GateHostLine = hostGate === undefined ? { kind: 'off' } : { kind: 'not_required' };
    if (hostGate !== undefined && gate.reviewsOnHead >= 1 && gate.unresolvedThreads === 0 && (await hostGate.required(gate.headSha))) {
      const status = await step('host_integration', () => github.getHostIntegration({ sha: gate.headSha }));
      judged = { ...gate, hostIntegration: status.state };
      host = { kind: 'checked', state: status.state, ...(status.counts === undefined ? {} : { counts: status.counts }) };
    }
    if (!gateClear(judged)) {
      if (left <= 0) {
        return await timedOut();
      }
      await sleep(Math.min(pollMs, left));
      continue;
    }
    head = gate.headSha;
    // The exit statement (#715): ONE comment on the PR the first time the gate is clear for this head, from counts and ids
    // only. The key carries the head, so a retry posts once and a later push gets its own. A failure to post stops the run.
    if (!statedFor.has(head)) {
      // The counts belong to the review loop's last review. If the head moved since (a person pushed, a host failure round pushed a fix), the
      // statement says the count is not known for this head rather than describe an older head's review as this one's.
      // The review link moves with the counts: it is the id of the review they came from, so it is said only for that head too.
      const countsForHead = advisoryHead === head && advisoryReviewId !== undefined;
      const facts = {
        ...(context.stopAtGateClear === true ? { resumed: true } : {}),
        workflowId,
        issue,
        pr,
        headSha: head,
        fixRounds: fixRoundsUsed,
        reviewsOnHead: gate.reviewsOnHead,
        unresolvedThreads: gate.unresolvedThreads,
        host,
        advisory: countsForHead ? advisory : undefined,
        advisoryOmitted: countsForHead ? advisoryOmitted : undefined,
        lastReviewId: countsForHead ? advisoryReviewId : undefined,
      };
      await step('decision_comment', () => github.commentIssue({ issue: pr, key: gateClearCommentKey(pr, head), body: gateClearComment(facts) }));
      statedFor.add(head);
    }
    if (context.stopAtGateClear === true) {
      return { outcome: 'resumed_gate_clear', issueNumber: issue, pr, headSha: head, reviewsOnHead: gate.reviewsOnHead };
    }
    if (heldBefore !== undefined) {
      decision = heldBefore;
      break;
    }
    if (inbox.decision() !== undefined) {
      continue;
    }
    if (left <= 0) {
      return await timedOut();
    }
    // Wake on the signal or on the poll, whichever comes first, then read the gate and the PR again.
    await condition(() => inbox.decision() !== undefined, Math.min(left, pollMs));
  }

  async function timedOut(): Promise<IssueRunResult> {
    await step('decision_comment', () =>
      github.commentIssue({ issue: pr, key: decisionTimeoutCommentKey(pr), body: decisionTimeoutComment(workflowId, pr, timeoutMs) }),
    );
    return { outcome: 'decision_timeout', issueNumber: issue, pr, headSha: head, ignoredSignals: inbox.ignored() };
  }

  // ---- comment ---------------------------------------------------------------------------------------------------
  if (decision !== undefined) {
    const recorded = decision;
    const changes = await step('decision_comment', () => github.getPrChanges(pr));
    await step('decision_comment', () =>
      github.commentIssue({ issue: pr, key: decisionCommentKey(pr), body: decisionComment(workflowId, pr, head, recorded, changes) }),
    );
    if (decision.decision === 'changes_requested' && !merged) {
      return { outcome: 'changes_requested', issueNumber: issue, pr, headSha: head, ignoredSignals: inbox.ignored() };
    }
  } else {
    await step('decision_comment', () =>
      github.commentIssue({ issue: pr, key: mergedWithoutDecisionKey(pr), body: mergedWithoutDecisionComment(workflowId, pr) }),
    );
  }

  // ---- merge: observed, never made ---------------------------------------------------------------------------------
  const mergeBy = Date.now() + timeoutMs;
  while (!merged) {
    const seen = await step('merge_wait', () => github.getPrState(pr));
    if (seen.merged) {
      break;
    }
    if (seen.state === 'closed') {
      return await stop('merge_wait', 'PrClosedUnmerged');
    }
    if (seen.headSha !== head) {
      // An approval does not survive a push (CLAUDE.md "Merge policy"): the run stops and a person decides again.
      return await stop('merge_wait', 'HeadMovedAfterApproval');
    }
    const left = mergeBy - Date.now();
    if (left <= 0) {
      await step('merge_wait', () =>
        github.commentIssue({ issue: pr, key: mergeTimeoutCommentKey(pr), body: mergeTimeoutComment(workflowId, pr, timeoutMs) }),
      );
      return { outcome: 'merge_timeout', issueNumber: issue, pr, headSha: head, ignoredSignals: inbox.ignored() };
    }
    await sleep(Math.min(pollMs, left));
  }

  // ---- done: the board, then the issue's own state -----------------------------------------------------------------
  await step('board_done', () => board.setStatus(prItem, 'Done'));
  await confirmStatus(prItem, 'Done');
  await step('board_done', () => board.setStatus(issueItem, 'Done'));
  await confirmStatus(issueItem, 'Done');

  // The cause of an issue left open after its PR merged was not established (#626), so this verifies, not assumes.
  let closedByRun = false;
  if ((await step('issue_close', () => github.checkIssue(issue))).open) {
    await step('issue_close', () => github.closeIssue(issue));
    closedByRun = true;
    if ((await step('issue_close', () => github.checkIssue(issue))).open) {
      return await stop('issue_close', 'IssueStillOpen');
    }
  }
  return { outcome: 'merged', issueNumber: issue, pr, headSha: head, issueClosedByRun: closedByRun, decisionRecorded: decision !== undefined, ignoredSignals: inbox.ignored() };
}
