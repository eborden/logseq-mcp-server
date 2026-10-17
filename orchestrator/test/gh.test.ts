// The `gh` wrapper against the fake `gh` (no network): argv handling, timeouts, malformed answers, and the
// rate-limit rules of CLAUDE.md "GitHub rate limits" (primary waits for the reset, secondary waits Retry-After or
// at least a minute and doubles, a long wait fails instead of sleeping).

import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ConfigError } from '../src/config.ts';
import { DEFAULT_RATE_LIMIT, loadGhConfig } from '../src/gh-config.ts';
import { GhCli, GhError, classifyRateLimit, splitHttpResponse } from '../src/gh.ts';
import { NOW_MS, createFake, emptyState, httpAnswer, rawIssue, recordedSleep } from './github-support.ts';
import type { Fault } from './github-support.ts';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orchestrator-gh-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ISSUE_ROUTE = 'repos/eborden/logseq-mcp-server/issues/123';

async function withFaults(name: string, faults: Fault[]) {
  const state = emptyState();
  state.issues['123'] = rawIssue(123);
  state.faults = faults;
  return await createFake(dir, name, state);
}

function secondaryFault(times: number, headers: Record<string, string> = {}): Fault {
  return {
    match: 'issues/123',
    times,
    stdout: httpAnswer(403, { message: 'You have exceeded a secondary rate limit.' }, headers),
    stderr: 'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)\n',
    exit: 1,
  };
}

function primaryFault(times: number, resetAtSeconds: number | undefined): Fault {
  const headers: Record<string, string> = { 'X-RateLimit-Remaining': '0' };
  if (resetAtSeconds !== undefined) {
    headers['X-RateLimit-Reset'] = String(resetAtSeconds);
  }
  return {
    match: 'issues/123',
    times,
    stdout: httpAnswer(403, { message: 'API rate limit exceeded for user ID 1.' }, headers),
    stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)\n',
    exit: 1,
  };
}

test('splitHttpResponse reads the status, lowercases header names and keeps the body whole', () => {
  const response = splitHttpResponse('HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 7\r\nEtag: "a"\r\n\r\n{"a":1}\n\n{"b":2}');
  assert.deepEqual(response, { status: 200, headers: { 'x-ratelimit-remaining': '7', etag: '"a"' }, body: '{"a":1}\n\n{"b":2}' });
  assert.equal(splitHttpResponse('{"not":"http"}'), undefined);
});

test('classifyRateLimit tells a primary limit from a secondary one, and neither from a plain 403', () => {
  const secondary = classifyRateLimit(
    httpAnswer(403, { message: 'x' }, { 'Retry-After': '30' }),
    'gh: You have exceeded a secondary rate limit (HTTP 403)',
  );
  assert.deepEqual(secondary, { kind: 'secondary', retryAfterMs: 30_000 });

  // Retry-After alone on a 429 is enough, as the skill says, and a missing header leaves the wait undecided.
  assert.deepEqual(classifyRateLimit(httpAnswer(429, {}, { 'Retry-After': '5' }), 'gh: (HTTP 429)'), { kind: 'secondary', retryAfterMs: 5000 });
  assert.deepEqual(classifyRateLimit('', 'gh: You have exceeded a secondary rate limit.'), { kind: 'secondary', retryAfterMs: undefined });

  const primary = classifyRateLimit(
    httpAnswer(403, { message: 'API rate limit exceeded' }, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1800000600' }),
    'gh: API rate limit exceeded (HTTP 403)',
  );
  assert.deepEqual(primary, { kind: 'primary', resetAtMs: 1_800_000_600_000 });

  assert.equal(classifyRateLimit(httpAnswer(403, { message: 'Resource not accessible' }, { 'X-RateLimit-Remaining': '4000' }), 'gh: Resource not accessible (HTTP 403)'), undefined);
  assert.equal(classifyRateLimit('', 'gh: Not Found (HTTP 404)'), undefined);
});

test('a secondary limit waits Retry-After, then the call succeeds', async () => {
  const fake = await withFaults('secondary-header', [secondaryFault(1, { 'Retry-After': '7' })]);
  const clock = recordedSleep();
  const body = await new GhCli(fake.config, clock).api(ISSUE_ROUTE);

  assert.equal(typeof body, 'object');
  assert.deepEqual(clock.waits, [7000]);
  assert.equal((await fake.callsMatching('issues/123')).length, 2);
});

test('a secondary limit with no Retry-After waits at least 60 seconds and doubles on each repeat', async () => {
  const fake = await withFaults('secondary-doubling', [secondaryFault(2)]);
  const clock = recordedSleep();
  await new GhCli(fake.config, clock).api(ISSUE_ROUTE);

  assert.deepEqual(clock.waits, [60_000, 120_000]);
  assert.equal((await fake.callsMatching('issues/123')).length, 3);
});

test('repeated rate limits stop after the allowed waits instead of polling', async () => {
  const fake = await withFaults('exhausted', [secondaryFault(50)]);
  const clock = recordedSleep();

  await assert.rejects(
    new GhCli(fake.config, clock).api(ISSUE_ROUTE),
    (error: unknown) => error instanceof GhError && error.kind === 'rate_limit_exhausted' && /still rate limited after 3 waits/.test(error.message),
  );
  assert.deepEqual(clock.waits, [60_000, 120_000, 240_000]);
  assert.equal((await fake.callsMatching('issues/123')).length, DEFAULT_RATE_LIMIT.maxWaits + 1);
});

test('a primary limit waits until the reset time (plus a second)', async () => {
  const resetAtSeconds = NOW_MS / 1000 + 300;
  const fake = await withFaults('primary-short', [primaryFault(1, resetAtSeconds)]);
  const clock = recordedSleep();
  await new GhCli(fake.config, clock).api(ISSUE_ROUTE);

  assert.deepEqual(clock.waits, [301_000]);
});

test('a primary reset more than ten minutes away fails with a clear message and does not sleep', async () => {
  const fake = await withFaults('primary-long', [primaryFault(1, NOW_MS / 1000 + 1800)]);
  const clock = recordedSleep();

  await assert.rejects(
    new GhCli(fake.config, clock).api(ISSUE_ROUTE),
    (error: unknown) =>
      error instanceof GhError &&
      error.kind === 'rate_limit_wait_too_long' &&
      /primary GitHub rate limit that needs a wait of about 31 minutes, more than the 10 minute limit; not waiting/.test(error.message),
  );
  assert.deepEqual(clock.waits, []);
  assert.equal((await fake.callsMatching('issues/123')).length, 1);
});

test('a primary limit with no reset header asks the rate_limit endpoint, which names the reset', async () => {
  const fake = await withFaults('primary-lookup', [primaryFault(1, undefined)]);
  const state = await fake.state();
  state.rateLimit = { resources: { core: { remaining: 0, reset: NOW_MS / 1000 + 120 }, graphql: { remaining: 40, reset: NOW_MS / 1000 + 5 } } };
  await writeFile(fake.statePath, JSON.stringify(state));
  const clock = recordedSleep();
  await new GhCli(fake.config, clock).api(ISSUE_ROUTE);

  assert.deepEqual(clock.waits, [121_000]);
  assert.equal((await fake.callsMatching('rate_limit')).length, 1);
});

test('a limit reported only on stderr (a gh project command has no headers) is waited out the same way', async () => {
  const state = emptyState();
  state.faults = [{ match: 'item-list', times: 1, stderr: 'gh: You have exceeded a secondary rate limit\n', exit: 1 }];
  const fake = await createFake(dir, 'stderr-only', state);
  const clock = recordedSleep();
  const out = await new GhCli(fake.config, clock).project(['item-list', '1', '--owner', 'eborden', '--format', 'json']);

  assert.deepEqual(clock.waits, [60_000]);
  assert.deepEqual(JSON.parse(out), { items: [], totalCount: 0 });
});

test('a 403 that is not a rate limit fails at once, with its status, and nothing waits', async () => {
  const fake = await withFaults('plain-403', [
    { match: 'issues/123', times: 5, stdout: httpAnswer(403, { message: 'Resource not accessible' }, { 'X-RateLimit-Remaining': '4000' }), stderr: 'gh: Resource not accessible (HTTP 403)\n', exit: 1 },
  ]);
  const clock = recordedSleep();

  await assert.rejects(new GhCli(fake.config, clock).api(ISSUE_ROUTE), (error: unknown) => error instanceof GhError && error.kind === 'exit' && error.httpStatus === 403);
  assert.deepEqual(clock.waits, []);
  assert.equal((await fake.callsMatching('issues/123')).length, 1);
});

test('malformed answers fail with the path of the first mismatch, never a value and never a partial result', async () => {
  const cases: { name: string; stdout: string; message: RegExp }[] = [
    { name: 'not-json', stdout: 'HTTP/2.0 200 OK\r\n\r\n<html>oops</html>', message: /the answer is not JSON/ },
    { name: 'no-status-line', stdout: '{"number":123}', message: /no HTTP status line/ },
  ];
  for (const { name, stdout, message } of cases) {
    const state = emptyState();
    state.faults = [{ match: 'issues/123', times: 1, stdout }];
    const fake = await createFake(dir, `malformed-${name}`, state);
    await assert.rejects(new GhCli(fake.config, recordedSleep()).api(ISSUE_ROUTE), (error: unknown) => error instanceof GhError && error.kind === 'malformed' && message.test(error.message));
  }
});

test('graphql answers with errors, or without data, are errors', async () => {
  const state = emptyState();
  state.faults = [
    { match: 'errors-case', times: 1, stdout: httpAnswer(200, { errors: [{ message: 'boom' }] }) },
    { match: 'no-data-case', times: 1, stdout: httpAnswer(200, { something: 1 }) },
  ];
  const fake = await createFake(dir, 'graphql-errors', state);
  const cli = new GhCli(fake.config, recordedSleep());

  await assert.rejects(cli.graphql('query { x }', { label: 'errors-case' }), (error: unknown) => error instanceof GhError && error.kind === 'graphql');
  await assert.rejects(cli.graphql('query { x }', { label: 'no-data-case' }), (error: unknown) => error instanceof GhError && error.kind === 'malformed');
});

test('arguments go to gh as an argv array: shell characters in them are never interpreted', async () => {
  const state = emptyState();
  const fake = await createFake(dir, 'argv', state);
  const marker = join(dir, 'argv', 'pwned');
  const hostile = `x"; touch ${marker}; echo "$(touch ${marker})`;

  await assert.rejects(new GhCli(fake.config, recordedSleep()).graphql('query { x }', { label: hostile }));
  const [call] = await fake.calls();
  assert.ok(call !== undefined);
  assert.ok(call.argv.includes(`label=${hostile}`), 'the hostile value is one argument, byte for byte');
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('a gh that hangs is killed at the timeout', async () => {
  const state = emptyState();
  state.faults = [{ match: 'item-list', times: 1, delayMs: 3000 }];
  const fake = await createFake(dir, 'timeout', state, { timeoutMs: 300 });

  await assert.rejects(
    new GhCli(fake.config, recordedSleep()).project(['item-list', '1']),
    (error: unknown) => error instanceof GhError && error.kind === 'timeout' && /timed out after 300 ms/.test(error.message),
  );
});

test('a gh that cannot start is a spawn error that names the path', async () => {
  const fake = await createFake(dir, 'missing', emptyState(), { ghPath: join(dir, 'missing', 'no-such-gh') });
  await assert.rejects(new GhCli(fake.config, recordedSleep()).project(['item-list']), (error: unknown) => error instanceof GhError && error.kind === 'spawn');
});

test('output past the cap kills gh and fails', async () => {
  const state = emptyState();
  state.faults = [{ match: 'item-list', times: 1, stdout: 'x'.repeat(5000) }];
  const fake = await createFake(dir, 'big-output', state, { maxOutputBytes: 1000 });
  await assert.rejects(new GhCli(fake.config, recordedSleep()).project(['item-list']), (error: unknown) => error instanceof GhError && error.kind === 'output_too_large');
});

test('config: defaults, overrides and bad values', () => {
  const defaults = loadGhConfig({});
  assert.equal(defaults.ghPath, 'gh');
  assert.equal(defaults.repo, 'eborden/logseq-mcp-server');
  assert.equal(defaults.projectNumber, 1);
  assert.equal(defaults.rateLimit.maxWaitMs, 600_000);

  const custom = loadGhConfig({ ORCHESTRATOR_GH_PATH: '/opt/gh', ORCHESTRATOR_GITHUB_REPO: 'alice/atlas', ORCHESTRATOR_PROJECT_NUMBER: '7', ORCHESTRATOR_GH_TIMEOUT_MS: '5000' });
  assert.deepEqual([custom.ghPath, custom.repo, custom.projectNumber, custom.timeoutMs], ['/opt/gh', 'alice/atlas', 7, 5000]);

  assert.throws(() => loadGhConfig({ ORCHESTRATOR_GH_PATH: 'gh; rm -rf /' }), ConfigError);
  assert.throws(() => loadGhConfig({ ORCHESTRATOR_GITHUB_REPO: 'not a repo' }), /owner\/name/);
  assert.throws(() => loadGhConfig({ ORCHESTRATOR_PROJECT_NUMBER: '0' }), /ORCHESTRATOR_PROJECT_NUMBER/);
  assert.throws(() => loadGhConfig({ ORCHESTRATOR_GH_TIMEOUT_MS: '999999999' }), /ORCHESTRATOR_GH_TIMEOUT_MS/);
});
