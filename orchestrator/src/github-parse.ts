// Parsers for what `gh` answers (foundations 4.2). Each turns an untyped answer into a precise value in one
// place, reads only the fields the activities use (extra keys pass, as GitHub adds them), and rejects a missing or
// mistyped field with a GhError that names the answer and the path of the first mismatch, never a value.
//
// Trust (CLAUDE.md "Untrusted GitHub content"): every parser that reads text written by someone else checks
// `author_association` first, and the text of an item from any author other than OWNER, MEMBER or COLLABORATOR is
// never read, copied or returned. The filter lives here, inside the listing parse, so no caller can forget it.

import type { FindingsCandidate } from './findings-comment.ts';
import { bodyOrigin } from './pr-template.ts';
import { GhError } from './gh.ts';
import type { BoardStatus, IssueComment, IssueView, ItemKind, ReviewThread } from './types.ts';

type Obj = ReadonlyMap<string, unknown>;

const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** A missing or unknown association is untrusted: the rule fails closed. */
export function isTrustedAssociation(raw: unknown): boolean {
  return typeof raw === 'string' && TRUSTED_ASSOCIATIONS.has(raw);
}

function mismatch(what: string, path: string): never {
  throw new GhError(`${what}: unexpected answer at ${path}`, 'malformed');
}

function obj(raw: unknown, what: string, path: string): Obj {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return mismatch(what, path);
  }
  return new Map(Object.entries(raw));
}

function list(raw: unknown, what: string, path: string): unknown[] {
  if (!Array.isArray(raw)) {
    return mismatch(what, path);
  }
  // Array.isArray narrows to any[]; the elements are still unknown to every caller.
  const items: unknown[] = raw;
  return items;
}

function str(from: Obj, key: string, what: string, path: string): string {
  const value = from.get(key);
  return typeof value === 'string' ? value : mismatch(what, `${path}.${key}`);
}

/** A string, or `''` when the answer has `null` or no such key (a missing issue body is `null`). */
function strOrEmpty(from: Obj, key: string, what: string, path: string): string {
  const value = from.get(key);
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : mismatch(what, `${path}.${key}`);
}

function optStr(from: Obj, key: string, what: string, path: string): string | undefined {
  const value = from.get(key);
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : mismatch(what, `${path}.${key}`);
}

function int(from: Obj, key: string, what: string, path: string): number {
  const value = from.get(key);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : mismatch(what, `${path}.${key}`);
}

function bool(from: Obj, key: string, what: string, path: string): boolean {
  const value = from.get(key);
  return typeof value === 'boolean' ? value : mismatch(what, `${path}.${key}`);
}

function login(from: Obj, key: string, what: string, path: string): string {
  return str(obj(from.get(key), what, `${path}.${key}`), 'login', what, `${path}.${key}`);
}

/** The elements of a list answer, each parsed by `parse`. An element `parse` answers `undefined` for is dropped. */
export function parseList<T>(
  raw: unknown,
  what: string,
  parse: (element: unknown, path: string) => T | undefined,
): { readonly items: T[]; readonly length: number } {
  const elements = list(raw, what, '$');
  const items: T[] = [];
  elements.forEach((element, index) => {
    const parsed = parse(element, `$[${index}]`);
    if (parsed !== undefined) {
      items.push(parsed);
    }
  });
  return { items, length: elements.length };
}

// ---- issues ---------------------------------------------------------------------------------------------------

export type IssueHead =
  | { readonly trusted: false }
  | { readonly trusted: true; readonly issue: Omit<IssueView, 'comments' | 'droppedUntrustedComments'> };

const WHAT_ISSUE = 'issue';

/** Reads the author's association before any text. An untrusted issue returns no text at all. */
export function parseIssueHead(raw: unknown, expectedNumber: number): IssueHead {
  const issue = obj(raw, WHAT_ISSUE, '$');
  if (!isTrustedAssociation(issue.get('author_association'))) {
    return { trusted: false };
  }
  if (issue.has('pull_request')) {
    return mismatch(WHAT_ISSUE, '$.pull_request (this is a pull request, not an issue)');
  }
  const number = int(issue, 'number', WHAT_ISSUE, '$');
  if (number !== expectedNumber) {
    return mismatch(WHAT_ISSUE, '$.number');
  }
  const state = str(issue, 'state', WHAT_ISSUE, '$');
  if (state !== 'open' && state !== 'closed') {
    return mismatch(WHAT_ISSUE, '$.state');
  }
  const labels = list(issue.get('labels'), WHAT_ISSUE, '$.labels').map((label, index) =>
    str(obj(label, WHAT_ISSUE, `$.labels[${index}]`), 'name', WHAT_ISSUE, `$.labels[${index}]`),
  );
  return {
    trusted: true,
    issue: {
      number,
      title: str(issue, 'title', WHAT_ISSUE, '$'),
      state,
      author: login(issue, 'user', WHAT_ISSUE, '$'),
      body: strOrEmpty(issue, 'body', WHAT_ISSUE, '$'),
      labels,
    },
  };
}

/** One comment of a listing, or `undefined` when its author is not trusted (the text is never read). */
export function parseComment(raw: unknown, path: string): IssueComment | undefined {
  const comment = obj(raw, 'issue comments', path);
  if (!isTrustedAssociation(comment.get('author_association'))) {
    return undefined;
  }
  return {
    id: int(comment, 'id', 'issue comments', path),
    author: login(comment, 'user', 'issue comments', path),
    createdAt: str(comment, 'created_at', 'issue comments', path),
    body: strOrEmpty(comment, 'body', 'issue comments', path),
  };
}

/**
 * One PR comment for the findings parser (#674). The body of an author who is not trusted is never read: the candidate
 * keeps its ids and `trusted: false` with an empty body, as a thread comment does.
 */
export function parseFindingsCandidate(raw: unknown, path: string): FindingsCandidate {
  const comment = obj(raw, 'pr comments', path);
  const trusted = isTrustedAssociation(comment.get('author_association'));
  return {
    id: int(comment, 'id', 'pr comments', path),
    nodeId: str(comment, 'node_id', 'pr comments', path),
    trusted,
    body: trusted ? strOrEmpty(comment, 'body', 'pr comments', path) : '',
  };
}

/** True when a `minimizeComment` answer shows the comment hidden. */
export function parseMinimized(raw: unknown): boolean {
  const data = obj(raw, 'minimizeComment', 'data');
  const result = data.get('minimizeComment');
  if (typeof result !== 'object' || result === null) {
    return false;
  }
  const minimized = (result as Record<string, unknown>)['minimizedComment'];
  return typeof minimized === 'object' && minimized !== null && (minimized as Record<string, unknown>)['isMinimized'] === true;
}

export interface Blocker {
  readonly number: number;
  readonly open: boolean;
}

export function parseBlocker(raw: unknown, path: string): Blocker {
  const issue = obj(raw, 'blocked-by list', path);
  const state = str(issue, 'state', 'blocked-by list', path);
  if (state !== 'open' && state !== 'closed') {
    return mismatch('blocked-by list', `${path}.state`);
  }
  return { number: int(issue, 'number', 'blocked-by list', path), open: state === 'open' };
}

// ---- the board ------------------------------------------------------------------------------------------------

export interface BoardItem {
  readonly number: number;
  /** The Status option's name, or undefined when the item has none. */
  readonly status: string | undefined;
}

/** The issues of `gh project item-list --format json`, for one repository. Other items are left out. */
export function parseBoardItems(raw: unknown, repo: string): { readonly items: BoardItem[]; readonly totalCount: number } {
  const what = 'board items';
  const root = obj(raw, what, '$');
  const totalCount = int(root, 'totalCount', what, '$');
  const items: BoardItem[] = [];
  list(root.get('items'), what, '$.items').forEach((element, index) => {
    const path = `$.items[${index}]`;
    const item = obj(element, what, path);
    const content = obj(item.get('content'), what, `${path}.content`);
    // Drafts and pull requests carry no issue number of ours.
    if (str(content, 'type', what, `${path}.content`) !== 'Issue') {
      return;
    }
    if (str(content, 'repository', what, `${path}.content`) !== repo) {
      return;
    }
    items.push({
      number: int(content, 'number', what, `${path}.content`),
      status: optStr(item, 'status', what, path),
    });
  });
  return { items, totalCount };
}

const BOARD_STATUSES: readonly BoardStatus[] = ['Backlog', 'Ready', 'In progress', 'Needs Input', 'In review', 'Done'];

export function parseBoardStatus(raw: string, what: string, path: string): BoardStatus {
  const status = BOARD_STATUSES.find((candidate) => candidate === raw);
  return status ?? mismatch(what, `${path} (an unknown Status option)`);
}

export type BoardLookup =
  | { readonly onBoard: false }
  | { readonly onBoard: true; readonly itemId: string; readonly status: BoardStatus | undefined };

/**
 * The Status of one issue's or PR's item on one project, from the `projectItems` GraphQL query. `undefined`: no such
 * issue or PR. The query asks `issue(number)` or `pullRequest(number)` by `kind`, and the answer is read under the
 * matching key, so an answer for the other kind is a mismatch, not a lookup.
 */
export function parseItemBoardStatus(
  data: unknown,
  kind: ItemKind,
  projectOwner: string,
  projectNumber: number,
): BoardLookup | undefined {
  const what = kind === 'pr' ? 'pull request board status' : 'issue board status';
  const key = kind === 'pr' ? 'pullRequest' : 'issue';
  const repository = obj(obj(data, what, '$').get('repository'), what, '$.repository');
  const itemRaw = repository.get(key);
  if (itemRaw === null) {
    return undefined;
  }
  const projectItems = obj(obj(itemRaw, what, `$.repository.${key}`).get('projectItems'), what, '$...projectItems');
  if (bool(obj(projectItems.get('pageInfo'), what, '$...pageInfo'), 'hasNextPage', what, '$...pageInfo')) {
    throw new GhError(`${what}: the item is on more projects than one page holds`, 'output_too_large');
  }
  for (const [index, element] of list(projectItems.get('nodes'), what, '$...nodes').entries()) {
    const path = `$...nodes[${index}]`;
    const node = obj(element, what, path);
    const project = obj(node.get('project'), what, `${path}.project`);
    const owner = obj(project.get('owner'), what, `${path}.project.owner`);
    if (project.get('number') !== projectNumber || owner.get('login') !== projectOwner) {
      continue;
    }
    const itemId = str(node, 'id', what, path);
    const value = node.get('fieldValueByName');
    if (value === null || value === undefined) {
      return { onBoard: true, itemId, status: undefined };
    }
    const name = str(obj(value, what, `${path}.fieldValueByName`), 'name', what, `${path}.fieldValueByName`);
    return { onBoard: true, itemId, status: parseBoardStatus(name, what, `${path}.fieldValueByName.name`) };
  }
  return { onBoard: false };
}

/**
 * Whether the REST answer for an issue or a PR (`issues/<n>` serves both) is by a trusted author and is the kind and
 * number asked for. No text of it is read: this is the check before an item is added to the board.
 */
export function parseItemAuthor(raw: unknown, kind: ItemKind, expectedNumber: number): { readonly trusted: boolean } {
  const what = kind === 'pr' ? 'pull request' : 'issue';
  const item = obj(raw, what, '$');
  if (!isTrustedAssociation(item.get('author_association'))) {
    return { trusted: false };
  }
  if (int(item, 'number', what, '$') !== expectedNumber) {
    return mismatch(what, '$.number');
  }
  // The issues route answers for a PR too, and marks it with `pull_request`.
  if (item.has('pull_request') !== (kind === 'pr')) {
    return mismatch(what, '$.pull_request (the number is not a ' + what + ')');
  }
  return { trusted: true };
}

// ---- branches and pull requests -------------------------------------------------------------------------------

/** The branch names of `git/matching-refs/heads/...`, without the `refs/heads/` prefix. */
export function parseRefName(raw: unknown, path: string): string {
  const ref = str(obj(raw, 'branches', path), 'ref', 'branches', path);
  const prefix = 'refs/heads/';
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : mismatch('branches', `${path}.ref`);
}

export interface OpenPr {
  readonly number: number;
  readonly url: string;
  readonly headRef: string;
  /** Issue numbers the description closes (`Closes #N`). The text itself is not kept. */
  readonly closes: readonly number[];
  /** Where the body came from (#707), read from its fixed fallback line. The text itself is not kept. */
  readonly bodyOrigin: 'fallback' | 'session' | 'unknown';
}

const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d{1,9})\b/gi;

/** An open pull request of a listing, or `undefined` when its author is not trusted. */
export function parseOpenPr(raw: unknown, path: string): OpenPr | undefined {
  const what = 'pull requests';
  const pr = obj(raw, what, path);
  if (!isTrustedAssociation(pr.get('author_association'))) {
    return undefined;
  }
  const head = obj(pr.get('head'), what, `${path}.head`);
  const body = strOrEmpty(pr, 'body', what, path);
  const closes = [...body.matchAll(CLOSING_KEYWORD)].map((match) => Number(match[1]));
  return {
    number: int(pr, 'number', what, path),
    url: str(pr, 'html_url', what, path),
    headRef: str(head, 'ref', what, `${path}.head`),
    closes,
    bodyOrigin: bodyOrigin(body),
  };
}

export interface CreatedPr {
  readonly number: number;
  readonly url: string;
}

export function parseCreatedPr(raw: unknown): CreatedPr {
  const pr = obj(raw, 'created pull request', '$');
  return { number: int(pr, 'number', 'created pull request', '$'), url: str(pr, 'html_url', 'created pull request', '$') };
}

// ---- reviews and the merge gate -------------------------------------------------------------------------------

export interface ReviewMarker {
  readonly id: number;
  readonly body: string;
}

/** A review of a listing, or `undefined` when its author is not trusted. */
export function parseReview(raw: unknown, path: string): ReviewMarker | undefined {
  const review = obj(raw, 'reviews', path);
  if (!isTrustedAssociation(review.get('author_association'))) {
    return undefined;
  }
  return { id: int(review, 'id', 'reviews', path), body: strOrEmpty(review, 'body', 'reviews', path) };
}

export function parseCreatedReviewId(raw: unknown): number {
  return int(obj(raw, 'created review', '$'), 'id', 'created review', '$');
}

/** The id of a comment GitHub just created. */
export function parseCreatedCommentId(raw: unknown): number {
  return int(obj(raw, 'created comment', '$'), 'id', 'created comment', '$');
}

export interface GateFacts {
  readonly headSha: string;
  readonly reviews: readonly {
    /** COMMENTED, APPROVED, CHANGES_REQUESTED, DISMISSED or PENDING. */
    readonly state: string;
    readonly body: string;
    readonly trusted: boolean;
    /** The commit the review is on. `undefined` when GitHub no longer has it. */
    readonly commitOid: string | undefined;
  }[];
  readonly unresolvedThreads: number;
}

const GATE_PAGE = 100;

export function parseGate(data: unknown): GateFacts | undefined {
  const what = 'merge gate';
  const repository = obj(obj(data, what, '$').get('repository'), what, '$.repository');
  const prRaw = repository.get('pullRequest');
  if (prRaw === null) {
    return undefined;
  }
  const pr = obj(prRaw, what, '$.repository.pullRequest');
  const headSha = str(pr, 'headRefOid', what, '$...pullRequest');

  const reviews = obj(pr.get('reviews'), what, '$...reviews');
  const threads = obj(pr.get('reviewThreads'), what, '$...reviewThreads');
  // A gate computed from a partial list could clear a PR that is not clear, so it fails instead.
  for (const [name, connection] of [['reviews', reviews], ['review threads', threads]] as const) {
    if (bool(obj(connection.get('pageInfo'), what, `$...${name}.pageInfo`), 'hasNextPage', what, `$...${name}.pageInfo`)) {
      throw new GhError(`${what}: the PR has more than ${GATE_PAGE} ${name}, so the gate cannot be counted`, 'output_too_large');
    }
  }

  const reviewFacts = list(reviews.get('nodes'), what, '$...reviews.nodes').map((element, index) => {
    const path = `$...reviews.nodes[${index}]`;
    const review = obj(element, what, path);
    const commit = review.get('commit');
    return {
      state: str(review, 'state', what, path),
      body: strOrEmpty(review, 'body', what, path),
      trusted: isTrustedAssociation(review.get('authorAssociation')),
      commitOid: commit === null || commit === undefined ? undefined : str(obj(commit, what, `${path}.commit`), 'oid', what, `${path}.commit`),
    };
  });
  const unresolvedThreads = list(threads.get('nodes'), what, '$...reviewThreads.nodes').filter(
    (element, index) => !bool(obj(element, what, `$...reviewThreads.nodes[${index}]`), 'isResolved', what, `$...reviewThreads.nodes[${index}]`),
  ).length;
  return { headSha, reviews: reviewFacts, unresolvedThreads };
}

// ---- review threads (#630) ------------------------------------------------------------------------------------

const THREAD_PAGE = 100;
const THREAD_COMMENT_PAGE = 30;
const THREAD_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * The unresolved review threads of a PR. The text of a comment by an author who is not an OWNER, MEMBER or COLLABORATOR
 * is never read: that comment keeps its id and `trusted: false`, with an empty body. A list or a thread with more
 * entries than one page reads fails instead of being cut, because a reply or a brief made from part of a thread could
 * miss the comment that matters.
 */
export function parseReviewThreads(data: unknown): ReviewThread[] | undefined {
  const what = 'review threads';
  const repository = obj(obj(data, what, '$').get('repository'), what, '$.repository');
  const prRaw = repository.get('pullRequest');
  if (prRaw === null) {
    return undefined;
  }
  const threads = obj(obj(prRaw, what, '$.repository.pullRequest').get('reviewThreads'), what, '$...reviewThreads');
  if (bool(obj(threads.get('pageInfo'), what, '$...reviewThreads.pageInfo'), 'hasNextPage', what, '$...reviewThreads.pageInfo')) {
    throw new GhError(`${what}: the PR has more than ${THREAD_PAGE} review threads`, 'output_too_large');
  }
  const result: ReviewThread[] = [];
  list(threads.get('nodes'), what, '$...reviewThreads.nodes').forEach((element, index) => {
    const path = `$...reviewThreads.nodes[${index}]`;
    const thread = obj(element, what, path);
    if (bool(thread, 'isResolved', what, path)) {
      return;
    }
    const id = str(thread, 'id', what, path);
    if (!THREAD_ID.test(id)) {
      mismatch(what, `${path}.id`);
    }
    const comments = obj(thread.get('comments'), what, `${path}.comments`);
    if (bool(obj(comments.get('pageInfo'), what, `${path}.comments.pageInfo`), 'hasNextPage', what, `${path}.comments.pageInfo`)) {
      throw new GhError(`${what}: a thread has more than ${THREAD_COMMENT_PAGE} comments`, 'output_too_large');
    }
    const parsed = list(comments.get('nodes'), what, `${path}.comments.nodes`).map((raw, at) => {
      const commentPath = `${path}.comments.nodes[${at}]`;
      const comment = obj(raw, what, commentPath);
      const trusted = isTrustedAssociation(comment.get('authorAssociation'));
      return {
        id: int(comment, 'databaseId', what, commentPath),
        trusted,
        body: trusted ? strOrEmpty(comment, 'body', what, commentPath) : '',
      };
    });
    const first = parsed[0];
    if (first === undefined) {
      mismatch(what, `${path}.comments.nodes`);
    }
    const line = thread.get('line');
    result.push({
      id,
      path: strOrEmpty(thread, 'path', what, path),
      line: typeof line === 'number' && Number.isSafeInteger(line) && line >= 0 ? line : null,
      trusted: first.trusted,
      comments: parsed,
    });
  });
  return result;
}

// ---- pull request state and files (#631) ------------------------------------------------------------------------

export interface PrState {
  /** `open` or `closed`. A merged PR is closed. */
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly headSha: string;
}

/** The state of one PR: flags and a SHA only. No title or body is read. */
export function parsePrState(raw: unknown, expectedNumber: number): PrState {
  const what = 'pull request';
  const pr = obj(raw, what, '$');
  if (int(pr, 'number', what, '$') !== expectedNumber) {
    return mismatch(what, '$.number');
  }
  const state = str(pr, 'state', what, '$');
  if (state !== 'open' && state !== 'closed') {
    return mismatch(what, '$.state');
  }
  const headSha = str(obj(pr.get('head'), what, '$.head'), 'sha', what, '$.head');
  return { state, merged: bool(pr, 'merged', what, '$'), headSha };
}

/** The paths of one changed file of a PR's listing: its name and, for a rename, the name it had. Repository paths only. */
export function parsePrFilePaths(raw: unknown, path: string): string[] {
  const file = obj(raw, 'pull request files', path);
  const previous = optStr(file, 'previous_filename', 'pull request files', path);
  return [str(file, 'filename', 'pull request files', path), ...(previous === undefined ? [] : [previous])];
}

/** True when a REST answer for an issue shows it closed. The state is read after the same trusted-author check. */
export function parseIssueClosed(raw: unknown, expectedNumber: number): boolean | undefined {
  const head = parseIssueHead(raw, expectedNumber);
  return head.trusted ? head.issue.state === 'closed' : undefined;
}

/** What one context shows on a commit: its state and the description it was posted with. */
export interface CommitStatusEntry {
  readonly state: string;
  readonly description: string;
}

/**
 * The combined status of a commit (`GET /repos/{repo}/commits/{sha}/status`), reduced to the entry of one context:
 * GitHub lists the latest status of each context there. `undefined` when the context has none. Only the context, state
 * and description of each entry are read. A list longer than one page is `output_too_large`, never a silent cut.
 */
export function parseCombinedStatus(raw: unknown, sha: string, context: string): CommitStatusEntry | undefined {
  const what = 'combined commit status';
  const combined = obj(raw, what, '$');
  if (str(combined, 'sha', what, '$') !== sha) {
    return mismatch(what, '$.sha');
  }
  const entries = list(combined.get('statuses'), what, '$.statuses');
  if (int(combined, 'total_count', what, '$') > entries.length) {
    throw new GhError(`${what}: more statuses than one call reads`, 'output_too_large');
  }
  let found: CommitStatusEntry | undefined;
  entries.forEach((element, index) => {
    const path = `$.statuses[${index}]`;
    const entry = obj(element, what, path);
    if (str(entry, 'context', what, path) === context) {
      found = { state: str(entry, 'state', what, path), description: strOrEmpty(entry, 'description', what, path) };
    }
  });
  return found;
}

// ---- reads of a remote session's progress (#672) --------------------------------------------------------------

/** The branch name and tip of one entry of `git/matching-refs/heads/...`. */
export function parseRefTip(raw: unknown, path: string): { readonly name: string; readonly sha: string } {
  const what = 'branches';
  const entry = obj(raw, what, path);
  const ref = str(entry, 'ref', what, path);
  const prefix = 'refs/heads/';
  if (!ref.startsWith(prefix)) {
    return mismatch(what, `${path}.ref`);
  }
  const sha = str(obj(entry.get('object'), what, `${path}.object`), 'sha', what, `${path}.object`);
  return /^[0-9a-f]{40}$/.test(sha) ? { name: ref.slice(prefix.length), sha } : mismatch(what, `${path}.object.sha`);
}

/**
 * Whether a commit has a check run that has not completed, or a pending commit status. Only statuses and counts are
 * read. A list longer than one page is `output_too_large`, never a silent cut.
 */
export function parseChecksPending(checkRuns: unknown, combined: unknown, sha: string): boolean {
  const runsWhat = 'check runs';
  const runs = obj(checkRuns, runsWhat, '$');
  const runList = list(runs.get('check_runs'), runsWhat, '$.check_runs');
  if (int(runs, 'total_count', runsWhat, '$') > runList.length) {
    throw new GhError(`${runsWhat}: more runs than one call reads`, 'output_too_large');
  }
  const anyRunPending = runList.some((element, index) => str(obj(element, runsWhat, `$.check_runs[${index}]`), 'status', runsWhat, `$.check_runs[${index}]`) !== 'completed');
  const statusWhat = 'combined commit status';
  const status = obj(combined, statusWhat, '$');
  if (str(status, 'sha', statusWhat, '$') !== sha) {
    return mismatch(statusWhat, '$.sha');
  }
  // GitHub answers `pending` for a commit with no statuses at all, so the count decides.
  const statusPending = int(status, 'total_count', statusWhat, '$') > 0 && str(status, 'state', statusWhat, '$') === 'pending';
  return anyRunPending || statusPending;
}

/**
 * The commit a review of a listing is on, when the review counts for the merge gate's purposes: a trusted author, a
 * state that is a verdict (not PENDING or DISMISSED) and a body. `undefined` for any other.
 */
export function parseReviewCommit(raw: unknown, path: string): string | undefined {
  const review = obj(raw, 'reviews', path);
  if (!isTrustedAssociation(review.get('author_association'))) {
    return undefined;
  }
  const state = str(review, 'state', 'reviews', path);
  if (state !== 'COMMENTED' && state !== 'APPROVED' && state !== 'CHANGES_REQUESTED') {
    return undefined;
  }
  if (strOrEmpty(review, 'body', 'reviews', path).trim() === '') {
    return undefined;
  }
  return optStr(review, 'commit_id', 'reviews', path);
}
