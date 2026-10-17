// The bounds of the review loop (#630, foundations 4.6), in one place that workflow code may import: this file imports
// nothing from Node and nothing from config.ts.

import type { ActivityOptions } from '@temporalio/workflow';
import { CLAUDE_SESSION_ACTIVITY_OPTIONS, IMPLEMENTER_START_TO_CLOSE_MS, NON_RETRYABLE_SESSION_FAILURES } from './claude-session-policy.ts';
import { GITHUB_ACTIVITY_OPTIONS, NON_RETRYABLE_GITHUB_FAILURES } from './github-policy.ts';

/**
 * ASSUMPTION for the maintainer to confirm (#630 "Open questions"): the most fixer rounds before the workflow stops
 * and hands the PR over. A round is one fixer session followed by one closing review. The input may set another
 * number (1 to MAX_FIX_ROUNDS_LIMIT), which is how the tests use a small one.
 */
export const DEFAULT_MAX_FIX_ROUNDS = 3;
export const MAX_FIX_ROUNDS_LIMIT = 10;

/**
 * ASSUMPTION for the maintainer to confirm: the longest the review loop (every review, fix and gate read after the
 * PR opened) may take in all. At this limit the running step is cancelled, the run comments once and stops. Each step
 * has its own timeout inside it (ISSUE_STEP_TIMEOUT in issue-types.ts). The input may set another value in milliseconds.
 */
export const DEFAULT_REVIEW_LOOP_TIMEOUT_MS = 4 * 60 * 60_000;
export const MIN_REVIEW_LOOP_TIMEOUT_MS = 1_000;
export const MAX_REVIEW_LOOP_TIMEOUT_MS = 6 * 60 * 60_000;

/** How many times the workflow reads the gate while GitHub still shows an older head than the one just pushed, and the wait between. */
export const GATE_READS = 3;
export const GATE_READ_WAIT = '5 seconds';

/**
 * Failure types of the review activities that a retry cannot fix. A session is never retried after it ran: its marker
 * (in the repo's git config) turns a retry into `SessionInterrupted` or `SessionError`, never a second session.
 */
export const NON_RETRYABLE_REVIEW_FAILURES: string[] = [
  ...NON_RETRYABLE_SESSION_FAILURES,
  ...NON_RETRYABLE_GITHUB_FAILURES,
  'SessionError',
  'SessionInterrupted',
  'MalformedFindings',
  'FindingsTooLarge',
  'BriefTooLarge',
  'BranchMoved',
];

/** The reviewer and the fixer each read from GitHub before the session, so they get the implementer's budget. */
export const REVIEW_SESSION_ACTIVITY_OPTIONS: ActivityOptions = {
  ...CLAUDE_SESSION_ACTIVITY_OPTIONS,
  startToCloseTimeout: IMPLEMENTER_START_TO_CLOSE_MS,
  retry: { ...CLAUDE_SESSION_ACTIVITY_OPTIONS.retry, nonRetryableErrorTypes: NON_RETRYABLE_REVIEW_FAILURES },
};

/** The activities that read or write GitHub for the loop (thread list, post a review, post replies, read the gate). */
export const REVIEW_GITHUB_ACTIVITY_OPTIONS: ActivityOptions = {
  ...GITHUB_ACTIVITY_OPTIONS,
  retry: { ...GITHUB_ACTIVITY_OPTIONS.retry, nonRetryableErrorTypes: NON_RETRYABLE_REVIEW_FAILURES },
};
