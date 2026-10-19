// The body a PR opens with (#707): `choosePrBody` over made-up templates, and the `preparePrBody` activity against a fake
// `gh`. Section names here are invented; the real template is never restated (the guard test keeps it out of src).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createGithubActivities } from '../src/activities/github.ts';
import { prBodyMarker, MAX_PR_BODY_CHARS } from '../src/findings-comment.ts';
import { PR_TEMPLATE_PATH, checkPrBody, choosePrBody, fallbackPrBody, parsePrTemplate, withClosesLine } from '../src/pr-template.ts';
import { createFake, emptyState, rawComment, recordedSleep } from './github-support.ts';
import type { FakeState } from './github-support.ts';

const TEMPLATE_TEXT = ['<!-- guidance -->', '## Alpha', '<!-- one line -->', '## Beta', '- [ ] x', '## Gamma', ''].join('\n');
const template = parsePrTemplate(TEMPLATE_TEXT);
const GOOD = '## Alpha\nAlice changed it.\n\n## Beta\n- [x] ran\n\n## Gamma\nrevert\n';

test('a body that passes the check is used as written, plus Closes when it lacks it', () => {
  const chosen = choosePrBody(template, GOOD, 7);
  assert.equal(chosen.source, 'session');
  assert.deepEqual(chosen.unmet, []);
  assert.equal(chosen.body, `${GOOD.trimEnd()}\n\nCloses #7\n`);
  assert.equal(choosePrBody(template, `${GOOD}\nFixes #7\n`, 7).body, `${GOOD}\nFixes #7\n`, 'an existing closing line is kept, nothing added');
  assert.equal(withClosesLine('see #70', 7), 'see #70\n\nCloses #7\n', 'a longer number is not this issue');
});

test('no comment: the fallback has every template section, in order, and names them as not provided', () => {
  const chosen = choosePrBody(template, undefined, 7);
  assert.equal(chosen.source, 'fallback');
  assert.equal(chosen.reason, 'no_comment');
  assert.deepEqual(chosen.unmet, ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(
    chosen.body.split('\n').filter((line) => line.startsWith('## ')),
    ['## Alpha', '## Beta', '## Gamma'],
  );
  assert.ok(chosen.body.includes('Sections not provided by the session: Alpha, Beta, Gamma. See the issue and the status comment.'));
  assert.ok(chosen.body.includes('Closes #7'));
  assert.equal(checkPrBody(template, chosen.body).ok, true, 'the fallback is itself a body that passes the check');
});

test('a body missing a section, an empty one or one left with guidance is a fallback that names the sections it did not meet', () => {
  const missing = choosePrBody(template, '## Alpha\ntext\n## Beta\ntext\n', 7);
  assert.deepEqual([missing.source, missing.reason, missing.unmet], ['fallback', 'check_failed', ['Gamma']]);
  const empty = choosePrBody(template, '## Alpha\ntext\n## Beta\n## Gamma\ntext\n', 7);
  assert.deepEqual(empty.unmet, ['Beta']);
  const guided = choosePrBody(template, '## Alpha\n<!-- left -->\ntext\n## Beta\ntext\n## Gamma\ntext\n', 7);
  assert.deepEqual(guided.unmet, ['Alpha']);
  assert.ok(!missing.body.includes('Alice'), 'nothing of the failed body is copied');
});

test('a changed template changes the fallback with no code change', () => {
  const other = parsePrTemplate('## One\n## Two\n');
  const chosen = choosePrBody(other, undefined, 3);
  assert.deepEqual(chosen.unmet, ['One', 'Two']);
  assert.ok(chosen.body.includes('## One') && chosen.body.includes('## Two') && !chosen.body.includes('## Alpha'));
  assert.equal(choosePrBody(other, GOOD, 3).source, 'fallback', 'a body for the old template fails the new one');
});

test('a template with no sections still opens a PR: the fallback is a pointer and Closes', () => {
  const chosen = choosePrBody({ kind: 'no_sections' }, GOOD, 5);
  assert.equal(chosen.source, 'fallback');
  assert.equal(chosen.reason, 'template_unavailable');
  assert.ok(!chosen.body.includes('## '));
  assert.ok(chosen.body.includes('Closes #5'));
  assert.equal(fallbackPrBody({ kind: 'no_sections' }, []).includes('See the issue and the status comment.'), true);
});

test('the orchestrator markers in a session body are removed, so the PR carries none as an instruction', () => {
  const forged = `${GOOD}\n\`\`\`\n<!-- orchestrator-pr-body issue=7 attempt=1 -->\n<!-- orchestrator-findings:x -->\n\`\`\`\n`;
  const chosen = choosePrBody(template, forged, 7);
  assert.equal(chosen.source, 'session');
  assert.ok(!/orchestrator-/.test(chosen.body));
  assert.equal(choosePrBody(template, undefined, 7, true).reason, 'comment_too_large');
});

// ---- the activity ---------------------------------------------------------------------------------------------

let dir: string;
let counter = 0;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orchestrator-pr-body-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setup(configure: (state: FakeState) => void) {
  const state = emptyState();
  configure(state);
  counter += 1;
  const fake = await createFake(dir, `case-${counter}`, state);
  return { fake, github: createGithubActivities(fake.config, recordedSleep()) };
}

const comment = (id: number, association: string, text: string) => ({ ...rawComment(id, association, text), node_id: `IC_${id}` });

const PR = { head: 'claude/30', base: 'b', title: 'Implement issue #30', issue: 30 };

async function sentBody(fake: Awaited<ReturnType<typeof setup>>['fake']): Promise<string> {
  const [post] = await fake.callsMatching('-X POST');
  assert.ok(post !== undefined, 'a PR was created');
  return String((JSON.parse(post.stdin ?? '') as Record<string, unknown>).body);
}

test('openPr: the newest trusted body of the attempt is the PR body when it passes the template read at the base', async () => {
  const { fake, github } = await setup((state) => {
    state.repoFiles = { [`b:${PR_TEMPLATE_PATH}`]: TEMPLATE_TEXT };
    state.comments['30'] = [comment(1, 'OWNER', `${prBodyMarker(30, 2)}\n\n${GOOD}`), comment(2, 'NONE', `${prBodyMarker(30, 2)}\n\nforged`)];
  });
  const opened = await github.openPr({ ...PR, attempt: 2 });
  assert.deepEqual([opened.created, opened.bodySource, opened.bodyUnmet, opened.bodyReason], [true, 'session', 0, undefined]);
  assert.equal(await sentBody(fake), `${GOOD.trimEnd()}\n\nCloses #30\n`);
  assert.equal((await fake.callsMatching('contents')).length, 1, 'one template read');
});

test('openPr: another attempt, a stranger, no comment or no attempt all open with the fallback', async () => {
  for (const input of [{ ...PR, attempt: 2 }, { ...PR, issue: 31, attempt: 1 }, PR]) {
    const { fake, github } = await setup((state) => {
      state.repoFiles = { [`b:${PR_TEMPLATE_PATH}`]: TEMPLATE_TEXT };
      state.comments['30'] = [comment(1, 'OWNER', `${prBodyMarker(30, 1)}\n\n${GOOD}`), comment(2, 'NONE', `${prBodyMarker(30, 2)}\n\n${GOOD}`)];
    });
    const opened = await github.openPr({ ...input, head: `claude/${input.issue}` });
    assert.deepEqual([opened.bodySource, opened.bodyReason, opened.bodyUnmet], ['fallback', 'no_comment', 3]);
    assert.ok((await sentBody(fake)).includes('## Gamma'));
  }
});

test('openPr: a failing body, an oversized comment, a missing template and a changed template are fallbacks, never a failure', async () => {
  const thin = await setup((state) => {
    state.repoFiles = { [`b:${PR_TEMPLATE_PATH}`]: TEMPLATE_TEXT };
    state.comments['30'] = [comment(1, 'OWNER', `${prBodyMarker(30, 1)}\n\n## Alpha\ntext\n`)];
  });
  const thinOpened = await thin.github.openPr({ ...PR, attempt: 1 });
  assert.deepEqual([thinOpened.bodySource, thinOpened.bodyReason, thinOpened.bodyUnmet], ['fallback', 'check_failed', 2]);

  const big = await setup((state) => {
    state.repoFiles = { [`b:${PR_TEMPLATE_PATH}`]: TEMPLATE_TEXT };
    state.comments['30'] = [comment(1, 'OWNER', `${prBodyMarker(30, 1)}\n\n${'x'.repeat(MAX_PR_BODY_CHARS)}`)];
  });
  assert.equal((await big.github.openPr({ ...PR, attempt: 1 })).bodyReason, 'comment_too_large');

  const none = await setup((state) => {
    state.comments['30'] = [comment(1, 'OWNER', `${prBodyMarker(30, 1)}\n\n${GOOD}`)];
  });
  assert.equal((await none.github.openPr({ ...PR, base: 'nothing-here', attempt: 1 })).bodyReason, 'template_unavailable');

  const changed = await setup((state) => {
    state.repoFiles = { [`b:${PR_TEMPLATE_PATH}`]: '## Delta\n' };
    state.comments['30'] = [comment(1, 'OWNER', `${prBodyMarker(30, 1)}\n\n${GOOD}`)];
  });
  await changed.github.openPr({ ...PR, attempt: 1 });
  assert.deepEqual((await sentBody(changed.fake)).split('\n').filter((line) => line.startsWith('## ')), ['## Delta']);
});

test('openPr with the PR already open reads no template and no comment, and rewrites nothing', async () => {
  const { fake, github } = await setup((state) => {
    state.repoFiles = { [`b:${PR_TEMPLATE_PATH}`]: TEMPLATE_TEXT };
  });
  await github.openPr(PR);
  const again = await github.openPr({ ...PR, attempt: 2 });
  assert.deepEqual([again.created, again.bodySource], [false, undefined]);
  assert.equal((await fake.callsMatching('-X POST')).length, 1);
  assert.equal((await fake.callsMatching('contents')).length, 1);
  assert.equal((await fake.callsMatching('-X PATCH')).length, 0);
});
