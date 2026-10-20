// The eligibility rule of the queue watcher (#722), on made-up issue numbers. Pure: no gh, no Temporal.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_SKIPPED_REPORTED, eligibleIssues } from '../src/queue-policy.ts';
import type { ReadyIssues } from '../src/types.ts';

const none: readonly number[] = [];

test('a Ready issue with no open blocker, not taken and trusted is eligible', () => {
  const listed: ReadyIssues = { ready: [12, 10], blocked: [] };
  assert.deepEqual(eligibleIssues(listed, none, [10, 12]), { eligible: [10, 12], skipped: [], skippedNotReported: 0 });
});

test('an issue with an open blocker is not eligible; one whose blockers are all closed is listed ready and is', () => {
  const listed: ReadyIssues = { ready: [12], blocked: [{ number: 11, openBlockers: [9] }] };
  const result = eligibleIssues(listed, none, [11, 12]);
  assert.deepEqual(result.eligible, [12]);
  assert.deepEqual(result.skipped, [{ number: 11, reason: 'blocked' }]);
});

test('an issue with an open PR or a claude branch (taken) is not eligible', () => {
  const listed: ReadyIssues = { ready: [10, 11, 12], blocked: [] };
  const result = eligibleIssues(listed, [11], [10, 11, 12]);
  assert.deepEqual(result.eligible, [10, 12]);
  assert.deepEqual(result.skipped, [{ number: 11, reason: 'taken' }]);
});

test('an issue from an author outside OWNER, MEMBER and COLLABORATOR is not eligible, and one with no trust answer is not either', () => {
  const listed: ReadyIssues = { ready: [10, 11], blocked: [] };
  const result = eligibleIssues(listed, none, [10]);
  assert.deepEqual(result.eligible, [10]);
  assert.deepEqual(result.skipped, [{ number: 11, reason: 'untrusted' }]);
  assert.deepEqual(eligibleIssues(listed, none, none).eligible, []);
});

test('an issue that is both blocked and untrusted reports the first reason, in the order blocked, taken, untrusted', () => {
  const listed: ReadyIssues = { ready: [20, 21], blocked: [{ number: 22, openBlockers: [1] }] };
  const result = eligibleIssues(listed, [21, 22], none);
  assert.deepEqual(result.skipped, [
    { number: 20, reason: 'untrusted' },
    { number: 21, reason: 'taken' },
    { number: 22, reason: 'blocked' },
  ]);
});

test('an issue the activity lists as both ready and blocked is blocked, and a repeated number is reported once', () => {
  const listed: ReadyIssues = { ready: [5, 5, 6], blocked: [{ number: 5, openBlockers: [2] }] };
  const result = eligibleIssues(listed, none, [5, 6]);
  assert.deepEqual(result.eligible, [6]);
  assert.deepEqual(result.skipped, [{ number: 5, reason: 'blocked' }]);
});

test('numbers that are not listed Ready are never eligible, whatever taken and trusted say', () => {
  const listed: ReadyIssues = { ready: [10], blocked: [] };
  assert.deepEqual(eligibleIssues(listed, [99], [10, 99, 100]).eligible, [10]);
});

test('an empty list gives an empty answer', () => {
  assert.deepEqual(eligibleIssues({ ready: [], blocked: [] }, none, none), { eligible: [], skipped: [], skippedNotReported: 0 });
});

test('the skipped report is bounded and says how many it left out', () => {
  const ready = Array.from({ length: MAX_SKIPPED_REPORTED + 5 }, (_, index) => index + 1);
  const result = eligibleIssues({ ready, blocked: [] }, none, none);
  assert.equal(result.skipped.length, MAX_SKIPPED_REPORTED);
  assert.equal(result.skippedNotReported, 5);
  assert.deepEqual(result.skipped[0], { number: 1, reason: 'untrusted' });
  assert.equal(result.eligible.length, 0);
});

test('the result holds numbers and reasons only', () => {
  const listed: ReadyIssues = { ready: [10], blocked: [{ number: 11, openBlockers: [1] }] };
  const text = JSON.stringify(eligibleIssues(listed, none, [10]));
  assert.equal(text, '{"eligible":[10],"skipped":[{"number":11,"reason":"blocked"}],"skippedNotReported":0}');
});
