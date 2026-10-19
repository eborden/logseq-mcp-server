// The PR template check (#706): the pure parser and `checkPrBody` over differently shaped made-up templates and over the
// repo's real template (read from disk, never restated), and the `readPrTemplate` activity against a fake `gh`.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ApplicationFailure } from '@temporalio/activity';
import { createGithubActivities } from '../src/activities/github.ts';
import { MAX_TEMPLATE_BYTES, PR_TEMPLATE_PATH, checkPrBody, parsePrTemplate, parseTemplateFile } from '../src/pr-template.ts';
import { createFake, emptyState, recordedSleep } from './github-support.ts';
import type { FakeState } from './github-support.ts';

const REAL_TEMPLATE = new URL('../../.github/pull_request_template.md', import.meta.url);

const SMALL = ['<!-- fill every part -->', '', '## Summary', '<!-- one line -->', '', '## Plan', '- [ ] step', '', '### Detail', '', '## Risks', ''].join('\n');

function headingsOf(text: string): readonly string[] {
  const parsed = parsePrTemplate(text);
  assert.equal(parsed.kind, 'ok');
  return parsed.kind === 'ok' ? parsed.headings : [];
}

test('the real template: the check lists exactly its level-2 headings, read from the file', async () => {
  const text = await readFile(REAL_TEMPLATE, 'utf8');
  const expected = text
    .split('\n')
    .filter((line) => /^## \S/.test(line))
    .map((line) => line.slice(3).trim());
  assert.ok(expected.length >= 3, 'the real template has sections');
  assert.deepEqual(headingsOf(text), expected);
});

test('level-3 headings, comments, fenced blocks and checkboxes are not sections', () => {
  const text = ['## One', '### Sub', '<!--', '## Hidden', '-->', '```md', '## Fenced', '```', '~~~', '## Tilde', '~~~', '- [ ] ## not a heading', '## Two ##', '    ## indented code', '#hashtag'].join('\n');
  assert.deepEqual(headingsOf(text), ['One', 'Two']);
});

test('a template with no level-2 heading is a typed result', () => {
  assert.deepEqual(parsePrTemplate('just text\n### only level three\n'), { kind: 'no_sections' });
  assert.deepEqual(parsePrTemplate(''), { kind: 'no_sections' });
});

test('the check follows a template with a section added, one renamed and one removed, with no code change', () => {
  const before = headingsOf(SMALL);
  assert.deepEqual(before, ['Summary', 'Plan', 'Risks']);
  const changed = ['## Summary', '## Approach', '## Risks', '## Rollout'].join('\n');
  assert.deepEqual(headingsOf(changed), ['Summary', 'Approach', 'Risks', 'Rollout']);
  const body = ['## Summary', 'Alice adds a thing', '## Plan', 'old name', '## Risks', 'none'].join('\n');
  const result = checkPrBody(parsePrTemplate(changed), body);
  assert.deepEqual(result.present, ['Summary', 'Risks']);
  assert.deepEqual(result.missing, ['Approach', 'Rollout']);
  assert.equal(result.ok, false);
});

test('a complete body passes, in any order, with extra sections and a fenced block as content', () => {
  const body = ['## Risks', 'none', '## Extra', 'x', '## Summary', 'text', '## Plan', '```mermaid', 'graph TD', '```'].join('\n');
  const result = checkPrBody(parsePrTemplate(SMALL), body);
  assert.deepEqual(result, { present: ['Summary', 'Plan', 'Risks'], missing: [], empty: [], guidanceLeft: false, guidanceSections: [], ok: true });
});

test('a missing section, an empty one and leftover guidance are reported by name', () => {
  const body = ['## Summary', '<!-- one line -->', '## Plan', '', '   ', '## Other', 'x'].join('\n');
  const result = checkPrBody(parsePrTemplate(SMALL), body);
  assert.deepEqual(result.present, []);
  assert.deepEqual(result.empty, ['Summary', 'Plan']);
  assert.deepEqual(result.missing, ['Risks']);
  assert.equal(result.guidanceLeft, true);
  assert.deepEqual(result.guidanceSections, ['Summary']);
  assert.equal(result.ok, false);
});

test('a diagram arrow inside a comment does not end it, and a heading line with a comment is its own section\'s guidance', () => {
  const text = ['## A <!-- note -->', 'text', '## B', '<!--', 'graph', '  X-->>Y: z', '  P-->Q', '```', '## Hidden', '```', '-->', 'text'].join('\n');
  assert.deepEqual(headingsOf(text), ['A', 'B']);
  const result = checkPrBody(parsePrTemplate(text), text);
  assert.deepEqual(result.guidanceSections, ['A', 'B']);
  assert.deepEqual(result.present, ['A', 'B']);
});

test('a comment that opens and closes on one line ends at its first arrow, whatever follows', () => {
  assert.deepEqual(headingsOf('## A\n<!--hint--> note\n## B\nt'), ['A', 'B']);
  assert.deepEqual(headingsOf('## A\n<!-- hint-->text\n## B\nt'), ['A', 'B']);
  assert.deepEqual(headingsOf('## A\n<!--hint--> ## B\n## C'), ['A', 'B', 'C']);
  assert.deepEqual(headingsOf('## A\n<!--hint-->\n## B\n<!-- x --><!-- y -->\n## C'), ['A', 'B', 'C']);
  const result = checkPrBody(parsePrTemplate('## A\n## B\n'), '## A\n<!--hint--> note\n## B\nt');
  assert.deepEqual(result.present, ['A', 'B']);
  assert.deepEqual(result.guidanceSections, ['A']);
});

test('ok is false for an empty section alone, and for leftover guidance alone', () => {
  const template = parsePrTemplate('## A\n## B\n');
  const emptyOnly = checkPrBody(template, '## A\ntext\n## B\n');
  assert.deepEqual([emptyOnly.missing, emptyOnly.empty, emptyOnly.guidanceLeft, emptyOnly.ok], [[], ['B'], false, false]);
  const guidanceOnly = checkPrBody(template, '## A\ntext\n<!-- left -->\n## B\ntext');
  assert.deepEqual([guidanceOnly.missing, guidanceOnly.empty, guidanceOnly.guidanceLeft, guidanceOnly.ok], [[], [], true, false]);
  assert.equal(checkPrBody(template, '## A\ntext\n## B\ntext').ok, true);
});

test('a comment that spans lines or sits before the first heading is leftover guidance; one inside a fence is not', () => {
  const template = parsePrTemplate('## A\n');
  assert.equal(checkPrBody(template, '<!-- note -->\n## A\ntext').guidanceLeft, true);
  assert.deepEqual(checkPrBody(template, '## A\ntext\n<!--\nmore\n-->').guidanceSections, ['A']);
  assert.equal(checkPrBody(template, '## A\n```html\n<!-- code -->\n```\n').guidanceLeft, false);
  assert.equal(checkPrBody(template, '## A\n```html\n<!-- code -->\n```\n').ok, true);
});

test('with no usable template the check never passes', () => {
  assert.equal(checkPrBody({ kind: 'no_sections' }, '## A\ntext').ok, false);
});

test('parseTemplateFile: found, too large (by size and by content), and malformed answers', () => {
  const text = '## A\n';
  const file = { type: 'file', encoding: 'base64', size: text.length, content: Buffer.from(text).toString('base64') + '\n' };
  assert.deepEqual(parseTemplateFile(file), { kind: 'found', text });
  assert.deepEqual(parseTemplateFile({ type: 'file', size: MAX_TEMPLATE_BYTES + 1 }), { kind: 'too_large', bytes: MAX_TEMPLATE_BYTES + 1 });
  const lying = { ...file, size: 5, content: Buffer.alloc(MAX_TEMPLATE_BYTES + 1, 'a').toString('base64') };
  assert.equal(parseTemplateFile(lying).kind, 'too_large');
  for (const bad of [null, [], 'x', { type: 'dir' }, { ...file, size: -1 }, { ...file, encoding: 'none' }, { ...file, content: 5 }]) {
    assert.throws(() => parseTemplateFile(bad), { kind: 'malformed' });
  }
});

// ---- the activity ---------------------------------------------------------------------------------------------

let dir: string;
let counter = 0;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orchestrator-pr-template-'));
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

test('readPrTemplate reads the file at the base ref in one call', async () => {
  const { fake, github } = await setup((state) => {
    state.repoFiles = { [`feature/base:${PR_TEMPLATE_PATH}`]: SMALL, [`main:${PR_TEMPLATE_PATH}`]: '## Other\n' };
  });
  assert.deepEqual(await github.readPrTemplate('feature/base'), { kind: 'found', text: SMALL });
  const calls = await fake.callsMatching('contents');
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.argv.join(' ').includes('ref=feature%2Fbase'));
});

test('readPrTemplate: a missing file and an oversized one are typed results', async () => {
  const { github } = await setup((state) => {
    state.repoFiles = { [`big:${PR_TEMPLATE_PATH}`]: { type: 'file', size: MAX_TEMPLATE_BYTES + 1, encoding: 'none', content: '' } };
  });
  assert.deepEqual(await github.readPrTemplate('nothing-here'), { kind: 'missing' });
  assert.deepEqual(await github.readPrTemplate('big'), { kind: 'too_large', bytes: MAX_TEMPLATE_BYTES + 1 });
});

test('readPrTemplate refuses a ref that is not a branch name, and maps a malformed answer to a failure', async () => {
  const { fake, github } = await setup((state) => {
    state.repoFiles = { [`odd:${PR_TEMPLATE_PATH}`]: { type: 'dir' } };
  });
  for (const bad of ['', '-x', 'a..b', 'a b', 'a?b=c', 5, undefined, 'x'.repeat(201)]) {
    await assert.rejects(github.readPrTemplate(bad as string), (error: unknown) => error instanceof ApplicationFailure && error.nonRetryable && error.type === 'InvalidInput');
  }
  assert.equal((await fake.callsMatching('contents')).length, 0);
  await assert.rejects(github.readPrTemplate('odd'), (error: unknown) => error instanceof ApplicationFailure);
});
