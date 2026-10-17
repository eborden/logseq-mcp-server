// Activities may run more than once (at-least-once, foundations 4.5): a worker can die after the side effect and
// before Temporal hears about it. Each activity's side effect is therefore idempotent, keyed by the run key and
// the step name, so a retry after a crash leaves exactly one line in the file.

import { appendFile, readFile } from 'node:fs/promises';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { InvalidInputError, parseHelloInput } from '../hello-types.ts';
import type { HelloInput, StepResult } from '../hello-types.ts';

const HEARTBEAT_SLICE_MS = 500;

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

async function readLines(file: string): Promise<string[]> {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/** Appends `<runKey> <step> <detail>` unless this run's step is already there. Returns whether it wrote. */
async function appendOnce(input: HelloInput, step: StepResult['step'], detail: string): Promise<boolean> {
  const prefix = `${input.runKey} ${step} `;
  const lines = await readLines(input.logFile);
  if (lines.some((line) => line.startsWith(prefix))) {
    return false;
  }
  await appendFile(input.logFile, `${prefix}${detail}\n`, 'utf8');
  return true;
}

export async function greet(raw: unknown): Promise<StepResult> {
  const input = parseOrFail(raw);
  const appended = await appendOnce(input, 'greet', `hello ${input.name}`);
  return { step: 'greet', appended };
}

/** Pretends to work for `workMs`, heartbeating so a dead worker is noticed within the heartbeat timeout. */
export async function farewell(raw: unknown): Promise<StepResult> {
  const input = parseOrFail(raw);
  const context = Context.current();
  const deadline = Date.now() + input.workMs;
  while (Date.now() < deadline) {
    context.heartbeat();
    // Rejects when the activity is cancelled, which ends the work early.
    await context.sleep(Math.min(HEARTBEAT_SLICE_MS, Math.max(deadline - Date.now(), 0)));
  }
  const appended = await appendOnce(input, 'farewell', `goodbye ${input.name}`);
  return { step: 'farewell', appended };
}
