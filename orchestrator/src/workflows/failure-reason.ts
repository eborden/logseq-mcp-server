// What a workflow reads from a failed activity (#675): the plain type word of the failure and the counts line of a guard
// refusal. Moved out of issue.ts, unchanged, so the review loop can name a guard refusal without importing the issue workflow.
// Deterministic: no clock, I/O or randomness.

import { ActivityFailure, ApplicationFailure, TimeoutFailure } from '@temporalio/workflow';
import type { StopReason } from '../issue-types.ts';

/** The type of the failure under an activity failure, as a plain word. Never the message: it can name a path or a PR. */
export function failureReason(error: unknown): StopReason {
  const cause = error instanceof ActivityFailure ? error.cause : error;
  if (cause instanceof ApplicationFailure && typeof cause.type === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(cause.type)) {
    return cause.type;
  }
  if (cause instanceof TimeoutFailure) {
    return 'ActivityTimeout';
  }
  return 'ActivityFailed';
}

/** The counts line of a guard refusal (`the branch changes N file(s), ...`), which is numbers and fixed words, or undefined. */
export function guardCounts(error: unknown): string | undefined {
  const cause = error instanceof ActivityFailure ? error.cause : error;
  const message = cause instanceof ApplicationFailure ? cause.message : '';
  const match = /^the branch changes \d{1,9} file\(s\), \d{1,9} protected path\(s\) and \d{1,9} special file\(s\) in its commits$/.exec(message);
  return match === null ? undefined : `${match[0]}.`;
}
