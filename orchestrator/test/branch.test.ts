// The diff guard and the branch activities, with no server, no GitHub and no model: pure checks of the guard, then the
// activities against throwaway repositories with a local bare `origin`. A wrapper around git records every argv, so a
// test can assert that the push is exactly the fixed command and that a refused branch name never reaches git.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';
import { ApplicationFailure } from '@temporalio/activity';
import { MockActivityEnvironment } from '@temporalio/testing';
import { createBranchActivities } from '../src/activities/branch.ts';
import { BRANCH_ACTIVITY_OPTIONS, isPushableBranch, NON_RETRYABLE_BRANCH_FAILURES } from '../src/branch-types.ts';
import { checkChangedPaths, isProtectedPath, MAX_CHANGED_FILES } from '../src/diff-guard.ts';

const execFileAsync = promisify(execFile);

const PROTECTED = [
  '.github/workflows/ci.yml',
  '.github/pull_request_template.md',
  'CLAUDE.md',
  'docs/CLAUDE.md',
  'CLAUDE.local.md',
  '.claude/settings.json',
  '.claude/skills/x/SKILL.md',
  'docs/adr/0099-x.md',
  'docs/business-rules/0099-x.md',
  '.env',
  '.env.local',
  'orchestrator/.env.production',
  'orchestrator/src/config.ts',
  'orchestrator/src/claude-session-policy.ts',
  'orchestrator/src/activities/claude-session.ts',
  'orchestrator/src/activities/branch.ts',
  'orchestrator/src/diff-guard.ts',
  'orchestrator/src/branch-types.ts',
  'orchestrator/.temporal/dev.sqlite',
  'keys/server.pem',
  'x/id.key',
  // The same paths on a case-insensitive disk.
  '.GitHub/workflows/ci.yml',
  'claude.MD',
  'Docs/ADR/0099-x.md',
  'Orchestrator/Src/Config.ts',
  // Not inside the work tree.
  '../outside.txt',
  '/etc/passwd',
  'a/../b',
  '.git/hooks/pre-push',
];

const ALLOWED = [
  'src/tools/find_blocks/mod.rs',
  'tests/data/parity/find_blocks.json',
  'docs/architecture.md',
  'docs/adr-notes.md',
  'orchestrator/src/brief.ts',
  'orchestrator/test/brief.test.ts',
  'orchestrator/README.md',
  'README.md',
  'scripts/x.sh',
  'claude-notes.md',
  'my.environment.ts',
];

test('every protected path fails the guard, whatever its case, and every ordinary path passes', () => {
  for (const path of PROTECTED) {
    assert.equal(isProtectedPath(path), true, path);
    const verdict = checkChangedPaths(['src/ok.ts', path]);
    assert.deepEqual({ ok: verdict.ok, reason: verdict.ok ? undefined : verdict.reason }, { ok: false, reason: 'ProtectedPath' }, path);
  }
  for (const path of ALLOWED) {
    assert.equal(isProtectedPath(path), false, path);
  }
  assert.deepEqual(checkChangedPaths(ALLOWED), { ok: true, files: ALLOWED.length });
});

test('an empty diff and an unexpectedly large one fail, and the failure carries counts, not paths', () => {
  assert.deepEqual(checkChangedPaths([]), { ok: false, reason: 'EmptyDiff', files: 0, protectedPaths: 0 });
  const many = Array.from({ length: MAX_CHANGED_FILES }, (_, index) => `src/file-${index}.ts`);
  assert.equal(checkChangedPaths(many).ok, true, 'exactly the limit passes');
  assert.deepEqual(checkChangedPaths([...many, 'src/one-more.ts']), { ok: false, reason: 'DiffTooLarge', files: MAX_CHANGED_FILES + 1, protectedPaths: 0 });
  // A protected path outranks size, and the verdict names none of them.
  const verdict = checkChangedPaths([...many, '.github/x.yml']);
  assert.deepEqual(verdict, { ok: false, reason: 'ProtectedPath', files: MAX_CHANGED_FILES + 1, protectedPaths: 1 });
  assert.ok(!JSON.stringify(verdict).includes('.github'));
});

test('only claude/<number> is a branch the push accepts', () => {
  for (const good of ['claude/1', 'claude/629', 'claude/999999999']) {
    assert.equal(isPushableBranch(good), true, good);
  }
  for (const bad of [
    'main',
    'claude/x',
    'claude/0',
    'claude/012',
    'claude/629-slug',
    'claude/1:main',
    'claude/1 HEAD:main',
    'claude/1\nmain',
    '+claude/1',
    ':claude/1',
    '--delete',
    '-u',
    'HEAD',
    'refs/heads/claude/1',
    'claude/1/../2',
    'claude//1',
    'claude/1000000000',
    '',
    undefined,
    7,
  ]) {
    assert.equal(isPushableBranch(bad), false, String(bad));
  }
});

test('the policy: bounded attempts, and the failures a retry cannot fix are not retried', () => {
  assert.equal(BRANCH_ACTIVITY_OPTIONS.retry?.maximumAttempts, 3);
  for (const type of ['InvalidInput', 'ProtectedPath', 'DiffTooLarge', 'EmptyDiff', 'BranchMoved', 'PushRejected']) {
    assert.ok(NON_RETRYABLE_BRANCH_FAILURES.includes(type), type);
    assert.ok(BRANCH_ACTIVITY_OPTIONS.retry?.nonRetryableErrorTypes?.includes(type), type);
  }
});

// ---- the activities against real repositories ---------------------------------------------------------------------

interface Scenario {
  readonly dir: string;
  readonly origin: string;
  readonly repo: string;
  readonly argvLog: string;
  readonly activities: ReturnType<typeof createBranchActivities>;
}

let scenario: Scenario;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd });
  return stdout.trim();
}

async function writeIn(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-branch-'));
  const origin = join(dir, 'origin.git');
  const repo = join(dir, 'repo');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await execFileAsync('git', ['clone', '-q', origin, repo]);
  await git(repo, 'checkout', '-q', '-b', 'main');
  await writeIn(repo, { 'README.md': 'x\n', '.github/old.yml': 'on: push\n' });
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'init');
  await git(repo, 'push', '-q', 'origin', 'main');
  // A git wrapper that records each argv (separated by the unit separator), then runs the real git.
  const wrapper = join(dir, 'git-wrapper');
  const argvLog = join(dir, 'argv.log');
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\037' "$@" >> '${argvLog}'\nprintf '\\n' >> '${argvLog}'\nexec git "$@"\n`);
  await chmod(wrapper, 0o755);
  scenario = { dir, origin, repo, argvLog, activities: createBranchActivities({ gitBin: wrapper }) };
});

afterEach(async () => {
  await rm(scenario.dir, { recursive: true, force: true });
});

/** A branch off main with the given files committed (and then main checked out again). Returns its tip. */
async function branchWith(name: string, files: Record<string, string>, remove: string[] = []): Promise<string> {
  const { repo } = scenario;
  await git(repo, 'checkout', '-q', '-b', name, 'main');
  await writeIn(repo, files);
  for (const path of remove) {
    await rm(join(repo, path));
  }
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'work', '--allow-empty');
  const sha = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'checkout', '-q', 'main');
  return sha;
}

function input(branch: string, headSha: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { repoDir: scenario.repo, branch, headSha, base: 'main', ...overrides };
}

async function failureOf(promise: Promise<unknown>): Promise<ApplicationFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApplicationFailure) {
      return error;
    }
    throw error;
  }
  assert.fail('the activity should have failed');
}

async function argvs(): Promise<string[][]> {
  try {
    return (await readFile(scenario.argvLog, 'utf8')).split('\n').filter((line) => line !== '').map((line) => line.split('\u001f').slice(0, -1));
  } catch {
    return [];
  }
}

const guard = (raw: unknown) => new MockActivityEnvironment().run(scenario.activities.guardBranch, raw);
const push = (raw: unknown) => new MockActivityEnvironment().run(scenario.activities.pushBranch, raw);

test('guardBranch passes an ordinary change and reports how many files', async () => {
  const sha = await branchWith('claude/1', { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  assert.deepEqual(await guard(input('claude/1', sha)), { branch: 'claude/1', headSha: sha, files: 2 });
});

test('guardBranch refuses a branch that changes a protected path, for each path, with a count and no path in the failure', async () => {
  const paths = ['.github/workflows/x.yml', 'CLAUDE.md', '.claude/settings.json', 'docs/adr/0099-x.md', 'docs/business-rules/0099-x.md', '.env.local', 'orchestrator/src/config.ts', '.GitHub/y.yml'];
  for (const [index, path] of paths.entries()) {
    const name = `claude/${100 + index}`;
    const sha = await branchWith(name, { 'src/fine.ts': 'x\n', [path]: 'x\n' });
    const failure = await failureOf(guard(input(name, sha)));
    assert.equal(failure.type, 'ProtectedPath', path);
    assert.equal(failure.nonRetryable, true, path);
    assert.match(failure.message, /changes 2 file\(s\), 1 of them protected/);
    assert.ok(!failure.message.includes(path), 'no path in the failure');
  }
});

test('guardBranch sees a file moved out of a protected directory, and one deleted from it', async () => {
  await branchWith('claude/200', {});
  await git(scenario.repo, 'checkout', '-q', 'claude/200');
  await mkdir(join(scenario.repo, 'src'), { recursive: true });
  await git(scenario.repo, 'mv', '.github/old.yml', 'src/old.yml');
  await git(scenario.repo, 'commit', '-q', '-m', 'move');
  const sha = await git(scenario.repo, 'rev-parse', 'HEAD');
  await git(scenario.repo, 'checkout', '-q', 'main');
  assert.equal((await failureOf(guard(input('claude/200', sha)))).type, 'ProtectedPath', 'a move out of .github');

  const deleted = await branchWith('claude/201', { 'src/x.ts': 'x\n' }, ['.github/old.yml']);
  assert.equal((await failureOf(guard(input('claude/201', deleted)))).type, 'ProtectedPath', 'a deletion in .github');
});

test('guardBranch refuses an empty diff and a diff of more than the limit of files', async () => {
  const empty = await branchWith('claude/300', {});
  assert.equal((await failureOf(guard(input('claude/300', empty)))).type, 'EmptyDiff');

  const files: Record<string, string> = {};
  for (let index = 0; index <= MAX_CHANGED_FILES; index += 1) {
    files[`src/many/f${index}.txt`] = 'x\n';
  }
  const big = await branchWith('claude/301', files);
  const failure = await failureOf(guard(input('claude/301', big)));
  assert.equal(failure.type, 'DiffTooLarge');
  assert.equal(failure.nonRetryable, true);
});

test('both activities refuse a branch that is not at the commit the session ended at', async () => {
  const sha = await branchWith('claude/400', { 'src/a.ts': 'a\n' });
  const other = '0'.repeat(40);
  assert.equal((await failureOf(guard(input('claude/400', other)))).type, 'BranchMoved');
  assert.equal((await failureOf(push(input('claude/400', other)))).type, 'BranchMoved');
  assert.equal((await failureOf(push(input('claude/401', sha)))).type, 'BranchMoved', 'a branch that does not exist');
  assert.equal((await git(scenario.repo, 'ls-remote', '--heads', 'origin', 'claude/400')), '', 'nothing was pushed');
});

test('pushBranch pushes with the fixed argv, reads the remote back, and a second push changes nothing', async () => {
  const sha = await branchWith('claude/12', { 'src/a.ts': 'a\n' });

  assert.deepEqual(await push(input('claude/12', sha)), { branch: 'claude/12', headSha: sha });
  assert.deepEqual(await push(input('claude/12', sha)), { branch: 'claude/12', headSha: sha });

  assert.match(await git(scenario.repo, 'ls-remote', '--heads', 'origin', 'claude/12'), new RegExp(`^${sha}\\s`));
  const pushes = (await argvs()).filter((argv) => argv.includes('push'));
  assert.deepEqual(pushes, [
    ['-c', 'core.hooksPath=/dev/null', 'push', '-u', 'origin', 'claude/12'],
    ['-c', 'core.hooksPath=/dev/null', 'push', '-u', 'origin', 'claude/12'],
  ]);
  // Only that branch and main are on the remote: nothing else was written.
  const heads = (await git(scenario.repo, 'ls-remote', '--heads', 'origin')).split('\n').map((line) => line.split('\t')[1]);
  assert.deepEqual(heads.sort(), ['refs/heads/claude/12', 'refs/heads/main']);
});

test('a hook in the shared repository does not run for the push', async () => {
  const sha = await branchWith('claude/13', { 'src/a.ts': 'a\n' });
  const hook = join(scenario.repo, '.git', 'hooks', 'pre-push');
  await writeFile(hook, `#!/bin/sh\necho ran > '${join(scenario.dir, 'hook-ran')}'\nexit 1\n`);
  await chmod(hook, 0o755);

  assert.deepEqual(await push(input('claude/13', sha)), { branch: 'claude/13', headSha: sha });
  await assert.rejects(readFile(join(scenario.dir, 'hook-ran'), 'utf8'), { code: 'ENOENT' });
});

test('a branch name that is a refspec, an option or a slug is refused before any git call', async () => {
  const sha = await branchWith('claude/14', { 'src/a.ts': 'a\n' });
  const before = (await argvs()).length;
  for (const bad of ['claude/14:main', 'claude/14 HEAD:main', '--delete', '-u', 'main', 'claude/14-slug', '+claude/14', 'HEAD', 'refs/heads/claude/14', ':claude/14']) {
    for (const run of [push, guard]) {
      const failure = await failureOf(run(input(bad, sha)));
      assert.equal(failure.type, 'InvalidInput', bad);
      assert.equal(failure.nonRetryable, true, bad);
    }
  }
  for (const bad of [input('claude/14', 'not-a-sha'), input('claude/14', sha, { base: '--upload-pack=x' }), input('claude/14', sha, { repoDir: 'relative' }), 'nope']) {
    assert.equal((await failureOf(push(bad))).type, 'InvalidInput');
    assert.equal((await failureOf(guard(bad))).type, 'InvalidInput');
  }
  assert.equal((await argvs()).length, before, 'git was never called for a refused input');
  assert.equal(await git(scenario.repo, 'ls-remote', '--heads', 'origin', 'claude/14'), '');
});

test('a remote that refuses the push is a PushRejected failure that is not retried', async () => {
  // Someone else already put a different history on claude/15.
  const other = join(scenario.dir, 'other');
  await execFileAsync('git', ['clone', '-q', scenario.origin, other]);
  await git(other, 'checkout', '-q', '-b', 'claude/15');
  await writeIn(other, { 'elsewhere.txt': 'x\n' });
  await git(other, 'add', '.');
  await git(other, 'commit', '-q', '-m', 'elsewhere');
  await git(other, 'push', '-q', 'origin', 'claude/15');
  const sha = await branchWith('claude/15', { 'src/a.ts': 'a\n' });

  const failure = await failureOf(push(input('claude/15', sha)));

  assert.equal(failure.type, 'PushRejected');
  assert.equal(failure.nonRetryable, true);
  assert.ok(!failure.message.includes('elsewhere'));
});
