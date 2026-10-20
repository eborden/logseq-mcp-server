// The run input `npm run run-issue` builds from its flags (#671), apart from the script so a test can pin it: the script
// connects to a server and cannot be imported. Parsing is the same `parseIssueWorkflowInput` the workflow uses.

import { resolve } from 'node:path';
import { InvalidIssueInputError, attemptForFlag, executorForFlag, hostIntegrationForFlag, parseIssueWorkflowInput } from './issue-types.ts';
import type { IssueWorkflowInput } from './issue-types.ts';

export interface RunIssueFlags {
  readonly issue: string | undefined;
  readonly base: string;
  readonly repoDir: string;
  readonly worktreeDir: string | undefined;
  readonly hostIntegration: boolean;
  readonly executor: string | undefined;
  /** The first attempt number of the remote implementer (#673). Absent means 1. */
  readonly attempt?: string | undefined;
}

/** Throws `InvalidIssueInputError` for a bad flag, before any connection is made. */
export function buildRunInput(flags: RunIssueFlags): IssueWorkflowInput {
  const issueNumber = Number(flags.issue);
  const repoDir = resolve(flags.repoDir);
  return parseIssueWorkflowInput({
    issueNumber,
    repoDir,
    worktreeDir: resolve(flags.worktreeDir ?? `${repoDir}/.claude/worktrees/issue-${issueNumber}`),
    base: flags.base,
    ...hostIntegrationForFlag(flags.hostIntegration),
    ...executorForFlag(flags.executor),
    ...attemptForFlag(flags.attempt),
  });
}

/** The flags `npm run run-issue -- --resume` (#747) refuses, as they were given: a resume starts no session and reads the PR's own base. */
export interface ResumeFlags {
  readonly issue: string | undefined;
  readonly repoDir: string;
  readonly hostIntegration: boolean;
  readonly executor: string | undefined;
  readonly base: string | undefined;
  readonly worktreeDir: string | undefined;
  readonly attempt: string | undefined;
}

/** A base only to pass the parse: `startResumeRun` replaces it with the PR's own base before the run starts. */
const PLACEHOLDER_BASE = 'main';

/**
 * The run input of a resume (#747), before the PR is read. Throws `InvalidIssueInputError` for a bad flag or for a flag a resume
 * does not take, before any connection is made. `--host-integration` is the stopped run's: the check at the gate is the same as in
 * a full run. `--executor` is refused because no session of any kind runs: a failed check stops for a person, never for a fixer
 * (the fixer works on `claude/<n>`, and the PR being re-gated may be on another branch).
 */
export function buildResumeInput(flags: ResumeFlags) {
  if (flags.executor !== undefined) {
    throw new InvalidIssueInputError('--executor is not used with --resume: no session starts, and a failed check stops for a person');
  }
  if (flags.base !== undefined) {
    throw new InvalidIssueInputError('--base is not used with --resume: the base is the pull request\'s own');
  }
  if (flags.worktreeDir !== undefined) {
    throw new InvalidIssueInputError('--worktree-dir is not used with --resume: no session starts');
  }
  if (flags.attempt !== undefined) {
    throw new InvalidIssueInputError('--attempt is not used with --resume: no implementer session starts');
  }
  return buildRunInput({
    issue: flags.issue,
    base: PLACEHOLDER_BASE,
    repoDir: flags.repoDir,
    worktreeDir: undefined,
    hostIntegration: flags.hostIntegration,
    executor: undefined,
  });
}
