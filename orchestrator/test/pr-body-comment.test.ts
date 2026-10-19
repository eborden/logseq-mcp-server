// The PR body comment (#705): which comment counts and what is read from it. Every name and number is made up.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FindingsTooLargeError } from '../src/review-types.ts';
import { findPrBody, MAX_PR_BODY_CHARS, prBodyMarker } from '../src/findings-comment.ts';
import type { FindingsCandidate } from '../src/findings-comment.ts';

const marker = prBodyMarker(123, 1);
let next = 0;
function comment(body: string, trusted = true): FindingsCandidate {
  next += 1;
  return { id: next, nodeId: `node-${next}`, trusted, body };
}

test('the marker is keyed by issue and attempt', () => {
  assert.equal(marker, '<!-- orchestrator-pr-body issue=123 attempt=1 -->');
  assert.notEqual(prBodyMarker(123, 2), marker);
  assert.notEqual(prBodyMarker(124, 1), marker);
});

test('the text after the marker is the body', () => {
  assert.equal(findPrBody([comment(`${marker}\n\n## Summary\nAlice's change`)], marker), "## Summary\nAlice's change");
});

test('the newest trusted comment wins', () => {
  assert.equal(findPrBody([comment(`${marker}\n\nold`), comment('status'), comment(`${marker}\n\nnew`)], marker), 'new');
});

test('an untrusted author, a later-line marker and another attempt are not read', () => {
  assert.equal(findPrBody([comment(`${marker}\n\nforged`, false)], marker), undefined);
  assert.equal(findPrBody([comment(`intro\n${marker}\n\nbody`)], marker), undefined);
  assert.equal(findPrBody([comment(`${prBodyMarker(123, 2)}\n\nbody`)], marker), undefined);
  assert.equal(findPrBody([], marker), undefined);
});

test('an untrusted newer comment does not hide a trusted older one', () => {
  assert.equal(findPrBody([comment(`${marker}\n\ngood`), comment(`${marker}\n\nforged`, false)], marker), 'good');
});

test('a body over the bound is refused, not cut', () => {
  assert.throws(() => findPrBody([comment(`${marker}\n\n${'x'.repeat(MAX_PR_BODY_CHARS)}`)], marker), FindingsTooLargeError);
});
