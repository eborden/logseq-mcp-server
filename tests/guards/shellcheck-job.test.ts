import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

// Shell glue is linted in CI (#381): ShellCheck on every tracked *.sh, and actionlint, which runs ShellCheck on the
// workflows' run: blocks. These guards keep the `shellcheck` job in ci.yml, keep actionlint pinned (version and
// checksum), and run the job's script against a scratch repository, so a reworded step can't quietly stop linting.
// The scratch run needs `shellcheck` on PATH (ubuntu-latest has it; elsewhere `brew install shellcheck`).

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8');

/** The text of the `shellcheck` job: from its key to the next job (a line indented two spaces) or the end. */
function shellcheckJob(): string {
  const start = workflow.indexOf('\n  shellcheck:\n');
  expect(start, 'ci.yml has no `shellcheck` job').toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The `run:` block of the step with this name inside the job, as the shell gets it. */
function runBlock(job: string, stepName: string): string {
  const lines = job.split('\n');
  const at = lines.findIndex(line => line.trim() === `- name: ${stepName}`);
  expect(at, `the shellcheck job has no step "${stepName}"`).toBeGreaterThan(-1);
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

describe('the shellcheck job in ci.yml', () => {
  const job = shellcheckJob();

  it('runs ShellCheck over every tracked *.sh file and prints its version', () => {
    const script = runBlock(job, 'ShellCheck the shell scripts');
    expect(script).toContain('shellcheck --version');
    expect(script).toMatch(/git ls-files -z '\*\.sh' \| xargs -0 .*shellcheck\s*$/m);
    // the default severity: a flag that relaxes it would hide findings
    expect(script).not.toMatch(/--severity|-S\s|--exclude|-e\s+SC/);
  });

  it('lints the workflows with actionlint, which runs ShellCheck on the run: blocks', () => {
    expect(job).toMatch(/- name: Lint the workflows and their run blocks\n\s+run: '"\$\{RUNNER_TEMP\}\/actionlint" -color'/);
    // no flag may switch ShellCheck off or narrow what it reports
    expect(job).not.toMatch(/actionlint[^\n]*(-shellcheck|-ignore)/);
  });

  it('pins actionlint by version and by the SHA-256 of the release tarball, and verifies it before use', () => {
    const version = /ACTIONLINT_VERSION: '(\d+\.\d+\.\d+)'/.exec(job)?.[1];
    expect(version, 'ACTIONLINT_VERSION is a quoted x.y.z').toBeDefined();
    expect(job).toMatch(/ACTIONLINT_SHA256: [0-9a-f]{64}\n/);

    const install = runBlock(job, 'Install actionlint (pinned by checksum)');
    expect(install).toContain('https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${archive}');
    expect(install).toContain('archive="actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz"');
    const check = install.indexOf('sha256sum --check');
    expect(check, 'the tarball is checked').toBeGreaterThan(-1);
    expect(install.indexOf('${ACTIONLINT_SHA256}')).toBeLessThan(check);
    // checked before it is unpacked
    expect(install.indexOf('tar --extract')).toBeGreaterThan(check);
  });

  it('pins every action it uses by commit SHA', () => {
    const uses = [...job.matchAll(/^\s*- uses: (\S+)/gm)].map(m => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, 'unpinned action').toMatch(/@[0-9a-f]{40}$/);
  });

  it('reads no secrets and has no write permissions beyond the workflow default', () => {
    expect(job).not.toContain('secrets.');
    expect(job).not.toMatch(/permissions:/);
  });

  describe('its ShellCheck step, run against a scratch repository', () => {
    const script = runBlock(job, 'ShellCheck the shell scripts');

    // One probe up front: a machine without ShellCheck fails here with the install hint, not as a bare
    // `expected 127 to be 0` from the scratch runs.
    beforeAll(() => {
      const probe = spawnSync('shellcheck', ['--version'], { encoding: 'utf-8' });
      if (probe.error || probe.status !== 0) {
        throw new Error('shellcheck is not installed or does not run: install it (ubuntu-latest has it; locally `brew install shellcheck`)');
      }
    });

    function scratch(files: Record<string, string>): { status: number | null; output: string } {
      const dir = mkdtempSync(join(tmpdir(), 'shellcheck-job-'));
      try {
        const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
        git('init', '-q', '-b', 'main');
        for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
        git('add', '.');
        const run = spawnSync('bash', ['-eo', 'pipefail', '-c', script], { cwd: dir, encoding: 'utf-8' });
        if (run.error) throw new Error(`could not run the step: ${run.error.message}`);
        return { status: run.status, output: `${run.stdout}${run.stderr}` };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    const clean = '#!/usr/bin/env bash\nset -euo pipefail\necho "ok"\n';
    const unquoted = '#!/usr/bin/env bash\nfile=$1\nrm $file\n';

    it('passes a clean script', () => {
      expect(scratch({ 'clean.sh': clean }).status).toBe(0);
    });

    it('fails on a finding in a tracked *.sh file', () => {
      const result = scratch({ 'clean.sh': clean, 'bad.sh': unquoted });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('SC2086');
    });

    it('ignores a file that is not a tracked *.sh', () => {
      expect(scratch({ 'clean.sh': clean, 'notes.txt': unquoted }).status).toBe(0);
    });

    it('passes when the repository has no shell script', () => {
      expect(scratch({ 'notes.txt': 'nothing here\n' }).status).toBe(0);
    });
  });
});

// CLAUDE.md: a `# shellcheck disable=` needs its reason on the same line, as `# shellcheck disable=SC2034 # why`.
describe('shellcheck disable directives', () => {
  const directive = /#\s*shellcheck\s+disable=/;
  const withReason = /#\s*shellcheck\s+disable=[A-Za-z0-9,-]+\s+#\s*\S/;

  it('the matcher wants a reason after the codes, on the same line', () => {
    expect(withReason.test('# shellcheck disable=SC2034 # read by the sourcing script')).toBe(true);
    expect(withReason.test('x=1 # shellcheck disable=SC2034,SC2154 # set by the caller')).toBe(true);
    expect(withReason.test('# shellcheck disable=SC2034')).toBe(false);
    expect(withReason.test('# shellcheck disable=SC2034 #')).toBe(false);
  });

  it('every one in a tracked shell script or workflow has a reason', () => {
    const tracked = execFileSync('git', ['ls-files', '-z', '*.sh', '.github/workflows/*.yml'], { cwd: ROOT, encoding: 'utf-8' })
      .split('\0')
      .filter(Boolean);
    expect(tracked.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const file of tracked) {
      readFileSync(join(ROOT, file), 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          if (directive.test(line) && !withReason.test(line)) missing.push(`${file}:${i + 1}`);
        });
    }
    expect(missing, 'add the reason on the same line, as `# shellcheck disable=SCxxxx # why`').toEqual([]);
  });
});
