// The branch activities (#629 review): `guardBranch` checks what a session changed, and `pushBranch` pushes it. The
// session cannot push at all (no push rule in its allowed tools); this is the only push, and its argv is fixed:
//
//   git -c core.hooksPath=/dev/null push -u origin claude/<number>
//
// The branch name is parsed against `claude/<number>` first, so no refspec, option, flag or slug can come from input.
// Hooks are switched off for that one command, because a session can write into the shared `.git/hooks`, and a hook
// would run here, outside the session's permissions. Both activities are idempotent: a guard only reads, and pushing an
// up-to-date branch changes nothing. They return counts, a branch and a SHA, never a path or any git output.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApplicationFailure } from '@temporalio/activity';
import { InvalidBranchInputError, parseBranchInput } from '../branch-types.ts';
import type { BranchInput, GuardResult, PushResult } from '../branch-types.ts';
import { checkChangedPaths } from '../diff-guard.ts';

const execFileAsync = promisify(execFile);

const DIFF_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 120_000;
const LS_REMOTE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 4_000_000;

export interface BranchActivityOptions {
  /** The git executable. Tests point it at a wrapper that records the argv. */
  readonly gitBin?: string;
}

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function parseOrFail(raw: unknown): BranchInput {
  try {
    return parseBranchInput(raw);
  } catch (error) {
    if (error instanceof InvalidBranchInputError) {
      throw ApplicationFailure.nonRetryable(error.message, 'InvalidInput');
    }
    throw error;
  }
}

export function createBranchActivities(options: BranchActivityOptions = {}) {
  const gitBin = options.gitBin ?? 'git';

  /** Runs git with a fixed argv and returns its exit code. A timeout or a missing git is thrown (the retry policy tries again). */
  async function git(cwd: string, args: readonly string[], timeoutMs: number): Promise<GitResult> {
    try {
      const { stdout, stderr } = await execFileAsync(gitBin, args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
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

  /** The tip of the local branch, and a refusal when it is not the one the session ended at. */
  async function requireTip(input: BranchInput): Promise<void> {
    const result = await git(input.repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${input.branch}^{commit}`], DIFF_TIMEOUT_MS);
    if (result.code !== 0) {
      throw ApplicationFailure.nonRetryable('the branch does not exist', 'BranchMoved');
    }
    if (result.stdout.trim() !== input.headSha) {
      throw ApplicationFailure.nonRetryable('the branch is not at the commit the session ended at', 'BranchMoved');
    }
  }

  async function guardBranch(raw: unknown): Promise<GuardResult> {
    const input = parseOrFail(raw);
    await requireTip(input);
    // `--no-renames` lists both ends of a rename, so a file moved out of a protected directory is still seen.
    // `-z` keeps odd file names exact. The base and the SHA are validated, and `--` ends the options.
    const diff = await git(
      input.repoDir,
      ['diff', '--name-only', '-z', '--no-renames', `origin/${input.base}...${input.headSha}`, '--'],
      DIFF_TIMEOUT_MS,
    );
    if (diff.code !== 0) {
      throw new Error(`git diff failed (exit ${diff.code})`);
    }
    const paths = diff.stdout.split('\0').filter((path) => path !== '');
    const verdict = checkChangedPaths(paths);
    if (!verdict.ok) {
      // Counts only: the comment and the history carry no path. The paths are in the worktree for a person.
      throw ApplicationFailure.nonRetryable(
        `the branch changes ${verdict.files} file(s), ${verdict.protectedPaths} of them protected`,
        verdict.reason,
      );
    }
    return { branch: input.branch, headSha: input.headSha, files: verdict.files };
  }

  async function pushBranch(raw: unknown): Promise<PushResult> {
    const input = parseOrFail(raw);
    await requireTip(input);
    const push = await git(
      input.repoDir,
      ['-c', 'core.hooksPath=/dev/null', 'push', '-u', 'origin', input.branch],
      PUSH_TIMEOUT_MS,
    );
    if (push.code !== 0) {
      // What the remote refused is not quoted. A refusal is not fixed by a retry; a network failure is.
      if (/rejected|non-fast-forward|denied|permission|protected|not allowed/i.test(push.stderr)) {
        throw ApplicationFailure.nonRetryable('the remote refused the push', 'PushRejected');
      }
      throw new Error(`git push failed (exit ${push.code})`);
    }
    // Read the remote back: a push that exited 0 is not proof the branch is there at the commit we expect.
    const remote = await git(input.repoDir, ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${input.branch}`], LS_REMOTE_TIMEOUT_MS);
    const remoteSha = remote.stdout.split('\t')[0]?.trim();
    if (remote.code !== 0 || remoteSha !== input.headSha) {
      throw new Error('the remote does not show the branch at the pushed commit');
    }
    return { branch: input.branch, headSha: input.headSha };
  }

  return { guardBranch, pushBranch };
}

export type BranchActivities = ReturnType<typeof createBranchActivities>;
