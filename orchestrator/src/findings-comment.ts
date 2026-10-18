// The remote reviewer's findings comment (#674, plan #643 open question 3, option b). A remote reviewer cannot hand text
// to the worker, and posting its own review would skip the sanitiser, so it writes its findings as JSON into ONE keyed
// comment. This file turns the PR's comments into the same typed `ReviewerOutput` the local path reads from a file.
//
// The comment is untrusted input (foundations 4.2): it is read only from an author the repo trusts (a `trusted` flag the
// listing set from `author_association`), it counts only with the marker for this PR, head and round on its first line,
// and exactly one such comment with exactly one fenced JSON block must exist. Anything else is a refusal with counts, not
// a partial result. The JSON itself goes through `parseReviewerOutput`, the parser the local path uses, which bounds the
// size, checks the shape and cleans the text. No message here quotes comment text.

import { MAX_OUTPUT_FILE_BYTES, FindingsTooLargeError, MalformedFindingsError, parseReviewerOutput } from './review-types.ts';
import type { ReviewerOutput } from './review-types.ts';

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

/** The key the reviewer's comment starts with. It names the PR, the exact head and the round, so an old comment never matches a new head. */
export function findingsMarker(pr: number, headSha: string, round: number): string {
  return `<!-- orchestrator-findings pr=${pr} head=${headSha} round=${round} -->`;
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

/** True when `value` is a marker `findingsMarker` could have made. */
export function isFindingsMarker(value: string): boolean {
  return /^<!-- orchestrator-findings pr=[1-9]\d{0,9} head=[0-9a-f]{40} round=[1-9]\d{0,5} -->$/.test(value);
}

/**
 * The findings of the one trusted comment that carries `marker`. Throws `MalformedFindingsError` for no such comment,
 * more than one, no or several JSON blocks, or JSON that is not in the asked shape, and `FindingsTooLargeError` for a
 * comment or a file over its bound. A comment by an author who is not trusted is never looked at, even with the marker.
 */
export function parseFindingsComment(candidates: readonly FindingsCandidate[], marker: string): ParsedFindings {
  const ours = keyedComments(candidates, marker);
  const [only, ...rest] = ours;
  if (only === undefined) {
    throw new MalformedFindingsError(`no comment by a trusted author carries the findings marker (${candidates.length} comments read)`);
  }
  if (rest.length > 0) {
    throw new MalformedFindingsError(`${ours.length} comments by trusted authors carry the findings marker, and exactly one is expected`);
  }
  if (only.body.length > MAX_COMMENT_CHARS) {
    throw new FindingsTooLargeError(`the findings comment is longer than ${MAX_COMMENT_CHARS} characters`);
  }
  const blocks = [...only.body.matchAll(JSON_FENCE)];
  const [block, ...more] = blocks;
  if (block?.[1] === undefined) {
    throw new MalformedFindingsError('the findings comment holds no fenced json block');
  }
  if (more.length > 0) {
    throw new MalformedFindingsError(`the findings comment holds ${blocks.length} fenced json blocks, and exactly one is expected`);
  }
  return { output: parseReviewerOutput(block[1]), commentId: only.id, commentNodeId: only.nodeId };
}
