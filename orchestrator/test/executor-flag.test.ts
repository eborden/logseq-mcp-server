// The executor flag (#671, plan #643): `executor: 'local' | 'remote'`, parsed at the boundary, with `local` (the default)
// leaving v1 as it was and `remote` stopping the run for a person before any session, because no remote activity is wired.
// Real Temporal dev server and fake activities with counters; nothing calls GitHub, `claude` or LogSeq. Names are made up.

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
import {
  ISSUE_STOPPED_FAILURE,
  REMOTE_EXECUTOR_UNAVAILABLE,
  executorForFlag,
  issueBranch,
  issueWorkflowId,
  parseIssueWorkflowInput,
  stopCommentKey,
} from '../src/issue-types.ts';
import type { IssueRunResult, IssueWorkflowInput } from '../src/issue-types.ts';
import { onExecutor } from '../src/workflows/executor.ts';
import { freePort } from './support.ts';

const WORKFLOWS_PATH = fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url));
const QUEUE = 'executor-flag-fakes';
const HEAD = 'a'.repeat(40);
const PR_OFFSET = 1000;
const BASE_INPUT = { issueNumber: 5, repoDir: '/work/repo', worktreeDir: '/work/wt', base: 'main' };

// ---- the input ---------------------------------------------------------------------------------------------------

test('the input takes executor local or remote, leaves it absent when absent, and refuses anything else', () => {
  assert.equal('executor' in parseIssueWorkflowInput(BASE_INPUT), false, 'absent stays absent: the default is local');
  assert.equal(parseIssueWorkflowInput({ ...BASE_INPUT, executor: 'local' }).executor, 'local');
  assert.equal(parseIssueWorkflowInput({ ...BASE_INPUT, executor: 'remote' }).executor, 'remote');
  for (const bad of ['Remote', 'cloud', '', true, 1, null, {}]) {
    assert.throws(() => parseIssueWorkflowInput({ ...BASE_INPUT, executor: bad }), /executor must be local or remote/, JSON.stringify(bad));
  }
});

test('--executor adds the field, no flag adds none, and any other value is an error', () => {
  assert.deepEqual(executorForFlag(undefined), {});
  assert.deepEqual(executorForFlag('local'), { executor: 'local' });
  assert.deepEqual(executorForFlag('remote'), { executor: 'remote' });
  for (const bad of ['', 'Remote', 'cloud', 'remote ']) {
    assert.throws(() => executorForFlag(bad), /--executor must be local or remote/, JSON.stringify(bad));
  }
});

test('the choice point calls the local activity for local and for no executor, and never for remote', async () => {
  const stops: string[] = [];
  const stop = async (step: string, reason: string): Promise<never> => {
    stops.push(`${step}:${reason}`);
    throw new Error('stopped');
  };
  let calls = 0;
  const local = async (): Promise<number> => {
    calls += 1;
    return 7;
  };
  assert.equal(await onExecutor(undefined, 'session', stop, local), 7);
  assert.equal(await onExecutor('local', 'session', stop, local), 7);
  assert.equal(calls, 2);
  await assert.rejects(onExecutor('remote', 'review_session', stop, local), /stopped/);
  await assert.rejects(onExecutor('remote', 'fix_session', stop, local), /stopped/);
  assert.equal(calls, 2, 'a remote run starts no local session');
  assert.deepEqual(stops, [`review_session:${REMOTE_EXECUTOR_UNAVAILABLE}`, `fix_session:${REMOTE_EXECUTOR_UNAVAILABLE}`]);
});

// ---- the workflow ------------------------------------------------------------------------------------------------

class World {
  issueStatus: string | undefined = 'Ready';
  prStatus: string | undefined;
  readonly calls: Record<string, number> = {};
  readonly comments = new Map<string, string>();
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
let nextIssue = 200;

function fakeActivities() {
  const target = (t: { kind: 'issue' | 'pr'; number: number }) => ({ w: worldOf(t.kind === 'pr' ? t.number - PR_OFFSET : t.number), kind: t.kind });
  return {
    checkIssue: async (issue: number) => ({ number: issue, open: true, trustedComments: 1, droppedUntrustedComments: 0 }),
    claimIssue: async (issue: number) => {
      const w = worldOf(issue);
      w.hit('claimIssue');
      w.issueStatus = 'In progress';
      return { claimed: true, reason: 'claimed' as const, proceed: true };
    },
    runImplementerSession: async (raw: IssueWorkflowInput) => {
      worldOf(raw.issueNumber).hit('runImplementerSession');
      return { branch: issueBranch(raw.issueNumber), headSha: HEAD, exitStatus: 'success' as const };
    },
    guardBranch: async (raw: { branch: string; headSha: string }) => ({ branch: raw.branch, headSha: raw.headSha, files: 1 }),
    pushBranch: async (raw: { branch: string; headSha: string }) => ({ branch: raw.branch, headSha: raw.headSha }),
    openPr: async (input: { head: string }) => {
      const issue = Number(/^claude\/(\d+)$/.exec(input.head)?.[1]);
      worldOf(issue).hit('openPr');
      return { number: issue + PR_OFFSET, url: `https://github.com/eborden/logseq-mcp-server/pull/${issue + PR_OFFSET}`, created: true };
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
    postSessionReview: async () => ({ reviewId: 1, posted: true, comments: 0, advisory: 0, omitted: 0 }),
    getGateStatus: async (pr: number) => ({ headSha: HEAD, reviewsOnHead: 1, unresolvedThreads: 0, clear: true, pr }),
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

function start(extra: Record<string, unknown>): { issue: number; world: World; started: Promise<unknown> } {
  nextIssue += 1;
  const issue = nextIssue;
  const world = new World();
  worlds.set(issue, world);
  const input = { issueNumber: issue, repoDir: '/work/repo', worktreeDir: `/work/repo/.claude/worktrees/issue-${issue}`, base: 'main', awaitDecision: false, ...extra };
  const started = client.workflow.start('issueWorkflow', { taskQueue: QUEUE, workflowId: issueWorkflowId(issue), args: [input], workflowExecutionTimeout: '2 minutes' });
  return { issue, world, started };
}

async function result(issue: number, started: Promise<unknown>): Promise<IssueRunResult> {
  await started;
  return (await client.workflow.getHandle(issueWorkflowId(issue)).result()) as IssueRunResult;
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

test('with no executor, and with local, the run is v1: one implementer and one reviewer session, a PR, the gate clear', { timeout: 120_000 }, async () => {
  for (const extra of [{}, { executor: 'local' }]) {
    const { issue, world, started } = start(extra);
    const done = await result(issue, started);
    assert.equal(done.outcome, 'gate_clear', JSON.stringify(extra));
    assert.equal(world.called('runImplementerSession'), 1);
    assert.equal(world.called('runReviewerSession'), 1);
    assert.equal(world.called('openPr'), 1);
    assert.equal(world.comments.size, 0);
  }
});

test('executor remote stops the run with RemoteExecutorUnavailable, one keyed comment of identifiers, and no session or PR', { timeout: 120_000 }, async () => {
  const { issue, world, started } = start({ executor: 'remote' });
  const cause = await failure(issue, started);
  const [step, reason] = cause.details ?? [];
  assert.equal(cause.type, ISSUE_STOPPED_FAILURE);
  assert.equal(reason, REMOTE_EXECUTOR_UNAVAILABLE);
  assert.equal(step, 'session');
  assert.equal(world.called('runImplementerSession'), 0, 'no implementer session is started');
  assert.equal(world.called('runReviewerSession'), 0);
  assert.equal(world.called('openPr'), 0);
  assert.deepEqual([...world.comments.keys()], [stopCommentKey('session', REMOTE_EXECUTOR_UNAVAILABLE)]);
  const body = [...world.comments.values()][0] ?? '';
  assert.ok(body.includes(REMOTE_EXECUTOR_UNAVAILABLE) && body.includes(issueWorkflowId(issue)));
});

test('an invalid executor value fails the run as InvalidInput before any activity', { timeout: 60_000 }, async () => {
  const { issue, world, started } = start({ executor: 'cloud' });
  const cause = await failure(issue, started);
  assert.equal(cause.type, 'InvalidInput');
  assert.deepEqual(world.calls, {});
  assert.equal(world.comments.size, 0);
});
