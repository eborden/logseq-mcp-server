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
import {
  checkBranchChanges,
  isProtectedPath,
  MAX_CHANGED_FILES,
  normalizePath,
  parseRawDiff,
  PROTECTED_BASENAMES,
  PROTECTED_PREFIXES,
  protectedDenyRules,
  RawDiffError,
} from '../src/diff-guard.ts';
import type { ChangedFile } from '../src/diff-guard.ts';

const execFileAsync = promisify(execFile);

// Every entry of the protected set, by the principle in src/diff-guard.ts: what an allowed command, the worker or CI
// executes, what configures git, npm, cargo, node or claude, CI and release files, and the orchestrator itself.
const PROTECTED = [
  // CI and release
  '.github/workflows/ci.yml',
  '.github/pull_request_template.md',
  'about.toml',
  'about.hbs',
  'Dockerfile',
  'Dockerfile.dev',
  'docker-compose.yml',
  'Makefile',
  // executed by an allowed command: manifests, lockfiles, build scripts, scripts, hooks, tool configs
  'package.json',
  'orchestrator/package.json',
  'sub/dir/package.json',
  'package-lock.json',
  'orchestrator/package-lock.json',
  'npm-shrinkwrap.json',
  'Cargo.toml',
  'Cargo.lock',
  'crates/x/Cargo.toml',
  'build.rs',
  'crates/x/build.rs',
  'rust-toolchain.toml',
  'rust-toolchain',
  'scripts/cloud-setup.sh',
  'scripts/measure-api-calls.ts',
  '.husky/pre-commit',
  '.githooks/pre-push',
  'vitest.config.ts',
  'orchestrator/vite.config.mjs',
  'jest.config.js',
  'webpack.config.cjs',
  '.eslintrc.json',
  '.babelrc',
  '.mocharc.yml',
  '.pre-commit-config.yaml',
  // configuration of git, npm, cargo, node and claude
  '.npmrc',
  'orchestrator/.npmrc',
  '.cargo/config.toml',
  '.gitattributes',
  'sub/.gitattributes',
  '.gitmodules',
  '.mcp.json',
  'sub/.mcp.json',
  '.claude/settings.json',
  '.claude/skills/x/SKILL.md',
  '.devcontainer/devcontainer.json',
  '.vscode/tasks.json',
  'CLAUDE.md',
  'docs/CLAUDE.md',
  'CLAUDE.local.md',
  '.git/hooks/pre-push',
  'sub/.git/config',
  // rules CI enforces
  'docs/adr/0099-x.md',
  'docs/business-rules/0099-x.md',
  'tests/guards/privacy.test.ts',
  'tests/rust-guards/version.test.ts',
  // secrets and databases
  '.env',
  '.env.local',
  'orchestrator/.env.production',
  'keys/server.pem',
  'x/id.key',
  'x/cert.p12',
  'orchestrator/.temporal/dev.sqlite',
  'x/data.sqlite-journal',
  // the orchestrator itself
  'orchestrator/src/config.ts',
  'orchestrator/src/brief.ts',
  'orchestrator/src/workflows/issue.ts',
  'orchestrator/src/activities/github.ts',
  'orchestrator/src/activities/branch.ts',
  'orchestrator/src/diff-guard.ts',
  // the same on a case-insensitive disk
  '.GitHub/workflows/ci.yml',
  'claude.MD',
  'Docs/ADR/0099-x.md',
  'Orchestrator/Src/Config.ts',
  'PACKAGE.JSON',
  'cargo.toml',
  'Scripts/x.sh',
  // paths that need normalising, or are not inside the work tree
  'docs/./adr/x.md',
  'docs//adr/x.md',
  'src/../.github/x.yml',
  'src/../../outside.txt',
  '../outside.txt',
  '/etc/passwd',
  'a/../b/../..',
  '.github\\workflows\\ci.yml',
  '.',
  '',
];

const ALLOWED = [
  'src/tools/find_blocks/mod.rs',
  'tests/data/parity/find_blocks.json',
  'tests/integration/x.test.ts',
  'docs/architecture.md',
  'docs/adr-notes.md',
  'orchestrator/test/brief.test.ts',
  'orchestrator/README.md',
  'README.md',
  'claude-notes.md',
  'my.environment.ts',
  'src/package.json.md',
  'src/build.rs.txt',
  'notes/scripts-overview.md',
  'src/github/mod.rs',
];

function file(path: string, oldMode = '000000', newMode = '100644'): ChangedFile {
  return { path, oldMode, newMode };
}

test('every protected path fails the guard, whatever its case or spelling, and every ordinary path passes', () => {
  for (const path of PROTECTED) {
    assert.equal(isProtectedPath(path), true, JSON.stringify(path));
    const verdict = checkBranchChanges([file('src/ok.ts')], [file('src/ok.ts'), file(path)]);
    assert.deepEqual({ ok: verdict.ok, reason: verdict.ok ? undefined : verdict.reason }, { ok: false, reason: 'ProtectedPath' }, JSON.stringify(path));
  }
  for (const path of ALLOWED) {
    assert.equal(isProtectedPath(path), false, path);
  }
  const ordinary = ALLOWED.map((path) => file(path));
  assert.deepEqual(checkBranchChanges(ordinary, ordinary), { ok: true, files: ALLOWED.length });
});

test('every entry of the protected set is in the test list, so a new one cannot be added without a test', () => {
  for (const prefix of PROTECTED_PREFIXES) {
    assert.ok(PROTECTED.some((path) => path.toLowerCase().startsWith(prefix)), `no test path under ${prefix}`);
  }
  for (const name of PROTECTED_BASENAMES) {
    assert.ok(
      PROTECTED.some((path) => path.toLowerCase().split('/').pop() === name.toLowerCase()),
      `no test path named ${name}`,
    );
  }
});

test('paths are normalised before they are compared', () => {
  assert.equal(normalizePath('docs/./adr/x.md'), 'docs/adr/x.md');
  assert.equal(normalizePath('Docs//ADR/x.md'), 'docs/adr/x.md');
  assert.equal(normalizePath('src/../.github/x'), '.github/x');
  assert.equal(normalizePath('.github\\x'), '.github/x');
  assert.equal(normalizePath('../x'), undefined);
  assert.equal(normalizePath('a/../../x'), undefined);
  assert.equal(normalizePath('/abs'), undefined);
});

test('the same set is the deny rules for the file tools: every prefix, name and extension has an Edit and a Write rule', () => {
  const rules = protectedDenyRules();
  for (const glob of ['.github/**', 'docs/adr/**', 'scripts/**', 'orchestrator/src/**', '**/.git/**', '**/CLAUDE.md', '**/package.json', '**/.mcp.json', '**/.env*', '**/*.pem', '**/Cargo.toml', '**/build.rs', '**/.npmrc']) {
    assert.ok(rules.includes(`Edit(${glob})`), `Edit(${glob})`);
    assert.ok(rules.includes(`Write(${glob})`), `Write(${glob})`);
  }
  for (const prefix of PROTECTED_PREFIXES) {
    assert.ok(rules.includes(`Edit(${prefix}**)`), prefix);
  }
  for (const name of PROTECTED_BASENAMES) {
    assert.ok(rules.includes(`Write(**/${name})`), name);
  }
});

test('the raw change list parses, with modes, and anything else is refused without being quoted', () => {
  const sha = 'a'.repeat(40);
  const entry = (old: string, now: string, status: string, path: string) => `:${old} ${now} ${sha} ${sha} ${status}\0${path}\0`;
  // Two commits as `git log --raw -z --format=` prints them: an empty token separates them.
  assert.deepEqual(parseRawDiff(`${entry('100644', '100644', 'M', 'src/a.ts')}\0${entry('000000', '120000', 'A', 'src/link')}`), [
    { path: 'src/a.ts', oldMode: '100644', newMode: '100644' },
    { path: 'src/link', oldMode: '000000', newMode: '120000' },
  ]);
  assert.deepEqual(parseRawDiff(''), []);
  for (const bad of ['SECRET-TEXT', `${entry('100644', '100644', 'M', 'a')}stray`, ':12 34 x', `:100644 100644 ${sha} ${sha} M\0`]) {
    assert.throws(
      () => parseRawDiff(bad),
      (error: unknown) => error instanceof RawDiffError && !error.message.includes('SECRET'),
      bad.slice(0, 20),
    );
  }
});

test('a symlink, a submodule or a file mode change is refused, before or after, and an executable file with it', () => {
  const plain = file('src/a.ts', '100644', '100644');
  assert.equal(checkBranchChanges([plain], [plain]).ok, true);
  for (const [oldMode, newMode] of [
    ['000000', '120000'], // a new symlink
    ['120000', '100644'], // a symlink replaced by a file
    ['120000', '000000'], // a symlink deleted
    ['000000', '160000'], // a new submodule
    ['000000', '100755'], // a new executable
    ['100644', '100755'], // the executable bit set
    ['100755', '100644'], // the executable bit cleared
    ['100644', '120000'], // a file replaced by a symlink
  ]) {
    const special = file('src/x', oldMode, newMode);
    for (const [net, history] of [[[special], [special]], [[plain], [plain, special]]] as const) {
      const verdict = checkBranchChanges(net, history);
      assert.deepEqual({ ok: verdict.ok, reason: verdict.ok ? undefined : verdict.reason }, { ok: false, reason: 'SpecialFile' }, `${oldMode} to ${newMode}`);
    }
  }
});

test('a protected path in any commit refuses the branch even when the net change is clean, and the verdict carries counts, not paths', () => {
  // A workflow added in one commit and removed in the next: the net change is clean, the push still publishes it.
  const verdict = checkBranchChanges([file('src/a.ts')], [file('.github/workflows/x.yml'), file('.github/workflows/x.yml', '100644', '000000'), file('src/a.ts')]);
  assert.deepEqual(verdict, { ok: false, reason: 'ProtectedPath', files: 1, protectedPaths: 1, specialFiles: 0 });
  assert.ok(!JSON.stringify(verdict).includes('.github'));
});

test('an empty diff and an unexpectedly large one fail, and the failure carries counts, not paths', () => {
  assert.deepEqual(checkBranchChanges([], []), { ok: false, reason: 'EmptyDiff', files: 0, protectedPaths: 0, specialFiles: 0 });
  const many = Array.from({ length: MAX_CHANGED_FILES }, (_, index) => file(`src/file-${index}.ts`));
  assert.equal(checkBranchChanges(many, many).ok, true, 'exactly the limit passes');
  const over = [...many, file('src/one-more.ts')];
  assert.deepEqual(checkBranchChanges(over, over), { ok: false, reason: 'DiffTooLarge', files: MAX_CHANGED_FILES + 1, protectedPaths: 0, specialFiles: 0 });
  // A protected path outranks size.
  const withProtected = [...many, file('.github/x.yml')];
  assert.equal((checkBranchChanges(withProtected, withProtected) as { reason: string }).reason, 'ProtectedPath');
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
  for (const type of ['InvalidInput', 'ProtectedPath', 'DiffTooLarge', 'EmptyDiff', 'SpecialFile', 'MalformedGitOutput', 'BranchMoved', 'PushRejected']) {
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
    assert.match(failure.message, /changes 2 file\(s\), 1 protected path\(s\) and 0 special file\(s\)/);
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

// ---- the range: every commit the push would publish -----------------------------------------------------------------

interface Commit {
  readonly files?: Record<string, string>;
  readonly remove?: string[];
  readonly empty?: boolean;
}

/** A branch off main with one commit per entry, in order. The branch is left, and main is checked out again. */
async function branchWithCommits(name: string, commits: Commit[]): Promise<string> {
  const { repo } = scenario;
  await git(repo, 'checkout', '-q', '-b', name, 'main');
  for (const commit of commits) {
    await writeIn(repo, commit.files ?? {});
    for (const path of commit.remove ?? []) {
      await rm(join(repo, path));
    }
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'work', ...(commit.empty === true ? ['--allow-empty'] : []));
  }
  const sha = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'checkout', '-q', 'main');
  return sha;
}

test('a protected change in the FIRST of several commits refuses the branch, however the later commits look', async () => {
  const protectedFiles: Record<string, string>[] = [{ '.github/workflows/x.yml': 'x\n' }, { 'package.json': '{}\n' }, { '.env': 'KEY=1\n' }, { 'scripts/run.sh': 'x\n' }];
  for (const [index, files] of protectedFiles.entries()) {
    for (const [offset, later] of [1, 2].entries()) {
      const name = `claude/${500 + index * 10 + offset}`;
      const commits: Commit[] = [{ files: { 'src/first.ts': 'x\n', ...files } }, ...Array.from({ length: later }, (_, n) => ({ files: { [`src/later-${n}.ts`]: 'x\n' } }))];
      const sha = await branchWithCommits(name, commits);
      const failure = await failureOf(guard(input(name, sha)));
      assert.equal(failure.type, 'ProtectedPath', `${Object.keys(files)[0]} first of ${later + 1} commits`);
      assert.equal(failure.nonRetryable, true);
    }
  }
});

test('a protected file added in one commit and removed in the next is still refused: the push publishes both commits', async () => {
  const sha = await branchWithCommits('claude/520', [{ files: { 'src/a.ts': 'a\n', '.env': 'SECRET=1\n' } }, { remove: ['.env'] }, { files: { 'src/b.ts': 'b\n' } }]);
  // The net change is clean (src/a.ts and src/b.ts), and only the range of commits sees the secret.
  assert.equal((await failureOf(guard(input('claude/520', sha)))).type, 'ProtectedPath');
});

test('a clean branch of several commits passes, and the net change is counted once even when the last commit is empty', async () => {
  const sha = await branchWithCommits('claude/530', [{ files: { 'src/a.ts': 'a\n' } }, { files: { 'src/a.ts': 'a2\n', 'src/b.ts': 'b\n' } }, { empty: true }]);
  assert.deepEqual(await guard(input('claude/530', sha)), { branch: 'claude/530', headSha: sha, files: 2 });
  // Pushed as it is: the same commits the guard read.
  assert.deepEqual(await push(input('claude/530', sha)), { branch: 'claude/530', headSha: sha });
});

test('a base that moved is not the session: a protected change on main does not refuse a branch, however the branch carries it', async () => {
  const sha = await branchWithCommits('claude/540', [{ files: { 'src/a.ts': 'a\n' } }, { files: { 'src/b.ts': 'b\n' } }]);
  // main moves on with a protected change, and the branch is not updated.
  await git(scenario.repo, 'checkout', '-q', 'main');
  await writeIn(scenario.repo, { '.github/workflows/new.yml': 'on: push\n', 'package.json': '{}\n' });
  await git(scenario.repo, 'add', '-A');
  await git(scenario.repo, 'commit', '-q', '-m', 'main moves on');
  await git(scenario.repo, 'push', '-q', 'origin', 'main');
  assert.deepEqual(await guard(input('claude/540', sha)), { branch: 'claude/540', headSha: sha, files: 2 }, 'not updated');

  // Rebased onto the new main.
  await git(scenario.repo, 'checkout', '-q', '-b', 'claude/541', 'claude/540');
  await git(scenario.repo, 'rebase', '-q', 'main');
  const rebased = await git(scenario.repo, 'rev-parse', 'HEAD');
  await git(scenario.repo, 'checkout', '-q', 'main');
  assert.notEqual(rebased, sha);
  assert.deepEqual(await guard(input('claude/541', rebased)), { branch: 'claude/541', headSha: rebased, files: 2 }, 'rebased');

  // Merged with the new main.
  await git(scenario.repo, 'checkout', '-q', '-b', 'claude/542', 'claude/540');
  await git(scenario.repo, 'merge', '-q', '--no-edit', 'main');
  const merged = await git(scenario.repo, 'rev-parse', 'HEAD');
  await git(scenario.repo, 'checkout', '-q', 'main');
  assert.deepEqual(await guard(input('claude/542', merged)), { branch: 'claude/542', headSha: merged, files: 2 }, 'merged');
});

test('a symlink, an executable file or a mode change in any commit is refused as a special file', async () => {
  const { repo } = scenario;
  await git(repo, 'checkout', '-q', '-b', 'claude/550', 'main');
  await writeIn(repo, { 'src/a.ts': 'a\n' });
  await execFileAsync('ln', ['-s', '../.github', join(repo, 'src', 'link')]);
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'link');
  const link = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'checkout', '-q', 'main');
  assert.equal((await failureOf(guard(input('claude/550', link)))).type, 'SpecialFile', 'a symlink');

  await git(repo, 'checkout', '-q', '-b', 'claude/551', 'main');
  await writeIn(repo, { 'src/run.ts': 'x\n' });
  await chmod(join(repo, 'src', 'run.ts'), 0o755);
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'exec');
  const exec = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'checkout', '-q', 'main');
  assert.equal((await failureOf(guard(input('claude/551', exec)))).type, 'SpecialFile', 'an executable file');

  await git(repo, 'checkout', '-q', '-b', 'claude/552', 'main');
  await chmod(join(repo, 'README.md'), 0o755);
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'mode');
  const mode = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'checkout', '-q', 'main');
  assert.equal((await failureOf(guard(input('claude/552', mode)))).type, 'SpecialFile', 'a mode change');

  await git(repo, 'checkout', '-q', '-b', 'claude/553', 'main');
  await git(repo, 'update-index', '--add', '--cacheinfo', `160000,${link},src/sub`);
  await git(repo, 'commit', '-q', '-m', 'gitlink');
  const gitlink = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'checkout', '-q', 'main');
  assert.equal((await failureOf(guard(input('claude/553', gitlink)))).type, 'SpecialFile', 'a submodule');
});

test('new protected entries are refused by the guard on a real branch too: a manifest, a build script and the orchestrator', async () => {
  for (const [index, path] of ['package.json', 'orchestrator/package.json', 'crates/x/build.rs', 'Cargo.toml', '.npmrc', '.mcp.json', 'orchestrator/src/workflows/issue.ts', '.husky/pre-commit'].entries()) {
    const name = `claude/${600 + index}`;
    const sha = await branchWithCommits(name, [{ files: { 'src/ok.ts': 'x\n', [path]: 'x\n' } }]);
    assert.equal((await failureOf(guard(input(name, sha)))).type, 'ProtectedPath', path);
  }
});
