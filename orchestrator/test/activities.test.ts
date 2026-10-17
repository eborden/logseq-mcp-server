// Needs no Temporal server: runs the activities in the SDK's mock activity environment and bundles the workflow
// code the way the worker does, so a workflow that is not deterministic-safe or does not bundle fails here.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MockActivityEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode } from '@temporalio/worker';
import { farewell, greet } from '../src/activities/hello.ts';
import { InvalidInputError, parseHelloResult } from '../src/hello-types.ts';
import type { HelloInput, StepResult } from '../src/hello-types.ts';

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

test('overlapping attempts of one step write one line', async () => {
  const logFile = join(dir, 'overlap.log');
  const results: StepResult[] = await Promise.all(
    // The mock's generics do not infer the result type here, so name it.
    Array.from({ length: 8 }, () =>
      new MockActivityEnvironment().run<[unknown], StepResult, typeof greet>(greet, input({ logFile })),
    ),
  );
  assert.equal(results.filter((result) => result.appended).length, 1);
  assert.deepEqual(await readFile(logFile, 'utf8'), 'run-1 greet hello Alice\n');
  await assert.rejects(stat(`${logFile}.lock`), { code: 'ENOENT' });
});

test('a line cut short by a kill does not count as done, and the retry starts a fresh line', async () => {
  const logFile = join(dir, 'partial.log');
  // The first half of the line a killed worker was writing: it is a prefix of the real line, with no newline.
  await writeFile(logFile, 'run-1 greet hel');
  const env = new MockActivityEnvironment();

  assert.deepEqual(await env.run(greet, input({ logFile })), { step: 'greet', appended: true });
  assert.deepEqual(await env.run(greet, input({ logFile })), { step: 'greet', appended: false });
  assert.equal(await readFile(logFile, 'utf8'), 'run-1 greet hel\nrun-1 greet hello Alice\n');
});

test('a lock left by a killed worker is broken once it is stale', async () => {
  const logFile = join(dir, 'stale.log');
  const lockFile = `${logFile}.lock`;
  await writeFile(lockFile, '');
  const longAgo = new Date(Date.now() - 60_000);
  await utimes(lockFile, longAgo, longAgo);

  assert.deepEqual(await new MockActivityEnvironment().run(greet, input({ logFile })), { step: 'greet', appended: true });
  await assert.rejects(stat(lockFile), { code: 'ENOENT' });
});

test('parseHelloResult accepts a result and rejects a malformed one', () => {
  const good = { runKey: 'run-1', steps: [{ step: 'greet', appended: true }] };
  assert.deepEqual(parseHelloResult(good), good);
  assert.throws(() => parseHelloResult({ runKey: 'run-1', steps: [{ step: 'other', appended: true }] }), InvalidInputError);
  assert.throws(() => parseHelloResult(null), InvalidInputError);
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
