// Workflow code must be deterministic: no clock, no I/O, no randomness. Everything with a side effect is an
// activity (parent plan #625). Every activity has a timeout and a bounded retry policy (foundations 4.6).

import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/hello.ts';
import type { HelloInput, HelloResult } from '../hello-types.ts';

const { greet } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '5 seconds',
    nonRetryableErrorTypes: ['InvalidInput'],
  },
});

// The slow activity heartbeats, so a killed worker is noticed after 3 seconds, not after the whole timeout.
const { farewell } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  heartbeatTimeout: '3 seconds',
  retry: {
    maximumAttempts: 5,
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '10 seconds',
    nonRetryableErrorTypes: ['InvalidInput'],
  },
});

export async function helloWorkflow(input: HelloInput): Promise<HelloResult> {
  const first = await greet(input);
  const second = await farewell(input);
  return { runKey: input.runKey, steps: [first, second] };
}
