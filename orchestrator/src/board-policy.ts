// The bounds of the board activities `addToBoard` and `setStatus` (#635, foundations 4.6), in one place that workflow
// code may import (it imports nothing from Node and nothing from config.ts). The activities enforce the re-read
// bounds themselves; the workflow uses BOARD_ACTIVITY_OPTIONS (or its parts) so a board that never shows a change
// fails the step after a fixed number of tries instead of looping under Temporal's unlimited default.
//
// Two layers, both bounded:
// - Inside one attempt, after a write the activity re-reads the board up to BOARD_RE_READS more times, waiting
//   BOARD_RE_READ_DELAY_MS before each (the wait heartbeats and stops when the activity is cancelled). GitHub
//   Projects can show a stale Status for a moment after a write, and a new item's default Status is set by a board
//   workflow a moment after the add.
// - Across attempts, a board that still does not show the change fails the attempt as `BoardReadbackMismatch`,
//   which is retryable, and BOARD_ACTIVITY_MAX_ATTEMPTS bounds the tries. An item that is on the board but still
//   shows no Status after the re-reads fails the same way (#629): a default Status can arrive late, and the three
//   attempts cover about 40 seconds (6 s of re-reads each, 5 s and 10 s between attempts, plus the reads).

import type { ActivityOptions } from '@temporalio/workflow';
import { GITHUB_ACTIVITY_TIMEOUTS, NON_RETRYABLE_GITHUB_FAILURES } from './github-policy.ts';

/** Re-reads of the board after a write, after the first read-back, before the attempt fails. */
export const BOARD_RE_READS = 3;
/** The wait before each re-read. */
export const BOARD_RE_READ_DELAY_MS = 2_000;
/** The most attempts of an activity whose read-back keeps disagreeing: use it as the retry policy's `maximumAttempts`. */
export const BOARD_ACTIVITY_MAX_ATTEMPTS = 3;

/** Failure types a retry cannot fix. `BoardReadbackMismatch` is not among them: it is the one a retry may fix. */
export const NON_RETRYABLE_BOARD_FAILURES: string[] = NON_RETRYABLE_GITHUB_FAILURES;

/**
 * Options for `addToBoard`, `getBoardStatus` and `setStatus` in the workflow. The timeouts are those of every GitHub
 * activity (GITHUB_ACTIVITY_TIMEOUTS in src/github-policy.ts: 45 minutes and a 2 minute heartbeat).
 */
export const BOARD_ACTIVITY_OPTIONS: ActivityOptions = {
  ...GITHUB_ACTIVITY_TIMEOUTS,
  retry: {
    maximumAttempts: BOARD_ACTIVITY_MAX_ATTEMPTS,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    nonRetryableErrorTypes: NON_RETRYABLE_BOARD_FAILURES,
  },
};
