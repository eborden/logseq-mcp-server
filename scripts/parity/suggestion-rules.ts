// The closest-name rules of ADR-0032 (closest-page-suggestions-match-by-meaning), Decision 3 (#335). The
// list of names after `Closest:` in a page-not-found message is held to rules, not bytes, for any server
// other than the TypeScript one, which keeps comparing its bytes with its record exactly.
//
// This file is the checker and nothing else: the harness (harness.ts) decides when to run it. The
// words below are the ADR's: the reference is the TypeScript server's recorded result for a case; the
// candidates are the `originalName` strings of the stubbed `logseq.Editor.getAllPages` answer; `fold`
// is trim, Unicode NFD, drop combining marks, lowercase; E, P, T and N are the sets the ADR names.
import type { CannedCall } from './stub-logseq.js';
import type { ToolResult } from './harness.js';

/** The fixed sentence that closes every page-not-found message (`PageNotFoundError`, src/errors.ts). */
export const GUIDANCE = 'Try logseq_search_blocks to find it by content, or logseq_list_pages (name_contains) to browse names.';

/** `fold(s)`: trim, Unicode NFD, drop combining marks, lowercase. A second implementation doesn't need it. */
export const fold = (s: string): string => s.trim().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The input's tokens: its fold split on spaces, empty pieces dropped. */
export const tokensOf = (input: string): string[] => fold(input).split(' ').filter(t => t !== '');

/** A name covers a token when the token's characters appear in order, not necessarily next to each other, in its fold. */
function covers(foldedName: string, token: string): boolean {
  const wanted = Array.from(token);
  let at = 0;
  for (const ch of Array.from(foldedName)) {
    if (at < wanted.length && ch === wanted[at]) at++;
  }
  return at === wanted.length;
}

/** The ADR's sets over the (distinct) candidates for one input. */
export interface Matches {
  /** Candidates whose fold equals the input's fold */
  exact: string[];
  /** Candidates whose fold starts with the input's fold and isn't equal to it */
  prefix: string[];
  /** E and P together */
  both: string[];
  /** Candidates that cover every token of the input */
  covering: string[];
}

export function matchesOf(input: string, candidates: readonly string[]): Matches {
  const names = [...new Set(candidates)].filter(name => name !== '');
  const wanted = fold(input);
  const tokens = tokensOf(input);
  const exact = names.filter(name => fold(name) === wanted);
  const prefix = names.filter(name => fold(name) !== wanted && fold(name).startsWith(wanted));
  const covering = names.filter(name => tokens.every(token => covers(fold(name), token)));
  return { exact, prefix, both: [...exact, ...prefix], covering };
}

/** A page-not-found message, read the way the ADR says: the frame, and the list between its edges. */
export interface NotFoundMessage {
  /** Everything up to and including `Closest: ` (a `MCP error <code>: ` prefix of a JSON-RPC error included), or up to `No page <json>.` with no list */
  opening: string;
  /** The input, decoded */
  input: string;
  /** The text of the list; absent when the message has none */
  list?: string;
}

const CLOSING = `. ${GUIDANCE}`;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The JSON-RPC errors the MCP client throws carry `MCP error <code>: ` in front, more than once
const NOT_FOUND = new RegExp(
  `^((?:MCP error -?\\d+: )*No page ("(?:[^"\\\\]|\\\\.)*")\\.)(?: Closest: ([\\s\\S]+)\\.)? ${escapeRegExp(GUIDANCE)}$`
);

/** Read a message as a page-not-found message, or undefined when it isn't one. */
export function parseNotFound(message: string): NotFoundMessage | undefined {
  const m = NOT_FOUND.exec(message);
  if (!m) return undefined;
  let input: unknown;
  try {
    input = JSON.parse(m[2]);
  } catch {
    return undefined;
  }
  if (typeof input !== 'string') return undefined;
  return m[3] === undefined ? { opening: m[1], input } : { opening: `${m[1]} Closest: `, input, list: m[3] };
}

/**
 * Every way to read a list as one to three distinct candidates joined by `, `, trying the longest name
 * first and backing up when a choice leaves the rest unreadable (names can contain `, `). The first is the
 * split rules 4 to 6 use. It stops at two, which is all anyone needs to know ("is it unique").
 */
export function splitList(list: string, candidates: readonly string[]): string[][] {
  const names = [...new Set(candidates)].filter(name => name !== '').sort((a, b) => b.length - a.length);
  const found: string[][] = [];
  const walk = (start: number, chosen: string[]): void => {
    if (found.length >= 2 || chosen.length === 3) return;
    for (const name of names) {
      if (!list.startsWith(name, start) || chosen.includes(name)) continue;
      const end = start + name.length;
      if (end === list.length) found.push([...chosen, name]);
      else if (list.startsWith(', ', end)) walk(end + 2, [...chosen, name]);
      if (found.length >= 2) return;
    }
  };
  walk(0, []);
  return found;
}

const show = (names: readonly string[]): string => (names.length === 0 ? 'none' : names.map(n => JSON.stringify(n)).join(', '));

/** Rules 3 to 6 for a list, for an input and the candidates. Empty when the list passes. */
export function checkList(list: string, input: string, candidates: readonly string[]): string[] {
  const splits = splitList(list, candidates);
  if (splits.length === 0) {
    return [`rule 3: the closest names ${JSON.stringify(list)} are not one to three distinct candidates joined by ", "`];
  }
  const names = splits[0];
  const failures: string[] = [];
  const { exact, prefix, both, covering } = matchesOf(input, candidates);

  // Rule 4: exact and prefix first, exact before prefix (skipped for an input that folds to nothing)
  if (fold(input) !== '') {
    const k = Math.min(3, both.length);
    const head = names.slice(0, k);
    if (head.length < k || head.some(name => !both.includes(name))) {
      failures.push(
        `rule 4: the first ${k} name(s) must be exact or prefix matches of ${JSON.stringify(input)} (${show(both)}), got ${show(names)}`
      );
    }
    names.forEach((name, at) => {
      if (!prefix.includes(name)) return;
      const late = exact.filter(e => !names.slice(0, at).includes(e));
      if (late.length > 0) failures.push(`rule 4: the prefix match ${JSON.stringify(name)} is listed before the exact match ${show(late)}`);
    });
  }

  // Rule 5: every listed name covers every token
  const stray = names.filter(name => !covering.includes(name));
  if (stray.length > 0) failures.push(`rule 5: ${show(stray)} does not cover every word of ${JSON.stringify(input)}`);

  // Rule 6: as many names as there are to list, up to three
  const wanted = Math.min(3, covering.length);
  if (names.length < wanted) failures.push(`rule 6: ${names.length} name(s) listed, ${wanted} cover ${JSON.stringify(input)}: ${show(covering)}`);
  return failures;
}

/**
 * Check one page-not-found message against the reference's: rules 1 and 2 on the frame, and rules 3 to 6
 * on the list when the reference has one. Empty when the message passes. The list's edges come from the
 * reference's frame (the ADR's rule 1), so a name that contains `. Try` or ends with a full stop moves
 * nothing.
 */
export function checkSuggestionRules(reference: string, message: string, candidates: readonly string[]): string[] {
  const ref = parseNotFound(reference);
  if (!ref) throw new Error(`not a page-not-found message: ${JSON.stringify(reference)}`);
  if (ref.list === undefined) {
    if (message === reference) return [];
    // The message with a list in it has the reference's opening, a list, and its closing
    const listed = `${ref.opening} Closest: `;
    return message.startsWith(listed) && message.endsWith(CLOSING)
      ? ['rule 2: the reference lists no closest names, this message does']
      : [`rule 1: the message differs from the reference's outside the list\n  expected: ${JSON.stringify(reference)}\n  actual:   ${JSON.stringify(message)}`];
  }
  const { opening } = ref;
  if (message.length >= opening.length + CLOSING.length && message.startsWith(opening) && message.endsWith(CLOSING)) {
    const list = message.slice(opening.length, message.length - CLOSING.length);
    return list === '' ? ['rule 3: the closest names are empty'] : checkList(list, ref.input, candidates);
  }
  if (message === `${ref.opening.slice(0, -' Closest: '.length)} ${GUIDANCE}`) {
    return ['rule 2: the reference lists closest names, this message lists none'];
  }
  return [`rule 1: the message differs from the reference's outside the list\n  expected: ${JSON.stringify(opening)} ... ${JSON.stringify(CLOSING)}\n  actual:   ${JSON.stringify(message)}`];
}

/** The reference's own list has to pass rules 3 to 6, and be read one way only, before it is recorded. */
export function checkReferenceList(reference: string, candidates: readonly string[]): string[] {
  const ref = parseNotFound(reference);
  if (!ref || ref.list === undefined) return [];
  const failures = checkList(ref.list, ref.input, candidates);
  if (splitList(ref.list, candidates).length > 1) failures.push('rule 3: the list can be split into names in two ways, so it can not be recorded');
  return failures;
}

// ---- where a message sits in a result

/** A page-not-found message in a result: a tool result's content block (`{"error": ...}` JSON), or a JSON-RPC error. */
export type Site = { kind: 'tool'; index: number } | { kind: 'error' };

export const describeSite = (site: Site): string => (site.kind === 'tool' ? `content[${site.index}] error` : 'error message');

/** The decoded message at a site, or undefined when the result has none there. */
export function readMessage(result: ToolResult, site: Site): string | undefined {
  if (site.kind === 'error') {
    const error = result.error;
    const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
    return typeof message === 'string' ? message : undefined;
  }
  const text = Array.isArray(result.content) ? result.content[site.index]?.text : undefined;
  if (typeof text !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const keys = Object.keys(parsed);
    const message = (parsed as { error?: unknown }).error;
    return keys.length === 1 && typeof message === 'string' ? message : undefined;
  } catch {
    return undefined;
  }
}

/** A copy of a result with the message at a site replaced, serialized as the TypeScript server does (minified). */
export function withMessage(result: ToolResult, site: Site, message: string): ToolResult {
  const copy = structuredClone(result);
  if (site.kind === 'error') (copy.error as { message: string }).message = message;
  else copy.content![site.index].text = JSON.stringify({ error: message });
  return copy;
}

/** Every place in a reference result that holds a page-not-found message. */
export function notFoundSites(reference: ToolResult): Site[] {
  const sites: Site[] = [];
  const blocks = Array.isArray(reference.content) ? reference.content.length : 0;
  for (let index = 0; index < blocks; index++) sites.push({ kind: 'tool', index });
  sites.push({ kind: 'error' });
  return sites.filter(site => {
    const message = readMessage(reference, site);
    return message !== undefined && parseNotFound(message) !== undefined;
  });
}

/** Whether a reference result holds a page-not-found message with a list of closest names, the kind the rules judge. */
export const hasClosestList = (reference: ToolResult): boolean =>
  notFoundSites(reference).some(site => parseNotFound(readMessage(reference, site)!)?.list !== undefined);

/** The candidates of a case: the `originalName` strings of its `getAllPages` answers, strings only, as `suggestPages` reads them. */
export function candidatesOf(steps: readonly CannedCall[][]): string[] {
  const names: string[] = [];
  for (const call of steps.flat()) {
    if (call.method !== 'logseq.Editor.getAllPages' || !Array.isArray(call.response)) continue;
    for (const page of call.response as unknown[]) {
      const name = page && typeof page === 'object' ? (page as { originalName?: unknown }).originalName : undefined;
      if (typeof name === 'string') names.push(name);
    }
  }
  return [...new Set(names)];
}

// ---- the recorded set has to exercise the rules (ADR-0032 Decision 3)

/** What a recorded case needs for the minimum set, in the order the ADR lists them. */
export const REQUIRED_CASES = [
  'an exact hit (E and P both non-empty)',
  'a prefix hit (E empty, P non-empty)',
  'more than three exact or prefix matches',
  'a typo with no prefix match and at least one covering name',
  'no suggestion: an ISO date',
  'no suggestion: an input no candidate covers',
  'a listed name that contains ", "',
  "the page resource's error"
] as const;

export interface RecordedCase {
  name: string;
  steps: readonly CannedCall[][];
  /** Set for a `resources/read` case: the URI */
  readResource?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Which of {@link REQUIRED_CASES} one recorded case is. */
export function requiredKindsOf(c: RecordedCase, result: ToolResult): Array<(typeof REQUIRED_CASES)[number]> {
  const kinds: Array<(typeof REQUIRED_CASES)[number]> = [];
  const candidates = candidatesOf(c.steps);
  for (const site of notFoundSites(result)) {
    const ref = parseNotFound(readMessage(result, site)!)!;
    const { exact, prefix, both, covering } = matchesOf(ref.input, candidates);
    const nonEmpty = fold(ref.input) !== '';
    if (ref.list === undefined) {
      if (ISO_DATE.test(ref.input)) kinds.push('no suggestion: an ISO date');
      else if (candidates.length > 0 && covering.length === 0) kinds.push('no suggestion: an input no candidate covers');
      continue;
    }
    if (nonEmpty && exact.length > 0 && prefix.length > 0) kinds.push('an exact hit (E and P both non-empty)');
    if (nonEmpty && exact.length === 0 && prefix.length > 0) kinds.push('a prefix hit (E empty, P non-empty)');
    if (nonEmpty && both.length > 3) kinds.push('more than three exact or prefix matches');
    if (nonEmpty && both.length === 0 && covering.length > 0) kinds.push('a typo with no prefix match and at least one covering name');
    if ((splitList(ref.list, candidates)[0] ?? []).some(name => name.includes(', '))) kinds.push('a listed name that contains ", "');
    if (site.kind === 'error' && c.readResource?.startsWith('logseq://page/')) kinds.push("the page resource's error");
  }
  return kinds;
}

/** Failures for each recorded reference whose closest names break rules 3 to 6 (or can be read two ways). */
export function checkReferenceLists(cases: readonly RecordedCase[], results: Readonly<Record<string, ToolResult>>): string[] {
  const failures: string[] = [];
  for (const c of cases) {
    const result = results[c.name];
    if (!result) continue;
    for (const site of notFoundSites(result)) {
      for (const f of checkReferenceList(readMessage(result, site)!, candidatesOf(c.steps))) {
        failures.push(`[${c.name}] the reference's closest names break ${f}`);
      }
    }
  }
  return failures;
}

/** Failures for the required cases the recorded set lacks (ADR-0032 Decision 3). */
export function missingRequiredCases(cases: readonly RecordedCase[], results: Readonly<Record<string, ToolResult>>): string[] {
  const seen = new Set<string>();
  for (const c of cases) {
    const result = results[c.name];
    if (result) for (const kind of requiredKindsOf(c, result)) seen.add(kind);
  }
  return REQUIRED_CASES.filter(kind => !seen.has(kind)).map(kind => `the recorded cases lack a required closest-names case (ADR-0032): ${kind}`);
}

// ---- the self-check: wrong lists, each of which a rule has to catch

/** The kinds of wrong list the self-check makes, each of which has to apply to some recorded case and be caught in all of them. */
export const WRONG_LIST_LABELS = [
  'a name that is not a candidate',
  'an unrelated name',
  'a wrong frame',
  'no list',
  'a reversed order',
  'a non-match before the exact or prefix hits'
] as const;

/** One way a list can go wrong, as a message to feed the check. */
export interface WrongList {
  label: (typeof WRONG_LIST_LABELS)[number];
  message: string;
}

/**
 * Wrong versions of a reference message with a list: a name that is not a candidate, an unrelated name, the
 * wrong frame, no list, the list in reverse (exact after prefix), and a non-match ahead of a match. A kind
 * that doesn't apply to the case (there is no unrelated candidate, the list is one name long) is left out.
 */
export function wrongLists(reference: string, candidates: readonly string[]): WrongList[] {
  const ref = parseNotFound(reference);
  if (!ref || ref.list === undefined) return [];
  const names = splitList(ref.list, candidates)[0] ?? [];
  const { exact, prefix, both, covering } = matchesOf(ref.input, candidates);
  const make = (list: readonly string[]) => `${ref.opening}${list.join(', ')}${CLOSING}`;
  const wrong: WrongList[] = [
    { label: 'a name that is not a candidate', message: make([`${names[0]} (not a page)`, ...names.slice(1)]) },
    { label: 'a wrong frame', message: `${ref.opening}${names.join(', ')}. Try something else.` },
    { label: 'no list', message: `${ref.opening.slice(0, -' Closest: '.length)} ${GUIDANCE}` }
  ];
  const unrelated = [...new Set(candidates)].find(name => name !== '' && !covering.includes(name));
  if (unrelated !== undefined) wrong.push({ label: 'an unrelated name', message: make([unrelated]) });
  if (exact.length > 0 && prefix.length > 0 && names.includes(exact[0]) && names.includes(prefix[0])) {
    wrong.push({ label: 'a reversed order', message: make([...names].reverse()) });
  }
  const miss = covering.find(name => !both.includes(name));
  if (both.length > 0 && miss !== undefined) wrong.push({ label: 'a non-match before the exact or prefix hits', message: make([miss, ...names.filter(n => n !== miss)].slice(0, 3)) });
  return wrong;
}
