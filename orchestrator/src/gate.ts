// The merge gate as a pure function (#630; CLAUDE.md "Code review" step 5, foundations 4.8). No model, no clock, no
// I/O: the numbers come from the `getGateStatus` activity, which counts reviews and unresolved threads on GitHub.
// Workflow code may import this file.

import type { HostIntegrationState } from './integration-policy.ts';

export interface GateCounts {
  /** Submitted, non-empty reviews by a trusted author on the PR's current head commit. */
  readonly reviewsOnHead: number;
  /** Review threads that are not resolved, whoever started them. */
  readonly unresolvedThreads: number;
  /**
   * What the `host/integration` commit status of the head commit shows (#646). Absent means the host check is not
   * required for this PR, and the gate is what it was before this field existed. Present means it is required: only
   * `success` clears it, and `none`, `pending`, `failure` and `error` hold the gate.
   */
  readonly hostIntegration?: HostIntegrationState;
}

/**
 * Clear means at least one review on the head and no unresolved thread. Zero threads with zero reviews on the head
 * is not clear: nothing has looked at this commit. A required host check (see `hostIntegration`) that is not `success`
 * on the head holds the gate too.
 */
export function gateClear(counts: GateCounts): boolean {
  if (counts.hostIntegration !== undefined && counts.hostIntegration !== 'success') {
    return false;
  }
  return counts.reviewsOnHead >= 1 && counts.unresolvedThreads === 0;
}
