// The GitHub activities of the orchestrator (#628, parent plan #625): thin wrappers over `gh` (src/gh.ts) that
// carry the repo's trust and rate-limit rules in code, not prose (CLAUDE.md "Untrusted GitHub content", "Board
// statuses", "GitHub rate limits", "Code review" step 5).
//
// What they never do, by construction: merge, apply a label (`golden-change` included), move a board item out of
// Backlog or into Ready, or resolve a review thread. The only board write is `setStatus` to In progress, In
// review or Done, and the only GraphQL here is read-only.
//
// Activities run at least once (foundations 4.5), so every write checks first and a repeat does nothing:
// - `claimIssue` and `setStatus` read the item's Status and write only when it differs.
// - `openPr` looks for an open PR with the same head and base before it creates one.
// - `postReview` looks for a review that carries its idempotency key before it posts one.
// A write whose answer was lost (a timeout, a killed worker) is found by the next attempt's read.
//
// Inputs arrive from workflow code as untyped JSON, so each activity parses its input first. A bad input is a
// non-retryable `InvalidInput` failure; an untrusted issue author is `UntrustedAuthor`; `gh` output that does not
// match is `MalformedGhOutput`; a rate-limit wait too long to sit through is `GitHubRateLimitTooLong`.

import { ApplicationFailure, Context } from '@temporalio/activity';
import { GhCli, GhError, defaultGhDeps } from '../gh.ts';
import type { GhDeps } from '../gh.ts';
import type { GhConfig } from '../gh-config.ts';
import {
  parseBlocker,
  parseBoardItems,
  parseComment,
  parseCreatedPr,
  parseCreatedReviewId,
  parseGate,
  parseIssueBoardStatus,
  parseIssueHead,
  parseList,
  parseOpenPr,
  parseRefName,
  parseReview,
} from '../github-parse.ts';
import type { BoardLookup, OpenPr } from '../github-parse.ts';
import type {
  ClaimResult,
  GateStatus,
  IssueView,
  OpenPrInput,
  OpenPrResult,
  PostReviewInput,
  PostReviewResult,
  ReadyIssues,
  ReviewComment,
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

const SETTABLE: readonly SettableStatus[] = ['In progress', 'In review', 'Done'];

export type RefusalType = 'InvalidInput' | 'UntrustedAuthor' | 'InvalidState' | 'NotFound';

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

const HEAD = /^claude\/\d{1,9}(?:-[A-Za-z0-9._-]{1,100})?$/;
const BASE = /^[A-Za-z0-9._/-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const KEY = /^[A-Za-z0-9._-]{1,100}$/;

function parseOpenPrInput(raw: unknown): OpenPrInput {
  const input = inputObject(raw, 'openPr input');
  return {
    head: inputText(input, 'head', HEAD, 200),
    base: inputText(input, 'base', BASE, 100),
    title: inputText(input, 'title', /^[^\r\n]+$/, 256),
    body: inputText(input, 'body', undefined, MAX_TEXT_CHARS),
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

const BOARD_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){' +
  'projectItems(first:20){pageInfo{hasNextPage} nodes{project{number owner{... on User{login} ... on Organization{login}}} ' +
  'fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}';

// The query of CLAUDE.md "Code review" step 5, with the review's author association added so a stranger's review
// cannot clear the gate, and a page-info flag so a PR with more than 100 reviews or threads fails instead of
// being counted from part of its list.
const GATE_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){' +
  'headRefOid reviews(first:100){pageInfo{hasNextPage} nodes{body authorAssociation commit{oid}}} ' +
  'reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}}}}';

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner = '', name = ''] = repo.split('/');
  return { owner, name };
}

export function createGithubActivities(config: GhConfig, deps: GhDeps = activityDeps) {
  const gh = new GhCli(config, deps);
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

  async function boardLookup(issue: number): Promise<BoardLookup> {
    const data = await gh.graphql(BOARD_QUERY, { owner, name, number: issue });
    const lookup = parseIssueBoardStatus(data, config.projectOwner, config.projectNumber);
    if (lookup === undefined) {
      throw new GithubRefusal('NotFound', `issue #${issue} does not exist`);
    }
    return lookup;
  }

  async function moveTo(issue: number, status: SettableStatus): Promise<void> {
    await gh.project([
      'item-edit',
      String(config.projectNumber),
      '--owner',
      config.projectOwner,
      '--url',
      `https://github.com/${config.repo}/issues/${issue}`,
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

  async function claimIssue(raw: unknown): Promise<ClaimResult> {
    const issue = parseIssueNumber(raw, 'issue');
    const lookup = await boardLookup(issue);
    if (!lookup.onBoard) {
      throw new GithubRefusal('InvalidState', `issue #${issue} is not on the board`);
    }
    if (lookup.status === 'In progress') {
      return { claimed: false, reason: 'already_in_progress' };
    }
    if (lookup.status === 'In review' || lookup.status === 'Done') {
      return { claimed: false, reason: 'already_past_in_progress' };
    }
    if (lookup.status !== 'Ready') {
      // Backlog to anything is the maintainer's move, and so is an item with no status.
      throw new GithubRefusal('InvalidState', `issue #${issue} is not Ready (${lookup.status ?? 'no status'}), so it is not claimed`);
    }
    if ((await openPrsFor(issue)).length > 0) {
      return { claimed: false, reason: 'open_pr' };
    }
    if ((await claudeBranchesFor(issue)).length > 0) {
      return { claimed: false, reason: 'claude_branch' };
    }
    await moveTo(issue, 'In progress');
    return { claimed: true, reason: 'claimed' };
  }

  async function setStatus(rawIssue: unknown, rawStatus: unknown): Promise<SetStatusResult> {
    const issue = parseIssueNumber(rawIssue, 'issue');
    const status = parseSettableStatus(rawStatus);
    const lookup = await boardLookup(issue);
    if (!lookup.onBoard) {
      throw new GithubRefusal('InvalidState', `issue #${issue} is not on the board`);
    }
    if (lookup.status === undefined || lookup.status === 'Backlog') {
      throw new GithubRefusal('InvalidState', `issue #${issue} is ${lookup.status ?? 'without a status'}, and only a maintainer moves it out`);
    }
    if (lookup.status === status) {
      return { changed: false, status };
    }
    await moveTo(issue, status);
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

  async function getGateStatus(raw: unknown): Promise<GateStatus> {
    const number = parseIssueNumber(raw, 'pr');
    const facts = parseGate(await gh.graphql(GATE_QUERY, { owner, name, number }));
    if (facts === undefined) {
      throw new GithubRefusal('NotFound', `pull request #${number} does not exist`);
    }
    const reviewsOnHead = facts.reviews.filter(
      (review) => review.trusted && review.commitOid === facts.headSha && review.body.trim().length > 0,
    ).length;
    return {
      headSha: facts.headSha,
      reviewsOnHead,
      unresolvedThreads: facts.unresolvedThreads,
      clear: reviewsOnHead >= 1 && facts.unresolvedThreads === 0,
    };
  }

  const guard = <Args extends unknown[], Result>(work: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      try {
        return await work(...args);
      } catch (error) {
        throw toFailure(error);
      }
    };

  return {
    listReadyIssues: guard(listReadyIssues),
    readIssue: guard((issue: number) => readIssue(issue)),
    claimIssue: guard((issue: number) => claimIssue(issue)),
    setStatus: guard((issue: number, status: SettableStatus) => setStatus(issue, status)),
    openPr: guard((input: OpenPrInput) => openPr(input)),
    postReview: guard((input: PostReviewInput) => postReview(input)),
    getGateStatus: guard((pr: number) => getGateStatus(pr)),
  };
}

export type GithubActivities = ReturnType<typeof createGithubActivities>;

// ---- failures -------------------------------------------------------------------------------------------------

/** Maps what went wrong to a Temporal failure. What retrying cannot fix is non-retryable; the rest retries by the workflow's policy. */
export function toFailure(error: unknown): unknown {
  if (error instanceof GithubRefusal) {
    return ApplicationFailure.nonRetryable(error.message, error.type);
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
