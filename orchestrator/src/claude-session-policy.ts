// The bounds of `runClaudeSession` (foundations 4.6), in one place that workflow code may import (it imports
// nothing from Node). The activity enforces SESSION_TIMEOUT_MS itself and stops the child, so the Temporal
// start-to-close timeout is set longer: it is the backstop for a worker that stops responding, not the first line.

import type { ActivityOptions } from '@temporalio/workflow';

/** How long one `claude -p` session may run before the activity stops it. */
export const SESSION_TIMEOUT_MS = 30 * 60_000;
/** How often the activity heartbeats while the session runs. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
/**
 * How long Temporal waits for a heartbeat before it counts the attempt dead. The heartbeat is a timer that runs
 * from the start of the activity to its end, so no git call or session can starve it, however long it takes:
 * the timeout only has to be a few intervals.
 */
export const HEARTBEAT_TIMEOUT_MS = 30_000;
/** How long a stopped child has to exit after SIGTERM before it gets SIGKILL. */
export const KILL_GRACE_MS = 5_000;

/** Failure types a retry cannot fix. A session is never retried, because a retry must not start a second one. */
export const NON_RETRYABLE_SESSION_FAILURES: string[] = [
  'InvalidInput',
  'SessionTimeout',
  'MalformedResult',
  'ClaudeUnavailable',
];

export const START_TO_CLOSE_MS = 35 * 60_000;

export const CLAUDE_SESSION_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: START_TO_CLOSE_MS,
  heartbeatTimeout: HEARTBEAT_TIMEOUT_MS,
  retry: {
    // Only infrastructure failures (git, the network) are retried, and each retry is idempotent.
    maximumAttempts: 3,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    nonRetryableErrorTypes: NON_RETRYABLE_SESSION_FAILURES,
  },
};

/**
 * `runImplementerSession` reads the issue before it starts the session, and the read can wait out up to three rate
 * limits of ten minutes each (GITHUB_ACTIVITY_TIMEOUTS, 30 minutes) plus its requests. Sharing the session's 35 minutes
 * with that read would let start-to-close fire in the middle of a session, so the implementer has its own: the read's
 * budget, then the session's own limit, then a margin for git. The workflow still bounds the whole step at 2 hours.
 */
export const IMPLEMENTER_READ_BUDGET_MS = 35 * 60_000;
export const IMPLEMENTER_START_TO_CLOSE_MS = IMPLEMENTER_READ_BUDGET_MS + SESSION_TIMEOUT_MS + 10 * 60_000;

export const IMPLEMENTER_ACTIVITY_OPTIONS: ActivityOptions = {
  ...CLAUDE_SESSION_ACTIVITY_OPTIONS,
  startToCloseTimeout: IMPLEMENTER_START_TO_CLOSE_MS,
};
