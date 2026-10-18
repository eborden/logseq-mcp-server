// The host integration check at the gate (#648, plan #643): decide whether a head needs it, run it on the host queue,
// and record the result as the `host/integration` commit status that the gate reads. CLAUDE.md "Verification before
// merge", foundations 4.5, 4.6 and 4.9.
//
// What `required(head)` does, once per head (a head already judged answers from memory, with no call):
//   need     `getHostIntegrationNeed`: the pure rule of integration-policy.ts over the PR's changed files. No → done.
//   read     `getHostIntegration` for that head. `success` → done: a head with a pass is never run again, so a replay or
//            a restarted run does not run the suite twice. Any other state (none, pending, failure, error) runs it.
//   pending  `postCommitStatus` pending, so a person looking at the PR sees the check is under way.
//   run      `runHostIntegration` on the `host` queue with the options of host-integration-policy.ts: a bounded
//            deadline and one retry, and a test failure is returned, not thrown, so one failing check is not retried.
//   record   the result as success, failure or error (error is never reported as failure, and a run that did not finish
//            is never a pass). Counts travel in the description, nothing else.
//   fix      (#676) a `fail` with a failure summary, with a remote executor and a fix round left, starts one remote fixer round
//            (`fix`, from decision.ts) and the run goes on; the new head is judged on its own, once, when it has settled.
//   stop     anything else but `pass` ends the run for a person (`IntegrationFailed`, `IntegrationConflict`,
//            `IntegrationFixtureDirty`, `IntegrationSetupError`, `IntegrationTimeout`), after the status is written.
//
// The status posts are idempotent (`postCommitStatus` reads first), and the stop comment is keyed, so a worker killed
// between the run and the post repeats the post and leaves one visible status. Only the `fix` above starts a fixer; every other failure goes
// to a person. Workflow code is deterministic: no clock, no I/O; history carries a PR number, a SHA, one fixed word and
// two integers (BR-0001).

import { ActivityFailure, TimeoutFailure, isCancellation, proxyActivities } from '@temporalio/workflow';
import type { GithubActivities } from '../activities/github.ts';
import type { HostIntegrationActivities } from '../activities/host-integration.ts';
import { GITHUB_ACTIVITY_OPTIONS } from '../github-policy.ts';
import { HOST_INTEGRATION_ACTIVITY_OPTIONS } from '../host-integration-policy.ts';
import type { HostFailureSummary, HostIntegrationOutcome, HostIntegrationResult } from '../host-integration-policy.ts';
import { buildHostDescription } from '../integration-policy.ts';
import type { HostCounts, HostStatusState } from '../integration-policy.ts';
import { ISSUE_STEP_TIMEOUT } from '../issue-types.ts';
import type { IssueStep, StopReason } from '../issue-types.ts';

const github = proxyActivities<Pick<GithubActivities, 'getHostIntegrationNeed' | 'getHostIntegration' | 'postCommitStatus'>>({
  ...GITHUB_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});
// The run is bounded by its own start-to-close and heartbeat timeouts and a retry budget of two attempts (the policy
// file). `scheduleToCloseTimeout` bounds the wait for a host worker that is not running: it ends in a stop, not an open wait.
const host = proxyActivities<Pick<HostIntegrationActivities, 'runHostIntegration'>>({
  ...HOST_INTEGRATION_ACTIVITY_OPTIONS,
  scheduleToCloseTimeout: ISSUE_STEP_TIMEOUT,
});

/** How each outcome is written on the commit, and why the run stops (none for a pass). */
const OUTCOMES: Readonly<Record<HostIntegrationOutcome, { readonly state: HostStatusState; readonly counts: boolean; readonly stop?: StopReason }>> = {
  pass: { state: 'success', counts: true },
  fail: { state: 'failure', counts: true, stop: 'IntegrationFailed' },
  // The suite ran to a report but the fixture changed: the counts are real, the result is not trusted.
  fixture_dirty: { state: 'error', counts: true, stop: 'IntegrationFixtureDirty' },
  // No suite ran (or none to a report): zero counts would read as "nothing failed", so none are given.
  conflict: { state: 'error', counts: false, stop: 'IntegrationConflict' },
  setup_error: { state: 'error', counts: false, stop: 'IntegrationSetupError' },
};

export interface HostIntegrationGate {
  /** Whether the host check is required for this head, after running it when it is needed and not yet passed. */
  readonly required: (head: string) => Promise<boolean>;
}

export interface HostIntegrationGateContext {
  readonly pr: number;
  /** The branch the PR targets, for the merge into a throwaway worktree on the host. */
  readonly base: string;
  /** Runs one activity call; a failure of it ends the run at `name` (issue.ts). */
  readonly step: <T>(name: IssueStep, call: () => Promise<T>) => Promise<T>;
  /** Ends the run with one comment on the issue and a Failed workflow (issue.ts); `detail` is one fixed line of counts. */
  readonly stop: (step: IssueStep, reason: StopReason, detail?: string) => Promise<never>;
  /**
   * Routes a `fail` of a run proved to be on the fixture to one remote fixer round (#676), and answers whether it did: false
   * when there is no round left, and the run then stops for a person as it always did. Absent: every failure stops.
   * The summary goes to the fixer's brief only; the status and the stop comment keep counts.
   */
  readonly fix?: (head: string, summary: HostFailureSummary) => Promise<boolean>;
}

export function createHostIntegrationGate(context: HostIntegrationGateContext): HostIntegrationGate {
  const { pr, base, step, stop, fix } = context;
  const judged = new Map<string, boolean>();

  async function run(head: string): Promise<void> {
    if ((await step('host_integration', () => github.getHostIntegration({ sha: head }))).state === 'success') {
      return;
    }
    await step('host_integration', () => github.postCommitStatus({ sha: head, state: 'pending' }));

    let result: HostIntegrationResult;
    try {
      result = await host.runHostIntegration({ pr, headSha: head, base });
    } catch (error) {
      if (isCancellation(error)) {
        throw error;
      }
      // The activity threw: a setup failure after its retry, or a run that never finished. Not a pass, not a failure of the tests.
      const reason: StopReason = (error instanceof ActivityFailure ? error.cause : error) instanceof TimeoutFailure ? 'IntegrationTimeout' : 'IntegrationSetupError';
      await step('host_integration', () => github.postCommitStatus({ sha: head, state: 'error' }));
      return await stop('host_integration', reason, `Host integration check for \`${head}\`: it did not finish (${buildHostDescription(undefined)}).`);
    }

    const written = OUTCOMES[result.outcome];
    const counts: HostCounts | undefined = written.counts ? { passed: result.passed, failed: result.failed } : undefined;
    await step('host_integration', () => github.postCommitStatus(counts === undefined ? { sha: head, state: written.state } : { sha: head, state: written.state, counts }));
    // Only a `fail` that carries a summary is the fixer's: `error`, `conflict`, `setup_error` and `fixture_dirty` never are, and a
    // `fail` the activity could not prove was on the fixture has no summary.
    if (result.outcome === 'fail' && result.failureSummary !== undefined && fix !== undefined && (await fix(head, result.failureSummary))) {
      return;
    }
    if (written.stop !== undefined) {
      return await stop('host_integration', written.stop, `Host integration check for \`${head}\`: ${result.outcome} (${buildHostDescription(counts)}).`);
    }
  }

  return {
    required: async (head) => {
      const known = judged.get(head);
      if (known !== undefined) {
        return known;
      }
      const needed = (await step('host_integration', () => github.getHostIntegrationNeed(pr))).needed;
      if (needed) {
        await run(head);
      }
      judged.set(head, needed);
      return needed;
    },
  };
}
