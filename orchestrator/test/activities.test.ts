// Needs no Temporal server: runs the activities in the SDK's mock activity environment and bundles the workflow
// code the way the worker does, so a workflow that is not deterministic-safe or does not bundle fails here.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MockActivityEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode } from '@temporalio/worker';
import { farewell, greet } from '../src/activities/hello.ts';
import type { HelloInput } from '../src/hello-types.ts';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orchestrator-activities-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function input(overrides: Partial<HelloInput> = {}): HelloInput {
  return { name: 'Alice', logFile: join(dir, 'a.log'), runKey: 'run-1', workMs: 0, ...overrides };
}

test('each activity appends its line once, even when it runs again', async () => {
  const env = new MockActivityEnvironment();
  const args = input({ logFile: join(dir, 'idempotent.log') });

  assert.deepEqual(await env.run(greet, args), { step: 'greet', appended: true });
  assert.deepEqual(await env.run(greet, args), { step: 'greet', appended: false });
  assert.deepEqual(await env.run(farewell, args), { step: 'farewell', appended: true });
  assert.deepEqual(await env.run(farewell, args), { step: 'farewell', appended: false });

  const lines = (await readFile(args.logFile, 'utf8')).split('\n').filter((line) => line !== '');
  assert.deepEqual(lines, ['run-1 greet hello Alice', 'run-1 farewell goodbye Alice']);
});

test('two runs sharing a file each get their own lines', async () => {
  const env = new MockActivityEnvironment();
  const logFile = join(dir, 'shared.log');
  await env.run(greet, input({ logFile, runKey: 'run-a' }));
  await env.run(greet, input({ logFile, runKey: 'run-b' }));
  const lines = (await readFile(logFile, 'utf8')).split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 2);
});

test('a bad input is a non-retryable failure and writes nothing', async () => {
  const env = new MockActivityEnvironment();
  const logFile = join(dir, 'never.log');
  await assert.rejects(
    env.run(greet, { ...input({ logFile }), logFile: 'relative.log' }),
    (error: Error & { type?: string; nonRetryable?: boolean }) => error.type === 'InvalidInput' && error.nonRetryable === true,
  );
  await assert.rejects(readFile(logFile, 'utf8'), { code: 'ENOENT' });
});

test('the workflow code bundles for the worker', async () => {
  const { code } = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url)),
  });
  assert(code.includes('helloWorkflow'));
});
