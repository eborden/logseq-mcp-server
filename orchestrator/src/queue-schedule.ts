// The Schedule of the queue watcher (#723), apart from the script so a test can run it against a server: the script
// parses flags and connects, and cannot be imported. `create` makes the one Schedule `queue-watcher` with overlap policy
// SKIP, so a slow tick is skipped and never stacks. Nothing here starts a schedule unless asked: no worker, no setup and
// no other script creates one. None of it merges, approves, labels or moves a board item; a tick only reads and starts runs.

import { resolve } from 'node:path';
import { Client, ScheduleAlreadyRunning, ScheduleNotFoundError, ScheduleOverlapPolicy } from '@temporalio/client';
import { executorForFlag, hostIntegrationForFlag } from './issue-types.ts';
import {
  DEFAULT_TICK_MS,
  InvalidQueueInputError,
  MAX_TICK_MS,
  MIN_TICK_MS,
  QUEUE_SCHEDULE_ID,
  QUEUE_TICK_TIMEOUT,
  QUEUE_WATCHER_WORKFLOW_NAME,
  parseQueueWatcherInput,
} from './queue-types.ts';
import type { QueueWatcherInput } from './queue-types.ts';

export type QueueCommand = 'create' | 'pause' | 'resume' | 'delete';

export const QUEUE_COMMANDS: readonly QueueCommand[] = ['create', 'pause', 'resume', 'delete'];

export type QueueArgs =
  | { readonly command: 'pause' | 'resume' | 'delete' }
  /** The watcher's input and the tick interval. Only `create` takes them. */
  | { readonly command: 'create'; readonly input: QueueWatcherInput; readonly everyMs: number };

export interface QueueFlags {
  readonly cap: string | undefined;
  readonly every: string | undefined;
  readonly base: string | undefined;
  readonly repoDir: string | undefined;
  readonly hostIntegration: boolean;
  readonly executor: string | undefined;
}

const EVERY = /^([1-9]\d{0,3})([mh])$/;

/** `5m` or `1h`, from MIN_TICK_MS to MAX_TICK_MS. A bare number is refused: the unit is the part people forget. */
export function parseEvery(flag: string | undefined): number {
  if (flag === undefined) {
    return DEFAULT_TICK_MS;
  }
  const match = EVERY.exec(flag);
  const ms = match === null ? NaN : Number(match[1]) * (match[2] === 'h' ? 60 : 1) * 60_000;
  if (!(ms >= MIN_TICK_MS && ms <= MAX_TICK_MS)) {
    throw new InvalidQueueInputError('--every must be a whole number of minutes or hours, like 5m, from 1m to 1h');
  }
  return ms;
}

/** Throws `InvalidQueueInputError` (or `InvalidIssueInputError` for a run flag), before any connection is made. */
export function parseQueueArgs(positionals: readonly string[], flags: QueueFlags): QueueArgs {
  const [command, ...rest] = positionals;
  const known = QUEUE_COMMANDS.find((candidate) => candidate === command);
  if (rest.length > 0 || known === undefined) {
    throw new InvalidQueueInputError(`usage: queue ${QUEUE_COMMANDS.join('|')} [--cap N] [--every 5m] (the flags go with create)`);
  }
  if (known !== 'create') {
    const given = flags.cap !== undefined || flags.every !== undefined || flags.base !== undefined || flags.repoDir !== undefined || flags.hostIntegration || flags.executor !== undefined;
    if (given) {
      throw new InvalidQueueInputError(`${known} takes no flags: create sets them`);
    }
    return { command: known };
  }
  const cap = flags.cap === undefined ? undefined : /^\d{1,3}$/.test(flags.cap) ? Number(flags.cap) : NaN;
  // The same flags and defaults as `npm run run-issue`: each run's input is built from them by `buildRunInput`.
  const input: QueueWatcherInput = {
    ...(cap === undefined ? {} : { cap }),
    // The default assumes you run this from orchestrator/, so the main checkout is one level up.
    repoDir: resolve(flags.repoDir ?? resolve(process.cwd(), '..')),
    base: flags.base ?? 'main',
    ...hostIntegrationForFlag(flags.hostIntegration),
    ...executorForFlag(flags.executor),
  };
  parseQueueWatcherInput(input);
  return { command: 'create', input, everyMs: parseEvery(flags.every) };
}

export type ScheduleOutcome =
  | { readonly status: 'created'; readonly scheduleId: string; readonly everyMs: number; readonly cap: number }
  | { readonly status: 'already_exists' | 'paused' | 'resumed' | 'deleted' | 'not_found'; readonly scheduleId: string };

/** Creates the Schedule, running (not paused). An existing one is reported and left as it is: change it with delete, then create. */
export async function createQueueSchedule(client: Client, taskQueue: string, input: QueueWatcherInput, everyMs: number): Promise<ScheduleOutcome> {
  const { cap } = parseQueueWatcherInput(input);
  try {
    await client.schedule.create({
      scheduleId: QUEUE_SCHEDULE_ID,
      spec: { intervals: [{ every: everyMs }] },
      action: {
        type: 'startWorkflow',
        workflowType: QUEUE_WATCHER_WORKFLOW_NAME,
        taskQueue,
        args: [input],
        // Temporal adds the scheduled time to this ID, so each tick has its own.
        workflowId: QUEUE_SCHEDULE_ID,
        workflowExecutionTimeout: QUEUE_TICK_TIMEOUT,
      },
      policies: {
        // A tick still running when the next is due is skipped (README, "The queue watcher"): ticks never stack.
        overlap: ScheduleOverlapPolicy.SKIP,
        // After an outage, take only a tick that is at most a minute late; the next regular one reads the same queue.
        catchupWindow: '1 minute',
      },
      state: { paused: false, note: 'created by npm run queue -- create' },
    });
  } catch (error) {
    if (error instanceof ScheduleAlreadyRunning) {
      return { status: 'already_exists', scheduleId: QUEUE_SCHEDULE_ID };
    }
    throw error;
  }
  return { status: 'created', scheduleId: QUEUE_SCHEDULE_ID, everyMs, cap };
}

/** Pauses, resumes or deletes the Schedule. A missing one is reported, not an error; each is safe to repeat. Delete does not stop a tick already running. */
export async function changeQueueSchedule(client: Client, command: 'pause' | 'resume' | 'delete'): Promise<ScheduleOutcome> {
  const handle = client.schedule.getHandle(QUEUE_SCHEDULE_ID);
  try {
    switch (command) {
      case 'pause':
        await handle.pause('paused by npm run queue -- pause');
        return { status: 'paused', scheduleId: QUEUE_SCHEDULE_ID };
      case 'resume':
        await handle.unpause('resumed by npm run queue -- resume');
        return { status: 'resumed', scheduleId: QUEUE_SCHEDULE_ID };
      case 'delete':
        await handle.delete();
        return { status: 'deleted', scheduleId: QUEUE_SCHEDULE_ID };
    }
  } catch (error) {
    if (error instanceof ScheduleNotFoundError) {
      return { status: 'not_found', scheduleId: QUEUE_SCHEDULE_ID };
    }
    throw error;
  }
}
