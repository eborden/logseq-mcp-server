// The one place the workflow chooses how a model session runs (#671, plan #643). `local` calls the activity it is given,
// exactly as v1 did. `remote` has no activity behind it yet, so the run stops for a person before any session starts;
// the later tasks replace that stop with a remote session. Deterministic: no clock, I/O or randomness.

import { REMOTE_EXECUTOR_UNAVAILABLE } from '../issue-types.ts';
import type { Executor, IssueStep, StopReason } from '../issue-types.ts';

export async function onExecutor<T>(
  executor: Executor | undefined,
  stepName: IssueStep,
  stop: (step: IssueStep, reason: StopReason) => Promise<never>,
  local: () => Promise<T>,
): Promise<T> {
  if (executor === 'remote') {
    return await stop(stepName, REMOTE_EXECUTOR_UNAVAILABLE);
  }
  return await local();
}
