// Crash test (#626): kill the worker with SIGKILL while the second activity is running, start a new worker, and
// check that the same run completes and each activity's side effect (a line in a temp file) appears once.
// It starts its own in-memory dev server on a free port, so it never touches the SQLite file of `start-server`.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { loadServerConfig } from '../src/config.ts';
import { startDevServer } from '../src/dev-server.ts';
import { hasErrorCode } from '../src/fs-errors.ts';
import { parseHelloResult } from '../src/hello-types.ts';
import type { HelloInput } from '../src/hello-types.ts';
import { freePort } from './support.ts';

const WORKER_ENTRY = fileURLToPath(new URL('../src/worker.ts', import.meta.url));
const TASK_QUEUE = 'crash-test';
const WORK_MS = 6_000;

function startWorker(port: number): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', WORKER_ENTRY], {
    env: {
      ...process.env,
      TEMPORAL_ADDRESS: `127.0.0.1:${port}`,
      TEMPORAL_NAMESPACE: 'default',
      TASK_QUEUE,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await probe();
    if (found !== undefined) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

async function lines(file: string): Promise<string[]> {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
}

let server: TestWorkflowEnvironment;
let port: number;
let dir: string;
const workers: ChildProcess[] = [];

before(async () => {
  port = await freePort();
  // TEMPORAL_CLI_PATH is honoured here too, so a machine without network access can point at an installed CLI.
  server = await startDevServer({ port, cliPath: loadServerConfig(process.env).cliPath });
  dir = await mkdtemp(join(tmpdir(), 'orchestrator-crash-'));
});

after(async () => {
  for (const worker of workers) {
    worker.kill('SIGKILL');
  }
  await server?.teardown();
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run survives a SIGKILLed worker and each side effect happens once', { timeout: 120_000 }, async () => {
  const logFile = join(dir, 'hello.log');
  const input: HelloInput = { name: 'Alice', logFile, runKey: 'crash-run-1', workMs: WORK_MS };

  const first = startWorker(port);
  workers.push(first);
  const handle = await server.client.workflow.start('helloWorkflow', {
    taskQueue: TASK_QUEUE,
    workflowId: 'hello-crash-run-1',
    args: [input],
    workflowExecutionTimeout: '2 minutes',
  });

  // Wait until farewell has WRITTEN its line and is still running (it wraps up for WORK_MS after the write), then
  // kill the worker. This is the case the idempotent write exists for: the side effect is done, the worker dies
  // before Temporal hears about it, and the activity is retried.
  await until('farewell to have written its line while still running', 60_000, async () => {
    const description = await handle.describe();
    const running = (description.raw.pendingActivities ?? []).some(
      (activity) => activity.activityType?.name === 'farewell' && (activity.lastStartedTime ?? null) !== null,
    );
    return running && (await lines(logFile)).length === 2 ? true : undefined;
  });
  first.kill('SIGKILL');
  await once(first, 'exit');

  workers.push(startWorker(port));
  // The dead worker's attempt times out on its heartbeat, and the second worker runs attempt 2.
  await until('the farewell activity to be retried', 60_000, async () => {
    const description = await handle.describe();
    const retried = (description.raw.pendingActivities ?? []).some(
      (activity) => activity.activityType?.name === 'farewell' && (activity.attempt ?? 0) >= 2,
    );
    return retried ? true : undefined;
  });
  const result = parseHelloResult(await handle.result());

  assert.equal(result.runKey, 'crash-run-1');
  // greet ran once and wrote. farewell wrote before the crash, so its retry found the line and wrote nothing.
  assert.deepEqual(result.steps, [
    { step: 'greet', appended: true },
    { step: 'farewell', appended: false },
  ]);
  assert.deepEqual(await lines(logFile), ['crash-run-1 greet hello Alice', 'crash-run-1 farewell goodbye Alice']);
});
