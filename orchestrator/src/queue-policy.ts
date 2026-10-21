// Which Ready issues may start now (#722, parent plan #721). Pure: no I/O, no Node imports, so workflow code may import it.
//
// The rule is the GitHub edges, not file overlap (plan-in-issues: blocked-by is the hard-ordering source of truth). An issue
// is eligible when it is in the Ready list, has no open blocked-by issue, is not taken (an open PR or a `claude/<n>` branch
// of its own, and later a running workflow, #723), and its author is trusted (OWNER, MEMBER or COLLABORATOR). The trust
// answer is an input: the activity that reads it is `checkTrustedIssues` (src/activities/github.ts). An issue the caller
// has no trust answer for is not trusted, so a missing answer never starts a run.
//
// Numbers only in, numbers and reasons out. No title, label or other text from an issue's author is ever here.

import type { ReadyIssues } from './types.ts';

/** Why a listed issue does not start. The order is the order the rule checks them in. */
export type SkipReason = 'blocked' | 'taken' | 'untrusted';

export interface SkippedIssue {
  readonly number: number;
  readonly reason: SkipReason;
}

export interface Eligibility {
  /** The issue numbers that may start, ascending and without repeats. */
  readonly eligible: readonly number[];
  /** A reason per issue that may not, ascending by number, at most MAX_SKIPPED_REPORTED of them. */
  readonly skipped: readonly SkippedIssue[];
  /** How many more skipped issues the report left out because of the bound. Zero when `skipped` is complete. */
  readonly skippedNotReported: number;
}

/** Most skipped issues one report names. The rest are counted in `skippedNotReported`, never dropped silently (BR-0006). */
export const MAX_SKIPPED_REPORTED = 100;

/**
 * Decides which of the listed Ready issues may start.
 *
 * @param listed what `listReadyIssues` answered: `ready` has no open blocker, `blocked` names the issues that have one.
 * @param taken the issue numbers with an open PR or a `claude/<n>` branch (`listTakenIssues`), and later a running workflow.
 * @param trusted the issue numbers whose author is OWNER, MEMBER or COLLABORATOR (`checkTrustedIssues`).
 */
export function eligibleIssues(listed: ReadyIssues, taken: readonly number[], trusted: readonly number[]): Eligibility {
  const blocked = new Set(listed.blocked.map((issue) => issue.number));
  const takenSet = new Set(taken);
  const trustedSet = new Set(trusted);
  const candidates = [...new Set([...listed.ready, ...blocked])].sort((a, b) => a - b);

  const eligible: number[] = [];
  const skipped: SkippedIssue[] = [];
  for (const number of candidates) {
    const reason = skipReason(number, blocked, takenSet, trustedSet);
    if (reason === undefined) {
      eligible.push(number);
    } else {
      skipped.push({ number, reason });
    }
  }
  return {
    eligible,
    skipped: skipped.slice(0, MAX_SKIPPED_REPORTED),
    skippedNotReported: Math.max(0, skipped.length - MAX_SKIPPED_REPORTED),
  };
}

function skipReason(number: number, blocked: ReadonlySet<number>, taken: ReadonlySet<number>, trusted: ReadonlySet<number>): SkipReason | undefined {
  if (blocked.has(number)) {
    return 'blocked';
  }
  if (taken.has(number)) {
    return 'taken';
  }
  return trusted.has(number) ? undefined : 'untrusted';
}
