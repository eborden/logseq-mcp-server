// Crash test (#626): kill the worker with SIGKILL while the second activity is running, start a new worker, and
// check that the same run completes and each activity's side effect (a line in a temp file) appears once.
// It starts its own in-memory dev server on a free port, so it never touches the SQLite file of `start-server`.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { startDevServer } from '../src/dev-server.ts';
import type { HelloInput, HelloResult } from '../src/hello-types.ts';

const WORKER_ENTRY = fileURLToPath(new URL('../src/worker.ts', import.meta.url));
const TASK_QUEUE = 'crash-test';
const WORK_MS = 6_000;

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  server.close();
  await once(server, 'close');
  return address.port;
}

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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
  server = await startDevServer({ port });
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

  // Wait until the first activity is done and the second is running on the first worker, then kill it.
  await until('the farewell activity to be running', 60_000, async () => {
    const description = await handle.describe();
    const pending = description.raw.pendingActivities ?? [];
    const running = pending.some(
      (activity) => activity.activityType?.name === 'farewell' && (activity.lastStartedTime ?? null) !== null,
    );
    return running ? true : undefined;
  });
  assert.equal((await lines(logFile)).length, 1, 'greet has appended its line, farewell has not yet');
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
  const result = (await handle.result()) as HelloResult;

  assert.equal(result.runKey, 'crash-run-1');
  assert.deepEqual(
    result.steps.map((step) => step.step),
    ['greet', 'farewell'],
  );
  const finalLines = await lines(logFile);
  assert.equal(finalLines.length, 2, `expected one line per activity, got: ${JSON.stringify(finalLines)}`);
  assert.equal(finalLines.filter((line) => line.startsWith('crash-run-1 greet ')).length, 1);
  assert.equal(finalLines.filter((line) => line.startsWith('crash-run-1 farewell ')).length, 1);
});
