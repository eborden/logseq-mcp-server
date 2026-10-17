// Shapes and bounds of the branch activities `guardBranch` and `pushBranch` (#629 review), parsed at their boundary
// (foundations 4.2). This file imports nothing from Node, so workflow code may import its options and types.

import type { ActivityOptions } from '@temporalio/workflow';

/**
 * The only branch name `pushBranch` accepts: `claude/<number>`, nothing else. It is never a refspec (no `:`, no
 * `HEAD`, no `+`), never an option (no leading dash) and never a name with a slug, because the orchestrator itself
 * derives the branch from the issue number (`issueBranch`).
 */
const BRANCH = /^claude\/[1-9][0-9]{0,8}$/;
const SHA = /^[0-9a-f]{40}$/;
const BASE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const MAX_PATH_CHARS = 1024;

export interface BranchInput {
  readonly repoDir: string;
  readonly branch: string;
  /** The tip the session ended at. The guard and the push both refuse a branch that is no longer there. */
  readonly headSha: string;
  /** The branch the PR targets. The diff is `origin/<base>...<headSha>`. */
  readonly base: string;
}

export class InvalidBranchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBranchInputError';
  }
}

export function isPushableBranch(value: unknown): value is string {
  return typeof value === 'string' && BRANCH.test(value);
}

/** Parses untrusted activity input. The message never quotes a value. */
export function parseBranchInput(raw: unknown): BranchInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidBranchInputError('input must be an object');
  }
  const repoDir: unknown = 'repoDir' in raw ? raw.repoDir : undefined;
  const branch: unknown = 'branch' in raw ? raw.branch : undefined;
  const headSha: unknown = 'headSha' in raw ? raw.headSha : undefined;
  const base: unknown = 'base' in raw ? raw.base : undefined;
  if (typeof repoDir !== 'string' || !repoDir.startsWith('/') || repoDir.length > MAX_PATH_CHARS || repoDir.includes('\0')) {
    throw new InvalidBranchInputError('repoDir must be an absolute path');
  }
  if (!isPushableBranch(branch)) {
    throw new InvalidBranchInputError('branch must be claude/<number>');
  }
  if (typeof headSha !== 'string' || !SHA.test(headSha)) {
    throw new InvalidBranchInputError('headSha must be a 40 character commit id');
  }
  if (typeof base !== 'string' || !BASE.test(base) || base.includes('..') || base.includes('//') || base.endsWith('/') || base.endsWith('.lock')) {
    throw new InvalidBranchInputError('base must be a plain branch name');
  }
  return { repoDir, branch, headSha, base };
}

export interface GuardResult {
  readonly branch: string;
  readonly headSha: string;
  /** How many files the branch changes against its base. */
  readonly files: number;
}

export interface PushResult {
  readonly branch: string;
  readonly headSha: string;
}

/** Failure types a retry cannot fix. */
export const NON_RETRYABLE_BRANCH_FAILURES: string[] = [
  'InvalidInput',
  'ProtectedPath',
  'DiffTooLarge',
  'EmptyDiff',
  'BranchMoved',
  'PushRejected',
];

/**
 * Options for both branch activities. A diff, a rev-parse and a push of one branch are short, so five minutes covers
 * the slowest git command's own timeout (src/activities/branch.ts) with room, and three attempts bound the retries.
 */
export const BRANCH_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: '5 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    nonRetryableErrorTypes: NON_RETRYABLE_BRANCH_FAILURES,
  },
};
