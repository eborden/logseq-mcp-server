// IssueWorkflow against a real Temporal server (an in-memory dev server on a free port, like the crash test) and no
// real service: layer 1 uses fake activities with counters, so each side effect can be counted and each result lost;
// layer 2 runs the real activity code against the fake `gh` and the fake `claude`. No test calls GitHub or the model.
// Every name is made up (issue 123, Alice, "project atlas").
//
// The workers run with `maxCachedWorkflows: 0`, so every workflow task replays the whole history: a workflow change
// that is not deterministic, or that repeats a step on replay, fails here. `Worker.runReplayHistory` checks a
// finished run's history against the current code too.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ApplicationFailure } from '@temporalio/activity';
import { WorkflowFailedError } from '@temporalio/client';
import type { Client } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import type { WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { createClaudeSessionActivities } from '../src/activities/claude-session.ts';
import { createGithubActivities } from '../src/activities/github.ts';
import { createImplementerActivities } from '../src/activities/implementer.ts';
import { loadClaudeConfig, loadServerConfig } from '../src/config.ts';
import { startDevServer } from '../src/dev-server.ts';
import { startIssueRun } from '../src/issue-client.ts';
import { ISSUE_STOPPED_FAILURE, ISSUE_WORKFLOW_NAME, issueBranch, issueWorkflowId } from '../src/issue-types.ts';
import type { IssueRunResult, IssueWorkflowInput } from '../src/issue-types.ts';
import type { BoardItemRef, BoardStatus, SessionExitStatus } from '../src/types.ts';
import { freePort } from './support.ts';
import { createFake, emptyState, rawComment, rawIssue } from './github-support.ts';

const execFileAsync = promisify(execFile);
const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.sh', import.meta.url));
const WORKFLOWS_PATH = fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url));
const HEAD_SHA = 'a'.repeat(40);

let env: TestWorkflowEnvironment;
let client: Client;
let bundle: WorkflowBundleWithSourceMap;
let dir: string;
const workers: { worker: Worker; running: Promise<void> }[] = [];

async function startWorker(taskQueue: string, activities: object): Promise<void> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: 'default',
    taskQueue,
    workflowBundle: bundle,
    activities,
    // Every workflow task replays the whole history: determinism and "a step is not repeated" are tested all the time.
    maxCachedWorkflows: 0,
  });
  workers.push({ worker, running: worker.run() });
}

before(async () => {
  env = await startDevServer({ port: await freePort(), cliPath: loadServerConfig(process.env).cliPath });
  client = env.client;
  bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH });
  dir = await mkdtemp(join(tmpdir(), 'orchestrator-issue-wf-'));
});

after(async () => {
  for (const { worker } of workers) {
    worker.shutdown();
  }
  await Promise.allSettled(workers.map(({ running }) => running));
  await env?.teardown();
  delete process.env['FAKE_CLAUDE_MODE'];
  delete process.env['FAKE_CLAUDE_LOG'];
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- layer 1: fake activities with counters ------------------------------------------------------------------

type LostStep = 'claimIssue' | 'runImplementerSession' | 'openPr' | 'addToBoard' | 'setStatusPr' | 'setStatusIssue';

class World {
  issueOpen = true;
  /** The issue's Status on the board, and the PR's (`undefined`: not on the board). */
  issueStatus: BoardStatus | undefined = 'Ready';
  prStatus: BoardStatus | undefined;
  /** The PR's Status the board shows to a read, whatever was written (a board that does not show the move). */
  stalePrStatus: BoardStatus | undefined;
  prOpened = false;
  sessionStarted = false;
  sessionExit: SessionExitStatus = 'success';
  /** The failure type the session activity ends with, non-retryable, as `SessionTimeout` does. */
  sessionFails: string | undefined;
  checkFails: string | undefined;
  claimProceeds = true;
  /** Each side effect, counted once however many attempts ran. */
  readonly counters = { claims: 0, sessions: 0, prs: 0, adds: 0, prWrites: 0, issueWrites: 0, comments: 0 };
  readonly attempts: Record<string, number> = {};
  /** The order in which the side effects first happened. */
  readonly order: string[] = [];
  readonly commentKeys = new Map<string, string>();
  /** Steps that do their side effect and then die before the result is recorded, once (a worker crash). */
  readonly loseOnce = new Set<LostStep>();
  /** A gate a test opens to let the session finish, so a second start can be tried while one run is open. */
  sessionGate: Promise<void> | undefined;
  sessionEntered: (() => void) | undefined;

  attempt(name: string): void {
    this.attempts[name] = (this.attempts[name] ?? 0) + 1;
  }

  /** The worker "dies" after the side effect and before Temporal hears of it: the attempt fails, the retry runs. */
  maybeLose(step: LostStep): void {
    if (this.loseOnce.delete(step)) {
      throw new Error('simulated: the worker died after the side effect');
    }
  }
}

const PR_OFFSET = 1000;

function fakeActivities(worlds: Map<number, World>) {
  const world = (issue: number): World => {
    const found = worlds.get(issue);
    assert.ok(found, `no world for issue ${issue}`);
    return found;
  };
  const worldOf = (target: BoardItemRef | number): { w: World; kind: 'issue' | 'pr' } => {
    const ref: BoardItemRef = typeof target === 'number' ? { kind: 'issue', number: target } : target;
    return { w: world(ref.kind === 'pr' ? ref.number - PR_OFFSET : ref.number), kind: ref.kind };
  };
  return {
    checkIssue: async (issue: number) => {
      const w = world(issue);
      w.attempt('checkIssue');
      if (w.checkFails !== undefined) {
        throw ApplicationFailure.nonRetryable('refused', w.checkFails);
      }
      return { number: issue, open: w.issueOpen, trustedComments: 1, droppedUntrustedComments: 0 };
    },
    claimIssue: async (issue: number) => {
      const w = world(issue);
      w.attempt('claimIssue');
      if (!w.claimProceeds) {
        return { claimed: false, reason: 'open_pr' as const, proceed: false };
      }
      let answer: { claimed: boolean; reason: 'claimed' | 'already_in_progress'; proceed: boolean };
      if (w.issueStatus === 'Ready') {
        w.issueStatus = 'In progress';
        w.counters.claims += 1;
        w.order.push('claim');
        answer = { claimed: true, reason: 'claimed', proceed: true };
      } else {
        // A retry of a claim that already moved the item: not `claimed`, but carry on.
        answer = { claimed: false, reason: 'already_in_progress', proceed: true };
      }
      w.maybeLose('claimIssue');
      return answer;
    },
    runImplementerSession: async (raw: IssueWorkflowInput) => {
      const w = world(raw.issueNumber);
      w.attempt('runImplementerSession');
      if (w.sessionFails !== undefined) {
        throw ApplicationFailure.nonRetryable('the session failed', w.sessionFails);
      }
      if (!w.sessionStarted) {
        w.sessionStarted = true;
        w.counters.sessions += 1;
        w.order.push('session');
        w.sessionEntered?.();
        await w.sessionGate;
      }
      w.maybeLose('runImplementerSession');
      return { branch: issueBranch(raw.issueNumber), headSha: HEAD_SHA, exitStatus: w.sessionExit };
    },
    openPr: async (input: { head: string; base: string; title: string; body: string }) => {
      const issue = Number(/^claude\/(\d+)$/.exec(input.head)?.[1]);
      const w = world(issue);
      w.attempt('openPr');
      const created = !w.prOpened;
      if (created) {
        w.prOpened = true;
        w.counters.prs += 1;
        w.order.push('openPr');
      }
      w.maybeLose('openPr');
      return { number: issue + PR_OFFSET, url: `https://github.com/eborden/logseq-mcp-server/pull/${issue + PR_OFFSET}`, created };
    },
    addToBoard: async (target: BoardItemRef) => {
      const { w } = worldOf(target);
      w.attempt('addToBoard');
      const added = w.prStatus === undefined;
      if (added) {
        w.prStatus = 'Backlog';
        w.counters.adds += 1;
        w.order.push('addToBoard');
      }
      w.maybeLose('addToBoard');
      return { kind: target.kind, number: target.number, itemId: 'PVTI_x', added, status: w.prStatus ?? null };
    },
    getBoardStatus: async (target: BoardItemRef) => {
      const { w, kind } = worldOf(target);
      w.attempt(`getBoardStatus:${kind}`);
      const status = kind === 'pr' ? (w.stalePrStatus ?? w.prStatus) : w.issueStatus;
      return { kind, number: target.number, onBoard: status !== undefined, status: status ?? null };
    },
    setStatus: async (target: BoardItemRef, status: 'In progress' | 'In review' | 'Done') => {
      const { w, kind } = worldOf(target);
      w.attempt(`setStatus:${kind}`);
      const current = kind === 'pr' ? w.prStatus : w.issueStatus;
      const changed = current !== status;
      if (changed) {
        if (kind === 'pr') {
          w.prStatus = status;
          w.counters.prWrites += 1;
        } else {
          w.issueStatus = status;
          w.counters.issueWrites += 1;
        }
        w.order.push(`setStatus:${kind}`);
      }
      w.maybeLose(kind === 'pr' ? 'setStatusPr' : 'setStatusIssue');
      return { changed, status };
    },
    commentIssue: async (input: { issue: number; key: string; body: string }) => {
      const w = world(input.issue);
      w.attempt('commentIssue');
      const posted = !w.commentKeys.has(input.key);
      if (posted) {
        w.commentKeys.set(input.key, input.body);
        w.counters.comments += 1;
      }
      return { commentId: 1, posted };
    },
  };
}

const worlds = new Map<number, World>();
let fakeQueueStarted = false;
const FAKE_QUEUE = 'issue-wf-fakes';

async function ensureFakeWorker(): Promise<void> {
  if (!fakeQueueStarted) {
    fakeQueueStarted = true;
    await startWorker(FAKE_QUEUE, fakeActivities(worlds));
  }
}

let nextIssue = 100;

/** A fresh issue number with its own world, so tests can run side by side on one worker. */
function newWorld(configure: (world: World) => void = () => undefined): { issue: number; world: World } {
  nextIssue += 1;
  const world = new World();
  configure(world);
  worlds.set(nextIssue, world);
  return { issue: nextIssue, world };
}

function inputFor(issue: number): IssueWorkflowInput {
  return { issueNumber: issue, repoDir: '/work/repo', worktreeDir: `/work/repo/.claude/worktrees/issue-${issue}`, base: 'main' };
}

async function runIssue(taskQueue: string, issue: number): Promise<IssueRunResult> {
  const started = await startIssueRun(client, taskQueue, inputFor(issue));
  assert.equal(started.status, 'started');
  // The workflow result is untyped here, so it is checked by the shape the tests read.
  const result: unknown = await client.workflow.getHandle(issueWorkflowId(issue)).result();
  return result as IssueRunResult;
}

async function stoppedWith(issue: number, taskQueue: string): Promise<{ step: unknown; reason: unknown; pr: unknown; type: unknown; message: string }> {
  await startIssueRun(client, taskQueue, inputFor(issue));
  try {
    await client.workflow.getHandle(issueWorkflowId(issue)).result();
  } catch (error) {
    assert.ok(error instanceof WorkflowFailedError, 'the run ends as a failed workflow');
    const cause = error.cause;
    assert.ok(cause instanceof ApplicationFailure);
    const [step, reason, pr] = cause.details ?? [];
    return { step, reason, pr, type: cause.type, message: cause.message };
  }
  return assert.fail('the run should have stopped');
}

test('happy path: check, claim, session, PR, then the PR and the issue In review, in that order, each side effect once', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue, world } = newWorld();

  const result = await runIssue(FAKE_QUEUE, issue);

  assert.deepEqual(result, { outcome: 'in_review', issueNumber: issue, branch: `claude/${issue}`, headSha: HEAD_SHA, pr: issue + PR_OFFSET });
  assert.deepEqual(world.order, ['claim', 'session', 'openPr', 'addToBoard', 'setStatus:pr', 'setStatus:issue']);
  assert.deepEqual(world.counters, { claims: 1, sessions: 1, prs: 1, adds: 1, prWrites: 1, issueWrites: 1, comments: 0 });
  assert.equal(world.prStatus, 'In review', 'the PR is In review on the board with no manual step');
  assert.equal(world.issueStatus, 'In review');
  // The board was read back, not assumed: after the claim, and for the PR and the issue after their moves.
  assert.equal(world.attempts['getBoardStatus:issue'], 2);
  assert.equal(world.attempts['getBoardStatus:pr'], 1);
});

test('the finished run replays against the current workflow code', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue } = newWorld();
  await runIssue(FAKE_QUEUE, issue);
  const history = await client.workflow.getHandle(issueWorkflowId(issue)).fetchHistory();

  await Worker.runReplayHistory({ workflowBundle: bundle }, history, issueWorkflowId(issue));
});

test('a result lost after any one step is retried, and the run still ends In review with each side effect once', { timeout: 180_000 }, async () => {
  await ensureFakeWorker();
  const steps: LostStep[] = ['claimIssue', 'runImplementerSession', 'openPr', 'addToBoard', 'setStatusPr', 'setStatusIssue'];
  const runs = steps.map((step) => ({ step, ...newWorld((world) => world.loseOnce.add(step)) }));

  // Side by side: each has its own issue, so its own workflow ID and world.
  const results = await Promise.all(runs.map(({ issue }) => runIssue(FAKE_QUEUE, issue)));

  for (const [index, { step, issue, world }] of runs.entries()) {
    assert.equal(results[index]?.outcome, 'in_review', step);
    assert.deepEqual(world.counters, { claims: 1, sessions: 1, prs: 1, adds: 1, prWrites: 1, issueWrites: 1, comments: 0 }, `${step}: each side effect once`);
    assert.deepEqual(world.order, ['claim', 'session', 'openPr', 'addToBoard', 'setStatus:pr', 'setStatus:issue'], step);
    assert.equal(world.loseOnce.size, 0, `${step}: the loss really happened`);
  }
  // The lost step ran twice (the attempt that died, and its retry). The ones before it did not run again.
  const [claim, session, openPr, addToBoard, setStatusPr, setStatusIssue] = runs.map(({ world }) => world);
  assert.equal(claim?.attempts['claimIssue'], 2);
  assert.equal(session?.attempts['runImplementerSession'], 2);
  assert.equal(session?.attempts['claimIssue'], 1, 'a step that finished is not run again after the replay');
  assert.equal(openPr?.attempts['openPr'], 2);
  assert.equal(openPr?.attempts['runImplementerSession'], 1);
  assert.equal(addToBoard?.attempts['addToBoard'], 2);
  assert.equal(setStatusPr?.attempts['setStatus:pr'], 2);
  assert.equal(setStatusIssue?.attempts['setStatus:issue'], 2);
  assert.equal(setStatusIssue?.attempts['setStatus:pr'], 1);
});

test('a retry of the run own claim carries on: proceed true with claimed false is not a stop', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  // The item is already In progress, as it is after a claim whose answer was lost.
  const { issue, world } = newWorld((w) => {
    w.issueStatus = 'In progress';
  });

  const result = await runIssue(FAKE_QUEUE, issue);

  assert.equal(result.outcome, 'in_review');
  assert.equal(world.counters.claims, 0, 'this run moved nothing in the claim');
  assert.equal(world.counters.sessions, 1);
});

test('proceed false is a stop without a session, a PR or a comment: an open PR, a branch, or an item past In progress', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue, world } = newWorld((w) => {
    w.claimProceeds = false;
  });

  const result = await runIssue(FAKE_QUEUE, issue);

  assert.deepEqual(result, { outcome: 'skipped', issueNumber: issue, reason: 'open_pr' });
  assert.deepEqual(world.counters, { claims: 0, sessions: 0, prs: 0, adds: 0, prWrites: 0, issueWrites: 0, comments: 0 });
});

test('a closed issue is skipped before any claim', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue, world } = newWorld((w) => {
    w.issueOpen = false;
  });

  assert.deepEqual(await runIssue(FAKE_QUEUE, issue), { outcome: 'skipped', issueNumber: issue, reason: 'issue_closed' });
  assert.equal(world.attempts['claimIssue'], undefined);
});

test('a session that fails permanently ends with one comment on the issue and a stopped run, with no PR and no retry', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue, world } = newWorld((w) => {
    w.sessionFails = 'SessionTimeout';
  });

  const stopped = await stoppedWith(issue, FAKE_QUEUE);

  assert.equal(stopped.type, ISSUE_STOPPED_FAILURE);
  assert.equal(stopped.step, 'session');
  assert.equal(stopped.reason, 'SessionTimeout');
  assert.equal(world.attempts['runImplementerSession'], 1, 'a failed premise is not retried');
  assert.equal(world.counters.comments, 1);
  assert.deepEqual([...world.commentKeys.keys()], ['stopped-session']);
  const comment = [...world.commentKeys.values()][0] ?? '';
  assert.ok(comment.includes('SessionTimeout') && comment.includes(issueWorkflowId(issue)));
  assert.equal(world.counters.prs, 0, 'no PR for a failed session');
  assert.equal(world.prStatus, undefined);
  assert.equal(world.issueStatus, 'In progress', 'the issue is left where the claim put it, for a person');
});

test('every status that means a person must look ends the same way: a comment and a stopped run, never a second session', { timeout: 180_000 }, async () => {
  await ensureFakeWorker();
  const expected: [SessionExitStatus, string][] = [
    ['error', 'SessionError'],
    ['interrupted', 'SessionInterrupted'],
    ['claimed', 'SessionClaimed'],
    ['existing', 'SessionExistingBranch'],
  ];
  const runs = expected.map(([status, reason]) => ({ reason, ...newWorld((w) => (w.sessionExit = status)) }));

  const stops = await Promise.all(runs.map(({ issue }) => stoppedWith(issue, FAKE_QUEUE)));

  for (const [index, { reason, world }] of runs.entries()) {
    assert.equal(stops[index]?.reason, reason);
    assert.equal(stops[index]?.step, 'session');
    assert.equal(world.counters.comments, 1, reason);
    assert.equal(world.counters.sessions, 1, reason);
    assert.equal(world.counters.prs, 0, reason);
  }
});

test('an untrusted or missing issue stops the run before any claim and says nothing on the issue', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  for (const failure of ['UntrustedAuthor', 'NotFound']) {
    const { issue, world } = newWorld((w) => {
      w.checkFails = failure;
    });
    const stopped = await stoppedWith(issue, FAKE_QUEUE);
    assert.equal(stopped.reason, failure);
    assert.equal(stopped.step, 'check');
    assert.equal(world.counters.comments, 0, `${failure}: no comment on an issue that is not ours to talk on`);
    assert.equal(world.attempts['claimIssue'], undefined);
  }
});

test('a board that does not show the PR In review stops the run with a comment: the move is read back, not assumed', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue, world } = newWorld((w) => {
    w.stalePrStatus = 'Backlog';
  });

  const stopped = await stoppedWith(issue, FAKE_QUEUE);

  assert.equal(stopped.step, 'board_pr');
  assert.equal(stopped.reason, 'BoardDisagrees');
  assert.equal(stopped.pr, issue + PR_OFFSET, 'the comment names the PR that is open');
  assert.equal(world.attempts['getBoardStatus:pr'], 3, 'a bounded number of reads');
  assert.equal(world.counters.comments, 1);
  assert.equal(world.issueStatus, 'In progress', 'the issue is not moved on a board that disagreed');
  assert.equal(world.counters.issueWrites, 0);
});

test('a bad input stops before any activity', { timeout: 60_000 }, async () => {
  await ensureFakeWorker();
  const handle = await client.workflow.start(ISSUE_WORKFLOW_NAME, {
    taskQueue: FAKE_QUEUE,
    workflowId: 'issue-bad-input',
    args: [{ issueNumber: 0, repoDir: 'relative', worktreeDir: '/x', base: 'main' }],
  });
  await assert.rejects(handle.result(), (error: unknown) => error instanceof WorkflowFailedError && error.cause instanceof ApplicationFailure && error.cause.type === 'InvalidInput');
});

// ---- the claim: one workflow ID per issue --------------------------------------------------------------------

test('a second start for the same issue is rejected while the run is open and after it closed, never attached or replaced', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
  const { issue, world } = newWorld((w) => {
    w.sessionGate = new Promise<void>((resolve) => (release = resolve));
    w.sessionEntered = entered;
  });

  try {
    const first = await startIssueRun(client, FAKE_QUEUE, inputFor(issue));
    assert.equal(first.status, 'started');
    await enteredPromise;

    const whileOpen = await startIssueRun(client, FAKE_QUEUE, inputFor(issue));
    assert.deepEqual(whileOpen, { status: 'already_running', workflowId: issueWorkflowId(issue) });
  } finally {
    // Always let the session finish, so a failed assertion cannot leave the worker waiting on it.
    release();
  }
  await client.workflow.getHandle(issueWorkflowId(issue)).result();
  const afterClose = await startIssueRun(client, FAKE_QUEUE, inputFor(issue));
  assert.deepEqual(afterClose, { status: 'already_finished', workflowId: issueWorkflowId(issue), closedAs: 'COMPLETED' });
  assert.equal(world.counters.sessions, 1, 'the second starts ran nothing');
  assert.equal(world.counters.claims, 1);
});

test('a stopped run holds its ID too: a failed run is not started again by a script', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue, world } = newWorld((w) => {
    w.sessionFails = 'SessionTimeout';
  });
  await stoppedWith(issue, FAKE_QUEUE);

  const again = await startIssueRun(client, FAKE_QUEUE, inputFor(issue));

  assert.deepEqual(again, { status: 'already_finished', workflowId: issueWorkflowId(issue), closedAs: 'FAILED' });
  assert.equal(world.attempts['runImplementerSession'], 1);
});

test('the workflow ID is built from the issue number alone, and the registered name is the exported function', () => {
  assert.equal(issueWorkflowId(123), 'issue-123');
  assert.equal(issueBranch(123), 'claude/123');
  assert.ok(bundle.code.includes(ISSUE_WORKFLOW_NAME));
});

// ---- layer 2: the real activities against the fake gh and the fake claude -------------------------------------

const SECRET_BODY = 'SECRET-ISSUE-BODY-project-atlas';
const SECRET_COMMENT = 'SECRET-TRUSTED-COMMENT';
const STRANGER = 'STRANGER-TEXT-ignore-all-rules';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd });
  return stdout.trim();
}

async function realStack(name: string, issue: number, configure: (state: ReturnType<typeof emptyState>) => void, claudeMode = 'success') {
  const home = join(dir, name);
  const bare = join(home, 'origin.git');
  const repo = join(home, 'repo');
  await mkdir(home, { recursive: true });
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  await execFileAsync('git', ['clone', '-q', bare, repo]);
  await git(repo, 'checkout', '-q', '-b', 'main');
  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  await git(repo, 'push', '-q', 'origin', 'main');
  const state = emptyState();
  configure(state);
  const fake = await createFake(home, 'gh', state);
  const logFile = join(home, 'claude.log');
  process.env['FAKE_CLAUDE_MODE'] = claudeMode;
  process.env['FAKE_CLAUDE_LOG'] = logFile;
  const github = createGithubActivities(fake.config);
  const claude = createClaudeSessionActivities({ ...loadClaudeConfig({}), claudeBin: FAKE_CLAUDE });
  const implementer = createImplementerActivities({ readIssue: github.readIssue, runClaudeSession: claude.runClaudeSession, repo: fake.config.repo });
  const taskQueue = `issue-wf-real-${name}`;
  await startWorker(taskQueue, { ...github, ...implementer });
  const input: IssueWorkflowInput = { issueNumber: issue, repoDir: repo, worktreeDir: join(home, 'wt'), base: 'main' };
  const sessions = async (): Promise<number> => {
    try {
      return (await readFile(logFile, 'utf8')).split('\n').filter((line) => line !== '').length;
    } catch {
      return 0;
    }
  };
  return { fake, taskQueue, input, sessions };
}

function seed(issue: number): (state: ReturnType<typeof emptyState>) => void {
  return (state) => {
    state.board = [{ number: issue, status: 'Ready' }];
    state.issues[String(issue)] = rawIssue(issue, { body: SECRET_BODY });
    state.comments[String(issue)] = [rawComment(1, 'OWNER', SECRET_COMMENT), rawComment(2, 'NONE', STRANGER, 'mallory')];
  };
}

/** Every payload of a history, decoded to text: what Temporal stores about a run. */
function historyText(history: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (value instanceof Uint8Array) {
      found.push(Buffer.from(value).toString('utf8'));
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(walk);
    }
  };
  walk(history);
  return found;
}

test('the real activities against the fake gh and claude: the PR is In review, and the history holds identifiers only', { timeout: 240_000 }, async () => {
  const stack = await realStack('happy', 201, seed(201));
  const started = await startIssueRun(client, stack.taskQueue, stack.input);
  assert.equal(started.status, 'started');

  const result: unknown = await client.workflow.getHandle(issueWorkflowId(stack.input.issueNumber)).result();

  assert.deepEqual(result, { outcome: 'in_review', issueNumber: 201, branch: 'claude/201', headSha: (result as { headSha: string }).headSha, pr: 1001 });
  const state = await stack.fake.state();
  assert.equal(state.board.find((item) => item.number === stack.input.issueNumber)?.status, 'In review');
  assert.equal(state.board.find((item) => item.number === 1001)?.status, 'In review');
  assert.equal(state.pulls.length, 1);
  assert.equal(await stack.sessions(), 1);

  const history = await client.workflow.getHandle(issueWorkflowId(stack.input.issueNumber)).fetchHistory();
  const texts = historyText(history);
  assert.ok(texts.length > 10, 'the history was read');
  for (const leaked of [SECRET_BODY, SECRET_COMMENT, STRANGER, 'mallory', 'issue-data', 'Co-Authored-By', 'Untrusted GitHub content']) {
    assert.ok(!texts.some((text) => text.includes(leaked)), `${leaked} must not be in the workflow history`);
  }
  assert.ok(texts.every((text) => text.length < 2_000), 'no payload carries a document');
  await Worker.runReplayHistory({ workflowBundle: bundle }, history, issueWorkflowId(stack.input.issueNumber));
});

test('the real activities: a failed session leaves one comment on the issue and no PR, and the comment is the fixed text', { timeout: 240_000 }, async () => {
  const stack = await realStack('failed', 202, seed(202), 'session-error');
  await startIssueRun(client, stack.taskQueue, stack.input);

  await assert.rejects(client.workflow.getHandle(issueWorkflowId(stack.input.issueNumber)).result(), WorkflowFailedError);

  const state = await stack.fake.state();
  const comments = (state.comments['202'] ?? []).filter((comment) => JSON.stringify(comment).includes('orchestrator-comment'));
  assert.equal(comments.length, 1);
  const body = JSON.stringify(comments[0]);
  assert.ok(body.includes('SessionError') && body.includes('issue-202'));
  assert.equal(state.pulls.length, 0);
  assert.equal(state.board.find((item) => item.number === stack.input.issueNumber)?.status, 'In progress');
  assert.equal(await stack.sessions(), 1);
});

test('the real activities: an untrusted issue never reaches claim or session', { timeout: 120_000 }, async () => {
  const stack = await realStack('untrusted', 203, (state) => {
    state.board = [{ number: 203, status: 'Ready' }];
    state.issues['203'] = rawIssue(203, { author_association: 'NONE', body: STRANGER });
  });
  await startIssueRun(client, stack.taskQueue, stack.input);

  await assert.rejects(client.workflow.getHandle(issueWorkflowId(stack.input.issueNumber)).result(), WorkflowFailedError);

  const state = await stack.fake.state();
  assert.equal(state.board.find((item) => item.number === stack.input.issueNumber)?.status, 'Ready', 'not claimed');
  assert.equal(await stack.sessions(), 0);
  assert.equal(Object.values(state.comments).flat().length, 0, 'nothing posted on a stranger issue');
  assert.equal((await stack.fake.callsMatching('item-edit')).length, 0);
});
