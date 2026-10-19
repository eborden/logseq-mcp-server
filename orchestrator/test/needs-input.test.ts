// The answer to a needs-input comment (#698): which comment counts, the bounded wait activity that reads for it, the board
// moves of a park, and the run input that bounds it. Every name and number is made up. No GitHub, no Temporal server.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ApplicationFailure } from '@temporalio/activity';
import { createGithubActivities } from '../src/activities/github.ts';
import { carriesOrchestratorMarker, findNeedsInputAnswer, findingsMarker, needsInputMarker } from '../src/findings-comment.ts';
import type { FindingsCandidate } from '../src/findings-comment.ts';
import {
  DEFAULT_NEEDS_INPUT_TIMEOUT_MS,
  InvalidIssueInputError,
  MAX_NEEDS_INPUT_TIMEOUT_MS,
  MIN_NEEDS_INPUT_TIMEOUT_MS,
  needsInputParkComment,
  needsInputParkCommentKey,
  parseIssueWorkflowInput,
} from '../src/issue-types.ts';
import { createFake, emptyState, rawComment as plainComment, rawIssue, recordedSleep } from './github-support.ts';
import type { FakeState } from './github-support.ts';

let dir: string;
let counter = 0;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orchestrator-needs-input-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setup(configure: (state: FakeState) => void) {
  const state = emptyState();
  configure(state);
  counter += 1;
  const fake = await createFake(dir, `needs-input-${counter}`, state);
  const clock = recordedSleep();
  return { fake, clock, github: createGithubActivities(fake.config, clock) };
}

/** A raw comment as the issue comments route answers it, with the node id the findings listing reads. */
const rawComment = (id: number, association: string | undefined, body: string) => ({ ...plainComment(id, association, body), node_id: `IC_${id}` });
const candidate = (id: number, trusted: boolean, body: string): FindingsCandidate => ({ id, nodeId: `IC_${id}`, trusted, body: trusted ? body : '' });
const ASKED = needsInputMarker(30, 1);

// ---- which comment answers --------------------------------------------------------------------------------------------

test('a trusted comment newer than the question, with no marker, is the answer; nothing else is', () => {
  const answer = candidate(12, true, 'Use the second option, please.');
  assert.equal(findNeedsInputAnswer([candidate(10, true, `${ASKED}\n\nWhich option?`), candidate(11, true, 'An earlier remark'), answer], 10)?.id, 11, 'the first newer one wins, oldest first');
  assert.equal(findNeedsInputAnswer([candidate(10, true, `${ASKED}\n\nWhich option?`)], 10), undefined, 'the question is not its own answer');
  assert.equal(findNeedsInputAnswer([candidate(9, true, 'Older than the question')], 10), undefined, 'an older comment never answers');
  assert.equal(findNeedsInputAnswer([candidate(11, false, 'A stranger replies')], 10), undefined, 'an untrusted author never answers');
});

test('our own comments never answer: the park comment, a status comment, a findings comment and any marker anywhere', () => {
  const park = `The orchestrator is waiting.\n\n<!-- orchestrator-comment:${needsInputParkCommentKey(1)} -->`;
  const bodies = [park, `${findingsMarker(5, 'a'.repeat(40), 1)}\n\n\`\`\`json\n{}\n\`\`\``, `${needsInputMarker(30, 2)}\n\nAnother question`, 'A reply that quotes <!-- orchestrator-needs-input issue=30 attempt=1 --> inline'];
  bodies.forEach((body, index) => {
    assert.ok(carriesOrchestratorMarker(body), `marker ${index}`);
    assert.equal(findNeedsInputAnswer([candidate(11 + index, true, body)], 10), undefined, `comment ${index}`);
  });
  assert.equal(carriesOrchestratorMarker('A plain answer'), false);
  assert.equal(findNeedsInputAnswer([...bodies.map((body, index) => candidate(11 + index, true, body)), candidate(40, true, 'A plain answer')], 10)?.id, 40);
});

// ---- the wait activity ---------------------------------------------------------------------------------------------------

const wait = (waitMs: number, pollMs = 300_000, issue = 30, afterCommentId = 10) => ({ issue, afterCommentId, waitMs, pollMs });

test('waitForNeedsInputAnswer returns the first answer with no wait, and reads only', async () => {
  const { fake, clock, github } = await setup((state) => {
    state.comments['30'] = [rawComment(10, 'OWNER', `${ASKED}\n\nWhich option?`), rawComment(11, 'OWNER', 'Take the second option.')];
  });
  assert.deepEqual(await github.waitForNeedsInputAnswer(wait(3_600_000)), { answered: true, commentId: 11 });
  assert.deepEqual(clock.waits, []);
  assert.equal((await fake.calls()).filter((call) => call.argv.includes('POST')).length, 0, 'it writes nothing');
});

test('waitForNeedsInputAnswer polls every pollMs until the time is up, reads once more at the end, and answers false', async () => {
  const { fake, clock, github } = await setup((state) => {
    state.comments['30'] = [
      rawComment(10, 'OWNER', `${ASKED}\n\nWhich option?`),
      rawComment(11, 'OWNER', 'The park note\n\n<!-- orchestrator-comment:needs-input-park-1 -->'),
      rawComment(12, 'NONE', 'A stranger tries to answer'),
      rawComment(9, 'OWNER', 'An older remark'),
    ];
  });
  assert.deepEqual(await github.waitForNeedsInputAnswer(wait(900_000)), { answered: false });
  assert.deepEqual(clock.waits, [300_000, 300_000, 300_000]);
  assert.equal((await fake.calls()).filter((call) => call.argv.some((arg) => arg.includes('issues/30/comments'))).length, 4, 'one read at the start and one after each wait');
  assert.deepEqual(await (await setup(() => undefined)).github.waitForNeedsInputAnswer(wait(0)), { answered: false }, 'a zero wait reads once');
});

test('waitForNeedsInputAnswer refuses bad input before any gh call', async () => {
  const { fake, github } = await setup((state) => {
    state.issues['30'] = rawIssue(30);
  });
  for (const bad of [undefined, 7, { ...wait(1), issue: 0 }, { ...wait(1), afterCommentId: 0 }, { ...wait(-1) }, { ...wait(25 * 3_600_000) }, { ...wait(1), pollMs: 0 }, { ...wait(1.5) }]) {
    let failure: unknown;
    try {
      await github.waitForNeedsInputAnswer(bad as never);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof ApplicationFailure && failure.type === 'InvalidInput' && failure.nonRetryable, JSON.stringify(bad));
  }
  assert.equal((await fake.calls()).length, 0);
});

// ---- the board move of a park --------------------------------------------------------------------------------------------

test('setStatus makes In progress to Needs Input and back, and only those two moves involve Needs Input', async () => {
  const { fake, github } = await setup((state) => {
    state.issues['30'] = rawIssue(30);
    state.board = [{ number: 30, status: 'In progress' }];
  });
  assert.deepEqual(await github.setStatus(30, 'Needs Input'), { changed: true, status: 'Needs Input' });
  assert.deepEqual(await github.setStatus(30, 'Needs Input'), { changed: false, status: 'Needs Input' });
  assert.equal((await fake.state()).board[0]?.status, 'Needs Input');
  assert.deepEqual(await github.setStatus(30, 'In progress'), { changed: true, status: 'In progress' });
  assert.equal((await fake.state()).board[0]?.status, 'In progress');
});

test('nothing moves into or out of Needs Input but In progress, and nothing moves Backlog or Ready into it', async () => {
  for (const [from, to] of [
    ['Needs Input', 'In review'],
    ['Needs Input', 'Done'],
    ['Ready', 'Needs Input'],
    ['Backlog', 'Needs Input'],
    ['In review', 'Needs Input'],
    ['Done', 'Needs Input'],
  ] as const) {
    const { fake, github } = await setup((state) => {
      state.issues['30'] = rawIssue(30);
      state.board = [{ number: 30, status: from }];
    });
    let failure: unknown;
    try {
      await github.setStatus(30, to);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof ApplicationFailure && failure.type === 'InvalidState' && failure.nonRetryable, `${from} to ${to}`);
    assert.equal((await fake.callsMatching('item-edit')).length, 0, `${from} to ${to}: nothing written`);
  }
});

test('a pull request never moves to Needs Input', async () => {
  const { fake, github } = await setup((state) => {
    state.board = [{ number: 77, status: 'In progress', type: 'PullRequest' }];
  });
  let failure: unknown;
  try {
    await github.setStatus({ kind: 'pr', number: 77 }, 'Needs Input');
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof ApplicationFailure && failure.type === 'InvalidState');
  assert.equal((await fake.callsMatching('item-edit')).length, 0);
});

// ---- the run input and the park comment ----------------------------------------------------------------------------------

const BASE = { issueNumber: 30, repoDir: '/work/repo', worktreeDir: '/work/wt', base: 'main' };

test('needsInputTimeoutMs is parsed at the boundary with a floor and a ceiling, and absent means the default', () => {
  assert.equal(parseIssueWorkflowInput(BASE).needsInputTimeoutMs, undefined);
  assert.equal(parseIssueWorkflowInput({ ...BASE, needsInputTimeoutMs: MIN_NEEDS_INPUT_TIMEOUT_MS }).needsInputTimeoutMs, MIN_NEEDS_INPUT_TIMEOUT_MS);
  assert.equal(parseIssueWorkflowInput({ ...BASE, needsInputTimeoutMs: MAX_NEEDS_INPUT_TIMEOUT_MS }).needsInputTimeoutMs, MAX_NEEDS_INPUT_TIMEOUT_MS);
  for (const bad of [0, MIN_NEEDS_INPUT_TIMEOUT_MS - 1, MAX_NEEDS_INPUT_TIMEOUT_MS + 1, 1.5, '1000', null, Number.NaN]) {
    assert.throws(() => parseIssueWorkflowInput({ ...BASE, needsInputTimeoutMs: bad }), InvalidIssueInputError, String(bad));
  }
  assert.equal(DEFAULT_NEEDS_INPUT_TIMEOUT_MS, 7 * 24 * 3_600_000);
});

test('the park comment is fixed words and identifiers, names the next attempt and the limit, and carries no marker of the question', () => {
  const text = needsInputParkComment('issue-30', 1, DEFAULT_NEEDS_INPUT_TIMEOUT_MS);
  assert.match(text, /workflow `issue-30`/);
  assert.match(text, /starts attempt 2/);
  assert.match(text, /at most 7 days/);
  assert.match(text, /about every 5 minutes/);
  assert.doesNotMatch(text, /orchestrator-needs-input/);
  assert.equal(needsInputParkCommentKey(2), 'needs-input-park-2');
});
