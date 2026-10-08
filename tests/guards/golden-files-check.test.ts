import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

// The golden files (scripts/parity/expected) are the tool contract. CI fails a pull request that changes one unless it
// carries the `golden-change` label, which the maintainer adds after an explicit OK recorded on the PR (#356). These
// guards keep the check in ci.yml, and run its script against a scratch repository, so a reworded step can't quietly
// stop checking.

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
    expect(script).toContain('scripts/parity/expected');
    expect(script).toContain('golden-change');
    // never a `${{ }}` expression inside the script text
    expect(script).not.toContain('${{');
  });

  describe('its script, run against a scratch repository', () => {
    const script = runBlock('Check the golden files');

    function scratch(changes: Record<string, string>): string {
      const dir = mkdtempSync(join(tmpdir(), 'golden-files-'));
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      mkdirSync(join(dir, 'scripts', 'parity', 'expected'), { recursive: true });
      writeFileSync(join(dir, 'scripts', 'parity', 'expected', 'get-page.json'), '{}\n');
      writeFileSync(join(dir, 'README.md'), 'base\n');
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      // the merge commit CI checks out: the base tip is its first parent
      for (const [path, text] of Object.entries(changes)) {
        mkdirSync(join(dir, path, '..'), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      git('add', '.');
      git('commit', '-q', '-m', 'the PR');
      return dir;
    }

    function run(dir: string, labels: string[]) {
      const result = spawnSync('bash', ['-e', '-c', script], { cwd: dir, env: { ...process.env, PR_LABELS: JSON.stringify(labels) }, encoding: 'utf-8' });
      rmSync(dir, { recursive: true, force: true });
      return { status: result.status, out: `${result.stdout}${result.stderr}` };
    }

    it('passes when no golden file changed, label or not', () => {
      expect(run(scratch({ 'README.md': 'changed\n' }), []).status).toBe(0);
      expect(run(scratch({ 'README.md': 'changed\n' }), ['golden-change']).status).toBe(0);
    });

    it('fails a change to a golden file without the label, and names the files', () => {
      const { status, out } = run(
        scratch({ 'scripts/parity/expected/get-page.json': '{"a":1}\n', 'scripts/parity/expected/tool-list.json': '[]\n' }),
        ['task', 'documentation']
      );
      expect(status).toBe(1);
      expect(out).toContain('scripts/parity/expected/get-page.json');
      expect(out).toContain('scripts/parity/expected/tool-list.json');
      expect(out).toContain('golden-change');
    });

    it('fails when no label is set at all', () => {
      expect(run(scratch({ 'scripts/parity/expected/get-page.json': '{"a":1}\n' }), []).status).toBe(1);
    });

    it('passes a change to a golden file that carries the golden-change label', () => {
      const { status, out } = run(scratch({ 'scripts/parity/expected/get-page.json': '{"a":1}\n' }), ['golden-change']);
      expect(status).toBe(0);
      expect(out).toContain('scripts/parity/expected/get-page.json');
    });

    it('does not take a label that merely contains the name', () => {
      expect(run(scratch({ 'scripts/parity/expected/get-page.json': '{"a":1}\n' }), ['golden-change-later']).status).toBe(1);
    });
  });
});
