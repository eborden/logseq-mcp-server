// Shapes and bounds of what the reviewer and fixer sessions hand back (#630), parsed at the boundary (foundations 4.2).
// A session writes one JSON file in a known place; the activity reads and parses it here. The text in it is untrusted
// model output: it is size-capped, schema-checked, refused when it does not fit (never cut) and sanitised before it
// reaches GitHub. It never reaches workflow history: the activities return counts and identifiers only.
//
// This file imports nothing from Node, so workflow code may import its types and constants.

import { parseHostFailureSummary } from './host-integration-policy.ts';
import type { HostFailureSummary } from './host-integration-policy.ts';
import type { ReviewThread } from './types.ts';

/** The files the sessions write, relative to their working directory. */
export const REVIEWER_OUTPUT_FILE = 'review-findings.json';
export const FIXER_OUTPUT_FILE = 'fixer-replies.json';

export const MAX_OUTPUT_FILE_BYTES = 64_000;
export const MAX_FINDINGS = 30;
export const MAX_REPLIES = 50;
export const MAX_COMMENT_CHARS = 3_000;
export const MAX_SUMMARY_CHARS = 4_000;
export const MAX_ACCEPTED = 100;
export const MAX_PATH_CHARS = 300;
export const MAX_LINE = 1_000_000;

/** A GraphQL node id of a review thread. Narrower than GitHub's alphabet on purpose: it is also part of an idempotency key. */
export const THREAD_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** The identifiers every review activity takes from the workflow. No text. */
export interface ReviewStepInput {
  readonly pr: number;
  readonly issue: number;
  readonly repoDir: string;
  /** The implementer's worktree, on the branch `claude/<issue>`. The fixer works there, the reviewer next to it. */
  readonly worktreeDir: string;
  readonly base: string;
  /** The head commit this step is about. */
  readonly headSha: string;
  /** The number of fixer rounds finished before this step. Names the review and its files. */
  readonly round: number;
  /** Threads the reviewer already accepted a reply on. The fixer leaves them alone. */
  readonly acceptedThreadIds: readonly string[];
  /** A host integration failure on a fixture run (#676): the remote fixer's brief carries it as data. Only the fixer round reads it. */
  readonly hostFailure?: HostFailureSummary;
  /** Where the PR body came from (#708): the remote reviewer's brief says so for a generated fallback. Absent when not known. */
  readonly bodySource?: 'session' | 'fallback' | 'unknown';
}

export class InvalidReviewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReviewInputError';
  }
}

/** A session's file that does not have the shape asked for. The message never quotes the file. */
export class MalformedFindingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedFindingsError';
  }
}

/** A session's file or text over a bound. Refused, never cut (BR-0006's rule). */
export class FindingsTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FindingsTooLargeError';
  }
}

export interface Finding {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

export interface ReviewerOutput {
  readonly summary: string;
  readonly findings: readonly Finding[];
  readonly acceptedThreadIds: readonly string[];
}

export interface FixerReply {
  readonly threadId: string;
  readonly body: string;
}

export interface FixerOutput {
  readonly replies: readonly FixerReply[];
}

/** What the workflow sees of a reviewer session: counts and thread identifiers. */
export interface ReviewerSessionResult {
  readonly findings: number;
  /** Open threads the reviewer accepted a reply on. Always a subset of the threads that were open. */
  readonly acceptedThreadIds: readonly string[];
}

/** What the workflow sees of a remote reviewer round (#674): counts, thread ids and the node id of the raw comment to hide. */
export interface RemoteReviewerSessionResult extends ReviewerSessionResult {
  readonly commentNodeId: string;
}

export interface PostedReviewResult {
  readonly reviewId: number;
  readonly posted: boolean;
  /** Findings posted as inline comments, on lines the commit changes. */
  readonly comments: number;
  /** Findings on an unchanged line of a changed file, opened as file-level review threads (#714). They hold the gate. */
  readonly fileLevel: number;
  /** Findings that wanted a file-level thread, could not get one, and were placed on the nearest changed line of their file (#714). They hold the gate. */
  readonly nearest: number;
  /** Findings that open no thread (a file the commit does not change, the cap of file-level threads, a thread GitHub refused), listed in the review body. */
  readonly advisory: number;
  /** Advisory findings left out of the body because it is at its size bound. Counted, never silent. */
  readonly omitted: number;
}

export interface FixerSessionResult {
  /** The branch tip after the session. */
  readonly headSha: string;
  readonly moved: boolean;
  readonly replies: number;
}

/** What the workflow sees of a remote fixer round (#675): the tip the branch is at, whether it moved, a count and the node id of the raw comment to hide. */
export interface RemoteFixerSessionResult extends FixerSessionResult {
  readonly commentNodeId: string;
}

export interface PostedRepliesResult {
  readonly posted: number;
  /** Replies that were already there, or whose thread is gone. */
  readonly skipped: number;
}

/** An open thread as the workflow sees it: an identifier and whether its first comment is by a trusted author. */
export interface OpenThreadRef {
  readonly id: string;
  readonly trusted: boolean;
}

export interface OpenThreads {
  readonly threads: readonly OpenThreadRef[];
}

export function openThreadRefs(threads: readonly ReviewThread[]): OpenThreads {
  return { threads: threads.map((thread) => ({ id: thread.id, trusted: thread.trusted })) };
}

// ---- sanitising -----------------------------------------------------------------------------------------------

// Control characters other than newline and tab, and the characters that reorder or hide text.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069\ufeff]/g;

/**
 * Text from a session, made safe to post. It cannot carry the hidden idempotency markers (`<!--`), notify anyone
 * (`@name` gets a zero-width space), name a link or image target, autolink a URL, offer an "apply suggestion" button, or hide text
 * behind control characters. Plain `<` in review text (a generic type) becomes `&lt;`: the cost of closing HTML.
 */
export function sanitiseText(text: string): string {
  return neutralise(text).trim();
}

/** `sanitiseText` without the final trim, so a file path keeps a leading or trailing space it really has. */
function neutralise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    // An entity that would render as `@`, `:` or `/` must not reach GitHub as one (`&#64;alice` renders `@alice`). `&amp;`,
    // `&lt;` and `&gt;` stay, so the pass is idempotent and the entities the next rule writes are not doubled.
    .replace(/&(?!(?:amp|lt|gt);)(?=#|[A-Za-z][A-Za-z0-9]*;)/g, '&amp;')
    // Every `<` is an entity: no hidden marker, no HTML tag (an `<img>` is fetched when the review is viewed).
    .replace(/</g, '&lt;')
    .replace(/-->/g, '--&gt;')
    // Every `@` before a letter or digit is broken, in a code span or not (GitHub notifies only outside a closed one,
    // and a lone backtick does not close one).
    .replace(/@(?=[A-Za-z0-9])/g, '@\u200b')
    // No markdown image or link target, so a finding cannot make GitHub fetch or show a URL of the session's choosing.
    .replace(/!\[/g, '!\u200b[')
    .replace(/\]\(/g, ']\u200b(')
    .replace(/\]:/g, ']\u200b:')
    // A raw URL must not autolink (a zero-width space after the scheme's colon, and in `www.`).
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]{1,31}):\/\//g, '$1:\u200b//')
    .replace(/\bwww\./gi, (match) => `${match.slice(0, 3)}\u200b.`)
    .replace(/```[ \t]*suggestion/gi, '``` suggestion');
}

/**
 * A file path as an inline code span that no path can break out of. The path is first neutralised like any session text
 * (no hidden marker, no mention, no autolink), then wrapped in a fence of backticks one longer than the longest run in it,
 * padded with a space on each side when it starts or ends with a backtick or a space (CommonMark strips one space each
 * side). `suffix` (the `:line` of a finding) goes inside the span, after the path. Only for display: the path used to match
 * the diff and to open a thread is the raw one, and the text shown can differ from it (`<` is written `&lt;`, a zero-width
 * space follows an `@` or a URL scheme's colon, three backticks and `suggestion` get a space between), so a reader must not
 * copy a name from a span. A line break or tab is shown as a space, so the helper is safe on its own and does not rely on
 * the parser.
 */
export function pathCodeSpan(path: string, suffix = ''): string {
  const content = `${neutralise(path).replace(/[\n\t]/g, ' ')}${suffix}`;
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^[ `]|[ `]$/.test(content) ? ' ' : '';
  return `${fence}${pad}${content}${pad}${fence}`;
}

// ---- changed lines --------------------------------------------------------------------------------------------

/** Changed lines of the new side of a diff, per path, as inclusive ranges. */
export type ChangedLines = ReadonlyMap<string, readonly (readonly [number, number])[]>;

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A diff header whose C-quoted name is not what git writes. Thrown, never guessed at: the diff cannot be trusted to place a finding. */
export class MalformedDiffHeaderError extends Error {
  constructor(reason: string) {
    super(`malformed quoted file name in a diff header: ${reason}`);
    this.name = 'MalformedDiffHeaderError';
  }
}

/** The single-letter escapes of git's `quote_c_style`, besides `\\` and `\"`. */
const C_ESCAPES: Readonly<Record<string, string>> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

/**
 * Reads the file name of a `+++ ` header (the text after `+++ `). An unquoted name is the text up to a tab (git adds a trailing
 * tab to a name with a space). A name git writes C-quoted (it holds a double quote, a backslash or a control character, and with
 * `core.quotePath` on, a non-ASCII byte) starts with `"`: it is decoded as git writes it, strictly. Exactly `\\`, `\"`, `\a`, `\b`,
 * `\f`, `\n`, `\r`, `\t`, `\v` and three-digit octal escapes up to `\377` are accepted; the octal escapes are bytes, and the bytes of
 * the whole name must be valid UTF-8. A missing closing quote, an unescaped quote inside, any other escape, a short or too large
 * octal escape, a raw control character, a trailing backslash, text after the closing quote (a tab is the only thing allowed) or invalid UTF-8 throws
 * `MalformedDiffHeaderError`. Pure, no I/O.
 */
export function parseDiffHeaderName(text: string): string {
  if (!text.startsWith('"')) {
    return text.split('\t')[0] ?? '';
  }
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let index = 1;
  for (;;) {
    if (index >= text.length) {
      throw new MalformedDiffHeaderError('no closing quote');
    }
    const char = text[index] as string;
    if (char === '"') {
      index += 1;
      break;
    }
    if (char !== '\\') {
      if (/[\u0000-\u001f\u007f]/.test(char)) {
        throw new MalformedDiffHeaderError('a raw control character, which git writes as an escape');
      }
      const codePoint = text.codePointAt(index) as number;
      const whole = String.fromCodePoint(codePoint);
      bytes.push(...encoder.encode(whole));
      index += whole.length;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) {
      throw new MalformedDiffHeaderError('a backslash ends the header');
    }
    if (next === '\\' || next === '"') {
      bytes.push(next.charCodeAt(0));
      index += 2;
    } else if (Object.prototype.hasOwnProperty.call(C_ESCAPES, next)) {
      bytes.push((C_ESCAPES[next] as string).charCodeAt(0));
      index += 2;
    } else if (/^[0-7]{3}$/.test(text.slice(index + 1, index + 4))) {
      const value = parseInt(text.slice(index + 1, index + 4), 8);
      if (value > 0xff) {
        throw new MalformedDiffHeaderError('an octal escape above \\377');
      }
      bytes.push(value);
      index += 4;
    } else {
      throw new MalformedDiffHeaderError('an escape git does not write');
    }
  }
  const rest = text.slice(index);
  if (rest !== '' && !rest.startsWith('\t')) {
    throw new MalformedDiffHeaderError('text after the closing quote');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes));
  } catch {
    throw new MalformedDiffHeaderError('the bytes are not valid UTF-8');
  }
}

/**
 * Parses `git diff -U0 --no-prefix --no-renames` into the lines each file changes on its new side. GitHub accepts an
 * inline comment only on a line the diff shows; with no context lines that is exactly these. The hunk's counts are
 * followed, so a changed line that reads `++ x` (shown as `+++ x`) is not taken for a file header. A file name git writes
 * C-quoted in a header is decoded to the raw path (#746), so a finding on it matches; a quoted name that is not what git writes
 * throws `MalformedDiffHeaderError`. Pure, no I/O.
 */
export function changedLines(diff: string): ChangedLines {
  const files = new Map<string, [number, number][]>();
  let current: [number, number][] | undefined;
  let old = 0;
  let added = 0;
  for (const line of diff.split('\n')) {
    if (old > 0 || added > 0) {
      if (line.startsWith('-')) {
        old -= 1;
      } else if (line.startsWith('+')) {
        added -= 1;
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = parseDiffHeaderName(line.slice(4));
      current = path === '/dev/null' ? undefined : (files.get(path) ?? []);
      if (current !== undefined) {
        files.set(path, current);
      }
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk !== null && current !== undefined) {
      old = hunk[1] === undefined ? 1 : Number(hunk[1]);
      added = hunk[3] === undefined ? 1 : Number(hunk[3]);
      if (added > 0) {
        const start = Number(hunk[2]);
        current.push([start, start + added - 1]);
      }
    }
  }
  return files;
}

/** Why a finding opened no thread: it is listed in the review body instead. */
export type AdvisoryReason = 'file_not_in_diff' | 'thread_cap' | 'thread_failed' | 'no_changed_line';

export interface AdvisoryFinding extends Finding {
  readonly reason: AdvisoryReason;
}

/** The most file-level threads one review opens (#714). A finding past it is advisory, with its reason, never dropped. */
export const MAX_FILE_THREADS = 10;

export interface SplitFindings {
  /** On a line the commit changes: an inline comment GitHub accepts. */
  readonly inline: readonly Finding[];
  /** On an unchanged line of a file the commit changes: a file-level thread (#714), at most `MAX_FILE_THREADS`. */
  readonly fileLevel: readonly Finding[];
  /** Anywhere else. An inline comment on such a line makes GitHub reject the whole review (422), and a file the commit does not change has no diff to hang a thread on. */
  readonly advisory: readonly AdvisoryFinding[];
}

/**
 * `undefined` for `changed` means the diff could not be read: nothing can be shown to sit on a changed line, and no file is
 * known to be in the diff. A file is in the diff when it has an entry in `changed`, even one with no added line (a file that
 * only lost lines): a thread can hang on it, a comment on a line cannot.
 */
export function splitFindings(findings: readonly Finding[], changed: ChangedLines | undefined): SplitFindings {
  const inline: Finding[] = [];
  const fileLevel: Finding[] = [];
  const advisory: AdvisoryFinding[] = [];
  for (const finding of findings) {
    const ranges = changed?.get(finding.path);
    if (ranges === undefined) {
      advisory.push({ ...finding, reason: 'file_not_in_diff' });
    } else if (ranges.some(([from, to]) => finding.line >= from && finding.line <= to)) {
      inline.push(finding);
    } else if (fileLevel.length < MAX_FILE_THREADS) {
      fileLevel.push(finding);
    } else {
      advisory.push({ ...finding, reason: 'thread_cap' });
    }
  }
  return { inline, fileLevel, advisory };
}

/**
 * The changed line of a file that is nearest to `line`: the smallest distance, and on a tie the earlier line. `undefined`
 * when the file has no changed line on its new side (a file that only lost lines).
 */
export function nearestChangedLine(ranges: readonly (readonly [number, number])[], line: number): number | undefined {
  let best: number | undefined;
  for (const [from, to] of ranges) {
    const candidate = Math.min(Math.max(line, from), to);
    if (best === undefined || Math.abs(candidate - line) < Math.abs(best - line) || (Math.abs(candidate - line) === Math.abs(best - line) && candidate < best)) {
      best = candidate;
    }
  }
  return best;
}

/** The first comment of a file-level thread: the path and the original line are in the text, because the thread has no line (#714). */
export function fileThreadBody(finding: Finding): string {
  return `Finding on ${pathCodeSpan(finding.path, `:${finding.line}`)}, a line this commit does not change, so it is raised on the file.\n\n${finding.body}`;
}

/** The first comment of a thread placed on the nearest changed line: it says that it is placed there and where it belongs (#714). */
export function nearestThreadBody(finding: Finding, placedAt: number): string {
  return `Finding on ${pathCodeSpan(finding.path, `:${finding.line}`)}, a line this commit does not change. A file-level thread could not be created, so it is placed on line ${placedAt}, the nearest changed line of this file. It belongs on line ${finding.line}.\n\n${finding.body}`;
}

/** The most the advisory findings add to a review body, so the body stays far under GitHub's limit. */
export const MAX_ADVISORY_CHARS = 20_000;

const REASON_TEXT: Readonly<Record<AdvisoryReason, string>> = {
  file_not_in_diff: 'the file is not changed by this commit',
  thread_cap: `the review is at its cap of ${MAX_FILE_THREADS} file-level threads`,
  thread_failed: 'GitHub refused a thread for it',
  no_changed_line: 'GitHub refused a file-level thread for it, and its file has no changed line to place it on',
};

/**
 * The advisory findings as a section of the review body: what fits, then a count of the rest. The text of a finding
 * is already sanitised. Each entry says why it opened no thread. Returns the section and how many were left out.
 */
export function advisorySection(advisory: readonly (Finding & { readonly reason?: AdvisoryReason })[]): { readonly text: string; readonly listed: number; readonly omitted: number } {
  if (advisory.length === 0) {
    return { text: '', listed: 0, omitted: 0 };
  }
  const lines = [
    `${advisory.length} finding${advisory.length === 1 ? '' : 's'} could not be attached to the diff or opened as a thread. ${advisory.length === 1 ? 'It is' : 'They are'} listed here, ${advisory.length === 1 ? 'is' : 'are'} **advisory** and open no thread, so ${advisory.length === 1 ? 'it does' : 'they do'} not hold the gate.`,
  ];
  let size = lines[0]?.length ?? 0;
  let listed = 0;
  for (const finding of advisory) {
    const why = finding.reason === undefined ? '' : ` (${REASON_TEXT[finding.reason]})`;
    const entry = `\n- ${pathCodeSpan(finding.path, `:${finding.line}`)}${why}\n${finding.body.split('\n').map((row) => `  > ${row}`).join('\n')}`;
    if (size + entry.length > MAX_ADVISORY_CHARS) {
      break;
    }
    lines.push(entry);
    size += entry.length;
    listed += 1;
  }
  const omitted = advisory.length - listed;
  if (omitted > 0) {
    lines.push(`\n${omitted} more advisory finding${omitted === 1 ? ' was' : 's were'} left out because this list is at its size bound.`);
  }
  return { text: lines.join('\n'), listed, omitted };
}

// ---- parsing --------------------------------------------------------------------------------------------------

function malformed(what: string): never {
  throw new MalformedFindingsError(`the session's file is not in the asked shape: ${what}`);
}

function tooLarge(what: string): never {
  throw new FindingsTooLargeError(`the session's file is over a bound: ${what}`);
}

function record(raw: unknown, what: string): ReadonlyMap<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return malformed(`${what} must be an object`);
  }
  return new Map(Object.entries(raw));
}

function array(raw: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(raw)) {
    return malformed(`${what} must be a list`);
  }
  if (raw.length > max) {
    return tooLarge(`${what} has more than ${max} entries`);
  }
  const items: unknown[] = raw;
  return items;
}

/** A non-empty string within `max` characters, sanitised. Empty after sanitising is refused. */
function text(raw: unknown, what: string, max: number): string {
  if (typeof raw !== 'string') {
    return malformed(`${what} must be text`);
  }
  if (raw.length > max) {
    return tooLarge(`${what} is longer than ${max} characters`);
  }
  const clean = sanitiseText(raw);
  return clean === '' ? malformed(`${what} must not be empty`) : clean;
}

function parseJson(content: string): unknown {
  if (new TextEncoder().encode(content).length > MAX_OUTPUT_FILE_BYTES) {
    return tooLarge(`the file is larger than ${MAX_OUTPUT_FILE_BYTES} bytes`);
  }
  try {
    return JSON.parse(content);
  } catch {
    return malformed('it is not JSON');
  }
}

// A path is checked by its structure, not by a list of characters: a file of the repository may be named with brackets,
// parentheses, `~`, `#`, `=` or a non-ASCII letter. What is refused is what is not a file name a reader can see (#719).
// Everywhere the path is printed into markdown it goes through `pathCodeSpan`, which cannot be broken out of, so the
// spelling of a path never decides what a body renders.
//   \p{Cc}  control characters: C0, DEL, C1 (a newline and a tab too)
//   \p{Cf}  format characters, which are invisible or reorder text: zero-width space, word joiner and the invisible
//           operators U+2060 to U+2064, the bidi marks and isolates, the Arabic letter mark U+061C, soft hyphen U+00AD,
//           U+180E, BOM U+FEFF, the interlinear annotation marks, and the assigned tag characters
//   \p{Zl}\p{Zp}  line and paragraph separators
//   \p{Cs}  a lone surrogate: not valid text, and JSON-encoded it makes GitHub answer 422 and fail the whole review
//   U+E0000 to U+E007F  the whole tag block, its unassigned code points too (invisible text)
// U+200C and U+200D (zero-width non-joiner and joiner) are the one exception inside \p{Cf}: file names in Persian and
// several Indic scripts need them. The cost is that a path can still carry one of those two invisible joiners.
const PATH_UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\u{E0000}-\u{E007F}]/u;
const PATH_JOINERS = /[\u200c\u200d]/g;

/**
 * Whether `path` is a relative path of the repository by structure: not blank, no control or invisible character, no
 * leading slash, and no empty, `.` or `..` segment. The length bound is the caller's (a finding allows 300, a review
 * comment 1024). The finding parser, the thread input and the review-comment input all use this one check, so what one
 * accepts the others do not refuse (#719).
 */
export function isRepoPath(path: string): boolean {
  return path.trim() !== '' && !PATH_UNSEEN.test(path.replace(PATH_JOINERS, '')) && !path.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function parsePath(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_CHARS || !isRepoPath(raw)) {
    return malformed(`${what} must be a relative path of the repository`);
  }
  return raw;
}

function parseFinding(raw: unknown, index: number): Finding {
  const finding = record(raw, `findings[${index}]`);
  const line = finding.get('line');
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1 || line > MAX_LINE) {
    return malformed(`findings[${index}].line must be a positive whole number`);
  }
  return {
    path: parsePath(finding.get('path'), `findings[${index}].path`),
    line,
    body: text(finding.get('body'), `findings[${index}].body`, MAX_COMMENT_CHARS),
  };
}

/** Parses the reviewer's file. `content` is read by the caller, which has already refused a file over the byte bound. */
export function parseReviewerOutput(content: string): ReviewerOutput {
  const top = record(parseJson(content), 'the file');
  const accepted = array(top.get('acceptedThreadIds') ?? [], 'acceptedThreadIds', MAX_ACCEPTED).map((id, index) => {
    if (typeof id !== 'string' || !THREAD_ID.test(id)) {
      return malformed(`acceptedThreadIds[${index}] must be a thread id`);
    }
    return id;
  });
  return {
    summary: text(top.get('summary'), 'summary', MAX_SUMMARY_CHARS),
    findings: array(top.get('findings') ?? [], 'findings', MAX_FINDINGS).map(parseFinding),
    acceptedThreadIds: [...new Set(accepted)],
  };
}

export function parseFixerOutput(content: string): FixerOutput {
  const top = record(parseJson(content), 'the file');
  const replies = array(top.get('replies') ?? [], 'replies', MAX_REPLIES).map((raw, index): FixerReply => {
    const reply = record(raw, `replies[${index}]`);
    const threadId = reply.get('threadId');
    if (typeof threadId !== 'string' || !THREAD_ID.test(threadId)) {
      return malformed(`replies[${index}].threadId must be a thread id`);
    }
    return { threadId, body: text(reply.get('body'), `replies[${index}].body`, MAX_COMMENT_CHARS) };
  });
  return { replies };
}

// ---- input ----------------------------------------------------------------------------------------------------

const SHA = /^[0-9a-f]{40}$/;
const BASE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

function wholeNumber(raw: unknown, name: string, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) {
    throw new InvalidReviewInputError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return raw;
}

function absolute(raw: unknown, name: string): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.length > 1024 || raw.includes('\0')) {
    throw new InvalidReviewInputError(`${name} must be an absolute path`);
  }
  return raw;
}

/** Parses the input of a review activity. The message never quotes a value. */
export function parseReviewStepInput(raw: unknown): ReviewStepInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidReviewInputError('input must be an object');
  }
  const from = new Map(Object.entries(raw));
  const base = from.get('base');
  const headSha = from.get('headSha');
  const accepted = from.get('acceptedThreadIds');
  if (typeof base !== 'string' || !BASE_REF.test(base) || base.includes('..') || base.includes('//') || base.endsWith('/') || base.endsWith('.lock')) {
    throw new InvalidReviewInputError('base must be a plain branch name');
  }
  if (typeof headSha !== 'string' || !SHA.test(headSha)) {
    throw new InvalidReviewInputError('headSha must be a 40 character commit id');
  }
  if (!Array.isArray(accepted) || accepted.length > MAX_ACCEPTED) {
    throw new InvalidReviewInputError('acceptedThreadIds must be a list of thread ids');
  }
  const ids: unknown[] = accepted;
  const acceptedThreadIds = ids.map((id) => {
    if (typeof id !== 'string' || !THREAD_ID.test(id)) {
      throw new InvalidReviewInputError('acceptedThreadIds must be a list of thread ids');
    }
    return id;
  });
  let hostFailure: HostFailureSummary | undefined;
  try {
    hostFailure = parseHostFailureSummary(from.get('hostFailure'));
  } catch {
    throw new InvalidReviewInputError('hostFailure has the wrong shape');
  }
  const bodySource = from.get('bodySource');
  if (bodySource !== undefined && bodySource !== 'session' && bodySource !== 'fallback' && bodySource !== 'unknown') {
    throw new InvalidReviewInputError('bodySource must be session, fallback or unknown');
  }
  return {
    pr: wholeNumber(from.get('pr'), 'pr', 1, 999_999_999),
    issue: wholeNumber(from.get('issue'), 'issue', 1, 999_999_999),
    repoDir: absolute(from.get('repoDir'), 'repoDir'),
    worktreeDir: absolute(from.get('worktreeDir'), 'worktreeDir'),
    base,
    headSha,
    round: wholeNumber(from.get('round'), 'round', 0, 100),
    acceptedThreadIds,
    ...(hostFailure === undefined ? {} : { hostFailure }),
    ...(bodySource === undefined ? {} : { bodySource }),
  };
}
