import Fuzzysort from 'fuzzysort';
import { LogseqClient } from '../client.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import { AmbiguousPageError, PageNotFoundError, isInfrastructureError } from '../errors.js';
import type { PageCandidate, PageEntity, PageMatchReason, ResultWarning } from '../types.js';

/** Most candidates listed for an ambiguous name; the rest are only counted. */
export const MAX_CANDIDATES = 10;

/** How many "did you mean" names a not-found message carries. */
const MAX_SUGGESTIONS = 3;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Turn an ISO date (`2025-01-01`) into a LogSeq journal day (`20250101`).
 * Returns null for anything else, including impossible dates (`2025-02-30`),
 * which are then treated as ordinary page names.
 */
export function isoDateToJournalDay(input: string): number | null {
  const match = ISO_DATE.exec(input.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return year * 10000 + month * 100 + day;
}

/** A name that resolved to exactly one page. */
export interface ResolvedPage {
  /** The page as pulled by Datalog (`pull [*]`, kebab-case keys) */
  page: any;
  /** Lowercased `:block/name` of the page */
  name: string;
  originalName: string;
  matchedBy: PageMatchReason;
  /**
   * The name to hand to follow-up calls. For an exact match it is the caller's
   * own text (so default behaviour is unchanged); otherwise the resolved page's name.
   */
  lookupName: string;
}

export type PageResolution =
  | ({ kind: 'found' } & ResolvedPage)
  | { kind: 'ambiguous'; candidates: PageCandidate[]; totalCandidates: number }
  | { kind: 'not_found' };

type Row = [any, string | undefined];

const nameOf = (page: any): string => String(page?.name ?? '').toLowerCase();
const originalNameOf = (page: any): string => page?.['original-name'] ?? page?.originalName ?? page?.name ?? '';
const idOf = (page: any): unknown => page?.id ?? page?.['db/id'];

/** Pages from rows, one per entity, ordered by name so output never depends on row order. */
function distinctPages(pages: any[]): any[] {
  const seen = new Set<unknown>();
  const out: any[] = [];
  for (const page of pages) {
    const key = idOf(page) ?? nameOf(page);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(page);
  }
  return out.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
}

function found(page: any, matchedBy: PageMatchReason, lookupName: string): PageResolution {
  return { kind: 'found', page, name: nameOf(page), originalName: originalNameOf(page), matchedBy, lookupName };
}

function pick(pages: any[], matchedBy: PageMatchReason, reason: string): PageResolution {
  if (pages.length === 1) return found(pages[0], matchedBy, nameOf(pages[0]));
  const candidates: PageCandidate[] = pages.slice(0, MAX_CANDIDATES).map(page => ({
    name: nameOf(page),
    originalName: originalNameOf(page),
    matchedBy,
    reason: reason
  }));
  return { kind: 'ambiguous', candidates, totalCandidates: pages.length };
}

/**
 * Resolve a page name to one page, or to the candidates when it is ambiguous.
 *
 * One Datalog query covers three routes; only if all three find nothing is a
 * second query run (the namespace-leaf lookup), so an exact match, an alias and
 * an ISO date each cost one API call. Order, first hit wins:
 *
 * 1. **Exact name** (`:block/name`, case-insensitive). It wins even when other
 *    pages alias the same name, with one exception: a *bare alias target*.
 *    `alias:: Bob` on a page makes LogSeq create an empty stub page "bob" (no
 *    file, no blocks), so a stub that other pages alias is not a real page and
 *    the alias sources are used instead.
 * 2. **Alias.** The page(s) whose `:block/alias` points at the name. One source
 *    resolves to it; several are ambiguous.
 * 3. **ISO date** (`2025-01-01`): the journal page with that `:block/journal-day`,
 *    whatever the graph's journal title format is.
 * 4. **Namespace leaf**: `atlas` finds `projects/atlas`. One page resolves to it;
 *    several are ambiguous.
 *
 * Infrastructure errors (connection, timeout, auth) propagate untouched.
 */
export async function resolvePage(client: LogseqClient, input: string): Promise<PageResolution> {
  const name = input.trim();
  const journalDay = isoDateToJournalDay(name);

  const { query, inputs } =
    journalDay === null
      ? DatalogQueryBuilder.resolvePage(name)
      : DatalogQueryBuilder.resolvePage(name, journalDay);
  const rows = (await client.executeDatalogQuery<Row[]>(query, ...inputs)) || [];

  // A row without a `via` is a plain page row, i.e. an exact match
  const byRoute = (via: string) => rows.filter(([, v]) => (v ?? 'name') === via).map(([page]) => page);
  const exact = byRoute('name')[0];
  const aliasSources = distinctPages(byRoute('alias')).filter(page => !exact || idOf(page) !== idOf(exact));
  const journals = distinctPages(byRoute('journal-date'));

  if (exact) {
    // A stub is a page nobody wrote: no file. Real pages keep the name.
    const isBareAliasTarget = aliasSources.length > 0 && exact.file == null;
    return isBareAliasTarget
      ? pick(aliasSources, 'alias', `declares alias ${JSON.stringify(name)}`)
      : found(exact, 'name', name);
  }
  if (aliasSources.length > 0) return pick(aliasSources, 'alias', `declares alias ${JSON.stringify(name)}`);
  if (journals.length > 0) return pick(journals, 'journal-date', `journal page for ${name}`);

  // Last resort, and only for names that are not dates
  if (journalDay === null) {
    const leaf = DatalogQueryBuilder.namespaceLeafPages(name);
    const leafRows = (await client.executeDatalogQuery<Array<[any]>>(leaf.query, ...leaf.inputs)) || [];
    const leaves = distinctPages(leafRows.map(([page]) => page));
    if (leaves.length > 0) return pick(leaves, 'namespace-leaf', `namespace page ending in ${JSON.stringify(`/${name}`)}`);
  }

  return { kind: 'not_found' };
}

/**
 * Closest page names for a missing page, best first. Best-effort: when the page
 * list can't be fetched the suggestions are just empty, but connection, timeout
 * and auth errors propagate. Costs one `getAllPages` call.
 */
export async function suggestPages(client: LogseqClient, input: string): Promise<string[]> {
  if (isoDateToJournalDay(input) !== null) return []; // fuzzy-matching a date finds nothing useful
  try {
    const allPages = await client.callAPI<PageEntity[]>('logseq.Editor.getAllPages', []);
    if (!allPages || allPages.length === 0) return [];
    return Fuzzysort.go(input, allPages, {
      key: 'originalName',
      limit: MAX_SUGGESTIONS,
      threshold: -10000 // Be lenient with matching
    }).map(match => match.obj.originalName);
  } catch (error) {
    if (isInfrastructureError(error)) throw error;
    return [];
  }
}

/**
 * Resolve a name that must be a page. Returns the one page, or throws:
 * - {@link AmbiguousPageError} when several pages match (nothing is picked);
 * - {@link PageNotFoundError} with the closest names when none does.
 */
export async function requirePage(client: LogseqClient, input: string): Promise<ResolvedPage> {
  const resolution = await resolvePage(client, input);
  switch (resolution.kind) {
    case 'found':
      return resolution;
    case 'ambiguous':
      throw new AmbiguousPageError(input, resolution.candidates, resolution.totalCandidates);
    case 'not_found':
      throw new PageNotFoundError(input, await suggestPages(client, input));
  }
}

/**
 * Optional field a tool adds to its result when the name was not an exact
 * match, so the caller sees which page it actually got. Absent for exact
 * matches, so default output is unchanged.
 */
export interface ResolvedFrom {
  resolvedFrom?: { name: string; matchedBy: PageMatchReason };
}

export function resolvedFrom(input: string, resolved: ResolvedPage): ResolvedFrom {
  return resolved.matchedBy === 'name' ? {} : { resolvedFrom: { name: input, matchedBy: resolved.matchedBy } };
}

/** What the MCP layer returns for an {@link AmbiguousPageError}: a result, not an error. */
export interface AmbiguousPageResult {
  ambiguous: true;
  pageName: string;
  candidates: PageCandidate[];
  totalCandidates: number;
  hasMore: false;
  warnings: ResultWarning[];
}

export function ambiguousPageResult(error: AmbiguousPageError): AmbiguousPageResult {
  return {
    ambiguous: true,
    pageName: error.pageName,
    candidates: error.candidates,
    totalCandidates: error.totalCandidates,
    hasMore: false,
    warnings: [ambiguousPageWarning(error)]
  };
}

/** The `ambiguous_page` warning. It has no `howToFetchAll`, so it never sets `hasMore`. */
export function ambiguousPageWarning(error: AmbiguousPageError): ResultWarning {
  return { code: 'ambiguous_page', message: error.message };
}
