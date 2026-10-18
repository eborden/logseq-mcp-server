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

/**
 * Integers and one fixed word. `passed` and `failed` are 0 when the suite did not run to a report. `failureSummary` is
 * present only for a `fail` of a run the activity proved to be on the fixture instance (#676, BR-0001 as narrowed by #669).
 */
export interface HostIntegrationResult {
  readonly outcome: HostIntegrationOutcome;
  readonly passed: number;
  readonly failed: number;
  readonly failureSummary?: HostFailureSummary;
}

// ---- the failure summary (#676) -------------------------------------------------------------------------------
// A bounded list of failing test names, each with one short assertion line, for the remote fixer's brief. It exists only
// for a run on the committed fixture graph, whose every value is fictional. It is data in the brief, never an
// instruction, and it is never written to a comment or a commit status (those keep counts: `buildHostDescription`).

export const MAX_FAILURE_TESTS = 10;
export const MAX_FAILURE_NAME_CHARS = 200;
export const MAX_FAILURE_MESSAGE_CHARS = 300;

export interface HostFailureTest {
  readonly name: string;
  readonly message: string;
}

export interface HostFailureSummary {
  readonly tests: readonly HostFailureTest[];
  /** Failing tests left out because of `MAX_FAILURE_TESTS` (BR-0006: a cap says so). */
  readonly droppedTests: number;
  /** Names and messages cut to their character bound. */
  readonly cutFields: number;
}

/** One printable line: no colour codes, no control characters, one run of spaces, at most `max` characters. */
function oneLine(text: string, max: number): { readonly text: string; readonly cut: boolean } {
  const first = text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((part) => part.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim())
    .find((part) => part !== '');
  const line = first ?? '';
  return line.length > max ? { text: line.slice(0, max), cut: true } : { text: line, cut: false };
}

/**
 * The failing tests of the JSON reporter's report, capped. `undefined` when the report has no failing assertion to name
 * (a suite that failed to load, a bad shape): the caller then gives counts only.
 */
export function summariseHostFailures(reportText: string): HostFailureSummary | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reportText);
  } catch {
    return undefined;
  }
  const files: unknown = typeof parsed === 'object' && parsed !== null && 'testResults' in parsed ? parsed.testResults : undefined;
  if (!Array.isArray(files)) {
    return undefined;
  }
  const tests: HostFailureTest[] = [];
  let failing = 0;
  let cutFields = 0;
  for (const file of files as unknown[]) {
    const results: unknown = typeof file === 'object' && file !== null && 'assertionResults' in file ? file.assertionResults : undefined;
    if (!Array.isArray(results)) {
      continue;
    }
    for (const result of results as unknown[]) {
      if (typeof result !== 'object' || result === null || !('status' in result) || result.status !== 'failed') {
        continue;
      }
      failing += 1;
      if (tests.length >= MAX_FAILURE_TESTS) {
        continue;
      }
      const title: unknown = 'fullName' in result ? result.fullName : 'title' in result ? result.title : undefined;
      const messages: unknown = 'failureMessages' in result ? result.failureMessages : undefined;
      const name = oneLine(typeof title === 'string' ? title : '', MAX_FAILURE_NAME_CHARS);
      const message = oneLine(Array.isArray(messages) && typeof messages[0] === 'string' ? messages[0] : '', MAX_FAILURE_MESSAGE_CHARS);
      cutFields += (name.cut ? 1 : 0) + (message.cut ? 1 : 0);
      tests.push({ name: name.text, message: message.text });
    }
  }
  return failing === 0 ? undefined : { tests, droppedTests: failing - tests.length, cutFields };
}

/** Parses a summary at the boundary (it crosses from the host activity into another activity's input). `undefined` when absent. */
export function parseHostFailureSummary(raw: unknown): HostFailureSummary | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidHostIntegrationInputError('failureSummary must be an object');
  }
  const tests: unknown = 'tests' in raw ? raw.tests : undefined;
  const dropped: unknown = 'droppedTests' in raw ? raw.droppedTests : undefined;
  const cut: unknown = 'cutFields' in raw ? raw.cutFields : undefined;
  if (!Array.isArray(tests) || tests.length > MAX_FAILURE_TESTS || typeof dropped !== 'number' || !Number.isSafeInteger(dropped) || dropped < 0 || typeof cut !== 'number' || !Number.isSafeInteger(cut) || cut < 0) {
    throw new InvalidHostIntegrationInputError('failureSummary has the wrong shape');
  }
  const kept = (tests as unknown[]).map((entry) => {
    const name: unknown = typeof entry === 'object' && entry !== null && 'name' in entry ? entry.name : undefined;
    const message: unknown = typeof entry === 'object' && entry !== null && 'message' in entry ? entry.message : undefined;
    if (typeof name !== 'string' || name.length > MAX_FAILURE_NAME_CHARS || typeof message !== 'string' || message.length > MAX_FAILURE_MESSAGE_CHARS) {
      throw new InvalidHostIntegrationInputError('failureSummary has the wrong shape');
    }
    return { name: oneLine(name, MAX_FAILURE_NAME_CHARS).text, message: oneLine(message, MAX_FAILURE_MESSAGE_CHARS).text };
  });
  return { tests: kept, droppedTests: dropped, cutFields: cut };
}

/** The ports the fixture instance script picks from (`scripts/logseq-instance.ts`); LogSeq's own is 12315. */
export const FIXTURE_PORT_MIN = 12320;
export const FIXTURE_PORT_MAX = 12399;

/** Whether an instance config's API address is a fixture instance: loopback, in the fixture's port range. */
export function isFixtureApiUrl(apiUrl: unknown): boolean {
  if (typeof apiUrl !== 'string') {
    return false;
  }
  try {
    const url = new URL(apiUrl);
    const port = Number(url.port);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number.isInteger(port) && port >= FIXTURE_PORT_MIN && port <= FIXTURE_PORT_MAX;
  } catch {
    return false;
  }
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
