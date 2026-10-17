// The merge gate as a pure function (#630; CLAUDE.md "Code review" step 5, foundations 4.8). No model, no clock, no
// I/O: the numbers come from the `getGateStatus` activity, which counts reviews and unresolved threads on GitHub.
// Workflow code may import this file.

export interface GateCounts {
  /** Submitted, non-empty reviews by a trusted author on the PR's current head commit. */
  readonly reviewsOnHead: number;
  /** Review threads that are not resolved, whoever started them. */
  readonly unresolvedThreads: number;
}

/**
 * Clear means at least one review on the head and no unresolved thread. Zero threads with zero reviews on the head
 * is not clear: nothing has looked at this commit.
 */
export function gateClear(counts: GateCounts): boolean {
  return counts.reviewsOnHead >= 1 && counts.unresolvedThreads === 0;
}
