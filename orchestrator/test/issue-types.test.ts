// The exit statements on the PR (#715): pure text, from counts and ids. Every name is made up.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  gateClearComment,
  gateClearCommentKey,
  gateHeldComment,
  gateHeldCommentKey,
  stopPrComment,
  stopPrCommentKey,
} from '../src/issue-types.ts';
import type { GateClearFacts } from '../src/issue-types.ts';

const HEAD = 'c'.repeat(40);
const FACTS: GateClearFacts = {
  workflowId: 'issue-123',
  issue: 123,
  pr: 456,
  headSha: HEAD,
  fixRounds: 2,
  reviewsOnHead: 1,
  unresolvedThreads: 0,
  host: { kind: 'checked', state: 'success', counts: { passed: 82, failed: 0 } },
  advisory: 2,
  advisoryOmitted: 1,
};

test('the gate-clear statement carries the head, the counts and the signal command, and says it is not an approval', () => {
  const text = gateClearComment(FACTS);
  assert.ok(text.includes(`for head \`${HEAD}\` of #456`));
  assert.match(text, /1 review on the head, 0 unresolved review threads, 2 fix rounds used/);
  assert.match(text, /host\/integration: success \(82 passed, 0 failed\)/);
  assert.match(text, /Advisory findings in the last review: 3 \(1 not listed in its body\)/);
  assert.match(text, /This is a gate result and not an approval/);
  assert.ok(text.includes('`npm run signal -- 123 approved`'));
  assert.ok(text.includes('`npm run signal -- 123 changes_requested --message "..."`'));
  assert.ok(text.includes('`issue-123`'));
  assert.match(text, /makes this statement stale/);
});

test('the host line says what was read, or why nothing was', () => {
  assert.match(gateClearComment({ ...FACTS, host: { kind: 'off' } }), /host\/integration: not asked for in this run\./);
  assert.match(gateClearComment({ ...FACTS, host: { kind: 'not_required' } }), /host\/integration: not required for this change\./);
  assert.match(gateClearComment({ ...FACTS, host: { kind: 'checked', state: 'success' } }), /host\/integration: success\./);
});

test('counts read right in the singular, and no advisory findings are said so', () => {
  const text = gateClearComment({ ...FACTS, fixRounds: 1, advisory: 0, advisoryOmitted: 0 });
  assert.match(text, /1 review on the head, 0 unresolved review threads, 1 fix round used/);
  assert.match(text, /Advisory findings in the last review: none/);
});

test('the keys carry the head, so a push gets its own statement and a retry posts once', () => {
  assert.equal(gateClearCommentKey(456, HEAD), `gate-clear-456-${HEAD}`);
  assert.notEqual(gateClearCommentKey(456, HEAD), gateClearCommentKey(456, 'd'.repeat(40)));
  assert.equal(gateHeldCommentKey(456, HEAD), `gate-held-456-${HEAD}`);
  assert.match(gateClearCommentKey(456, HEAD), /^[A-Za-z0-9._-]{1,100}$/);
  assert.match(gateHeldCommentKey(456, HEAD), /^[A-Za-z0-9._-]{1,100}$/);
  assert.match(stopPrCommentKey('review_loop', 'MaxRoundsReached'), /^[A-Za-z0-9._-]{1,100}$/);
});

test('the held-gate statement names what holds the gate and is not an approval', () => {
  const none = gateHeldComment('issue-123', 456, HEAD, 1, [], true);
  assert.match(none, /Gate not clear/);
  assert.match(none, /not an approval/);
  assert.match(none, /1 open review thread, 0 of them with a reply the reviewer accepted\./);
  const some = gateHeldComment('issue-123', 456, HEAD, 3, ['PRRT_a', 'PRRT_b'], true);
  assert.match(some, /3 open review threads, 2 of them with a reply the reviewer accepted \(thread ids: `PRRT_a`, `PRRT_b`\)/);
  assert.ok(some.includes(HEAD));
});

test('the held-gate statement promises a gate-clear statement only when the decision stage runs', () => {
  const waits = gateHeldComment('issue-123', 456, HEAD, 1, [], true);
  assert.match(waits, /The run keeps reading the gate, and when it is clear on a head it posts a gate-clear statement/);
  const ends = gateHeldComment('issue-123', 456, HEAD, 1, [], false);
  assert.match(ends, /This run ends here and does not read the gate again, so it will post no gate-clear statement: a new run is needed/);
  assert.doesNotMatch(ends, /keeps reading the gate/);
});

test('the gate-clear statement says the advisory count is not known when it is not for this head, and claims no count', () => {
  const text = gateClearComment({ ...FACTS, advisory: undefined, advisoryOmitted: undefined });
  assert.match(text, /Advisory findings: not known for this head/);
  assert.doesNotMatch(text, /Advisory findings in the last review/);
  assert.doesNotMatch(text, /on this head, not in a thread/);
});

test('the stop line is one line with the step and the reason, points at the issue, and is not an approval', () => {
  const line = stopPrComment('issue-123', 'review_loop', 'MaxRoundsReached', 123);
  assert.equal(line.includes('\n'), false);
  assert.ok(line.includes('`review_loop`') && line.includes('`MaxRoundsReached`') && line.includes('issue #123'));
  assert.match(line, /not an approval/);
  assert.equal(stopPrCommentKey('review_loop', 'MaxRoundsReached'), 'stopped-pr-review_loop-MaxRoundsReached');
});
