// The activity that runs the implementer (#629). It exists so the text of an issue never enters the workflow history:
// Temporal stores every activity input and result, and the brief holds the issue body and its comments. Here the
// issue is read (by the trusted-only `readIssue`), the brief is built from it, and the session is started, all
// inside one activity. What leaves is a `SessionResult`: a branch, a SHA and a status.
//
// A retry reads the issue again and then asks `runClaudeSession` for the branch, which starts no second session
// when the branch exists (it reports `interrupted`, `claimed`, `existing`, `success` or `error` instead).

import { ApplicationFailure, Context } from '@temporalio/activity';
import { HEARTBEAT_INTERVAL_MS } from '../claude-session-policy.ts';
import { BriefTooLargeError, buildBrief, buildRemoteImplementerBrief } from '../brief.ts';
import { InvalidIssueInputError, issueBranch, issueWorkflowId, parseIssueWorkflowInput } from '../issue-types.ts';
import type { RemoteSessionInput, RemoteSessionResult } from '../remote-session-policy.ts';
import type { IssueView, SessionInput, SessionResult } from '../types.ts';

export interface ImplementerDeps {
  /** The trusted-only read: an untrusted issue is refused and an untrusted comment is dropped. */
  readonly readIssue: (issueNumber: number) => Promise<IssueView>;
  readonly runClaudeSession: (input: SessionInput) => Promise<SessionResult>;
  /** `owner/name`, named in the brief. */
  readonly repo: string;
}

export function createImplementerActivities(deps: ImplementerDeps) {
  async function runImplementerSession(raw: unknown): Promise<SessionResult> {
    let input;
    try {
      input = parseIssueWorkflowInput(raw);
    } catch (error) {
      if (error instanceof InvalidIssueInputError) {
        throw ApplicationFailure.nonRetryable(error.message, 'InvalidInput');
      }
      throw error;
    }
    // The read before the session can take a while (rate limits wait, heartbeating); keep the beat from the start.
    const context = Context.current();
    context.heartbeat();
    const heartbeat = setInterval(() => context.heartbeat(), HEARTBEAT_INTERVAL_MS);
    try {
      const issue = await deps.readIssue(input.issueNumber);
      if (issue.state !== 'open') {
        throw ApplicationFailure.nonRetryable(`issue #${input.issueNumber} is closed, so no session is started`, 'InvalidState');
      }
      const branch = issueBranch(input.issueNumber);
      let prompt: string;
      try {
        prompt = buildBrief({ issue, repo: deps.repo, branch, base: input.base, workflowId: issueWorkflowId(input.issueNumber) });
      } catch (error) {
        if (error instanceof BriefTooLargeError) {
          throw ApplicationFailure.nonRetryable(error.message, 'BriefTooLarge');
        }
        throw error;
      }
      return await deps.runClaudeSession({
        repoDir: input.repoDir,
        worktreeDir: input.worktreeDir,
        branch,
        baseRef: `origin/${input.base}`,
        prompt,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  return { runImplementerSession };
}

export type ImplementerActivities = ReturnType<typeof createImplementerActivities>;

export interface RemoteImplementerDeps {
  readonly readIssue: (issueNumber: number) => Promise<IssueView>;
  /** `runRemoteSession` (#672). */
  readonly runRemoteSession: (input: RemoteSessionInput) => Promise<RemoteSessionResult>;
  readonly repo: string;
}

/**
 * The remote implementer (#673): the run input plus the attempt number, answered with a `RemoteSessionResult`. It exists for the
 * same reason as `runImplementerSession`: the brief holds the issue body and its comments, so it is built here, inside the
 * activity, and never passes through the workflow history. The session itself is `runRemoteSession` with role `implementer`.
 */
export function createRemoteImplementerActivities(deps: RemoteImplementerDeps) {
  async function runRemoteImplementerSession(raw: unknown): Promise<RemoteSessionResult> {
    let input;
    try {
      input = parseIssueWorkflowInput(raw);
    } catch (error) {
      if (error instanceof InvalidIssueInputError) {
        throw ApplicationFailure.nonRetryable(error.message, 'InvalidInput');
      }
      throw error;
    }
    // Passed as it came: runRemoteSession parses the attempt (a positive whole number) with the rest of its input.
    const attempt: unknown = typeof raw === 'object' && raw !== null && 'attempt' in raw ? raw.attempt : undefined;
    const issue = await deps.readIssue(input.issueNumber);
    if (issue.state !== 'open') {
      throw ApplicationFailure.nonRetryable(`issue #${input.issueNumber} is closed, so no session is started`, 'InvalidState');
    }
    const branch = issueBranch(input.issueNumber);
    let brief: string;
    try {
      brief = buildRemoteImplementerBrief({ issue, repo: deps.repo, branch, base: input.base, workflowId: issueWorkflowId(input.issueNumber) });
    } catch (error) {
      if (error instanceof BriefTooLargeError) {
        throw ApplicationFailure.nonRetryable(error.message, 'BriefTooLarge');
      }
      throw error;
    }
    return await deps.runRemoteSession({
      role: 'implementer',
      issue: input.issueNumber,
      branch,
      base: input.base,
      brief,
      ...(attempt === undefined ? {} : { attempt: attempt as number }),
    });
  }

  return { runRemoteImplementerSession };
}

export type RemoteImplementerActivities = ReturnType<typeof createRemoteImplementerActivities>;
