// The host integration policy (#646): when the check is needed, the status description, and the gate's new field.
// Pure functions, no server and no `gh`. Every path and number is made up.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gateClear } from '../src/gate.ts';
import {
  HOST_INTEGRATION_CONTEXT,
  MAX_HOST_COUNT,
  MAX_HOST_DESCRIPTION_CHARS,
  NO_COUNTS_DESCRIPTION,
  buildHostDescription,
  needsHostIntegration,
  parseHostDescription,
  parseHostStatusInput,
} from '../src/integration-policy.ts';

const SHA = 'c'.repeat(40);

test('needsHostIntegration: the paths the suite can notice need the check', () => {
  for (const path of ['src/refs.rs', 'scripts/x.ts', 'Cargo.lock', 'Cargo.toml', 'rust-toolchain.toml', 'tests/fixtures/graph/a.md', 'tests/integration/a.ts']) {
    assert.equal(needsHostIntegration([path], true), true, path);
  }
});

test('needsHostIntegration: docs, the orchestrator, parity data and an empty list do not', () => {
  for (const path of ['docs/a.md', 'README.md', 'tests/data/parity/a.json', 'orchestrator/src/x.ts', 'orchestrator/Cargo.lock', 'tests/guards/a.test.ts']) {
    assert.equal(needsHostIntegration([path], true), false, path);
  }
  assert.equal(needsHostIntegration([], true), false);
});

test('needsHostIntegration: one path that needs it among many is enough', () => {
  assert.equal(needsHostIntegration(['docs/a.md', 'README.md', 'src/lib.rs'], true), true);
});

test('needsHostIntegration: paths are normalised the way the diff guard does it', () => {
  for (const path of ['./SRC/x.rs', 'src\\x.rs', 'src//x.rs', './/Scripts/x.ts', 'docs/../src/x.rs', '../outside.md', '/abs/path']) {
    assert.equal(needsHostIntegration([path], true), true, path);
  }
});

test('needsHostIntegration: a rename counts by both names', () => {
  assert.equal(needsHostIntegration([{ path: 'docs/moved.md', previousPath: 'src/old.rs' }], true), true, 'the old name is under src/');
  assert.equal(needsHostIntegration([{ path: 'src/new.rs', previousPath: 'docs/old.md' }], true), true, 'the new name is under src/');
  assert.equal(needsHostIntegration([{ path: 'docs/b.md', previousPath: 'docs/a.md' }], true), false);
  assert.equal(needsHostIntegration([{ path: 'docs/b.md' }], true), false);
});

test('needsHostIntegration: an incomplete read of the changed files needs the check, whatever was read', () => {
  assert.equal(needsHostIntegration([], false), true);
  assert.equal(needsHostIntegration(['docs/a.md'], false), true);
});

test('the status context and the description shape are fixed', () => {
  assert.equal(HOST_INTEGRATION_CONTEXT, 'host/integration');
  assert.equal(buildHostDescription({ passed: 82, failed: 0 }), '82 passed, 0 failed');
  assert.equal(buildHostDescription(undefined), NO_COUNTS_DESCRIPTION);
  assert.deepEqual(parseHostDescription('82 passed, 0 failed'), { passed: 82, failed: 0 });
  assert.equal(parseHostDescription(NO_COUNTS_DESCRIPTION), undefined);
});

test('buildHostDescription refuses non-integers, negatives and values over the bound, and never exceeds 140 characters', () => {
  for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_HOST_COUNT + 1, '5', null, undefined]) {
    assert.throws(() => buildHostDescription({ passed: bad as number, failed: 0 }), { name: 'InvalidHostStatusError' }, `passed ${String(bad)}`);
    assert.throws(() => buildHostDescription({ passed: 0, failed: bad as number }), { name: 'InvalidHostStatusError' }, `failed ${String(bad)}`);
  }
  const longest = buildHostDescription({ passed: MAX_HOST_COUNT, failed: MAX_HOST_COUNT });
  assert.ok(longest.length <= MAX_HOST_DESCRIPTION_CHARS);
  assert.deepEqual(parseHostDescription(longest), { passed: MAX_HOST_COUNT, failed: MAX_HOST_COUNT });
});

test('parseHostDescription reads nothing but the counts shape: text from anywhere else yields no counts', () => {
  for (const text of ['', '82 passed', '82 passed, 0 failed extra', 'x 82 passed, 0 failed', '-1 passed, 0 failed', '1.5 passed, 0 failed', '9999999 passed, 0 failed', `${'1'.repeat(200)} passed, 0 failed`, 'all tests ok']) {
    assert.equal(parseHostDescription(text), undefined, text);
  }
});

test('parseHostStatusInput refuses a bad sha, state or count and keeps nothing else', () => {
  assert.deepEqual(parseHostStatusInput({ sha: SHA, state: 'success', counts: { passed: 3, failed: 0 } }), { sha: SHA, state: 'success', counts: { passed: 3, failed: 0 } });
  assert.deepEqual(parseHostStatusInput({ sha: SHA, state: 'pending', note: 'ignored' }), { sha: SHA, state: 'pending' });
  for (const bad of [
    { sha: 'abc', state: 'success' },
    { sha: SHA.toUpperCase(), state: 'success' },
    { sha: `${SHA}0`, state: 'success' },
    { sha: SHA, state: 'approved' },
    { sha: SHA, state: 'SUCCESS' },
    { sha: SHA },
    { sha: SHA, state: 'success', counts: { passed: -1, failed: 0 } },
    { sha: SHA, state: 'success', counts: { passed: 1 } },
    { sha: SHA, state: 'success', counts: 'many' },
    null,
    [],
    'sha',
  ]) {
    assert.throws(() => parseHostStatusInput(bad), { name: 'InvalidHostStatusError' }, JSON.stringify(bad));
  }
});

test('gateClear: a required host check that is not success holds the gate; success clears it; absent changes nothing', () => {
  const reviewed = { reviewsOnHead: 1, unresolvedThreads: 0 };
  for (const state of ['pending', 'failure', 'error', 'none'] as const) {
    assert.equal(gateClear({ ...reviewed, hostIntegration: state }), false, state);
  }
  assert.equal(gateClear({ ...reviewed, hostIntegration: 'success' }), true);
  assert.equal(gateClear(reviewed), true, 'absent means not required');
  // Success does not stand in for the review or the threads.
  assert.equal(gateClear({ reviewsOnHead: 0, unresolvedThreads: 0, hostIntegration: 'success' }), false);
  assert.equal(gateClear({ reviewsOnHead: 1, unresolvedThreads: 1, hostIntegration: 'success' }), false);
});

test('integration-policy.ts is workflow-safe: no node: import and no config import', async () => {
  const text = await readFile(fileURLToPath(new URL('../src/integration-policy.ts', import.meta.url)), 'utf8');
  const imports = [...text.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ['./diff-guard.ts']);
  const diffGuard = await readFile(fileURLToPath(new URL('../src/diff-guard.ts', import.meta.url)), 'utf8');
  assert.ok(!/from 'node:|config\.ts'/.test(diffGuard));
});
