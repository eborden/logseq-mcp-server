// The bounds of the GitHub activities, in one place that workflow code may import: this file imports nothing from
// Node and nothing from config.ts (gh-config.ts reads config and is not safe to bundle into a workflow, #629).
// gh-config.ts and board-policy.ts re-export from here, so existing imports keep working.

import type { ActivityOptions } from '@temporalio/workflow';

/**
 * What the workflow gives every GitHub activity. One attempt can wait out three rate limits of up to ten minutes
 * each (30 minutes in all, DEFAULT_RATE_LIMIT in gh-config.ts) on top of the time of its own requests, so the
 * start-to-close timeout is longer than that. While it waits it heartbeats every 5 seconds, and a request is bounded
 * by `timeoutMs` (30 s), so a heartbeat timeout of two minutes tells a dead worker from a waiting one.
 */
export const GITHUB_ACTIVITY_TIMEOUTS = {
  startToCloseTimeout: '45 minutes',
  heartbeatTimeout: '2 minutes',
} as const;

/** Failure types a retry cannot fix. `BoardReadbackMismatch` is not among them: it is the one a retry may fix. */
export const NON_RETRYABLE_GITHUB_FAILURES: string[] = [
  'InvalidInput',
  'InvalidState',
  'NotFound',
  'UntrustedAuthor',
  'MalformedGhOutput',
  'TooLarge',
  'GitHubRateLimitTooLong',
  'GitHubRateLimitExhausted',
  'GhUnavailable',
  'GitHubClientError',
];

/** The most attempts of a GitHub activity: Temporal's default is unlimited, which would loop on a broken premise. */
export const GITHUB_ACTIVITY_MAX_ATTEMPTS = 3;

/** Options for the GitHub activities that do not read the board back (`checkIssue`, `claimIssue`, `openPr`, `commentIssue`). */
export const GITHUB_ACTIVITY_OPTIONS: ActivityOptions = {
  ...GITHUB_ACTIVITY_TIMEOUTS,
  retry: {
    maximumAttempts: GITHUB_ACTIVITY_MAX_ATTEMPTS,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    nonRetryableErrorTypes: NON_RETRYABLE_GITHUB_FAILURES,
  },
};

// ---- the host integration status (#646) --------------------------------------------------------------------------

// Spelled out here, not imported from integration-policy.ts: the test of this file allows it no import but Temporal's.
// The activities assign these to the policy's types, so the compiler keeps the two in step.

/** What `postCommitStatus` takes: the commit, the state and, when the run finished, its counts. The context is fixed. */
export interface PostCommitStatusInput {
  readonly sha: string;
  readonly state: 'pending' | 'success' | 'failure' | 'error';
  readonly counts?: { readonly passed: number; readonly failed: number };
}

export interface PostCommitStatusResult {
  /** True when this call wrote the status. A repeat of the state the head already shows answers false. */
  readonly posted: boolean;
}

/** What `getHostIntegration` answers: the latest `host/integration` state of a commit, and its counts when it has them. */
export interface HostIntegrationResult {
  readonly state: 'none' | 'pending' | 'success' | 'failure' | 'error';
  readonly counts?: { readonly passed: number; readonly failed: number };
}
