// The remote reviewer's findings comment (#674, plan #643 open question 3, option b). A remote reviewer cannot hand text
// to the worker, and posting its own review would skip the sanitiser, so it writes its findings as JSON into ONE keyed
// comment. This file turns the PR's comments into the same typed `ReviewerOutput` the local path reads from a file.
//
// The comment is untrusted input (foundations 4.2): it is read only from an author the repo trusts (a `trusted` flag the
// listing set from `author_association`), it counts only with the marker for this PR, head and round on its first line,
// and exactly one such comment with exactly one fenced JSON block must exist. Anything else is a refusal with counts, not
// a partial result. The JSON itself goes through `parseReviewerOutput`, the parser the local path uses, which bounds the
// size, checks the shape and cleans the text. No message here quotes comment text.

import { MAX_OUTPUT_FILE_BYTES, FindingsTooLargeError, MalformedFindingsError, parseFixerOutput, parseReviewerOutput } from './review-types.ts';
import type { FixerOutput, ReviewerOutput } from './review-types.ts';

/** What the listing keeps of one PR comment. `body` is empty when the author is not trusted. */
export interface FindingsCandidate {
  /** The REST id, for counts and logs. */
  readonly id: number;
  /** The GraphQL node id, which the minimise step needs. */
  readonly nodeId: string;
  readonly trusted: boolean;
  readonly body: string;
}

export interface ParsedFindings {
  readonly output: ReviewerOutput;
  readonly commentId: number;
  readonly commentNodeId: string;
}

/** The replies of a remote fixer (#675), read from its one keyed comment the way the reviewer's findings are. */
export interface ParsedFixerReplies {
  readonly output: FixerOutput;
  readonly commentId: number;
  readonly commentNodeId: string;
}

/** The key the reviewer's comment starts with. It names the PR, the exact head and the round, so an old comment never matches a new head. */
export function findingsMarker(pr: number, headSha: string, round: number): string {
  return `<!-- orchestrator-findings pr=${pr} head=${headSha} round=${round} -->`;
}

/**
 * The first line of the comment a remote implementer posts as its last act when it stops for a person (#697). It names the
 * issue and the attempt, so a comment of an earlier attempt never ends a later wait. What follows the marker is a question
 * for the maintainer: it is never read here.
 */
export function needsInputMarker(issue: number, attempt: number): string {
  return `<!-- orchestrator-needs-input issue=${issue} attempt=${attempt} -->`;
}

/**
 * The first line of the comment a remote implementer posts with the PR body it wrote (#705). It names the issue and the
 * attempt, so the body of an earlier attempt is never read for a later one. Everything after the marker is the body: data,
 * read by `findPrBody` and never executed.
 */
export function prBodyMarker(issue: number, attempt: number): string {
  return `<!-- orchestrator-pr-body issue=${issue} attempt=${attempt} -->`;
}

/** A PR body comment longer than this is refused, not cut: a body this long is not a handoff. */
export const MAX_PR_BODY_CHARS = 60_000;

/**
 * The text after the marker of the newest trusted comment whose first line is `marker` (the listing orders comments oldest
 * first, so the last match is the newest), or undefined when there is none. Untrusted authors and a marker on a later line
 * never count. Throws `FindingsTooLargeError` when that comment is over `MAX_PR_BODY_CHARS`. Reads only.
 */
export function findPrBody(candidates: readonly FindingsCandidate[], marker: string): string | undefined {
  const newest = keyedComments(candidates, marker).at(-1);
  if (newest === undefined) {
    return undefined;
  }
  if (newest.body.length > MAX_PR_BODY_CHARS) {
    throw new FindingsTooLargeError(`the PR body comment is longer than ${MAX_PR_BODY_CHARS} characters`);
  }
  const text = newest.body.trimStart();
  return text.slice(text.indexOf('\n') < 0 ? text.length : text.indexOf('\n') + 1).trim();
}

/** True when a comment body carries any orchestrator marker (`<!-- orchestrator-...`): a comment of ours or of a session we started, never an answer. */
export function carriesOrchestratorMarker(body: string): boolean {
  return body.includes('<!-- orchestrator-');
}

/**
 * The first comment that answers a needs-input comment (#698): by a trusted author, newer than `afterCommentId` (REST ids grow
 * with time), and with no orchestrator marker anywhere in it, so neither the park comment nor a status comment of ours can
 * count. The listing keeps no text for an untrusted author, and `trusted` is checked as well. Reads only.
 */
export function findNeedsInputAnswer(candidates: readonly FindingsCandidate[], afterCommentId: number): FindingsCandidate | undefined {
  return candidates.find((candidate) => candidate.trusted && candidate.id > afterCommentId && !carriesOrchestratorMarker(candidate.body));
}

/** The key the fixer's replies comment starts with. It names the PR, the head the round started from and the round. */
export function fixerRepliesMarker(pr: number, headSha: string, round: number): string {
  return `<!-- orchestrator-fixer-replies pr=${pr} head=${headSha} round=${round} -->`;
}

/** True when `value` is a marker `fixerRepliesMarker` could have made. */
export function isFixerRepliesMarker(value: string): boolean {
  return /^<!-- orchestrator-fixer-replies pr=[1-9]\d{0,9} head=[0-9a-f]{40} round=(?:0|[1-9]\d{0,5}) -->$/.test(value);
}

/** A body longer than this cannot hold a findings file within its own byte bound, so it is refused before any scan. */
const MAX_COMMENT_CHARS = MAX_OUTPUT_FILE_BYTES + 2_000;

const JSON_FENCE = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

/** True when the comment's first line is the marker and nothing else. */
function carriesMarker(body: string, marker: string): boolean {
  return body.trimStart().split('\n', 1)[0]?.trim() === marker;
}

/** The comments of a trusted author that carry `marker` on their first line. The one rule for "this comment counts". */
function keyedComments(candidates: readonly FindingsCandidate[], marker: string): FindingsCandidate[] {
  return candidates.filter((candidate) => candidate.trusted && carriesMarker(candidate.body, marker));
}

/** True when at least one trusted comment carries `marker`. The remote wait ends on this; the parse decides what it holds. */
export function hasFindingsComment(candidates: readonly FindingsCandidate[], marker: string): boolean {
  return keyedComments(candidates, marker).length > 0;
}

/** The first trusted comment that carries `marker` on its first line (the oldest, as the listing orders them), or undefined. Reads only. */
export function findKeyedComment(candidates: readonly FindingsCandidate[], marker: string): FindingsCandidate | undefined {
  return keyedComments(candidates, marker)[0];
}

/** True when `value` is a marker `findingsMarker` could have made. Round 0 is the first review, before any fixer round (#687). */
export function isFindingsMarker(value: string): boolean {
  return /^<!-- orchestrator-findings pr=[1-9]\d{0,9} head=[0-9a-f]{40} round=(?:0|[1-9]\d{0,5}) -->$/.test(value);
}

/** The JSON text of the one trusted comment that carries `marker`, with the ids of that comment. Refusals are as `parseFindingsComment`'s. */
function keyedJson(candidates: readonly FindingsCandidate[], marker: string, what: string): { readonly json: string; readonly id: number; readonly nodeId: string } {
  const ours = keyedComments(candidates, marker);
  const [only, ...rest] = ours;
  if (only === undefined) {
    throw new MalformedFindingsError(`no comment by a trusted author carries the ${what} marker (${candidates.length} comments read)`);
  }
  if (rest.length > 0) {
    throw new MalformedFindingsError(`${ours.length} comments by trusted authors carry the ${what} marker, and exactly one is expected`);
  }
  if (only.body.length > MAX_COMMENT_CHARS) {
    throw new FindingsTooLargeError(`the ${what} comment is longer than ${MAX_COMMENT_CHARS} characters`);
  }
  const blocks = [...only.body.matchAll(JSON_FENCE)];
  const [block, ...more] = blocks;
  if (block?.[1] === undefined) {
    throw new MalformedFindingsError(`the ${what} comment holds no fenced json block`);
  }
  if (more.length > 0) {
    throw new MalformedFindingsError(`the ${what} comment holds ${blocks.length} fenced json blocks, and exactly one is expected`);
  }
  return { json: block[1], id: only.id, nodeId: only.nodeId };
}

/**
 * The findings of the one trusted comment that carries `marker`. Throws `MalformedFindingsError` for no such comment,
 * more than one, no or several JSON blocks, or JSON that is not in the asked shape, and `FindingsTooLargeError` for a
 * comment or a file over a bound. A comment by an author who is not trusted is never looked at, even with the marker.
 */
export function parseFindingsComment(candidates: readonly FindingsCandidate[], marker: string): ParsedFindings {
  const found = keyedJson(candidates, marker, 'findings');
  return { output: parseReviewerOutput(found.json), commentId: found.id, commentNodeId: found.nodeId };
}

/** The replies of the one trusted comment that carries `marker`, through `parseFixerOutput`, with the same refusals as the findings. */
export function parseFixerRepliesComment(candidates: readonly FindingsCandidate[], marker: string): ParsedFixerReplies {
  const found = keyedJson(candidates, marker, 'fixer replies');
  return { output: parseFixerOutput(found.json), commentId: found.id, commentNodeId: found.nodeId };
}
