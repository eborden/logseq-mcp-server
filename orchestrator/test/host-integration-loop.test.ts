// The host integration check at the gate (#648, plan #643) against a real Temporal server (an in-memory dev server on
// a free port) and no real service: GitHub, the model and the suite are fakes that model one PR with counters. Nothing
// here calls GitHub, `claude` or LogSeq. Every name is made up (issue 123, project atlas, Alice).
//
// Two workers, as in production: one on the default queue (GitHub, sessions, branches) and one on the `host` queue
// that has only `runHostIntegration`. The waits are real but short (a second or two through the input); the retry
// backoffs of the policies are real too, so the tests that wait on a retry take 5 to 10 seconds.
//
// The workers run with `maxCachedWorkflows: 0`, so every workflow task replays the whole history.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/activity';
import { WorkflowFailedError } from '@temporalio/client';
import type { Client } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import type { WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { maintainerDecisionSignal } from '../src/approval-types.ts';
import { loadServerConfig } from '../src/config.ts';
import { startDevServer } from '../src/dev-server.ts';
import { HOST_TASK_QUEUE_NAME } from '../src/host-integration-policy.ts';
import type { HostIntegrationInput, HostIntegrationResult } from '../src/host-integration-policy.ts';
import { buildHostDescription, parseHostStatusInput } from '../src/integration-policy.ts';
import { ISSUE_STOPPED_FAILURE, hostIntegrationForFlag, issueWorkflowId, parseIssueWorkflowInput } from '../src/issue-types.ts';
import type { IssueRunResult, IssueWorkflowInput } from '../src/issue-types.ts';
import { startIssueRun } from '../src/issue-client.ts';
import type { BoardItemRef } from '../src/types.ts';
import { freePort } from './support.ts';

const WORKFLOWS_PATH = fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url));
/** A head of one issue's world: the issue number in the first 8 digits, then the letter. Unique per world, so the shared fakes find their world by sha. */
const shaOf = (issue: number, letter: 'a' | 'b'): string => `${String(issue).padStart(8, '0')}${letter.repeat(32)}`;
const issueOfSha = (sha: string): number => Number(sha.slice(0, 8));
const PR_OFFSET = 1000;
const QUEUE = 'host-loop-fakes';
const APPROVED = { decision: 'approved', at: '2025-03-04', message: 'Ship it, project atlas is ready.' };

// ---- the input ---------------------------------------------------------------------------------------------------

test('the workflow input takes hostIntegration auto or off, and refuses anything else', () => {
  const base = { issueNumber: 5, repoDir: '/work/repo', worktreeDir: '/work/wt', base: 'main' };
  assert.equal('hostIntegration' in parseIssueWorkflowInput(base), false, 'absent stays absent: the default is off');
  assert.equal(parseIssueWorkflowInput({ ...base, hostIntegration: 'auto' }).hostIntegration, 'auto');
  assert.equal(parseIssueWorkflowInput({ ...base, hostIntegration: 'off' }).hostIntegration, 'off');
  for (const bad of ['on', 'AUTO', true, 1, null, {}]) {
    assert.throws(() => parseIssueWorkflowInput({ ...base, hostIntegration: bad }), /hostIntegration must be auto or off/, JSON.stringify(bad));
  }
});

test('the --host-integration flag adds hostIntegration auto, and no field without it', () => {
  const base = { issueNumber: 5, repoDir: '/work/repo', worktreeDir: '/work/wt', base: 'main' };
  assert.deepEqual(hostIntegrationForFlag(true), { hostIntegration: 'auto' });
  assert.deepEqual(hostIntegrationForFlag(false), {});
  assert.equal(parseIssueWorkflowInput({ ...base, ...hostIntegrationForFlag(true) }).hostIntegration, 'auto');
  assert.equal('hostIntegration' in parseIssueWorkflowInput({ ...base, ...hostIntegrationForFlag(false) }), false);
});

// ---- a model of one PR --------------------------------------------------------------------------------------------

let env: TestWorkflowEnvironment;
let client: Client;
let bundle: WorkflowBundleWithSourceMap;
const workers: { worker: Worker; running: Promise<void> }[] = [];
let releaseHang: () => void = () => undefined;
const hang = new Promise<void>((resolve) => {
  releaseHang = resolve;
});

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
    // Production runs one at a time. Here a hung attempt (the fake never returns and never heartbeats) would hold the one slot and
    // starve its own retry, so the test worker has a second.
    maxConcurrentActivityTaskExecutions: 2,
  });
  workers.push({ worker: main, running: main.run() }, { worker: host, running: host.run() });
});

after(async () => {
  releaseHang();
  for (const { worker } of workers) {
    worker.shutdown();
  }
  await Promise.allSettled(workers.map(({ running }) => running));
  await env?.teardown();
});

type HostStep = HostIntegrationResult | 'throw_setup' | 'hang' | 'die_once';

class World {
  merged = false;
  issueOpen = true;
  /** Gate reads (1-based) before this one show the head as not settled. Read 1 is the review loop's and is always settled. 0 means always settled. */
  settleAtRead = 0;
  gateReads = 0;
  /** What the gate shows on an unsettled read. */
  unsettled = { reviewsOnHead: 0, unresolvedThreads: 1 };
  prHead = '';
  head1 = '';
  head2 = '';
  /** The files the PR changes, as the activity sees them (the rule over them is the real one). */
  changedFiles: string[] = ['docs/atlas.md'];
  /** The `host/integration` status of each commit: its latest state and description. */
  readonly statuses = new Map<string, { state: string; description: string }>();
  /** Every status write that changed something, in order: `<sha letter>:<state>:<description>`. */
  readonly statusWrites: string[] = [];
  /** What each run of the suite does, in order. The last entry repeats. */
  hostSteps: HostStep[] = [{ outcome: 'pass', passed: 82, failed: 0 }];
  readonly runs: string[] = [];
  /** The sha of every `getHostIntegration` read, in order: the gate must read the head it is judging, never an earlier one. */
  readonly readShas: string[] = [];
  /** How many reads had happened when the gate first showed the new head. */
  gateSwitchedAt: number | undefined;
  runAttempts = 0;
  /** Blocks the run of this head until released (a test that needs to look at the gate while the check is under way). */
  blockRun: Map<string, Promise<void>> = new Map();
  issueStatus = 'Ready';
  prStatus: string | undefined;
  readonly boardWrites: string[] = [];
  readonly comments = new Map<string, { body: string; target: number }>();
  readonly counters = { need: 0, read: 0, post: 0 };
  /** Throws once after the named write has happened, as a worker that died after the side effect would. */
  readonly loseOnce = new Set<string>();

  lose(name: string): void {
    if (this.loseOnce.delete(name)) {
      throw new Error('simulated: the worker died after the side effect');
    }
  }
}

const worlds = new Map<number, World>();
let nextIssue = 700;

function newWorld(configure: (world: World) => void = () => undefined): { issue: number; world: World } {
  nextIssue += 1;
  const world = new World();
  world.head1 = shaOf(nextIssue, 'a');
  world.head2 = shaOf(nextIssue, 'b');
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
  w.runAttempts += 1;
  const blocked = w.blockRun.get(input.headSha);
  if (blocked !== undefined) {
    await blocked;
  }
  const index = Math.min(w.runs.length, w.hostSteps.length - 1);
  const step = w.hostSteps[index];
  assert.ok(step);
  if (step === 'die_once') {
    w.hostSteps = w.hostSteps.slice(index + 1).length === 0 ? [{ outcome: 'pass', passed: 82, failed: 0 }] : w.hostSteps.slice(index + 1);
    throw new Error('simulated: the host worker died during the run');
  }
  w.runs.push(input.headSha);
  if (step === 'throw_setup') {
    throw ApplicationFailure.nonRetryable('setup failed', 'HostSetupFailed');
  }
  if (step === 'hang') {
    await hang;
    return { outcome: 'pass', passed: 1, failed: 0 };
  }
  return step;
}

function fakeActivities() {
  const board = (target: BoardItemRef): { w: World; kind: 'issue' | 'pr' } => ({
    w: worldOfIssue(target.kind === 'pr' ? target.number - PR_OFFSET : target.number),
    kind: target.kind,
  });
  return {
    checkIssue: async (issue: number) => ({ number: issue, open: worldOfIssue(issue).issueOpen, trustedComments: 1, droppedUntrustedComments: 0 }),
    claimIssue: async (issue: number) => {
      worldOfIssue(issue).issueStatus = 'In progress';
      return { claimed: true, reason: 'claimed' as const, proceed: true };
    },
    runImplementerSession: async (raw: IssueWorkflowInput) => ({ branch: `claude/${raw.issueNumber}`, headSha: shaOf(raw.issueNumber, 'a'), exitStatus: 'success' as const }),
    guardBranch: async (raw: { branch: string; headSha: string }) => ({ branch: raw.branch, headSha: raw.headSha, files: 1 }),
    pushBranch: async (raw: { branch: string; headSha: string }) => ({ branch: raw.branch, headSha: raw.headSha }),
    openPr: async (input: { head: string }) => {
      const issue = Number(/^claude\/(\d+)$/.exec(input.head)?.[1]);
      return { number: issue + PR_OFFSET, url: `https://github.com/eborden/logseq-mcp-server/pull/${issue + PR_OFFSET}`, created: true };
    },
    addToBoard: async (target: BoardItemRef) => {
      const { w } = board(target);
      const added = w.prStatus === undefined;
      w.prStatus ??= 'Backlog';
      return { kind: target.kind, number: target.number, itemId: 'PVTI_x', added, status: w.prStatus };
    },
    getBoardStatus: async (target: BoardItemRef) => {
      const { w, kind } = board(target);
      const status = kind === 'pr' ? w.prStatus : w.issueStatus;
      return { kind, number: target.number, onBoard: status !== undefined, status: status ?? null };
    },
    setStatus: async (target: BoardItemRef, status: string) => {
      const { w, kind } = board(target);
      if (kind === 'pr') {
        w.prStatus = status;
      } else {
        w.issueStatus = status;
      }
      w.boardWrites.push(`${kind}:${status}`);
      return { changed: true, status };
    },
    runReviewerSession: async () => ({ findings: 0, acceptedThreadIds: [] }),
    postSessionReview: async () => ({ reviewId: 1, posted: true, comments: 0, advisory: 0, omitted: 0 }),
    // Every head the PR shows has one review and no thread: the gate's own half is clear, so the host check is what decides.
    getGateStatus: async (pr: number) => {
      const w = worldOfIssue(pr - PR_OFFSET);
      if (w.prHead === w.head2) {
        w.gateSwitchedAt ??= w.readShas.length;
      }
      w.gateReads += 1;
      const settled = w.gateReads === 1 || w.gateReads >= w.settleAtRead;
      const counts = settled ? { reviewsOnHead: 1, unresolvedThreads: 0 } : w.unsettled;
      return { headSha: w.prHead, ...counts, clear: counts.reviewsOnHead >= 1 && counts.unresolvedThreads === 0 };
    },
    commentIssue: async (input: { issue: number; key: string; body: string }) => {
      const w = worldOfIssue(input.issue >= PR_OFFSET ? input.issue - PR_OFFSET : input.issue);
      const posted = !w.comments.has(input.key);
      if (posted) {
        w.comments.set(input.key, { body: input.body, target: input.issue });
      }
      return { commentId: 1, posted };
    },
    getPrState: async (pr: number) => {
      const w = worldOfIssue(pr - PR_OFFSET);
      return { state: 'open' as const, merged: w.merged, headSha: w.prHead };
    },
    getPrChanges: async () => ({ files: 0, golden: 0, ceilings: 0, adrs: 0, businessRules: 0, complete: true }),
    closeIssue: async (issue: number) => {
      worldOfIssue(issue).issueOpen = false;
      return { changed: true, closed: true as const };
    },
    getHostIntegrationNeed: async (pr: number) => {
      const w = worldOfIssue(pr - PR_OFFSET);
      w.counters.need += 1;
      // The real activity applies the rule of integration-policy.ts; the fake uses the same rule through the real function.
      const { needsHostIntegration } = await import('../src/integration-policy.ts');
      return { needed: needsHostIntegration(w.changedFiles, true) };
    },
    getHostIntegration: async (input: { sha: string }) => {
      const w = worldOfIssue(issueOfSha(input.sha));
      w.counters.read += 1;
      w.readShas.push(input.sha);
      const current = w.statuses.get(input.sha);
      return current === undefined ? { state: 'none' as const } : { state: current.state as 'pending' | 'success' | 'failure' | 'error' };
    },
    postCommitStatus: async (raw: unknown) => {
      const input = parseHostStatusInput(raw);
      const w = worldOfIssue(issueOfSha(input.sha));
      w.counters.post += 1;
      const description = buildHostDescription(input.counts);
      const current = w.statuses.get(input.sha);
      const posted = !(current?.state === input.state && current.description === description);
      if (posted) {
        w.statuses.set(input.sha, { state: input.state, description });
        w.statusWrites.push(`${input.sha[8]}:${input.state}:${description}`);
      }
      w.lose(`postCommitStatus:${input.state}`);
      return { posted };
    },
  };
}

const FAST = { awaitDecision: true, decisionTimeoutMs: 30_000, decisionPollMs: 500 };

function startRun(issue: number, extra: Partial<IssueWorkflowInput> = {}) {
  const input: IssueWorkflowInput = { issueNumber: issue, repoDir: '/work/repo', worktreeDir: `/work/repo/.claude/worktrees/issue-${issue}`, base: 'main', ...FAST, ...extra };
  return startIssueRun(client, QUEUE, input).then((started) => {
    assert.equal(started.status, 'started');
    return client.workflow.getHandle(issueWorkflowId(issue));
  });
}

async function resultOf(issue: number): Promise<IssueRunResult> {
  const result: unknown = await client.workflow.getHandle(issueWorkflowId(issue)).result();
  return result as IssueRunResult;
}

async function until(what: string, ready: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function stoppedWith(issue: number): Promise<{ step: unknown; reason: unknown }> {
  try {
    await client.workflow.getHandle(issueWorkflowId(issue)).result();
  } catch (error) {
    assert.ok(error instanceof WorkflowFailedError);
    assert.ok(error.cause instanceof ApplicationFailure);
    assert.equal(error.cause.type, ISSUE_STOPPED_FAILURE);
    const [step, reason] = error.cause.details ?? [];
    return { step, reason };
  }
  return assert.fail('the run should have stopped');
}

async function approveAndMerge(issue: number, world: World): Promise<IssueRunResult> {
  const handle = client.workflow.getHandle(issueWorkflowId(issue));
  await handle.signal(maintainerDecisionSignal, APPROVED);
  await until('the decision comment', () => world.comments.has(`decision-${issue + PR_OFFSET}`));
  world.merged = true;
  return await resultOf(issue);
}

const noHostCalls = (world: World): void => {
  assert.deepEqual(world.counters, { need: 0, read: 0, post: 0 });
  assert.deepEqual(world.runs, []);
  assert.deepEqual(world.statusWrites, []);
};

// ---- off (the default) ---------------------------------------------------------------------------------------------

test('with hostIntegration off or absent no host activity is called, even for a change under src/', { timeout: 120_000 }, async () => {
  for (const extra of [{}, { hostIntegration: 'off' as const }]) {
    const { issue, world } = newWorld((w) => {
      w.changedFiles = ['src/atlas.rs'];
    });
    await startRun(issue, extra);
    await until('the run to wait at the gate', () => world.prStatus === 'In review');
    const result = await approveAndMerge(issue, world);
    assert.equal(result.outcome, 'merged');
    noHostCalls(world);
  }
});

// ---- auto ----------------------------------------------------------------------------------------------------------

test('auto with a docs-only change: the check is skipped, nothing is posted and the gate is as before', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.changedFiles = ['docs/atlas.md', 'orchestrator/src/atlas.ts'];
  });
  await startRun(issue, { hostIntegration: 'auto' });
  const result = await approveAndMerge(issue, world);
  assert.equal(result.outcome, 'merged');
  assert.ok(world.counters.need >= 1, 'the classifier ran');
  assert.deepEqual({ read: world.counters.read, post: world.counters.post, runs: world.runs, writes: world.statusWrites }, { read: 0, post: 0, runs: [], writes: [] });
});

test('auto with a change under src/: pending, then success with counts, then the run waits for the decision as before', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.changedFiles = ['docs/atlas.md', 'src/atlas.rs'];
  });
  await startRun(issue, { hostIntegration: 'auto' });
  await until('the pass to be recorded', () => world.statusWrites.length === 2);
  assert.deepEqual(world.statusWrites, ['a:pending:no counts', 'a:success:82 passed, 0 failed']);
  assert.deepEqual(world.runs, [world.head1]);
  assert.equal(world.comments.size, 0, 'a pass comments nothing');
  assert.equal(world.merged, false, 'the workflow merges nothing');

  const result = await approveAndMerge(issue, world);

  assert.equal(result.outcome, 'merged');
  assert.deepEqual(world.runs, [world.head1], 'one run for the head, however many gate reads follow');
  assert.deepEqual(world.statusWrites, ['a:pending:no counts', 'a:success:82 passed, 0 failed']);
});

test('a change to the integration tests, a fixture or a Cargo file is checked as well; the orchestrator is not the server', { timeout: 120_000 }, async () => {
  for (const [changed, runs] of [
    [['tests/fixtures/graph/pages/atlas.md'], 1],
    [['Cargo.lock'], 1],
    [['orchestrator/src/atlas.ts', 'orchestrator/test/atlas.test.ts'], 0],
  ] as const) {
    const { issue, world } = newWorld((w) => {
      w.changedFiles = [...changed];
    });
    await startRun(issue, { hostIntegration: 'auto' });
    await until('the gate', () => world.prStatus === 'In review' && world.counters.need >= 1);
    const result = await approveAndMerge(issue, world);
    assert.equal(result.outcome, 'merged');
    assert.equal(world.runs.length, runs, changed.join(','));
  }
});

test('a failing run posts pending then failure, comments once with counts, and stops with IntegrationFailed: no fixer, no decision', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.changedFiles = ['src/atlas.rs'];
    w.hostSteps = [{ outcome: 'fail', passed: 80, failed: 2 }];
  });
  await startRun(issue, { hostIntegration: 'auto' });

  assert.deepEqual(await stoppedWith(issue), { step: 'host_integration', reason: 'IntegrationFailed' });

  assert.deepEqual(world.statusWrites, ['a:pending:no counts', 'a:failure:80 passed, 2 failed']);
  assert.deepEqual([...world.comments.keys()], ['stopped-host_integration-IntegrationFailed', 'stopped-pr-host_integration-IntegrationFailed']);
  const comment = world.comments.get('stopped-host_integration-IntegrationFailed');
  assert.match(comment?.body ?? '', /fail \(80 passed, 2 failed\)/);
  assert.equal(comment?.target, issue, 'the comment is on the issue');
  assert.equal(world.comments.get('stopped-pr-host_integration-IntegrationFailed')?.target, issue + PR_OFFSET, 'the one-line stop is on the PR too (#715)');
  assert.deepEqual(world.runs, [world.head1], 'a failing check is not run again');
  assert.equal(world.boardWrites.includes('pr:Done'), false);
});

test('conflict, fixture_dirty and setup_error are errors, never failures, and each stops for a person with its own reason', { timeout: 120_000 }, async () => {
  const cases: { result: HostIntegrationResult; state: string; description: string; reason: string }[] = [
    { result: { outcome: 'conflict', passed: 0, failed: 0 }, state: 'error', description: 'no counts', reason: 'IntegrationConflict' },
    { result: { outcome: 'fixture_dirty', passed: 82, failed: 0 }, state: 'error', description: '82 passed, 0 failed', reason: 'IntegrationFixtureDirty' },
    { result: { outcome: 'setup_error', passed: 0, failed: 0 }, state: 'error', description: 'no counts', reason: 'IntegrationSetupError' },
  ];
  for (const { result, state, description, reason } of cases) {
    const { issue, world } = newWorld((w) => {
      w.changedFiles = ['scripts/atlas.ts'];
      w.hostSteps = [result];
    });
    await startRun(issue, { hostIntegration: 'auto' });
    assert.deepEqual(await stoppedWith(issue), { step: 'host_integration', reason });
    assert.deepEqual(world.statusWrites, ['a:pending:no counts', `a:${state}:${description}`], reason);
  }
});

test('a head with a success is not run again, and a pass on an earlier head does not clear a later one', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.changedFiles = ['src/atlas.rs'];
    w.statuses.set(w.head1, { state: 'success', description: '82 passed, 0 failed' });
  });
  let release: () => void = () => undefined;
  world.blockRun.set(world.head2, new Promise<void>((resolve) => { release = resolve; }));
  const handle = await startRun(issue, { hostIntegration: 'auto' });
  // Read 1 is the check's own look at the head, read 2 the gate's, after the check has been judged: only then is "not run" settled.
  await until('the gate to be read on the head with a pass', () => world.counters.read >= 2);
  assert.deepEqual(world.runs, [], 'a success already on the head is not run again');
  assert.deepEqual(world.statusWrites, []);

  // Alice pushes: the head moves. The pass on the old head is a status on another sha, so it clears nothing.
  world.prHead = world.head2;
  await handle.signal(maintainerDecisionSignal, APPROVED);
  await until('the check on the new head to start', () => world.runAttempts === 1);
  assert.deepEqual(world.statusWrites, ['b:pending:no counts']);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(world.comments.has(`decision-${issue + PR_OFFSET}`), false, 'the old pass does not clear the gate on the new head');

  release();
  await until('the decision comment', () => world.comments.has(`decision-${issue + PR_OFFSET}`));
  world.merged = true;
  assert.equal((await resultOf(issue)).outcome, 'merged');
  assert.deepEqual(world.runs, [world.head2]);
  assert.deepEqual(world.statusWrites, ['b:pending:no counts', 'b:success:82 passed, 0 failed']);
  const after = world.readShas.slice(world.gateSwitchedAt);
  assert.ok(after.length >= 2, 'the gate read the status after the push');
  assert.deepEqual([...new Set(after)], [world.head2], 'every read after the gate shows the new head is of the new head: a status on another sha is never read for the gate');
});

test('a worker that dies after the status write repeats the post and leaves one visible status; the run is not repeated', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.changedFiles = ['src/atlas.rs'];
    w.loseOnce.add('postCommitStatus:success');
  });
  await startRun(issue, { hostIntegration: 'auto' });
  await until('the success to be recorded', () => world.counters.post >= 3, 60_000);
  const result = await approveAndMerge(issue, world);

  assert.equal(result.outcome, 'merged');
  assert.deepEqual(world.statusWrites, ['a:pending:no counts', 'a:success:82 passed, 0 failed']);
  assert.deepEqual(world.runs, [world.head1]);
});

test('a host worker that dies mid-run is retried once by the policy: one pending, one success', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.changedFiles = ['src/atlas.rs'];
    w.hostSteps = ['die_once', { outcome: 'pass', passed: 82, failed: 0 }];
  });
  await startRun(issue, { hostIntegration: 'auto' });
  await until('the success', () => world.statusWrites.length === 2, 60_000);
  assert.equal(world.runAttempts, 2);
  assert.deepEqual(world.statusWrites, ['a:pending:no counts', 'a:success:82 passed, 0 failed']);
  assert.equal((await approveAndMerge(issue, world)).outcome, 'merged');
});

test('a setup failure thrown by the host activity is an error status and a stop, not a failure and not a pass', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.changedFiles = ['src/atlas.rs'];
    w.hostSteps = ['throw_setup'];
  });
  await startRun(issue, { hostIntegration: 'auto' });

  assert.deepEqual(await stoppedWith(issue), { step: 'host_integration', reason: 'IntegrationSetupError' });
  assert.deepEqual(world.statusWrites, ['a:pending:no counts', 'a:error:no counts']);
});

test('a check that never finishes ends at the activity bound with a stop for a person, not an open wait', { timeout: 200_000 }, async () => {
  // The fake never heartbeats, so the policy's 30 second heartbeat timeout ends each attempt, and the one retry ends it again.
  const { issue, world } = newWorld((w) => {
    w.changedFiles = ['src/atlas.rs'];
    w.hostSteps = ['hang'];
  });
  await startRun(issue, { hostIntegration: 'auto' });

  assert.deepEqual(await stoppedWith(issue), { step: 'host_integration', reason: 'IntegrationTimeout' });
  assert.deepEqual(world.statusWrites, ['a:pending:no counts', 'a:error:no counts']);
  assert.ok(world.runAttempts <= 2, 'no more attempts than the policy allows');
  releaseHang();
});

test('only a settled head is checked: a head with no review, or an open thread, spends nothing on the host until the gate settles', { timeout: 120_000 }, async () => {
  for (const unsettled of [{ reviewsOnHead: 0, unresolvedThreads: 0 }, { reviewsOnHead: 1, unresolvedThreads: 1 }]) {
    const { issue, world } = newWorld((w) => {
      w.changedFiles = ['src/atlas.rs'];
      w.settleAtRead = 6;
      w.unsettled = unsettled;
    });
    await startRun(issue, { hostIntegration: 'auto' });
    await until('several unsettled gate reads', () => world.gateReads >= 5);
    assert.deepEqual(world.counters, { need: 0, read: 0, post: 0 }, JSON.stringify(unsettled));
    assert.deepEqual(world.runs, []);
    assert.deepEqual(world.statusWrites, []);

    await until('the run after the gate settles', () => world.statusWrites.length === 2);
    assert.deepEqual(world.runs, [world.head1], 'checked once, when settled');
    assert.equal((await approveAndMerge(issue, world)).outcome, 'merged');
    assert.deepEqual(world.runs, [world.head1]);
  }
});

test('with awaitDecision false and hostIntegration auto the run ends at the review loop and the check is not run (documented)', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.changedFiles = ['src/atlas.rs'];
  });
  await startRun(issue, { hostIntegration: 'auto', awaitDecision: false });

  assert.equal((await resultOf(issue)).outcome, 'gate_clear');
  noHostCalls(world);
});
