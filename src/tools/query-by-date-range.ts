import { LogseqClient } from '../client.js';
import { PageEntity, BlockEntity, SlimBlock, ResolveRefsMeta } from '../types.js';
import { resolveBlockRefs } from '../utils/resolve-refs.js';
import { buildResultMeta } from '../utils/result-meta.js';
import {
  AliasSet,
  ResolvedAliases,
  aliasIds,
  aliasNames,
  aliasSetWarnings,
  resolveAliasSetByName,
  resolvedAliases
} from '../utils/alias-set.js';
import { InvalidParameterError } from '../errors.js';
import { escapeRegex } from '../utils/escape-regex.js';
import { toSlimBlock } from '../utils/slim-entities.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import { buildBlockTrees, camelizeKeys } from '../utils/block-tree.js';
import { formatLogseqDate } from '../utils/date-utils.js';
import { DATE_PRESETS, isDatePreset, resolveDatePreset } from '../utils/date-presets.js';
import {
  ConceptRef,
  DEFAULT_TOP_CONCEPTS_LIMIT,
  TopConcept,
  extractConceptRefs,
  rollUpTopConcepts
} from '../utils/top-concepts.js';

export type { TopConcept } from '../utils/top-concepts.js';
export { BUILT_IN_CONCEPTS, DEFAULT_TOP_CONCEPTS_LIMIT } from '../utils/top-concepts.js';

/**
 * The `summary` of every result shape. `topConcepts` is the pages most referenced
 * (`:block/refs`) by the returned blocks, nested ones included; it is left out when
 * `topConceptsLimit` is 0.
 */
export interface DateRangeSummary {
  totalDays: number;
  totalBlocks: number;
  searchTerm?: string;
  topConcepts?: TopConcept[];
}

/** `hasMore` / `warnings` are present only when `resolve_refs` is on. */
export interface DateRangeResult extends ResolveRefsMeta, ResolvedAliases {
  dateRange: {
    start: number;
    end: number;
  };
  entries: Array<{
    date: number;
    page: PageEntity;
    blocks: BlockEntity[];
  }>;
  summary: DateRangeSummary;
}

export interface SlimDateRangeResult extends ResolveRefsMeta, ResolvedAliases {
  dateRange: {
    start: number;
    end: number;
  };
  entries: Array<{
    date: number;
    pageName: string;
    blocks: SlimBlock[];
  }>;
  summary: DateRangeSummary;
}

/**
 * `include_content: false` result: dates, block counts and top-level snippets only.
 * `blockCount` counts every block under the matching top-level blocks, nested ones
 * included; `snippets` has one entry per top-level block (its first line, shortened).
 */
export interface OutlineDateRangeResult extends ResolveRefsMeta, ResolvedAliases {
  dateRange: {
    start: number;
    end: number;
  };
  entries: Array<{
    date: number;
    pageName: string;
    blockCount: number;
    snippets: string[];
  }>;
  summary: DateRangeSummary;
}

/**
 * How the caller chose the range. Exactly one of the three groups must be given.
 * Field names mirror the tool's snake_case arguments in camelCase.
 */
export interface DateRangeSelection {
  /** Explicit range: needs both `startDate` and `endDate` (YYYYMMDD) */
  startDate?: number;
  endDate?: number;
  /** The N most recent journal pages that exist, newest first */
  lastN?: number;
  /** A named period such as `last_week` (see `utils/date-presets.ts`) */
  preset?: string;
}

export interface DateRangeOptions extends DateRangeSelection {
  searchTerm?: string;
  /** Slim blocks (ignored when `includeContent` is false). Direct calls default to full (false); the MCP handler defaults to slim via `wantsSlim` (#42) */
  slimResults?: boolean;
  /** `false` returns the outline shape (default true) */
  includeContent?: boolean;
  /** Entries in `summary.topConcepts`, 0 to leave it out (default 10) */
  topConceptsLimit?: number;
  /**
   * Resolve `((uuid))` refs and `{{embed}}`s in the returned blocks, adding
   * `resolvedContent` / `resolvedRefs` (also on slim blocks) and `hasMore` /
   * `warnings` to the result. At most 2 extra Datalog queries however many days.
   * Ignored when `includeContent` is false. Default false.
   */
  resolveRefs?: boolean;
}

/**
 * Whether a top-level block matches `searchTerm` (case-insensitive, literal).
 *
 * When the term is the name of a page that has aliases (#69), a block also
 * matches if it references any page of the group (`#tag` and `[[link]]` forms
 * included), or if its text holds one of the group's other names as a whole
 * word. Only the term itself matches inside a word: a short alias such as `AI`
 * must not match "said". A term that is not a page name, or names a page
 * without aliases, matches exactly as before.
 */
function blockMatcher(searchTerm: string, aliasSet: AliasSet | null): (block: BlockEntity) => boolean {
  const term = searchTerm.toLowerCase();
  const otherNames = (aliasSet ? aliasNames(aliasSet) : []).filter(name => name !== term.trim());
  const wholeWord =
    otherNames.length > 0
      ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${otherNames.map(escapeRegex).join('|')})(?![\\p{L}\\p{N}])`, 'iu')
      : null;
  const pageIds = new Set(aliasSet ? aliasIds(aliasSet) : []);
  return block => {
    const content = (block.content ?? '').toLowerCase();
    if (content.includes(term) || wholeWord?.test(content)) return true;
    return pageIds.size > 0 && (block.refs ?? []).some(ref => pageIds.has(ref?.id));
  };
}

/** The validated, resolved form of a {@link DateRangeSelection}. */
type ResolvedSelection =
  | { mode: 'range'; start: number; end: number }
  | { mode: 'last_n'; count: number; latest: number };

const SNIPPET_LENGTH = 80;

/**
 * Validate date is in YYYYMMDD format
 * @param date - Date in YYYYMMDD format
 * @returns true if valid
 */
function isValidDateFormat(date: number): boolean {
  if (!Number.isInteger(date)) return false;
  const str = date.toString();
  if (str.length !== 8) return false;

  const year = parseInt(str.substring(0, 4));
  const month = parseInt(str.substring(4, 6));
  const day = parseInt(str.substring(6, 8));

  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  return true;
}

const isGiven = (value: unknown): boolean => value !== undefined && value !== null;

/**
 * The one validation path for choosing a range. Exactly one of three groups must be
 * given: explicit dates (`startDate` + `endDate`), `lastN`, or `preset`. Presets are
 * resolved against `now` here, so everything after this sees plain dates.
 * @throws InvalidParameterError for none, for more than one, and for bad values
 */
function resolveSelection(selection: DateRangeSelection, now: Date): ResolvedSelection {
  const { startDate, endDate, lastN, preset } = selection;

  const given: string[] = [];
  if (isGiven(startDate) || isGiven(endDate)) given.push('start_date/end_date');
  if (isGiven(lastN)) given.push('last_n');
  if (isGiven(preset)) given.push('preset');

  if (given.length === 0) {
    throw new InvalidParameterError(
      'date selection',
      'none given',
      'Exactly one of: start_date with end_date, last_n, or preset',
      'last_n: 7, or preset: "last_week", or start_date: 20251115 with end_date: 20251120'
    );
  }
  if (given.length > 1) {
    throw new InvalidParameterError(
      'date selection',
      given.join(' and '),
      'Exactly one of: start_date with end_date, last_n, or preset (not several together)',
      'last_n: 7'
    );
  }

  if (isGiven(lastN)) {
    if (typeof lastN !== 'number' || !Number.isInteger(lastN) || lastN < 1) {
      throw new InvalidParameterError(
        'last_n',
        String(lastN),
        'A whole number of journal pages, 1 or more',
        'last_n: 7'
      );
    }
    return { mode: 'last_n', count: lastN, latest: formatLogseqDate(now) };
  }

  if (isGiven(preset)) {
    if (!isDatePreset(preset)) {
      throw new InvalidParameterError(
        'preset',
        String(preset),
        `One of: ${DATE_PRESETS.join(', ')}`,
        'preset: "last_week"'
      );
    }
    return { mode: 'range', ...resolveDatePreset(preset, now) };
  }

  // Explicit dates
  if (!isGiven(startDate) || !isGiven(endDate)) {
    const missing = isGiven(startDate) ? 'end_date' : 'start_date';
    throw new InvalidParameterError(
      missing,
      'missing',
      'Both start_date and end_date when choosing an explicit range',
      'start_date: 20251115, end_date: 20251120'
    );
  }
  if (!isValidDateFormat(startDate as number)) {
    throw new InvalidParameterError(
      'start_date',
      startDate,
      'Date in YYYYMMDD format (8 digits, valid year/month/day)',
      '20251115 for November 15, 2025'
    );
  }
  if (!isValidDateFormat(endDate as number)) {
    throw new InvalidParameterError(
      'end_date',
      endDate,
      'Date in YYYYMMDD format (8 digits, valid year/month/day)',
      '20251120 for November 20, 2025'
    );
  }
  if ((startDate as number) > (endDate as number)) {
    throw new InvalidParameterError(
      'date_range',
      `${startDate} to ${endDate}`,
      'start_date must be before or equal to end_date',
      'start_date: 20251115, end_date: 20251120'
    );
  }
  return { mode: 'range', start: startDate as number, end: endDate as number };
}

const pageNameOf = (page: PageEntity): string =>
  page.originalName || page['original-name'] || page.name;

/** Number of blocks in these trees, nested ones included. */
function countBlocks(blocks: BlockEntity[]): number {
  return blocks.reduce((sum, block) => sum + 1 + countBlocks(block.children ?? []), 0);
}

/** First line of a block, trimmed and shortened. */
function snippetOf(block: BlockEntity): string {
  const firstLine = (block.content ?? '').split('\n')[0].trim();
  return firstLine.length > SNIPPET_LENGTH
    ? `${firstLine.slice(0, SNIPPET_LENGTH - 3)}...`
    : firstLine;
}

async function fetchPages(
  client: LogseqClient,
  { query, inputs }: { query: string; inputs: unknown[] }
): Promise<PageEntity[]> {
  const rows = await client.executeDatalogQuery<Array<[any]>>(query, ...inputs);
  return (rows || [])
    .map(row => row[0])
    .filter(page => page != null)
    .map(page => camelizeKeys<PageEntity>(page));
}

/**
 * Query journal entries by explicit date range.
 * Kept for callers that already have two dates; it goes through the same
 * validation and query path as {@link queryJournals}.
 * @param client - LogseqClient instance
 * @param startDate - Start date in YYYYMMDD format
 * @param endDate - End date in YYYYMMDD format
 * @param searchTerm - Optional search term to filter blocks
 * @param slimResults - Return slim results (40-50% fewer tokens, essential data only). Direct calls default to full (false); the MCP handler defaults to slim via `wantsSlim` (#42)
 * @returns DateRangeResult or SlimDateRangeResult with journal entries in range
 */
export async function queryByDateRange(
  client: LogseqClient,
  startDate: number,
  endDate: number,
  searchTerm?: string,
  slimResults: boolean = false
): Promise<DateRangeResult | SlimDateRangeResult> {
  return (await queryJournals(client, {
    startDate,
    endDate,
    searchTerm,
    slimResults
  })) as DateRangeResult | SlimDateRangeResult;
}

/**
 * Query journal entries for a range chosen one of three ways: explicit dates,
 * the `lastN` most recent journals, or a named `preset`.
 *
 * API calls: at most 2 whatever the range or N (the concept roll-up in
 * `summary.topConcepts` reads the refs pulled with the blocks, so it adds none).
 *  - explicit dates and presets: journal pages in range, then every block on them
 *  - `lastN`: journal pages up to today (sorted and sliced here), then every block
 *    on the pages that were kept
 * The second call is skipped when no page matched.
 *
 * With a `searchTerm` that names a page with aliases (#69) the search also matches the
 * other names (as whole words) and references to any of them, adds one query (the alias group),
 * and says so in `resolvedAliases`. Any other term is matched literally as before and
 * costs the same one query, which finds no page.
 *
 * Entries are oldest first, except `lastN`, which is newest first. For `lastN`,
 * `dateRange` spans the oldest to the newest page returned (0 to 0 if none), and
 * each full-result `page` holds only its identifying attributes (id, uuid, name,
 * originalName, journalDay, journal?).
 *
 * @param client - LogseqClient instance
 * @param options - Range selection plus search, slim and content options
 * @param now - The current moment, for `lastN` and presets (injectable for tests)
 * @returns Full, slim, or (with `includeContent: false`) outline results
 * @throws InvalidParameterError if the selection is missing, ambiguous or invalid
 */
export async function queryJournals(
  client: LogseqClient,
  options: DateRangeOptions,
  now: Date = new Date()
): Promise<DateRangeResult | SlimDateRangeResult | OutlineDateRangeResult> {
  const {
    searchTerm,
    slimResults = false,
    includeContent = true,
    topConceptsLimit = DEFAULT_TOP_CONCEPTS_LIMIT,
    resolveRefs = false
  } = options;
  if (!Number.isInteger(topConceptsLimit) || topConceptsLimit < 0) {
    throw new InvalidParameterError(
      'top_concepts_limit',
      String(topConceptsLimit),
      'A whole number, 0 or more (0 leaves topConcepts out)',
      'top_concepts_limit: 10'
    );
  }
  const selection = resolveSelection(options, now);

  // Query 1: journal pages (may be empty), in the order entries are returned
  let journals: PageEntity[];
  let rangeStart: number;
  let rangeEnd: number;

  if (selection.mode === 'range') {
    rangeStart = selection.start;
    rangeEnd = selection.end;
    const pagesQuery = DatalogQueryBuilder.getJournalPagesInRange(rangeStart, rangeEnd);
    journals = await fetchPages(client, pagesQuery);
    journals.sort((a, b) => (a.journalDay || 0) - (b.journalDay || 0));
  } else {
    const pagesQuery = DatalogQueryBuilder.getJournalPagesUpTo(selection.latest);
    const all = await fetchPages(client, pagesQuery);
    all.sort((a, b) => (b.journalDay || 0) - (a.journalDay || 0));
    journals = all.slice(0, selection.count);
    // Journals are unique per day, so every page between the oldest and newest
    // kept is one of the kept pages: the range query below fetches exactly them.
    rangeEnd = journals.length > 0 ? journals[0].journalDay! : 0;
    rangeStart = journals.length > 0 ? journals[journals.length - 1].journalDay! : 0;
  }

  // Query 2: every block on those pages (may be empty), rebuilt into trees.
  // Skipped when there are no pages; a second query never scales with range length.
  let treesByPage = new Map<number, BlockEntity[]>();
  const refsByBlock = new Map<number, ConceptRef[]>();
  if (journals.length > 0) {
    const blocksQuery = DatalogQueryBuilder.getJournalBlocksInRange(rangeStart, rangeEnd);
    const blockRows = await client.executeDatalogQuery<Array<[any]>>(
      blocksQuery.query,
      ...blocksQuery.inputs
    );
    const flatBlocks = (blockRows || [])
      .map(row => row[0])
      .filter(block => block != null)
      .map(block => {
        // The query pulls each ref as a page map. Keep the concepts for the roll-up
        // and hand the tree the bare `{id}` refs the Editor API returns.
        if (!Array.isArray(block.refs)) return block;
        const concepts = extractConceptRefs(block);
        if (concepts.length > 0) refsByBlock.set(block.id, concepts);
        return {
          ...block,
          refs: block.refs.map((ref: any) => ({ id: ref?.id ?? ref?.['db/id'] }))
        };
      });
    treesByPage = buildBlockTrees(flatBlocks, journals.map(page => page.id));
  }

  // A search term that names a page with aliases also finds blocks written under the
  // other names (#69). One query, only when there is something to search; null for any
  // text that is not such a page. After the journal queries, so it never delays them.
  const aliasSet =
    searchTerm && journals.length > 0 ? await resolveAliasSetByName(client, searchTerm) : null;
  const matchesSearch = blockMatcher(searchTerm ?? '', aliasSet);
  const entries: DateRangeResult['entries'] = [];
  let totalBlocks = 0;

  for (const page of journals) {
    const blocks = treesByPage.get(page.id) || [];

    // Filter top-level blocks by search term if provided
    let filteredBlocks = blocks;
    if (searchTerm) {
      filteredBlocks = filteredBlocks.filter(matchesSearch);
    }

    if (filteredBlocks.length > 0 || !searchTerm) {
      entries.push({
        date: page.journalDay!,
        page,
        blocks: filteredBlocks
      });

      totalBlocks += filteredBlocks.length;
    }
  }

  const dateRange = { start: rangeStart, end: rangeEnd };
  const summary: DateRangeSummary = { totalDays: entries.length, totalBlocks, searchTerm };
  if (topConceptsLimit > 0) {
    summary.topConcepts = rollUpTopConcepts(entries, refsByBlock, topConceptsLimit);
  }

  // Which names the search covered (#69); absent unless the term named a page with aliases
  const aliasCoverage: ResolvedAliases = aliasSet ? resolvedAliases(aliasSet) : {};
  const aliasWarnings = aliasSet ? aliasSetWarnings(aliasSet) : [];
  const aliasMeta: ResolveRefsMeta = aliasWarnings.length > 0 ? buildResultMeta(aliasWarnings) : {};

  if (!includeContent) {
    return {
      dateRange,
      entries: entries.map(entry => ({
        date: entry.date,
        pageName: pageNameOf(entry.page),
        blockCount: countBlocks(entry.blocks),
        snippets: entry.blocks.map(snippetOf)
      })),
      summary,
      ...aliasCoverage,
      ...aliasMeta
    };
  }

  // Opt-in (#18): resolve once over every returned block, whatever the number of days
  let resolveMeta: ResolveRefsMeta = aliasMeta;
  if (resolveRefs) {
    const resolved = await resolveBlockRefs(client, entries.flatMap(entry => entry.blocks));
    let offset = 0;
    for (const entry of entries) {
      entry.blocks = resolved.blocks.slice(offset, offset + entry.blocks.length);
      offset += entry.blocks.length;
    }
    const { hasMore, warnings } = buildResultMeta([...aliasWarnings, ...resolved.warnings]);
    resolveMeta = { hasMore, warnings };
  }

  // Return slim results if requested
  if (slimResults) {
    return {
      dateRange,
      entries: entries.map(entry => {
        return {
          date: entry.date,
          pageName: pageNameOf(entry.page),
          // The entry names the page, so its blocks don't repeat it (#42)
          blocks: entry.blocks.map(block => toSlimBlock(block, ''))
        };
      }),
      summary,
      ...aliasCoverage,
      ...resolveMeta
    };
  }

  return { dateRange, entries, summary, ...aliasCoverage, ...resolveMeta };
}
