// `runHostIntegration` (#647, parent plan #643): runs the integration suite on a PR head, on the maintainer's Mac (the
// only machine with the LogSeq desktop app), and returns counts. It uses no model and makes no GitHub call. The
// worker registers it only on the `host` queue, one at a time (`worker.ts`, `HOST_TASK_QUEUE`).
//
// What one run does, in order, every command with a fixed argv and a timeout:
//   1. parse the input, then remove what an earlier run of the same PR left behind (a stale worktree, a running instance);
//   2. fetch the base and the PR head, make a throwaway detached worktree at `origin/<base>` OUTSIDE the working copy,
//      and merge the head into it. A conflict is the outcome `conflict`, not a test failure, and no suite starts;
//   3. `npm ci`, `cargo build --locked`, `scripts/logseq-instance.ts start`, `npm run test:integration` with the JSON
//      reporter, and `scripts/logseq-instance.ts stop` in a `finally`, so a failure, a timeout or a cancellation still
//      stops the instance;
//   4. `git status --porcelain tests/fixtures/graph` must be empty, or the outcome is `fixture_dirty`;
//   5. remove the worktree and the output.
//
// Rules the code keeps:
// - Nothing but integers and one fixed word leaves the activity (BR-0001, foundations 4.9). The raw output of every
//   command goes to a file in the run's own directory, capped in size, and is deleted with the worktree. The only part
//   read back is the reporter's two counts. Log lines carry a step name and an exit code, never output.
// - Re-running is safe (4.5): the same PR always uses the same directory, which a new run clears first, and `stop` is
//   harmless when nothing runs.
// - Bounded (4.6): one deadline for the whole run, a timeout per command inside it, a heartbeat from start to end, and
//   a retry only for a failure before the suite started. A failed suite is returned, never retried.
// - The commands run the PR's code (install scripts, `build.rs`, the tests) as the worker's user, so they get a small
//   allowlist of environment variables instead of the worker's: no token of the orchestrator reaches them. Only a
//   branch that passed `guardBranch` should be sent here.
// - The instance script is the only way LogSeq starts. It sandboxes the app's profile and the suite refuses port 12315.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationFailure, CancelledFailure, Context } from '@temporalio/activity';
import {
  HOST_CLEANUP_BUDGET_MS,
  HOST_HEARTBEAT_INTERVAL_MS,
  HOST_RUN_DEADLINE_MS,
  InvalidHostIntegrationInputError,
  parseHostIntegrationInput,
} from '../host-integration-policy.ts';
import type { HostIntegrationInput, HostIntegrationResult } from '../host-integration-policy.ts';

/** One command. The output is appended to `outputFile`; the runner returns only how it ended. */
export interface CommandSpec {
  /** A fixed name for the logs and for tests. It is never built from input. */
  readonly step: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly outputFile: string;
}

export interface CommandResult {
  /** The exit code, or null when the command did not start or was stopped by a signal. */
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

/** Runs one command, stops it (and its children) at the timeout or when `signal` aborts. Tests inject a fake. */
export interface CommandRunner {
  run(spec: CommandSpec, signal?: AbortSignal): Promise<CommandResult>;
}

export interface HostLimits {
  readonly runDeadlineMs: number;
  readonly cleanupBudgetMs: number;
  readonly heartbeatIntervalMs: number;
  readonly now: () => number;
}

export interface HostIntegrationOptions {
  /** The working copy the worktree is made from (any directory inside it works). */
  readonly repoDir: string;
  /** Where runs are made, outside `repoDir`. Default: a directory under the OS temp directory. */
  readonly workRoot?: string;
  readonly runner?: CommandRunner;
  readonly limits?: Partial<HostLimits>;
  /** Called with one line per step: a name and an exit code. Default: stderr. */
  readonly log?: (line: string) => void;
  /** The worker's environment, to pick the allowlisted variables from. Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_LIMITS: HostLimits = {
  runDeadlineMs: HOST_RUN_DEADLINE_MS,
  cleanupBudgetMs: HOST_CLEANUP_BUDGET_MS,
  heartbeatIntervalMs: HOST_HEARTBEAT_INTERVAL_MS,
  now: Date.now,
};

// Per-command ceilings. Each is also cut to what is left of the run's deadline.
const GIT_TIMEOUT_MS = 5 * 60_000;
const NPM_CI_TIMEOUT_MS = 10 * 60_000;
const CARGO_TIMEOUT_MS = 20 * 60_000;
const INSTANCE_START_TIMEOUT_MS = 5 * 60_000;
const QUICK_TIMEOUT_MS = 60_000;

/** The most a command's output file may grow to; the rest is dropped. */
export const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;
/** The most the reporter's JSON file may be before it is refused unread. */
export const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;

const WORK_DIR_NAME = 'logseq-mcp-orchestrator-host';
const GIT_NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'] as const;
const MERGE_IDENTITY = ['-c', 'user.name=orchestrator', '-c', 'user.email=orchestrator@localhost', '-c', 'commit.gpgsign=false'] as const;

/** The variables the commands may inherit. No token, no config path (a `LOGSEQ_MCP_CONFIG` must never reach the suite). */
const ENV_ALLOWLIST: readonly string[] = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'CARGO_HOME', 'RUSTUP_HOME', 'NVM_DIR', 'VOLTA_HOME', 'SSH_AUTH_SOCK'];

export function hostCommandEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      picked[name] = value;
    }
  }
  picked['GIT_TERMINAL_PROMPT'] = '0';
  return picked;
}

/** The default runner: `spawn` in its own process group, so a timeout or cancellation stops the children too. */
export function createProcessRunner(): CommandRunner {
  return {
    run(spec, signal) {
      return new Promise<CommandResult>((resolve) => {
        const sink = createWriteStream(spec.outputFile, { flags: 'a' });
        sink.on('error', () => undefined);
        let written = 0;
        let timedOut = false;
        let aborted = false;
        let settled = false;
        let killTimer: NodeJS.Timeout | undefined;
        const finish = (code: number | null): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          clearTimeout(killTimer);
          signal?.removeEventListener('abort', onAbort);
          sink.end(() => resolve({ code, timedOut, aborted }));
        };

        const child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: { ...spec.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const signalGroup = (name: NodeJS.Signals): void => {
          try {
            if (child.pid !== undefined) {
              process.kill(-child.pid, name);
            }
          } catch {
            // The group is already gone.
          }
        };
        const stopChild = (): void => {
          signalGroup('SIGTERM');
          killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
        };
        const onAbort = (): void => {
          aborted = true;
          stopChild();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stopChild();
        }, spec.timeoutMs);

        const collect = (chunk: Buffer): void => {
          if (written >= MAX_COMMAND_OUTPUT_BYTES) {
            return;
          }
          const part = chunk.subarray(0, MAX_COMMAND_OUTPUT_BYTES - written);
          written += part.length;
          sink.write(part);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('error', () => finish(null));
        child.on('close', (code) => finish(code));
        if (signal?.aborted === true) {
          onAbort();
        } else {
          signal?.addEventListener('abort', onAbort, { once: true });
        }
      });
    },
  };
}

/** The suite did not run to a point where the failure is the PR's: retry once, then report `setup_error`. */
class SetupFailure extends Error {
  readonly retryable: boolean;
  constructor(step: string, retryable: boolean) {
    super(`host integration stopped at ${step}`);
    this.name = 'SetupFailure';
    this.retryable = retryable;
  }
}

/** Reads the two counts the JSON reporter writes. Anything else in the file is ignored, and a bad shape is `undefined`. */
export function parseReportCounts(text: string): { passed: number; failed: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const passed: unknown = 'numPassedTests' in parsed ? parsed.numPassedTests : undefined;
  const failed: unknown = 'numFailedTests' in parsed ? parsed.numFailedTests : undefined;
  if (typeof passed !== 'number' || !Number.isSafeInteger(passed) || passed < 0 || typeof failed !== 'number' || !Number.isSafeInteger(failed) || failed < 0) {
    return undefined;
  }
  return { passed, failed };
}

export function createHostIntegrationActivities(options: HostIntegrationOptions) {
  const limits: HostLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const runner = options.runner ?? createProcessRunner();
  const log = options.log ?? ((line: string): void => console.error(line));
  const commandEnv = hostCommandEnv(options.env ?? process.env);
  const workRoot = options.workRoot ?? join(tmpdir(), WORK_DIR_NAME);

  function parseOrFail(raw: unknown): HostIntegrationInput {
    try {
      return parseHostIntegrationInput(raw);
    } catch (error) {
      if (error instanceof InvalidHostIntegrationInputError) {
        throw ApplicationFailure.nonRetryable(error.message, 'InvalidInput');
      }
      throw error;
    }
  }

  async function runHostIntegration(raw: unknown): Promise<HostIntegrationResult> {
    const input = parseOrFail(raw);
    const context = Context.current();
    // From here to the end, so a slow fetch or build never looks like a dead worker.
    context.heartbeat();
    const heartbeat = setInterval(() => context.heartbeat(), limits.heartbeatIntervalMs);
    try {
      return await execute(input, context);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function execute(input: HostIntegrationInput, context: Context): Promise<HostIntegrationResult> {
    const runDir = join(workRoot, `pr-${input.pr}`);
    const tree = join(runDir, 'tree');
    const outDir = join(runDir, 'out');
    const commandLog = join(outDir, 'commands.log');
    const reportFile = join(outDir, 'report.json');
    const statusFile = join(outDir, 'fixture-status.txt');
    const deadlineAt = limits.now() + limits.runDeadlineMs;
    const signal = context.cancellationSignal;
    const line = (step: string, exit: string): void => log(`host-integration pr=${input.pr} step=${step} exit=${exit}`);

    /** Runs one command inside the run's deadline. A start failure or a timeout is a result, a cancellation is thrown. */
    async function step(name: string, command: string, args: readonly string[], cwd: string, capMs: number, outputFile = commandLog): Promise<CommandResult> {
      const remaining = deadlineAt - limits.now();
      if (remaining <= 0) {
        line(name, 'deadline');
        return { code: null, timedOut: true, aborted: false };
      }
      const result = await runCommand({ step: name, command, args, cwd, env: commandEnv, timeoutMs: Math.min(capMs, remaining), outputFile }, signal);
      line(name, result.aborted ? 'cancelled' : result.timedOut ? 'timeout' : result.code === null ? 'error' : String(result.code));
      if (result.aborted) {
        throw new CancelledFailure('the host integration run was cancelled and its process was stopped');
      }
      return result;
    }

    /** Cleanup commands: their own budget, never the cancellation signal, and a failure is logged and not thrown. */
    async function cleanup(name: string, command: string, args: readonly string[], cwd: string, capMs: number): Promise<CommandResult> {
      const result = await runCommand({ step: name, command, args, cwd, env: commandEnv, timeoutMs: Math.min(capMs, limits.cleanupBudgetMs), outputFile: commandLog });
      line(name, result.timedOut ? 'timeout' : result.code === null ? 'error' : String(result.code));
      return result;
    }

    async function runCommand(spec: CommandSpec, abort?: AbortSignal): Promise<CommandResult> {
      try {
        return await runner.run(spec, abort);
      } catch {
        return { code: null, timedOut: false, aborted: false };
      }
    }

    function must(result: CommandResult, name: string, retryable: boolean): void {
      if (result.timedOut) {
        throw new SetupFailure(name, false);
      }
      if (result.code !== 0) {
        throw new SetupFailure(name, retryable);
      }
    }

    async function removeRun(): Promise<void> {
      await cleanup('worktree_remove', 'git', [...GIT_NO_HOOKS, 'worktree', 'remove', '--force', tree], options.repoDir, GIT_TIMEOUT_MS);
      await cleanup('worktree_prune', 'git', [...GIT_NO_HOOKS, 'worktree', 'prune'], options.repoDir, GIT_TIMEOUT_MS);
      try {
        await rm(runDir, { recursive: true, force: true });
      } catch {
        line('remove_run_dir', 'error');
      }
    }

    async function stopInstance(): Promise<void> {
      await cleanup('instance_stop', 'npx', ['tsx', 'scripts/logseq-instance.ts', 'stop'], tree, QUICK_TIMEOUT_MS * 2);
    }

    try {
      // A stale run of the same PR (a crashed worker): stop its instance, then remove it. All best effort.
      if (await exists(runDir)) {
        await mkdir(outDir, { recursive: true });
        if (await exists(tree)) {
          await stopInstance();
        }
        await removeRun();
      }
      await mkdir(outDir, { recursive: true });

      try {
        return await runSteps();
      } finally {
        await removeRun();
      }
    } catch (error) {
      if (error instanceof SetupFailure) {
        if (error.retryable && context.info.attempt < 2) {
          throw new Error(error.message);
        }
        return { outcome: 'setup_error', passed: 0, failed: 0 };
      }
      throw error;
    }

    async function runSteps(): Promise<HostIntegrationResult> {
      const remoteBase = `+refs/heads/${input.base}:refs/remotes/origin/${input.base}`;
      must(await step('fetch', 'git', [...GIT_NO_HOOKS, 'fetch', '--no-tags', '--no-recurse-submodules', 'origin', remoteBase, `refs/pull/${input.pr}/head`], options.repoDir, GIT_TIMEOUT_MS), 'fetch', true);
      // The run tests exactly the commit it was asked for; a head that was never fetched means the PR moved.
      must(await step('head_present', 'git', ['cat-file', '-e', `${input.headSha}^{commit}`], options.repoDir, QUICK_TIMEOUT_MS), 'head_present', false);
      must(await step('worktree_add', 'git', [...GIT_NO_HOOKS, 'worktree', 'add', '--detach', tree, `origin/${input.base}`], options.repoDir, GIT_TIMEOUT_MS), 'worktree_add', true);

      const merge = await step('merge', 'git', [...GIT_NO_HOOKS, ...MERGE_IDENTITY, 'merge', '--no-edit', input.headSha], tree, GIT_TIMEOUT_MS);
      if (merge.timedOut) {
        throw new SetupFailure('merge', false);
      }
      if (merge.code !== 0) {
        // A conflict leaves MERGE_HEAD behind; any other failure does not, and is not the PR's conflict.
        const pending = await step('merge_head', 'git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], tree, QUICK_TIMEOUT_MS);
        if (pending.code === 0) {
          return { outcome: 'conflict', passed: 0, failed: 0 };
        }
        throw new SetupFailure('merge', false);
      }

      must(await step('npm_ci', 'npm', ['ci', '--no-audit', '--no-fund'], tree, NPM_CI_TIMEOUT_MS), 'npm_ci', true);
      must(await step('cargo_build', 'cargo', ['build', '--locked'], tree, CARGO_TIMEOUT_MS), 'cargo_build', true);

      let suite: CommandResult;
      try {
        must(await step('instance_start', 'npx', ['tsx', 'scripts/logseq-instance.ts', 'start'], tree, INSTANCE_START_TIMEOUT_MS), 'instance_start', true);
        suite = await step('integration', 'npm', ['run', 'test:integration', '--', '--reporter=json', `--outputFile=${reportFile}`], tree, HOST_RUN_DEADLINE_MS);
      } finally {
        // Also after a timeout, a cancellation or a crash of the run. A repeated stop is harmless.
        await stopInstance();
      }

      if (suite.timedOut) {
        throw new SetupFailure('integration', false);
      }

      // The committed fixture must never change. The instance is stopped, so nothing is writing any more.
      const status = await step('fixture_status', 'git', ['status', '--porcelain', '--', 'tests/fixtures/graph'], tree, QUICK_TIMEOUT_MS, statusFile);
      must(status, 'fixture_status', false);
      const dirty = (await readSmall(statusFile, 1_000_000))?.trim() !== '';
      const counts = await readCounts(reportFile);

      if (dirty) {
        return { outcome: 'fixture_dirty', passed: counts?.passed ?? 0, failed: counts?.failed ?? 0 };
      }
      if (counts === undefined) {
        // The suite ended without a report (its global setup refused, or the run crashed): there is nothing to count.
        throw new SetupFailure('report', false);
      }
      const ok = suite.code === 0 && counts.failed === 0;
      return { outcome: ok ? 'pass' : 'fail', passed: counts.passed, failed: counts.failed };
    }
  }

  return { runHostIntegration };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A file's text, or `undefined` when it is missing or larger than `maxBytes`. A missing status file reads as dirty by the caller's `!== ''`. */
async function readSmall(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    if ((await stat(path)).size > maxBytes) {
      return undefined;
    }
    return await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
}

async function readCounts(path: string): Promise<{ passed: number; failed: number } | undefined> {
  const text = await readSmall(path, MAX_REPORT_BYTES);
  return text === undefined ? undefined : parseReportCounts(text);
}

export type HostIntegrationActivities = ReturnType<typeof createHostIntegrationActivities>;
