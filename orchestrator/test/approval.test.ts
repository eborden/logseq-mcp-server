// The maintainer's decision as a signal (#631) against a real Temporal server (an in-memory dev server on a free port)
// and no real service. The activities are fakes that model one PR with counters, so each side effect can be counted
// and each result lost. No test calls GitHub or the model. Every name is made up (issue 123, Alice, "project atlas").
//
// The waits are real but short: the dev server is not the time-skipping test server (its download is blocked in the
// cloud), so the timeouts and the poll are set through the input to a second or two.
//
// The workers run with `maxCachedWorkflows: 0`, so every workflow task replays the whole history.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/activity';
import { WorkflowFailedError } from '@temporalio/client';
import type { Client } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import type { WorkflowBundleWithSourceMap } from '@temporalio/worker';
import {
  InvalidDecisionError,
  MAX_DECISION_MESSAGE_CHARS,
  classifyChangedPaths,
  decisionComment,
  isCalendarDate,
  maintainerDecisionSignal,
  parseMaintainerDecision,
  parseSignalArgs,
  quoteMessage,
} from '../src/approval-types.ts';
import { loadServerConfig } from '../src/config.ts';
import { startDevServer } from '../src/dev-server.ts';
import { startIssueRun } from '../src/issue-client.ts';
import { ISSUE_STOPPED_FAILURE, issueWorkflowId, parseIssueWorkflowInput } from '../src/issue-types.ts';
import type { IssueRunResult, IssueWorkflowInput } from '../src/issue-types.ts';
import type { BoardItemRef } from '../src/types.ts';
import { forbiddenCalls } from './invariants.ts';
import { freePort } from './support.ts';

const WORKFLOWS_PATH = fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const HEAD = 'a'.repeat(40);
const PR_OFFSET = 1000;

// ---- the pure parts ----------------------------------------------------------------------------------------------

test('a decision payload is parsed at the boundary: kind, calendar date and an optional bounded message', () => {
  assert.deepEqual(parseMaintainerDecision({ decision: 'approved', at: '2025-01-31' }), { decision: 'approved', at: '2025-01-31' });
  assert.deepEqual(parseMaintainerDecision({ decision: 'changes_requested', at: '2025-02-28', message: 'Please add a test.' }), {
    decision: 'changes_requested',
    at: '2025-02-28',
    message: 'Please add a test.',
  });
  const bad: unknown[] = [
    undefined,
    null,
    'approved',
    [],
    {},
    { decision: 'approve', at: '2025-01-31' },
    { decision: 'APPROVED', at: '2025-01-31' },
    { decision: 'approved' },
    { decision: 'approved', at: '2025-02-30' },
    { decision: 'approved', at: '2025-13-01' },
    { decision: 'approved', at: '20250131' },
    { decision: 'approved', at: '2025-01-31', message: '' },
    { decision: 'approved', at: '2025-01-31', message: '   ' },
    { decision: 'approved', at: '2025-01-31', message: 5 },
    { decision: 'approved', at: '2025-01-31', message: 'x'.repeat(MAX_DECISION_MESSAGE_CHARS + 1) },
    { decision: 'approved', at: '2025-01-31', message: 'a\u0000b' },
    { decision: 'approved', at: '2025-01-31', message: 'a\u202eb' },
    { decision: 'approved', at: '2025-01-31', message: 'a\u2028b' },
    { decision: 'approved', at: '2025-01-31', message: 'a\rb' },
  ];
  for (const raw of bad) {
    assert.throws(() => parseMaintainerDecision(raw), InvalidDecisionError, JSON.stringify(raw));
  }
  assert.equal(isCalendarDate('2024-02-29'), true, 'a leap day');
  assert.equal(isCalendarDate('2025-02-29'), false);
});

test('the signal CLI arguments are parsed into the same payload', () => {
  const parsed = parseSignalArgs(['123', 'approved'], 'Looks right.', '2025-03-04');
  assert.deepEqual(parsed.args, { issue: 123, decision: 'approved', message: 'Looks right.' });
  assert.deepEqual(parsed.payload, { decision: 'approved', at: '2025-03-04', message: 'Looks right.' });
  assert.deepEqual(parseSignalArgs(['7', 'changes_requested'], undefined, '2025-03-04').payload, { decision: 'changes_requested', at: '2025-03-04' });
  for (const positionals of [[], ['123'], ['123', 'approved', 'extra'], ['0', 'approved'], ['x', 'approved'], ['-1', 'approved'], ['123', 'merge'], ['123', 'approve']]) {
    assert.throws(() => parseSignalArgs(positionals, undefined, '2025-03-04'), InvalidDecisionError, positionals.join(' '));
  }
});

test('a PR is sorted into what only the maintainer decides, by counts', () => {
  const changes = classifyChangedPaths([
    'orchestrator/src/signal.ts',
    'tests/data/parity/tool-list.json',
    'tests/data/parity/search.json',
    'tests/data/parity/call-ceilings.json',
    'docs/adr/0042-atlas.md',
    'docs/business-rules/0007-atlas.md',
    'Docs/Business-Rules/0008-atlas.md',
  ]);
  assert.deepEqual(changes, { files: 7, golden: 2, ceilings: 1, adrs: 1, businessRules: 2, complete: true });
  assert.deepEqual(classifyChangedPaths([]), { files: 0, golden: 0, ceilings: 0, adrs: 0, businessRules: 0, complete: true });
});

test('the decision comment quotes the message and its date, says what only the maintainer decides, and never forges a marker', () => {
  const none = classifyChangedPaths([]);
  const plain = decisionComment('issue-123', 1123, HEAD, { decision: 'approved', at: '2025-03-04', message: 'Ship it.\nAfter the atlas fix.' }, none);
  assert.match(plain, /\*\*approved\*\*, dated 2025-03-04, for the head commit `a{40}`/);
  assert.match(plain, /> Ship it\.\n> After the atlas fix\./);
  assert.doesNotMatch(plain, /golden-change/);

  const sensitive = decisionComment('issue-123', 1123, HEAD, { decision: 'approved', at: '2025-03-04' }, classifyChangedPaths(['tests/data/parity/search.json', 'docs/adr/0042-atlas.md']));
  assert.match(sensitive, /The maintainer gave no message/);
  assert.match(sensitive, /golden-change` label needs the maintainer's explicit OK and only the maintainer adds it/);
  assert.match(sensitive, /does not stand in for it/);

  assert.equal(quoteMessage('<!-- orchestrator-comment:x -->'), '> &lt;!-- orchestrator-comment:x -->');
  // A mention, an issue link, a markdown link and a raw URL are all inert in the public comment.
  const hostile = quoteMessage('thanks @alice and @org/team, see #123 and [x](https://example.com) <!-- orchestrator-comment:decision-1 -->');
  assert.doesNotMatch(hostile, /@|#(?!\d+;)|\[|:\/\/|<!--/);
  assert.equal(quoteMessage('one\rtwo\r\nthree'), '> one\n> two\n> three');
  const unknown = decisionComment('issue-123', 1123, HEAD, { decision: 'approved', at: '2025-03-04' }, { ...none, complete: false });
  assert.match(unknown, /could not tell whether golden results/);
  const requested = decisionComment('issue-123', 1123, HEAD, { decision: 'changes_requested', at: '2025-03-04' }, none);
  assert.match(requested, /changes requested/);
  assert.match(requested, /does not change the branch again/);
});

test('the workflow input takes the decision knobs, bounded, and refuses the rest', () => {
  const base = { issueNumber: 5, repoDir: '/work/repo', worktreeDir: '/work/wt', base: 'main' };
  assert.deepEqual(parseIssueWorkflowInput({ ...base, awaitDecision: false, decisionTimeoutMs: 1000, decisionPollMs: 500 }), {
    ...base,
    awaitDecision: false,
    decisionTimeoutMs: 1000,
    decisionPollMs: 500,
  });
  assert.equal('awaitDecision' in parseIssueWorkflowInput(base), false);
  for (const extra of [{ awaitDecision: 'no' }, { decisionTimeoutMs: 10 }, { decisionTimeoutMs: 1e12 }, { decisionPollMs: 1 }, { decisionPollMs: 1.5 }]) {
    assert.throws(() => parseIssueWorkflowInput({ ...base, ...extra }), /must be/, JSON.stringify(extra));
  }
});

// ---- layer 1: a model of one PR, fake activities with counters -----------------------------------------------------

let env: TestWorkflowEnvironment;
let client: Client;
let bundle: WorkflowBundleWithSourceMap;
const workers: { worker: Worker; running: Promise<void> }[] = [];

before(async () => {
  env = await startDevServer({ port: await freePort(), cliPath: loadServerConfig(process.env).cliPath });
  client = env.client;
  bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH });
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: 'default',
    taskQueue: QUEUE,
    workflowBundle: bundle,
    activities: fakeActivities(),
    maxCachedWorkflows: 0,
  });
  workers.push({ worker, running: worker.run() });
});

after(async () => {
  for (const { worker } of workers) {
    worker.shutdown();
  }
  await Promise.allSettled(workers.map(({ running }) => running));
  await env?.teardown();
});

const QUEUE = 'approval-fakes';

class World {
  /** The gate read (1-based, across the whole run) from which the gate is clear. Read 1 is the review loop's and is always clear. */
  clearFromRead = 2;
  gateReads = 0;
  /** What the PR changes, as the activity's counts. */
  changedFiles: string[] = [];
  merged = false;
  prState: 'open' | 'closed' = 'open';
  prHead = HEAD;
  /** The issue is still open after the PR merged (a merge into a feature branch closes nothing). */
  issueOpen = true;
  /** `closeIssue` leaves the issue open, as a broken write would. */
  closeIgnored = false;
  prStatus: string | undefined;
  issueStatus = 'Ready';
  readonly statusWrites: string[] = [];
  readonly comments = new Map<string, { body: string; gateReadsAtPost: number; target: number }>();
  readonly counters = { closeIssue: 0, getPrState: 0, getPrChanges: 0, commentCalls: 0 };
  readonly loseOnce = new Set<string>();

  lose(name: string): void {
    if (this.loseOnce.delete(name)) {
      throw new Error('simulated: the worker died after the side effect');
    }
  }
}

const worlds = new Map<number, World>();
let nextIssue = 300;

function newWorld(configure: (world: World) => void = () => undefined): { issue: number; world: World } {
  nextIssue += 1;
  const world = new World();
  configure(world);
  worlds.set(nextIssue, world);
  return { issue: nextIssue, world };
}

function fakeActivities() {
  const world = (issue: number): World => {
    const found = worlds.get(issue);
    assert.ok(found, `no world for issue ${issue}`);
    return found;
  };
  const worldOf = (target: BoardItemRef): { w: World; kind: 'issue' | 'pr' } => ({ w: world(target.kind === 'pr' ? target.number - PR_OFFSET : target.number), kind: target.kind });
  return {
    checkIssue: async (issue: number) => ({ number: issue, open: world(issue).issueOpen, trustedComments: 1, droppedUntrustedComments: 0 }),
    claimIssue: async (issue: number) => {
      const w = world(issue);
      const claimed = w.issueStatus === 'Ready';
      w.issueStatus = 'In progress';
      return { claimed, reason: claimed ? ('claimed' as const) : ('already_in_progress' as const), proceed: true };
    },
    runImplementerSession: async (raw: IssueWorkflowInput) => ({ branch: `claude/${raw.issueNumber}`, headSha: HEAD, exitStatus: 'success' as const }),
    guardBranch: async (raw: { branch: string; headSha: string }) => ({ branch: raw.branch, headSha: raw.headSha, files: 1 }),
    pushBranch: async (raw: { branch: string; headSha: string }) => ({ branch: raw.branch, headSha: raw.headSha }),
    openPr: async (input: { head: string }) => {
      const issue = Number(/^claude\/(\d+)$/.exec(input.head)?.[1]);
      return { number: issue + PR_OFFSET, url: `https://github.com/eborden/logseq-mcp-server/pull/${issue + PR_OFFSET}`, created: true };
    },
    addToBoard: async (target: BoardItemRef) => {
      const { w } = worldOf(target);
      const added = w.prStatus === undefined;
      w.prStatus ??= 'Backlog';
      return { kind: target.kind, number: target.number, itemId: 'PVTI_x', added, status: w.prStatus };
    },
    getBoardStatus: async (target: BoardItemRef) => {
      const { w, kind } = worldOf(target);
      const status = kind === 'pr' ? w.prStatus : w.issueStatus;
      return { kind, number: target.number, onBoard: status !== undefined, status: status ?? null };
    },
    setStatus: async (target: BoardItemRef, status: string) => {
      const { w, kind } = worldOf(target);
      const current = kind === 'pr' ? w.prStatus : w.issueStatus;
      const changed = current !== status;
      if (changed) {
        if (kind === 'pr') {
          w.prStatus = status;
        } else {
          w.issueStatus = status;
        }
        w.statusWrites.push(`${kind}:${status}`);
      }
      w.lose(`setStatus:${kind}:${status}`);
      return { changed, status };
    },
    runReviewerSession: async () => ({ findings: 0, acceptedThreadIds: [] }),
    postSessionReview: async () => ({ reviewId: 1, posted: true, comments: 0, advisory: 0, omitted: 0 }),
    getGateStatus: async (pr: number) => {
      const w = world(pr - PR_OFFSET);
      w.gateReads += 1;
      const clear = w.gateReads === 1 || w.gateReads >= w.clearFromRead;
      return { headSha: w.prHead, reviewsOnHead: clear ? 1 : 0, unresolvedThreads: clear ? 0 : 1, clear };
    },
    commentIssue: async (input: { issue: number; key: string; body: string }) => {
      // A comment on the PR (its number) or on the issue.
      const w = world(input.issue >= PR_OFFSET ? input.issue - PR_OFFSET : input.issue);
      w.counters.commentCalls += 1;
      const posted = !w.comments.has(input.key);
      if (posted) {
        w.comments.set(input.key, { body: input.body, gateReadsAtPost: w.gateReads, target: input.issue });
      }
      w.lose(`commentIssue:${input.key}`);
      return { commentId: 1, posted };
    },
    getPrState: async (pr: number) => {
      const w = world(pr - PR_OFFSET);
      w.counters.getPrState += 1;
      return { state: w.merged ? ('closed' as const) : w.prState, merged: w.merged, headSha: w.prHead };
    },
    getPrChanges: async (pr: number) => {
      const w = world(pr - PR_OFFSET);
      w.counters.getPrChanges += 1;
      return classifyChangedPaths(w.changedFiles);
    },
    closeIssue: async (issue: number) => {
      const w = world(issue);
      w.counters.closeIssue += 1;
      const changed = w.issueOpen;
      if (!w.closeIgnored) {
        w.issueOpen = false;
      }
      w.lose('closeIssue');
      return { changed, closed: true as const };
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

async function until(what: string, ready: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const APPROVED = { decision: 'approved', at: '2025-03-04', message: 'Ship it, project atlas is ready.' };

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

test('approved on a clear gate: one decision comment, then the merge is observed, PR and issue go Done, and the open issue is closed', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.changedFiles = ['orchestrator/src/atlas.ts'];
  });
  const handle = await startRun(issue);
  await until('the run to wait at a clear gate', () => world.gateReads >= 2);
  await handle.signal(maintainerDecisionSignal, APPROVED);
  const key = `decision-${issue + PR_OFFSET}`;
  await until('the decision comment', () => world.comments.has(key));
  assert.equal(world.statusWrites.includes('pr:Done'), false, 'nothing moves to Done before the merge');
  assert.equal(world.merged, false);
  world.merged = true;

  const result = await resultOf(issue);

  assert.deepEqual(result, { outcome: 'merged', issueNumber: issue, pr: issue + PR_OFFSET, headSha: HEAD, issueClosedByRun: true, decisionRecorded: true, ignoredSignals: 0, prBody: { source: 'unknown', unmet: 0 } });
  const comment = world.comments.get(key);
  assert.ok(comment);
  assert.equal(comment.target, issue + PR_OFFSET, 'the comment is on the PR');
  assert.match(comment.body, /\*\*approved\*\*, dated 2025-03-04/);
  assert.match(comment.body, /> Ship it, project atlas is ready\./);
  assert.deepEqual(world.statusWrites, ['pr:In review', 'issue:In review', 'pr:Done', 'issue:Done']);
  assert.equal(world.prStatus, 'Done');
  assert.equal(world.issueStatus, 'Done');
  assert.equal(world.counters.closeIssue, 1);
  assert.equal(world.issueOpen, false);
  assert.equal(world.counters.getPrChanges, 1);
});

test('an issue that is already closed when the PR merges is checked and left alone', { timeout: 120_000 }, async () => {
  // The first check of an issue happens at the start of the run, so it is open for that read only.
  const { issue, world } = newWorld();
  const handle = await startRun(issue);
  await until('a clear gate', () => world.gateReads >= 2);
  world.issueOpen = false;
  await handle.signal(maintainerDecisionSignal, APPROVED);
  await until('the decision comment', () => world.comments.has(`decision-${issue + PR_OFFSET}`));
  world.merged = true;

  const result = await resultOf(issue);

  assert.equal(result.outcome, 'merged');
  assert.equal(result.outcome === 'merged' ? result.issueClosedByRun : undefined, false);
  assert.equal(world.counters.closeIssue, 0, 'a closed issue is not written to');
});

test('a close that GitHub does not show stops the run: the issue is read again, not assumed closed', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.closeIgnored = true;
  });
  const handle = await startRun(issue);
  await until('a clear gate', () => world.gateReads >= 2);
  await handle.signal(maintainerDecisionSignal, APPROVED);
  await until('the decision comment', () => world.comments.has(`decision-${issue + PR_OFFSET}`));
  world.merged = true;

  assert.deepEqual(await stoppedWith(issue), { step: 'issue_close', reason: 'IssueStillOpen' });
  assert.equal(world.counters.closeIssue, 1);
});

test('a signal before the gate clears is held until it does: no comment and no merge wait while a thread is open', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.clearFromRead = 5;
  });
  const handle = await startRun(issue);
  await handle.signal(maintainerDecisionSignal, APPROVED);
  await until('the gate to clear', () => world.gateReads >= 5);
  await until('the decision comment', () => world.comments.has(`decision-${issue + PR_OFFSET}`));
  world.merged = true;

  const result = await resultOf(issue);

  assert.equal(result.outcome, 'merged');
  const comment = world.comments.get(`decision-${issue + PR_OFFSET}`);
  assert.ok(comment);
  assert.ok(comment.gateReadsAtPost >= 5, 'the decision was applied only after the gate read clear');
  assert.equal(world.counters.commentCalls >= 1, true);
});

test('a decision that arrives while a thread is open is not used until the gate is clear again', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.clearFromRead = 2;
  });
  const handle = await startRun(issue);
  await until('the run to wait at a clear gate', () => world.gateReads >= 2);
  // A person opens a thread: the gate is not clear when the decision arrives.
  world.clearFromRead = world.gateReads + 4;
  await handle.signal(maintainerDecisionSignal, APPROVED);
  await until('the gate to clear again', () => world.gateReads >= world.clearFromRead);
  await until('the decision comment', () => world.comments.has(`decision-${issue + PR_OFFSET}`));
  assert.ok((world.comments.get(`decision-${issue + PR_OFFSET}`)?.gateReadsAtPost ?? 0) >= world.clearFromRead);
  world.merged = true;
  assert.equal((await resultOf(issue)).outcome, 'merged');
});

test('a timeout comments on the PR and stops: it never approves, never moves anything and never waits for a merge', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld();
  await startRun(issue, { decisionTimeoutMs: 1_500 });

  const result = await resultOf(issue);

  assert.deepEqual(result, { outcome: 'decision_timeout', issueNumber: issue, pr: issue + PR_OFFSET, headSha: HEAD, ignoredSignals: 0, prBody: { source: 'unknown', unmet: 0 } });
  assert.deepEqual([...world.comments.keys()], [`decision-timeout-${issue + PR_OFFSET}`]);
  assert.equal(world.comments.get(`decision-timeout-${issue + PR_OFFSET}`)?.target, issue + PR_OFFSET);
  assert.match(world.comments.get(`decision-timeout-${issue + PR_OFFSET}`)?.body ?? '', /A timeout never approves/);
  assert.equal(world.counters.getPrChanges, 0);
  assert.deepEqual(world.statusWrites, ['pr:In review', 'issue:In review']);
  assert.equal(world.prStatus, 'In review');
  assert.equal(world.issueOpen, true);
});

test('a gate that never clears also times out without a decision being used', { timeout: 120_000 }, async () => {
  // Read 1 is the review loop's and is always clear; every read after it is not.
  const { issue, world } = newWorld((w) => {
    w.clearFromRead = 1_000_000;
  });
  const handle = await startRun(issue, { decisionTimeoutMs: 2_000 });
  await handle.signal(maintainerDecisionSignal, APPROVED);

  const result = await resultOf(issue);

  assert.equal(result.outcome, 'decision_timeout');
  assert.equal(world.comments.has(`decision-${issue + PR_OFFSET}`), false, 'a held decision is never applied on an open gate');
  assert.deepEqual(world.statusWrites, ['pr:In review', 'issue:In review']);
});

test('a duplicate, a different later word and a malformed payload change nothing: the first decision is the one recorded, once', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.clearFromRead = 4;
  });
  const handle = await startRun(issue);
  await handle.signal(maintainerDecisionSignal, { decision: 'nonsense', at: '2025-03-04' });
  await handle.signal(maintainerDecisionSignal, APPROVED);
  await handle.signal(maintainerDecisionSignal, APPROVED);
  await handle.signal(maintainerDecisionSignal, { decision: 'changes_requested', at: '2025-03-05', message: 'Wait.' });
  await handle.signal(maintainerDecisionSignal, 'approved');
  await until('the decision comment', () => world.comments.has(`decision-${issue + PR_OFFSET}`));
  world.merged = true;

  const result = await resultOf(issue);

  assert.equal(result.outcome, 'merged');
  assert.equal(result.outcome === 'merged' ? result.ignoredSignals : undefined, 4);
  assert.deepEqual([...world.comments.keys()], [`decision-${issue + PR_OFFSET}`]);
  assert.match(world.comments.get(`decision-${issue + PR_OFFSET}`)?.body ?? '', /\*\*approved\*\*, dated 2025-03-04/);
  assert.equal(world.counters.getPrChanges, 1);
  assert.equal(world.counters.closeIssue, 1);
  assert.deepEqual(world.statusWrites.filter((write) => write.endsWith('Done')), ['pr:Done', 'issue:Done'], 'each Done once');
});

test('a malformed signal alone is not a decision: the run times out', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld();
  const handle = await startRun(issue, { decisionTimeoutMs: 2_000 });
  await handle.signal(maintainerDecisionSignal, { decision: 'approved' });
  await handle.signal(maintainerDecisionSignal, { decision: 'approved', at: '2025-02-30' });

  const result = await resultOf(issue);

  assert.deepEqual(result, { outcome: 'decision_timeout', issueNumber: issue, pr: issue + PR_OFFSET, headSha: HEAD, ignoredSignals: 2, prBody: { source: 'unknown', unmet: 0 } });
  assert.equal(world.comments.has(`decision-${issue + PR_OFFSET}`), false);
});

test('changes_requested posts the decision comment and ends the run: no merge wait, nothing moves', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.changedFiles = ['tests/data/parity/search.json', 'docs/business-rules/0007-atlas.md'];
  });
  const handle = await startRun(issue);
  await until('a clear gate', () => world.gateReads >= 2);
  await handle.signal(maintainerDecisionSignal, { decision: 'changes_requested', at: '2025-03-04', message: 'Rename the atlas helper.' });

  const result = await resultOf(issue);

  assert.deepEqual(result, { outcome: 'changes_requested', issueNumber: issue, pr: issue + PR_OFFSET, headSha: HEAD, ignoredSignals: 0, prBody: { source: 'unknown', unmet: 0 } });
  const comment = world.comments.get(`decision-${issue + PR_OFFSET}`)?.body ?? '';
  assert.match(comment, /changes requested/);
  assert.match(comment, /> Rename the atlas helper\./);
  assert.match(comment, /golden-change/, 'a PR that changes golden results says the label is the maintainer\'s');
  assert.match(comment, /business rule file/);
  assert.deepEqual(world.statusWrites, ['pr:In review', 'issue:In review']);
});

test('a PR closed unmerged, or pushed to after the approval, stops the run and moves nothing to Done', { timeout: 120_000 }, async () => {
  const closed = newWorld();
  const moved = newWorld();
  for (const { issue, world } of [closed, moved]) {
    const handle = await startRun(issue);
    await until('a clear gate', () => world.gateReads >= 2);
    await handle.signal(maintainerDecisionSignal, APPROVED);
    await until('the decision comment', () => world.comments.has(`decision-${issue + PR_OFFSET}`));
  }
  closed.world.prState = 'closed';
  moved.world.prHead = 'b'.repeat(40);

  assert.deepEqual(await stoppedWith(closed.issue), { step: 'merge_wait', reason: 'PrClosedUnmerged' });
  assert.deepEqual(await stoppedWith(moved.issue), { step: 'merge_wait', reason: 'HeadMovedAfterApproval' });
  for (const { world } of [closed, moved]) {
    assert.deepEqual(world.statusWrites, ['pr:In review', 'issue:In review']);
    assert.equal(world.issueOpen, true);
    assert.equal(world.counters.closeIssue, 0);
  }
});

test('an approval the PR never merges for times out in the merge wait: the PR is commented, nothing moves to Done', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld();
  const handle = await startRun(issue, { decisionTimeoutMs: 3_000 });
  await until('a clear gate', () => world.gateReads >= 2);
  await handle.signal(maintainerDecisionSignal, APPROVED);

  const result = await resultOf(issue);

  assert.deepEqual(result, { outcome: 'merge_timeout', issueNumber: issue, pr: issue + PR_OFFSET, headSha: HEAD, ignoredSignals: 0, prBody: { source: 'unknown', unmet: 0 } });
  assert.ok(world.comments.has(`merge-timeout-${issue + PR_OFFSET}`));
  assert.deepEqual(world.statusWrites, ['pr:In review', 'issue:In review']);
  assert.equal(world.counters.closeIssue, 0);
});

test('a result lost after the decision comment, a Done move or the close is retried and each side effect happens once', { timeout: 180_000 }, async () => {
  const lost = newWorld();
  const key = (issue: number): string => `decision-${issue + PR_OFFSET}`;
  for (const name of [`commentIssue:${key(lost.issue)}`, 'setStatus:pr:Done', 'setStatus:issue:Done', 'closeIssue']) {
    lost.world.loseOnce.add(name);
  }
  const handle = await startRun(lost.issue);
  await until('a clear gate', () => lost.world.gateReads >= 2);
  await handle.signal(maintainerDecisionSignal, APPROVED);
  await until('the decision comment', () => lost.world.comments.has(key(lost.issue)));
  lost.world.merged = true;

  const result = await resultOf(lost.issue);

  assert.equal(result.outcome, 'merged');
  assert.equal(lost.world.loseOnce.size, 0, 'every loss really happened');
  assert.deepEqual([...lost.world.comments.keys()], [key(lost.issue)]);
  assert.deepEqual(lost.world.statusWrites.filter((write) => write.endsWith('Done')), ['pr:Done', 'issue:Done']);
  assert.equal(lost.world.issueOpen, false);
  assert.equal(lost.world.counters.commentCalls, 2, 'the decision comment ran twice (the lost attempt and its retry), the other comment never');
  assert.equal(handle.workflowId, issueWorkflowId(lost.issue));
});

test('a PR merged with no signal goes to Done and the closed check, and says no decision was recorded', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld();
  const handle = await startRun(issue);
  await until('a clear gate', () => world.gateReads >= 2);
  world.merged = true;

  const result = await resultOf(issue);

  assert.deepEqual(result, { outcome: 'merged', issueNumber: issue, pr: issue + PR_OFFSET, headSha: HEAD, issueClosedByRun: true, decisionRecorded: false, ignoredSignals: 0, prBody: { source: 'unknown', unmet: 0 } });
  assert.deepEqual([...world.comments.keys()], [`merged-without-decision-${issue + PR_OFFSET}`]);
  assert.deepEqual(world.statusWrites.filter((write) => write.endsWith('Done')), ['pr:Done', 'issue:Done']);
  assert.equal(world.issueOpen, false);
  assert.equal(handle.workflowId, issueWorkflowId(issue));
});

test('a PR closed unmerged while the run waits for a decision stops the run: it does not wait out the timeout', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld();
  await startRun(issue);
  await until('a clear gate', () => world.gateReads >= 2);
  world.prState = 'closed';

  assert.deepEqual(await stoppedWith(issue), { step: 'decision_gate', reason: 'PrClosedUnmerged' });
  assert.deepEqual(world.statusWrites, ['pr:In review', 'issue:In review']);
});

test('a PR merged while a decision is still held records the held decision, then goes to Done', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.clearFromRead = 1_000_000;
  });
  world.clearFromRead = 2;
  const handle = await startRun(issue);
  await until('the decision stage', () => world.gateReads >= 2);
  world.clearFromRead = 1_000_000;
  await handle.signal(maintainerDecisionSignal, APPROVED);
  world.merged = true;

  const result = await resultOf(issue);

  assert.equal(result.outcome, 'merged');
  assert.equal(result.outcome === 'merged' ? result.decisionRecorded : undefined, true);
  assert.ok(world.comments.has(`decision-${issue + PR_OFFSET}`));
});

test('the finished run replays against the current workflow code', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld();
  const handle = await startRun(issue);
  await until('a clear gate', () => world.gateReads >= 2);
  await handle.signal(maintainerDecisionSignal, APPROVED);
  await until('the decision comment', () => world.comments.has(`decision-${issue + PR_OFFSET}`));
  world.merged = true;
  await resultOf(issue);

  await Worker.runReplayHistory({ workflowBundle: bundle }, await handle.fetchHistory(), issueWorkflowId(issue));
});

test('the history carries identifiers, counts and the maintainer own message: no changed path', { timeout: 120_000 }, async () => {
  const { issue, world } = newWorld((w) => {
    w.changedFiles = ['orchestrator/src/atlas-secret-name.ts'];
  });
  const handle = await startRun(issue);
  await until('a clear gate', () => world.gateReads >= 2);
  await handle.signal(maintainerDecisionSignal, { decision: 'changes_requested', at: '2025-03-04', message: 'Rename the atlas helper.' });
  await resultOf(issue);

  // Payloads are base64 in the history's JSON: decode them to read what is in them.
  const raw = JSON.stringify(await handle.fetchHistory());
  const history = [...raw.matchAll(/"data":"([A-Za-z0-9+/=]+)"/g)].map((match) => Buffer.from(match[1] ?? '', 'base64').toString('utf8')).join('\n');

  assert.equal(history.includes('Rename the atlas helper.'), true, 'the message travels in the signal and the comment: it is the maintainer\'s own words');
  assert.equal(history.includes('atlas-secret-name'), false, 'paths stay inside the activity: the workflow sees counts');
});

// ---- the invariants, read from the code ----------------------------------------------------------------------------

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

test('the decision code never merges, labels, approves a review or resolves a thread, and only the GitHub activities write', async () => {
  const sources = await sourceFiles(SRC_DIR);
  assert.deepEqual(forbiddenCalls(sources), []);
  for (const name of ['approval-types.ts', 'signal.ts', 'workflows/decision.ts']) {
    assert.ok(sources.some((file) => file.name === name), `${name} is scanned`);
  }
  // The only new write to GitHub is closing the issue a merged PR was meant to close, and it names no label or merge.
  const github = sources.find((file) => file.name === 'activities/github.ts')?.text ?? '';
  assert.equal((github.match(/method: 'PATCH'/g) ?? []).length, 1);
  assert.match(github, /state: 'closed', state_reason: 'completed'/);
});
