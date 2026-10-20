// The workflows of the queue watcher test that runs the REAL client activities (src/activities/queue.ts): the real
// `queueWatcher`, and a stand-in `issueWorkflow` registered under the real name, so `startIssueRun` and the visibility
// list see real executions. The stand-in plays a run held at the gate: it stays open until a decision signal arrives and
// then returns its input, so a test can pin the input the watcher built. It does nothing else.

import { condition, setHandler } from '@temporalio/workflow';
import { maintainerDecisionSignal } from '../../src/approval-types.ts';
import type { IssueWorkflowInput } from '../../src/issue-types.ts';

export { queueWatcher } from '../../src/workflows/queue-watcher.ts';

export async function issueWorkflow(input: IssueWorkflowInput): Promise<IssueWorkflowInput> {
  let released = false;
  setHandler(maintainerDecisionSignal, () => {
    released = true;
  });
  await condition(() => released);
  return input;
}
