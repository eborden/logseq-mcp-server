// The remote implementer step (#673, plan #643): `deleteRemoteBranch`, the fetch-then-guard `guardRemoteBranch`, the
// brief-building wrapper, and the workflow order (session, guard on the fetched tip, then the PR; a refusal deletes the branch).
// The branch activities run against real git in throwaway repos with a local bare `origin`; the session is a fake that pushes
// from a second clone. A real Temporal dev server runs the workflow tests. No GitHub, no model, no real remote session, no
// LogSeq. Every name is made up.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ApplicationFailure } from '@temporalio/activity';
import { WorkflowFailedError } from '@temporalio/client';
import type { Client } from '@temporalio/client';
import { MockActivityEnvironment } from '@temporalio/testing';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { createBranchActivities } from '../src/activities/branch.ts';
import { createRemoteImplementerActivities } from '../src/activities/implementer.ts';
import { createRemoteSessionActivities } from '../src/activities/remote-session.ts';
import type { RemoteGithub } from '../src/activities/remote-session.ts';
import { loadServerConfig } from '../src/config.ts';
import { NON_RETRYABLE_BRANCH_FAILURES, parseDeleteBranchInput } from '../src/branch-types.ts';
import { startDevServer } from '../src/dev-server.ts';
import { ISSUE_STOPPED_FAILURE, attemptForFlag, issueWorkflowId, parseIssueWorkflowInput, stopCommentKey } from '../src/issue-types.ts';
import { buildRunInput } from '../src/run-issue-input.ts';
import type { IssueRunResult } from '../src/issue-types.ts';
import type { RemoteSessionInput, RemoteSessionResult } from '../src/remote-session-policy.ts';
import type { IssueView } from '../src/types.ts';
import { freePort } from './support.ts';

const execFileAsync = promisify(execFile);
const WORKFLOWS_PATH = fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url));
const QUEUE = 'remote-implementer-fakes';
const PR_OFFSET = 1000;

// ---- real repositories -------------------------------------------------------------------------------------------

interface Repos {
  readonly dir: string;
  readonly origin: string;
  /** The worker's working copy: it fetches, guards and deletes. */
  readonly repo: string;
  /** What the remote session pushes from. */
  readonly session: string;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd });
  return stdout.trim();
}

async function makeRepos(): Promise<Repos> {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-remote-impl-'));
  const origin = join(dir, 'origin.git');
  const repo = join(dir, 'repo');
  const session = join(dir, 'session');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await execFileAsync('git', ['clone', '-q', origin, repo]);
  await git(repo, 'checkout', '-q', '-b', 'main');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'README.md'), 'x\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'init');
  await git(repo, 'push', '-q', 'origin', 'main');
  await execFileAsync('git', ['clone', '-q', origin, session]);
  return { dir, origin, repo, session };
}

/** What the fake session does: commits `files` on a new branch off main in its own clone and pushes it. Returns the tip. */
async function sessionPush(repos: Repos, branch: string, files: Record<string, string>): Promise<string> {
  const { session } = repos;
  await git(session, 'fetch', '-q', 'origin');
  await git(session, 'checkout', '-q', '-B', branch, 'origin/main');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(session, path)), { recursive: true });
    await writeFile(join(session, path), content);
  }
  await git(session, 'add', '-A');
  await git(session, 'commit', '-q', '-m', 'work', '--allow-empty');
  await git(session, 'push', '-q', '-f', 'origin', branch);
  return await git(session, 'rev-parse', 'HEAD');
}

async function remoteTip(repos: Repos, branch: string): Promise<string> {
  const out = await git(repos.repo, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
  return out.split('\t')[0] ?? '';
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
  return assert.fail('the activity should have failed');
}

let repos: Repos;
beforeEach(async () => {
  repos = await makeRepos();
});
afterEach(async () => {
  await rm(repos.dir, { recursive: true, force: true });
});

const branchActivities = createBranchActivities();
const run = <T>(fn: (raw: unknown) => Promise<T>, raw: unknown): Promise<T> => new MockActivityEnvironment().run(fn, raw);
const guardRemote = (raw: unknown) => run(branchActivities.guardRemoteBranch, raw);
const deleteRemote = (raw: unknown) => run(branchActivities.deleteRemoteBranch, raw);
const guardInput = (sha: string, branch = 'claude/21') => ({ repoDir: repos.repo, branch, headSha: sha, base: 'main' });

// ---- the activities ----------------------------------------------------------------------------------------------

test('guardRemoteBranch fetches the pushed branch and passes an ordinary change, with no local branch needed', async () => {
  const sha = await sessionPush(repos, 'claude/21', { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  assert.deepEqual(await guardRemote(guardInput(sha)), { branch: 'claude/21', headSha: sha, files: 2 });
  assert.equal(await git(repos.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/claude/21').catch(() => ''), '', 'no local branch was made');
});

test('guardRemoteBranch refuses a protected path, even one a later commit undoes, and deletes nothing itself', async () => {
  await sessionPush(repos, 'claude/22', { '.github/workflows/ci.yml': 'on: push\n' });
  await writeFile(join(repos.session, 'src-note.txt'), 'n\n');
  await git(repos.session, 'rm', '-q', '-r', '.github');
  await git(repos.session, 'add', '-A');
  await git(repos.session, 'commit', '-q', '-m', 'undo');
  await git(repos.session, 'push', '-q', 'origin', 'claude/22');
  const sha = await git(repos.session, 'rev-parse', 'HEAD');
  const failure = await failureOf(guardRemote(guardInput(sha, 'claude/22')));
  assert.equal(failure.type, 'ProtectedPath');
  assert.match(failure.message, /^the branch changes \d+ file\(s\), \d+ protected path\(s\) and \d+ special file\(s\) in its commits$/);
  assert.equal(await remoteTip(repos, 'claude/22'), sha, 'the guard only reads; the workflow deletes');
});

test('guardRemoteBranch refuses a tip that is not the one the session reported', async () => {
  const first = await sessionPush(repos, 'claude/23', { 'src/a.ts': 'a\n' });
  await sessionPush(repos, 'claude/23', { 'src/a.ts': 'a\n', 'src/more.ts': 'm\n' });
  const failure = await failureOf(guardRemote(guardInput(first, 'claude/23')));
  assert.equal(failure.type, 'BranchMoved');
});

test('guardRemoteBranch refuses a branch that moved while the guard ran', async () => {
  const sha = await sessionPush(repos, 'claude/24', { 'src/a.ts': 'a\n' });
  // A git wrapper that, when the diff of the guard runs, makes the session push one more commit to the remote branch.
  const wrapper = join(repos.dir, 'git-moving');
  const push = join(repos.dir, 'push-more.sh');
  await writeFile(
    push,
    `#!/bin/sh\ncd '${repos.session}' && echo more > src/late.ts && git add -A && git -c user.name=T -c user.email=t@example.invalid commit -q -m late && git push -q -f origin claude/24\n`,
  );
  await chmod(push, 0o755);
  await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = "diff" ] && [ ! -e '${repos.dir}/pushed' ]; then : > '${repos.dir}/pushed'; '${push}'; fi\nexec git "$@"\n`);
  await chmod(wrapper, 0o755);
  const moving = createBranchActivities({ gitBin: wrapper });
  const failure = await failureOf(run(moving.guardRemoteBranch, guardInput(sha, 'claude/24')));
  assert.equal(failure.type, 'BranchMoved');
  assert.notEqual(await remoteTip(repos, 'claude/24'), sha);
});

test('guardRemoteBranch says BranchMissing for a branch that is not on the remote', async () => {
  const failure = await failureOf(guardRemote(guardInput('a'.repeat(40), 'claude/25')));
  assert.equal(failure.type, 'BranchMissing');
});

test('guardRemoteBranch uses fixed argv with hooks off and parses the branch first', async () => {
  const sha = await sessionPush(repos, 'claude/26', { 'src/a.ts': 'a\n' });
  const log = join(repos.dir, 'argv.log');
  const wrapper = join(repos.dir, 'git-log');
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\037' "$@" >> '${log}'\nprintf '\\n' >> '${log}'\nexec git "$@"\n`);
  await chmod(wrapper, 0o755);
  const logged = createBranchActivities({ gitBin: wrapper });
  await run(logged.guardRemoteBranch, guardInput(sha, 'claude/26'));
  const lines = (await readFile(log, 'utf8')).split('\n').filter((line) => line !== '').map((line) => line.split('\u001f').slice(0, -1));
  assert.deepEqual(lines[0], [
    '-c',
    'core.hooksPath=/dev/null',
    'fetch',
    '--no-tags',
    '--no-recurse-submodules',
    'origin',
    '+refs/heads/claude/26:refs/remotes/origin/claude/26',
    '+refs/heads/main:refs/remotes/origin/main',
  ]);
  const before = lines.length;
  for (const bad of ['main', 'claude/26:main', '--delete', 'claude/0', 'claude/26 x']) {
    assert.equal((await failureOf(run(logged.guardRemoteBranch, guardInput(sha, bad)))).type, 'InvalidInput', bad);
  }
  assert.equal((await readFile(log, 'utf8')).split('\n').filter((line) => line !== '').length, before, 'a refused name never reaches git');
});

test('deleteRemoteBranch deletes with the fixed command, and an already-deleted branch is success', async () => {
  await sessionPush(repos, 'claude/27', { 'src/a.ts': 'a\n' });
  const log = join(repos.dir, 'argv.log');
  const wrapper = join(repos.dir, 'git-log');
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\037' "$@" >> '${log}'\nprintf '\\n' >> '${log}'\nexec git "$@"\n`);
  await chmod(wrapper, 0o755);
  const logged = createBranchActivities({ gitBin: wrapper });
  const del = (raw: unknown) => run(logged.deleteRemoteBranch, raw);
  assert.deepEqual(await del({ repoDir: repos.repo, branch: 'claude/27' }), { branch: 'claude/27', deleted: true });
  assert.equal(await remoteTip(repos, 'claude/27'), '');
  assert.deepEqual(await del({ repoDir: repos.repo, branch: 'claude/27' }), { branch: 'claude/27', deleted: false }, 'the second delete finds it gone and succeeds');
  assert.deepEqual(await del({ repoDir: repos.repo, branch: 'claude/28' }), { branch: 'claude/28', deleted: false }, 'a branch that never existed is success too');
  const lines = (await readFile(log, 'utf8')).split('\n').filter((line) => line !== '').map((line) => line.split('\u001f').slice(0, -1));
  const pushes = lines.filter((line) => line.includes('push'));
  assert.deepEqual(pushes, [['-c', 'core.hooksPath=/dev/null', 'push', 'origin', '--delete', 'claude/27']], 'exactly one delete, with fixed argv');
});

test('deleteRemoteBranch refuses anything but claude/<number>, before git runs', async () => {
  for (const branch of ['main', 'claude/', 'claude/1/../../main', ':main', '--all', 'claude/1-slug', 'refs/heads/claude/1']) {
    assert.equal((await failureOf(deleteRemote({ repoDir: repos.repo, branch }))).type, 'InvalidInput', branch);
  }
  assert.equal((await failureOf(deleteRemote({ repoDir: 'relative', branch: 'claude/1' }))).type, 'InvalidInput');
  assert.throws(() => parseDeleteBranchInput(null), /input must be an object/);
  assert.ok(await remoteTip(repos, 'main'), 'main is untouched');
});

test('the new failure types are non-retryable', () => {
  for (const type of ['DeleteRejected', 'BranchMissing', 'BranchMoved']) {
    assert.ok(NON_RETRYABLE_BRANCH_FAILURES.includes(type), type);
  }
});

// ---- the brief-building wrapper --------------------------------------------------------------------------------

const issueView = (number: number, state: 'open' | 'closed' = 'open'): IssueView => ({
  number,
  title: 'Add a thing for project atlas',
  state,
  author: 'eborden',
  body: 'Alice asked for the thing.',
  labels: [],
  comments: [],
  droppedUntrustedComments: 0,
});
const WRAPPER_INPUT = { issueNumber: 30, repoDir: '/work/repo', worktreeDir: '/work/wt', base: 'main' };

test('the wrapper builds the brief inside the activity and starts runRemoteSession as the implementer with the attempt', async () => {
  const seen: RemoteSessionInput[] = [];
  const { runRemoteImplementerSession } = createRemoteImplementerActivities({
    readIssue: async (n) => issueView(n),
    runRemoteSession: async (input) => {
      seen.push(input);
      return { outcome: 'finished', sessionId: 'session_01AAA', headSha: 'a'.repeat(40) };
    },
    repo: 'eborden/logseq-mcp-server',
  });
  const result = await run(runRemoteImplementerSession, { ...WRAPPER_INPUT, attempt: 2 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.role, 'implementer');
  assert.equal(seen[0]?.issue, 30);
  assert.equal(seen[0]?.branch, 'claude/30');
  assert.equal(seen[0]?.attempt, 2);
  assert.equal('headSha' in (seen[0] ?? {}), false);
  assert.ok(seen[0]?.brief.includes('Alice asked for the thing.'), 'the issue text is in the brief');
  assert.ok(!JSON.stringify(result).includes('Alice'), 'and not in the result that goes into the history');
  await run(runRemoteImplementerSession, WRAPPER_INPUT);
  assert.equal('attempt' in (seen[1] ?? {}), false, 'no attempt in, none out: the default key');
});

test('the wrapper refuses a closed issue and a bad input before any session', async () => {
  let fired = 0;
  const { runRemoteImplementerSession } = createRemoteImplementerActivities({
    readIssue: async (n) => issueView(n, n === 31 ? 'closed' : 'open'),
    runRemoteSession: async () => {
      fired += 1;
      return { outcome: 'finished' };
    },
    repo: 'eborden/logseq-mcp-server',
  });
  assert.equal((await failureOf(run(runRemoteImplementerSession, { ...WRAPPER_INPUT, issueNumber: 31 }))).type, 'InvalidState');
  assert.equal((await failureOf(run(runRemoteImplementerSession, { ...WRAPPER_INPUT, base: '--x' }))).type, 'InvalidInput');
  assert.equal(fired, 0);
});

// ---- the run's first attempt number ------------------------------------------------------------------------------

test('the run input takes an optional attempt, a positive whole number, and --attempt builds it', () => {
  const base = { issueNumber: 5, repoDir: '/work/repo', worktreeDir: '/work/wt', base: 'main' };
  assert.equal('attempt' in parseIssueWorkflowInput(base), false, 'absent stays absent');
  assert.equal(parseIssueWorkflowInput({ ...base, attempt: 2 }).attempt, 2);
  for (const bad of [0, -1, 1.5, '2', null, 100, Number.NaN]) {
    assert.throws(() => parseIssueWorkflowInput({ ...base, attempt: bad }), /attempt must be a whole number/, String(bad));
  }
  assert.deepEqual(attemptForFlag(undefined), {});
  assert.deepEqual(attemptForFlag('3'), { attempt: 3 });
  for (const bad of ['', '0', '-1', '1.5', 'x', '100', '02']) {
    assert.throws(() => attemptForFlag(bad), /--attempt must be a whole number/, bad);
  }
  const flags = { issue: '5', base: 'main', repoDir: '/work/repo', worktreeDir: undefined, hostIntegration: false, executor: 'remote' };
  assert.equal('attempt' in buildRunInput(flags), false);
  assert.equal(buildRunInput({ ...flags, attempt: '2' }).attempt, 2);
  assert.throws(() => buildRunInput({ ...flags, attempt: 'two' }), /--attempt must be a whole number/);
});

test('a run started at attempt 2 fires a fresh session under a new marker key; the default keeps the old key and re-attaches', async () => {
  const fired: string[] = [];
  const clock = { t: 1_000_000 };
  const github: RemoteGithub = {
    openPrs: async () => [],
    claudeBranches: async () => [],
    branchTip: async () => 'b'.repeat(40),
    checksPending: async () => false,
    reviewedOnHead: async () => false,
  };
  const remote = createRemoteSessionActivities({
    repoDir: repos.repo,
    routines: { implementer: 'trig_i', reviewer: 'trig_r', fixer: 'trig_f' },
    fire: {
      fire: async () => {
        fired.push('fire');
        return { sessionId: `session_0${fired.length}`, url: 'https://claude.ai/code/x' };
      },
    },
    github,
    limits: { capMs: 600_000, pollIntervalMs: 60_000, settleMs: 120_000, orphanPollMs: 300_000, heartbeatIntervalMs: 50, fireAttempts: 3, fireBackoffMs: 1_000, retryAfterMaxMs: 60_000 },
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
  });
  const { runRemoteImplementerSession } = createRemoteImplementerActivities({ readIssue: async (n) => issueView(n), runRemoteSession: remote.runRemoteSession, repo: 'eborden/logseq-mcp-server' });
  const keys = async () => (await git(repos.repo, 'config', '--local', '--get-regexp', '^orchestratorremote\\.').catch(() => '')).split('\n').map((line) => line.split(' ')[0]);

  const first = await run(runRemoteImplementerSession, WRAPPER_INPUT);
  assert.equal(first.sessionId, 'session_01');
  assert.deepEqual(await keys(), ['orchestratorremote.30-implementer-none.state']);
  const again = await run(runRemoteImplementerSession, WRAPPER_INPUT);
  assert.equal(fired.length, 1, 'the default attempt re-attaches to the old key');
  assert.equal(again.sessionId, 'session_01');

  const next = await run(runRemoteImplementerSession, { ...WRAPPER_INPUT, attempt: 2 });
  assert.equal(fired.length, 2, 'attempt 2 fires fresh');
  assert.equal(next.sessionId, 'session_02');
  assert.deepEqual((await keys()).sort(), ['orchestratorremote.30-implementer-none-a2.state', 'orchestratorremote.30-implementer-none.state']);
});

test('the workflow starts the remote implementer at the run attempt and counts on from there', { timeout: 120_000 }, async () => {
  const dead = await start(() => async () => ({ outcome: 'timed_out' }), { attempt: 3 });
  const cause = await failure(dead.issue, dead.started);
  assert.deepEqual(cause.details?.slice(0, 2), ['session', 'RemoteSessionTimedOut']);
  assert.deepEqual(dead.world.attempts, [3, 4], 'the first call is the run attempt, the next call is one more');
  await finish(dead.world);
});

// ---- the workflow ------------------------------------------------------------------------------------------------

type SessionScript = (repos: Repos, input: { issueNumber: number; attempt: number }) => Promise<RemoteSessionResult>;

class World {
  readonly calls: Record<string, number> = {};
  readonly comments = new Map<string, string>();
  readonly attempts: number[] = [];
  /** Makes the session push again right after the PR opens: a late push between the guard and the PR. */
  moveOnOpen: (() => Promise<void>) | undefined;
  issueStatus: string | undefined = 'Ready';
  prStatus: string | undefined;
  constructor(
    readonly repos: Repos,
    readonly script: SessionScript,
  ) {}
  called(name: string): number {
    return this.calls[name] ?? 0;
  }
  hit(name: string): void {
    this.calls[name] = this.called(name) + 1;
  }
}

const worlds = new Map<number, World>();
const worldOf = (issue: number): World => {
  const found = worlds.get(issue);
  assert.ok(found, `no world for issue ${issue}`);
  return found;
};
let nextIssue = 700;

function fakeActivities() {
  const real = createBranchActivities();
  const target = (t: { kind: 'issue' | 'pr'; number: number }) => ({ w: worldOf(t.kind === 'pr' ? t.number - PR_OFFSET : t.number), kind: t.kind });
  return {
    checkIssue: async (issue: number) => ({ number: issue, open: true, trustedComments: 1, droppedUntrustedComments: 0 }),
    claimIssue: async (issue: number) => {
      const w = worldOf(issue);
      w.hit('claimIssue');
      w.issueStatus = 'In progress';
      return { claimed: true, reason: 'claimed' as const, proceed: true };
    },
    runImplementerSession: async (raw: { issueNumber: number }) => {
      worldOf(raw.issueNumber).hit('runImplementerSession');
      // Only a local run may ask for one: a remote run that did would be a failed test, shown by the call count.
      return { branch: `claude/${raw.issueNumber}`, headSha: 'a'.repeat(40), exitStatus: 'success' as const };
    },
    runRemoteImplementerSession: async (raw: { issueNumber: number; attempt: number }) => {
      const w = worldOf(raw.issueNumber);
      w.hit('runRemoteImplementerSession');
      w.attempts.push(raw.attempt);
      return await w.script(w.repos, raw);
    },
    // The real guard and delete, aimed at the issue's own throwaway repo (the workflow passes a placeholder repoDir).
    guardRemoteBranch: async (raw: { branch: string; headSha: string; base: string }) => {
      const issue = Number(/^claude\/(\d+)$/.exec(raw.branch)?.[1]);
      const w = worldOf(issue);
      w.hit('guardRemoteBranch');
      return await real.guardRemoteBranch({ ...raw, repoDir: w.repos.repo });
    },
    deleteRemoteBranch: async (raw: { branch: string }) => {
      const issue = Number(/^claude\/(\d+)$/.exec(raw.branch)?.[1]);
      const w = worldOf(issue);
      w.hit('deleteRemoteBranch');
      return await real.deleteRemoteBranch({ ...raw, repoDir: w.repos.repo });
    },
    guardBranch: async (raw: { branch: string; headSha: string }) => {
      worldOf(Number(/^claude\/(\d+)$/.exec(raw.branch)?.[1])).hit('guardBranch');
      return { branch: raw.branch, headSha: raw.headSha, files: 1 };
    },
    pushBranch: async (raw: { branch: string; headSha: string }) => {
      worldOf(Number(/^claude\/(\d+)$/.exec(raw.branch)?.[1])).hit('pushBranch');
      return { branch: raw.branch, headSha: raw.headSha };
    },
    openPr: async (input: { head: string }) => {
      const issue = Number(/^claude\/(\d+)$/.exec(input.head)?.[1]);
      const w = worldOf(issue);
      w.hit('openPr');
      await w.moveOnOpen?.();
      return { number: issue + PR_OFFSET, url: `https://github.com/eborden/logseq-mcp-server/pull/${issue + PR_OFFSET}`, created: true };
    },
    getPrState: async (pr: number) => {
      const w = worldOf(pr - PR_OFFSET);
      return { state: 'open' as const, merged: false, headSha: await remoteTip(w.repos, `claude/${pr - PR_OFFSET}`) };
    },
    addToBoard: async (t: { kind: 'issue' | 'pr'; number: number }) => {
      const { w } = target(t);
      w.prStatus = 'Backlog';
      return { kind: t.kind, number: t.number, itemId: 'PVTI_x', added: true, status: 'Backlog' };
    },
    getBoardStatus: async (t: { kind: 'issue' | 'pr'; number: number }) => {
      const { w, kind } = target(t);
      const status = kind === 'pr' ? w.prStatus : w.issueStatus;
      return { kind, number: t.number, onBoard: status !== undefined, status: status ?? null };
    },
    setStatus: async (t: { kind: 'issue' | 'pr'; number: number }, status: string) => {
      const { w, kind } = target(t);
      if (kind === 'pr') {
        w.prStatus = status;
      } else {
        w.issueStatus = status;
      }
      return { changed: true, status };
    },
    runReviewerSession: async (input: { issue: number }) => {
      worldOf(input.issue).hit('runReviewerSession');
      return { findings: 0, acceptedThreadIds: [] };
    },
    commentIssue: async (input: { issue: number; key: string; body: string }) => {
      const w = worldOf(input.issue);
      const posted = !w.comments.has(input.key);
      w.comments.set(input.key, input.body);
      return { commentId: 1, posted };
    },
  };
}

let env: TestWorkflowEnvironment;
let client: Client;
let running: Promise<void>;
let worker: Worker;

before(async () => {
  env = await startDevServer({ port: await freePort(), cliPath: loadServerConfig(process.env).cliPath });
  client = env.client;
  worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: 'default',
    taskQueue: QUEUE,
    workflowBundle: await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH }),
    activities: fakeActivities(),
    maxCachedWorkflows: 0,
  });
  running = worker.run();
});

after(async () => {
  worker?.shutdown();
  await Promise.allSettled([running]);
  await env?.teardown();
});

const reported = (sha: string): RemoteSessionResult => ({ outcome: 'finished', sessionId: 'session_01AAA', headSha: sha });

async function start(script: (issue: number) => SessionScript, extra: Record<string, unknown> = {}): Promise<{ issue: number; world: World; started: Promise<unknown> }> {
  nextIssue += 1;
  const issue = nextIssue;
  const world = new World(await makeRepos(), script(issue));
  worlds.set(issue, world);
  const input = { issueNumber: issue, repoDir: '/work/repo', worktreeDir: `/work/repo/.claude/worktrees/issue-${issue}`, base: 'main', awaitDecision: false, executor: 'remote', ...extra };
  const started = client.workflow.start('issueWorkflow', { taskQueue: QUEUE, workflowId: issueWorkflowId(issue), args: [input], workflowExecutionTimeout: '2 minutes' });
  return { issue, world, started };
}

async function failure(issue: number, started: Promise<unknown>): Promise<ApplicationFailure> {
  await started;
  try {
    await client.workflow.getHandle(issueWorkflowId(issue)).result();
  } catch (error) {
    assert.ok(error instanceof WorkflowFailedError, 'the run ends as a failed workflow');
    assert.ok(error.cause instanceof ApplicationFailure);
    return error.cause;
  }
  return assert.fail('the run should have failed');
}

async function finish(world: World): Promise<void> {
  await rm(world.repos.dir, { recursive: true, force: true });
}

// The one expected end of a run that gets past the implementer: the reviewer is not remote yet (a later task), so the run
// stops at its first step, after the PR is open and In review.
const STOPS_AT_REVIEWER = 'review_session';

test('a clean remote branch is guarded on the fetched tip, then the PR opens; no local session, no push', { timeout: 120_000 }, async () => {
  const { issue, world, started } = await start((n) => async (r) => reported(await sessionPush(r, `claude/${n}`, { 'src/a.ts': 'a\n' })));
  const cause = await failure(issue, started);
  assert.equal(cause.type, ISSUE_STOPPED_FAILURE);
  assert.equal(cause.details?.[0], STOPS_AT_REVIEWER);
  assert.equal(world.called('runImplementerSession'), 0);
  assert.equal(world.called('guardRemoteBranch'), 1, 'the guard ran on the fetched branch');
  assert.equal(world.called('guardBranch'), 0, 'not the local guard');
  assert.equal(world.called('pushBranch'), 0, 'there is no push on this path');
  assert.equal(world.called('deleteRemoteBranch'), 0);
  assert.equal(world.called('openPr'), 1);
  assert.deepEqual(world.attempts, [1], 'the first call is attempt 1');
  assert.ok(await remoteTip(world.repos, `claude/${issue}`), 'the branch stays');
  await finish(world);
});

test('a remote branch that touches a protected path never gets a PR, is deleted, and the run stops with counts only', { timeout: 120_000 }, async () => {
  const { issue, world, started } = await start((n) => async (r) => reported(await sessionPush(r, `claude/${n}`, { '.github/workflows/evil.yml': 'on: push\n', 'src/a.ts': 'a\n' })));
  const cause = await failure(issue, started);
  assert.equal(cause.type, ISSUE_STOPPED_FAILURE);
  assert.deepEqual(cause.details?.slice(0, 2), ['guard', 'ProtectedPath']);
  assert.equal(world.called('openPr'), 0, 'no PR on a refused branch');
  assert.equal(world.called('deleteRemoteBranch'), 1);
  assert.equal(await remoteTip(world.repos, `claude/${issue}`), '', 'the branch is gone from the remote');
  assert.deepEqual([...world.comments.keys()], [stopCommentKey('guard', 'ProtectedPath')], 'one keyed comment');
  const body = [...world.comments.values()][0] ?? '';
  assert.match(body, /2 file\(s\), 1 protected path\(s\) and 0 special file\(s\)/);
  assert.ok(!body.includes('evil') && !body.includes('.github'), 'no path in the comment');
  assert.equal(world.called('runReviewerSession'), 0);
  await finish(world);
});

test('a branch that moves between the report and the guard opens no PR on an unguarded sha, and is not deleted', { timeout: 120_000 }, async () => {
  const { issue, world, started } = await start((n) => async (r) => {
    const reportedSha = await sessionPush(r, `claude/${n}`, { 'src/a.ts': 'a\n' });
    await sessionPush(r, `claude/${n}`, { 'src/a.ts': 'a\n', '.github/workflows/late.yml': 'on: push\n' });
    return reported(reportedSha);
  });
  const cause = await failure(issue, started);
  assert.deepEqual(cause.details?.slice(0, 2), ['guard', 'BranchMoved']);
  assert.equal(world.called('openPr'), 0);
  assert.equal(world.called('deleteRemoteBranch'), 0, 'a moved branch is left for a person');
  assert.ok(await remoteTip(world.repos, `claude/${issue}`));
  await finish(world);
});

test('a branch that moves after the guard and before the PR is caught when the PR head is read back, and is not deleted', { timeout: 120_000 }, async () => {
  const { issue, world, started } = await start((n) => async (r) => reported(await sessionPush(r, `claude/${n}`, { 'src/a.ts': 'a\n' })));
  world.moveOnOpen = async () => {
    await sessionPush(world.repos, `claude/${issue}`, { 'src/a.ts': 'a\n', 'src/late.ts': 'late\n' });
  };
  const cause = await failure(issue, started);
  assert.deepEqual(cause.details?.slice(0, 2), ['guard', 'BranchMoved']);
  assert.equal(world.called('guardRemoteBranch'), 1);
  assert.equal(world.called('openPr'), 1);
  assert.equal(world.called('deleteRemoteBranch'), 0);
  assert.equal(world.called('runReviewerSession'), 0, 'the run does not go on to review an unchecked head');
  const body = [...world.comments.values()][0] ?? '';
  assert.match(body, /pull request #\d+ is on a commit that was not checked/);
  await finish(world);
});

test('unreadable git output (MalformedGitOutput) is a fault in the reading, so the branch is not deleted', async () => {
  const { GUARD_REFUSALS } = await import('../src/workflows/remote-implementer.ts');
  assert.deepEqual([...GUARD_REFUSALS].sort(), ['DiffTooLarge', 'EmptyDiff', 'ProtectedPath', 'SpecialFile']);
});

test('a session that ended with no push gets a second attempt, which is attempt 2; a second miss stops', { timeout: 120_000 }, async () => {
  const dead = await start(() => async () => ({ outcome: 'timed_out' }));
  const cause = await failure(dead.issue, dead.started);
  assert.deepEqual(cause.details?.slice(0, 2), ['session', 'RemoteSessionTimedOut']);
  assert.deepEqual(dead.world.attempts, [1, 2], 'one more attempt, numbered 2, then it stops');
  assert.equal(dead.world.called('openPr'), 0);
  assert.equal(dead.world.called('guardRemoteBranch'), 0);
  await finish(dead.world);

  const recovers = await start((n) => async (r, input) => (input.attempt === 1 ? { outcome: 'timed_out' } : reported(await sessionPush(r, `claude/${n}`, { 'src/a.ts': 'a\n' }))));
  const next = await failure(recovers.issue, recovers.started);
  assert.equal(next.details?.[0], STOPS_AT_REVIEWER);
  assert.deepEqual(recovers.world.attempts, [1, 2]);
  assert.equal(recovers.world.called('openPr'), 1);
  await finish(recovers.world);
});

test('a claim, a failed launch and a push that never settled stop the run without a second attempt or a guard', { timeout: 120_000 }, async () => {
  const cases: [string, RemoteSessionResult][] = [
    ['RemoteSessionClaimed', { outcome: 'failed', claim: 'open_pr' }],
    ['RemoteLaunchFailed', { outcome: 'failed', failure: 'rate_limited' }],
    ['RemoteSessionTimedOut', { outcome: 'timed_out', headSha: 'c'.repeat(40) }],
    ['RemoteSessionNoHead', { outcome: 'finished' }],
  ];
  for (const [reason, answer] of cases) {
    const { issue, world, started } = await start(() => async () => answer);
    const cause = await failure(issue, started);
    assert.deepEqual(cause.details?.slice(0, 2), ['session', reason], reason);
    assert.deepEqual(world.attempts, [1], reason);
    assert.equal(world.called('guardRemoteBranch'), 0, reason);
    assert.equal(world.called('openPr'), 0, reason);
    await finish(world);
  }
});

test('an empty remote branch is refused and deleted like any other refusal', { timeout: 120_000 }, async () => {
  const { issue, world, started } = await start((n) => async (r) => reported(await sessionPush(r, `claude/${n}`, {})));
  const cause = await failure(issue, started);
  assert.deepEqual(cause.details?.slice(0, 2), ['guard', 'EmptyDiff']);
  assert.equal(world.called('deleteRemoteBranch'), 1);
  assert.equal(await remoteTip(world.repos, `claude/${issue}`), '');
  assert.equal(world.called('openPr'), 0);
  await finish(world);
});

test('with executor local the step is v1: a local session, guardBranch then pushBranch, and no remote activity', { timeout: 120_000 }, async () => {
  const { issue, world, started } = await start(() => async () => ({ outcome: 'failed' }), { executor: 'local' });
  const cause = await failure(issue, started);
  // This fake world has no review activities, so the run ends later, past the PR; what matters is where it did not stop.
  assert.ok(!['session', 'guard', 'push', 'open_pr'].includes(String(cause.details?.[0])), String(cause.details?.[0]));
  assert.equal(world.called('runImplementerSession'), 1);
  assert.equal(world.called('guardBranch'), 1);
  assert.equal(world.called('pushBranch'), 1);
  assert.equal(world.called('openPr'), 1);
  assert.equal(world.called('runRemoteImplementerSession'), 0);
  assert.equal(world.called('guardRemoteBranch'), 0);
  assert.equal(world.called('deleteRemoteBranch'), 0);
  await finish(world);
});

test('the issue text never reaches the workflow history on the remote path', { timeout: 120_000 }, async () => {
  const { issue, world, started } = await start((n) => async (r) => reported(await sessionPush(r, `claude/${n}`, { 'src/a.ts': 'a\n' })));
  await failure(issue, started);
  const history = JSON.stringify((await client.workflow.getHandle(issueWorkflowId(issue)).fetchHistory()).events);
  assert.ok(!history.includes('brief'), 'no brief in the history');
  await finish(world);
});
