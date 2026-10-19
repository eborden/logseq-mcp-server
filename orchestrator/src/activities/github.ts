// The GitHub activities of the orchestrator (#628, parent plan #625): thin wrappers over `gh` (src/gh.ts) that
// carry the repo's trust and rate-limit rules in code, not prose (CLAUDE.md "Untrusted GitHub content", "Board
// statuses", "GitHub rate limits", "Code review" step 5).
//
// What they never do, by construction: merge, apply a label (`golden-change` included), move a board item into
// Ready or out of Backlog (one exception: a PR's own first move, Backlog to In review, #635), or resolve a review
// thread. The board writes are `addToBoard` (an item is added, nothing else) and `setStatus` to In progress, In
// review or Done, and the only GraphQL here is read-only.
//
// Activities run at least once (foundations 4.5), so every write checks first and a repeat does nothing:
// - `claimIssue` and `setStatus` read the item's Status and write only when it differs. `setStatus` then reads the
//   board again and fails if it does not show the new Status.
// - `addToBoard` reads the board first and adds only an item that is not on it.
// - `openPr` looks for an open PR with the same head and base before it creates one.
// - `postReview` looks for a review that carries its idempotency key before it posts one.
// A write whose answer was lost (a timeout, a killed worker) is found by the next attempt's read.
//
// Inputs arrive from workflow code as untyped JSON, so each activity parses its input first. A bad input is a
// non-retryable `InvalidInput` failure; an untrusted issue author is `UntrustedAuthor`; `gh` output that does not
// match is `MalformedGhOutput`; a rate-limit wait too long to sit through is `GitHubRateLimitTooLong`.

import { ApplicationFailure, Context } from '@temporalio/activity';
import { BOARD_RE_READS, BOARD_RE_READ_DELAY_MS } from '../board-policy.ts';
import { GhCli, GhError, defaultGhDeps } from '../gh.ts';
import type { GhDeps } from '../gh.ts';
import type { GhConfig } from '../gh-config.ts';
import {
  parseBlocker,
  parseBoardItems,
  parseChecksPending,
  parseCombinedStatus,
  parseComment,
  parseCreatedCommentId,
  parseCreatedPr,
  parseCreatedReviewId,
  parseFindingsCandidate,
  parseGate,
  parseIssueHead,
  parseItemAuthor,
  parseIssueClosed,
  parseItemBoardStatus,
  parseList,
  parseMinimized,
  parseOpenPr,
  parsePrFilePaths,
  parsePrState,
  parseRefName,
  parseRefTip,
  parseReview,
  parseReviewCommit,
  parseReviewThreads,
} from '../github-parse.ts';
import type { BoardLookup, OpenPr } from '../github-parse.ts';
import { findKeyedComment, findNeedsInputAnswer, hasFindingsComment } from '../findings-comment.ts';
import type { FindingsCandidate } from '../findings-comment.ts';
import type { RemoteGithub } from './remote-session.ts';
import {
  HOST_INTEGRATION_CONTEXT,
  HOST_STATUS_STATES,
  InvalidHostStatusError,
  buildHostDescription,
  needsHostIntegration,
  parseHostDescription,
  parseHostSha,
  parseHostStatusInput,
} from '../integration-policy.ts';
import type { HostIntegrationState } from '../integration-policy.ts';
import { UNCLASSIFIED_CHANGES, classifyChangedPaths } from '../approval-types.ts';
import type { SensitiveChanges } from '../approval-types.ts';
import type { HostIntegrationNeed, HostIntegrationResult, PostCommitStatusInput, PostCommitStatusResult } from '../github-policy.ts';
import type {
  AddToBoardResult,
  BoardItemRef,
  BoardStatusResult,
  BoardTarget,
  ClaimResult,
  CloseIssueResult,
  CommentIssueInput,
  CommentIssueResult,
  GateStatus,
  NeedsInputWaitInput,
  NeedsInputWaitResult,
  IssueCheck,
  IssueView,
  ItemKind,
  OpenPrInput,
  OpenPrResult,
  PrStateResult,
  PostReviewInput,
  PostReviewResult,
  ReadyIssues,
  ReplyToThreadInput,
  ReplyToThreadResult,
  ReviewComment,
  ReviewThread,
  SetStatusResult,
  SettableStatus,
} from '../types.ts';

const PAGE_SIZE = 100;
/** Most pages of one list. A longer list fails instead of being cut (BR-0006's rule, applied here). */
const MAX_PAGES = 10;
/** Most Ready items one call looks at. Each costs one request for its blockers. */
const MAX_READY_ITEMS = 50;
const MAX_TEXT_CHARS = 60_000;
const MAX_REVIEW_COMMENTS = 100;
const HEARTBEAT_SLICE_MS = 5_000;

const SETTABLE: readonly SettableStatus[] = ['In progress', 'Needs Input', 'In review', 'Done'];
/** The moves `setStatus` makes for an issue: from a status to the one next step it may take. */
const ISSUE_MOVES: ReadonlyMap<string, readonly SettableStatus[]> = new Map<string, readonly SettableStatus[]>([
  // A run that waits for a person's answer parks the item in Needs Input and moves it back when the answer arrives (#698).
  ['In progress', ['In review', 'Needs Input']],
  // In review as well, so a skipped move back (a board fault never fails a run) cannot strand the run at board_issue.
  ['Needs Input', ['In progress', 'In review']],
  ['In review', ['Done']],
]);
/**
 * What a PR may do that an issue may not, and the only difference. A PR is added to the board in Backlog (the board's
 * default, which nothing here changes), and it never passes through Ready or In progress: its first move is Backlog
 * to In review. For an issue that same move is the maintainer's (Backlog to Ready is a gate), so it stays refused.
 */
const PR_ONLY_MOVES: ReadonlyMap<string, readonly SettableStatus[]> = new Map<string, readonly SettableStatus[]>([['Backlog', ['In review']]]);
/** A PR never waits for an answer: it keeps the two moves it had before Needs Input existed. */
const PR_SHARED_MOVES: ReadonlyMap<string, readonly SettableStatus[]> = new Map<string, readonly SettableStatus[]>([
  ['In progress', ['In review']],
  ['In review', ['Done']],
]);
/** The moves by kind, keyed by the item's current status. A PR has the shared moves plus its own first move. */
const ALLOWED_MOVES: ReadonlyMap<ItemKind, ReadonlyMap<string, readonly SettableStatus[]>> = new Map<ItemKind, ReadonlyMap<string, readonly SettableStatus[]>>([
  ['issue', ISSUE_MOVES],
  ['pr', new Map<string, readonly SettableStatus[]>([...PR_ONLY_MOVES, ...PR_SHARED_MOVES])],
]);

function allowedMovesText(kind: ItemKind): string {
  const moves = [...(ALLOWED_MOVES.get(kind) ?? [])].flatMap(([from, targets]) => targets.map((to) => `${from} to ${to}`));
  const last = moves.pop();
  return moves.length === 0 ? (last ?? 'nothing') : `${moves.join(', ')} and ${last ?? ''}`;
}

function describeItem(item: BoardItemRef): string {
  return `${item.kind === 'pr' ? 'pull request' : 'issue'} #${item.number}`;
}

function itemUrl(repo: string, item: BoardItemRef): string {
  return `https://github.com/${repo}/${item.kind === 'pr' ? 'pull' : 'issues'}/${item.number}`;
}

export type RefusalType = 'InvalidInput' | 'UntrustedAuthor' | 'InvalidState' | 'NotFound';

/**
 * The board does not show what a write should have made of it (a move that did not stick, an add that is not
 * there) even after BOARD_RE_READS re-reads inside the attempt (src/board-policy.ts). Retryable on purpose: the next
 * attempt reads the board again and only writes what is still missing, and a board that never shows the change
 * exhausts BOARD_ACTIVITY_MAX_ATTEMPTS, which the workflow sets as the retry policy, and fails the step. It never
 * claims a move that the board did not show.
 */
export class BoardReadbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardReadbackError';
  }
}

/** A refusal retrying cannot fix. It becomes a non-retryable failure. */
export class GithubRefusal extends Error {
  readonly type: RefusalType;

  constructor(type: RefusalType, message: string) {
    super(message);
    this.name = 'GithubRefusal';
    this.type = type;
  }
}

// ---- input parsing --------------------------------------------------------------------------------------------

function refuse(message: string): never {
  throw new GithubRefusal('InvalidInput', message);
}

function parseIssueNumber(raw: unknown, name: string): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1 && raw <= 999_999_999
    ? raw
    : refuse(`${name} must be a positive whole number`);
}

function inputObject(raw: unknown, name: string): ReadonlyMap<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return refuse(`${name} must be an object`);
  }
  return new Map(Object.entries(raw));
}

function inputText(from: ReadonlyMap<string, unknown>, key: string, pattern: RegExp | undefined, max: number): string {
  const value = from.get(key);
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || (pattern !== undefined && !pattern.test(value))) {
    return refuse(`${key} must be a non-empty string${pattern === undefined ? '' : ' of the expected form'} of at most ${max} characters`);
  }
  return value;
}

function parseSettableStatus(raw: unknown): SettableStatus {
  const status = SETTABLE.find((candidate) => candidate === raw);
  // Ready is absent on purpose: a move into Ready is the maintainer's.
  return status ?? refuse(`status must be one of ${SETTABLE.join(', ')}`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A board item named as a bare number (an issue), a `{ kind, number }`, or the URL of an issue or PR of the
 * configured repository. Any other URL (another repository, a comment link, a query string) is refused.
 */
function parseItemRef(raw: unknown, repo: string, name: string): BoardItemRef {
  if (typeof raw === 'number') {
    return { kind: 'issue', number: parseIssueNumber(raw, name) };
  }
  if (typeof raw === 'string') {
    const match = new RegExp(`^https://github\\.com/${escapeRegExp(repo)}/(issues|pull)/([1-9]\\d{0,8})$`).exec(raw);
    if (match === null) {
      return refuse(`${name} must be an issue or pull request URL of ${repo}`);
    }
    return { kind: match[1] === 'pull' ? 'pr' : 'issue', number: Number(match[2]) };
  }
  const input = inputObject(raw, name);
  const kind = input.get('kind');
  if (kind !== 'issue' && kind !== 'pr') {
    return refuse(`${name}.kind must be issue or pr`);
  }
  return { kind, number: parseIssueNumber(input.get('number'), `${name}.number`) };
}

const HEAD = /^claude\/\d{1,9}(?:-[A-Za-z0-9._-]{1,100})?$/;
/** Review states that count toward the gate. PENDING (an unsubmitted draft) and DISMISSED do not. */
const COUNTED_REVIEW_STATES: ReadonlySet<string> = new Set(['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED']);

const BASE = /^[A-Za-z0-9._/-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const KEY = /^[A-Za-z0-9._-]{1,100}$/;

/** Runs a policy parser (src/integration-policy.ts) and turns its refusal into a non-retryable `InvalidInput`. */
function parsedHostInput<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof InvalidHostStatusError) {
      return refuse(error.message);
    }
    throw error;
  }
}

function parseOpenPrInput(raw: unknown): OpenPrInput {
  const input = inputObject(raw, 'openPr input');
  return {
    head: inputText(input, 'head', HEAD, 200),
    base: inputText(input, 'base', BASE, 100),
    title: inputText(input, 'title', /^[^\r\n]+$/, 256),
    body: inputText(input, 'body', undefined, MAX_TEXT_CHARS),
  };
}

function parseCommentIssueInput(raw: unknown): CommentIssueInput {
  const input = inputObject(raw, 'commentIssue input');
  return {
    issue: parseIssueNumber(input.get('issue'), 'issue'),
    key: inputText(input, 'key', KEY, 100),
    body: inputText(input, 'body', undefined, MAX_TEXT_CHARS),
  };
}

function parseNeedsInputWaitInput(raw: unknown): NeedsInputWaitInput {
  const input = inputObject(raw, 'waitForNeedsInputAnswer input');
  const bounded = (key: string, min: number, max: number): number => {
    const value = input.get(key);
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : refuse(`${key} must be a whole number from ${min} to ${max}`);
  };
  return {
    issue: parseIssueNumber(input.get('issue'), 'issue'),
    afterCommentId: parseIssueNumber(input.get('afterCommentId'), 'afterCommentId'),
    waitMs: bounded('waitMs', 0, 24 * 60 * 60_000),
    pollMs: bounded('pollMs', 1, 24 * 60 * 60_000),
  };
}

function parseReviewComment(raw: unknown, index: number): ReviewComment {
  const comment = inputObject(raw, `comments[${index}]`);
  const line = comment.get('line');
  const side = comment.get('side') ?? 'RIGHT';
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) {
    return refuse(`comments[${index}].line must be a positive whole number`);
  }
  if (side !== 'LEFT' && side !== 'RIGHT') {
    return refuse(`comments[${index}].side must be LEFT or RIGHT`);
  }
  return { path: inputText(comment, 'path', undefined, 1024), line, side, body: inputText(comment, 'body', undefined, MAX_TEXT_CHARS) };
}

function parsePostReviewInput(raw: unknown): PostReviewInput {
  const input = inputObject(raw, 'postReview input');
  const comments = input.get('comments') ?? [];
  if (!Array.isArray(comments) || comments.length > MAX_REVIEW_COMMENTS) {
    return refuse(`comments must be a list of at most ${MAX_REVIEW_COMMENTS}`);
  }
  const elements: unknown[] = comments;
  return {
    pr: parseIssueNumber(input.get('pr'), 'pr'),
    commitId: inputText(input, 'commitId', SHA, 40),
    idempotencyKey: inputText(input, 'idempotencyKey', KEY, 100),
    // The gate counts only reviews with a body, so a review without one is refused here.
    body: inputText(input, 'body', undefined, MAX_TEXT_CHARS),
    comments: elements.map(parseReviewComment),
  };
}

// ---- the activities -------------------------------------------------------------------------------------------

/** The board items of an issue or of a PR (`issue(number)` and `pullRequest(number)` both carry `projectItems`). Read-only. */
function boardQuery(kind: ItemKind): string {
  return (
    'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){' +
    `${kind === 'pr' ? 'pullRequest' : 'issue'}(number:$number){` +
    'projectItems(first:20){pageInfo{hasNextPage} nodes{id project{number owner{... on User{login} ... on Organization{login}}} ' +
    'fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}'
  );
}

// The query of CLAUDE.md "Code review" step 5, with the review's state and author association added (a PENDING draft
// or a DISMISSED review, or a stranger's review, must not clear the gate; the step 5 query has that gap too), and a page-info flag so a PR with more than 100 reviews or threads fails instead of
// being counted from part of its list.
const GATE_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){' +
  'headRefOid reviews(first:100){pageInfo{hasNextPage} nodes{state body authorAssociation commit{oid}}} ' +
  'reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}}}}';

// The unresolved threads with their comments, read only (#630). Not the merge gate's query: this one carries text.
const THREADS_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){' +
  'reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved path line ' +
  'comments(first:30){pageInfo{hasNextPage} nodes{databaseId authorAssociation body}}}}}}}';

const THREAD_ID = /^[A-Za-z0-9_-]{1,80}$/;

// Hides one comment as outdated (#674). The comment stays readable behind "show", and hiding it twice is a no-op, so a retry is safe.
const MINIMIZE_MUTATION = 'mutation($id:ID!){minimizeComment(input:{subjectId:$id,classifier:OUTDATED}){minimizedComment{isMinimized}}}';
const NODE_ID = /^[A-Za-z0-9_=-]{1,100}$/;

function parseReplyInput(raw: unknown): ReplyToThreadInput {
  const input = inputObject(raw, 'replyToThread input');
  return {
    pr: parseIssueNumber(input.get('pr'), 'pr'),
    threadId: inputText(input, 'threadId', THREAD_ID, 80),
    key: inputText(input, 'key', KEY, 100),
    body: inputText(input, 'body', undefined, MAX_TEXT_CHARS),
  };
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner = '', name = ''] = repo.split('/');
  return { owner, name };
}

/** The operations, bound to one `gh` wrapper. Each attempt of an activity gets its own, so its rate-limit waits are counted per attempt. */
function operations(config: GhConfig, gh: GhCli, sleep: (ms: number) => Promise<void>) {
  const { owner, name } = splitRepo(config.repo);
  const repoRoute = `repos/${config.repo}`;

  /** Every element of a paginated list, each parsed by `parse` (which drops what it answers `undefined` for). */
  async function listAll<T>(
    route: string,
    what: string,
    parse: (element: unknown, path: string) => T | undefined,
  ): Promise<{ items: T[]; dropped: number }> {
    const items: T[] = [];
    let dropped = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = route.includes('?') ? '&' : '?';
      const parsed = parseList(await gh.api(`${route}${separator}per_page=${PAGE_SIZE}&page=${page}`), what, parse);
      items.push(...parsed.items);
      dropped += parsed.length - parsed.items.length;
      if (parsed.length < PAGE_SIZE) {
        return { items, dropped };
      }
    }
    throw new GhError(`${what}: more than ${MAX_PAGES * PAGE_SIZE} entries, which is more than one call reads`, 'output_too_large');
  }

  async function boardLookup(item: BoardItemRef): Promise<BoardLookup> {
    const data = await gh.graphql(boardQuery(item.kind), { owner, name, number: item.number });
    const lookup = parseItemBoardStatus(data, item.kind, config.projectOwner, config.projectNumber);
    if (lookup === undefined) {
      throw new GithubRefusal('NotFound', `${describeItem(item)} does not exist`);
    }
    return lookup;
  }

  /**
   * Reads the board (or starts from `first`, a read the caller already made), and while `settled` does not hold re-reads it up to BOARD_RE_READS more times, waiting
   * BOARD_RE_READ_DELAY_MS before each (the activity's sleep: it heartbeats and stops on cancellation). The last
   * read is returned whether or not it settled, so the caller says what the board showed. GitHub Projects can show
   * a stale Status right after a write, and a new item's default Status comes from a board workflow a moment after
   * the add.
   */
  async function readUntil(item: BoardItemRef, settled: (lookup: BoardLookup) => boolean, first?: BoardLookup): Promise<BoardLookup> {
    let lookup = first ?? (await boardLookup(item));
    for (let reread = 0; reread < BOARD_RE_READS && !settled(lookup); reread += 1) {
      await sleep(BOARD_RE_READ_DELAY_MS);
      lookup = await boardLookup(item);
    }
    return lookup;
  }

  async function moveTo(item: BoardItemRef, status: SettableStatus): Promise<void> {
    await gh.project([
      'item-edit',
      String(config.projectNumber),
      '--owner',
      config.projectOwner,
      '--url',
      itemUrl(config.repo, item),
      '--field',
      'Status',
      '--value',
      status,
    ]);
  }

  async function openPrsFor(issue: number): Promise<OpenPr[]> {
    const { items } = await listAll(`${repoRoute}/pulls?state=open`, 'pull requests', parseOpenPr);
    const branch = new RegExp(`^claude/${issue}(?:-|$)`);
    return items.filter((pr) => branch.test(pr.headRef) || pr.closes.includes(issue));
  }

  async function claudeBranchesFor(issue: number): Promise<string[]> {
    const { items } = await listAll(`${repoRoute}/git/matching-refs/heads/claude/${issue}`, 'branches', parseRefName);
    const branch = new RegExp(`^claude/${issue}(?:-|$)`);
    return items.filter((candidate) => branch.test(candidate));
  }

  /** The tip of one branch on the remote, or undefined when it does not exist. The name is validated by the caller. */
  async function branchTip(branch: string): Promise<string | undefined> {
    const { items } = await listAll(`${repoRoute}/git/matching-refs/heads/${branch}`, 'branches', parseRefTip);
    return items.find((entry) => entry.name === branch)?.sha;
  }

  async function checksPending(sha: string): Promise<boolean> {
    const checkRuns = await gh.api(`${repoRoute}/commits/${sha}/check-runs?per_page=${PAGE_SIZE}`);
    const combined = await gh.api(`${repoRoute}/commits/${sha}/status?per_page=${PAGE_SIZE}`);
    return parseChecksPending(checkRuns, combined, sha);
  }

  async function reviewedOnHead(pr: number, sha: string): Promise<boolean> {
    const { items } = await listAll(`${repoRoute}/pulls/${pr}/reviews`, 'reviews', parseReviewCommit);
    return items.includes(sha);
  }

  async function listReadyIssues(): Promise<ReadyIssues> {
    const raw = await gh.projectJson([
      'item-list',
      String(config.projectNumber),
      '--owner',
      config.projectOwner,
      '--format',
      'json',
      '--limit',
      String(MAX_READY_ITEMS),
      '--query',
      'status:Ready',
    ]);
    const { items, totalCount } = parseBoardItems(raw, config.repo);
    if (totalCount > MAX_READY_ITEMS) {
      throw new GhError(`board items: ${totalCount} items match, more than the ${MAX_READY_ITEMS} one call reads`, 'output_too_large');
    }
    const ready: number[] = [];
    const blocked: { number: number; openBlockers: number[] }[] = [];
    // Sequential on purpose: at most MAX_READY_ITEMS requests, one after another.
    for (const item of items) {
      if (item.status !== 'Ready') {
        continue;
      }
      const { items: blockers } = await listAll(
        `${repoRoute}/issues/${item.number}/dependencies/blocked_by`,
        'blocked-by list',
        parseBlocker,
      );
      const openBlockers = blockers.filter((blocker) => blocker.open).map((blocker) => blocker.number);
      if (openBlockers.length === 0) {
        ready.push(item.number);
      } else {
        blocked.push({ number: item.number, openBlockers });
      }
    }
    return { ready, blocked };
  }

  async function readIssue(raw: unknown): Promise<IssueView> {
    const number = parseIssueNumber(raw, 'issue');
    const head = parseIssueHead(await gh.api(`${repoRoute}/issues/${number}`), number);
    if (!head.trusted) {
      // The body of an untrusted issue is data, never read (CLAUDE.md "Untrusted GitHub content").
      throw new GithubRefusal('UntrustedAuthor', `issue #${number} was not written by an OWNER, MEMBER or COLLABORATOR, so it is not read`);
    }
    // The author filter runs inside the listing parse: an untrusted comment's text is never read.
    const comments = await listAll(`${repoRoute}/issues/${number}/comments`, 'issue comments', parseComment);
    return { ...head.issue, comments: comments.items, droppedUntrustedComments: comments.dropped };
  }

  /**
   * The read of an issue the workflow makes before it claims one: the same trusted-only read as `readIssue`, answered
   * as numbers and flags. The workflow records every result in its history, so the text stays out of it.
   */
  async function checkIssue(raw: unknown): Promise<IssueCheck> {
    const issue = await readIssue(raw);
    return {
      number: issue.number,
      open: issue.state === 'open',
      trustedComments: issue.comments.length,
      droppedUntrustedComments: issue.droppedUntrustedComments,
    };
  }

  /**
   * Moves a Ready item to In progress, unless a PR or a `claude/` branch for it exists. Read, then write.
   *
   * What the workflow (#629) must do with the answer: carry on when `proceed` is true, never when only `claimed` is
   * false. A retry of a claim that already moved the item (the worker died before the result was recorded) reads In
   * progress and answers `claimed: false, reason: 'already_in_progress', proceed: true`. Ownership is not decided
   * here: two concurrent claims can both answer `claimed: true`. The workflow ID decides it, so #629 must start one
   * workflow per issue with a deterministic ID (from the issue number) and a reuse policy that rejects duplicates.
   */
  async function claimIssue(raw: unknown): Promise<ClaimResult> {
    const issue = parseIssueNumber(raw, 'issue');
    const item: BoardItemRef = { kind: 'issue', number: issue };
    const lookup = await boardLookup(item);
    if (!lookup.onBoard) {
      throw new GithubRefusal('InvalidState', `issue #${issue} is not on the board`);
    }
    if (lookup.status === 'In progress') {
      return { claimed: false, reason: 'already_in_progress', proceed: true };
    }
    if (lookup.status === 'In review' || lookup.status === 'Done') {
      return { claimed: false, reason: 'already_past_in_progress', proceed: false };
    }
    if (lookup.status !== 'Ready') {
      // Backlog to anything is the maintainer's move, and so is an item with no status.
      throw new GithubRefusal('InvalidState', `issue #${issue} is not Ready (${lookup.status ?? 'no status'}), so it is not claimed`);
    }
    if ((await openPrsFor(issue)).length > 0) {
      return { claimed: false, reason: 'open_pr', proceed: false };
    }
    if ((await claudeBranchesFor(issue)).length > 0) {
      return { claimed: false, reason: 'claude_branch', proceed: false };
    }
    await moveTo(item, 'In progress');
    return { claimed: true, reason: 'claimed', proceed: true };
  }

  /**
   * Adds an issue or a PR to the board, unless it is already there. Read, then write, then read again.
   *
   * The first read makes a repeat a no-op that touches nothing, not even the item's Status (`gh project item-add`
   * is idempotent itself, but a repeat must not depend on that, and the read tells `added` truthfully). The author
   * check runs only before a write: an item by anyone but an OWNER, MEMBER or COLLABORATOR is not put on the board,
   * and its text is never read. The read after the add fails (retryably) if the board does not show the item, so a
   * workflow never carries on with an item that is not there. The Status of a new item is whatever the board's own
   * default gives it (Backlog for a PR); this activity never sets it.
   */
  async function addToBoard(raw: unknown): Promise<AddToBoardResult> {
    const item = parseItemRef(raw, config.repo, 'url');
    const before = await boardLookup(item);
    if (before.onBoard) {
      return { ...item, itemId: before.itemId, added: false, status: before.status ?? null };
    }
    const head = parseItemAuthor(await gh.api(`${repoRoute}/issues/${item.number}`), item.kind, item.number);
    if (!head.trusted) {
      throw new GithubRefusal('UntrustedAuthor', `${describeItem(item)} was not written by an OWNER, MEMBER or COLLABORATOR, so it is not added to the board`);
    }
    await gh.project(['item-add', String(config.projectNumber), '--owner', config.projectOwner, '--url', itemUrl(config.repo, item)]);
    // Wait (bounded) for the item and for its default Status. A Status that never shows is answered as `null`, not
    // failed: the item is on the board, and `setStatus` waits for a Status again before it refuses.
    const after = await readUntil(item, (lookup) => lookup.onBoard && lookup.status !== undefined);
    if (!after.onBoard) {
      throw new BoardReadbackError(`${describeItem(item)} was added to the board but the board does not show it`);
    }
    return { ...item, itemId: after.itemId, added: true, status: after.status ?? null };
  }

  /** The Status the board shows for an issue or a PR: a read, so a workflow can verify a move instead of assuming it. */
  async function getBoardStatus(raw: unknown): Promise<BoardStatusResult> {
    const item = parseItemRef(raw, config.repo, 'url');
    const lookup = await boardLookup(item);
    return { ...item, onBoard: lookup.onBoard, status: lookup.onBoard ? (lookup.status ?? null) : null };
  }

  /**
   * Moves an issue or a PR one step, then reads the board again and fails unless it shows the status asked for.
   *
   * Which moves: `ALLOWED_MOVES` by kind. An issue makes In progress to In review, In progress to Needs Input and back (#698, a run waiting for an answer), Needs Input to In review (a skipped move back must not strand the run) and In review to Done. A PR makes
   * those two and, as its own first move, Backlog to In review (a PR is added in Backlog and never goes through
   * Ready or In progress). Ready is never a target (a move into Ready is the maintainer's), Backlog is never one
   * either, nothing moves out of Done or back, and a skipped step (Backlog to Done) is refused. A repeat finds the
   * status already set and writes nothing. A bare number means an issue, as before #635.
   */
  async function setStatus(rawTarget: unknown, rawStatus: unknown): Promise<SetStatusResult> {
    const item = parseItemRef(rawTarget, config.repo, 'item');
    const status = parseSettableStatus(rawStatus);
    // A new item's default Status can arrive a moment after the add, so wait (bounded) for one before refusing.
    const first = await boardLookup(item);
    const lookup = first.onBoard && first.status === undefined ? await readUntil(item, (read) => !read.onBoard || read.status !== undefined, first) : first;
    if (!lookup.onBoard) {
      throw new GithubRefusal('InvalidState', `${describeItem(item)} is not on the board`);
    }
    if (lookup.status === undefined) {
      // Still no Status after the bounded re-reads. That is the board's own workflow running late, not a refusal of
      // this move, so it is retryable: BOARD_ACTIVITY_MAX_ATTEMPTS attempts cover about 40 seconds (#629). A refusal
      // of the move itself (below) stays non-retryable, and nothing was written here.
      throw new BoardReadbackError(`${describeItem(item)} is on the board but shows no status yet`);
    }
    if (lookup.status === status) {
      return { changed: false, status };
    }
    const allowed = ALLOWED_MOVES.get(item.kind)?.get(lookup.status);
    if (allowed?.includes(status) !== true) {
      throw new GithubRefusal(
        'InvalidState',
        `${describeItem(item)} is ${lookup.status}; setStatus allows only ${allowedMovesText(item.kind)}` +
          (item.kind === 'issue' ? ' (claimIssue claims a Ready item)' : ''),
      );
    }
    await moveTo(item, status);
    // A write that exited 0 is not a move that happened: read the board and say what it shows.
    const after = await readUntil(item, (read) => read.onBoard && read.status === status);
    if (!after.onBoard || after.status !== status) {
      throw new BoardReadbackError(
        `${describeItem(item)} was moved to ${status} but the board shows ${after.onBoard ? (after.status ?? 'no status') : 'no item'}`,
      );
    }
    return { changed: true, status };
  }

  async function openPr(raw: unknown): Promise<OpenPrResult> {
    const input = parseOpenPrInput(raw);
    const { owner: headOwner } = splitRepo(config.repo);
    const existing = async (): Promise<OpenPrResult | undefined> => {
      const route = `${repoRoute}/pulls?state=open&head=${encodeURIComponent(`${headOwner}:${input.head}`)}&base=${encodeURIComponent(input.base)}`;
      const { items } = await listAll(route, 'pull requests', parseOpenPr);
      const found = items[0];
      return found === undefined ? undefined : { number: found.number, url: found.url, created: false };
    };
    const before = await existing();
    if (before !== undefined) {
      return before;
    }
    try {
      const created = parseCreatedPr(
        await gh.api(`${repoRoute}/pulls`, {
          method: 'POST',
          body: { title: input.title, head: input.head, base: input.base, body: input.body },
        }),
      );
      return { ...created, created: true };
    } catch (error) {
      // "A pull request already exists" (422) means an earlier attempt got through; return that one.
      if (error instanceof GhError && error.httpStatus === 422) {
        const after = await existing();
        if (after !== undefined) {
          return after;
        }
      }
      throw error;
    }
  }

  async function postReview(raw: unknown): Promise<PostReviewResult> {
    const input = parsePostReviewInput(raw);
    const marker = `<!-- orchestrator-review:${input.idempotencyKey} -->`;
    const { items } = await listAll(`${repoRoute}/pulls/${input.pr}/reviews`, 'reviews', parseReview);
    const earlier = items.find((review) => review.body.includes(marker));
    if (earlier !== undefined) {
      return { reviewId: earlier.id, posted: false };
    }
    const created = await gh.api(`${repoRoute}/pulls/${input.pr}/reviews`, {
      method: 'POST',
      body: {
        commit_id: input.commitId,
        // Never REQUEST_CHANGES or APPROVE: GitHub rejects both on a PR the same account opened (CLAUDE.md).
        event: 'COMMENT',
        body: `${input.body}\n\n${marker}`,
        comments: input.comments.map((comment) => ({ path: comment.path, line: comment.line, side: comment.side, body: comment.body })),
      },
    });
    return { reviewId: parseCreatedReviewId(created), posted: true };
  }

  /**
   * Comments on an issue once. The body carries a hidden marker with the idempotency key, and a retry looks for it
   * first, among the comments of trusted authors only (a stranger's comment that copies the marker cannot stop ours).
   * It assumes this account's comments count as trusted (an OWNER, MEMBER or COLLABORATOR); for any other account the
   * lookup would miss them and a retry could comment twice. The caller writes `body` from fixed text and identifiers.
   */
  async function commentIssue(raw: unknown): Promise<CommentIssueResult> {
    const input = parseCommentIssueInput(raw);
    const marker = `<!-- orchestrator-comment:${input.key} -->`;
    const { items } = await listAll(`${repoRoute}/issues/${input.issue}/comments`, 'issue comments', parseComment);
    const earlier = items.find((comment) => comment.body.includes(marker));
    if (earlier !== undefined) {
      return { commentId: earlier.id, posted: false };
    }
    const created = await gh.api(`${repoRoute}/issues/${input.issue}/comments`, {
      method: 'POST',
      body: { body: `${input.body}\n\n${marker}` },
    });
    return { commentId: parseCreatedCommentId(created), posted: true };
  }

  async function getGateStatus(raw: unknown): Promise<GateStatus> {
    const number = parseIssueNumber(raw, 'pr');
    const facts = parseGate(await gh.graphql(GATE_QUERY, { owner, name, number }));
    if (facts === undefined) {
      throw new GithubRefusal('NotFound', `pull request #${number} does not exist`);
    }
    const reviewsOnHead = facts.reviews.filter(
      (review) => COUNTED_REVIEW_STATES.has(review.state) && review.trusted && review.commitOid === facts.headSha && review.body.trim().length > 0,
    ).length;
    return {
      headSha: facts.headSha,
      reviewsOnHead,
      unresolvedThreads: facts.unresolvedThreads,
      clear: reviewsOnHead >= 1 && facts.unresolvedThreads === 0,
    };
  }

  /**
   * The latest `host/integration` status of a commit (#646): its state, and its counts when the description has the
   * counts shape. The combined status lists the latest status of each context, so older ones are never read, and any
   * other context is ignored. The description is parsed into integers and never returned as text.
   * A status is written by an account with write access to the repository, so it is not a stranger's text.
   */
  async function readHostIntegration(sha: string): Promise<HostIntegrationResult> {
    const entry = parseCombinedStatus(await gh.api(`${repoRoute}/commits/${sha}/status?per_page=${PAGE_SIZE}`), sha, HOST_INTEGRATION_CONTEXT);
    const state: HostIntegrationState | undefined = HOST_STATUS_STATES.find((candidate) => candidate === entry?.state);
    if (entry === undefined || state === undefined) {
      // No status, or a state this code does not know (GitHub has no others today): not a pass.
      return { state: 'none' };
    }
    const counts = parseHostDescription(entry.description);
    return counts === undefined ? { state } : { state, counts };
  }

  async function getHostIntegration(raw: unknown): Promise<HostIntegrationResult> {
    const input = inputObject(raw, 'getHostIntegration input');
    return readHostIntegration(parsedHostInput(() => parseHostSha(input.get('sha'))));
  }

  /**
   * Records the host integration result on a commit (#646): one POST of the fixed context, a state and a description
   * of integers. It reads the latest status of the context first and posts nothing when it already shows this state and
   * these counts, so a repeat leaves one result (foundations 4.5). It writes no other context, and it never says
   * anything but the four states of GitHub's status API.
   */
  async function postCommitStatus(raw: unknown): Promise<PostCommitStatusResult> {
    const input: PostCommitStatusInput = parsedHostInput(() => parseHostStatusInput(raw));
    const description = parsedHostInput(() => buildHostDescription(input.counts));
    const current = parseCombinedStatus(await gh.api(`${repoRoute}/commits/${input.sha}/status?per_page=${PAGE_SIZE}`), input.sha, HOST_INTEGRATION_CONTEXT);
    if (current !== undefined && current.state === input.state && current.description === description) {
      return { posted: false };
    }
    await gh.api(`${repoRoute}/statuses/${input.sha}`, {
      method: 'POST',
      body: { state: input.state, context: HOST_INTEGRATION_CONTEXT, description },
    });
    return { posted: true };
  }

  /**
   * Whether a PR is open, closed or merged (#631): flags and the head SHA. The workflow reads it to observe the merge,
   * which is the maintainer's: nothing here merges.
   */
  async function getPrState(raw: unknown): Promise<PrStateResult> {
    const number = parseIssueNumber(raw, 'pr');
    return parsePrState(await gh.api(`${repoRoute}/pulls/${number}`), number);
  }

  /**
   * The files a PR changes that the maintainer alone decides on (golden results, call ceilings, ADRs, business
   * rules), as counts. A rename counts by both names. Paths stay in this activity (#631): the workflow records numbers only.
   */
  async function getPrChanges(raw: unknown): Promise<SensitiveChanges> {
    const number = parseIssueNumber(raw, 'pr');
    try {
      const { items } = await listAll(`${repoRoute}/pulls/${number}/files`, 'pull request files', parsePrFilePaths);
      return classifyChangedPaths(items.flat());
    } catch (error) {
      // A PR with more files than one call reads must not stop the run after the maintainer decided: say so instead.
      if (error instanceof GhError && error.kind === 'output_too_large') {
        return UNCLASSIFIED_CHANGES;
      }
      throw error;
    }
  }

  /**
   * Whether the PR's change needs the host integration check (#648): the pure rule of integration-policy.ts over the
   * bounded changed-files read. Paths stay in this activity; the answer is one boolean. A PR with more files than one
   * call reads is "needed", as the rule says for an incomplete read.
   */
  async function getHostIntegrationNeed(raw: unknown): Promise<HostIntegrationNeed> {
    const number = parseIssueNumber(raw, 'pr');
    try {
      const { items } = await listAll(`${repoRoute}/pulls/${number}/files`, 'pull request files', parsePrFilePaths);
      return { needed: needsHostIntegration(items.flat(), true) };
    } catch (error) {
      if (error instanceof GhError && error.kind === 'output_too_large') {
        return { needed: needsHostIntegration([], false) };
      }
      throw error;
    }
  }

  /**
   * Closes an issue that is still open, with the reason `completed`, and reads it back (#631). The issue is the one
   * a merged PR was meant to close: a PR merged into a branch other than the default does not close it. It reads
   * first and writes only an issue that is open, so a repeat does nothing. A trusted-author read only.
   */
  async function closeIssue(raw: unknown): Promise<CloseIssueResult> {
    const number = parseIssueNumber(raw, 'issue');
    const route = `${repoRoute}/issues/${number}`;
    const before = parseIssueClosed(await gh.api(route), number);
    if (before === undefined) {
      throw new GithubRefusal('UntrustedAuthor', `issue #${number} was not written by an OWNER, MEMBER or COLLABORATOR, so it is not closed`);
    }
    if (before) {
      return { changed: false, closed: true };
    }
    await gh.api(route, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
    if (parseIssueClosed(await gh.api(route), number) !== true) {
      throw new BoardReadbackError(`issue #${number} was closed but GitHub still shows it open`);
    }
    return { changed: true, closed: true };
  }

  /** The unresolved review threads of a PR. Text of an untrusted author is not read (parseReviewThreads). */
  async function listReviewThreads(raw: unknown): Promise<ReviewThread[]> {
    const number = parseIssueNumber(raw, 'pr');
    const threads = parseReviewThreads(await gh.graphql(THREADS_QUERY, { owner, name, number }));
    if (threads === undefined) {
      throw new GithubRefusal('NotFound', `pull request #${number} does not exist`);
    }
    return threads;
  }

  /** The PR's conversation comments for the findings parser (#674). An untrusted author's body is not read. Bounded by `listAll`. */
  async function listFindingsCandidates(raw: unknown): Promise<FindingsCandidate[]> {
    const pr = parseIssueNumber(raw, 'pr');
    return (await listAll(`${repoRoute}/issues/${pr}/comments`, 'pr comments', parseFindingsCandidate)).items;
  }

  /**
   * Waits up to `waitMs` for the answer to a needs-input comment (#698): reads the issue's comments now and every `pollMs`
   * after, and returns the id of the first trusted comment that is newer than `afterCommentId` and carries no orchestrator
   * marker. Reads only, so a retry or a restart re-reads and cannot start anything. The wait is the activity's own sleep, which
   * heartbeats and stops on cancellation. Answers `answered: false` when the time is up; the workflow decides what that means.
   */
  async function waitForNeedsInputAnswer(raw: unknown): Promise<NeedsInputWaitResult> {
    const input = parseNeedsInputWaitInput(raw);
    let left = input.waitMs;
    for (;;) {
      const answer = findNeedsInputAnswer((await listAll(`${repoRoute}/issues/${input.issue}/comments`, 'issue comments', parseFindingsCandidate)).items, input.afterCommentId);
      if (answer !== undefined) {
        return { answered: true, commentId: answer.id };
      }
      if (left <= 0) {
        return { answered: false };
      }
      const slice = Math.min(left, input.pollMs);
      await sleep(slice);
      left -= slice;
    }
  }

  /** Hides the raw findings comment (#674). Idempotent. Refuses an answer that does not show the comment hidden. */
  async function minimizeComment(raw: unknown): Promise<{ readonly minimized: true }> {
    const input = inputObject(raw, 'minimizeComment input');
    const id = inputText(input, 'nodeId', NODE_ID, 100);
    const data = await gh.graphql(MINIMIZE_MUTATION, { id });
    if (!parseMinimized(data)) {
      throw new GhError('gh api graphql: minimizeComment did not report the comment hidden', 'malformed');
    }
    return { minimized: true };
  }

  /**
   * Replies in a review thread once. The body carries a hidden marker with the idempotency key, and a retry looks for
   * it in the thread's comments first. A thread that is no longer open gets no reply (`posted: false`). Nothing here
   * resolves a thread, and the reply is a comment, never a review state.
   */
  async function replyToThread(raw: unknown): Promise<ReplyToThreadResult> {
    const input = parseReplyInput(raw);
    const marker = `<!-- orchestrator-reply:${input.key} -->`;
    const thread = (await listReviewThreads(input.pr)).find((candidate) => candidate.id === input.threadId);
    const first = thread?.comments[0];
    if (thread === undefined || first === undefined || thread.comments.some((comment) => comment.trusted && comment.body.includes(marker))) {
      return { posted: false };
    }
    await gh.api(`${repoRoute}/pulls/${input.pr}/comments/${first.id}/replies`, {
      method: 'POST',
      body: { body: `${input.body}\n\n${marker}` },
    });
    return { posted: true };
  }

  return {
    listReadyIssues,
    readIssue,
    checkIssue,
    commentIssue,
    claimIssue,
    addToBoard,
    getBoardStatus,
    setStatus,
    openPr,
    postReview,
    getGateStatus,
    getPrState,
    getPrChanges,
    getHostIntegrationNeed,
    closeIssue,
    listReviewThreads,
    replyToThread,
    listFindingsCandidates,
    waitForNeedsInputAnswer,
    minimizeComment,
    getHostIntegration,
    postCommitStatus,
    openPrsFor,
    claudeBranchesFor,
    branchTip,
    checksPending,
    reviewedOnHead,
  };
}

/**
 * The activities. Give each of them `GITHUB_ACTIVITY_TIMEOUTS` (src/github-policy.ts) in the workflow: one attempt can
 * wait out up to three rate limits of ten minutes each.
 */
export function createGithubActivities(config: GhConfig, deps: GhDeps = activityDeps) {
  /** One fresh `gh` wrapper per attempt, and every failure mapped to a Temporal failure. */
  const activity =
    <Args extends unknown[], Result>(run: (ops: ReturnType<typeof operations>, ...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      try {
        return await run(operations(config, new GhCli(config, deps), deps.sleep), ...args);
      } catch (error) {
        throw toFailure(error);
      }
    };

  return {
    listReadyIssues: activity((ops) => ops.listReadyIssues()),
    readIssue: activity((ops, issue: number) => ops.readIssue(issue)),
    checkIssue: activity((ops, issue: number) => ops.checkIssue(issue)),
    commentIssue: activity((ops, input: CommentIssueInput) => ops.commentIssue(input)),
    claimIssue: activity((ops, issue: number) => ops.claimIssue(issue)),
    addToBoard: activity((ops, url: BoardTarget) => ops.addToBoard(url)),
    getBoardStatus: activity((ops, url: BoardTarget) => ops.getBoardStatus(url)),
    setStatus: activity((ops, target: BoardTarget, status: SettableStatus) => ops.setStatus(target, status)),
    openPr: activity((ops, input: OpenPrInput) => ops.openPr(input)),
    postReview: activity((ops, input: PostReviewInput) => ops.postReview(input)),
    getGateStatus: activity((ops, pr: number) => ops.getGateStatus(pr)),
    getPrState: activity((ops, pr: number) => ops.getPrState(pr)),
    getPrChanges: activity((ops, pr: number) => ops.getPrChanges(pr)),
    getHostIntegrationNeed: activity((ops, pr: number) => ops.getHostIntegrationNeed(pr)),
    closeIssue: activity((ops, issue: number) => ops.closeIssue(issue)),
    listReviewThreads: activity((ops, pr: number) => ops.listReviewThreads(pr)),
    replyToThread: activity((ops, input: ReplyToThreadInput) => ops.replyToThread(input)),
    listFindingsCandidates: activity((ops, pr: number) => ops.listFindingsCandidates(pr)),
    waitForNeedsInputAnswer: activity((ops, input: NeedsInputWaitInput) => ops.waitForNeedsInputAnswer(input)),
    minimizeComment: activity((ops, input: { nodeId: string }) => ops.minimizeComment(input)),
    getHostIntegration: activity((ops, input: { sha: string }) => ops.getHostIntegration(input)),
    postCommitStatus: activity((ops, input: PostCommitStatusInput) => ops.postCommitStatus(input)),
  };
}

/**
 * The reads `runRemoteSession` makes (#672), bound to one repository. They are plain functions, not activities: the
 * remote session activity polls with them from inside itself. Each call gets a fresh `gh` wrapper, and every failure
 * is mapped to a Temporal failure.
 */
export function createRemoteGithubReads(config: GhConfig, deps: GhDeps = activityDeps): RemoteGithub {
  const read =
    <Args extends unknown[], Result>(run: (ops: ReturnType<typeof operations>, ...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      try {
        return await run(operations(config, new GhCli(config, deps), deps.sleep), ...args);
      } catch (error) {
        throw toFailure(error);
      }
    };
  return {
    openPrs: read(async (ops, issue: number) => (await ops.openPrsFor(issue)).map((pr) => pr.number)),
    claudeBranches: read((ops, issue: number) => ops.claudeBranchesFor(issue)),
    branchTip: read((ops, branch: string) => ops.branchTip(branch)),
    checksPending: read((ops, sha: string) => ops.checksPending(sha)),
    reviewedOnHead: read((ops, pr: number, sha: string) => ops.reviewedOnHead(pr, sha)),
    findingsCommented: read(async (ops, pr: number, marker: string) => hasFindingsComment(await ops.listFindingsCandidates(pr), marker)),
    // An issue's comments are listed by the same route as a PR's, so the same bounded, trust-flagging listing serves (#697).
    needsInputCommented: read(async (ops, issue: number, marker: string) => findKeyedComment(await ops.listFindingsCandidates(issue), marker)?.id),
  };
}

export type GithubActivities = ReturnType<typeof createGithubActivities>;

// ---- failures -------------------------------------------------------------------------------------------------

/** Maps what went wrong to a Temporal failure. What retrying cannot fix is non-retryable; the rest retries by the workflow's policy. */
export function toFailure(error: unknown): unknown {
  if (error instanceof GithubRefusal) {
    return ApplicationFailure.nonRetryable(error.message, error.type);
  }
  if (error instanceof BoardReadbackError) {
    // Retryable: the retry reads the board again. BOARD_ACTIVITY_MAX_ATTEMPTS (src/board-policy.ts) bounds the attempts.
    return ApplicationFailure.retryable(error.message, 'BoardReadbackMismatch');
  }
  if (error instanceof GhError) {
    switch (error.kind) {
      case 'malformed':
        return ApplicationFailure.nonRetryable(error.message, 'MalformedGhOutput');
      case 'output_too_large':
        return ApplicationFailure.nonRetryable(error.message, 'TooLarge');
      case 'rate_limit_wait_too_long':
        return ApplicationFailure.nonRetryable(error.message, 'GitHubRateLimitTooLong');
      case 'rate_limit_exhausted':
        return ApplicationFailure.nonRetryable(error.message, 'GitHubRateLimitExhausted');
      case 'spawn':
        return ApplicationFailure.nonRetryable(error.message, 'GhUnavailable');
      case 'exit': {
        const status = error.httpStatus;
        if (status === 404) {
          return ApplicationFailure.nonRetryable(error.message, 'NotFound');
        }
        // A request GitHub rejected as wrong or forbidden is wrong again on a retry. 408 and 429 are not that.
        if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          return ApplicationFailure.nonRetryable(error.message, 'GitHubClientError');
        }
        return error;
      }
      case 'timeout':
      case 'graphql':
        return error;
    }
  }
  return error;
}

/** Waits out a rate limit inside an activity: heartbeats while it waits and stops when the activity is cancelled. */
async function activitySleep(ms: number): Promise<void> {
  const context = Context.current();
  for (let left = ms; left > 0; left -= HEARTBEAT_SLICE_MS) {
    context.heartbeat();
    await context.sleep(Math.min(left, HEARTBEAT_SLICE_MS));
  }
}

const activityDeps: GhDeps = { sleep: activitySleep, now: defaultGhDeps.now };
