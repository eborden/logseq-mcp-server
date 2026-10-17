// Activities may run more than once (at-least-once, foundations 4.5): a worker can die after the side effect and
// before Temporal hears about it, and a worker that merely stalls can have its attempt retried elsewhere while it
// is still running. Each activity's side effect is therefore idempotent, keyed by the run key and the step name:
//
// - The check and the append happen under one lock (an exclusive-create lock file), so overlapping attempts of
//   one step cannot both write.
// - The line is written in a single append, and a step counts as done only when its whole line is present
//   (an exact match, never a prefix), so a line cut short by a kill is not mistaken for a finished one. The next
//   writer starts a fresh line after it.
// - A lock left behind by a killed worker is broken once it is older than LOCK_STALE_MS. Breaking it is a rename,
//   not a delete, so two waiters cannot both think they own it. The one remaining gap is a holder that stalls for
//   longer than LOCK_STALE_MS between taking the lock and writing, which a lock held for a few milliseconds makes
//   very unlikely and which v1 accepts.

import { randomUUID } from 'node:crypto';
import { appendFile, type FileHandle, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { hasErrorCode } from '../fs-errors.ts';
import { InvalidInputError, parseHelloInput } from '../hello-types.ts';
import type { HelloInput, StepResult } from '../hello-types.ts';

const HEARTBEAT_SLICE_MS = 500;
const LOCK_POLL_MS = 25;
// Shorter than the 3 second heartbeat timeout of `farewell`, so waiting for the lock never looks like a dead worker.
const LOCK_WAIT_MS = 2_500;
const LOCK_STALE_MS = 1_500;

function parseOrFail(raw: unknown): HelloInput {
  try {
    return parseHelloInput(raw);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      // Retrying cannot fix a bad input.
      throw ApplicationFailure.nonRetryable(error.message, 'InvalidInput');
    }
    throw error;
  }
}

async function readContent(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return '';
    }
    throw error;
  }
}

async function breakLockIfStale(lockFile: string): Promise<void> {
  try {
    const { mtimeMs } = await stat(lockFile);
    if (Date.now() - mtimeMs < LOCK_STALE_MS) {
      return;
    }
    const graveyard = `${lockFile}.stale-${randomUUID()}`;
    await rename(lockFile, graveyard);
    await unlink(graveyard);
  } catch (error) {
    // Another waiter broke it first, or the holder released it: either way there is nothing left to break.
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }
}

/** Creates the lock file exclusively. Undefined means someone else holds it. */
async function tryCreateLock(lockFile: string): Promise<FileHandle | undefined> {
  try {
    return await open(lockFile, 'wx');
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return undefined;
    }
    throw error;
  }
}

async function withLock<T>(lockFile: string, work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const handle = await tryCreateLock(lockFile);
    if (handle !== undefined) {
      try {
        return await work();
      } finally {
        await handle.close();
        await unlink(lockFile);
      }
    }
    if (Date.now() >= deadline) {
      // A plain error: the retry policy tries again with backoff.
      throw new Error('the log file lock is busy');
    }
    await breakLockIfStale(lockFile);
    await sleep(LOCK_POLL_MS);
  }
}

/** The exact line a step writes. */
export function stepLine(input: HelloInput, step: StepResult['step'], detail: string): string {
  return `${input.runKey} ${step} ${detail}`;
}

/** Appends the step's line unless that exact line is already present. Returns whether it wrote. */
export async function appendOnce(input: HelloInput, step: StepResult['step'], detail: string): Promise<boolean> {
  const line = stepLine(input, step, detail);
  return await withLock(`${input.logFile}.lock`, async () => {
    const content = await readContent(input.logFile);
    // Only complete lines count: the last piece has no newline when a write was cut short.
    if (content.split('\n').slice(0, -1).includes(line)) {
      return false;
    }
    const startsFreshLine = content === '' || content.endsWith('\n');
    await appendFile(input.logFile, `${startsFreshLine ? '' : '\n'}${line}\n`, 'utf8');
    return true;
  });
}

export async function greet(raw: unknown): Promise<StepResult> {
  const input = parseOrFail(raw);
  const appended = await appendOnce(input, 'greet', `hello ${input.name}`);
  return { step: 'greet', appended };
}

/**
 * Writes its line, then wraps up for `workMs`, heartbeating so a dead worker is noticed within the heartbeat
 * timeout. The wrap-up after the write is the window in which a worker can die with the side effect done and the
 * activity not yet reported, which is the case the idempotent write exists for (the crash test kills it there).
 */
export async function farewell(raw: unknown): Promise<StepResult> {
  const input = parseOrFail(raw);
  const context = Context.current();
  context.heartbeat();
  const appended = await appendOnce(input, 'farewell', `goodbye ${input.name}`);
  const deadline = Date.now() + input.workMs;
  while (Date.now() < deadline) {
    context.heartbeat();
    // Rejects when the activity is cancelled, which ends the work early.
    await context.sleep(Math.min(HEARTBEAT_SLICE_MS, Math.max(deadline - Date.now(), 0)));
  }
  return { step: 'farewell', appended };
}
