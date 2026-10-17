// The third part of IssueWorkflow (#631, parent plan #625): from "the review loop ended" to the merge the maintainer
// makes, with the maintainer's decision as a signal. CLAUDE.md "Merge policy" and "Verification before merge",
// foundations 4.2, 4.5 and 4.8.
//
// What it does, in order:
//   hold      read the merge gate (`getGateStatus`, then the pure `gateClear`) until it is clear. A decision that
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
  parseMaintainerDecision,
} from '../approval-types.ts';
import type { MaintainerDecision } from '../approval-types.ts';
import { BOARD_ACTIVITY_OPTIONS } from '../board-policy.ts';
import { gateClear } from '../gate.ts';
import { GITHUB_ACTIVITY_OPTIONS } from '../github-policy.ts';
import { BOARD_CONFIRM_READS, BOARD_CONFIRM_WAIT, ISSUE_STEP_TIMEOUT, issueWorkflowId } from '../issue-types.ts';
import type { IssueRunResult, IssueStep, IssueWorkflowInput, StopReason } from '../issue-types.ts';
import type { BoardItemRef, SettableStatus } from '../types.ts';

const github = proxyActivities<
  Pick<GithubActivities, 'getGateStatus' | 'getPrState' | 'getPrChanges' | 'checkIssue' | 'closeIssue' | 'commentIssue'>
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
  /** Runs one activity call; a failure of it ends the run at `name` (issue.ts). */
  readonly step: <T>(name: IssueStep, call: () => Promise<T>) => Promise<T>;
  /** Ends the run with one comment on the issue and a Failed workflow (issue.ts). */
  readonly stop: (step: IssueStep, reason: StopReason) => Promise<never>;
}

export async function decisionStage(context: DecisionContext): Promise<IssueRunResult> {
  const { input, pr, inbox, step, stop } = context;
  const issue = input.issueNumber;
  const workflowId = issueWorkflowId(issue);
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

  // ---- hold and wait: until the gate is clear and a decision is in hand ----------------------------------------
  const decideBy = Date.now() + timeoutMs;
  let decision: MaintainerDecision;
  let head: string;
  /** The head of the last gate read: the head a timeout reports. */
  let lastHead = '';
  for (;;) {
    const gate = await step('decision_gate', () => github.getGateStatus(pr));
    lastHead = gate.headSha;
    const left = decideBy - Date.now();
    if (!gateClear(gate)) {
      if (left <= 0) {
        return await timedOut();
      }
      await sleep(Math.min(pollMs, left));
      continue;
    }
    const kept = inbox.decision();
    if (kept !== undefined) {
      decision = kept;
      head = gate.headSha;
      break;
    }
    if (left <= 0 || !(await condition(() => inbox.decision() !== undefined, left))) {
      return await timedOut();
    }
    // A decision arrived: read the gate again before it is used.
  }

  async function timedOut(): Promise<IssueRunResult> {
    await step('decision_comment', () =>
      github.commentIssue({ issue: pr, key: decisionTimeoutCommentKey(pr), body: decisionTimeoutComment(workflowId, pr, timeoutMs) }),
    );
    return { outcome: 'decision_timeout', issueNumber: issue, pr, headSha: lastHead, ignoredSignals: inbox.ignored() };
  }

  // ---- comment ---------------------------------------------------------------------------------------------------
  const changes = await step('decision_comment', () => github.getPrChanges(pr));
  await step('decision_comment', () =>
    github.commentIssue({ issue: pr, key: decisionCommentKey(pr), body: decisionComment(workflowId, pr, head, decision, changes) }),
  );
  if (decision.decision === 'changes_requested') {
    return { outcome: 'changes_requested', issueNumber: issue, pr, headSha: head, ignoredSignals: inbox.ignored() };
  }

  // ---- merge: observed, never made ---------------------------------------------------------------------------------
  const mergeBy = Date.now() + timeoutMs;
  for (;;) {
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
  return { outcome: 'merged', issueNumber: issue, pr, headSha: head, issueClosedByRun: closedByRun, ignoredSignals: inbox.ignored() };
}
