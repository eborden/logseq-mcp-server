// The maintainer's decision as a signal (#631, parent plan #625): shapes, bounds and the texts of the comments, in one
// place that workflow code, the signal CLI and the activities may all import. This file imports nothing from Node and
// nothing from config.ts, and it has no clock and no I/O.
//
// The decision is a typed payload parsed at the boundary (foundations 4.2): the CLI parses what a person typed, and
// the workflow parses what a signal carries, with the same function. A payload that does not parse changes nothing.
// The maintainer's message is the one piece of free text that reaches the workflow's history, because it travels in
// the signal. It is the maintainer's own words for the decision comment, bounded here, and it is never graph data.

import { defineSignal } from '@temporalio/workflow';

/** The signal's name. The CLI sends it by this name; the workflow handles it by this name. */
export const MAINTAINER_DECISION_SIGNAL = 'maintainerDecision';

export type DecisionKind = 'approved' | 'changes_requested';

export const DECISION_KINDS: readonly DecisionKind[] = ['approved', 'changes_requested'];

export interface MaintainerDecision {
  readonly decision: DecisionKind;
  /** The maintainer's date for the decision, `YYYY-MM-DD`. The CLI fills it; workflow code has no clock to read. */
  readonly at: string;
  /** The maintainer's own words, quoted in the decision comment. Absent when they gave none. */
  readonly message?: string;
}

/** The signal definition. `defineSignal` is pure; the CLI imports it to send, the workflow to handle. */
export const maintainerDecisionSignal = defineSignal<[unknown]>(MAINTAINER_DECISION_SIGNAL);

export const MAX_DECISION_MESSAGE_CHARS = 1_000;

export class InvalidDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDecisionError';
  }
}

// The characters review-types.ts `sanitiseText` removes: control characters other than newline and tab, and the ones
// that reorder or hide text.
const HIDDEN_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069\ufeff]/;

const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in the form `YYYY-MM-DD`: February 30 and month 13 are refused. */
export function isCalendarDate(value: string): boolean {
  const match = DATE_SHAPE.exec(value);
  if (match === null) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Parses a signal payload (or what the CLI built) into a decision. The message never quotes a value. */
export function parseMaintainerDecision(raw: unknown): MaintainerDecision {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidDecisionError('the decision must be an object');
  }
  const decision: unknown = 'decision' in raw ? raw.decision : undefined;
  const at: unknown = 'at' in raw ? raw.at : undefined;
  const message: unknown = 'message' in raw ? raw.message : undefined;
  const kind = DECISION_KINDS.find((candidate) => candidate === decision);
  if (kind === undefined) {
    throw new InvalidDecisionError('decision must be approved or changes_requested');
  }
  if (typeof at !== 'string' || !isCalendarDate(at)) {
    throw new InvalidDecisionError('at must be a calendar date, YYYY-MM-DD');
  }
  if (message !== undefined) {
    if (typeof message !== 'string' || message.trim() === '' || message.length > MAX_DECISION_MESSAGE_CHARS || HIDDEN_CHARACTERS.test(message)) {
      throw new InvalidDecisionError(`message must be non-empty text of at most ${MAX_DECISION_MESSAGE_CHARS} characters without control characters`);
    }
    return { decision: kind, at, message };
  }
  return { decision: kind, at };
}

/** The arguments of `npm run signal -- <issue> approved|changes_requested [--message <text>]`, parsed. */
export interface SignalArgs {
  readonly issue: number;
  readonly decision: DecisionKind;
  readonly message?: string;
}

/** Parses the CLI's positionals and options. `today` is `YYYY-MM-DD` from the caller's clock. */
export function parseSignalArgs(positionals: readonly string[], message: string | undefined, today: string): { args: SignalArgs; payload: MaintainerDecision } {
  const [issueText, decisionText, ...rest] = positionals;
  if (rest.length > 0 || issueText === undefined || decisionText === undefined) {
    throw new InvalidDecisionError('usage: signal <issue> approved|changes_requested [--message <text>]');
  }
  const issue = /^[1-9][0-9]{0,8}$/.test(issueText) ? Number(issueText) : undefined;
  if (issue === undefined) {
    throw new InvalidDecisionError('issue must be a positive whole number');
  }
  const payload = parseMaintainerDecision({ decision: decisionText, at: today, ...(message === undefined ? {} : { message }) });
  return { args: { issue, decision: payload.decision, ...(payload.message === undefined ? {} : { message: payload.message }) }, payload };
}

// ---- bounds ----------------------------------------------------------------------------------------------------

/**
 * ASSUMPTION for the maintainer to confirm (#631 "Open questions"): the longest the run waits for the maintainer's
 * decision, from the moment the review loop ends. At the limit it comments on the PR and stops; it never approves.
 * The same bound applies, separately, to the wait for the merge after an approval. The input may set another value.
 */
export const DEFAULT_DECISION_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
export const MIN_DECISION_TIMEOUT_MS = 1_000;
export const MAX_DECISION_TIMEOUT_MS = 10 * 24 * 60 * 60_000;

/** How often the run reads GitHub while it waits (the gate, the PR's state). Each read is one bounded activity. */
export const DEFAULT_DECISION_POLL_MS = 60 * 60_000;
export const MIN_DECISION_POLL_MS = 500;
export const MAX_DECISION_POLL_MS = 24 * 60 * 60_000;

// ---- what a PR changes that the maintainer alone decides -------------------------------------------------------

/**
 * Counts of the files of a PR that need the maintainer's own OK (CLAUDE.md "Verification before merge", "ADRs and
 * business rules"). Counts only: no path leaves the activity.
 */
export interface SensitiveChanges {
  readonly files: number;
  /** Golden results and the recorded tool list under `tests/data/parity/` (the `golden-change` label). */
  readonly golden: number;
  /** The call ceilings file (also the `golden-change` label). */
  readonly ceilings: number;
  readonly adrs: number;
  readonly businessRules: number;
  /** False when the PR has more files than one call reads, so the counts are not the whole answer. */
  readonly complete: boolean;
}

const CEILINGS_FILE = 'tests/data/parity/call-ceilings.json';
const PARITY_DIR = 'tests/data/parity/';

/** What a PR with more files than one call reads answers: nothing was counted, and the comment says so. */
export const UNCLASSIFIED_CHANGES: SensitiveChanges = { files: 0, golden: 0, ceilings: 0, adrs: 0, businessRules: 0, complete: false };

/**
 * Sorts the changed paths of a PR into the counts above. A group file under `tests/data/parity/` is counted as
 * golden although a change to only its stub answers is not one (the CI job compares by case): this errs toward
 * telling the maintainer, which costs a sentence, never toward staying quiet. The same goes for the README of
 * `docs/adr/` and `docs/business-rules/`: it counts as a change there although the OK rule is about their content.
 */
export function classifyChangedPaths(paths: readonly string[]): SensitiveChanges {
  let golden = 0;
  let ceilings = 0;
  let adrs = 0;
  let businessRules = 0;
  for (const raw of paths) {
    const path = raw.replace(/^\.\//, '').toLowerCase();
    if (path === CEILINGS_FILE) {
      ceilings += 1;
    } else if (path.startsWith(PARITY_DIR)) {
      golden += 1;
    } else if (path.startsWith('docs/adr/')) {
      adrs += 1;
    } else if (path.startsWith('docs/business-rules/')) {
      businessRules += 1;
    }
  }
  return { files: paths.length, golden, ceilings, adrs, businessRules, complete: true };
}

// ---- comments --------------------------------------------------------------------------------------------------

/** The key of the decision comment: one per PR, so a repeated step posts once. */
export function decisionCommentKey(pr: number): string {
  return `decision-${pr}`;
}

export function decisionTimeoutCommentKey(pr: number): string {
  return `decision-timeout-${pr}`;
}

export function mergeTimeoutCommentKey(pr: number): string {
  return `merge-timeout-${pr}`;
}

/**
 * The maintainer's words as a blockquote, made inert in a public comment: `<` is an entity (no hidden marker, no HTML),
 * and `@`, `#`, `[` and `://` are written as entities so a message cannot mention anyone, link an issue or autolink.
 */
export function quoteMessage(message: string): string {
  const entity: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '@': '&#64;', '#': '&#35;', '[': '&#91;' };
  return message
    .replace(/[&<@#[]/g, (character) => entity[character] ?? character)
    .replace(/:\/\//g, '&#58;//')
    .split(/\r\n|\r|\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The sentences about what only the maintainer may decide, from the counts. Empty when the PR changes none of it. */
export function sensitiveNotes(changes: SensitiveChanges): string[] {
  const notes: string[] = [];
  if (!changes.complete) {
    notes.push('This PR changes more files than the orchestrator reads, so it could not tell whether golden results, call ceilings, ADRs or business rules changed. Check by hand before the merge.');
  }
  if (changes.golden + changes.ceilings > 0) {
    notes.push(
      `This PR changes ${plural(changes.golden, 'file')} of golden results and ${plural(changes.ceilings, 'call ceiling file')} (\`tests/data/parity/\`). The \`golden-change\` label needs the maintainer's explicit OK and only the maintainer adds it. The workflow never applies it.`,
    );
  }
  if (changes.adrs + changes.businessRules > 0) {
    notes.push(
      `This PR changes ${plural(changes.adrs, 'ADR file')} and ${plural(changes.businessRules, 'business rule file')}. Merging it needs the maintainer's explicit OK on that change, recorded on the PR. This decision does not stand in for it.`,
    );
  }
  return notes;
}

/**
 * The decision comment (merge policy: "a PR comment records the approval ... quoting the maintainer's message
 * verbatim with its date"). Fixed words, the maintainer's own message and identifiers.
 */
export function decisionComment(workflowId: string, pr: number, headSha: string, decision: MaintainerDecision, changes: SensitiveChanges): string {
  const isApproval = decision.decision === 'approved';
  const notes = sensitiveNotes(changes);
  return [
    `The maintainer's decision on #${pr}, recorded by the orchestrator (workflow \`${workflowId}\`): **${isApproval ? 'approved' : 'changes requested'}**, dated ${decision.at}, for the head commit \`${headSha}\`.`,
    decision.message === undefined ? 'The maintainer gave no message.' : `The maintainer's message:\n\n${quoteMessage(decision.message)}`,
    ...notes,
    isApproval
      ? 'The orchestrator does not merge. It waits for the maintainer to merge, then moves the PR and its issue to Done and checks that the issue is closed.'
      : 'The orchestrator stops here. It does not change the branch again: a person decides what happens next.',
  ].join('\n\n');
}

export function decisionTimeoutComment(workflowId: string, pr: number, timeoutMs: number): string {
  return [
    `The orchestrator (workflow \`${workflowId}\`) waited ${Math.round(timeoutMs / 3_600_000)} hours for the maintainer's decision on #${pr} and none came, or the merge gate was not clear in that time.`,
    'A timeout never approves. The run stops here with the PR as it is. To decide later, a person starts the review again by hand.',
  ].join('\n\n');
}

export function mergeTimeoutComment(workflowId: string, pr: number, timeoutMs: number): string {
  return [
    `The orchestrator (workflow \`${workflowId}\`) recorded the maintainer's approval of #${pr} and waited ${Math.round(timeoutMs / 3_600_000)} hours for the merge, which did not happen.`,
    'The run stops here. The PR and its issue are left as they are: nothing was moved to Done.',
  ].join('\n\n');
}

export function mergedWithoutDecisionKey(pr: number): string {
  return `merged-without-decision-${pr}`;
}

export function mergedWithoutDecisionComment(workflowId: string, pr: number): string {
  return [
    `The orchestrator (workflow \`${workflowId}\`) saw #${pr} merged with no decision from the maintainer sent to it.`,
    'No decision is recorded for this run. The merge is the maintainer\'s own record. The run now moves the PR and its issue to Done and checks that the issue is closed.',
  ].join('\n\n');
}
