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
import { InvalidBranchInputError, parseBranchInput, parseDeleteBranchInput } from '../branch-types.ts';
import type { BranchInput, DeleteBranchResult, GuardResult, PushResult } from '../branch-types.ts';
import { checkBranchChanges, parseRawDiff, RawDiffError } from '../diff-guard.ts';
import type { ChangedFile } from '../diff-guard.ts';

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

  /** The raw change list of a git command, parsed. A non-zero exit is an error the retry policy tries again. */
  async function changes(input: BranchInput, args: readonly string[]): Promise<ChangedFile[]> {
    const result = await git(input.repoDir, args, DIFF_TIMEOUT_MS);
    if (result.code !== 0) {
      throw new Error(`git ${args[0] ?? ''} failed (exit ${result.code})`);
    }
    try {
      return parseRawDiff(result.stdout);
    } catch (error) {
      if (error instanceof RawDiffError) {
        throw ApplicationFailure.nonRetryable(error.message, 'MalformedGitOutput');
      }
      throw error;
    }
  }

  async function guardBranch(raw: unknown): Promise<GuardResult> {
    const input = parseOrFail(raw);
    await requireTip(input);
    return await guardRanges(input);
  }

  /** The two ranges of the guard on a tip that is already known to be where the input says. */
  async function guardRanges(input: BranchInput): Promise<GuardResult> {
    // Two ranges, and both are the ones the push is about to publish:
    // - HISTORY, `origin/<base>..<sha>`: every commit reachable from the head and not already on the base. This is
    //   exactly what `git push` of the branch sends, so a protected change in ANY of those commits refuses the branch,
    //   even if a later commit undoes it.
    // - NET, `origin/<base>...<sha>`: the merge base of the base and the head, against the head. This is the change the
    //   PR shows, so it decides whether there is anything to push and whether it is too big. A base that moved on, or
    //   that the branch merged or was rebased onto, adds nothing to either range that is not the session's own.
    // `--no-renames` lists both ends of a rename, `-z` keeps odd names exact and `--raw` carries the modes. The base and
    // the SHA are validated, and `--` ends the options. The base ref is the worktree's `origin/<base>` as the worker has
    // it; the activity does not fetch, and a stale one can only widen HISTORY, never narrow it.
    const history = await changes(input, ['log', '--raw', '-z', '--no-renames', '--no-abbrev', '--format=', `origin/${input.base}..${input.headSha}`, '--']);
    const net = await changes(input, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', `origin/${input.base}...${input.headSha}`, '--']);
    const verdict = checkBranchChanges(net, history);
    if (!verdict.ok) {
      // Counts only: the comment and the history carry no path. The paths are in the worktree for a person.
      throw ApplicationFailure.nonRetryable(
        `the branch changes ${verdict.files} file(s), ${verdict.protectedPaths} protected path(s) and ${verdict.specialFiles} special file(s) in its commits`,
        verdict.reason,
      );
    }
    return { branch: input.branch, headSha: input.headSha, files: verdict.files };
  }

  /** The branch's tip on the remote, or undefined when it is not there. A failed read is thrown (the retry policy tries again). */
  async function remoteTip(input: { readonly repoDir: string; readonly branch: string }): Promise<string | undefined> {
    const result = await git(input.repoDir, ['ls-remote', '--heads', 'origin', `refs/heads/${input.branch}`], LS_REMOTE_TIMEOUT_MS);
    if (result.code !== 0) {
      throw new Error(`git ls-remote failed (exit ${result.code})`);
    }
    const sha = result.stdout.split('\t')[0]?.trim();
    return sha === undefined || sha === '' ? undefined : sha;
  }

  /**
   * The guard for a branch a remote session pushed itself (#673). The session's tip is fetched into `refs/remotes/origin/`
   * first (the worktree has no local branch for it), then the same two ranges run on it as for a local branch. The tip must
   * be the one the session reported, before and after the guard: a branch that moved is `BranchMoved`, and no PR is opened
   * on a sha that was not guarded. The fetch has fixed argv, hooks off, and the names are parsed first.
   */
  async function guardRemoteBranch(raw: unknown): Promise<GuardResult> {
    const input = parseOrFail(raw);
    const fetch = await git(
      input.repoDir,
      [
        '-c',
        'core.hooksPath=/dev/null',
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        'origin',
        `+refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`,
        `+refs/heads/${input.base}:refs/remotes/origin/${input.base}`,
      ],
      PUSH_TIMEOUT_MS,
    );
    if (fetch.code !== 0) {
      // A branch that is not there is permanent for this call; anything else (network) is tried again.
      if (/couldn't find remote ref/i.test(fetch.stderr)) {
        throw ApplicationFailure.nonRetryable('the remote branch does not exist', 'BranchMissing');
      }
      throw new Error(`git fetch failed (exit ${fetch.code})`);
    }
    const fetched = await git(input.repoDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${input.branch}^{commit}`], DIFF_TIMEOUT_MS);
    if (fetched.code !== 0 || fetched.stdout.trim() !== input.headSha) {
      throw ApplicationFailure.nonRetryable('the remote branch is not at the commit the session ended at', 'BranchMoved');
    }
    const result = await guardRanges(input);
    // It can move while the guard runs: read the remote again, and refuse a different tip.
    if ((await remoteTip(input)) !== input.headSha) {
      throw ApplicationFailure.nonRetryable('the remote branch moved while it was checked', 'BranchMoved');
    }
    return result;
  }

  /**
   * Deletes a remote `claude/<number>` branch with fixed argv (#673): `git -c core.hooksPath=/dev/null push origin --delete
   * claude/<number>`, then reads the remote back. Idempotent: a branch that is already gone is success. Only the worker's own
   * credential does this; a cloud session cannot.
   */
  async function deleteRemoteBranch(raw: unknown): Promise<DeleteBranchResult> {
    let input;
    try {
      input = parseDeleteBranchInput(raw);
    } catch (error) {
      if (error instanceof InvalidBranchInputError) {
        throw ApplicationFailure.nonRetryable(error.message, 'InvalidInput');
      }
      throw error;
    }
    const before = await remoteTip(input);
    if (before === undefined) {
      return { branch: input.branch, deleted: false };
    }
    const push = await git(input.repoDir, ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', '--delete', input.branch], PUSH_TIMEOUT_MS);
    if (push.code !== 0 && !/remote ref does not exist/i.test(push.stderr)) {
      if (/rejected|denied|permission|protected|not allowed/i.test(push.stderr)) {
        throw ApplicationFailure.nonRetryable('the remote refused the delete', 'DeleteRejected');
      }
      throw new Error(`git push --delete failed (exit ${push.code})`);
    }
    if ((await remoteTip(input)) !== undefined) {
      throw new Error('the remote still shows the branch after the delete');
    }
    return { branch: input.branch, deleted: push.code === 0 };
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

  return { guardBranch, guardRemoteBranch, deleteRemoteBranch, pushBranch };
}

export type BranchActivities = ReturnType<typeof createBranchActivities>;
