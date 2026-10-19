// The activity that runs one remote session (#672, parent plan #643). A remote session is started by firing a routine
// (one per role, `routine-fire.ts`) and can be neither stopped nor messaged from here, and the fire call is not
// idempotent: a repeat creates another session. So, in this order:
//
// 1. The input is parsed (foundations 4.2). The brief is sent untouched as the per-run text and is data to the session.
// 2. A marker in the repo's git config, keyed on issue, role, head and attempt, says where an earlier attempt got to:
//    - `fired <session id> <ms>`: the id is recorded, so nothing is launched. The call re-attaches and waits, and
//      returns the same session. The cap counts from the recorded time, so a restart does not extend it.
//    - `firing`: the call was about to be made, or was made and its answer was lost. GitHub is watched for a bounded
//      time for the work of that session before another is fired.
// 3. With no marker, the claim: no open PR for the issue beyond the one the role works on, no `claude/<n>` branch
//    beyond the one expected, the tip where the input says it is. A claim found returns without launching.
// 4. The `firing` marker is written, then the call is made, then the id is recorded.
// 5. The wait polls GitHub (branch tip, checks, reviews, the reviewer's keyed findings comment) with a wall-clock cap and a heartbeat. How a session ended
//    is read from GitHub state only. Nothing the session says is read, returned or logged.
//
// Errors of the fire call (the comment on #672): 400 and 404 are permanent (`RoutineRejected`), 401 and 403 are
// permanent (`RoutineAuth`), both stop for a person and clear the marker (no session was made). 429 honours
// `Retry-After` within `retryAfterMaxMs` and the attempt budget. 5xx retries with backoff within the budget. A
// timeout or an unreadable answer is not retried here (a session may exist) and leaves `firing` behind. When the
// budget runs out the result is `failed`, never a throw.
//
// Never in a log, a result, the workflow history or an error message: the token, the brief, or a response body.

import { ApplicationFailure, Context } from '@temporalio/activity';
import { isFindingsMarker, isFixerRepliesMarker, needsInputMarker } from '../findings-comment.ts';
import { FireError } from '../routine-fire.ts';
import type { FireClient } from '../routine-fire.ts';
import {
  InvalidRemoteSessionInputError,
  REMOTE_LIMITS,
  parseRemoteSessionInput,
} from '../remote-session-policy.ts';
import type { RemoteClaim, RemoteLaunchFailure, RemoteLimits, RemoteRole, RemoteSessionInput, RemoteSessionResult } from '../remote-session-policy.ts';
import { git, gitOk, readConfig } from './claude-session.ts';

/** What the activity reads from GitHub. The real one is `createRemoteGithubReads` (github.ts); tests use a fake. */
export interface RemoteGithub {
  /** Numbers of the open PRs of trusted authors that belong to the issue (branch `claude/<n>` or `Closes #n`). */
  openPrs(issue: number): Promise<number[]>;
  /** Names of the branches `claude/<n>` and `claude/<n>-...` on the remote. */
  claudeBranches(issue: number): Promise<string[]>;
  branchTip(branch: string): Promise<string | undefined>;
  /** True while a check run or a commit status of the commit is not finished. */
  checksPending(sha: string): Promise<boolean>;
  /** True when a trusted review with a body exists on the commit. */
  reviewedOnHead(pr: number, sha: string): Promise<boolean>;
  /**
   * True when a comment of a trusted author on the PR carries `marker` on its first line (#682). Read only. Optional so a
   * reads object without it keeps the review-only wait; the real one (`createRemoteGithubReads`) has it.
   */
  findingsCommented?(pr: number, marker: string): Promise<boolean>;
  /**
   * The id of the first comment of a trusted author on the issue that carries `marker` on its first line, or undefined (#697).
   * Read only. Optional like `findingsCommented`: without it the implementer wait is the push wait alone.
   */
  needsInputCommented?(issue: number, marker: string): Promise<number | undefined>;
}

export interface RemoteSessionDeps {
  /** The working copy whose git config holds the markers. */
  readonly repoDir: string;
  /** The routine id of each role. */
  readonly routines: Readonly<Record<RemoteRole, string>>;
  readonly fire: FireClient;
  readonly github: RemoteGithub;
  readonly limits?: RemoteLimits;
  /** The clock and the wait. Tests give a virtual one. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

// ---- the marker ------------------------------------------------------------------------------------------------

type Marker = { readonly kind: 'firing' } | { readonly kind: 'fired'; readonly sessionId: string; readonly firedAt: number };

const SESSION_ID = /^(?:session|cse)_[A-Za-z0-9]{1,100}$/;

function markerKey(input: RemoteSessionInput): string {
  // Attempt 1 (the default) keeps the key of #672; a later attempt adds `-a<n>`, so it fires fresh (#673).
  const attempt = input.attempt === undefined || input.attempt === 1 ? '' : `-a${input.attempt}`;
  return `orchestratorremote.${input.issue}-${input.role}-${input.headSha ?? 'none'}${attempt}.state`;
}

function formatMarker(marker: Marker): string {
  return marker.kind === 'firing' ? 'firing' : `fired ${marker.sessionId} ${marker.firedAt}`;
}

function parseMarker(raw: string): Marker {
  if (raw === 'firing') {
    return { kind: 'firing' };
  }
  const match = /^fired (\S+) (\d{1,16})$/.exec(raw);
  if (match === null || match[1] === undefined || match[2] === undefined || !SESSION_ID.test(match[1])) {
    // Not written by this code: say so and stop, never guess which session it was.
    throw ApplicationFailure.nonRetryable('the remote session marker in the git config is not one this code wrote', 'MalformedMarker');
  }
  return { kind: 'fired', sessionId: match[1], firedAt: Number(match[2]) };
}

async function readMarker(repoDir: string, input: RemoteSessionInput): Promise<Marker | undefined> {
  const raw = await readConfig(repoDir, markerKey(input));
  return raw === undefined ? undefined : parseMarker(raw);
}

async function writeMarker(repoDir: string, input: RemoteSessionInput, marker: Marker): Promise<void> {
  await gitOk(repoDir, ['config', '--local', markerKey(input), formatMarker(marker)]);
}

async function clearMarker(repoDir: string, input: RemoteSessionInput): Promise<void> {
  // Exit 5 is "no such key", which is what a clear wants.
  const result = await git(repoDir, ['config', '--local', '--unset', markerKey(input)]);
  if (result.code !== 0 && result.code !== 5) {
    throw new Error(`git config failed (exit ${result.code})`);
  }
}

// ---- the claim and the wait --------------------------------------------------------------------------------------

/** The first reason the work is taken, or undefined when the role may launch. Reads only. */
async function findClaim(github: RemoteGithub, input: RemoteSessionInput): Promise<RemoteClaim | undefined> {
  const prs = await github.openPrs(input.issue);
  const branches = await github.claudeBranches(input.issue);
  if (input.role === 'implementer') {
    if (prs.length > 0) {
      return 'open_pr';
    }
    return branches.length > 0 ? 'branch_exists' : undefined;
  }
  // The reviewer and the fixer work on one open PR: any other open PR or branch of the issue is a claim.
  if (prs.some((pr) => pr !== input.pr)) {
    return 'open_pr';
  }
  if (branches.some((branch) => branch !== input.branch)) {
    return 'branch_exists';
  }
  if ((await github.branchTip(input.branch)) !== input.headSha) {
    return 'branch_moved';
  }
  if (input.role === 'reviewer' && input.pr !== undefined && input.headSha !== undefined && (await github.reviewedOnHead(input.pr, input.headSha))) {
    return 'already_reviewed';
  }
  return undefined;
}

interface WaitEnd {
  readonly outcome: 'finished' | 'timed_out' | 'needs_input';
  readonly headSha?: string;
  readonly commentId?: number;
}

// ---- the activity ------------------------------------------------------------------------------------------------

function parseOrFail(raw: unknown): RemoteSessionInput {
  try {
    const input = parseRemoteSessionInput(raw);
    if (input.findingsMarker !== undefined && !isFindingsMarker(input.findingsMarker)) {
      throw new InvalidRemoteSessionInputError('findingsMarker must be the findings marker of this pr and headSha');
    }
    if (input.repliesMarker !== undefined && !isFixerRepliesMarker(input.repliesMarker)) {
      throw new InvalidRemoteSessionInputError('repliesMarker must be the replies marker of this pr and headSha');
    }
    return input;
  } catch (error) {
    if (error instanceof InvalidRemoteSessionInputError) {
      // Retrying cannot fix a bad input.
      throw ApplicationFailure.nonRetryable(error.message, 'InvalidInput');
    }
    throw error;
  }
}

export function createRemoteSessionActivities(deps: RemoteSessionDeps) {
  const limits = deps.limits ?? REMOTE_LIMITS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  /**
   * Reads GitHub every `pollIntervalMs` until the session's work shows or `capMs` have passed since `since`.
   * - implementer and fixer: the branch tip differs from where the session started (none, or `headSha`), has not moved
   *   for `settleMs` and has no check pending. A push in the window restarts the settle time. The implementer has one more end
   *   (#697): a trusted comment on the issue with the needs-input marker of this attempt, while the tip has not moved. A moved
   *   tip keeps the settle path, marker or not.
   *   The fixer has one more end (#699): a trusted comment on the PR with its replies marker (`repliesMarker`), while the tip
   *   has not moved. It ends the wait as `finished` with no tip, the no-progress path. A moved tip keeps the settle path.
   * - reviewer: a trusted review with a body exists on `headSha`, or (when the input has `findingsMarker`) a trusted
   *   comment on the PR carries that marker. The first of the two ends the wait. Both are reads on the same schedule.
   */
  async function waitForEnd(input: RemoteSessionInput, since: number, capMs: number): Promise<WaitEnd> {
    const context = Context.current();
    let lastTip: string | undefined;
    let restingSince = now();
    for (;;) {
      context.heartbeat();
      if (input.role === 'reviewer') {
        if (input.pr !== undefined && input.headSha !== undefined && (await deps.github.reviewedOnHead(input.pr, input.headSha))) {
          return { outcome: 'finished', headSha: input.headSha };
        }
        if (
          input.pr !== undefined &&
          input.headSha !== undefined &&
          input.findingsMarker !== undefined &&
          deps.github.findingsCommented !== undefined &&
          (await deps.github.findingsCommented(input.pr, input.findingsMarker))
        ) {
          return { outcome: 'finished', headSha: input.headSha };
        }
      } else {
        const tip = await deps.github.branchTip(input.branch);
        if (tip !== undefined && tip !== input.headSha) {
          if (tip !== lastTip) {
            lastTip = tip;
            restingSince = now();
          }
          if (now() - restingSince >= limits.settleMs && !(await deps.github.checksPending(tip))) {
            return { outcome: 'finished', headSha: tip };
          }
        } else {
          lastTip = undefined;
          if (input.role === 'implementer' && deps.github.needsInputCommented !== undefined) {
            const commentId = await deps.github.needsInputCommented(input.issue, needsInputMarker(input.issue, input.attempt ?? 1));
            if (commentId !== undefined) {
              return { outcome: 'needs_input', commentId };
            }
          }
          if (
            input.role === 'fixer' &&
            input.pr !== undefined &&
            input.repliesMarker !== undefined &&
            deps.github.findingsCommented !== undefined &&
            (await deps.github.findingsCommented(input.pr, input.repliesMarker))
          ) {
            return { outcome: 'finished' };
          }
        }
      }
      if (now() - since >= capMs) {
        return { outcome: 'timed_out', ...(lastTip === undefined ? {} : { headSha: lastTip }) };
      }
      // Never past the cap by more than the read: the last wait is cut to what is left.
      await sleep(Math.min(limits.pollIntervalMs, Math.max(capMs - (now() - since), 1)));
    }
  }

  /** The fire call within its budget. Returns the receipt's id, or why it failed. Throws only a permanent error. */
  async function launch(input: RemoteSessionInput): Promise<{ sessionId: string } | { failure: RemoteLaunchFailure; keepMarker: boolean }> {
    const routineId = deps.routines[input.role];
    let backoff = limits.fireBackoffMs;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const receipt = await deps.fire.fire(routineId, input.brief);
        return { sessionId: receipt.sessionId };
      } catch (error) {
        if (!(error instanceof FireError)) {
          // Unknown: a session may exist, so the marker stays and the retry policy watches GitHub before it fires again.
          throw error;
        }
        const last = attempt >= limits.fireAttempts;
        let wait: number;
        switch (error.kind) {
          case 'bad_request':
            await clearMarker(deps.repoDir, input);
            throw ApplicationFailure.nonRetryable(`the routine for ${input.role} was refused (HTTP ${error.status ?? 400}): a person must look`, 'RoutineRejected');
          case 'auth':
            await clearMarker(deps.repoDir, input);
            throw ApplicationFailure.nonRetryable(`the routine for ${input.role} was refused (HTTP ${error.status ?? 401}): check the token`, 'RoutineAuth');
          case 'network':
          case 'malformed':
            // A session may have been made. No retry here, and the marker stays.
            return { failure: 'network', keepMarker: true };
          case 'rate_limited':
            wait = error.retryAfterMs ?? backoff;
            if (last || wait > limits.retryAfterMaxMs) {
              return { failure: 'rate_limited', keepMarker: false };
            }
            break;
          case 'server':
            if (last) {
              return { failure: 'server_error', keepMarker: true };
            }
            wait = backoff;
            break;
        }
        backoff *= 2;
        await sleepWithBeat(wait);
      }
    }
  }

  async function sleepWithBeat(ms: number): Promise<void> {
    Context.current().heartbeat();
    await sleep(ms);
  }

  async function runRemoteSession(raw: unknown): Promise<RemoteSessionResult> {
    const input = parseOrFail(raw);
    const context = Context.current();
    context.heartbeat();
    const heartbeat = setInterval(() => context.heartbeat(), limits.heartbeatIntervalMs);
    try {
      return await startOrReattach(input);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function startOrReattach(input: RemoteSessionInput): Promise<RemoteSessionResult> {
    let marker = await readMarker(deps.repoDir, input);

    if (marker?.kind === 'fired') {
      // Re-attach: nothing is launched. The same session is waited for, with the cap counted from its start.
      const end = await waitForEnd(input, marker.firedAt, limits.capMs);
      return { sessionId: marker.sessionId, ...end };
    }

    if (marker?.kind === 'firing') {
      // An earlier attempt may have made a session whose id was lost. Watch GitHub for its work before another is fired.
      const end = await waitForEnd(input, now(), limits.orphanPollMs);
      if (end.outcome !== 'timed_out') {
        return { outcome: end.outcome, ...(end.headSha === undefined ? {} : { headSha: end.headSha }), ...(end.commentId === undefined ? {} : { commentId: end.commentId }) };
      }
      await clearMarker(deps.repoDir, input);
      marker = undefined;
    }

    const claim = await findClaim(deps.github, input);
    if (claim !== undefined) {
      return { outcome: 'failed', claim };
    }

    // The marker first: the call is not idempotent, and a crash after it must not read as "never fired".
    await writeMarker(deps.repoDir, input, { kind: 'firing' });
    const launched = await launch(input);
    if ('failure' in launched) {
      if (!launched.keepMarker) {
        await clearMarker(deps.repoDir, input);
      }
      return { outcome: 'failed', failure: launched.failure };
    }
    const firedAt = now();
    await writeMarker(deps.repoDir, input, { kind: 'fired', sessionId: launched.sessionId, firedAt });
    console.error(`remote session ${launched.sessionId} fired for issue #${input.issue} as ${input.role}`);
    const end = await waitForEnd(input, firedAt, limits.capMs);
    return { sessionId: launched.sessionId, ...end };
  }

  return { runRemoteSession };
}

export type RemoteSessionActivities = ReturnType<typeof createRemoteSessionActivities>;

/** Waits inside an activity: heartbeats while it waits and stops when the activity is cancelled. */
async function defaultSleep(ms: number): Promise<void> {
  const context = Context.current();
  for (let left = ms; left > 0; left -= 5_000) {
    context.heartbeat();
    await context.sleep(Math.min(left, 5_000));
  }
}
