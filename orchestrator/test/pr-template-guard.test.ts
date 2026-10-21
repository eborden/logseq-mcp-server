// Guard (#706): the repo's PR template is the one source of its structure. If a level-2 heading of the real template
// appears in orchestrator/src, the structure has been copied into code, and this test fails. It reads the template
// at test time, so nothing from it is written down here either. There are no exceptions (#707 removed the last copy).

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePrTemplate } from '../src/pr-template.ts';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const TEMPLATE = new URL('../../.github/pull_request_template.md', import.meta.url);

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sourceFiles(path)));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

/**
 * The files of `files` that write one of `headings` the way code would copy it: as a whole string literal ('Name',
 * "Name" or `Name`) or as a markdown heading (`## Name`, anywhere, even inside a one-line string). A heading that only occurs inside a longer sentence
 * ("what changed" in a comment) is ordinary prose, not a copy of the structure.
 */
export function leaks(files: readonly { path: string; text: string }[], headings: readonly string[]): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    for (const heading of headings) {
      const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(['"\`])${escaped}\\1|(?<![#\\w])#{2}\\s+${escaped}(?![A-Za-z0-9_])`, 'mi').test(text)) {
        hits.push(`${path}: ${heading}`);
      }
    }
  }
  return hits;
}

async function scan() {
  const template = parsePrTemplate(await readFile(TEMPLATE, 'utf8'));
  assert.equal(template.kind, 'ok', 'the real template has level-2 headings');
  const headings = template.kind === 'ok' ? template.headings : [];
  const files = await Promise.all((await sourceFiles(SRC)).map(async (path) => ({ path: path.slice(SRC.length + 1), text: await readFile(path, 'utf8') })));
  assert.ok(files.length > 10, 'the scan sees the source files');
  return { files, headings };
}

test('no level-2 heading of the real PR template appears in orchestrator/src', async () => {
  const { files, headings } = await scan();
  assert.deepEqual(leaks(files, headings), []);
});

test('the scan catches a heading added to a source file', () => {
  assert.deepEqual(leaks([{ path: 'a.ts', text: "const required = ['Alpha part', 'Beta'];" }], ['Alpha part', 'Gamma']), ['a.ts: Alpha part']);
  assert.deepEqual(leaks([{ path: 'b.ts', text: '// ## Gamma\nconst x = `Gamma`;' }], ['Gamma']), ['b.ts: Gamma']);
  assert.deepEqual(leaks([{ path: 'd.ts', text: "const body = '## Gamma\\n';" }], ['Gamma']), ['d.ts: Gamma']);
  assert.deepEqual(leaks([{ path: 'e.ts', text: "const body = '## Gamma (undo)';" }], ['Gamma']), ['e.ts: Gamma']);
  assert.deepEqual(leaks([{ path: 'f.ts', text: "const x = '## Gammas';" }], ['Gamma']), []);
  assert.deepEqual(leaks([{ path: 'c.ts', text: '// the alpha part, as designed' }], ['Alpha part', 'Design']), []);
  assert.deepEqual(leaks([{ path: 'a.ts', text: 'nothing here' }], ['Alpha part']), []);
});
