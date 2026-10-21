// When the host integration check is needed, and how its result is written on a commit (#646, parent plan #643).
// The integration suite needs the LogSeq desktop app on the maintainer's Mac, so it is the one check the loop runs
// locally ("Remote sessions and the host" in the `remote-session` skill, "Verification before merge"). This file holds
// the pure pieces around it: a rule for when the check is needed, and the status the result is recorded as on the PR's
// head commit. Nothing here runs the suite and nothing here calls GitHub.
//
// The status description carries counts and nothing else (BR-0001): it is built from two integers and parsed back
// with a pattern that accepts nothing but that shape, so no test name, message or path can travel in it.
//
// This file imports nothing from Node and nothing from config.ts, and it has no clock and no I/O: workflow code may
// import it. It reuses `normalizePath` of diff-guard.ts, which is workflow-safe for the same reason.

import { normalizePath } from './diff-guard.ts';

// ---- when the check is needed ----------------------------------------------------------------------------------

/** Directories whose changes the integration suite can notice. Lower case, with the trailing slash. */
export const HOST_INTEGRATION_PREFIXES: readonly string[] = ['src/', 'scripts/', 'tests/fixtures/', 'tests/integration/'];

/** Files at the root of the repository that change what the server is built from. Lower case. */
export const HOST_INTEGRATION_FILES: readonly string[] = ['cargo.toml', 'cargo.lock', 'rust-toolchain.toml'];

/** One changed file: its name and, for a rename, the name it had. */
export interface ChangedPath {
  readonly path: string;
  readonly previousPath?: string;
}

function touchesHostCode(path: unknown): boolean {
  // A value that is not a string cannot be shown to be outside the tree: over-report, never throw (activities hand over parsed JSON).
  const normal = typeof path === 'string' ? normalizePath(path) : undefined;
  if (normal === undefined || normal === '') {
    // Not a path inside the work tree: never expected from git, and never waved through.
    return true;
  }
  return HOST_INTEGRATION_PREFIXES.some((prefix) => normal.startsWith(prefix)) || HOST_INTEGRATION_FILES.includes(normal);
}

/**
 * Whether a PR with these changed files needs the integration run on the host (`verify-before-merge`: a change to
 * `src/`, `scripts/`, `Cargo.*`, the toolchain pin or `tests/fixtures/`, and the integration tests themselves). It
 * over-reports on purpose: a wrong "yes" costs one run on the host, a wrong "no" lets a change through unchecked.
 * `complete: false` (the read of the changed files was cut short) is a "yes", since the files not read may be any.
 * A rename counts by both names. Paths are compared after the normalising `diff-guard.ts` does (`./`, `//`, a
 * backslash, lower case). `orchestrator/src/` is not `src/`: the orchestrator is not part of the server.
 */
export function needsHostIntegration(paths: readonly (string | ChangedPath)[], complete: boolean): boolean {
  if (!complete) {
    return true;
  }
  return paths.some((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) {
      return touchesHostCode(entry);
    }
    const changed = entry as Partial<ChangedPath>;
    return touchesHostCode(changed.path) || (changed.previousPath !== undefined && touchesHostCode(changed.previousPath));
  });
}

// ---- the commit status -----------------------------------------------------------------------------------------

/** The context the result is recorded under. No other context is ever written. */
export const HOST_INTEGRATION_CONTEXT = 'host/integration';

export type HostStatusState = 'pending' | 'success' | 'failure' | 'error';

export const HOST_STATUS_STATES: readonly HostStatusState[] = ['pending', 'success', 'failure', 'error'];

/** What a read of the status answers: a state, or `none` when the head has no `host/integration` status. */
export type HostIntegrationState = HostStatusState | 'none';

/** The most a count may be. A suite of a million tests is not expected, and a bound keeps the description short. */
export const MAX_HOST_COUNT = 1_000_000;

/** GitHub cuts a status description at 140 characters; this file never builds a longer one. */
export const MAX_HOST_DESCRIPTION_CHARS = 140;

export interface HostCounts {
  readonly passed: number;
  readonly failed: number;
}

/** The description of a status that has no counts (a run that has not finished, or one that could not start). */
export const NO_COUNTS_DESCRIPTION = 'no counts';

export class InvalidHostStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidHostStatusError';
  }
}

function parseCount(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_HOST_COUNT) {
    throw new InvalidHostStatusError(`${name} must be a whole number from 0 to ${MAX_HOST_COUNT}`);
  }
  return value;
}

/** Counts from untyped input: both fields whole numbers in range. The message never quotes a value. */
export function parseHostCounts(raw: unknown): HostCounts {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidHostStatusError('counts must be an object');
  }
  const passed: unknown = 'passed' in raw ? raw.passed : undefined;
  const failed: unknown = 'failed' in raw ? raw.failed : undefined;
  return { passed: parseCount(passed, 'passed'), failed: parseCount(failed, 'failed') };
}

/** The description of a status: `82 passed, 0 failed`, or the fixed words when there are no counts. Integers only. */
export function buildHostDescription(counts: HostCounts | undefined): string {
  if (counts === undefined) {
    return NO_COUNTS_DESCRIPTION;
  }
  const checked = parseHostCounts(counts);
  return `${checked.passed} passed, ${checked.failed} failed`;
}

const DESCRIPTION_SHAPE = /^(\d{1,7}) passed, (\d{1,7}) failed$/;

/**
 * Reads a description back into its counts. `undefined` for the no-counts words, and `undefined` for anything else:
 * a description somebody else wrote is never echoed, and a shape that does not match yields no counts at all.
 */
export function parseHostDescription(description: string): HostCounts | undefined {
  if (description.length > MAX_HOST_DESCRIPTION_CHARS) {
    return undefined;
  }
  const match = DESCRIPTION_SHAPE.exec(description);
  if (match === null) {
    return undefined;
  }
  const [passed, failed] = [Number(match[1]), Number(match[2])];
  return passed <= MAX_HOST_COUNT && failed <= MAX_HOST_COUNT ? { passed, failed } : undefined;
}

export interface HostStatusInput {
  readonly sha: string;
  readonly state: HostStatusState;
  readonly counts?: HostCounts;
}

const SHA = /^[0-9a-f]{40}$/;

export function parseHostSha(raw: unknown): string {
  if (typeof raw !== 'string' || !SHA.test(raw)) {
    throw new InvalidHostStatusError('sha must be 40 lower-case hexadecimal characters');
  }
  return raw;
}

export function parseHostState(raw: unknown): HostStatusState {
  const state = HOST_STATUS_STATES.find((candidate) => candidate === raw);
  if (state === undefined) {
    throw new InvalidHostStatusError(`state must be one of ${HOST_STATUS_STATES.join(', ')}`);
  }
  return state;
}

/** The input of `postCommitStatus`, parsed at the boundary: a bad sha, state or count is refused before any call. */
export function parseHostStatusInput(raw: unknown): HostStatusInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidHostStatusError('the status input must be an object');
  }
  const sha = parseHostSha('sha' in raw ? raw.sha : undefined);
  const state = parseHostState('state' in raw ? raw.state : undefined);
  const counts: unknown = 'counts' in raw ? raw.counts : undefined;
  return counts === undefined ? { sha, state } : { sha, state, counts: parseHostCounts(counts) };
}
