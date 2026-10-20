// `resolveResume` (#747) against a fake `gh` (no network, no real repository): the one read a resume entry makes before it
// starts a run. Every name is made up (issue 123, project atlas, Alice). It reads and never writes, and a refusal is a fixed
// word while a failed read is an error, never a refusal (BR-0003).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ApplicationFailure } from '@temporalio/activity';
import { createCliGithubActivities, createGithubActivities } from '../src/activities/github.ts';
import { createFake, emptyState, httpAnswer, rawIssue, rawOpenPr, recordedSleep } from './github-support.ts';
import type { FakeState } from './github-support.ts';

let dir: string;
let counter = 0;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orchestrator-resume-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const HEAD = 'c'.repeat(40);

const rawPr = (number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  number,
  state: 'open',
  merged: false,
  title: 'A title the activity never reads',
  head: { sha: HEAD },
  base: { ref: 'feature/atlas' },
  ...overrides,
});

async function setup(configure: (state: FakeState) => void) {
  const state = emptyState();
  state.board = [{ number: 123, status: 'In review' }];
  state.issues['123'] = rawIssue(123);
  state.pulls = [rawOpenPr(40, 'claude/123-importer')];
  state.prStates = { '40': rawPr(40) };
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

test('an In review issue with one open PR resolves to that PR, its head and its base', async () => {
  const { github } = await setup(() => undefined);

  assert.deepEqual(await github.resolveResume(123), { ok: true, pr: 40, headSha: HEAD, base: 'feature/atlas' });
});

test('the PR can be found by its Closes line as well as by its branch, as the claim finds it', async () => {
  const { github } = await setup((state) => {
    state.pulls = [rawOpenPr(41, 'alice/hand-fix', { body: 'Closes #123' })];
    state.prStates = { '41': rawPr(41) };
  });

  assert.deepEqual(await github.resolveResume(123), { ok: true, pr: 41, headSha: HEAD, base: 'feature/atlas' });
});

test('the head is the one GitHub shows now: a hand fix gives a new head, never the old one', async () => {
  const newer = 'd'.repeat(40);
  const { github } = await setup((state) => {
    state.prStates = { '40': rawPr(40, { head: { sha: newer } }) };
  });

  const resolved = await github.resolveResume(123);
  assert.equal(resolved.ok && resolved.headSha, newer);
});

test('an issue that is not In review is refused with a fixed word, whatever else is true', async () => {
  for (const status of ['Ready', 'In progress', 'Needs Input', 'Done', 'Backlog']) {
    const { github } = await setup((state) => {
      state.board = [{ number: 123, status }];
    });
    assert.deepEqual(await github.resolveResume(123), { ok: false, reason: 'issue_not_in_review' }, status);
  }
});

test('a closed issue is refused as closed', async () => {
  const { github } = await setup((state) => {
    state.issues['123'] = rawIssue(123, { state: 'closed' });
  });
  assert.deepEqual(await github.resolveResume(123), { ok: false, reason: 'issue_closed' });
});

test('no open PR is refused: none at all, a PR closed or merged after the list, and a stranger\'s that names the issue', async () => {
  const cases: readonly (readonly [string, (state: FakeState) => void])[] = [
    ['none', (state) => void (state.pulls = [])],
    // The list shows only open PRs, so a merged PR is not in it; a race that closes it after the list is caught by the state read.
    ['closed after the list', (state) => void (state.prStates = { '40': rawPr(40, { state: 'closed' }) })],
    ['merged after the list', (state) => void (state.prStates = { '40': rawPr(40, { state: 'closed', merged: true }) })],
    ['untrusted author', (state) => void (state.pulls = [rawOpenPr(40, 'claude/123-importer', { author_association: 'NONE', body: 'Closes #123' })])],
  ];
  for (const [name, configure] of cases) {
    const { github } = await setup(configure);
    assert.deepEqual(await github.resolveResume(123), { ok: false, reason: 'no_open_pr' }, name);
  }
});

test('more than one open PR for the issue is refused: the PR to gate is not decided here', async () => {
  const { github } = await setup((state) => {
    state.pulls = [rawOpenPr(40, 'claude/123-importer'), rawOpenPr(41, 'alice/second', { body: 'Closes #123' })];
    state.prStates = { '40': rawPr(40), '41': rawPr(41) };
  });
  assert.deepEqual(await github.resolveResume(123), { ok: false, reason: 'several_open_prs' });
});

test('an issue of an untrusted author is an error, not a refusal and not read', async () => {
  const { github } = await setup((state) => {
    state.issues['123'] = rawIssue(123, { author_association: 'NONE' });
  });
  assert.deepEqual(await failureOf(github.resolveResume(123)), { type: 'UntrustedAuthor', nonRetryable: true });
});

test('a failed read is an error and never a refusal: an issue that is not there', async () => {
  const { github } = await setup((state) => {
    state.issues = {};
  });
  assert.equal((await failureOf(github.resolveResume(123))).type, 'NotFound');
});

test('a bad issue number is refused before any call', async () => {
  const { fake, github } = await setup(() => undefined);
  await failureOf(github.resolveResume(0));
  await failureOf(github.resolveResume(1.5));
  assert.deepEqual(await fake.calls(), []);
});

test('it only reads: no board edit, no comment, no PR or issue write', async () => {
  const { fake, github } = await setup(() => undefined);
  await github.resolveResume(123);
  const calls = await fake.calls();
  assert.ok(calls.length > 0);
  for (const call of calls) {
    const text = call.argv.join(' ');
    // Only `gh api` reads: a GET (no method flag, no body) or a GraphQL query (never a mutation). No `gh project` write.
    assert.equal(call.argv[0], 'api', text);
    assert.doesNotMatch(text.replace('-X GET', ''), /--method|-X |--input|mutation/, text);
    assert.equal(call.stdin, undefined, text);
  }
});

// ---- the CLI's own activities (#747): no activity context ----------------------------------------------------------

function rateLimitedIssue(retryAfterSeconds: number) {
  return (state: FakeState) => {
    state.faults = [
      {
        match: 'issues/123',
        times: 1,
        stdout: httpAnswer(403, { message: 'secondary' }, { 'Retry-After': String(retryAfterSeconds) }),
        stderr: 'gh: You have exceeded a secondary rate limit (HTTP 403)\n',
        exit: 1,
      },
    ];
  };
}

test('the CLI activities wait out a rate limit with a plain timer, outside any activity, and then answer', { timeout: 20_000 }, async () => {
  // `createGithubActivities`' default sleep calls `Context.current()`, which throws outside an activity: `run-issue --resume` must not use it.
  const { fake } = await setup(rateLimitedIssue(1));
  const github = createCliGithubActivities(fake.config);

  assert.deepEqual(await github.resolveResume(123), { ok: true, pr: 40, headSha: HEAD, base: 'feature/atlas' });
  assert.ok((await fake.callsMatching('issues/123')).length >= 2, 'the limited request and its retry');
});

test('a rate limit over the wait limit is a loud, non-retryable failure in the CLI too, never an empty result', async () => {
  const { fake } = await setup(rateLimitedIssue(3600));
  const github = createCliGithubActivities(fake.config);

  assert.deepEqual(await failureOf(github.resolveResume(123)), { type: 'GitHubRateLimitTooLong', nonRetryable: true });
});
