import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

// The golden results are the tool contract: the `expected` result of each case in rust/tests/data/parity/<group>.json,
// and the recorded tool list rust/tests/data/parity/tool-list.json. CI fails a pull request that changes one unless it
// carries the `golden-change` label, which the maintainer adds after an explicit OK recorded on the PR (#356, #379). A
// group file holds the cases beside their goldens, and a change to a case's stub answers is not a change to the
// contract (ADR-0034 Decision 5), so a group file is compared by its goldens. These guards keep the check in ci.yml, and
// run its script against a scratch repository, so a reworded step can't quietly stop checking.

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8');

/** The `run:` block of the step with this name, as the shell gets it. */
function runBlock(stepName: string): string {
  const lines = workflow.split('\n');
  const at = lines.findIndex(line => line.trim() === `- name: ${stepName}`);
  expect(at, `ci.yml has no step "${stepName}"`).toBeGreaterThan(-1);
  const runAt = lines.findIndex((line, i) => i > at && line.trim() === 'run: |');
  expect(runAt, `step "${stepName}" has no run block`).toBeGreaterThan(-1);
  const indent = lines[runAt + 1].length - lines[runAt + 1].trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

const DATA = 'rust/tests/data/parity';

/** A group file as the recorder writes it: one case to a line. */
const group = (name: string, cases: Array<Record<string, unknown>>): string =>
  `{"group":${JSON.stringify(name)},"cases":[\n${cases.map(c => `  ${JSON.stringify(c)}`).join(',\n')}\n]}\n`;

const aCase = (over: Record<string, unknown> = {}) => ({
  name: 'alice',
  tool: 'logseq_get_page',
  arguments: { page_name: 'Alice' },
  steps: [[{ method: 'logseq.Editor.getPage', args: ['alice'], response: { id: 1 } }]],
  expected: { content: [{ type: 'text', text: '{"page":"Alice"}' }] },
  ...over
});

describe('the golden-files job in ci.yml', () => {
  it('runs on pull requests, and again when the golden-change label is added or removed', () => {
    expect(workflow).toMatch(/pull_request:\s*\n(?:\s*#.*\n)*\s*types: \[[^\]]*\blabeled\b[^\]]*\]/);
    expect(workflow).toMatch(/types: \[[^\]]*\bunlabeled\b[^\]]*\]/);
    const job = workflow.slice(workflow.indexOf('\n  golden-files:'), workflow.indexOf('\n  build-and-test:'));
    expect(job).toContain("if: github.event_name == 'pull_request'");
    // the whole history, so the merge commit's first parent is there
    expect(job).toMatch(/fetch-depth: 0/);
  });

  it('reads the labels through env, and compares the merge commit with its first parent', () => {
    const job = workflow.slice(workflow.indexOf('\n  golden-files:'), workflow.indexOf('\n  build-and-test:'));
    expect(job).toContain('PR_LABELS: ${{ toJSON(github.event.pull_request.labels.*.name) }}');
    const script = runBlock('Check the golden files');
    expect(script).toContain('HEAD^1');
    expect(script).toContain('rust/tests/data/parity');
    expect(script).toContain('golden-change');
    // never a `${{ }}` expression inside the script text
    expect(script).not.toContain('${{');
  });

  // Each run makes a repository with two commits, and a test makes up to three
  describe('its script, run against a scratch repository', { timeout: 30000 }, () => {
    const script = runBlock('Check the golden files');

    /** A repository whose base commit holds one group file, a tool list and a clock list, and whose next commit makes `changes` (a text, or null to delete the file). */
    async function scratch(changes: Record<string, string | null>): Promise<string> {
      const dir = mkdtempSync(join(tmpdir(), 'golden-files-'));
      const git = (...args: string[]) => exec('git', args, { cwd: dir });
      await git('init', '-q', '-b', 'main');
      await git('config', 'user.email', 'test@example.com');
      await git('config', 'user.name', 'Test');
      mkdirSync(join(dir, DATA), { recursive: true });
      writeFileSync(join(dir, DATA, 'get-page.json'), group('get-page', [aCase(), aCase({ name: 'bob', arguments: { page_name: 'Bob' } })]));
      writeFileSync(join(dir, DATA, 'tool-list.json'), '[\n  {\n    "name": "logseq_get_page"\n  }\n]\n');
      writeFileSync(join(dir, DATA, 'clock-cases.json'), '[]\n');
      writeFileSync(join(dir, 'README.md'), 'base\n');
      await git('add', '.');
      await git('commit', '-q', '-m', 'base');
      // the merge commit CI checks out: the base tip is its first parent
      for (const [path, text] of Object.entries(changes)) {
        if (text === null) {
          rmSync(join(dir, path));
          continue;
        }
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      await git('add', '-A');
      await git('commit', '-q', '-m', 'the PR');
      return dir;
    }

    /** The script's exit status and output, run without blocking the worker (a blocked one misses vitest's heartbeat under load) */
    async function run(made: Promise<string>, labels: string[]) {
      const dir = await made;
      try {
        const result = await exec('bash', ['-e', '-c', script], { cwd: dir, env: { ...process.env, PR_LABELS: JSON.stringify(labels) } }).then(
          ({ stdout, stderr }) => ({ status: 0, out: `${stdout}${stderr}` }),
          (error: { code?: number; stdout?: string; stderr?: string }) => ({ status: error.code ?? -1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` })
        );
        return result;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    const GET_PAGE = `${DATA}/get-page.json`;

    it('passes when nothing under the data folder changed, label or not', async () => {
      expect((await run(scratch({ 'README.md': 'changed\n' }), [])).status).toBe(0);
      expect((await run(scratch({ 'README.md': 'changed\n' }), ['golden-change'])).status).toBe(0);
    });

    it('passes a change to a case that is not a change to its golden result, with no label', async () => {
      // A re-recorded call fixture (ADR-0034 Decision 5): the stub's answer, the query, the arguments
      const stub = aCase({ steps: [[{ method: 'logseq.Editor.getPage', args: ['alice', { includeChildren: true }], response: { id: 1, extra: true } }]], arguments: { page_name: 'alice' } });
      expect((await run(scratch({ [GET_PAGE]: group('get-page', [stub, aCase({ name: 'bob', arguments: { page_name: 'Bob' } })]) }), [])).status).toBe(0);
    });

    it('passes a change to the clock list, which is not a golden', async () => {
      expect((await run(scratch({ [`${DATA}/clock-cases.json`]: '["alice"]\n' }), [])).status).toBe(0);
    });

    it('passes a file written another way with the same goldens: other layout, other key order, the cases in another order', async () => {
      const pretty = JSON.stringify({ cases: [aCase({ name: 'bob', arguments: { page_name: 'Bob' } }), aCase()].map(c => ({ expected: c.expected, name: c.name, tool: c.tool, steps: c.steps, arguments: c.arguments })), group: 'get-page' }, null, 2);
      expect((await run(scratch({ [GET_PAGE]: `${pretty}\n` }), [])).status).toBe(0);
    });

    it('passes a move that changes no result: a file renamed, or a case moved to another file', async () => {
      const bob = aCase({ name: 'bob', arguments: { page_name: 'Bob' } });
      expect((await run(scratch({ [GET_PAGE]: null, [`${DATA}/get-pages.json`]: group('get-pages', [aCase(), bob]) }), [])).status).toBe(0);
      expect((await run(scratch({ [GET_PAGE]: group('get-page', [aCase()]), [`${DATA}/get-block.json`]: group('get-block', [bob]) }), [])).status).toBe(0);
    });

    it('fails a move that changes a result on the way, and names the file it landed in', async () => {
      const bob = aCase({ name: 'bob', arguments: { page_name: 'Bob' }, expected: { content: [{ type: 'text', text: '{}' }] } });
      const { status, out } = await run(scratch({ [GET_PAGE]: group('get-page', [aCase()]), [`${DATA}/get-block.json`]: group('get-block', [bob]) }), []);
      expect(status).toBe(1);
      expect(out).toContain(`${DATA}/get-block.json`);
    });

    it('fails a changed golden result without the label, and names the file', async () => {
      const changed = aCase({ expected: { content: [{ type: 'text', text: '{"page":"alice"}' }] } });
      const { status, out } = await run(scratch({ [GET_PAGE]: group('get-page', [changed, aCase({ name: 'bob', arguments: { page_name: 'Bob' } })]) }), ['task', 'documentation']);
      expect(status).toBe(1);
      expect(out).toContain(GET_PAGE);
      expect(out).toContain('golden-change');
    });

    it('fails a case added or removed, since a case is a golden', async () => {
      expect((await run(scratch({ [GET_PAGE]: group('get-page', [aCase(), aCase({ name: 'bob', arguments: { page_name: 'Bob' } }), aCase({ name: 'carol' })]) }), [])).status).toBe(1);
      expect((await run(scratch({ [GET_PAGE]: group('get-page', [aCase()]) }), [])).status).toBe(1);
    });

    it('fails a case that loses its golden result, and a case renamed', async () => {
      const { expected: _expected, ...noResult } = aCase();
      expect((await run(scratch({ [GET_PAGE]: group('get-page', [noResult, aCase({ name: 'bob', arguments: { page_name: 'Bob' } })]) }), [])).status).toBe(1);
      expect((await run(scratch({ [GET_PAGE]: group('get-page', [aCase({ name: 'alice, renamed' }), aCase({ name: 'bob', arguments: { page_name: 'Bob' } })]) }), [])).status).toBe(1);
    });

    it('fails a group file added or deleted, and one that is not JSON', async () => {
      const added = await run(scratch({ [`${DATA}/get-block.json`]: group('get-block', [aCase({ name: 'a block' })]) }), []);
      expect(added.status).toBe(1);
      expect(added.out).toContain(`${DATA}/get-block.json`);
      expect((await run(scratch({ [GET_PAGE]: null }), [])).status).toBe(1);
      expect((await run(scratch({ [GET_PAGE]: 'not json\n' }), [])).status).toBe(1);
    });

    it('fails a change to the recorded tool list without the label, and names the file', async () => {
      const { status, out } = await run(scratch({ [`${DATA}/tool-list.json`]: '[\n  {\n    "name": "logseq_get_page",\n    "title": "Get Page"\n  }\n]\n' }), []);
      expect(status).toBe(1);
      expect(out).toContain(`${DATA}/tool-list.json`);
    });

    it('passes a tool list written with its keys in another order, which is the same list', async () => {
      expect((await run(scratch({ [`${DATA}/tool-list.json`]: '[{"name":"logseq_get_page"}]' }), [])).status).toBe(0);
    });

    it('names every golden file that changed', async () => {
      const { status, out } = await run(
        scratch({
          [GET_PAGE]: group('get-page', [aCase({ name: 'carol' })]),
          [`${DATA}/tool-list.json`]: '[]\n'
        }),
        []
      );
      expect(status).toBe(1);
      expect(out).toContain(GET_PAGE);
      expect(out).toContain(`${DATA}/tool-list.json`);
    });

    it('fails when no label is set at all', async () => {
      expect((await run(scratch({ [GET_PAGE]: group('get-page', [aCase({ name: 'carol' })]) }), [])).status).toBe(1);
    });

    it('passes a changed golden that carries the golden-change label, and still lists the files', async () => {
      const { status, out } = await run(scratch({ [GET_PAGE]: group('get-page', [aCase({ name: 'carol' })]) }), ['golden-change']);
      expect(status).toBe(0);
      expect(out).toContain(GET_PAGE);
    });

    it('does not take a label that merely contains the name', async () => {
      expect((await run(scratch({ [GET_PAGE]: group('get-page', [aCase({ name: 'carol' })]) }), ['golden-change-later'])).status).toBe(1);
    });

    it('no longer watches the old folder, which is gone', async () => {
      expect((await run(scratch({ 'scripts/parity/expected/get-page.json': '{"a":1}\n' }), [])).status).toBe(0);
    });
  });
});
