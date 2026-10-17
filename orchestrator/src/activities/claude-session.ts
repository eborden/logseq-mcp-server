// The activity that runs one Claude Code session (#627). Sessions are long and nondeterministic, and an activity
// runs at least once (foundations 4.5), so:
//
// - One branch is one session. The branch is created with `git worktree add -b`, which fails when the branch
//   exists, so two overlapping attempts cannot both create it. An attempt that finds the branch (locally, or on
//   `origin`, which is where an open PR's branch lives) returns that state and starts nothing. It never starts a
//   second session for the same branch, even when the first one was cut short: it reports `interrupted` and the
//   workflow decides.
// - How a session ended is kept in the repo's own config (`branch.<name>.orchestratorsession`: `started`, then
//   `success` or `error`), so a retry after a crash that came after the session can return its result. Deleting
//   the branch deletes that entry with it.
// - The prompt is one argv element of `claude`, spawned without a shell. Only `type` and `is_error` are read
//   from the session's JSON output; the model's text is untrusted and is never returned, logged or put in an
//   error message.
// - Everything is bounded (foundations 4.6): the session has a timeout, a heartbeat runs while it does, its
//   output is capped, every git command has a timeout, and the retry policy has a maximum
//   (`claude-session-policy.ts`). Cancel and timeout both stop the child's whole process group, SIGTERM first
//   and SIGKILL after a grace period.
//
// Known gap: a worker that is itself SIGKILLed cannot stop its child, which keeps running on its own. The next
// attempt then sees `interrupted`, not a second session, which is what makes that case safe.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ApplicationFailure, CancelledFailure, Context } from '@temporalio/activity';
import { HEARTBEAT_INTERVAL_MS, KILL_GRACE_MS, SESSION_TIMEOUT_MS } from '../claude-session-policy.ts';
import type { ClaudeConfig } from '../config.ts';
import {
  InvalidSessionInputError,
  isSha,
  MalformedSessionOutputError,
  parseClaudeOutput,
  parseSessionInput,
} from '../types.ts';
import type { SessionExitStatus, SessionInput, SessionResult } from '../types.ts';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 1_000_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const REMOTE = 'origin';

export interface SessionLimits {
  readonly sessionTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly killGraceMs: number;
}

export const DEFAULT_LIMITS: SessionLimits = {
  sessionTimeoutMs: SESSION_TIMEOUT_MS,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  killGraceMs: KILL_GRACE_MS,
};

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs git and returns its exit code. A timeout or a missing git is thrown (the retry policy tries again). */
async function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'number' &&
      'stdout' in error &&
      typeof error.stdout === 'string' &&
      'stderr' in error &&
      typeof error.stderr === 'string'
    ) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    throw error;
  }
}

/** Runs git and throws on any non-zero exit. */
async function gitOk(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) {
    throw new Error(`git ${args[0] ?? ''} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 300)}`);
  }
  return result.stdout;
}

function markerKey(branch: string): string {
  return `branch.${branch}.orchestratorsession`;
}

async function readMarker(repoDir: string, branch: string): Promise<string | undefined> {
  const result = await git(repoDir, ['config', '--local', '--get', markerKey(branch)]);
  if (result.code === 0) {
    return result.stdout.trim();
  }
  if (result.code === 1) {
    return undefined;
  }
  throw new Error(`git config failed (exit ${result.code})`);
}

async function writeMarker(repoDir: string, branch: string, value: 'started' | 'success' | 'error'): Promise<void> {
  await gitOk(repoDir, ['config', '--local', markerKey(branch), value]);
}

async function localBranchSha(repoDir: string, branch: string): Promise<string | undefined> {
  const result = await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  if (result.code === 0) {
    return result.stdout.trim();
  }
  if (result.code === 1) {
    return undefined;
  }
  throw new Error(`git rev-parse failed (exit ${result.code})`);
}

/** The tip of the branch on `origin`, or undefined when there is no such branch or no `origin`. */
async function remoteBranchSha(repoDir: string, branch: string): Promise<string | undefined> {
  if ((await git(repoDir, ['remote', 'get-url', REMOTE])).code !== 0) {
    return undefined;
  }
  const result = await git(repoDir, ['ls-remote', '--exit-code', '--heads', REMOTE, `refs/heads/${branch}`]);
  if (result.code === 0) {
    const sha = result.stdout.split('\t')[0]?.trim() ?? '';
    if (!isSha(sha)) {
      throw new Error('git ls-remote answered with something that is not a commit id');
    }
    return sha;
  }
  // 2 is "no matching ref". Anything else (a network failure, say) is an error, never "the branch is absent".
  if (result.code === 2) {
    return undefined;
  }
  throw new Error(`git ls-remote failed (exit ${result.code})`);
}

function statusFromMarker(marker: string | undefined): SessionExitStatus {
  switch (marker) {
    case 'success':
      return 'success';
    case 'error':
      return 'error';
    case 'started':
      return 'interrupted';
    default:
      return 'existing';
  }
}

/** The state of a branch that already exists, or undefined when it does not. Starts nothing. */
async function findExisting(input: SessionInput): Promise<SessionResult | undefined> {
  const local = await localBranchSha(input.repoDir, input.branch);
  if (local !== undefined) {
    const marker = await readMarker(input.repoDir, input.branch);
    return { branch: input.branch, headSha: local, exitStatus: statusFromMarker(marker) };
  }
  const remote = await remoteBranchSha(input.repoDir, input.branch);
  if (remote !== undefined) {
    return { branch: input.branch, headSha: remote, exitStatus: 'existing' };
  }
  return undefined;
}

type ChildOutcome =
  | { readonly kind: 'exited'; readonly code: number | null; readonly stdout: string; readonly overflow: boolean }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'spawn-failed' };

/** Runs `claude`, heartbeating, and stops its whole process group on timeout or cancel. */
function runChild(
  bin: string,
  args: readonly string[],
  cwd: string,
  limits: SessionLimits,
  context: Context,
): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    // No shell, and the prompt is one element of args. Its own process group lets the stop reach what it spawned.
    const child = spawn(bin, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    let bytes = 0;
    let overflow = false;
    let stopReason: 'timeout' | 'cancelled' | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        // ESRCH: the group is already gone, which is what we wanted.
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          console.error(`could not signal the session's process group with ${signal}`);
        }
      }
    };
    const stop = (reason: 'timeout' | 'cancelled'): void => {
      if (stopReason !== undefined || settled) {
        return;
      }
      stopReason = reason;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), limits.killGraceMs);
    };

    const heartbeat = setInterval(() => context.heartbeat(), limits.heartbeatIntervalMs);
    const timeout = setTimeout(() => stop('timeout'), limits.sessionTimeoutMs);
    const onAbort = (): void => stop('cancelled');
    context.cancellationSignal.addEventListener('abort', onAbort, { once: true });

    const finish = (outcome: ChildOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      context.cancellationSignal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (overflow) {
        return;
      }
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) {
        overflow = true;
        stdout = '';
        return;
      }
      stdout += chunk;
    });
    child.on('error', () => {
      // The process never started (a missing binary, a bad cwd), or could not be signalled.
      if (child.pid === undefined) {
        finish({ kind: 'spawn-failed' });
      }
    });
    child.on('close', (code) => {
      finish(stopReason === undefined ? { kind: 'exited', code, stdout, overflow } : { kind: stopReason });
    });
    if (context.cancellationSignal.aborted) {
      stop('cancelled');
    }
  });
}

function parseOrFail(raw: unknown): SessionInput {
  try {
    return parseSessionInput(raw);
  } catch (error) {
    if (error instanceof InvalidSessionInputError) {
      // Retrying cannot fix a bad input.
      throw ApplicationFailure.nonRetryable(error.message, 'InvalidInput');
    }
    throw error;
  }
}

export function createClaudeSessionActivities(config: ClaudeConfig, limits: SessionLimits = DEFAULT_LIMITS) {
  /**
   * Creates the worktree and branch, runs one session in it, and returns where the branch ended up. When the
   * branch already exists it returns that state instead and starts no session.
   */
  async function runClaudeSession(raw: unknown): Promise<SessionResult> {
    const input = parseOrFail(raw);
    const context = Context.current();
    context.heartbeat();

    const existing = await findExisting(input);
    if (existing !== undefined) {
      return existing;
    }

    try {
      await gitOk(input.repoDir, ['worktree', 'add', '-b', input.branch, input.worktreeDir, input.baseRef]);
    } catch (error) {
      // Another attempt may have created the branch since the check above: that attempt owns the session.
      const raced = await findExisting(input);
      if (raced !== undefined) {
        return raced;
      }
      throw error;
    }
    await writeMarker(input.repoDir, input.branch, 'started');

    const args = [
      '-p',
      '--output-format',
      'json',
      ...(config.permissionMode === undefined ? [] : ['--permission-mode', config.permissionMode]),
      '--',
      input.prompt,
    ];
    const outcome = await runChild(config.claudeBin, args, input.worktreeDir, limits, context);

    switch (outcome.kind) {
      case 'spawn-failed':
        // No session ran, so leave nothing behind that a retry would take for one.
        await gitOk(input.repoDir, ['worktree', 'remove', '--force', input.worktreeDir]);
        await gitOk(input.repoDir, ['branch', '-D', input.branch]);
        throw ApplicationFailure.nonRetryable('could not start the claude executable', 'ClaudeUnavailable');
      case 'timeout':
        await writeMarker(input.repoDir, input.branch, 'error');
        throw ApplicationFailure.nonRetryable(
          `the session ran past its ${limits.sessionTimeoutMs} ms limit and was stopped`,
          'SessionTimeout',
        );
      case 'cancelled':
        // The marker stays `started`: a later attempt reports `interrupted` and does not start another session.
        throw new CancelledFailure('the session was cancelled and its process was stopped');
      case 'exited':
        break;
    }

    let status: 'success' | 'error' = 'error';
    if (outcome.code === 0) {
      try {
        if (outcome.overflow) {
          throw new MalformedSessionOutputError('the session printed more than the output limit');
        }
        status = parseClaudeOutput(outcome.stdout).isError ? 'error' : 'success';
      } catch (error) {
        if (error instanceof MalformedSessionOutputError) {
          // The session ran, so a retry must not run another. Record that, and fail with nothing returned.
          await writeMarker(input.repoDir, input.branch, 'error');
          throw ApplicationFailure.nonRetryable(error.message, 'MalformedResult');
        }
        throw error;
      }
    }
    await writeMarker(input.repoDir, input.branch, status);
    const headSha = (await gitOk(input.repoDir, ['rev-parse', '--verify', `refs/heads/${input.branch}^{commit}`])).trim();
    return { branch: input.branch, headSha, exitStatus: status };
  }

  return { runClaudeSession };
}

export type ClaudeSessionActivities = ReturnType<typeof createClaudeSessionActivities>;
