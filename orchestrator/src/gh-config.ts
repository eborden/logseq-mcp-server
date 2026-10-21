// Configuration of the `gh` wrapper, read from the environment once at startup and parsed into a typed value
// (foundations 4.2). Nothing else reads process.env. Tests build a GhConfig directly, with a fake `gh` path.

import { ConfigError } from './config.ts';
import type { Env } from './config.ts';

export interface RateLimitPolicy {
  /** The longest wait the wrapper accepts. A longer one fails the call instead of sleeping (CLAUDE.md: ~10 minutes). */
  readonly maxWaitMs: number;
  /** The wait for a secondary limit that sent no Retry-After. It doubles on each repeat. */
  readonly secondaryMinWaitMs: number;
  /** Waits allowed for one call before it fails. No call retries in a tight loop. */
  readonly maxWaits: number;
}

export interface GhConfig {
  /** The `gh` executable: a bare command name on PATH or an absolute path (tests point it at a fake). */
  readonly ghPath: string;
  /** `owner/name` of the repository the activities work on. */
  readonly repo: string;
  /** Login that owns the project board. */
  readonly projectOwner: string;
  readonly projectNumber: number;
  /** Per `gh` process. */
  readonly timeoutMs: number;
  /** Largest stdout or stderr a `gh` process may produce before it is killed. */
  readonly maxOutputBytes: number;
  readonly rateLimit: RateLimitPolicy;
}

export const DEFAULT_REPO = 'eborden/logseq-mcp-server';
export const DEFAULT_PROJECT_OWNER = 'eborden';
export const DEFAULT_PROJECT_NUMBER = 1;
export const DEFAULT_GH_TIMEOUT_MS = 30_000;
export const MAX_GH_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_RATE_LIMIT: RateLimitPolicy = {
  maxWaitMs: 600_000,
  secondaryMinWaitMs: 60_000,
  maxWaits: 3,
};

// What the workflow gives every GitHub activity lives in github-policy.ts: workflow code cannot import this file,
// which reads config. Re-exported so existing imports keep working.
export { GITHUB_ACTIVITY_TIMEOUTS } from './github-policy.ts';

const GH_PATH = /^[A-Za-z0-9._/+-]{1,1024}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

function blankAsAbsent(raw: string | undefined): string | undefined {
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

function parseWholeNumber(name: string, raw: string, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ConfigError(`${name} must be a whole number from 1 to ${max}`);
  }
  return value;
}

export function loadGhConfig(env: Env): GhConfig {
  const ghPath = blankAsAbsent(env['ORCHESTRATOR_GH_PATH']) ?? 'gh';
  if (!GH_PATH.test(ghPath)) {
    throw new ConfigError('ORCHESTRATOR_GH_PATH must be a command name or a path with no spaces or shell characters');
  }
  const repo = blankAsAbsent(env['ORCHESTRATOR_GITHUB_REPO']) ?? DEFAULT_REPO;
  if (!REPO.test(repo)) {
    throw new ConfigError('ORCHESTRATOR_GITHUB_REPO must look like owner/name');
  }
  const projectOwner = blankAsAbsent(env['ORCHESTRATOR_PROJECT_OWNER']) ?? DEFAULT_PROJECT_OWNER;
  if (!LOGIN.test(projectOwner)) {
    throw new ConfigError('ORCHESTRATOR_PROJECT_OWNER must be a GitHub login');
  }
  const rawNumber = blankAsAbsent(env['ORCHESTRATOR_PROJECT_NUMBER']);
  const rawTimeout = blankAsAbsent(env['ORCHESTRATOR_GH_TIMEOUT_MS']);
  return {
    ghPath,
    repo,
    projectOwner,
    projectNumber:
      rawNumber === undefined ? DEFAULT_PROJECT_NUMBER : parseWholeNumber('ORCHESTRATOR_PROJECT_NUMBER', rawNumber, 100_000),
    timeoutMs:
      rawTimeout === undefined
        ? DEFAULT_GH_TIMEOUT_MS
        : parseWholeNumber('ORCHESTRATOR_GH_TIMEOUT_MS', rawTimeout, MAX_GH_TIMEOUT_MS),
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    rateLimit: DEFAULT_RATE_LIMIT,
  };
}
