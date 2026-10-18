// The input, result and bounds of `runRemoteSession` (#672, parent plan #643), in one place that workflow code may
// import: this file imports nothing from Node and nothing from config.ts, and it has no clock and no I/O.
//
// A remote session is started by firing a routine (one per role) and cannot be stopped or messaged from here. So the
// activity claims before it fires, records a keyed marker before the call (the call is not idempotent), bounds its
// wait with a wall-clock cap, and reads the outcome from GitHub state, never from anything the session says. The input
// is parsed at the boundary (foundations 4.2); the result is identifiers, counts and fixed words.

import type { ActivityOptions } from '@temporalio/workflow';
import { NON_RETRYABLE_GITHUB_FAILURES } from './github-policy.ts';

export const REMOTE_ROLES = ['implementer', 'reviewer', 'fixer'] as const;
export type RemoteRole = (typeof REMOTE_ROLES)[number];

/** The most characters the fire endpoint takes in the per-run `text`. A longer brief is refused whole, never cut. */
export const REMOTE_TEXT_MAX_CHARS = 65_536;

export interface RemoteSessionInput {
  readonly role: RemoteRole;
  readonly issue: number;
  /** The PR the session works on. Required for the reviewer and the fixer. */
  readonly pr?: number;
  /** The branch the session pushes (implementer, fixer) or reviews. */
  readonly branch: string;
  readonly base: string;
  /** The tip the session starts from. Required for the reviewer and the fixer, absent for the implementer. */
  readonly headSha?: string;
  /** Built by `brief.ts` and sent untouched as the per-run text. It is data to the session. */
  readonly brief: string;
  /**
   * Which launch of this (issue, role, head) this is, a positive whole number, 1 when absent. It is part of the marker key
   * (#673): the same attempt re-attaches to the session it fired, a higher one fires a new session. The workflow owns the
   * counter. Attempt 1 has the key it had before the field existed.
   */
  readonly attempt?: number;
  /**
   * The reviewer's keyed findings marker (`findingsMarker`, findings-comment.ts). When set, a trusted comment carrying it
   * on the PR ends the reviewer wait, as a review on the head does (#682). Reviewer only; absent keeps the review-only wait.
   */
  readonly findingsMarker?: string;
}

/** Why nothing was launched: something already holds the work. */
export type RemoteClaim = 'open_pr' | 'branch_exists' | 'branch_moved' | 'already_reviewed';
export const REMOTE_CLAIMS: readonly RemoteClaim[] = ['open_pr', 'branch_exists', 'branch_moved', 'already_reviewed'];

/** Why a launch failed within its budget. The session may or may not exist for `server_error` and `network`. */
export type RemoteLaunchFailure = 'rate_limited' | 'server_error' | 'network';
export const REMOTE_LAUNCH_FAILURES: readonly RemoteLaunchFailure[] = ['rate_limited', 'server_error', 'network'];

export type RemoteOutcome = 'finished' | 'timed_out' | 'failed';
export const REMOTE_OUTCOMES: readonly RemoteOutcome[] = ['finished', 'timed_out', 'failed'];

export interface RemoteSessionResult {
  readonly outcome: RemoteOutcome;
  /** The session the call launched or re-attached to. Absent when none is known (a claim, a failed launch, an orphan). */
  readonly sessionId?: string;
  /** The branch tip (implementer, fixer) or the reviewed head (reviewer) the outcome was read from. */
  readonly headSha?: string;
  /** Set with `failed` when the claim found the work taken: nothing was launched. */
  readonly claim?: RemoteClaim;
  /** Set with `failed` when the launch failed within its budget. */
  readonly failure?: RemoteLaunchFailure;
}

export class InvalidRemoteSessionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRemoteSessionInputError';
  }
}

const SHA = /^[0-9a-f]{40}$/;
const BASE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const BRANCH = /^claude\/(\d{1,9})(?:-[A-Za-z0-9._-]{1,80})?$/;
const MAX_NUMBER = 999_999_999;

function wholeNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_NUMBER) {
    throw new InvalidRemoteSessionInputError(`${name} must be a positive whole number`);
  }
  return value;
}

/** Parses untrusted activity input. A message never quotes a value. */
export function parseRemoteSessionInput(raw: unknown): RemoteSessionInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidRemoteSessionInputError('input must be an object');
  }
  const field = (name: string): unknown => (name in raw ? (raw as Record<string, unknown>)[name] : undefined);
  const role = REMOTE_ROLES.find((candidate) => candidate === field('role'));
  if (role === undefined) {
    throw new InvalidRemoteSessionInputError('role must be implementer, reviewer or fixer');
  }
  const issue = wholeNumber(field('issue'), 'issue');
  const branch = field('branch');
  const match = typeof branch === 'string' ? BRANCH.exec(branch) : null;
  if (typeof branch !== 'string' || match === null || Number(match[1]) !== issue) {
    throw new InvalidRemoteSessionInputError('branch must be claude/<issue> or claude/<issue>-<suffix> for the same issue');
  }
  const base = field('base');
  if (typeof base !== 'string' || !BASE.test(base) || base.includes('..') || base.includes('//') || base.endsWith('/') || base.endsWith('.') || base.endsWith('.lock')) {
    throw new InvalidRemoteSessionInputError('base must be a plain branch name');
  }
  const rawPr = field('pr');
  const rawHead = field('headSha');
  const pr = rawPr === undefined ? undefined : wholeNumber(rawPr, 'pr');
  if (rawHead !== undefined && (typeof rawHead !== 'string' || !SHA.test(rawHead))) {
    throw new InvalidRemoteSessionInputError('headSha must be a 40 character commit id');
  }
  const headSha = rawHead;
  if (role !== 'implementer' && (pr === undefined || headSha === undefined)) {
    throw new InvalidRemoteSessionInputError('the reviewer and the fixer need pr and headSha');
  }
  const brief = field('brief');
  if (typeof brief !== 'string' || brief.trim() === '' || brief.includes('\0')) {
    throw new InvalidRemoteSessionInputError('brief must be a non-empty string');
  }
  if (brief.length > REMOTE_TEXT_MAX_CHARS) {
    throw new InvalidRemoteSessionInputError(`brief must be at most ${REMOTE_TEXT_MAX_CHARS} characters`);
  }
  const rawAttempt = field('attempt');
  const attempt = rawAttempt === undefined ? undefined : wholeNumber(rawAttempt, 'attempt');
  const rawMarker = field('findingsMarker');
  if (rawMarker !== undefined) {
    if (role !== 'reviewer') {
      throw new InvalidRemoteSessionInputError('findingsMarker is for the reviewer only');
    }
    // The shape is checked against `findingsMarker` itself by the activity (it may import findings-comment.ts, this file may not).
    if (typeof rawMarker !== 'string' || rawMarker.length > 200 || !rawMarker.includes(` pr=${pr} head=${headSha} `)) {
      throw new InvalidRemoteSessionInputError('findingsMarker must be the findings marker of this pr and headSha');
    }
  }
  return {
    role,
    issue,
    ...(pr === undefined ? {} : { pr }),
    branch,
    base,
    ...(headSha === undefined ? {} : { headSha }),
    brief,
    ...(attempt === undefined ? {} : { attempt }),
    ...(rawMarker === undefined ? {} : { findingsMarker: rawMarker as string }),
  };
}

// ---- bounds ----------------------------------------------------------------------------------------------------

export interface RemoteLimits {
  /** The longest the session may take, from the moment its id was recorded (so a restart does not extend it). */
  readonly capMs: number;
  /** The wait between two reads of GitHub. */
  readonly pollIntervalMs: number;
  /** A pushed tip must stay unchanged this long, with no check pending, to count as the end. A later push moves it. */
  readonly settleMs: number;
  /** After a restart with a `firing` marker and no id: how long GitHub is watched for the earlier session's work before firing again. */
  readonly orphanPollMs: number;
  readonly heartbeatIntervalMs: number;
  /**
   * Most fire calls in one activity attempt (the first and its retries). The worst case for one key is this times the
   * activity's `maximumAttempts` (2), so 6 calls, and it needs a crash or a 5xx that came after a session was made.
   */
  readonly fireAttempts: number;
  /** The first wait before retrying a 5xx. It doubles. */
  readonly fireBackoffMs: number;
  /** The longest `Retry-After` honoured. A longer one ends the launch as `rate_limited`. */
  readonly retryAfterMaxMs: number;
}

// ASSUMPTIONS for the maintainer to confirm (#672 has no numbers): a session may run an hour, GitHub is read every
// 30 seconds, a tip must rest for 3 minutes, and an orphaned firing is watched for 10 minutes before a refire.
export const REMOTE_LIMITS: RemoteLimits = {
  capMs: 60 * 60_000,
  pollIntervalMs: 30_000,
  settleMs: 3 * 60_000,
  orphanPollMs: 10 * 60_000,
  heartbeatIntervalMs: 5_000,
  fireAttempts: 3,
  fireBackoffMs: 2_000,
  retryAfterMaxMs: 2 * 60_000,
};

export const REMOTE_HEARTBEAT_TIMEOUT_MS = 30_000;
/** The orphan watch, then the cap, then a margin for the reads, the fire call and its retries. */
export const REMOTE_START_TO_CLOSE_MS = REMOTE_LIMITS.orphanPollMs + REMOTE_LIMITS.capMs + 15 * 60_000;

/**
 * Failure types a retry cannot fix. `RoutineRejected` (400, 404) and `RoutineAuth` (401, 403) stop for a person.
 * `MalformedMarker` is a marker in the repo's git config that this code did not write.
 */
export const NON_RETRYABLE_REMOTE_FAILURES: string[] = [
  ...NON_RETRYABLE_GITHUB_FAILURES,
  'RoutineRejected',
  'RoutineAuth',
  'MalformedMarker',
];

/**
 * Two attempts (a retry multiplies the fire budget: 2 x `fireAttempts` calls at most), and every retry is safe: a repeat finds the marker and re-attaches (id recorded) or watches GitHub
 * before it fires again (`firing`), so a retry never fires a second session on its own.
 */
export const REMOTE_SESSION_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: REMOTE_START_TO_CLOSE_MS,
  heartbeatTimeout: REMOTE_HEARTBEAT_TIMEOUT_MS,
  retry: {
    maximumAttempts: 2,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '60 seconds',
    nonRetryableErrorTypes: NON_RETRYABLE_REMOTE_FAILURES,
  },
};
