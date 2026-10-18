// The host-only integration activity (#647, parent plan #643): its task queue, input, result and bounds, in one place
// that workflow code may import. This file imports nothing from Node and nothing from config.ts (the one import below
// is a type), and it has no clock and no I/O.
//
// The activity runs the integration suite on the maintainer's Mac, which is the only machine with the LogSeq desktop
// app. The host is the scarce resource, so its queue has its own worker that runs one activity at a time. The input is
// parsed at the boundary (foundations 4.2); the result is integers and one fixed word, never a test name, a message or
// a path (BR-0001, foundations 4.9).

import type { ActivityOptions } from '@temporalio/workflow';

/** The task queue only the host's worker polls. The workflow routes `runHostIntegration` here. */
export const HOST_TASK_QUEUE_NAME = 'host';

const SHA = /^[0-9a-f]{40}$/;
const BASE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const MAX_PR = 999_999_999;

export interface HostIntegrationInput {
  /** The PR's number: only the work directory and the fetch refspec derive from it. */
  readonly pr: number;
  /** The head commit under test. The run tests exactly this commit, merged onto the base. */
  readonly headSha: string;
  /** The branch the PR targets. */
  readonly base: string;
}

export type HostIntegrationOutcome = 'pass' | 'fail' | 'conflict' | 'fixture_dirty' | 'setup_error';

export const HOST_INTEGRATION_OUTCOMES: readonly HostIntegrationOutcome[] = ['pass', 'fail', 'conflict', 'fixture_dirty', 'setup_error'];

/** Integers and one fixed word. `passed` and `failed` are 0 when the suite did not run to a report. */
export interface HostIntegrationResult {
  readonly outcome: HostIntegrationOutcome;
  readonly passed: number;
  readonly failed: number;
}

export class InvalidHostIntegrationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidHostIntegrationInputError';
  }
}

/** Parses untrusted activity input. The message never quotes a value. */
export function parseHostIntegrationInput(raw: unknown): HostIntegrationInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidHostIntegrationInputError('input must be an object');
  }
  const pr: unknown = 'pr' in raw ? raw.pr : undefined;
  const headSha: unknown = 'headSha' in raw ? raw.headSha : undefined;
  const base: unknown = 'base' in raw ? raw.base : undefined;
  if (typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1 || pr > MAX_PR) {
    throw new InvalidHostIntegrationInputError('pr must be a positive whole number');
  }
  if (typeof headSha !== 'string' || !SHA.test(headSha)) {
    throw new InvalidHostIntegrationInputError('headSha must be a 40 character commit id');
  }
  if (typeof base !== 'string' || !BASE.test(base) || base.includes('..') || base.includes('//') || base.endsWith('/') || base.endsWith('.') || base.endsWith('.lock')) {
    throw new InvalidHostIntegrationInputError('base must be a plain branch name');
  }
  return { pr, headSha, base };
}

// ---- bounds ----------------------------------------------------------------------------------------------------

/**
 * How long the whole run (fetch, install, build, instance, suite) may take before the activity stops what it started.
 * The activity enforces it itself, so the Temporal timeout below is a backstop for a worker that stops answering.
 */
export const HOST_RUN_DEADLINE_MS = 40 * 60_000;
/** A budget of its own for the cleanup (stop the instance, remove the worktree), which runs after the deadline too. */
export const HOST_CLEANUP_BUDGET_MS = 5 * 60_000;
export const HOST_START_TO_CLOSE_MS = HOST_RUN_DEADLINE_MS + HOST_CLEANUP_BUDGET_MS + 5 * 60_000;
export const HOST_HEARTBEAT_INTERVAL_MS = 5_000;
export const HOST_HEARTBEAT_TIMEOUT_MS = 30_000;

/** Failure types a retry cannot fix. */
export const NON_RETRYABLE_HOST_FAILURES: string[] = ['InvalidInput'];

/**
 * One attempt for a test failure: the activity RETURNS `fail`, it does not throw, so there is nothing to retry. A
 * failure before the suite starts (fetch, worktree, install, build, instance start) is thrown once, and the second
 * attempt returns `setup_error` instead of throwing. So `maximumAttempts: 2` is the whole retry budget.
 */
export const HOST_INTEGRATION_ACTIVITY_OPTIONS: ActivityOptions = {
  taskQueue: HOST_TASK_QUEUE_NAME,
  startToCloseTimeout: HOST_START_TO_CLOSE_MS,
  heartbeatTimeout: HOST_HEARTBEAT_TIMEOUT_MS,
  retry: {
    maximumAttempts: 2,
    initialInterval: '10 seconds',
    backoffCoefficient: 1,
    nonRetryableErrorTypes: NON_RETRYABLE_HOST_FAILURES,
  },
};
