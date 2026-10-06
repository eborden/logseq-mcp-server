import { LogseqClient } from '../client.js';
import { InvalidParameterError } from '../errors.js';
import type { ResultMeta, ResultWarning } from '../types.js';
import { buildResultMeta } from '../utils/result-meta.js';
import { resolveLinkTargets } from '../utils/resolve-page.js';

/**
 * The concept-linking safety gate (#146), run in the server instead of
 * `skills/logseq-skills/scripts/check-link-safety.sh`. Each check matches the
 * script's, regex for regex, with one addition (check 4) the script lacks:
 *
 * 1. **Prose preserved:** stripping `[[ ]]` from both texts leaves them identical.
 * 2. **Brackets balanced:** as many `[[` as `]]`, and no `[[` opened inside another
 *    on the same line.
 * 3. **Refs resolve:** every `[[term]]` in `after` names a page or an alias, file-less
 *    pages included, through the shared resolver in one Datalog query.
 * 4. **Refs preserved:** every `[[term]]` in `before` is still a ref in `after`, as
 *    many times. Check 1 strips brackets from both sides, so un-bracketing an
 *    existing ref passes it; this one catches that.
 *
 * Read-only: it reads page names, never writes. It cannot see judgement errors
 * (a link to the wrong person, a name split into a ref and a leftover surname).
 */

/** Most characters `before` or `after` may hold, about 12k tokens each. A journal day or page file is well under. */
export const MAX_TEXT_CHARS = 50_000;

/** Most distinct `[[terms]]` one call resolves. More is rejected before any LogSeq call. */
export const MAX_LINK_TERMS = 500;

/** Characters of context an excerpt keeps before and after the position it points at. */
const EXCERPT_BEFORE = 30;
const EXCERPT_AFTER = 50;

/**
 * A `[[term]]` with no bracket inside it, on one line. The script's
 * `\[\[([^\[\]]+)\]\]`, which perl and grep apply one line at a time.
 */
const LINK = /\[\[([^\[\]\n]+)\]\]/g;
/** A `[[` opened before the previous one on the same line closed: the script's `\[\[[^][]*\[\[`. */
const NESTED = /\[\[[^\[\]\n]*\[\[/;

/** Where the stripped texts first differ. Excerpts are of the texts with brackets removed. */
export interface ProseDifference {
  /** 1-based line of the first difference */
  line: number;
  /** 1-based column on that line, in characters (code points) */
  column: number;
  /** That stretch of `before`, brackets removed */
  before: string;
  /** That stretch of `after`, brackets removed */
  after: string;
}

export interface ProseCheck {
  ok: boolean;
  /** Absent when the prose is preserved */
  firstDifference?: ProseDifference;
}

export interface BracketCheck {
  ok: boolean;
  /** `[[` in `after` */
  opens: number;
  /** `]]` in `after` */
  closes: number;
  /** The first line where a `[[` opens inside another; absent when nothing nests */
  nested?: { line: number; excerpt: string };
}

export interface ResolvedRef {
  /** The term as written between the brackets */
  term: string;
  /** The page it reaches, in its original casing */
  page: string;
  /** `alias` when the term is another page's `alias::` value */
  matchedBy: 'name' | 'alias';
}

export interface AmbiguousRef {
  term: string;
  /** Original names of the pages that declare it as an alias, at most 10 */
  candidates: string[];
  totalCandidates: number;
  /**
   * True when `before` already linked it and the pass added no copies (as many
   * refs to it in `after` as in `before`, counted case-insensitively). Such a ref
   * is reported but doesn't fail the check: the pass didn't add it and can't
   * remove it (check 4). A new copy fails, since its mention may mean another page.
   */
  preexisting: boolean;
}

export interface RefCheck {
  ok: boolean;
  resolved: ResolvedRef[];
  /** Terms that name no page or alias. Linking one would create a page */
  unresolved: string[];
  ambiguous: AmbiguousRef[];
}

export interface RemovedRef {
  term: string;
  /** Times `[[term]]` appears in `before` */
  before: number;
  /** Times it appears in `after`, fewer than in `before` */
  after: number;
}

export interface RefsPreservedCheck {
  ok: boolean;
  removed: RemovedRef[];
}

export interface CheckLinksResult extends ResultMeta {
  /** True only when all four checks pass */
  ok: boolean;
  prose: ProseCheck;
  brackets: BracketCheck;
  refs: RefCheck;
  refsPreserved: RefsPreservedCheck;
}

/** Strip `[[term]]` to `term`, one pass, as the script's `s/\[\[([^\[\]]+)\]\]/$1/g`. */
function stripBrackets(text: string): string {
  return text.replace(LINK, '$1');
}

function countOf(text: string, token: '[[' | ']]'): number {
  return text.split(token).length - 1;
}

/** Each `[[term]]` in the text, as written, with how many times it appears. */
function linkCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(LINK)) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  return counts;
}

const keyOf = (term: string) => term.trim().toLowerCase();

/** Refs per page name (`keyOf` of each term), however each copy is spelled. */
function keyCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [term, count] of linkCounts(text)) counts.set(keyOf(term), (counts.get(keyOf(term)) ?? 0) + count);
  return counts;
}

/** The stretch of the line around `index`, cut to the excerpt window, in whole code points. */
function excerpt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const end = text.indexOf('\n', index);
  const head = Array.from(text.slice(start, index));
  const tail = Array.from(text.slice(index, end === -1 ? undefined : end));
  const left = head.length > EXCERPT_BEFORE ? `...${head.slice(-EXCERPT_BEFORE).join('')}` : head.join('');
  const right = tail.length > EXCERPT_AFTER ? `${tail.slice(0, EXCERPT_AFTER).join('')}...` : tail.join('');
  return left + right;
}

/** 1-based line and code-point column of `index`. */
function position(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  const lineStart = before.lastIndexOf('\n') + 1;
  return { line: before.split('\n').length, column: Array.from(before.slice(lineStart)).length + 1 };
}

/** Check 1. */
export function checkProse(before: string, after: string): ProseCheck {
  const a = stripBrackets(before);
  const b = stripBrackets(after);
  if (a === b) return { ok: true };
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  // Never point into the middle of a surrogate pair
  if (i > 0 && /[\uD800-\uDBFF]/.test(a[i - 1])) i--;
  return { ok: false, firstDifference: { ...position(a, i), before: excerpt(a, i), after: excerpt(b, i) } };
}

/** Check 2. */
export function checkBrackets(after: string): BracketCheck {
  const opens = countOf(after, '[[');
  const closes = countOf(after, ']]');
  const nestedAt = after.search(NESTED);
  const result: BracketCheck = { ok: opens === closes && nestedAt === -1, opens, closes };
  if (nestedAt !== -1) result.nested = { line: position(after, nestedAt).line, excerpt: excerpt(after, nestedAt) };
  return result;
}

/** Check 4. */
export function checkRefsPreserved(before: string, after: string): RefsPreservedCheck {
  const kept = linkCounts(after);
  const removed: RemovedRef[] = [];
  for (const [term, count] of linkCounts(before)) {
    const left = kept.get(term) ?? 0;
    if (left < count) removed.push({ term, before: count, after: left });
  }
  removed.sort((x, y) => (x.term < y.term ? -1 : x.term > y.term ? 1 : 0));
  return { ok: removed.length === 0, removed };
}

/**
 * Run the linking gate over `before` and `after` (#146).
 *
 * Calls: one Datalog query for all the distinct `[[terms]]` in `after`, however
 * many there are, and none when it has no terms. Never one call per term.
 *
 * @param client - LogseqClient instance
 * @param before - The text before the linking pass
 * @param after - The same text with `[[brackets]]` added
 * @returns Each check's outcome, `ok` for all four, and meta: `totals` counts the
 *   refs on each side and the distinct terms; a warning says when resolution could
 *   not run (LogSeq answered `null`) or a candidate list was cut
 * @throws InvalidParameterError if `after` has more than {@link MAX_LINK_TERMS} distinct terms
 */
export async function checkLinks(client: LogseqClient, before: string, after: string): Promise<CheckLinksResult> {
  const prose = checkProse(before, after);
  const brackets = checkBrackets(after);
  const refsPreserved = checkRefsPreserved(before, after);

  const terms = [...linkCounts(after).keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const distinctKeys = new Set(terms.map(keyOf));
  if (distinctKeys.size > MAX_LINK_TERMS) {
    throw new InvalidParameterError(
      'after',
      `${distinctKeys.size} distinct [[terms]]`,
      `at most ${MAX_LINK_TERMS} distinct [[terms]]. Check the text in parts`
    );
  }
  // Preexisting: linked before, and no copy added (check 4 rules out fewer)
  const refsBefore = keyCounts(before);
  const refsAfter = keyCounts(after);
  const preexisting = (term: string) => {
    const was = refsBefore.get(keyOf(term)) ?? 0;
    return was > 0 && (refsAfter.get(keyOf(term)) ?? 0) <= was;
  };

  const { resolutions, unavailable } = await resolveLinkTargets(client, terms);
  const warnings: ResultWarning[] = [];
  const refs: RefCheck = { ok: true, resolved: [], unresolved: [], ambiguous: [] };

  if (unavailable) {
    warnings.push({
      code: 'refs_unchecked',
      message:
        `LogSeq returned no answer for the ${terms.length} [[terms]], so none could be checked. ` +
        'This is not the same as missing pages: check that a graph is open and call again.',
    });
  } else {
    for (const term of terms) {
      const resolution = resolutions.get(keyOf(term)) ?? { kind: 'not_found' as const };
      if (resolution.kind === 'found') {
        refs.resolved.push({ term, page: resolution.originalName, matchedBy: resolution.matchedBy === 'alias' ? 'alias' : 'name' });
      } else if (resolution.kind === 'ambiguous') {
        refs.ambiguous.push({
          term,
          candidates: resolution.candidates.map(c => c.originalName),
          totalCandidates: resolution.totalCandidates,
          preexisting: preexisting(term),
        });
        if (resolution.totalCandidates > resolution.candidates.length) {
          warnings.push({
            code: 'candidates_truncated',
            message:
              `[[${term}]] is an alias of ${resolution.totalCandidates} pages. Showing ${resolution.candidates.length}, ` +
              "the most this lists; the rest can't be fetched in one call.",
          });
        }
      } else {
        refs.unresolved.push(term);
      }
    }
  }
  refs.ok = !unavailable && refs.unresolved.length === 0 && refs.ambiguous.every(a => a.preexisting);

  return {
    ok: prose.ok && brackets.ok && refs.ok && refsPreserved.ok,
    prose,
    brackets,
    refs,
    refsPreserved,
    ...buildResultMeta(warnings, {
      refsBefore: countOf(before, '[['),
      refsAfter: brackets.opens,
      terms: terms.length,
    }),
  };
}
