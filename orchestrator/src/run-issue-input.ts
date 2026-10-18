// The run input `npm run run-issue` builds from its flags (#671), apart from the script so a test can pin it: the script
// connects to a server and cannot be imported. Parsing is the same `parseIssueWorkflowInput` the workflow uses.

import { resolve } from 'node:path';
import { attemptForFlag, executorForFlag, hostIntegrationForFlag, parseIssueWorkflowInput } from './issue-types.ts';
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
