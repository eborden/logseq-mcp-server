// The three activities #631 adds, against a fake `gh` (no network, no real repository): `getPrState` (observe a merge),
// `getPrChanges` (counts of what only the maintainer decides) and `closeIssue` (the check that a merged PR's issue is
// closed). Every name is made up (issue 123, Alice, "project atlas").

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ApplicationFailure } from '@temporalio/activity';
import { createGithubActivities } from '../src/activities/github.ts';
import { createFake, emptyState, rawIssue, recordedSleep } from './github-support.ts';
import type { FakeState } from './github-support.ts';

let dir: string;
let counter = 0;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orchestrator-approval-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const HEAD = 'a'.repeat(40);

async function setup(configure: (state: FakeState) => void) {
  const state = emptyState();
  configure(state);
  counter += 1;
  const fake = await createFake(dir, `case-${counter}`, state);
  return { fake, github: createGithubActivities(fake.config, recordedSleep()) };
}

async function failureOf(promise: Promise<unknown>): Promise<{ type: string | null | undefined; nonRetryable: boolean }> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApplicationFailure, 'a Temporal failure');
    return { type: error.type, nonRetryable: error.nonRetryable === true };
  }
  return assert.fail('the activity should have failed');
}

const rawPr = (number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  number,
  state: 'open',
  merged: false,
  title: 'A title the activity never reads',
  head: { sha: HEAD },
  ...overrides,
});

test('getPrState answers open, closed unmerged and merged as flags and a SHA only', async () => {
  const { github } = await setup((state) => {
    state.prStates = {
      '10': rawPr(10),
      '11': rawPr(11, { state: 'closed' }),
      '12': rawPr(12, { state: 'closed', merged: true }),
    };
  });

  assert.deepEqual(await github.getPrState(10), { state: 'open', merged: false, headSha: HEAD });
  assert.deepEqual(await github.getPrState(11), { state: 'closed', merged: false, headSha: HEAD });
  assert.deepEqual(await github.getPrState(12), { state: 'closed', merged: true, headSha: HEAD });
});

test('getPrState refuses a bad number and a missing PR, and a malformed answer is not read as "not merged"', async () => {
  const { github } = await setup((state) => {
    state.prStates = { '10': rawPr(10, { merged: 'yes' }), '11': rawPr(99) };
  });

  assert.deepEqual(await failureOf(github.getPrState(0)), { type: 'InvalidInput', nonRetryable: true });
  assert.deepEqual(await failureOf(github.getPrState('10' as unknown as number)), { type: 'InvalidInput', nonRetryable: true });
  assert.deepEqual(await failureOf(github.getPrState(404)), { type: 'NotFound', nonRetryable: true });
  assert.deepEqual(await failureOf(github.getPrState(10)), { type: 'MalformedGhOutput', nonRetryable: true });
  assert.deepEqual(await failureOf(github.getPrState(11)), { type: 'MalformedGhOutput', nonRetryable: true });
});

test('getPrChanges returns counts, never a path', async () => {
  const { github } = await setup((state) => {
    state.prFiles = {
      '10': ['orchestrator/src/atlas.ts', 'tests/data/parity/search.json', 'tests/data/parity/call-ceilings.json', 'docs/adr/0042-atlas.md'],
      '11': [],
    };
  });

  const changes = await github.getPrChanges(10);

  assert.deepEqual(changes, { files: 4, golden: 1, ceilings: 1, adrs: 1, businessRules: 0, complete: true });
  assert.equal(JSON.stringify(changes).includes('atlas'), false);
  assert.deepEqual(await github.getPrChanges(11), { files: 0, golden: 0, ceilings: 0, adrs: 0, businessRules: 0, complete: true });
});

test('closeIssue closes an open issue as completed, reads it back, and a repeat writes nothing', async () => {
  const { fake, github } = await setup((state) => {
    state.issues['123'] = rawIssue(123);
  });

  assert.deepEqual(await github.closeIssue(123), { changed: true, closed: true });
  assert.deepEqual(await github.closeIssue(123), { changed: false, closed: true });

  const writes = await fake.callsMatching('-X PATCH');
  assert.equal(writes.length, 1, 'one write for two calls');
  assert.deepEqual(JSON.parse(writes[0]?.stdin ?? '{}'), { state: 'closed', state_reason: 'completed' });
  const issue = (await fake.state()).issues['123'] as { state: string; state_reason: string };
  assert.deepEqual([issue.state, issue.state_reason], ['closed', 'completed']);
});

test('closeIssue leaves a closed issue alone, refuses an untrusted author, and fails when GitHub still shows it open', async () => {
  const { fake, github } = await setup((state) => {
    state.issues['1'] = rawIssue(1, { state: 'closed' });
    state.issues['2'] = rawIssue(2, { author_association: 'NONE' });
    state.issues['3'] = rawIssue(3);
    state.patchIgnored = [3];
  });

  assert.deepEqual(await github.closeIssue(1), { changed: false, closed: true });
  assert.deepEqual(await failureOf(github.closeIssue(2)), { type: 'UntrustedAuthor', nonRetryable: true });
  // A write that answered 200 and changed nothing is not a closed issue: retryable, then bounded by the policy.
  assert.deepEqual(await failureOf(github.closeIssue(3)), { type: 'BoardReadbackMismatch', nonRetryable: false });
  assert.deepEqual(await failureOf(github.closeIssue(0)), { type: 'InvalidInput', nonRetryable: true });
  assert.equal((await fake.callsMatching('-X PATCH')).length, 1, 'only the open, trusted issue was written to');
});

test('getPrChanges counts a rename by the name it left, and a PR with more files than one call reads is reported incomplete, not failed', async () => {
  const { github } = await setup((state) => {
    state.prFiles = {
      '10': [{ filename: 'orchestrator/src/atlas.ts', previous_filename: 'docs/adr/0042-atlas.md' }] ,
      '11': Array.from({ length: 1001 }, (_, index) => `orchestrator/src/atlas-${index}.ts`),
    };
  });

  assert.deepEqual(await github.getPrChanges(10), { files: 2, golden: 0, ceilings: 0, adrs: 1, businessRules: 0, complete: true });
  assert.deepEqual(await github.getPrChanges(11), { files: 0, golden: 0, ceilings: 0, adrs: 0, businessRules: 0, complete: false });
});
