// How a closed `issueWorkflow` run ended, read for the queue watcher (#724). A stopped run ends Failed with an `IssueStopped`
// failure whose details are the step, the reason and the PR (`stop` in src/workflows/issue.ts). The watcher reports the reason,
// but only when it is one of the orchestrator's own fixed words: a failure's message and a detail of any other shape can hold
// text from a path, a PR or an issue, and none of that may reach a report or the history (BR-0001, BR-0003).
//
// The word list below is the set the code can stop a run with. It is built from the policy lists that name failure types and the
// literals the workflows stop with, and a test (test/queue-watcher.test.ts) reads every `stop('<step>', '<Reason>')` of the
// workflows, so a new reason added there and not here fails it.

import { NON_RETRYABLE_BRANCH_FAILURES } from './branch-types.ts';
import { NON_RETRYABLE_HOST_FAILURES } from './host-integration-policy.ts';
import {
  FIXER_PUSH_REJECTED,
  NEEDS_INPUT,
  NEEDS_INPUT_TIMEOUT,
  REMOTE_BRANCH_MOVED,
  REMOTE_EXECUTOR_UNAVAILABLE,
  REMOTE_LAUNCH_FAILED,
  REMOTE_NO_HEAD,
  REMOTE_SESSION_CLAIMED,
  REMOTE_SESSION_TIMED_OUT,
} from './issue-types.ts';
import type { ClosedRunStatus } from './queue-types.ts';
import { NON_RETRYABLE_REVIEW_FAILURES } from './review-policy.ts';

/** Every word an `issueWorkflow` run records as the reason it stopped. */
export const KNOWN_STOP_REASONS: ReadonlySet<string> = new Set([
  // The failure types of the activities (GitHub, git, sessions, remote sessions, reviews) that reach a stop as its reason.
  ...NON_RETRYABLE_REVIEW_FAILURES,
  ...NON_RETRYABLE_BRANCH_FAILURES,
  ...NON_RETRYABLE_HOST_FAILURES,
  REMOTE_EXECUTOR_UNAVAILABLE,
  REMOTE_SESSION_CLAIMED,
  REMOTE_LAUNCH_FAILED,
  REMOTE_SESSION_TIMED_OUT,
  REMOTE_NO_HEAD,
  REMOTE_BRANCH_MOVED,
  FIXER_PUSH_REJECTED,
  NEEDS_INPUT,
  NEEDS_INPUT_TIMEOUT,
  // The words `failureReason` gives a timeout and an unclassified failure.
  'ActivityTimeout',
  'ActivityFailed',
  // The words the workflows stop with by name.
  'BoardDisagrees',
  'UnexpectedClaimAnswer',
  'SessionError',
  'SessionInterrupted',
  'SessionClaimed',
  'SessionExistingBranch',
  'HeadMismatch',
  'ReviewNotCounted',
  'MaxRoundsReached',
  'ReviewLoopTimeout',
  'PrClosedUnmerged',
  'HeadMovedAfterApproval',
  'IssueStillOpen',
  'IntegrationConflict',
  'IntegrationFailed',
  'IntegrationFixtureDirty',
  'IntegrationSetupError',
  'IntegrationTimeout',
]);

/** What a stopped run's failure details say: the step and the reason, each only when it is a fixed word. */
export interface StopDetails {
  readonly step?: string;
  readonly reason?: string;
}

const STEP_WORD = /^[a-z][a-z_]{0,31}$/;

/** Reads `[step, reason, pr]` from an `IssueStopped` failure's details. The step is a lowercase word and the reason one of KNOWN_STOP_REASONS; anything else is dropped. */
export function stopDetails(details: unknown): StopDetails {
  if (!Array.isArray(details)) {
    return {};
  }
  const [step, reason] = details as unknown[];
  return {
    ...(typeof step === 'string' && STEP_WORD.test(step) ? { step } : {}),
    ...(typeof reason === 'string' && KNOWN_STOP_REASONS.has(reason) ? { reason } : {}),
  };
}

/** A run that stopped to wait for a person's answer and got none (README, "The park"): the park step, or a third needs-input at the session. */
export function isParkedStop(details: StopDetails): boolean {
  return details.step === 'park' || (details.step === 'session' && details.reason === NEEDS_INPUT);
}

/** The status of a run Temporal calls closed, by the name Temporal gives it, or undefined for one that is not a closed end (RUNNING, CONTINUED_AS_NEW, UNSPECIFIED). */
export function closedStatusOfName(name: string): ClosedRunStatus | undefined {
  switch (name) {
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
      return 'failed';
    case 'TERMINATED':
      return 'terminated';
    case 'TIMED_OUT':
      return 'timed_out';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return undefined;
  }
}
