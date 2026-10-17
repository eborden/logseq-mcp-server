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

import { appendFile, lstat, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ApplicationFailure, CancelledFailure, Context } from '@temporalio/activity';
import { BriefTooLargeError, buildFixerBrief, buildReviewerBrief, reviewerBriefCommands } from '../brief.ts';
import { HEARTBEAT_INTERVAL_MS } from '../claude-session-policy.ts';
import type { ClaudeConfig } from '../config.ts';
import { DEFAULT_LIMITS, claudeArgs, git, gitOk, readConfig, runChild } from './claude-session.ts';
import type { SessionLimits } from './claude-session.ts';
import { issueBranch, issueWorkflowId } from '../issue-types.ts';
import {
  FIXER_OUTPUT_FILE,
  FindingsTooLargeError,
  InvalidReviewInputError,
  MAX_OUTPUT_FILE_BYTES,
  MalformedFindingsError,
  REVIEWER_OUTPUT_FILE,
  openThreadRefs,
  parseFixerOutput,
  parseReviewStepInput,
  parseReviewerOutput,
} from '../review-types.ts';
import type {
  FixerOutput,
  FixerSessionResult,
  OpenThreads,
  PostedRepliesResult,
  PostedReviewResult,
  ReviewStepInput,
  ReviewerOutput,
  ReviewerSessionResult,
} from '../review-types.ts';
import { MalformedSessionOutputError, parseClaudeOutput } from '../types.ts';
import type { IssueView, PostReviewInput, PostReviewResult, ReplyToThreadInput, ReplyToThreadResult, ReviewThread } from '../types.ts';

export interface ReviewDeps {
  /** The trusted-only read: an untrusted issue is refused and an untrusted comment is dropped. */
  readonly readIssue: (issueNumber: number) => Promise<IssueView>;
  /** The unresolved threads; the text of an untrusted author is not in them. */
  readonly listReviewThreads: (pr: number) => Promise<ReviewThread[]>;
  readonly replyToThread: (input: ReplyToThreadInput) => Promise<ReplyToThreadResult>;
  readonly postReview: (input: PostReviewInput) => Promise<PostReviewResult>;
  /** `owner/name`, named in the briefs. */
  readonly repo: string;
  readonly claude: ClaudeConfig;
  readonly limits?: SessionLimits;
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

export function reviewerDir(input: ReviewStepInput): string {
  return `${input.worktreeDir}-review-${input.round}`;
}

function markerKey(kind: Kind, input: ReviewStepInput): string {
  return `orchestrator.${kind}-${input.pr}-r${input.round}`;
}

/** The file's text, refused when it is missing, not a plain file or over the byte bound. The text is never put in a message. */
async function readOutputFile(path: string): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw failure('the session wrote no output file', 'MalformedFindings');
  }
  if (!info.isFile()) {
    throw failure('the session output is not a plain file', 'MalformedFindings');
  }
  if (info.size > MAX_OUTPUT_FILE_BYTES) {
    throw failure(`the session output is larger than ${MAX_OUTPUT_FILE_BYTES} bytes`, 'FindingsTooLarge');
  }
  return await readFile(path, 'utf8');
}

async function readReviewerOutput(input: ReviewStepInput): Promise<ReviewerOutput> {
  const content = await readOutputFile(join(reviewerDir(input), REVIEWER_OUTPUT_FILE));
  try {
    return parseReviewerOutput(content);
  } catch (error) {
    throw asFailure(error);
  }
}

async function readFixerOutput(input: ReviewStepInput): Promise<FixerOutput> {
  const content = await readOutputFile(join(input.worktreeDir, FIXER_OUTPUT_FILE));
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
      };
      await runOnce('reviewer', input, dir, prompt, reviewerAllowedTools(input.base), prepare, context);

      const output = await readReviewerOutput(input);
      // Only a thread that is open and the reviewer could read is accepted; an id the session invented is dropped.
      const acceptable = new Set(threads.filter((thread) => thread.trusted).map((thread) => thread.id));
      return { findings: output.findings.length, acceptedThreadIds: output.acceptedThreadIds.filter((id) => acceptable.has(id)) };
    });
  }

  /** Posts the reviewer's findings as one review (event COMMENT) on the head commit, through `postReview`. */
  async function postSessionReview(raw: unknown): Promise<PostedReviewResult> {
    const input = parseInput(raw);
    if ((await readConfig(input.repoDir, markerKey('reviewer', input))) !== 'success') {
      throw failure('there is no finished reviewer session to post', 'SessionError');
    }
    const output = await readReviewerOutput(input);
    const body = [
      `Review of commit \`${input.headSha.slice(0, SHORT)}\` (round ${input.round}), by a fresh reviewer session of the orchestrator. Its text is model output, checked for size and shape and cleaned before it was posted.`,
      '',
      output.summary,
      '',
      output.findings.length === 0 ? 'No findings.' : `${output.findings.length} finding${output.findings.length === 1 ? '' : 's'}, as inline comments.`,
    ].join('\n');
    const posted = await deps.postReview({
      pr: input.pr,
      commitId: input.headSha,
      idempotencyKey: `review-${input.pr}-r${input.round}-${input.headSha.slice(0, SHORT)}`,
      body,
      comments: output.findings.map((finding) => ({ path: finding.path, line: finding.line, side: 'RIGHT', body: finding.body })),
    });
    return { reviewId: posted.reviewId, posted: posted.posted, comments: output.findings.length };
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
        await rm(join(input.worktreeDir, FIXER_OUTPUT_FILE), { force: true });
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
    const output = await readFixerOutput(input);
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

  /** The identifiers of the open threads, and whether each is a trusted author's. No text. */
  async function listOpenThreads(pr: number): Promise<OpenThreads> {
    return openThreadRefs(await deps.listReviewThreads(pr));
  }

  return { runReviewerSession, postSessionReview, runFixerSession, postFixerReplies, listOpenThreads };
}

export type ReviewActivities = ReturnType<typeof createReviewActivities>;
