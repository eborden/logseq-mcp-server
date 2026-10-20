// The review loop's remote branch (#674) against a real Temporal dev server and fake activities with counters. The loop
// runs through a test-only workflow (test/workflows/remote-review-loop.ts) because `issueWorkflow` cannot reach it with
// `executor: 'remote'` until a remote implementer exists. Nothing calls GitHub, a remote session or a model.

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
import type { IssueRunResult } from '../src/issue-types.ts';
import { freePort } from './support.ts';

const WORKFLOWS_PATH = fileURLToPath(new URL('./workflows/remote-review-loop.ts', import.meta.url));
const QUEUE = 'remote-reviewer-fakes';
const HEAD = 'a'.repeat(40);
const SECRET = 'SECRET-FINDING-TEXT';

class World {
  readonly calls: string[] = [];
  readonly comments = new Map<string, string>();
  minimizeFails = false;
  sessionFails: string | undefined;
  minimizedWith: string[] = [];
}

const worlds = new Map<string, World>();
let counter = 0;

function fakeActivities() {
  const world = (issue: number): World => {
    const found = worlds.get(String(issue));
    assert.ok(found);
    return found;
  };
  // One world per run, found by the issue number the input carries; the activities that take only a PR use the last one.
  let current: World | undefined;
  const pick = (issue: number): World => {
    current = world(issue);
    return current;
  };
  return {
    runReviewerSession: async (input: { issue: number }) => {
      pick(input.issue).calls.push('runReviewerSession');
      return { findings: 0, acceptedThreadIds: [] };
    },
    postSessionReview: async () => {
      current?.calls.push('postSessionReview');
      return { reviewId: 1, posted: true, comments: 0, advisory: 0, omitted: 0, fileLevel: 0, nearest: 0 };
    },
    runRemoteReviewerSession: async (input: { issue: number }) => {
      const w = pick(input.issue);
      w.calls.push('runRemoteReviewerSession');
      if (w.sessionFails !== undefined) {
        throw ApplicationFailure.nonRetryable('the findings are not in the asked shape', w.sessionFails);
      }
      return { findings: 1, acceptedThreadIds: [], commentNodeId: 'IC_raw1' };
    },
    postRemoteSessionReview: async () => {
      current?.calls.push('postRemoteSessionReview');
      return { reviewId: 2, posted: true, comments: 1, advisory: 0, omitted: 0, fileLevel: 0, nearest: 0 };
    },
    minimizeFindingsComment: async (input: { nodeId: string }) => {
      current?.calls.push('minimizeFindingsComment');
      current?.minimizedWith.push(input.nodeId);
      if (current?.minimizeFails === true) {
        throw ApplicationFailure.nonRetryable('could not hide it', 'GitHubClientError');
      }
      return { minimized: true as const };
    },
    getGateStatus: async (pr: number) => {
      current?.calls.push('getGateStatus');
      return { headSha: HEAD, reviewsOnHead: 1, unresolvedThreads: 0, clear: true, pr };
    },
    commentIssue: async (input: { issue: number; key: string; body: string }) => {
      const w = world(input.issue);
      w.comments.set(input.key, input.body);
      return { commentId: 1, posted: true };
    },
    listOpenThreads: async () => ({ threads: [] }),
  };
}

let env: TestWorkflowEnvironment;
let client: Client;
let worker: Worker;
let running: Promise<void>;

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

async function runLoop(executor: 'local' | 'remote' | undefined, tune: (world: World) => void = () => undefined): Promise<{ world: World; handle: ReturnType<Client['workflow']['getHandle']> }> {
  counter += 1;
  const issue = 300 + counter;
  const world = new World();
  tune(world);
  worlds.set(String(issue), world);
  const input = { issueNumber: issue, repoDir: '/work/repo', worktreeDir: `/work/repo/wt-${issue}`, base: 'main', awaitDecision: false, ...(executor === undefined ? {} : { executor }) };
  const handle = await client.workflow.start('remoteReviewLoopWorkflow', { taskQueue: QUEUE, workflowId: `remote-loop-${issue}`, args: [input], workflowExecutionTimeout: '2 minutes' });
  return { world, handle };
}

test('executor remote: the remote reviewer, the worker posts the review, the raw comment is hidden, the gate decides', { timeout: 120_000 }, async () => {
  const { world, handle } = await runLoop('remote');
  const result = (await handle.result()) as IssueRunResult;
  assert.equal(result.outcome, 'gate_clear');
  assert.equal('rawCommentsNotHidden' in result && result.rawCommentsNotHidden, 0);
  assert.deepEqual(world.calls, ['runRemoteReviewerSession', 'postRemoteSessionReview', 'minimizeFindingsComment', 'getGateStatus'], 'no local session, and the review is posted before the raw comment is hidden');
  assert.deepEqual(world.minimizedWith, ['IC_raw1']);
  assert.equal(world.comments.size, 0);
});

test('executor remote: a comment that cannot be hidden does not stop the run, and the run says so', { timeout: 120_000 }, async () => {
  const { world, handle } = await runLoop('remote', (w) => {
    w.minimizeFails = true;
  });
  const result = (await handle.result()) as IssueRunResult;
  assert.equal(result.outcome, 'gate_clear');
  assert.equal('rawCommentsNotHidden' in result && result.rawCommentsNotHidden, 1);
  assert.equal(world.comments.size, 1, 'one note on the issue');
  const [key, body] = [...world.comments.entries()][0] ?? ['', ''];
  assert.match(key, /^findings-not-hidden-77-r0$/);
  assert.ok(body.includes('could not hide') && !body.includes(SECRET));
  assert.ok(world.calls.includes('getGateStatus'), 'the loop went on to the gate');
});

test('executor remote: findings that fail the parser stop the run at the review session, and nothing is posted', { timeout: 120_000 }, async () => {
  for (const type of ['MalformedFindings', 'FindingsTooLarge', 'RemoteSessionFailed']) {
    const { world, handle } = await runLoop('remote', (w) => {
      w.sessionFails = type;
    });
    try {
      await handle.result();
      assert.fail('the run should have failed');
    } catch (error) {
      assert.ok(error instanceof WorkflowFailedError);
      assert.ok(error.cause instanceof ApplicationFailure);
      assert.deepEqual(error.cause.details, ['review_session', type]);
    }
    assert.deepEqual(world.calls, ['runRemoteReviewerSession'], `${type}: no review, no hiding, no gate read`);
  }
});

test('executor local, and no executor: the local reviewer runs as before and the remote activities are never called', { timeout: 120_000 }, async () => {
  for (const executor of ['local', undefined] as const) {
    const { world, handle } = await runLoop(executor);
    const result = (await handle.result()) as IssueRunResult;
    assert.equal(result.outcome, 'gate_clear');
    assert.equal('rawCommentsNotHidden' in result, false, 'a local result has no new field');
    assert.deepEqual(world.calls, ['runReviewerSession', 'postSessionReview', 'getGateStatus']);
  }
});
