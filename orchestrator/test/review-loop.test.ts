// The review loop of IssueWorkflow (#630) against a real Temporal server (an in-memory dev server on a free port) and no
// real service. Layer 1: fake activities that model a PR (its head, its reviews, its threads) with counters, so each side
// effect can be counted and each result lost. Layer 2: the real review activities against the fake `gh` and the fake
// `claude`, which is also where session text is checked against the stored history. No test calls GitHub or the model.
// Every name is made up (issue 123, Alice, "project atlas").
//
// The model of GitHub is honest on purpose: a review counts for the gate only on the commit it was made on, a thread
// is resolved only by a person (`humanResolves`, the test standing in for the maintainer), and the head moves only when
// a push happens. The workflow has to get to a clear gate through those rules, not around them.
//
// The workers run with `maxCachedWorkflows: 0`, so every workflow task replays the whole history.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import { createBranchActivities } from '../src/activities/branch.ts';
import { createClaudeSessionActivities } from '../src/activities/claude-session.ts';
import { createGithubActivities } from '../src/activities/github.ts';
import { createImplementerActivities } from '../src/activities/implementer.ts';
import { createReviewActivities } from '../src/activities/review.ts';
import { loadClaudeConfig, loadServerConfig } from '../src/config.ts';
import { startDevServer } from '../src/dev-server.ts';
import { startIssueRun } from '../src/issue-client.ts';
import { issueBranch, issueWorkflowId } from '../src/issue-types.ts';
import type { IssueRunResult, IssueWorkflowInput } from '../src/issue-types.ts';
import { DEFAULT_MAX_FIX_ROUNDS } from '../src/review-policy.ts';
import type { ReviewStepInput } from '../src/review-types.ts';
import type { BoardItemRef, BoardStatus } from '../src/types.ts';
import { createFake, emptyState, rawComment, rawIssue } from './github-support.ts';
import { forbiddenCalls } from './invariants.ts';
import { freePort } from './support.ts';

const execFileAsync = promisify(execFile);
const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.sh', import.meta.url));
const WORKFLOWS_PATH = fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const HEAD0 = 'a'.repeat(40);
const PR_OFFSET = 1000;

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
    maxCachedWorkflows: 0,
  });
  workers.push({ worker, running: worker.run() });
}

before(async () => {
  env = await startDevServer({ port: await freePort(), cliPath: loadServerConfig(process.env).cliPath });
  client = env.client;
  bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH });
  dir = await mkdtemp(join(tmpdir(), 'orchestrator-review-wf-'));
});

after(async () => {
  for (const { worker } of workers) {
    worker.shutdown();
  }
  await Promise.allSettled(workers.map(({ running }) => running));
  await env?.teardown();
  for (const name of ['FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_SEQUENCE']) {
    delete process.env[name];
  }
  if (dir !== undefined && process.env['KEEP_TEST_DIR'] === undefined) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- layer 1: a model of the PR, fake activities with counters --------------------------------------------------

interface Thread {
  readonly id: string;
  readonly trusted: boolean;
  resolved: boolean;
}

type LostStep = 'runReviewerSession' | 'postSessionReview' | 'runFixerSession' | 'guardBranch' | 'pushBranch' | 'postFixerReplies';

/** The commit a fixer round ends at: round 0 gives 1111..., round 1 gives 2222..., all valid ids. */
const fixHead = (round: number): string => String(round + 1).repeat(40);

class World {
  /** The head GitHub shows for the PR. The first push sets it; a later push moves it. */
  head = HEAD0;
  threads: Thread[] = [];
  readonly reviews: { commit: string; round: number }[] = [];
  readonly events: string[] = [];

  // What the reviewer finds, per round. By default nothing: a clean review.
  findings: (round: number) => number = () => 0;
  /** Whether the reviewer accepts the replies on every open trusted thread it can see. */
  accepts = false;
  /** A person who resolves a thread the moment the reviewer accepts it. Off: nobody resolves, as in an unattended run. */
  humanResolves = false;
  fixerMoves = true;
  reviewerFails: string | undefined;
  fixerFails: string | undefined;
  guardFails: string | undefined;
  /** Which commit a review is recorded on (GitHub counts it for the gate only when this is the head). */
  recordReviewOn: (round: number, head: string) => string | undefined = (_round, head) => head;
  /** The head the gate read shows, when it is not the real one. */
  gateHead: (reads: number) => string | undefined = () => undefined;
  reviewerDelayMs = 0;
  pushHeadMoves = true;
  /** GitHub shows no review on the head for this many gate reads after it was accepted. */
  reviewLagReads = 0;
  /** Findings of every review that sit in its body (off the changed lines), and the ones left out of it. */
  advisory = 0;
  advisoryOmitted = 0;

  gateReads = 0;
  readonly counters = { reviewerSessions: 0, reviews: 0, fixerSessions: 0, guards: 0, pushes: 0, replies: 0, comments: 0 };
  readonly attempts: Record<string, number> = {};
  readonly commentKeys = new Map<string, string>();
  readonly loseOnce = new Set<LostStep>();
  readonly reviewerRounds = new Map<number, string[]>();
  readonly postedRounds = new Set<number>();
  readonly fixerRounds = new Map<number, { headSha: string; moved: boolean; replies: number }>();
  readonly guarded = new Set<string>();
  readonly pushed = new Set<string>();
  readonly repliedRounds = new Set<number>();
  readonly stepInputs: ReviewStepInput[] = [];
  firstHalf = { claimed: false, sessions: 0, prs: 0 };
  issueStatus: BoardStatus | undefined = 'Ready';
  prStatus: BoardStatus | undefined;

  attempt(name: string): void {
    this.attempts[name] = (this.attempts[name] ?? 0) + 1;
  }

  maybeLose(step: LostStep): void {
    if (this.loseOnce.delete(step)) {
      throw new Error('simulated: the worker died after the side effect');
    }
  }

  get unresolved(): Thread[] {
    return this.threads.filter((thread) => !thread.resolved);
  }
}

const worlds = new Map<number, World>();

function world(issue: number): World {
  const found = worlds.get(issue);
  assert.ok(found, `no world for issue ${issue}`);
  return found;
}

const issueOfBranch = (branch: string): number => Number(/^claude\/(\d+)$/.exec(branch)?.[1]);

function fakeActivities() {
  const worldOf = (target: BoardItemRef | number): { w: World; kind: 'issue' | 'pr' } => {
    const ref: BoardItemRef = typeof target === 'number' ? { kind: 'issue', number: target } : target;
    return { w: world(ref.kind === 'pr' ? ref.number - PR_OFFSET : ref.number), kind: ref.kind };
  };
  return {
    // ---- the first half, as small as it can be: the review loop is what these tests are about
    checkIssue: async (issue: number) => ({ number: issue, open: true, trustedComments: 0, droppedUntrustedComments: 0 }),
    claimIssue: async (issue: number) => {
      const w = world(issue);
      w.issueStatus = 'In progress';
      return { claimed: true, reason: 'claimed' as const, proceed: true };
    },
    runImplementerSession: async (raw: IssueWorkflowInput) => {
      world(raw.issueNumber).firstHalf.sessions += 1;
      return { branch: issueBranch(raw.issueNumber), headSha: HEAD0, exitStatus: 'success' as const };
    },
    openPr: async (input: { head: string }) => {
      const issue = issueOfBranch(input.head);
      world(issue).firstHalf.prs += 1;
      return { number: issue + PR_OFFSET, url: 'https://example.invalid/pull', created: true };
    },
    addToBoard: async (target: BoardItemRef) => {
      const { w } = worldOf(target);
      w.prStatus ??= 'Backlog';
      return { kind: target.kind, number: target.number, itemId: 'PVTI_x', added: true, status: w.prStatus };
    },
    getBoardStatus: async (target: BoardItemRef) => {
      const { w, kind } = worldOf(target);
      const status = kind === 'pr' ? w.prStatus : w.issueStatus;
      return { kind, number: target.number, onBoard: status !== undefined, status: status ?? null };
    },
    setStatus: async (target: BoardItemRef, status: BoardStatus) => {
      const { w, kind } = worldOf(target);
      if (kind === 'pr') {
        w.prStatus = status;
      } else {
        w.issueStatus = status;
      }
      return { changed: true, status };
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
    // ---- the branch: the guard and the push, once per commit
    guardBranch: async (raw: { branch: string; headSha: string }) => {
      const w = world(issueOfBranch(raw.branch));
      w.attempt('guardBranch');
      if (w.guardFails !== undefined && raw.headSha !== HEAD0) {
        throw ApplicationFailure.nonRetryable('the branch changes 2 file(s), 1 of them protected', w.guardFails);
      }
      if (!w.guarded.has(raw.headSha)) {
        w.guarded.add(raw.headSha);
        w.counters.guards += 1;
        w.events.push(`guard:${raw.headSha.slice(0, 1)}`);
      }
      w.maybeLose('guardBranch');
      return { branch: raw.branch, headSha: raw.headSha, files: 1 };
    },
    pushBranch: async (raw: { branch: string; headSha: string }) => {
      const w = world(issueOfBranch(raw.branch));
      w.attempt('pushBranch');
      if (!w.pushed.has(raw.headSha)) {
        w.pushed.add(raw.headSha);
        w.counters.pushes += 1;
        w.events.push(`push:${raw.headSha.slice(0, 1)}`);
        if (w.pushHeadMoves) {
          w.head = raw.headSha;
        }
      }
      w.maybeLose('pushBranch');
      return { branch: raw.branch, headSha: raw.headSha };
    },
    // ---- the second half
    runReviewerSession: async (input: ReviewStepInput) => {
      const w = world(input.issue);
      w.attempt('runReviewerSession');
      w.stepInputs.push(input);
      if (w.reviewerFails !== undefined) {
        throw ApplicationFailure.nonRetryable('the reviewer session failed', w.reviewerFails);
      }
      let accepted = w.reviewerRounds.get(input.round);
      if (accepted === undefined) {
        w.counters.reviewerSessions += 1;
        w.events.push(`reviewer:${input.round}`);
        if (w.reviewerDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, w.reviewerDelayMs));
        }
        accepted = w.accepts ? w.unresolved.filter((thread) => thread.trusted).map((thread) => thread.id) : [];
        if (w.humanResolves) {
          for (const thread of w.threads) {
            thread.resolved ||= accepted.includes(thread.id);
          }
        }
        w.reviewerRounds.set(input.round, accepted);
      }
      w.maybeLose('runReviewerSession');
      return { findings: w.findings(input.round), acceptedThreadIds: accepted };
    },
    postSessionReview: async (input: ReviewStepInput) => {
      const w = world(input.issue);
      w.attempt('postSessionReview');
      const findings = w.findings(input.round);
      if (!w.postedRounds.has(input.round)) {
        w.postedRounds.add(input.round);
        w.counters.reviews += 1;
        w.events.push(`review:${input.round}@${input.headSha.slice(0, 1)}`);
        const commit = w.recordReviewOn(input.round, input.headSha);
        if (commit !== undefined) {
          w.reviews.push({ commit, round: input.round });
        }
        for (let k = 0; k < findings; k += 1) {
          w.threads.push({ id: `T${input.round}_${k}`, trusted: true, resolved: false });
        }
      }
      w.maybeLose('postSessionReview');
      return { reviewId: 5000 + input.round, posted: true, comments: findings, advisory: w.advisory, omitted: w.advisoryOmitted };
    },
    getGateStatus: async (pr: number) => {
      const w = world(pr - PR_OFFSET);
      w.attempt('getGateStatus');
      w.gateReads += 1;
      return {
        headSha: w.gateHead(w.gateReads) ?? w.head,
        reviewsOnHead: w.gateReads <= w.reviewLagReads ? 0 : w.reviews.filter((review) => review.commit === w.head).length,
        unresolvedThreads: w.unresolved.length,
        clear: false,
      };
    },
    listOpenThreads: async (pr: number) => {
      const w = world(pr - PR_OFFSET);
      w.attempt('listOpenThreads');
      return { threads: w.unresolved.map((thread) => ({ id: thread.id, trusted: thread.trusted })) };
    },
    runFixerSession: async (input: ReviewStepInput) => {
      const w = world(input.issue);
      w.attempt('runFixerSession');
      w.stepInputs.push(input);
      if (w.fixerFails !== undefined) {
        throw ApplicationFailure.nonRetryable('the fixer session failed', w.fixerFails);
      }
      let result = w.fixerRounds.get(input.round);
      if (result === undefined) {
        w.counters.fixerSessions += 1;
        w.events.push(`fixer:${input.round}`);
        const open = w.unresolved.filter((thread) => thread.trusted && !input.acceptedThreadIds.includes(thread.id));
        result = { headSha: w.fixerMoves ? fixHead(input.round) : input.headSha, moved: w.fixerMoves, replies: open.length };
        w.fixerRounds.set(input.round, result);
      }
      w.maybeLose('runFixerSession');
      return result;
    },
    postFixerReplies: async (input: ReviewStepInput) => {
      const w = world(input.issue);
      w.attempt('postFixerReplies');
      if (!w.repliedRounds.has(input.round)) {
        w.repliedRounds.add(input.round);
        w.counters.replies += 1;
        w.events.push(`replies:${input.round}@${input.headSha.slice(0, 1)}`);
      }
      w.maybeLose('postFixerReplies');
      return { posted: 1, skipped: 0 };
    },
  };
}

const FAKE_QUEUE = 'review-loop-fakes';
let fakeQueueStarted = false;

async function ensureFakeWorker(): Promise<void> {
  if (!fakeQueueStarted) {
    fakeQueueStarted = true;
    await startWorker(FAKE_QUEUE, fakeActivities());
  }
}

let nextIssue = 300;

function newWorld(configure: (world: World) => void = () => undefined): { issue: number; world: World } {
  nextIssue += 1;
  const w = new World();
  configure(w);
  worlds.set(nextIssue, w);
  return { issue: nextIssue, world: w };
}

function inputFor(issue: number, extra: Partial<IssueWorkflowInput> = {}): IssueWorkflowInput {
  return { issueNumber: issue, repoDir: '/work/repo', worktreeDir: `/work/repo/.claude/worktrees/issue-${issue}`, base: 'main', awaitDecision: false, ...extra };
}

async function runIssue(taskQueue: string, issue: number, extra: Partial<IssueWorkflowInput> = {}): Promise<IssueRunResult> {
  const started = await startIssueRun(client, taskQueue, inputFor(issue, extra));
  assert.equal(started.status, 'started');
  const result: unknown = await client.workflow.getHandle(issueWorkflowId(issue)).result();
  return result as IssueRunResult;
}

async function stoppedWith(issue: number, taskQueue: string, extra: Partial<IssueWorkflowInput> = {}): Promise<{ step: unknown; reason: unknown; pr: unknown; type: unknown }> {
  await startIssueRun(client, taskQueue, inputFor(issue, extra));
  try {
    await client.workflow.getHandle(issueWorkflowId(issue)).result();
  } catch (error) {
    assert.ok(error instanceof WorkflowFailedError, 'the run ends as a failed workflow');
    const cause = error.cause;
    assert.ok(cause instanceof ApplicationFailure);
    const [step, reason, pr] = cause.details ?? [];
    return { step, reason, pr, type: cause.type };
  }
  return assert.fail('the run should have stopped');
}

/** One finding in the first review only, then clean: the scenario of "threads open, a fix, a closing review". */
function oneFindingFirst(w: World): void {
  w.findings = (round) => (round === 0 ? 1 : 0);
}

test('a clean first review clears the gate with no fixer run, and the run ends there without merging', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue, world: w } = newWorld();

  const result = await runIssue(FAKE_QUEUE, issue);

  assert.deepEqual(result, { outcome: 'gate_clear', issueNumber: issue, branch: `claude/${issue}`, headSha: HEAD0, pr: issue + PR_OFFSET, fixRounds: 0, reviewsOnHead: 1, advisory: 0, advisoryOmitted: 0, prBody: { source: 'unknown', unmet: 0 } });
  assert.deepEqual(w.counters, { reviewerSessions: 1, reviews: 1, fixerSessions: 0, guards: 1, pushes: 1, replies: 0, comments: 0 });
  assert.deepEqual(w.events, ['guard:a', 'push:a', 'reviewer:0', 'review:0@a']);
});

test('threads open, a fix, a closing review on the new head, then the gate clears (the maintainer resolves the accepted thread)', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue, world: w } = newWorld((world) => {
    oneFindingFirst(world);
    world.accepts = true;
    world.humanResolves = true;
  });

  const result = await runIssue(FAKE_QUEUE, issue);

  assert.deepEqual(result, { outcome: 'gate_clear', issueNumber: issue, branch: `claude/${issue}`, headSha: fixHead(0), pr: issue + PR_OFFSET, fixRounds: 1, reviewsOnHead: 1, advisory: 0, advisoryOmitted: 0, prBody: { source: 'unknown', unmet: 0 } });
  // In order: a review on the first head, a fix, the guard and the push of the new commit, the replies, and then a
  // second review on the NEW head. The first review is on an older commit and does not count for the gate any more.
  assert.deepEqual(w.events, ['guard:a', 'push:a', 'reviewer:0', 'review:0@a', 'fixer:0', 'guard:1', 'push:1', 'replies:0@1', 'reviewer:1', 'review:1@1']);
  assert.deepEqual(w.counters, { reviewerSessions: 2, reviews: 2, fixerSessions: 1, guards: 2, pushes: 2, replies: 1, comments: 0 });
  assert.deepEqual(w.reviews.map((review) => review.commit), [HEAD0, fixHead(0)]);
  // The sessions were fresh and bounded: every step carried the head it was about, and the reviewer saw what was accepted.
  assert.deepEqual(w.stepInputs.map((input) => [input.round, input.headSha.slice(0, 1)]), [[0, 'a'], [0, 'a'], [1, '1']]);
});

test('without a person resolving the thread, the run ends waiting for threads to be resolved, with the accepted ids, and says so once', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue, world: w } = newWorld((world) => {
    oneFindingFirst(world);
    world.accepts = true;
    world.humanResolves = false;
  });

  const result = await runIssue(FAKE_QUEUE, issue);

  assert.deepEqual(result, {
    outcome: 'waiting_for_threads',
    issueNumber: issue,
    branch: `claude/${issue}`,
    headSha: fixHead(0),
    pr: issue + PR_OFFSET,
    fixRounds: 1,
    acceptedThreadIds: ['T0_0'],
    openThreads: 1,
    advisory: 0,
    advisoryOmitted: 0,
    prBody: { source: 'unknown', unmet: 0 },
  });
  assert.equal(w.counters.fixerSessions, 1, 'no second fixer round for a thread the reviewer accepted');
  assert.equal(w.unresolved.length, 1, 'the workflow resolved nothing');
  assert.deepEqual([...w.commentKeys.keys()], [`waiting-threads-${issue + PR_OFFSET}`]);
  const comment = w.commentKeys.get(`waiting-threads-${issue + PR_OFFSET}`) ?? '';
  assert.ok(comment.includes('Only a person resolves a review thread') && comment.includes('T0_0'));
});

test('a review on an older commit does not clear the gate after a new push', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  // GitHub records the closing review on the commit before the push (a stale review): the gate sees none on the head.
  const { issue, world: w } = newWorld((world) => {
    oneFindingFirst(world);
    world.accepts = true;
    world.humanResolves = true;
    world.recordReviewOn = (round, head) => (round >= 1 ? HEAD0 : head);
  });

  const stopped = await stoppedWith(issue, FAKE_QUEUE);

  assert.equal(stopped.step, 'gate');
  assert.equal(stopped.reason, 'ReviewNotCounted', 'zero threads and a review only on an older commit is not clear');
  assert.equal(w.counters.fixerSessions, 1, 'it did not loop on a review that does not count');
  assert.deepEqual([...w.commentKeys.keys()], ['stopped-gate-ReviewNotCounted']);
});

test('zero threads with no review on the head is not clear', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue, world: w } = newWorld((world) => {
    world.recordReviewOn = () => undefined;
  });

  const stopped = await stoppedWith(issue, FAKE_QUEUE);

  assert.equal(stopped.reason, 'ReviewNotCounted');
  assert.equal(w.unresolved.length, 0);
  assert.equal(w.counters.reviewerSessions, 1, 'one review, not a loop of reviews');
});

test('the loop stops at the maximum rounds, comments once for the maintainer and leaves the PR to them', { timeout: 180_000 }, async () => {
  await ensureFakeWorker();
  // Every review finds one more problem and nobody accepts anything: the loop can only stop at its bound.
  const { issue, world: w } = newWorld((world) => {
    world.findings = () => 1;
  });

  const stopped = await stoppedWith(issue, FAKE_QUEUE);

  assert.equal(stopped.step, 'review_loop');
  assert.equal(stopped.reason, 'MaxRoundsReached');
  assert.equal(stopped.pr, issue + PR_OFFSET);
  assert.equal(DEFAULT_MAX_FIX_ROUNDS, 3, 'the default bound is the assumption the PR names');
  assert.equal(w.counters.fixerSessions, DEFAULT_MAX_FIX_ROUNDS, 'exactly the default number of fix rounds ran');
  assert.equal(w.counters.reviews, DEFAULT_MAX_FIX_ROUNDS + 1, 'each round was closed by a review on the new head, and the last one was read');
  assert.deepEqual([...w.commentKeys.keys()], ['stopped-review_loop-MaxRoundsReached']);
  assert.ok((w.commentKeys.get('stopped-review_loop-MaxRoundsReached') ?? '').includes(`#${issue + PR_OFFSET}`));
});

test('the maximum is an input too: one round when asked for one', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue, world: w } = newWorld((world) => {
    world.findings = () => 1;
  });

  const stopped = await stoppedWith(issue, FAKE_QUEUE, { maxFixRounds: 1 });

  assert.equal(stopped.reason, 'MaxRoundsReached');
  assert.equal(w.counters.fixerSessions, 1);
  assert.equal(w.counters.reviews, 2);
});

test('a bad bound is refused before any activity', { timeout: 60_000 }, async () => {
  await ensureFakeWorker();
  for (const extra of [{ maxFixRounds: 0 }, { maxFixRounds: 11 }, { maxFixRounds: 1.5 }, { reviewLoopTimeoutMs: 10 }]) {
    const { issue, world: w } = newWorld();
    const stopped = await stoppedWith(issue, FAKE_QUEUE, extra);
    assert.equal(stopped.type, 'InvalidInput', JSON.stringify(extra));
    assert.equal(w.firstHalf.sessions, 0);
  }
});

test('the total time is bounded: at the limit the running step is cancelled and the run stops with one comment', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue, world: w } = newWorld((world) => {
    world.reviewerDelayMs = 4_000;
  });

  const stopped = await stoppedWith(issue, FAKE_QUEUE, { reviewLoopTimeoutMs: 1_500 });

  assert.equal(stopped.step, 'review_loop');
  assert.equal(stopped.reason, 'ReviewLoopTimeout');
  assert.deepEqual([...w.commentKeys.keys()], ['stopped-review_loop-ReviewLoopTimeout']);
  assert.equal(w.counters.reviews, 0, 'no review was posted after the limit');
});

test('a failing reviewer ends the run with one comment on the issue and a stopped run, with no review and no fixer', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue, world: w } = newWorld((world) => {
    world.reviewerFails = 'SessionError';
  });

  const stopped = await stoppedWith(issue, FAKE_QUEUE);

  assert.equal(stopped.step, 'review_session');
  assert.equal(stopped.reason, 'SessionError');
  assert.equal(stopped.pr, issue + PR_OFFSET, 'the PR is named, it stays open for the maintainer');
  assert.equal(w.attempts['runReviewerSession'], 1, 'a failed premise is not retried');
  assert.equal(w.counters.reviews, 0);
  assert.equal(w.counters.fixerSessions, 0);
  assert.deepEqual([...w.commentKeys.keys()], ['stopped-review_session-SessionError']);
});

test('a failing fixer, a guard that refuses and a head the gate never shows each stop the run with a comment', { timeout: 180_000 }, async () => {
  await ensureFakeWorker();
  const fixer = newWorld((world) => {
    oneFindingFirst(world);
    world.fixerFails = 'SessionTimeout';
  });
  const guard = newWorld((world) => {
    oneFindingFirst(world);
    world.guardFails = 'ProtectedPath';
  });
  const lagging = newWorld((world) => {
    world.gateHead = () => 'f'.repeat(40);
  });

  const stoppedFixer = await stoppedWith(fixer.issue, FAKE_QUEUE);
  const stoppedGuard = await stoppedWith(guard.issue, FAKE_QUEUE);
  const stoppedLag = await stoppedWith(lagging.issue, FAKE_QUEUE);

  assert.deepEqual([stoppedFixer.step, stoppedFixer.reason], ['fix_session', 'SessionTimeout']);
  assert.deepEqual([stoppedGuard.step, stoppedGuard.reason], ['fix_guard', 'ProtectedPath']);
  assert.equal(guard.world.counters.pushes, 1, 'only the first push: the fixer commit never left');
  assert.equal(guard.world.counters.replies, 0, 'no reply is posted for a push that did not happen');
  assert.deepEqual([stoppedLag.step, stoppedLag.reason], ['gate', 'HeadMismatch']);
  assert.equal(lagging.world.attempts['getGateStatus'], 3, 'the gate was read a bounded number of times');
  assert.equal(lagging.world.counters.comments, 1);
});

test('advisory findings of the last review are in the result and in the waiting comment: a clear gate does not hide them', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const clear = newWorld((world) => {
    world.advisory = 2;
    world.advisoryOmitted = 1;
  });
  const waiting = newWorld((world) => {
    world.advisory = 3;
    world.threads.push({ id: 'STRANGER_1', trusted: false, resolved: false });
  });

  const result = await runIssue(FAKE_QUEUE, clear.issue);
  const other = await runIssue(FAKE_QUEUE, waiting.issue);

  assert.ok(result.outcome === 'gate_clear');
  assert.deepEqual([result.advisory, result.advisoryOmitted], [2, 1], 'clear, with 3 findings no thread holds');
  assert.ok(other.outcome === 'waiting_for_threads');
  assert.equal(other.advisory, 3);
  assert.ok((waiting.world.commentKeys.get(`waiting-threads-${waiting.issue + PR_OFFSET}`) ?? '').includes('3 advisory findings'));
});

test('a review count that lags the review just posted is read again, and only then does the run stop', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const lag = newWorld((world) => {
    world.reviewLagReads = 1;
  });
  const never = newWorld((world) => {
    world.recordReviewOn = () => undefined;
  });

  assert.equal((await runIssue(FAKE_QUEUE, lag.issue)).outcome, 'gate_clear');
  assert.equal(lag.world.attempts['getGateStatus'], 2);
  assert.equal((await stoppedWith(never.issue, FAKE_QUEUE)).reason, 'ReviewNotCounted');
  assert.equal(never.world.attempts['getGateStatus'], 3, 'the same bounded number of reads');
});

test('a gate read that lags one push behind is read again, and the run goes on', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue, world: w } = newWorld((world) => {
    world.gateHead = (reads) => (reads === 1 ? 'f'.repeat(40) : undefined);
  });

  const result = await runIssue(FAKE_QUEUE, issue);

  assert.equal(result.outcome, 'gate_clear');
  assert.equal(w.attempts['getGateStatus'], 2);
});

test('threads of an author the loop may not act on are left to the maintainer: no fixer, one comment, the run waits', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue, world: w } = newWorld((world) => {
    world.threads.push({ id: 'STRANGER_1', trusted: false, resolved: false });
  });

  const result = await runIssue(FAKE_QUEUE, issue);

  assert.equal(result.outcome, 'waiting_for_threads');
  assert.deepEqual(result.outcome === 'waiting_for_threads' ? result.acceptedThreadIds : undefined, []);
  assert.equal(w.counters.fixerSessions, 0);
  assert.equal(w.counters.comments, 1);
});

test('a fixer that changes nothing posts its replies, and the next review is on the same head under a new round', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue, world: w } = newWorld((world) => {
    oneFindingFirst(world);
    world.accepts = true;
    world.humanResolves = true;
    world.fixerMoves = false;
  });

  const result = await runIssue(FAKE_QUEUE, issue);

  assert.equal(result.outcome, 'gate_clear');
  assert.equal(w.counters.pushes, 1, 'nothing new to guard or push');
  assert.equal(w.counters.guards, 1);
  assert.equal(w.counters.replies, 1);
  assert.deepEqual(w.events.slice(-4), ['fixer:0', 'replies:0@a', 'reviewer:1', 'review:1@a']);
});

test('the finished run replays against the current workflow code, fix round included', { timeout: 120_000 }, async () => {
  await ensureFakeWorker();
  const { issue } = newWorld((world) => {
    oneFindingFirst(world);
    world.accepts = true;
    world.humanResolves = true;
  });
  await runIssue(FAKE_QUEUE, issue);
  const history = await client.workflow.getHandle(issueWorkflowId(issue)).fetchHistory();

  await Worker.runReplayHistory({ workflowBundle: bundle }, history, issueWorkflowId(issue));
});

test('a result lost after any one step is retried, and the run still ends with each side effect once', { timeout: 240_000 }, async () => {
  await ensureFakeWorker();
  const steps: LostStep[] = ['runReviewerSession', 'postSessionReview', 'runFixerSession', 'guardBranch', 'pushBranch', 'postFixerReplies'];
  const runs = steps.map((step) =>
    newWorld((world) => {
      oneFindingFirst(world);
      world.accepts = true;
      world.humanResolves = true;
      world.loseOnce.add(step);
    }),
  );

  const results = await Promise.all(runs.map(({ issue }) => runIssue(FAKE_QUEUE, issue)));

  for (const [index, { issue, world: w }] of runs.entries()) {
    const step = steps[index];
    assert.equal(results[index]?.outcome, 'gate_clear', step);
    assert.equal(w.loseOnce.size, 0, `${step}: the loss really happened`);
    assert.deepEqual(w.counters, { reviewerSessions: 2, reviews: 2, fixerSessions: 1, guards: 2, pushes: 2, replies: 1, comments: 0 }, `${step}: each side effect once`);
    assert.deepEqual(w.events, ['guard:a', 'push:a', 'reviewer:0', 'review:0@a', 'fixer:0', 'guard:1', 'push:1', 'replies:0@1', 'reviewer:1', 'review:1@1'], step);
    assert.deepEqual(w.reviews.map((review) => review.commit), [HEAD0, fixHead(0)], `${step}: one review per head`);
    assert.ok(issue > 0);
  }
  // The lost step ran twice (the attempt that died and its retry) and the steps before it did not run again.
  const [reviewer, post, fixer, guard, push, replies] = runs.map(({ world: w }) => w);
  assert.equal(reviewer?.attempts['runReviewerSession'], 3, 'the lost one ran twice in round 0, plus the round 1 session');
  assert.equal(post?.attempts['postSessionReview'], 3);
  assert.equal(fixer?.attempts['runFixerSession'], 2);
  assert.equal(guard?.attempts['guardBranch'], 3, 'the first push guard, the lost fix guard and its retry');
  assert.equal(push?.attempts['pushBranch'], 3);
  assert.equal(replies?.attempts['postFixerReplies'], 2);
  assert.equal(fixer?.attempts['postSessionReview'], 2, 'a step that finished is not run again after a replay');
});

// ---- the invariants, read from the code ---------------------------------------------------------------------

async function sourceFiles(root: string): Promise<{ name: string; text: string }[]> {
  const found: { name: string; text: string }[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sourceFiles(path)));
    } else if (entry.name.endsWith('.ts')) {
      found.push({ name: path.slice(SRC_DIR.length), text: await readFile(path, 'utf8') });
    }
  }
  return found;
}

test('nothing in the orchestrator resolves a thread, approves, requests changes, merges, labels or writes to the board outside the GitHub activities', async () => {
  const sources = await sourceFiles(SRC_DIR);
  assert.deepEqual(forbiddenCalls(sources), []);
  // The review is posted with the one event the repo allows. A second place that names an event would be a second path.
  const github = (await readFile(join(SRC_DIR, 'activities/github.ts'), 'utf8')).match(/event: '[A-Z_]+'/g);
  assert.deepEqual(github, ["event: 'COMMENT'"]);
});

test('the invariant check fails for each form a call could take, added to a scratch copy of the review activity', async () => {
  const sources = await sourceFiles(SRC_DIR);
  const review = sources.find((file) => file.name === 'activities/review.ts');
  assert.ok(review !== undefined);
  const others = sources.filter((file) => file !== review);
  const forms: [string, string][] = [
    ['a thread resolve string', "const q = 'mutation { resolveReviewThread(input: {}) { thread { id } } }';"],
    ['a thread resolve by concatenation', "const q = 'resolve' + 'ReviewThread';"],
    ['a thread resolve through a template', "const q = `resolve${'Review'}Thread`;"],
    ['a thread resolve through join', "const q = ['resolve', 'ReviewThread'].join('');"],
    ['a thread resolve route', "const route = `${repo}/pulls/${pr}/threads/${id}/resolve`;"],
    ['a merge argv', "const argv = ['pr', 'merge', '--squash'];"],
    ['a merge mutation', "const q = 'mutation { mergePullRequest(input: {}) { clientMutationId } }';"],
    ['a merge route', 'const route = `${repo}/pulls/${pr}/merge`;'],
    ['a merge method', 'await github.merge(pr);'],
    ['an approve argv', "const argv = ['pr', 'review', '--approve'];"],
    ['an approve event', "const event = 'APPROVE';"],
    ['an approve method', 'await github.approvePr(pr);'],
    ['a request-changes event', "const body = { event: 'REQUEST_CHANGES' };"],
    ['a label route', 'const route = `${repo}/issues/${n}/labels`;'],
    ['a label argv', "const argv = ['issue', 'edit', '--add-label', 'golden-change'];"],
    ['a label mutation', "const q = 'mutation { addLabelsToLabelable(input: {}) { clientMutationId } }';"],
    ['a label method', "await github.addLabels(pr, ['golden-change']);"],
    ['a Ready move by mutation', "const q = 'mutation { updateProjectV2ItemFieldValue(input: { value: { singleSelectOptionId: \"Ready\" } }) { clientMutationId } }';"],
    ['a board write by gh project outside the board activities', "await gh.project(['item-edit', '--id', id]);"],
    ['dynamic code', "eval('x');"],
    ['a merge call after a block comment on the same line', "/* ok */ await gh.api('repos/o/r/pulls/1/merge', { method: 'PUT' });"],
    ['a merge mutation on a template line that starts with a star', 'const q = `\n* mutation { mergePullRequest(input: {}) { clientMutationId } }\n`;'],
  ];
  for (const [name, line] of forms) {
    const scratch = { name: review.name, text: `${review.text}\n${line}\n` };
    assert.notDeepEqual(forbiddenCalls([...others, scratch]), [], `${name} must be caught`);
  }
  // The board activities may edit the board; nothing else may.
  const github = sources.find((file) => file.name === 'activities/github.ts');
  assert.ok(github !== undefined);
  assert.deepEqual(forbiddenCalls([github]), []);
  assert.notDeepEqual(forbiddenCalls([{ name: 'workflows/review-loop.ts', text: "await gh.project(['item-edit', '--id', id]);" }]), []);
  // What it says about itself: a literal text scan, so a name built at run time is not seen. That is why it is a tripwire.
  assert.deepEqual(forbiddenCalls([{ name: 'x.ts', text: "const name = ['resolve', suffix].join('');" }]), [], 'a name built from a variable is out of reach of a text scan');
});

// ---- layer 2: the real review activities against the fake gh and the fake claude ---------------------------------

const SECRET_FINDING = 'SECRET-FINDING-TEXT-handle-an-empty-file';
const SECRET_SUMMARY = 'SECRET-SUMMARY-TEXT-project-atlas';
const SECRET_REPLY = 'SECRET-REPLY-TEXT-handled-in-the-loop';
const SECRET_ISSUE = 'SECRET-ISSUE-BODY-project-atlas';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd });
  return stdout.trim();
}

/** The scripts the fake claude runs for the Nth session of a run: 1 is the implementer, 2 the first reviewer, and so on. */
const FINDING_REVIEW = `cat > review-findings.json <<'JSON'
{"summary":"${SECRET_SUMMARY}","findings":[{"path":"session.txt","line":1,"body":"${SECRET_FINDING}"}],"acceptedThreadIds":[]}
JSON
`;
const FIX_AND_REPLY = `echo "fixed" >> session.txt
git add session.txt
git -c user.name=Fake -c user.email=fake@example.invalid commit -q -m "fix the finding"
cat > fixer-replies.json <<'JSON'
{"replies":[{"threadId":"PRRT_PLACEHOLDER","body":"${SECRET_REPLY}"}]}
JSON
`;
const ACCEPTING_REVIEW = `cat > review-findings.json <<'JSON'
{"summary":"Re-checked the reply and the new commit.","findings":[],"acceptedThreadIds":["PRRT_PLACEHOLDER"]}
JSON
`;
const CLEAN_REVIEW = `cat > review-findings.json <<'JSON'
{"summary":"Checked the change against the issue.","findings":[],"acceptedThreadIds":[]}
JSON
`;

async function realStack(name: string, issue: number, scripts: Record<number, string>) {
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
  state.dynamicGate = true;
  state.board = [{ number: issue, status: 'Ready' }];
  state.issues[String(issue)] = rawIssue(issue, { body: SECRET_ISSUE });
  state.comments[String(issue)] = [rawComment(1, 'OWNER', 'Latest decision: keep it small.')];
  const fake = await createFake(home, 'gh', state);
  const sequence = join(home, 'sequence');
  await mkdir(sequence, { recursive: true });
  // The fake gh numbers the first PR 1001, and its first thread is `PRRT_1001_1`.
  for (const [n, body] of Object.entries(scripts)) {
    await writeFile(join(sequence, `${n}.sh`), body.replaceAll('PRRT_PLACEHOLDER', 'PRRT_1001_1'));
  }
  const logFile = join(home, 'claude.log');
  process.env['FAKE_CLAUDE_MODE'] = 'success';
  process.env['FAKE_CLAUDE_LOG'] = logFile;
  process.env['FAKE_CLAUDE_SEQUENCE'] = sequence;
  const github = createGithubActivities(fake.config);
  const claudeConfig = { ...loadClaudeConfig({}), claudeBin: FAKE_CLAUDE };
  const claude = createClaudeSessionActivities(claudeConfig);
  const implementer = createImplementerActivities({ readIssue: github.readIssue, runClaudeSession: claude.runClaudeSession, repo: fake.config.repo });
  const review = createReviewActivities({
    readIssue: github.readIssue,
    listReviewThreads: github.listReviewThreads,
    replyToThread: github.replyToThread,
    postReview: github.postReview,
    repo: fake.config.repo,
    claude: claudeConfig,
  });
  const taskQueue = `review-loop-real-${name}`;
  await startWorker(taskQueue, { ...github, ...createBranchActivities(), ...implementer, ...review });
  const input: IssueWorkflowInput = { issueNumber: issue, repoDir: repo, worktreeDir: join(home, 'wt'), base: 'main', awaitDecision: false };
  const sessions = async (): Promise<number> => {
    try {
      return (await readFile(logFile, 'utf8')).split('\n').filter((line) => line !== '').length;
    } catch {
      return 0;
    }
  };
  return { fake, taskQueue, input, sessions, bare, repo };
}

function historyStrings(history: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (value instanceof Uint8Array) {
      found.push(Buffer.from(value).toString('utf8'));
    } else if (typeof value === 'string') {
      found.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(walk);
    }
  };
  walk(history);
  return found;
}

function assertNoSessionText(history: unknown, label: string): void {
  const strings = historyStrings(history);
  assert.ok(strings.length > 20, `${label}: the history was read`);
  for (const marker of [SECRET_FINDING, SECRET_SUMMARY, SECRET_REPLY, SECRET_ISSUE, 'Latest decision', 'issue-data', 'thread-data', 'Co-Authored-By', '<!-- orchestrator-review', '<!-- orchestrator-reply', '"session_id"']) {
    assert.ok(!strings.some((text) => text.includes(marker)), `${label}: ${marker} must not be anywhere in the history, a failure message included`);
  }
}

test('real activities: a finding, a fix, a reply, an accepting closing review: the run waits for the maintainer, and no session text is in the history', { timeout: 300_000 }, async () => {
  const stack = await realStack('full', 401, { 2: FINDING_REVIEW, 3: FIX_AND_REPLY, 4: ACCEPTING_REVIEW });
  assert.equal((await startIssueRun(client, stack.taskQueue, stack.input)).status, 'started');

  const result = (await client.workflow.getHandle(issueWorkflowId(401)).result()) as IssueRunResult;

  assert.equal(result.outcome, 'waiting_for_threads', 'the thread stays open: only a person resolves it');
  assert.ok(result.outcome === 'waiting_for_threads');
  assert.deepEqual(result.acceptedThreadIds, ['PRRT_1001_1']);
  assert.equal(result.fixRounds, 1);
  assert.equal(await stack.sessions(), 4, 'implementer, reviewer, fixer, then a fresh reviewer');

  const state = await stack.fake.state();
  const reviews = state.reviews['1001'] as { body: string; commit_id: string; event: string; comments: unknown[] }[];
  assert.equal(reviews.length, 2, 'one review per head');
  assert.deepEqual(reviews.map((review) => review.event), ['COMMENT', 'COMMENT']);
  assert.notEqual(reviews[0]?.commit_id, reviews[1]?.commit_id, 'the closing review is on the new head');
  assert.equal(reviews[1]?.commit_id, result.headSha);
  assert.ok(JSON.stringify(reviews[0]).includes(SECRET_FINDING), 'the finding reached GitHub, through an activity');
  const thread = (state.threads?.['1001'] ?? []) as { isResolved: boolean; comments: { body: string }[] }[];
  assert.equal(thread.length, 1);
  assert.equal(thread[0]?.isResolved, false, 'nothing resolved the thread');
  assert.ok(thread[0]?.comments.some((comment) => comment.body.includes(SECRET_REPLY)), 'the reply is in the thread, posted by an activity');
  // The fix really was pushed (the guard ran, the session could not push) and the head on origin is the one reviewed.
  const remote = await execFileAsync('git', ['ls-remote', '--heads', stack.bare, 'refs/heads/claude/401']);
  assert.ok(remote.stdout.startsWith(result.headSha));
  const calls = (await stack.fake.calls()).map((call) => call.argv.join(' ') + (call.stdin ?? '')).join('\n');
  assert.ok(!/resolveReviewThread|mutation|\/merge|--add-label|"event":"(APPROVE|REQUEST_CHANGES)"|golden-change/i.test(calls), 'no call resolves, merges, labels, approves or requests changes');

  const history = await client.workflow.getHandle(issueWorkflowId(401)).fetchHistory();
  assertNoSessionText(history, 'the finished run');
  await Worker.runReplayHistory({ workflowBundle: bundle }, history, issueWorkflowId(401));
});

test('real activities: a reviewer file that is oversized or malformed is refused, stops the run, and reaches no history and no PR', { timeout: 300_000 }, async () => {
  const oversized = `head -c 70000 /dev/zero | tr '\\0' 'x' > review-findings.json\necho "${SECRET_FINDING}" >> review-findings.json\n`;
  const malformed = `echo '{"summary": "${SECRET_SUMMARY}", "findings": "not a list"}' > review-findings.json\n`;
  for (const [name, issue, script, reason] of [
    ['oversized', 402, oversized, 'FindingsTooLarge'],
    ['malformed', 403, malformed, 'MalformedFindings'],
  ] as const) {
    const stack = await realStack(name, issue, { 2: script });
    await startIssueRun(client, stack.taskQueue, stack.input);

    await assert.rejects(client.workflow.getHandle(issueWorkflowId(issue)).result(), WorkflowFailedError);

    const state = await stack.fake.state();
    assert.equal((state.reviews[String(issue + PR_OFFSET)] ?? []).length, 0, `${name}: no review was posted`);
    const comments = (state.comments[String(issue)] ?? []).filter((comment) => JSON.stringify(comment).includes('orchestrator-comment'));
    assert.equal(comments.length, 1);
    assert.ok(JSON.stringify(comments[0]).includes(reason), `${name}: the stop comment names the reason`);
    assert.ok(!JSON.stringify(comments[0]).includes(SECRET_FINDING) && !JSON.stringify(comments[0]).includes(SECRET_SUMMARY));
    const history = await client.workflow.getHandle(issueWorkflowId(issue)).fetchHistory();
    assertNoSessionText(history, name);
    assert.ok(historyStrings(history).some((text) => text.includes(reason)), `${name}: the reason is in the history as a type`);
    assert.equal(await stack.sessions(), 2, `${name}: a refused file is not retried with a second session`);
  }
});

test('real activities: a clean review of a clean PR clears the gate with no fixer, in one reviewer session', { timeout: 300_000 }, async () => {
  const stack = await realStack('clean', 404, { 2: CLEAN_REVIEW });
  await startIssueRun(client, stack.taskQueue, stack.input);

  const result = (await client.workflow.getHandle(issueWorkflowId(404)).result()) as IssueRunResult;

  assert.equal(result.outcome, 'gate_clear');
  assert.equal(await stack.sessions(), 2);
  const state = await stack.fake.state();
  assert.equal((state.reviews['1001'] ?? []).length, 1);
  assert.equal((await stack.fake.callsMatching('/replies')).length, 0);
  assert.deepEqual(await readdir(join(dir, 'clean')).then((names) => names.includes('wt-review-0')), true, 'the reviewer had its own worktree');
});

