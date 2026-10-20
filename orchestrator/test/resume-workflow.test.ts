// The resume entry point (#747) against a real Temporal server (an in-memory dev server on a free port) and no real service:
// GitHub, the model and the host suite are fakes that model one PR with counters. Nothing here calls GitHub, `claude` or
// LogSeq. Every name is made up (issue 123, project atlas, Alice).
//
// The story under test: a run stops at `host_integration` (or a fix step), a person fixes the PR by hand and has the new head
// reviewed, then `npm run run-issue -- --issue <n> --resume` re-gates that head: the same gate, host check and statement as the
// full run, with no claim, no session and no new PR. The workers run with `maxCachedWorkflows: 0`, so every workflow task replays
// the whole history.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/activity';
import { WorkflowFailedError, WorkflowNotFoundError } from '@temporalio/client';
import type { Client } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import type { WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { loadServerConfig } from '../src/config.ts';
import { startDevServer } from '../src/dev-server.ts';
import { HOST_TASK_QUEUE_NAME } from '../src/host-integration-policy.ts';
import type { HostIntegrationInput, HostIntegrationResult } from '../src/host-integration-policy.ts';
import { buildHostDescription, needsHostIntegration, parseHostStatusInput } from '../src/integration-policy.ts';
import { startIssueRun, startResumeRun } from '../src/issue-client.ts';
import {
  ISSUE_RUN_TIMEOUT,
  ISSUE_STOPPED_FAILURE,
  ISSUE_WORKFLOW_NAME,
  RESUME_REFUSALS,
  gateClearComment,
  issueWorkflowId,
  parseIssueWorkflowInput,
  resumeKeySuffix,
  resumeWorkflowId,
} from '../src/issue-types.ts';
import type { IssueRunResult, IssueWorkflowInput, ResumeResolution } from '../src/issue-types.ts';
import { buildResumeInput } from '../src/run-issue-input.ts';
import type { BoardItemRef } from '../src/types.ts';
import { freePort } from './support.ts';

const WORKFLOWS_PATH = fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url));
/** A head of one issue's world: the issue number in the first 8 digits, then a letter. Unique per world, so the shared fakes find their world by sha. */
const shaOf = (issue: number, letter: 'a' | 'b' | 'c'): string => `${String(issue).padStart(8, '0')}${letter.repeat(32)}`;
const issueOfSha = (sha: string): number => Number(sha.slice(0, 8));
const PR_OFFSET = 1000;
const QUEUE = 'resume-fakes';
const BASE = 'feature/atlas';
const PASS: HostIntegrationResult = { outcome: 'pass', passed: 82, failed: 0 };

// ---- the input, the ID and the flags ---------------------------------------------------------------------------------

test('the run input takes a resume target of a PR number and a full sha, and refuses anything else', () => {
  const base = { issueNumber: 5, repoDir: '/work/repo', worktreeDir: '/work/wt', base: 'main' };
  const head = 'a'.repeat(40);
  assert.equal('resume' in parseIssueWorkflowInput(base), false, 'absent stays absent: a run is a full run');
  assert.deepEqual(parseIssueWorkflowInput({ ...base, resume: { pr: 9, headSha: head } }).resume, { pr: 9, headSha: head });
  for (const bad of [null, [], 'a', 5, {}, { pr: 9 }, { headSha: head }, { pr: 0, headSha: head }, { pr: 1.5, headSha: head }, { pr: '9', headSha: head }, { pr: 9, headSha: 'a'.repeat(39) }, { pr: 9, headSha: 'A'.repeat(40) }, { pr: 9, headSha: `${head}\n` }]) {
    assert.throws(() => parseIssueWorkflowInput({ ...base, resume: bad }), /resume/, JSON.stringify(bad));
  }
});

test('a resume run has its own ID, one per head: never the issue run\'s, and a stopped run\'s ID is not touched', () => {
  const head = `0123456789ab${'c'.repeat(28)}`;
  assert.equal(resumeWorkflowId(123, head), 'issue-123-resume-0123456789ab');
  assert.notEqual(resumeWorkflowId(123, head), issueWorkflowId(123));
  assert.notEqual(resumeWorkflowId(123, head), resumeWorkflowId(123, `0123456789ac${'c'.repeat(28)}`));
  assert.notEqual(resumeWorkflowId(12, head), resumeWorkflowId(123, head));
  assert.match(resumeWorkflowId(123, head), /^[A-Za-z0-9._-]{1,100}$/);
  assert.equal(resumeKeySuffix(head), '-resume-0123456789ab');
});

test('--resume takes the issue, the repo and the host check, and refuses the flags that start or steer a session', () => {
  const flags = { issue: '123', repoDir: '/work/repo', hostIntegration: true, executor: undefined, base: undefined, worktreeDir: undefined, attempt: undefined };
  const input = buildResumeInput(flags);
  assert.equal(input.issueNumber, 123);
  assert.equal(input.hostIntegration, 'auto');
  assert.equal('resume' in input, false, 'the PR is read from GitHub later, never taken from a flag');
  assert.notEqual(buildResumeInput({ ...flags, hostIntegration: false }).hostIntegration, 'auto');
  assert.equal(buildResumeInput(flags).executor, undefined, 'no session of any kind runs, so no fixer');
  assert.throws(() => buildResumeInput({ ...flags, executor: 'remote' }), /--executor is not used with --resume/);
  assert.throws(() => buildResumeInput({ ...flags, executor: 'local' }), /--executor is not used with --resume/);
  assert.throws(() => buildResumeInput({ ...flags, base: 'main' }), /--base is not used with --resume/);
  assert.throws(() => buildResumeInput({ ...flags, worktreeDir: '/work/wt' }), /--worktree-dir is not used with --resume/);
  assert.throws(() => buildResumeInput({ ...flags, attempt: '2' }), /--attempt is not used with --resume/);
  assert.throws(() => buildResumeInput({ ...flags, issue: 'x' }), /issueNumber/);
});

test('the gate-clear statement of a resume run says it is a resume and names no signal; a full run\'s statement is unchanged', () => {
  const facts = { workflowId: 'issue-123', issue: 123, pr: 1123, headSha: 'a'.repeat(40), fixRounds: 2, reviewsOnHead: 1, unresolvedThreads: 0, host: { kind: 'off' } as const, advisory: undefined, advisoryOmitted: undefined, lastReviewId: undefined };
  const full = gateClearComment(facts);
  assert.match(full, /npm run signal -- 123 approved/);
  assert.match(full, /2 fix rounds used/);
  const resumed = gateClearComment({ ...facts, workflowId: 'issue-123-resume-aaaaaaaaaaaa', resumed: true });
  assert.doesNotMatch(resumed, /npm run signal|fix rounds? used/);
  assert.match(resumed, /started at the gate for this head/);
  assert.match(resumed, /not an approval/);
  assert.match(resumed, new RegExp(`${'a'.repeat(40)}`));
});

// ---- a model of one PR --------------------------------------------------------------------------------------------

let env: TestWorkflowEnvironment;
let client: Client;
let bundle: WorkflowBundleWithSourceMap;
const workers: { worker: Worker; running: Promise<void> }[] = [];

before(async () => {
  env = await startDevServer({ port: await freePort(), cliPath: loadServerConfig(process.env).cliPath });
  client = env.client;
  bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH });
  const main = await Worker.create({
    connection: env.nativeConnection,
    namespace: 'default',
    taskQueue: QUEUE,
    workflowBundle: bundle,
    activities: fakeActivities(),
    maxCachedWorkflows: 0,
  });
  const host = await Worker.create({
    connection: env.nativeConnection,
    namespace: 'default',
    taskQueue: HOST_TASK_QUEUE_NAME,
    activities: { runHostIntegration: fakeHostRun },
  });
  workers.push({ worker: main, running: main.run() }, { worker: host, running: host.run() });
});

after(async () => {
  for (const { worker } of workers) {
    worker.shutdown();
  }
  await Promise.allSettled(workers.map(({ running }) => running));
  await env?.teardown();
});

class World {
  issueOpen = true;
  issueStatus = 'Ready';
  prStatus: string | undefined;
  /** How many open PRs the issue has, and whether the PR is open at all. */
  openPrs = 1;
  base = BASE;
  prHead = '';
  head1 = '';
  head2 = '';
  head3 = '';
  /** The heads a review is on, and the open threads. */
  readonly reviewed = new Set<string>();
  threads = 0;
  merged = false;
  changedFiles: string[] = ['docs/atlas.md', 'src/atlas.rs'];
  readonly statuses = new Map<string, { state: string; description: string }>();
  readonly statusWrites: string[] = [];
  hostSteps: HostIntegrationResult[] = [PASS];
  /** The head of every run of the suite. */
  readonly runs: string[] = [];
  /** Every comment by key; a repeat of a key posts nothing, as the real activity does. */
  readonly comments = new Map<string, { body: string; target: number }>();
  /** How many times each fake activity was called. */
  readonly calls = new Map<string, number>();

  count(name: string): number {
    return this.calls.get(name) ?? 0;
  }

  resolution(): ResumeResolution {
    if (!this.issueOpen) {
      return { ok: false, reason: 'issue_closed' };
    }
    if (this.issueStatus !== 'In review') {
      return { ok: false, reason: 'issue_not_in_review' };
    }
    if (this.openPrs === 0) {
      return { ok: false, reason: 'no_open_pr' };
    }
    if (this.openPrs > 1) {
      return { ok: false, reason: 'several_open_prs' };
    }
    return { ok: true, pr: this.issueNumber + PR_OFFSET, headSha: this.prHead, base: this.base };
  }

  constructor(readonly issueNumber: number) {}
}

const worlds = new Map<number, World>();
let nextIssue = 800;

function newWorld(configure: (world: World) => void = () => undefined): { issue: number; world: World } {
  nextIssue += 1;
  const world = new World(nextIssue);
  world.head1 = shaOf(nextIssue, 'a');
  world.head2 = shaOf(nextIssue, 'b');
  world.head3 = shaOf(nextIssue, 'c');
  world.prHead = world.head1;
  configure(world);
  worlds.set(nextIssue, world);
  return { issue: nextIssue, world };
}

const worldOfIssue = (issue: number): World => {
  const found = worlds.get(issue);
  assert.ok(found, `no world for issue ${issue}`);
  return found;
};

async function fakeHostRun(input: HostIntegrationInput): Promise<HostIntegrationResult> {
  const w = worldOfIssue(input.pr - PR_OFFSET);
  const step = w.hostSteps[Math.min(w.runs.length, w.hostSteps.length - 1)];
  assert.ok(step);
  w.runs.push(input.headSha);
  return step;
}

function fakeActivities() {
  const board = (target: BoardItemRef): { w: World; kind: 'issue' | 'pr' } => ({
    w: worldOfIssue(target.kind === 'pr' ? target.number - PR_OFFSET : target.number),
    kind: target.kind,
  });
  /** Wraps an activity so the world counts its calls by name. */
  const counted =
    <Args extends unknown[], Result>(name: string, world: (...args: Args) => World, run: (w: World, ...args: Args) => Promise<Result> | Result) =>
    async (...args: Args): Promise<Result> => {
      const w = world(...args);
      w.calls.set(name, w.count(name) + 1);
      return await run(w, ...args);
    };
  const byIssue = (issue: number): World => worldOfIssue(issue);
  const byPr = (pr: number): World => worldOfIssue(pr - PR_OFFSET);
  return {
    // The resume path.
    resolveResume: counted('resolveResume', byIssue, (w) => w.resolution()),
    // The full run's first leg, to make a run that stops at the gate.
    checkIssue: counted('checkIssue', byIssue, (w, issue: number) => ({ number: issue, open: w.issueOpen, trustedComments: 1, droppedUntrustedComments: 0 })),
    claimIssue: counted('claimIssue', byIssue, (w) => {
      w.issueStatus = 'In progress';
      return { claimed: true, reason: 'claimed' as const, proceed: true };
    }),
    runImplementerSession: counted('runImplementerSession', (raw: IssueWorkflowInput) => worldOfIssue(raw.issueNumber), (_w, raw: IssueWorkflowInput) => ({ branch: `claude/${raw.issueNumber}`, headSha: shaOf(raw.issueNumber, 'a'), exitStatus: 'success' as const })),
    guardBranch: async (raw: { branch: string; headSha: string }) => ({ branch: raw.branch, headSha: raw.headSha, files: 1 }),
    pushBranch: async (raw: { branch: string; headSha: string }) => ({ branch: raw.branch, headSha: raw.headSha }),
    openPr: counted('openPr', (input: { head: string }) => worldOfIssue(Number(/^claude\/(\d+)$/.exec(input.head)?.[1])), (w) => ({ number: w.issueNumber + PR_OFFSET, url: `https://github.com/eborden/logseq-mcp-server/pull/${w.issueNumber + PR_OFFSET}`, created: true })),
    addToBoard: counted('addToBoard', (target: BoardItemRef) => board(target).w, (w, target: BoardItemRef) => {
      const added = w.prStatus === undefined;
      w.prStatus ??= 'Backlog';
      return { kind: target.kind, number: target.number, itemId: 'PVTI_x', added, status: w.prStatus };
    }),
    getBoardStatus: async (target: BoardItemRef) => {
      const { w, kind } = board(target);
      const status = kind === 'pr' ? w.prStatus : w.issueStatus;
      return { kind, number: target.number, onBoard: status !== undefined, status: status ?? null };
    },
    setStatus: counted('setStatus', (target: BoardItemRef, _status: string) => board(target).w, (w, target: BoardItemRef, status: string) => {
      if (target.kind === 'pr') {
        w.prStatus = status;
      } else {
        w.issueStatus = status;
      }
      return { changed: true, status };
    }),
    runReviewerSession: counted('runReviewerSession', (input: { pr: number }) => byPr(input.pr), () => ({ findings: 0, acceptedThreadIds: [] })),
    postSessionReview: counted('postSessionReview', (input: { pr: number }) => byPr(input.pr), (w) => {
      w.reviewed.add(w.prHead);
      return { reviewId: 1, posted: true, comments: 0, advisory: 0, omitted: 0, fileLevel: 0, nearest: 0 };
    }),
    // The gate is the real rule over these counts: a review on the head and no open thread.
    getGateStatus: counted('getGateStatus', byPr, (w) => {
      const counts = { reviewsOnHead: w.reviewed.has(w.prHead) ? 1 : 0, unresolvedThreads: w.threads };
      return { headSha: w.prHead, ...counts, clear: counts.reviewsOnHead >= 1 && counts.unresolvedThreads === 0 };
    }),
    commentIssue: counted('commentIssue', (input: { issue: number }) => worldOfIssue(input.issue >= PR_OFFSET ? input.issue - PR_OFFSET : input.issue), (w, input: { issue: number; key: string; body: string }) => {
      const posted = !w.comments.has(input.key);
      if (posted) {
        w.comments.set(input.key, { body: input.body, target: input.issue });
      }
      return { commentId: 1, posted };
    }),
    getPrState: counted('getPrState', byPr, (w) => ({ state: 'open' as const, merged: w.merged, headSha: w.prHead })),
    getPrChanges: async () => ({ files: 0, golden: 0, ceilings: 0, adrs: 0, businessRules: 0, complete: true }),
    closeIssue: async (issue: number) => {
      worldOfIssue(issue).issueOpen = false;
      return { changed: true, closed: true as const };
    },
    getHostIntegrationNeed: counted('getHostIntegrationNeed', byPr, (w) => ({ needed: needsHostIntegration(w.changedFiles, true) })),
    getHostIntegration: counted('getHostIntegration', (input: { sha: string }) => worldOfIssue(issueOfSha(input.sha)), (w, input: { sha: string }) => {
      const current = w.statuses.get(input.sha);
      return current === undefined ? { state: 'none' as const } : { state: current.state as 'pending' | 'success' | 'failure' | 'error' };
    }),
    postCommitStatus: counted('postCommitStatus', (raw: unknown) => worldOfIssue(issueOfSha(parseHostStatusInput(raw).sha)), (w, raw: unknown) => {
      const input = parseHostStatusInput(raw);
      const description = buildHostDescription(input.counts);
      const current = w.statuses.get(input.sha);
      const posted = !(current?.state === input.state && current.description === description);
      if (posted) {
        w.statuses.set(input.sha, { state: input.state, description });
        w.statusWrites.push(`${input.sha[8]}:${input.state}:${description}`);
      }
      return { posted };
    }),
  };
}

const FAST = { decisionTimeoutMs: 30_000, decisionPollMs: 500 };

const resumeFlags = (issue: number, hostIntegration = true) => ({ issue: String(issue), repoDir: '/work/repo', hostIntegration, executor: undefined, base: undefined, worktreeDir: undefined, attempt: undefined });
const resolverFor = async (issue: number): Promise<ResumeResolution> => worldOfIssue(issue).resolution();

function startResume(issue: number, extra: Partial<IssueWorkflowInput> = {}, hostIntegration = true) {
  return startResumeRun(client, QUEUE, resolverFor, { ...buildResumeInput(resumeFlags(issue, hostIntegration)), ...FAST, ...extra });
}

async function startFull(issue: number, extra: Partial<IssueWorkflowInput> = {}) {
  const input: IssueWorkflowInput = { issueNumber: issue, repoDir: '/work/repo', worktreeDir: `/work/repo/.claude/worktrees/issue-${issue}`, base: BASE, hostIntegration: 'auto', ...FAST, ...extra };
  const started = await startIssueRun(client, QUEUE, input);
  assert.equal(started.status, 'started');
}

async function resultOf(workflowId: string): Promise<IssueRunResult> {
  const result: unknown = await client.workflow.getHandle(workflowId).result();
  return result as IssueRunResult;
}

async function until(what: string, ready: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function stoppedWith(workflowId: string): Promise<{ step: unknown; reason: unknown }> {
  try {
    await client.workflow.getHandle(workflowId).result();
  } catch (error) {
    assert.ok(error instanceof WorkflowFailedError);
    assert.ok(error.cause instanceof ApplicationFailure);
    assert.equal(error.cause.type, ISSUE_STOPPED_FAILURE);
    const [step, reason] = error.cause.details ?? [];
    return { step, reason };
  }
  return assert.fail('the run should have stopped');
}

/** A full run that stops at `host_integration` for head 1, as the stopped run of the issue, and the world left as it was. */
async function stoppedAtHostIntegration(configure: (world: World) => void = () => undefined): Promise<{ issue: number; world: World }> {
  const made = newWorld((w) => {
    w.hostSteps = [{ outcome: 'fail', passed: 80, failed: 2 }];
    configure(w);
  });
  await startFull(made.issue);
  assert.deepEqual(await stoppedWith(issueWorkflowId(made.issue)), { step: 'host_integration', reason: 'IntegrationFailed' });
  assert.deepEqual(made.world.statusWrites, ['a:pending:no counts', 'a:failure:80 passed, 2 failed']);
  return made;
}

/** What a person does by hand: pushes a fix (the head moves), has it reviewed, and the suite would now pass. */
function handFix(world: World, head: string): void {
  world.prHead = head;
  world.reviewed.add(head);
  world.hostSteps = [PASS];
}

/** The activities a resume run must never reach: they claim, run a session, open a PR, write the board or post a review. */
const NEVER_ON_RESUME = ['checkIssue', 'claimIssue', 'runImplementerSession', 'openPr', 'addToBoard', 'setStatus', 'runReviewerSession', 'postSessionReview'] as const;

function snapshotOf(world: World): Record<string, number> {
  return Object.fromEntries(NEVER_ON_RESUME.map((name) => [name, world.count(name)]));
}

// ---- the story ----------------------------------------------------------------------------------------------------

test('after a stop at host_integration, a hand fix and a review, a resume checks the new head, posts its host status and its gate-clear statement, and nothing else', { timeout: 120_000 }, async () => {
  const { issue, world } = await stoppedAtHostIntegration();
  const pr = issue + PR_OFFSET;
  handFix(world, world.head2);
  const before = snapshotOf(world);
  const commentsBefore = [...world.comments.keys()];

  const started = await startResume(issue);

  assert.equal(started.status, 'started');
  const id = resumeWorkflowId(issue, world.head2);
  assert.equal('workflowId' in started && started.workflowId, id);
  const result = await resultOf(id);
  assert.deepEqual(result, { outcome: 'resumed_gate_clear', issueNumber: issue, pr, headSha: world.head2, reviewsOnHead: 1 });

  // The suite ran for the new head, once, and the old head's failure is untouched.
  assert.deepEqual(world.runs, [world.head1, world.head2]);
  assert.deepEqual(world.statusWrites, ['a:pending:no counts', 'a:failure:80 passed, 2 failed', 'b:pending:no counts', 'b:success:82 passed, 0 failed']);
  // One statement, for this head only, on the PR.
  const added = [...world.comments.keys()].filter((key) => !commentsBefore.includes(key));
  assert.deepEqual(added, [`gate-clear-${pr}-${world.head2}`]);
  const statement = world.comments.get(`gate-clear-${pr}-${world.head2}`);
  assert.equal(statement?.target, pr);
  assert.match(statement?.body ?? '', new RegExp(`head \`${world.head2}\``));
  assert.match(statement?.body ?? '', /host\/integration: success\./);
  assert.match(statement?.body ?? '', /not an approval/);
  assert.match(statement?.body ?? '', new RegExp(`workflow \`${id}\``));
  assert.doesNotMatch(statement?.body ?? '', new RegExp(world.head1));
  // No claim, no session, no PR, no board write, no review: the run is the gate and nothing before it.
  assert.deepEqual(snapshotOf(world), before);
  assert.equal(world.merged, false, 'nothing merges');
  assert.equal(world.issueStatus, 'In review', 'the board is as the stopped run left it');
});

test('starting the resume twice for one head runs the check once and posts one statement; the second start says why and starts nothing', { timeout: 120_000 }, async () => {
  const { issue, world } = await stoppedAtHostIntegration();
  handFix(world, world.head2);
  await startResume(issue);
  await resultOf(resumeWorkflowId(issue, world.head2));
  const runsAfterFirst = [...world.runs];
  const writesAfterFirst = [...world.statusWrites];
  const commentsAfterFirst = new Map(world.comments);

  const again = await startResume(issue);

  assert.deepEqual(again, { status: 'already_finished', workflowId: resumeWorkflowId(issue, world.head2), closedAs: 'COMPLETED' });
  assert.deepEqual(world.runs, runsAfterFirst);
  assert.deepEqual(world.statusWrites, writesAfterFirst);
  assert.deepEqual(world.comments, commentsAfterFirst);

  // Also while it is still open: a second start of the same head is refused as running, never attached to.
  const { issue: other, world: otherWorld } = await stoppedAtHostIntegration();
  handFix(otherWorld, otherWorld.head2);
  otherWorld.reviewed.delete(otherWorld.head2); // the gate holds, so the run stays open
  const first = await startResume(other, { decisionTimeoutMs: 30_000 });
  assert.equal(first.status, 'started');
  const second = await startResume(other);
  assert.deepEqual(second, { status: 'already_running', workflowId: resumeWorkflowId(other, otherWorld.head2) });
  await client.workflow.getHandle(resumeWorkflowId(other, otherWorld.head2)).terminate('test is done');
});

test('even if the closed resume run is deleted and started again, the check is not run twice and no statement is posted twice: the keys are the full run\'s', { timeout: 120_000 }, async () => {
  const { issue, world } = await stoppedAtHostIntegration();
  handFix(world, world.head2);
  await startResume(issue);
  await resultOf(resumeWorkflowId(issue, world.head2));
  const runs = [...world.runs];
  const writes = [...world.statusWrites];
  const comments = new Map(world.comments);
  const needBefore = world.count('commentIssue');

  // The same input under a fresh ID, as a person who deleted the closed run would start it.
  const input: IssueWorkflowInput = { ...buildResumeInput(resumeFlags(issue)), ...FAST, base: BASE, resume: { pr: issue + PR_OFFSET, headSha: world.head2 } };
  const handle = await client.workflow.start(ISSUE_WORKFLOW_NAME, { taskQueue: QUEUE, workflowId: `${resumeWorkflowId(issue, world.head2)}-again`, args: [input], workflowExecutionTimeout: ISSUE_RUN_TIMEOUT });
  const result = (await handle.result()) as IssueRunResult;

  assert.equal(result.outcome, 'resumed_gate_clear');
  assert.ok(world.count('commentIssue') > needBefore, 'the statement was offered again');
  assert.deepEqual(world.runs, runs, 'the head already has a success: the suite is not run again');
  assert.deepEqual(world.statusWrites, writes);
  assert.deepEqual(world.comments, comments, 'the keyed statement is not posted twice');
});

test('a new head never reuses an older head\'s review, status or statement: the next hand fix is re-gated on its own', { timeout: 120_000 }, async () => {
  const { issue, world } = await stoppedAtHostIntegration();
  const pr = issue + PR_OFFSET;
  handFix(world, world.head2);
  await startResume(issue);
  await resultOf(resumeWorkflowId(issue, world.head2));
  assert.deepEqual(world.runs, [world.head1, world.head2]);

  // Another push: head 3 has no review yet. The head 2 pass and statement are on head 2 only.
  world.prHead = world.head3;
  const held = await startResume(issue, { decisionTimeoutMs: 30_000 });
  assert.equal(held.status, 'started');
  assert.equal('workflowId' in held && held.workflowId, resumeWorkflowId(issue, world.head3), 'a new head has its own run');
  await until('the gate to be read for head 3', () => world.count('getGateStatus') >= 6);
  assert.deepEqual(world.runs, [world.head1, world.head2], 'no review on head 3: no check, whatever head 2 passed');
  assert.equal(world.comments.has(`gate-clear-${pr}-${world.head3}`), false, 'no statement for a head the gate has not cleared');
  assert.equal(world.statuses.has(world.head3), false);

  // The review lands: head 3 is checked and stated, and head 2's statement stays what it was.
  const statementOfHead2 = world.comments.get(`gate-clear-${pr}-${world.head2}`);
  world.reviewed.add(world.head3);
  const result = await resultOf(resumeWorkflowId(issue, world.head3));
  assert.equal(result.outcome, 'resumed_gate_clear');
  assert.equal('headSha' in result && result.headSha, world.head3);
  assert.deepEqual(world.runs, [world.head1, world.head2, world.head3]);
  assert.ok(world.comments.has(`gate-clear-${pr}-${world.head3}`));
  assert.deepEqual(world.comments.get(`gate-clear-${pr}-${world.head2}`), statementOfHead2);
  assert.match(world.comments.get(`gate-clear-${pr}-${world.head3}`)?.body ?? '', new RegExp(`head \`${world.head3}\``));
});

test('the gate checks stay in the loop: with no review on the head, or an open thread, the run holds and runs no check', { timeout: 120_000 }, async () => {
  for (const hold of ['no_review', 'open_thread'] as const) {
    const { issue, world } = newWorld((w) => {
      w.issueStatus = 'In review';
      w.prStatus = 'In review';
      if (hold === 'open_thread') {
        w.reviewed.add(w.head1);
        w.threads = 1;
      }
    });
    const started = await startResume(issue);
    assert.equal(started.status, 'started', hold);
    await until('a few gate reads', () => world.count('getGateStatus') >= 4);
    assert.deepEqual(world.runs, [], hold);
    assert.equal(world.count('getHostIntegrationNeed'), 0, `${hold}: the check is for a head the review settled`);
    assert.equal(world.comments.size, 0, hold);

    // Once the person's review is on the head and the thread is resolved, the same run goes on.
    world.reviewed.add(world.head1);
    world.threads = 0;
    const result = await resultOf(resumeWorkflowId(issue, world.head1));
    assert.equal(result.outcome, 'resumed_gate_clear', hold);
    assert.deepEqual(world.runs, [world.head1], hold);
  }
});

test('with the host check off the gate is the review and the threads, and the statement says the check was not asked for', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.issueStatus = 'In review';
    w.reviewed.add(w.head1);
  });

  await startResume(issue, {}, false);
  const result = await resultOf(resumeWorkflowId(issue, world.head1));

  assert.equal(result.outcome, 'resumed_gate_clear');
  assert.deepEqual(world.runs, []);
  assert.match(world.comments.get(`gate-clear-${issue + PR_OFFSET}-${world.head1}`)?.body ?? '', /host\/integration: not asked for in this run/);
});

test('a check that fails again on the new head stops the resume at host_integration with a comment of its own, not silenced by the first stop\'s key', { timeout: 120_000 }, async () => {
  const { issue, world } = await stoppedAtHostIntegration();
  handFix(world, world.head2);
  world.hostSteps = [{ outcome: 'fail', passed: 81, failed: 1 }];
  const pr = issue + PR_OFFSET;

  await startResume(issue);
  const id = resumeWorkflowId(issue, world.head2);

  assert.deepEqual(await stoppedWith(id), { step: 'host_integration', reason: 'IntegrationFailed' });
  const suffix = resumeKeySuffix(world.head2);
  const key = `stopped-host_integration-IntegrationFailed${suffix}`;
  assert.ok(world.comments.has(key), 'the stop comment on the issue');
  assert.ok(world.comments.has(`stopped-pr-host_integration-IntegrationFailed${suffix}`), 'and on the PR');
  assert.match(world.comments.get(key)?.body ?? '', new RegExp(`workflow \`${id}\``));
  assert.match(world.comments.get(key)?.body ?? '', /fail \(81 passed, 1 failed\)/);
  assert.equal(world.comments.get(key)?.target, issue);
  assert.equal(world.comments.get(`stopped-pr-host_integration-IntegrationFailed${suffix}`)?.target, pr);
  assert.ok(world.comments.has('stopped-host_integration-IntegrationFailed'), 'the first stop\'s comment is still there');
  assert.equal(world.comments.has(`gate-clear-${pr}-${world.head2}`), false, 'a failed check clears nothing');
  assert.deepEqual(world.statusWrites.slice(-2), ['b:pending:no counts', 'b:failure:81 passed, 1 failed']);
});

// ---- refusals ------------------------------------------------------------------------------------------------------

test('a start that does not fit is refused with a fixed word before anything is started or called on a run', { timeout: 120_000 }, async () => {
  const cases: readonly (readonly [string, (world: World) => void, string])[] = [
    ['issue closed', (w) => void (w.issueOpen = false), 'issue_closed'],
    ['not In review (Ready)', (w) => void (w.issueStatus = 'Ready'), 'issue_not_in_review'],
    ['not In review (In progress)', (w) => void (w.issueStatus = 'In progress'), 'issue_not_in_review'],
    ['not In review (Done)', (w) => void (w.issueStatus = 'Done'), 'issue_not_in_review'],
    ['no open PR (merged or closed)', (w) => void (w.openPrs = 0), 'no_open_pr'],
    ['more than one open PR', (w) => void (w.openPrs = 2), 'several_open_prs'],
  ];
  for (const [name, configure, reason] of cases) {
    const { issue, world } = newWorld((w) => {
      w.issueStatus = 'In review';
      w.reviewed.add(w.head1);
      configure(w);
    });
    const outcome = await startResume(issue);

    assert.deepEqual(outcome, { status: 'refused', reason }, name);
    assert.ok(RESUME_REFUSALS.includes(reason as (typeof RESUME_REFUSALS)[number]), name);
    // Nothing was started, and no activity of the run was called (the entry point's own read is the resolver, not an activity).
    await assert.rejects(client.workflow.getHandle(resumeWorkflowId(issue, world.head1)).describe(), WorkflowNotFoundError, name);
    assert.deepEqual([...world.calls.keys()], [], name);
    assert.deepEqual([...world.comments.keys()], [], name);
    assert.deepEqual(world.statusWrites, [], name);
  }
});

test('a start is refused while the issue\'s own run is open: it holds the gate and the signal', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.hostSteps = [PASS];
    w.changedFiles = ['docs/atlas.md'];
  });
  await startFull(issue);
  await until('the full run to wait at the gate', () => world.prStatus === 'In review' && world.count('getGateStatus') >= 2);
  const calls = world.count('resolveResume');

  const outcome = await startResume(issue);

  assert.deepEqual(outcome, { status: 'refused', reason: 'run_open' });
  assert.equal(world.count('resolveResume'), calls, 'refused before the PR was read');
  await assert.rejects(client.workflow.getHandle(resumeWorkflowId(issue, world.head1)).describe(), WorkflowNotFoundError);
  await client.workflow.getHandle(issueWorkflowId(issue)).terminate('test is done');
});

test('the workflow reads the PR again and refuses a head, a PR or a base that is not what the run was started for, so a stale head is never gated', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.issueStatus = 'In review';
    w.reviewed.add(w.head1);
    w.reviewed.add(w.head2);
  });
  const pr = issue + PR_OFFSET;
  const run = async (name: string, resume: { pr: number; headSha: string }, base = BASE): Promise<IssueRunResult> => {
    const input: IssueWorkflowInput = { ...buildResumeInput(resumeFlags(issue)), ...FAST, base, resume };
    const handle = await client.workflow.start(ISSUE_WORKFLOW_NAME, { taskQueue: QUEUE, workflowId: `issue-${issue}-stale-${name}`, args: [input], workflowExecutionTimeout: ISSUE_RUN_TIMEOUT });
    return (await handle.result()) as IssueRunResult;
  };

  // The entry point read head 1; a push made the PR show head 2 before the run read it again.
  world.prHead = world.head2;
  assert.deepEqual(await run('head', { pr, headSha: world.head1 }), { outcome: 'refused', issueNumber: issue, reason: 'pr_changed' });
  assert.deepEqual(await run('pr', { pr: pr + 1, headSha: world.head2 }), { outcome: 'refused', issueNumber: issue, reason: 'pr_changed' });
  assert.deepEqual(await run('base', { pr, headSha: world.head2 }, 'main'), { outcome: 'refused', issueNumber: issue, reason: 'pr_changed' });
  assert.deepEqual(world.runs, []);
  assert.equal(world.count('getHostIntegrationNeed'), 0);
  assert.equal(world.comments.size, 0, 'a refusal leaves no comment');

  // The same run for the head that is there goes through.
  assert.equal((await run('fresh', { pr, headSha: world.head2 })).outcome, 'resumed_gate_clear');
});

test('the workflow answers the entry point\'s refusals too, when the issue changed between the entry point\'s read and the run\'s: a result, not a failure', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.issueStatus = 'In review';
    w.reviewed.add(w.head1);
  });
  const input: IssueWorkflowInput = { ...buildResumeInput(resumeFlags(issue)), ...FAST, base: BASE, resume: { pr: issue + PR_OFFSET, headSha: world.head1 } };
  const results: IssueRunResult[] = [];
  for (const [name, configure, reason] of [
    ['closed', (w: World) => void (w.issueOpen = false), 'issue_closed'],
    ['moved on', (w: World) => void (w.issueStatus = 'Done'), 'issue_not_in_review'],
    ['no pr', (w: World) => void (w.openPrs = 0), 'no_open_pr'],
    ['two prs', (w: World) => void (w.openPrs = 2), 'several_open_prs'],
  ] as const) {
    world.issueOpen = true;
    world.issueStatus = 'In review';
    world.openPrs = 1;
    configure(world);
    const handle = await client.workflow.start(ISSUE_WORKFLOW_NAME, { taskQueue: QUEUE, workflowId: `issue-${issue}-late-${name.replace(' ', '-')}`, args: [input], workflowExecutionTimeout: ISSUE_RUN_TIMEOUT });
    const result = (await handle.result()) as IssueRunResult;
    results.push(result);
    assert.deepEqual(result, { outcome: 'refused', issueNumber: issue, reason }, name);
  }
  assert.equal(results.length, 4);
  assert.deepEqual(world.runs, []);
  assert.equal(world.comments.size, 0);
});
