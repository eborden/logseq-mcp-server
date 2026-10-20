// The review activities (#630): a fresh reviewer session, a fixer session, the posting of what they produced, and the
// open-thread list the workflow decides from. The workflow never sees the text of an issue, a thread, a finding or a
// reply (foundations 4.2, BR-0001): the briefs are built here, the sessions' output is read from a file here, and
// what leaves is a count, an identifier or a SHA.
//
// The sessions are denied `gh` and `git push` (README, "Permission modes"), so they cannot post. Each writes one JSON
// file in its working directory instead, and this module reads and parses it at the boundary: refused when it is too
// large or not in the asked shape (src/review-types.ts), sanitised when it is used. The review and the replies are
// then posted by the existing GitHub activities (`postReview`, `replyToThread`), each idempotent by a hidden key.
//
// One session per (kind, PR, round), recorded in the repo's git config as `started`, then `success` or `error`, as
// `runClaudeSession` does: an activity runs at least once, and a retry after a crash reads the marker and starts no
// second session (`SessionInterrupted` when the first one may still be running). The reviewer works in a detached
// worktree of its own at the head commit, next to the implementer's; the fixer works in the implementer's worktree
// on the PR's branch, and its commits are guarded and pushed by the workflow's `guardBranch` and `pushBranch`.
//
// Nothing here resolves a thread, approves, requests changes, merges or labels.

import { createHash } from 'node:crypto';
import { appendFile, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ApplicationFailure, CancelledFailure, Context } from '@temporalio/activity';
import { BriefTooLargeError, buildFixerBrief, buildRemoteFixerBrief, buildRemoteReviewerBrief, buildReviewerBrief, reviewerBriefCommands } from '../brief.ts';
import { HEARTBEAT_INTERVAL_MS } from '../claude-session-policy.ts';
import type { ClaudeConfig } from '../config.ts';
import { DEFAULT_LIMITS, claudeArgs, git, gitOk, readConfig, runChild } from './claude-session.ts';
import type { SessionLimits } from './claude-session.ts';
import { findingsMarker, fixerRepliesMarker, parseFindingsComment, parseFixerRepliesComment } from '../findings-comment.ts';
import type { FindingsCandidate } from '../findings-comment.ts';
import { REMOTE_EXECUTOR_UNAVAILABLE, REMOTE_SESSION_TIMED_OUT, issueBranch, issueWorkflowId } from '../issue-types.ts';
import { REMOTE_TEXT_MAX_CHARS } from '../remote-session-policy.ts';
import type { RemoteSessionResult } from '../remote-session-policy.ts';
import {
  FIXER_OUTPUT_FILE,
  FindingsTooLargeError,
  InvalidReviewInputError,
  MAX_OUTPUT_FILE_BYTES,
  MalformedFindingsError,
  REVIEWER_OUTPUT_FILE,
  advisorySection,
  changedLines,
  fileThreadBody,
  nearestChangedLine,
  nearestThreadBody,
  openThreadRefs,
  parseFixerOutput,
  parseReviewStepInput,
  parseReviewerOutput,
  splitFindings,
} from '../review-types.ts';
import type {
  AdvisoryFinding,
  Finding,
  FixerOutput,
  FixerSessionResult,
  OpenThreads,
  PostedRepliesResult,
  PostedReviewResult,
  RemoteReviewerSessionResult,
  RemoteFixerSessionResult,
  ReviewStepInput,
  ReviewerOutput,
  ReviewerSessionResult,
} from '../review-types.ts';
import type { ChangedLines } from '../review-types.ts';
import { MalformedSessionOutputError, parseClaudeOutput } from '../types.ts';
import type { AddReviewThreadInput, AddReviewThreadResult, IssueView, PostReviewInput, PostReviewResult, ReplyToThreadInput, ReplyToThreadResult, ReviewThread } from '../types.ts';

/** What the remote reviewer path needs (#674). The worker builds it from `runRemoteSession` and the GitHub activities. */
export interface RemoteReviewDeps {
  readonly runRemoteSession: (input: unknown) => Promise<RemoteSessionResult>;
  /** The PR's comments; the body of an untrusted author is empty. */
  readonly listFindingsCandidates: (pr: number) => Promise<FindingsCandidate[]>;
  readonly minimizeComment: (input: { nodeId: string }) => Promise<{ readonly minimized: true }>;
}

export interface ReviewDeps {
  /** The trusted-only read: an untrusted issue is refused and an untrusted comment is dropped. */
  readonly readIssue: (issueNumber: number) => Promise<IssueView>;
  /** The unresolved threads; the text of an untrusted author is not in them. */
  readonly listReviewThreads: (pr: number) => Promise<ReviewThread[]>;
  readonly replyToThread: (input: ReplyToThreadInput) => Promise<ReplyToThreadResult>;
  readonly postReview: (input: PostReviewInput) => Promise<PostReviewResult>;
  /** Opens a review thread of its own, on a line or on a file, once per key (#714). */
  readonly addReviewThread: (input: AddReviewThreadInput) => Promise<AddReviewThreadResult>;
  /** `owner/name`, named in the briefs. */
  readonly repo: string;
  readonly claude: ClaudeConfig;
  readonly limits?: SessionLimits;
  /** Absent: the remote reviewer activities stop with `RemoteExecutorUnavailable`. */
  readonly remote?: RemoteReviewDeps;
}

type Kind = 'reviewer' | 'fixer';

/**
 * What the reviewer may use: read the tree, read-only git, and write its one findings file. It cannot commit, push or
 * call `gh`. `acceptEdits` would let it edit files of its own throwaway worktree, which nobody reads or pushes.
 */
export function reviewerAllowedTools(base: string): readonly string[] {
  return ['Read', 'Glob', 'Grep', `Write(/${REVIEWER_OUTPUT_FILE})`, ...reviewerBriefCommands(base).map((command) => `Bash(${command})`), 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git rev-parse *)'];
}

const SHORT = 12;

function failure(message: string, type: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, type);
}

function parseInput(raw: unknown): ReviewStepInput {
  try {
    return parseReviewStepInput(raw);
  } catch (error) {
    if (error instanceof InvalidReviewInputError) {
      throw failure(error.message, 'InvalidInput');
    }
    throw error;
  }
}

/** A parse failure of a session's file as a non-retryable failure of its own type. The message is fixed text. */
function asFailure(error: unknown): unknown {
  if (error instanceof FindingsTooLargeError) {
    return failure(error.message, 'FindingsTooLarge');
  }
  if (error instanceof MalformedFindingsError) {
    return failure(error.message, 'MalformedFindings');
  }
  if (error instanceof BriefTooLargeError) {
    return failure(error.message, 'BriefTooLarge');
  }
  return error;
}

interface StagedReview {
  readonly commentId: number;
  readonly commentNodeId: string;
  readonly review: ReviewerOutput;
}

interface StagedFixer {
  readonly commentId: number;
  readonly commentNodeId: string;
  readonly replies: FixerOutput;
}

/** One marker per remote fixer round. Like the local fixer's it has no head: a round starts at one head, and the replies are posted after the push. */
function remoteFixerMarkerKey(input: ReviewStepInput): string {
  return `orchestrator.remote-fixer-${input.pr}-r${input.round}`;
}

/** One marker per remote round and head, as the local reviewer's: `success` once the findings are parsed and staged. */
function remoteMarkerKey(input: ReviewStepInput): string {
  return `orchestrator.remote-reviewer-${input.pr}-r${input.round}-${input.headSha.slice(0, SHORT)}`;
}

const NODE_ID = /^[A-Za-z0-9_=-]{1,100}$/;

/** The node id of the comment to hide, parsed at the boundary (the same shape the GitHub activity checks again). */
function minimizeInput(raw: unknown): { nodeId: string } {
  const nodeId = typeof raw === 'object' && raw !== null && 'nodeId' in raw ? (raw as { nodeId: unknown }).nodeId : undefined;
  if (typeof nodeId !== 'string' || !NODE_ID.test(nodeId)) {
    throw failure('nodeId must be a comment node id', 'InvalidInput');
  }
  return { nodeId };
}

/**
 * Names one finding of one round and head, so a retry finds the thread the first attempt opened (#714). The finding's own
 * text is hashed, so the same finding is the same key and no text is in the key.
 */
export function findingKey(input: ReviewStepInput, finding: Finding): string {
  const digest = createHash('sha256').update(JSON.stringify([finding.path, finding.line, finding.body])).digest('hex').slice(0, 16);
  return `finding-${input.pr}-r${input.round}-${input.headSha.slice(0, SHORT)}-${digest}`;
}

/**
 * Whether GitHub (or the boundary check in front of it) refused to take a thread: a non-retryable `GitHubClientError` (a 4xx
 * other than 408 and 429, such as the 422 of a line the diff does not hold) or `InvalidInput`. Only that is the case for
 * another way of placing a finding. Everything else (a 5xx, a timeout, a 429, a network error, an exhausted rate limit, a
 * failed read, a cancelled activity) says nothing about the finding, so it is rethrown for the activity to retry or stop
 * (BR-0003), and never turned into an advisory finding that holds no gate.
 */
function isRefusal(error: unknown): boolean {
  return error instanceof ApplicationFailure && error.nonRetryable === true && (error.type === 'GitHubClientError' || error.type === 'InvalidInput');
}

/** Returns the thread's result, or `undefined` when GitHub refused it. Any other failure is thrown. */
async function tryAddThread(add: () => Promise<AddReviewThreadResult>): Promise<AddReviewThreadResult | undefined> {
  try {
    return await add();
  } catch (error) {
    if (isRefusal(error)) {
      return undefined;
    }
    throw error;
  }
}

/** The review body's line of counts: what became of each finding. Fixed words and numbers. */
function findingCounts(inline: number, file: number, nearest: number, advisory: number): string {
  const total = inline + file + nearest + advisory;
  const parts = [
    `${inline} as inline comment${inline === 1 ? '' : 's'}`,
    `${file} as file-level thread${file === 1 ? '' : 's'}`,
    `${nearest} as thread${nearest === 1 ? '' : 's'} on the nearest changed line`,
    `${advisory} advisory (no thread)`,
  ];
  return `${total} finding${total === 1 ? '' : 's'}: ${parts.join(', ')}.`;
}

export function reviewerDir(input: ReviewStepInput): string {
  return `${input.worktreeDir}-review-${input.round}`;
}

/**
 * One marker per session. The reviewer's carries the head it reviewed, so a marker from an earlier head can never
 * make a later head reuse its findings. The fixer's does not: a round starts at one head, and `postFixerReplies` is
 * given the head after the push.
 */
function markerKey(kind: Kind, input: ReviewStepInput): string {
  return kind === 'reviewer' ? `orchestrator.reviewer-${input.pr}-r${input.round}-${input.headSha.slice(0, SHORT)}` : `orchestrator.fixer-${input.pr}-r${input.round}`;
}

/**
 * The file's text, refused when it is missing, not a plain file (a link is refused, not followed), tracked by git, or
 * over the byte bound. A tracked file is one the PR's own tree carries, not one the session wrote. The text is never
 * put in a message.
 */
async function readOutputFile(dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw failure('the session wrote no output file', 'MalformedFindings');
  }
  if (!info.isFile()) {
    throw failure('the session output is not a plain file', 'MalformedFindings');
  }
  if ((await gitOk(dir, ['ls-files', '--', name])).trim() !== '') {
    throw failure('the session output file is tracked by git, so the session did not write it', 'MalformedFindings');
  }
  if (info.size > MAX_OUTPUT_FILE_BYTES) {
    throw failure(`the session output is larger than ${MAX_OUTPUT_FILE_BYTES} bytes`, 'FindingsTooLarge');
  }
  return await readFile(path, 'utf8');
}

async function readReviewerOutput(input: ReviewStepInput): Promise<ReviewerOutput> {
  const content = await readOutputFile(reviewerDir(input), REVIEWER_OUTPUT_FILE);
  try {
    return parseReviewerOutput(content);
  } catch (error) {
    throw asFailure(error);
  }
}

async function readFixerOutput(input: ReviewStepInput): Promise<FixerOutput> {
  const content = await readOutputFile(input.worktreeDir, FIXER_OUTPUT_FILE);
  try {
    return parseFixerOutput(content);
  } catch (error) {
    throw asFailure(error);
  }
}

export function createReviewActivities(deps: ReviewDeps) {
  const limits = deps.limits ?? DEFAULT_LIMITS;

  /** Heartbeats for the whole activity, the reads before the session and the git work after it included. */
  async function withHeartbeat<T>(run: (context: Context) => Promise<T>): Promise<T> {
    const context = Context.current();
    context.heartbeat();
    const beat = setInterval(() => context.heartbeat(), HEARTBEAT_INTERVAL_MS);
    try {
      return await run(context);
    } finally {
      clearInterval(beat);
    }
  }

  /**
   * Runs one session unless its marker says one already ran. `prepare` creates what the session needs and runs only
   * for a session that is about to start. Whatever way it ends, the marker says so, and a session is never run twice.
   */
  async function runOnce(
    kind: Kind,
    input: ReviewStepInput,
    cwd: string,
    prompt: string,
    allowedTools: readonly string[],
    prepare: () => Promise<void>,
    context: Context,
  ): Promise<void> {
    const key = markerKey(kind, input);
    switch (await readConfig(input.repoDir, key)) {
      case 'success':
        return;
      case 'started':
        throw failure(`a ${kind} session for round ${input.round} started and never finished, so no second one is started`, 'SessionInterrupted');
      case 'error':
        throw failure(`the ${kind} session for round ${input.round} failed`, 'SessionError');
      default:
        break;
    }
    await prepare();
    await gitOk(input.repoDir, ['config', '--local', key, 'started']);
    const outcome = await runChild(deps.claude.claudeBin, claudeArgs(deps.claude, prompt, allowedTools), cwd, limits, context);
    switch (outcome.kind) {
      case 'spawn-failed':
        // No session ran, so leave nothing behind that a retry would take for one.
        await git(input.repoDir, ['config', '--local', '--unset', key]);
        throw failure('could not start the claude executable', 'ClaudeUnavailable');
      case 'timeout':
        await gitOk(input.repoDir, ['config', '--local', key, 'error']);
        throw failure(`the ${kind} session ran past its ${limits.sessionTimeoutMs} ms limit and was stopped`, 'SessionTimeout');
      case 'cancelled':
        // The marker stays `started`: a later attempt reports `SessionInterrupted` and does not start another session.
        throw new CancelledFailure(`the ${kind} session was cancelled and its process was stopped`);
      case 'exited':
        break;
    }
    let ok = false;
    if (outcome.code === 0) {
      try {
        if (outcome.overflow) {
          throw new MalformedSessionOutputError('the session printed more than the output limit');
        }
        ok = !parseClaudeOutput(outcome.stdout).isError;
      } catch (error) {
        if (error instanceof MalformedSessionOutputError) {
          await gitOk(input.repoDir, ['config', '--local', key, 'error']);
          throw failure(error.message, 'MalformedResult');
        }
        throw error;
      }
    }
    await gitOk(input.repoDir, ['config', '--local', key, ok ? 'success' : 'error']);
    if (!ok) {
      throw failure(`the ${kind} session for round ${input.round} failed`, 'SessionError');
    }
  }

  /** Builds `kind`'s brief from trusted reads only; the brief and the issue text stay inside this activity. */
  async function readForBrief(input: ReviewStepInput): Promise<{ issue: IssueView; threads: ReviewThread[] }> {
    const issue = await deps.readIssue(input.issue);
    return { issue, threads: await deps.listReviewThreads(input.pr) };
  }

  async function runReviewerSession(raw: unknown): Promise<ReviewerSessionResult> {
    const input = parseInput(raw);
    return await withHeartbeat(async (context) => {
      const { issue, threads } = await readForBrief(input);
      let prompt: string;
      try {
        prompt = buildReviewerBrief({
          issue,
          repo: deps.repo,
          pr: input.pr,
          base: input.base,
          headSha: input.headSha,
          round: input.round,
          workflowId: issueWorkflowId(input.issue),
          threads,
        });
      } catch (error) {
        throw asFailure(error);
      }
      const dir = reviewerDir(input);
      const prepare = async (): Promise<void> => {
        // A directory left by an attempt that died before it wrote the marker holds no session: start clean.
        await git(input.repoDir, ['worktree', 'remove', '--force', dir]);
        await rm(dir, { recursive: true, force: true });
        await git(input.repoDir, ['worktree', 'prune']);
        await gitOk(input.repoDir, ['worktree', 'add', '--detach', dir, input.headSha]);
        // The checkout is the PR's own tree, which may already hold a file (or a link) of this name: only the session
        // may write the findings, so remove it (a link itself, not its target; a directory too) before the session starts.
        await rm(join(dir, REVIEWER_OUTPUT_FILE), { recursive: true, force: true });
      };
      await runOnce('reviewer', input, dir, prompt, reviewerAllowedTools(input.base), prepare, context);

      const output = await readReviewerOutput(input);
      // Only a thread that is open and the reviewer could read is accepted; an id the session invented is dropped.
      const acceptable = new Set(threads.filter((thread) => thread.trusted).map((thread) => thread.id));
      return { findings: output.findings.length, acceptedThreadIds: output.acceptedThreadIds.filter((id) => acceptable.has(id)) };
    });
  }

  /**
   * The lines the head commit changes against the base, or `undefined` when the diff cannot be read within the bounds
   * (a missing base ref, a shallow clone, a diff over the output buffer, a git failure). The caller does not post
   * findings it cannot place. No diff text is kept or logged. `-U0` shows exactly the changed lines, which is what an inline comment may sit on.
   */
  async function changedOnHead(input: ReviewStepInput): Promise<ChangedLines | undefined> {
    try {
      const result = await git(input.repoDir, ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-prefix', '--no-renames', `origin/${input.base}...${input.headSha}`, '--']);
      return result.code === 0 ? changedLines(result.stdout) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Posts the reviewer's findings as one review (event COMMENT) on the head commit, through `postReview`. */
  async function postSessionReview(raw: unknown): Promise<PostedReviewResult> {
    const input = parseInput(raw);
    if ((await readConfig(input.repoDir, markerKey('reviewer', input))) !== 'success') {
      throw failure('there is no finished reviewer session to post', 'SessionError');
    }
    return await postFindings(input, await readReviewerOutput(input));
  }

  /** The one place a reviewer's findings, local or remote, are placed, cleaned and posted as a review. */
  async function postFindings(input: ReviewStepInput, output: ReviewerOutput): Promise<PostedReviewResult> {
    const changed = await changedOnHead(input);
    if (changed === undefined && output.findings.length > 0) {
      // Posting every finding as advisory would open no thread, and the gate would clear on a review that raised problems.
      throw failure(`the diff could not be read, so ${output.findings.length} finding${output.findings.length === 1 ? ' cannot' : 's cannot'} be placed`, 'DiffUnreadable');
    }
    const split = splitFindings(output.findings, changed);
    const { inline } = split;
    // The threads come first, so the review body can say what became of every finding, including a thread GitHub refused.
    // Both steps are idempotent by key, so a retry after either one places and posts nothing twice.
    const placed = await placeFileFindings(input, split.fileLevel, changed);
    const advisory: readonly AdvisoryFinding[] = [...split.advisory, ...placed.failed];
    const section = advisorySection(advisory);
    const body = [
      `Review of commit \`${input.headSha.slice(0, SHORT)}\` (round ${input.round}), by a fresh reviewer session of the orchestrator. Its text is model output, checked for size and shape and cleaned before it was posted.`,
      '',
      output.summary,
      '',
      output.findings.length === 0 ? 'No findings.' : findingCounts(inline.length, placed.file, placed.nearest, advisory.length),
      ...(section.text === '' ? [] : ['', section.text]),
    ].join('\n');
    const posted = await deps.postReview({
      pr: input.pr,
      commitId: input.headSha,
      idempotencyKey: `review-${input.pr}-r${input.round}-${input.headSha.slice(0, SHORT)}`,
      body,
      comments: inline.map((finding) => ({ path: finding.path, line: finding.line, side: 'RIGHT', body: finding.body })),
    });
    return { reviewId: posted.reviewId, posted: posted.posted, comments: inline.length, fileLevel: placed.file, nearest: placed.nearest, advisory: section.listed, omitted: section.omitted };
  }

  /**
   * Opens a thread for each finding on an unchanged line of a changed file (#714). The thread is on the file, with the path
   * and the original line in its first comment. When GitHub refuses that (a non-retryable client error such as a 422), the
   * finding is anchored on the nearest changed line of its file instead, and its text says so. A second refusal
   * (`thread_failed`) or a file with no changed line makes the finding advisory, listed in the review
   * body: never dropped. A failure that is not a refusal (a 5xx, a timeout, a 429, a failed read) is thrown, so the
   * activity retries: that is idempotent by key, and a finding is never made advisory by an outage. Only the finding's
   * path, already a file of the diff, and fixed words go in a thread.
   */
  async function placeFileFindings(
    input: ReviewStepInput,
    findings: readonly Finding[],
    changed: ChangedLines | undefined,
  ): Promise<{ readonly file: number; readonly nearest: number; readonly failed: readonly AdvisoryFinding[] }> {
    let file = 0;
    let nearest = 0;
    const failed: AdvisoryFinding[] = [];
    for (const finding of findings) {
      const base = { pr: input.pr, commitId: input.headSha, path: finding.path, key: findingKey(input, finding) };
      let result = await tryAddThread(() => deps.addReviewThread({ ...base, body: fileThreadBody(finding) }));
      if (result === undefined) {
        const line = nearestChangedLine(changed?.get(finding.path) ?? [], finding.line);
        if (line !== undefined) {
          result = await tryAddThread(() => deps.addReviewThread({ ...base, line, body: nearestThreadBody(finding, line) }));
        }
      }
      if (result === undefined) {
        failed.push({ ...finding, reason: 'thread_failed' });
      } else if (result.level === 'file') {
        file += 1;
      } else {
        nearest += 1;
      }
    }
    return { file, nearest, failed };
  }

  // ---- the remote reviewer (#674) --------------------------------------------------------------------------------

  function remoteDeps(): RemoteReviewDeps {
    if (deps.remote === undefined) {
      throw failure('no remote session activity is configured on this worker', REMOTE_EXECUTOR_UNAVAILABLE);
    }
    return deps.remote;
  }

  /**
   * Starts one remote reviewer for the head, waits for it (`runRemoteSession`, as it is), reads its keyed findings
   * comment, and stages what survives the parser. The raw comment is never posted or logged. Retry-safe: a finished
   * round returns its staged result, and `runRemoteSession` itself never fires a second session for the same key.
   *
   * The wait of `runRemoteSession` for a reviewer ends on a review on the head, which this reviewer never posts (it
   * posts a comment), or on the keyed findings comment, which this step names with `findingsMarker` (#687), so the wait
   * ends within about one poll of the comment. The comment is what counts: it is read after any outcome but a launch
   * that failed.
   */
  async function runRemoteReviewerSession(raw: unknown): Promise<RemoteReviewerSessionResult> {
    const input = parseInput(raw);
    const remote = remoteDeps();
    return await withHeartbeat(async () => {
      const key = remoteMarkerKey(input);
      if ((await readConfig(input.repoDir, key)) === 'success') {
        return await readStaged(input);
      }
      const { issue, threads } = await readForBrief(input);
      const marker = findingsMarker(input.pr, input.headSha, input.round);
      let brief: string;
      try {
        brief = buildRemoteReviewerBrief({
          issue,
          repo: deps.repo,
          pr: input.pr,
          base: input.base,
          headSha: input.headSha,
          round: input.round,
          workflowId: issueWorkflowId(input.issue),
          threads,
          marker,
          ...(input.bodySource === undefined ? {} : { bodySource: input.bodySource }),
        });
      } catch (error) {
        throw asFailure(error);
      }
      if (brief.length > REMOTE_TEXT_MAX_CHARS) {
        throw failure(`the remote brief is ${brief.length} characters, more than the ${REMOTE_TEXT_MAX_CHARS} a routine takes`, 'BriefTooLarge');
      }
      // `attempt` = round + 1, as the remote fixer's: a round that follows a fixer that pushed nothing reviews the same head, and
      // the session key has the head but no round, so without it the round re-attaches to the last round's finished session,
      // fires nothing, and finds no comment under the new round's marker (`MalformedFindings`). Round 0 is attempt 1, the old key.
      const session = await remote.runRemoteSession({ role: 'reviewer', issue: input.issue, pr: input.pr, branch: issueBranch(input.issue), base: input.base, headSha: input.headSha, brief, findingsMarker: marker, attempt: input.round + 1 });
      if (session.outcome === 'failed' && session.claim !== 'already_reviewed') {
        // A fixed word only: the claim or the launch failure the session activity reported.
        throw failure(`the remote reviewer did not run (${session.claim ?? session.failure ?? 'failed'})`, 'RemoteSessionFailed');
      }
      const parsed = await parseRemoteFindings(input, marker, remote);
      // Only a thread that is open and the reviewer could read is accepted; an id the session invented is dropped.
      const acceptable = new Set(threads.filter((thread) => thread.trusted).map((thread) => thread.id));
      const output = { ...parsed.output, acceptedThreadIds: parsed.output.acceptedThreadIds.filter((id) => acceptable.has(id)) };
      await stage(input, { commentId: parsed.commentId, commentNodeId: parsed.commentNodeId, review: output });
      await gitOk(input.repoDir, ['config', '--local', key, 'success']);
      return { findings: output.findings.length, acceptedThreadIds: output.acceptedThreadIds, commentNodeId: parsed.commentNodeId };
    });
  }

  async function parseRemoteFindings(input: ReviewStepInput, marker: string, remote: RemoteReviewDeps): Promise<ReturnType<typeof parseFindingsComment>> {
    const candidates = await remote.listFindingsCandidates(input.pr);
    try {
      return parseFindingsComment(candidates, marker);
    } catch (error) {
      throw asFailure(error);
    }
  }

  /** The review of the staged findings, through the same code the local path posts with. */
  async function postRemoteSessionReview(raw: unknown): Promise<PostedReviewResult> {
    const input = parseInput(raw);
    if ((await readConfig(input.repoDir, remoteMarkerKey(input))) !== 'success') {
      throw failure('there is no finished remote reviewer session to post', 'SessionError');
    }
    await ensureHeadCommit(input);
    const staged = await readStagedFile(input);
    return await postFindings(input, staged.review);
  }

  /**
   * Hides the raw findings comment. Called by the workflow after the review is posted, and allowed to fail without
   * stopping the run. The node id is checked here and again by the GitHub activity. Hiding twice is a no-op.
   */
  async function minimizeFindingsComment(raw: unknown): Promise<{ readonly minimized: true }> {
    const remote = remoteDeps();
    return await withHeartbeat(async () => await remote.minimizeComment(minimizeInput(raw)));
  }

  /** The head commit has to be in the working copy for the diff that places the findings. A fetch of the one branch, fixed argv, is the only try. */
  async function ensureHeadCommit(input: ReviewStepInput): Promise<void> {
    if ((await git(input.repoDir, ['cat-file', '-e', `${input.headSha}^{commit}`])).code === 0) {
      return;
    }
    await git(input.repoDir, ['fetch', '--no-tags', 'origin', `+refs/heads/${issueBranch(input.issue)}:refs/remotes/origin/${issueBranch(input.issue)}`]);
  }

  async function stagedPath(input: ReviewStepInput): Promise<string> {
    const relative = (await gitOk(input.repoDir, ['rev-parse', '--git-path', `orchestrator-remote-review-${input.pr}-r${input.round}-${input.headSha.slice(0, SHORT)}.json`])).trim();
    return resolve(input.repoDir, relative);
  }

  async function stage(input: ReviewStepInput, staged: StagedReview): Promise<void> {
    const path = await stagedPath(input);
    await writeFile(`${path}.tmp`, JSON.stringify(staged), 'utf8');
    await rename(`${path}.tmp`, path);
  }

  /** The staged file, parsed again at this boundary: nothing read back from disk is trusted for its shape. */
  async function readStagedFile(input: ReviewStepInput): Promise<StagedReview> {
    let top: unknown;
    try {
      top = JSON.parse(await readFile(await stagedPath(input), 'utf8'));
    } catch {
      throw failure('the staged findings of the remote reviewer are missing or unreadable', 'MalformedFindings');
    }
    const record = typeof top === 'object' && top !== null && !Array.isArray(top) ? (top as Record<string, unknown>) : {};
    const { commentId, commentNodeId } = record;
    if (typeof commentId !== 'number' || typeof commentNodeId !== 'string') {
      throw failure('the staged findings of the remote reviewer are not in the shape this code wrote', 'MalformedFindings');
    }
    try {
      return { commentId, commentNodeId, review: parseReviewerOutput(JSON.stringify(record['review'])) };
    } catch (error) {
      throw asFailure(error);
    }
  }

  async function readStaged(input: ReviewStepInput): Promise<RemoteReviewerSessionResult> {
    const staged = await readStagedFile(input);
    return { findings: staged.review.findings.length, acceptedThreadIds: staged.review.acceptedThreadIds, commentNodeId: staged.commentNodeId };
  }

  async function runFixerSession(raw: unknown): Promise<FixerSessionResult> {
    const input = parseInput(raw);
    return await withHeartbeat(async (context) => {
      const { issue, threads } = await readForBrief(input);
      const accepted = new Set(input.acceptedThreadIds);
      const actionable = threads.filter((thread) => thread.trusted && !accepted.has(thread.id));
      let prompt: string;
      try {
        prompt = buildFixerBrief({
          issue,
          repo: deps.repo,
          pr: input.pr,
          base: input.base,
          headSha: input.headSha,
          round: input.round,
          workflowId: issueWorkflowId(input.issue),
          branch: issueBranch(input.issue),
          threads: actionable,
        });
      } catch (error) {
        throw asFailure(error);
      }
      const prepare = async (): Promise<void> => {
        const head = (await gitOk(input.worktreeDir, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
        if (head !== input.headSha) {
          throw failure('the worktree is not at the commit the round starts from', 'BranchMoved');
        }
        await rm(join(input.worktreeDir, FIXER_OUTPUT_FILE), { recursive: true, force: true });
        // The replies file is untracked on purpose: keep it out of `git status` and out of a `git add`.
        const exclude = (await gitOk(input.worktreeDir, ['rev-parse', '--git-path', 'info/exclude'])).trim();
        const path = resolve(input.worktreeDir, exclude);
        const current = await readFile(path, 'utf8').catch(() => '');
        if (!current.split('\n').includes(`/${FIXER_OUTPUT_FILE}`)) {
          await appendFile(path, `${current === '' || current.endsWith('\n') ? '' : '\n'}/${FIXER_OUTPUT_FILE}\n`);
        }
      };
      await runOnce('fixer', input, input.worktreeDir, prompt, deps.claude.allowedTools, prepare, context);

      const headSha = (await gitOk(input.worktreeDir, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
      const output = await readFixerOutput(input);
      const open = new Set(actionable.map((thread) => thread.id));
      return { headSha, moved: headSha !== input.headSha, replies: output.replies.filter((reply) => open.has(reply.threadId)).length };
    });
  }

  /** Posts the fixer's replies, each once, in the thread it answers. `input.headSha` is the branch tip after the push. */
  async function postFixerReplies(raw: unknown): Promise<PostedRepliesResult> {
    const input = parseInput(raw);
    if ((await readConfig(input.repoDir, markerKey('fixer', input))) !== 'success') {
      throw failure('there is no finished fixer session whose replies could be posted', 'SessionError');
    }
    return await postReplies(input, await readFixerOutput(input));
  }

  /** The one place a fixer's replies, local or remote, are filtered to the threads that are open and the fixer's, and posted. */
  async function postReplies(input: ReviewStepInput, output: FixerOutput): Promise<PostedRepliesResult> {
    const accepted = new Set(input.acceptedThreadIds);
    const open = new Set((await deps.listReviewThreads(input.pr)).filter((thread) => thread.trusted && !accepted.has(thread.id)).map((thread) => thread.id));
    let posted = 0;
    let skipped = 0;
    for (const reply of output.replies) {
      if (!open.has(reply.threadId)) {
        skipped += 1;
        continue;
      }
      const result = await deps.replyToThread({
        pr: input.pr,
        threadId: reply.threadId,
        key: `reply-r${input.round}-${reply.threadId}`,
        body: `${reply.body}\n\n(Fix round ${input.round + 1}, branch tip \`${input.headSha.slice(0, SHORT)}\`.)`,
      });
      if (result.posted) {
        posted += 1;
      } else {
        skipped += 1;
      }
    }
    return { posted, skipped };
  }

  // ---- the remote fixer (#675) -----------------------------------------------------------------------------------

  /**
   * Starts one remote fixer for the head, waits for it (`runRemoteSession`, as it is, with `attempt` = round + 1 so a new
   * round on a head that did not move fires fresh and a retry of the same round re-attaches), reads its keyed replies
   * comment, and stages what survives the parser. Nothing is pushed or posted here: the session pushed on its own, and the
   * workflow guards the fetched tip before the replies are posted. Retry-safe: a finished round returns its staged result.
   *
   * The wait ends on a tip that differs from `headSha` and has rested. A session that pushed nothing runs to the cap
   * (`timed_out`, no tip): that is a round with no progress, like a local fixer that made no commit. A cap with a tip that had
   * not rested is `RemoteSessionTimedOut`: the session may still push, so the run stops for a person.
   */
  async function runRemoteFixerSession(raw: unknown): Promise<RemoteFixerSessionResult> {
    const input = parseInput(raw);
    const remote = remoteDeps();
    return await withHeartbeat(async () => {
      const key = remoteFixerMarkerKey(input);
      if ((await readConfig(input.repoDir, key)) === 'success') {
        return await readStagedFixer(input);
      }
      const { issue, threads } = await readForBrief(input);
      const accepted = new Set(input.acceptedThreadIds);
      const actionable = threads.filter((thread) => thread.trusted && !accepted.has(thread.id));
      const marker = fixerRepliesMarker(input.pr, input.headSha, input.round);
      let brief: string;
      try {
        brief = buildRemoteFixerBrief({
          issue,
          repo: deps.repo,
          pr: input.pr,
          base: input.base,
          headSha: input.headSha,
          round: input.round,
          workflowId: issueWorkflowId(input.issue),
          branch: issueBranch(input.issue),
          threads: actionable,
          marker,
          ...(input.hostFailure === undefined ? {} : { hostFailure: input.hostFailure }),
        });
      } catch (error) {
        throw asFailure(error);
      }
      if (brief.length > REMOTE_TEXT_MAX_CHARS) {
        throw failure(`the remote brief is ${brief.length} characters, more than the ${REMOTE_TEXT_MAX_CHARS} a routine takes`, 'BriefTooLarge');
      }
      const session = await remote.runRemoteSession({
        role: 'fixer',
        issue: input.issue,
        pr: input.pr,
        branch: issueBranch(input.issue),
        base: input.base,
        headSha: input.headSha,
        brief,
        repliesMarker: marker,
        attempt: input.round + 1,
      });
      if (session.outcome === 'failed') {
        // A fixed word only: the claim or the launch failure the session activity reported.
        throw failure(`the remote fixer did not run (${session.claim ?? session.failure ?? 'failed'})`, 'RemoteSessionFailed');
      }
      if (session.outcome === 'timed_out' && session.headSha !== undefined) {
        throw failure('the remote fixer ran past its cap with a branch tip that had not settled', REMOTE_SESSION_TIMED_OUT);
      }
      const tip = session.headSha ?? input.headSha;
      const parsed = await parseRemoteReplies(input, marker, remote);
      // Only a reply on a thread that is open and the fixer's is kept; the rest is counted as skipped when posting.
      await stageFixer(input, { commentId: parsed.commentId, commentNodeId: parsed.commentNodeId, replies: parsed.output }, tip);
      await gitOk(input.repoDir, ['config', '--local', key, 'success']);
      return {
        headSha: tip,
        moved: tip !== input.headSha,
        replies: openReplyCount(parsed.output, actionable),
        commentNodeId: parsed.commentNodeId,
      };
    });
  }

  function openReplyCount(output: FixerOutput, actionable: readonly ReviewThread[]): number {
    const open = new Set(actionable.map((thread) => thread.id));
    return output.replies.filter((reply) => open.has(reply.threadId)).length;
  }

  async function parseRemoteReplies(input: ReviewStepInput, marker: string, remote: RemoteReviewDeps): Promise<ReturnType<typeof parseFixerRepliesComment>> {
    const candidates = await remote.listFindingsCandidates(input.pr);
    try {
      return parseFixerRepliesComment(candidates, marker);
    } catch (error) {
      throw asFailure(error);
    }
  }

  /** Posts the staged replies of a finished remote fixer round, after the workflow guarded the tip. `input.headSha` is the branch tip after the push. */
  async function postRemoteFixerReplies(raw: unknown): Promise<PostedRepliesResult> {
    const input = parseInput(raw);
    if ((await readConfig(input.repoDir, remoteFixerMarkerKey(input))) !== 'success') {
      throw failure('there is no finished remote fixer session whose replies could be posted', 'SessionError');
    }
    return await postReplies(input, (await readStagedFixerFile(input)).replies);
  }

  async function stagedFixerPath(input: ReviewStepInput): Promise<string> {
    const relative = (await gitOk(input.repoDir, ['rev-parse', '--git-path', `orchestrator-remote-fixer-${input.pr}-r${input.round}.json`])).trim();
    return resolve(input.repoDir, relative);
  }

  async function stageFixer(input: ReviewStepInput, staged: StagedFixer, tip: string): Promise<void> {
    const path = await stagedFixerPath(input);
    await writeFile(`${path}.tmp`, JSON.stringify({ ...staged, tip }), 'utf8');
    await rename(`${path}.tmp`, path);
  }

  /** The staged file, parsed again at this boundary: nothing read back from disk is trusted for its shape. */
  async function readStagedFixerFile(input: ReviewStepInput): Promise<StagedFixer & { readonly tip: string }> {
    let top: unknown;
    try {
      top = JSON.parse(await readFile(await stagedFixerPath(input), 'utf8'));
    } catch {
      throw failure('the staged replies of the remote fixer are missing or unreadable', 'MalformedFindings');
    }
    const record = typeof top === 'object' && top !== null && !Array.isArray(top) ? (top as Record<string, unknown>) : {};
    const { commentId, commentNodeId, tip } = record;
    if (typeof commentId !== 'number' || typeof commentNodeId !== 'string' || typeof tip !== 'string' || !/^[0-9a-f]{40}$/.test(tip)) {
      throw failure('the staged replies of the remote fixer are not in the shape this code wrote', 'MalformedFindings');
    }
    try {
      return { commentId, commentNodeId, tip, replies: parseFixerOutput(JSON.stringify(record['replies'])) };
    } catch (error) {
      throw asFailure(error);
    }
  }

  async function readStagedFixer(input: ReviewStepInput): Promise<RemoteFixerSessionResult> {
    const staged = await readStagedFixerFile(input);
    const threads = await deps.listReviewThreads(input.pr);
    const accepted = new Set(input.acceptedThreadIds);
    return {
      headSha: staged.tip,
      moved: staged.tip !== input.headSha,
      replies: openReplyCount(staged.replies, threads.filter((thread) => thread.trusted && !accepted.has(thread.id))),
      commentNodeId: staged.commentNodeId,
    };
  }

  /** The identifiers of the open threads, and whether each is a trusted author's. No text. */
  async function listOpenThreads(pr: number): Promise<OpenThreads> {
    return openThreadRefs(await deps.listReviewThreads(pr));
  }

  return { runReviewerSession, postSessionReview, runRemoteReviewerSession, postRemoteSessionReview, minimizeFindingsComment, runFixerSession, postFixerReplies, runRemoteFixerSession, postRemoteFixerReplies, listOpenThreads };
}

export type ReviewActivities = ReturnType<typeof createReviewActivities>;
