// The park of a remote implementer that stopped for a person (#698, plan #696): the run comments once, moves the issue to
// Needs Input, waits (bounded) for a trusted answer, then fires the next attempt and carries on into the guard and the PR.
// A real Temporal dev server runs the workflow, with fake activities that count each side effect; every task replays the
// whole history (`maxCachedWorkflows: 0`). No GitHub, no model, no real git, no LogSeq. Every name is made up.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/activity';
import { WorkflowFailedError } from '@temporalio/client';
import type { Client } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { loadServerConfig } from '../src/config.ts';
import { startDevServer } from '../src/dev-server.ts';
import { NEEDS_INPUT_WAIT_CHUNK_MS, issueWorkflowId, needsInputParkCommentKey } from '../src/issue-types.ts';
import type { RemoteSessionResult } from '../src/remote-session-policy.ts';
import type { NeedsInputWaitInput, NeedsInputWaitResult } from '../src/types.ts';
import { freePort } from './support.ts';

const WORKFLOWS_PATH = fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url));
const QUEUE = 'needs-input-park-fakes';
const PR_OFFSET = 1000;
const SHA = 'd'.repeat(40);
/** Where a run that gets past the implementer ends: the fake remote reviewer finds a thread and the fake fixer does not run. */
const STOPS_AT_FIXER = 'fix_session';

const asked = (commentId = 31): RemoteSessionResult => ({ outcome: 'needs_input', commentId });
const pushed: RemoteSessionResult = { outcome: 'finished', sessionId: 'session_01AAA', headSha: SHA };

class World {
  readonly calls: Record<string, number> = {};
  readonly comments = new Map<string, string>();
  readonly attempts: number[] = [];
  /** The key of every commentIssue call, repeats included. */
  readonly commentCalls: string[] = [];
  readonly waits: NeedsInputWaitInput[] = [];
  /** Every Status the issue showed, in order, starting with the claim's. */
  readonly issueStatuses: string[] = [];
  boardFault = false;
  /** Set by a test that wants to look at the run while the wait is open. */
  hold: Promise<void> | undefined;
  onWait: (() => void) | undefined;
  /** What the wait activity answers, call by call; the last entry repeats. */
  waitScript: ((call: number) => NeedsInputWaitResult | 'fault') = () => ({ answered: false });
  constructor(readonly sessions: (attempt: number) => RemoteSessionResult) {}
  called(name: string): number {
    return this.calls[name] ?? 0;
  }
  hit(name: string): void {
    this.calls[name] = this.called(name) + 1;
  }
  get status(): string | undefined {
    return this.issueStatuses.at(-1);
  }
}

const worlds = new Map<number, World>();
const worldOf = (issue: number): World => {
  const found = worlds.get(issue);
  assert.ok(found, `no world for issue ${issue}`);
  return found;
};
let nextIssue = 800;
const issueOfBranch = (branch: string): number => Number(/^claude\/(\d+)$/.exec(branch)?.[1]);

function fakeActivities() {
  return {
    checkIssue: async (issue: number) => ({ number: issue, open: true, trustedComments: 1, droppedUntrustedComments: 0 }),
    claimIssue: async (issue: number) => {
      const w = worldOf(issue);
      w.issueStatuses.push('In progress');
      return { claimed: true, reason: 'claimed' as const, proceed: true };
    },
    runRemoteImplementerSession: async (raw: { issueNumber: number; attempt: number }) => {
      const w = worldOf(raw.issueNumber);
      w.hit('runRemoteImplementerSession');
      w.attempts.push(raw.attempt);
      return w.sessions(raw.attempt);
    },
    waitForNeedsInputAnswer: async (input: NeedsInputWaitInput) => {
      const w = worldOf(input.issue);
      w.waits.push(input);
      w.onWait?.();
      await w.hold;
      const answer = w.waitScript(w.waits.length);
      if (answer === 'fault') {
        throw new Error('the worker was lost during the wait');
      }
      return answer;
    },
    guardRemoteBranch: async (raw: { branch: string; headSha: string }) => {
      worldOf(issueOfBranch(raw.branch)).hit('guardRemoteBranch');
      return { branch: raw.branch, headSha: raw.headSha, files: 1 };
    },
    deleteRemoteBranch: async () => ({ deleted: true }),
    openPr: async (input: { head: string }) => {
      const issue = issueOfBranch(input.head);
      worldOf(issue).hit('openPr');
      return { number: issue + PR_OFFSET, url: `https://github.com/eborden/logseq-mcp-server/pull/${issue + PR_OFFSET}`, created: true };
    },
    getPrState: async (pr: number) => ({ state: 'open' as const, merged: false, headSha: SHA, pr }),
    addToBoard: async (t: { kind: 'issue' | 'pr'; number: number }) => ({ kind: t.kind, number: t.number, itemId: 'PVTI_x', added: true, status: 'Backlog' }),
    getBoardStatus: async (t: { kind: 'issue' | 'pr'; number: number }) => {
      const status = t.kind === 'pr' ? 'In review' : worldOf(t.number).status;
      return { kind: t.kind, number: t.number, onBoard: status !== undefined, status: status ?? null };
    },
    setStatus: async (t: { kind: 'issue' | 'pr'; number: number }, status: string) => {
      if (t.kind === 'issue') {
        const w = worldOf(t.number);
        w.hit(`setStatus:${status}`);
        if (w.boardFault && (status === 'Needs Input' || (status === 'In progress' && w.status !== 'In progress'))) {
          throw ApplicationFailure.nonRetryable('the item is not on the board, or the option does not exist', 'InvalidState');
        }
        w.issueStatuses.push(status);
      }
      return { changed: true, status };
    },
    runRemoteReviewerSession: async (input: { issue: number }) => {
      worldOf(input.issue).hit('runRemoteReviewerSession');
      return { findings: 1, acceptedThreadIds: [], commentNodeId: 'IC_raw1' };
    },
    runRemoteFixerSession: async (input: { issue: number }) => {
      worldOf(input.issue).hit('runRemoteFixerSession');
      throw ApplicationFailure.nonRetryable('the remote fixer did not run (open_pr)', 'RemoteSessionFailed');
    },
    postRemoteSessionReview: async () => ({ reviewId: 2, posted: true, comments: 1, advisory: 0, omitted: 0, fileLevel: 0, nearest: 0 }),
    minimizeFindingsComment: async () => ({ minimized: true as const }),
    getGateStatus: async (pr: number) => ({ headSha: SHA, reviewsOnHead: 1, unresolvedThreads: 1, clear: false, pr }),
    listOpenThreads: async () => ({
      threads: [{ id: 'PRRT_1', path: 'src/a.ts', line: 1, trusted: true, comments: [{ id: 1, trusted: true, body: 'a made-up remark' }] }],
    }),
    commentIssue: async (input: { issue: number; key: string; body: string }) => {
      if (input.issue >= PR_OFFSET) {
        // A comment on the PR (#715): this suite follows the issue's comments only.
        return { commentId: 2, posted: true };
      }
      const w = worldOf(input.issue);
      const posted = !w.comments.has(input.key);
      w.comments.set(input.key, input.body);
      w.commentCalls.push(input.key);
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

function start(sessions: (attempt: number) => RemoteSessionResult, extra: Record<string, unknown> = {}) {
  nextIssue += 1;
  const issue = nextIssue;
  const world = new World(sessions);
  worlds.set(issue, world);
  const input = { issueNumber: issue, repoDir: '/work/repo', worktreeDir: `/work/repo/.claude/worktrees/issue-${issue}`, base: 'main', awaitDecision: false, executor: 'remote', ...extra };
  const handle = client.workflow.start('issueWorkflow', { taskQueue: QUEUE, workflowId: issueWorkflowId(issue), args: [input], workflowExecutionTimeout: '2 minutes' });
  return { issue, world, handle };
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

const answered: NeedsInputWaitResult = { answered: true, commentId: 32 };
const parkKey = (attempt: number) => needsInputParkCommentKey(attempt);

test('a needs-input session parks the run (running, not failed), one comment, the board shows Needs Input; the answer starts attempt 2 and the run reaches the guard and the PR', { timeout: 120_000 }, async () => {
  const { issue, world, handle } = start((attempt) => (attempt === 1 ? asked() : pushed));
  let release: () => void = () => undefined;
  world.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waitOpen = new Promise<void>((resolve) => {
    world.onWait = resolve;
  });
  world.waitScript = () => answered;
  await handle;
  await waitOpen;

  // While parked: the run is open, the comment is posted once and the board shows the park.
  const describe = await client.workflow.getHandle(issueWorkflowId(issue)).describe();
  assert.equal(describe.status.name, 'RUNNING');
  assert.deepEqual([...world.comments.keys()], [parkKey(1)], 'one comment, no stop comment');
  assert.equal(world.status, 'Needs Input');
  assert.deepEqual(world.attempts, [1], 'no second session before the answer');
  assert.equal(world.called('guardRemoteBranch'), 0);
  assert.equal(world.called('openPr'), 0);
  assert.deepEqual(world.waits.map((wait) => wait.afterCommentId), [31], 'the wait is keyed on the needs-input comment');

  release();
  const cause = await failure(issue, handle);
  assert.equal(cause.details?.[0], STOPS_AT_FIXER, 'the run got past the guard and the PR');
  assert.deepEqual(world.attempts, [1, 2], 'the answer fires the next attempt, once');
  assert.equal(world.called('guardRemoteBranch'), 1);
  assert.equal(world.called('openPr'), 1);
  assert.deepEqual(world.issueStatuses.slice(0, 3), ['In progress', 'Needs Input', 'In progress'], 'moved back when the answer came');
  assert.equal(world.status, 'In review', 'and on to In review as before');
  assert.deepEqual(world.commentCalls.filter((key) => key === parkKey(1)), [parkKey(1)], 'the park comment was posted once');
});

test('no answer by the limit ends the run as NeedsInputTimeout with one stop comment; the item stays in Needs Input and no PR opens', { timeout: 120_000 }, async () => {
  const { issue, world, handle } = start(() => asked(), { needsInputTimeoutMs: 5_000 });
  const cause = await failure(issue, handle);
  assert.deepEqual(cause.details?.slice(0, 2), ['park', 'NeedsInputTimeout']);
  assert.deepEqual(world.attempts, [1]);
  assert.deepEqual(world.waits.map((wait) => wait.waitMs), [5_000]);
  assert.deepEqual([...world.comments.keys()].sort(), [parkKey(1), 'stopped-park-NeedsInputTimeout'].sort());
  assert.equal(world.status, 'Needs Input');
  assert.equal(world.called('openPr'), 0);
});

test('a limit longer than one wait is spent in bounded chunks that add up to the limit', { timeout: 120_000 }, async () => {
  const limit = 2 * NEEDS_INPUT_WAIT_CHUNK_MS + 30 * 60_000;
  const { issue, world, handle } = start(() => asked(), { needsInputTimeoutMs: limit });
  const cause = await failure(issue, handle);
  assert.equal(cause.details?.[1], 'NeedsInputTimeout');
  assert.deepEqual(world.waits.map((wait) => wait.waitMs), [NEEDS_INPUT_WAIT_CHUNK_MS, NEEDS_INPUT_WAIT_CHUNK_MS, 30 * 60_000]);
  assert.ok(world.waits.every((wait) => wait.pollMs === 300_000), 'every wait polls every 5 minutes');
  assert.equal(world.waits.reduce((sum, wait) => sum + wait.waitMs, 0), limit);
});

test('an answer in a later chunk counts, and the earlier chunks cost no session', { timeout: 120_000 }, async () => {
  const { issue, world, handle } = start((attempt) => (attempt === 1 ? asked() : pushed), { needsInputTimeoutMs: 3 * NEEDS_INPUT_WAIT_CHUNK_MS });
  world.waitScript = (call) => (call < 3 ? { answered: false } : answered);
  const cause = await failure(issue, handle);
  assert.equal(cause.details?.[0], STOPS_AT_FIXER);
  assert.equal(world.waits.length, 3);
  assert.deepEqual(world.attempts, [1, 2]);
});

test('a run parks twice, and a third needs-input stops it as NeedsInput with no third park', { timeout: 120_000 }, async () => {
  const { issue, world, handle } = start(() => asked());
  world.waitScript = () => answered;
  const cause = await failure(issue, handle);
  assert.deepEqual(cause.details?.slice(0, 2), ['session', 'NeedsInput']);
  assert.deepEqual(world.attempts, [1, 2, 3]);
  assert.equal(world.waits.length, 2, 'two parks');
  assert.ok(world.comments.has(parkKey(1)) && world.comments.has(parkKey(2)) && !world.comments.has(parkKey(3)));
  assert.ok(world.comments.has('stopped-session-NeedsInput'));
  assert.match(world.comments.get('stopped-session-NeedsInput') ?? '', /needs-input comment \(id 31\)/, 'the stop comment names the comment by id');
  assert.equal(world.called('openPr'), 0);
});

test('a park does not spend the no-push retry: a session that ends with no push after the answer still gets its one retry', { timeout: 120_000 }, async () => {
  const { issue, world, handle } = start((attempt) => (attempt === 1 ? asked() : attempt === 2 ? { outcome: 'timed_out' } : pushed));
  world.waitScript = () => answered;
  const cause = await failure(issue, handle);
  assert.equal(cause.details?.[0], STOPS_AT_FIXER);
  assert.deepEqual(world.attempts, [1, 2, 3]);

  // And the other way round: the retry spent before a park leaves the park its own budget.
  const other = start((attempt) => (attempt === 1 ? { outcome: 'timed_out' } : attempt === 2 ? asked() : pushed));
  other.world.waitScript = () => answered;
  assert.equal((await failure(other.issue, other.handle)).details?.[0], STOPS_AT_FIXER);
  assert.deepEqual(other.world.attempts, [1, 2, 3]);

  // Without a park the second no-push session still stops the run.
  const dead = start(() => ({ outcome: 'timed_out' }));
  assert.equal((await failure(dead.issue, dead.handle)).details?.[1], 'RemoteSessionTimedOut');
  assert.deepEqual(dead.world.attempts, [1, 2]);
});

test('a board that has no item or no Needs Input option is skipped: the run still parks, resumes and opens its PR', { timeout: 120_000 }, async () => {
  const { issue, world, handle } = start((attempt) => (attempt === 1 ? asked() : pushed));
  world.boardFault = true;
  world.waitScript = () => answered;
  const cause = await failure(issue, handle);
  assert.equal(cause.details?.[0], STOPS_AT_FIXER);
  assert.deepEqual(world.attempts, [1, 2]);
  assert.equal(world.called('setStatus:Needs Input'), 1, 'one move attempted, not retried');
  assert.ok(!world.issueStatuses.includes('Needs Input'));
});

test('a wait activity lost mid-park is retried and reads again: no second session, one park comment', { timeout: 120_000 }, async () => {
  const { issue, world, handle } = start((attempt) => (attempt === 1 ? asked() : pushed));
  world.waitScript = (call) => (call === 1 ? 'fault' : answered);
  const cause = await failure(issue, handle);
  assert.equal(cause.details?.[0], STOPS_AT_FIXER);
  assert.equal(world.waits.length, 2, 'the read was repeated');
  assert.deepEqual(world.attempts, [1, 2], 'attempt 2 started once, and attempt 1 was not run again by the replays');
  assert.equal(world.called('runRemoteImplementerSession'), 2);
  assert.deepEqual(world.commentCalls.filter((key) => key === parkKey(1)), [parkKey(1)], 'one park comment');
  assert.equal(world.called('openPr'), 1);
});

test('a needs-input result with no comment id cannot be waited on, so it stops as NeedsInput', { timeout: 120_000 }, async () => {
  const { issue, world, handle } = start(() => ({ outcome: 'needs_input' }));
  const cause = await failure(issue, handle);
  assert.deepEqual(cause.details?.slice(0, 2), ['session', 'NeedsInput']);
  assert.equal(world.waits.length, 0);
  assert.deepEqual([...world.comments.keys()], ['stopped-session-NeedsInput']);
});
