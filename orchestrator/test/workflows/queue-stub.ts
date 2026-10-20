// The workflows of the queue watcher test that runs the REAL client activities (src/activities/queue.ts): the real
// `queueWatcher`, and a stand-in `issueWorkflow` registered under the real name, so `startIssueRun` and the visibility
// list see real executions. The stand-in plays a run held at the gate: it stays open until a decision signal arrives and
// then returns its input, so a test can pin the input the watcher built. It can also be told to end the way a stopped or
// crashed run ends (#724), so the status read sees real closed runs. It does nothing else.

import { ApplicationFailure, condition, defineSignal, setHandler } from '@temporalio/workflow';
import { maintainerDecisionSignal } from '../../src/approval-types.ts';
import type { IssueWorkflowInput } from '../../src/issue-types.ts';

export { queueWatcher } from '../../src/workflows/queue-watcher.ts';

/**
 * Ends the stand-in the way a test names: `complete` (returns its input), `stop:<step>:<reason>` (fails as `IssueStopped`,
 * the failure the real workflow ends a stopped run with: details are the step, the reason and no PR) or `crash` (fails with
 * a type that is not `IssueStopped`). Every failure carries a message with text that must never reach a report.
 */
export const stubFinishSignal = defineSignal<[string]>('stub-finish');

export const STUB_FAILURE_MESSAGE = 'canary text that must never reach a report';

export async function issueWorkflow(input: IssueWorkflowInput): Promise<IssueWorkflowInput> {
  let released = false;
  let finish: string | undefined;
  setHandler(maintainerDecisionSignal, () => {
    released = true;
  });
  setHandler(stubFinishSignal, (how) => {
    finish = how;
  });
  await condition(() => released || finish !== undefined);
  if (finish !== undefined && finish.startsWith('stop:')) {
    const [, step, ...reason] = finish.split(':');
    throw ApplicationFailure.nonRetryable(STUB_FAILURE_MESSAGE, 'IssueStopped', step, reason.join(':'), undefined);
  }
  if (finish === 'crash') {
    throw ApplicationFailure.nonRetryable(STUB_FAILURE_MESSAGE, 'StubCrash');
  }
  return input;
}
