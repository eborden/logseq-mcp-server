import { LogseqClient } from '../client.js';
import { PageEntity, BlockEntity, SlimBlock, ResolveRefsMeta, ResultMeta, ResultWarning } from '../types.js';
import { resolveBlockRefs } from '../utils/resolve-refs.js';
import { buildResultMeta, LARGE_RESULT_NOTE } from '../utils/result-meta.js';
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
import { entityId, pageDisplayName } from '../utils/entity-fields.js';
import { Budget, countBlocks, takeBlocks } from '../utils/block-budget.js';
import { formatLogseqDate } from '../utils/date-utils.js';
import { DATE_PRESETS, isDatePreset, resolveDatePreset } from '../utils/date-presets.js';
import {
  ConceptRef,
  DEFAULT_TOP_CONCEPTS_LIMIT,
  TopConcept,
  extractConceptRefs,
  rollUpTopConcepts
} from '../utils/top-concepts.js';
import { queryParsed } from '../utils/parse-response.js';
import { responses } from '../response-schemas.js';

export type { TopConcept } from '../utils/top-concepts.js';
export { BUILT_IN_CONCEPTS, DEFAULT_TOP_CONCEPTS_LIMIT } from '../utils/top-concepts.js';

/** Blocks kept when `maxBlocks` is absent (#61). */
export const DEFAULT_DATE_RANGE_MAX_BLOCKS = 200;

/**
 * Most blocks one call returns (#61). A larger `maxBlocks` is clamped to it, and a cut
 * at the maximum is reported by a `blocks_truncated` warning whose `howToFetchAll` pages
 * on from the day the entries end at (#187). Dates narrow a result to whole days, so a day
 * holding more blocks than this can't be fetched whole by any call.
 */
export const MAX_DATE_RANGE_BLOCKS = 1000;

/**
 * The `summary` of every result shape. It describes every day and block found in the
 * range, also when `maxBlocks` cut the entries (#61): `totalDays` and `totalBlocks`
 * (top-level blocks) can exceed what `entries` holds, and `totals` says by how much.
 * `topConcepts` is the pages most referenced (`:block/refs`) by those blocks, nested
 * ones included; it is left out when `topConceptsLimit` is 0.
 */
export interface DateRangeSummary {
  totalDays: number;
  totalBlocks: number;
  searchTerm?: string;
  topConcepts?: TopConcept[];
}

/**
 * `hasMore` / `warnings` are present only when `resolve_refs` is on, an alias warning
 * applies, `maxBlocks` cut the entries, or LogSeq answered a query with `null`
 * (`journals_unavailable`, `blocks_unavailable`: BR-0011, #269). `totals` ({ blocks, days }: what there was
 * before the cut) comes only with a cut. `dateRange` is the range queried, not where
 * the cut left the entries: the `blocks_truncated` warning says where they end.
 * `totals.blocks` counts in the cap's unit (nested blocks too in full and slim output),
 * while `summary.totalBlocks` counts top-level blocks, so the two differ when blocks nest.
 */
export interface DateRangeResult extends ResolveRefsMeta, ResolvedAliases {
  totals?: ResultMeta['totals'];
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
  totals?: ResultMeta['totals'];
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
  totals?: ResultMeta['totals'];
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
  /** Slim blocks (ignored when `includeContent` is false). Direct calls default to full (false); the MCP handler defaults to slim through its argument schema (#42, #60) */
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
  /**
   * Blocks kept across all days (default 200), clamped to 0..`MAX_DATE_RANGE_BLOCKS` (1000) and
   * floored (#61). Counts every block, nested ones included, in document order: a block,
   * then its children, then the next sibling, day by day in the order of `entries`.
   * With `includeContent: false` it counts top-level blocks, the ones the result lists
   * as snippets. `summary` still covers every block found.
   */
  maxBlocks?: number;
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
  // The term's own name stays out of the regex: `includes` matches it, and the `iu` flags would
  // also match case-folded spellings (`ſam` for `sam`) that `includes` does not
  const otherNames = (aliasSet ? aliasNames(aliasSet) : []).filter(name => name !== term);
  const wholeWord =
    otherNames.length > 0
      ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${otherNames.map(escapeRegex).join('|')})(?![\\p{L}\\p{N}])`, 'iu')
      : null;
  const pageIds = new Set(aliasSet ? aliasIds(aliasSet) : []);
  return block => {
    const content = (block.content ?? '').toLowerCase();
    if (content.includes(term) || wholeWord?.test(content)) return true;
    return (block.refs ?? []).some(ref => ref.id !== undefined && pageIds.has(ref.id));
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

const isGiven = <T>(value: T): value is NonNullable<T> => value !== undefined && value !== null;

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
    if (!Number.isInteger(lastN) || lastN < 1) {
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

const pageNameOf = (page: PageEntity): string => pageDisplayName(page);

type Entry = DateRangeResult['entries'][number];

/** Blocks an entry lists against the cap: nested ones too, or only top-level ones (the outline). */
const listedBlocks = (blocks: BlockEntity[], nested: boolean): number =>
  nested ? countBlocks(blocks) : blocks.length;

/** Where `capEntries` cut, for the warning. */
interface BlockCut {
  entries: Entry[];
  /** Blocks there were before the cut, counted the way the cap counts them */
  total: number;
  /** Day of the last entry kept; null when nothing was kept */
  endsAt: number | null;
  /** The first day dropped; null when the last kept day was the last entry */
  nextDay: number | null;
  /** The last kept day lost blocks */
  splitDay: boolean;
  /** Blocks kept on the days before the last kept one: 0 means that day alone filled the cap */
  keptBefore: number;
  /** Blocks the last kept day holds in all */
  lastDayTotal: number;
  /** A kept block lost some of its children */
  partialBlock: boolean;
}

/**
 * Keep the first `cap` blocks across `entries` (#61), in the order of the entries.
 * At or below the cap this returns null and the entries stay untouched. Days after the
 * last kept block are dropped, empty ones included; a day kept part-way keeps its first
 * blocks.
 */
function capEntries(entries: Entry[], cap: number, nested: boolean): BlockCut | null {
  const total = entries.reduce((sum, entry) => sum + listedBlocks(entry.blocks, nested), 0);
  if (total <= cap) return null;

  const budget: Budget = { room: cap, partial: false };
  const kept: Entry[] = [];
  let firstDropped: Entry | undefined;
  let splitDay = false;
  let keptBefore = 0;
  let lastDayTotal = 0;
  for (const entry of entries) {
    if (budget.room === 0) {
      firstDropped = entry;
      break;
    }
    const before = budget.room;
    let blocks: BlockEntity[];
    if (nested) {
      blocks = takeBlocks(entry.blocks, budget);
    } else {
      blocks = entry.blocks.slice(0, budget.room);
      budget.room -= blocks.length;
    }
    kept.push({ ...entry, blocks });
    keptBefore = cap - before;
    lastDayTotal = listedBlocks(entry.blocks, nested);
    splitDay = before - budget.room < lastDayTotal;
  }
  const last = kept[kept.length - 1];
  return {
    entries: kept,
    total,
    endsAt: last ? last.date : null,
    nextDay: firstDropped?.date ?? null,
    splitDay,
    keptBefore,
    lastDayTotal,
    partialBlock: budget.partial
  };
}

/**
 * The `blocks_truncated` warning (#187). The message says what was kept and where the
 * entries end, plus any fact about a day that no date range can fix. `howToFetchAll` leads
 * with paging: a call from the day where the entries stop, with the same end of the range
 * and the same `max_blocks`, which reaches whole days after the cut and never part of one.
 * That is a real fetch-the-rest parameter, so `hasMore` stays true at the maximum too
 * (BR-0006, paged-cap amendment) whenever such a call exists.
 *
 * The advice always moves the reader forward, and every branch is literally true:
 *  - cut between days: page from the first day dropped
 *  - cut inside a day after earlier days: page from that day, which repeats its kept blocks
 *    (if it is the last day, that reads the rest of it). A day bigger than the cap is
 *    handled like the first day below: it alone fills a call from it
 *  - a day alone filling the cap (the first day, or a split day bigger than the cap): a query
 *    from it at this cap reads only its first blocks, so the way forward is that day alone at a
 *    higher cap (within the maximum), then paging; a day over the maximum can't be fetched
 *    whole, so page past it (or, with no later day, offer a search_term and no howToFetchAll)
 *  - nothing kept (a cap of 0): there is no day to page from, so raise the cap
 * A raise of `max_blocks` is suggested only there and says a result that large may not be
 * shown by the host. `newestFirst` is the `last_n` order, which continues with older days.
 */
function blocksTruncated(
  cut: BlockCut,
  shown: number,
  options: { nested: boolean; newestFirst: boolean; start: number; end: number; requested: number }
): ResultWarning {
  const { nested, newestFirst, start, end, requested } = options;
  const { endsAt, nextDay, splitDay, keptBefore, lastDayTotal, total } = cut;
  const max = MAX_DATE_RANGE_BLOCKS;
  const atMax = shown >= max;
  const direction = newestFirst ? 'older' : 'later';
  /** The dates that read on from `day`: the same end of the range, or for `last_n` (newest first) the same start */
  const from = (day: number) =>
    newestFirst ? `start_date ${start}, end_date ${day}` : `start_date ${day}, the same end_date (${end})`;
  const callAgain = (day: number) => `Call again with ${from(day)} and the same max_blocks`;

  // Facts go in the message. The way forward goes in howToFetchAll, or in the message when
  // nothing can be fetched (no howToFetchAll, so hasMore is false).
  const facts: string[] = [];
  let howToFetchAll: string | undefined;
  if (endsAt === null) {
    howToFetchAll =
      (total <= max
        ? `Set max_blocks to ${total} (or higher) to get all ${total}.`
        : `Set max_blocks to ${max} (the maximum) to get ${max} of ${total}. Narrow the dates or last_n, or add a search_term.`) +
      ` ${LARGE_RESULT_NOTE}`;
  } else if (!splitDay) {
    howToFetchAll = `${callAgain(nextDay ?? endsAt)} to read the ${direction} days, or add a search_term.`;
  } else if (lastDayTotal <= shown) {
    // Cut inside a day that fits the cap (so earlier days were kept): a call from it reads that day whole
    howToFetchAll =
      nextDay !== null
        ? `${callAgain(endsAt)} to read the ${direction} days (day ${endsAt} repeats its kept blocks), or add a search_term.`
        : `${callAgain(endsAt)} to read the rest of day ${endsAt} (it repeats its kept blocks), or add a search_term.`;
  } else if (lastDayTotal > max) {
    // The day holds more than any call returns, so no call reads it whole
    facts.push(
      keptBefore > 0
        ? `A day is the narrowest date range, so day ${endsAt}, with ${lastDayTotal} blocks, can't be fetched whole.`
        : `Day ${endsAt} holds ${lastDayTotal} blocks, more than the maximum of ${max}, so no call can return it whole.`
    );
    if (nextDay !== null) {
      howToFetchAll = `${callAgain(nextDay)} for the rest of the range, or add a search_term to read day ${endsAt} in pieces.`;
    } else if (!atMax) {
      howToFetchAll =
        `Set max_blocks to ${max} (the maximum) with start_date ${endsAt} and end_date ${endsAt} to read ${max} of its ` +
        `${lastDayTotal} blocks, or add a search_term to read it in pieces. ${LARGE_RESULT_NOTE}`;
    } else {
      // Nothing is left to fetch: no howToFetchAll, so hasMore is false
      facts.push('Add a search_term to narrow it.');
    }
  } else {
    // The day alone fills the cap but fits the maximum: a call from it at this cap reads only its first `shown` blocks
    facts.push(
      keptBefore > 0
        ? `Day ${endsAt} holds ${lastDayTotal} blocks, more than ${shown}, so a query from it at this max_blocks reads only its first ${shown}.`
        : `Day ${endsAt} alone holds ${lastDayTotal} blocks, more than ${shown}, so a query from it returns the same blocks at this max_blocks.`
    );
    howToFetchAll =
      `To read it whole, call again with start_date ${endsAt}, end_date ${endsAt} and max_blocks ${lastDayTotal}. ` +
      `${LARGE_RESULT_NOTE} If it comes back saved, read the day in pieces with a search_term.` +
      (nextDay !== null ? ` Then continue with ${from(nextDay)} and max_blocks ${shown}.` : '');
  }

  const unit = nested ? 'nested ones counted' : 'top-level only';
  const order = `${newestFirst ? 'newest' : 'oldest'} day first`;
  const ends = endsAt !== null ? `; the entries end at ${endsAt}` : '';
  const partial = cut.partialBlock ? '; a kept block shows fewer children than it has (childrenTruncated)' : '';
  const base = `Showing ${shown} of ${total} blocks (${unit}; ${order}${ends}${partial})`;
  const clamped = requested > max ? ` (${requested} was asked for)` : '';
  const head = atMax
    ? `${base}: max_blocks is capped at its maximum of ${max}${clamped}, so the rest can't be fetched in one call.`
    : `${base}.`;
  return {
    code: 'blocks_truncated',
    message: [head, ...facts].join(' '),
    ...(howToFetchAll === undefined ? {} : { howToFetchAll })
  };
}

/** First line of a block, trimmed and shortened. */
function snippetOf(block: BlockEntity): string {
  const firstLine = (block.content ?? '').split('\n')[0].trim();
  return firstLine.length > SNIPPET_LENGTH
    ? `${firstLine.slice(0, SNIPPET_LENGTH - 3)}...`
    : firstLine;
}

/**
 * The journal pages a query finds, or `null` when LogSeq answered `null`. `null` is not `[]` (BR-0011, #269):
 * an empty array is a range with no journals, `null` is no answer at all.
 */
async function fetchPages(
  client: LogseqClient,
  { query, inputs }: { query: string; inputs: unknown[] }
): Promise<PageEntity[] | null> {
  const rows = await queryParsed(client, responses.nullablePageRows, query, ...inputs);
  if (rows === null) return null;
  return rows
    .map(row => row[0])
    .filter(page => page != null)
    .map(page => camelizeKeys<PageEntity>(page));
}

/**
 * No howToFetchAll on either warning: no parameter fetches what LogSeq did not answer (like `pages_unavailable`,
 * #64), so `hasMore` is unaffected. The retry advice is in the message.
 */
const RETRY_ADVICE =
  'Retry in a moment, or call logseq_get_graph_info to check which graph is open.';

function journalsUnavailable(): ResultWarning {
  return {
    code: 'journals_unavailable',
    message:
      'LogSeq returned no answer when looking up journal pages (possibly no graph open or a re-index ' +
      'in progress), so the empty result may not mean there are no journals to show. ' +
      RETRY_ADVICE
  };
}

function blocksUnavailable(pageCount: number): ResultWarning {
  return {
    code: 'blocks_unavailable',
    message:
      `LogSeq returned no answer when looking up the blocks on ${pageCount} journal page(s) (possibly no graph ` +
      'open or a re-index in progress), so their blocks are missing from this result (with a search term, ' +
      'those days are left out). This does not mean the days are empty. ' +
      RETRY_ADVICE
  };
}

/**
 * Query journal entries by explicit date range.
 * Kept for callers that already have two dates; it goes through the same
 * validation and query path as {@link queryJournals}.
 * @param client - LogseqClient instance
 * @param startDate - Start date in YYYYMMDD format
 * @param endDate - End date in YYYYMMDD format
 * @param searchTerm - Optional search term to filter blocks
 * @param slimResults - Return slim results (40-50% fewer tokens, essential data only). Direct calls default to full (false); the MCP handler defaults to slim through its argument schema (#42, #60)
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
    resolveRefs = false,
    maxBlocks = DEFAULT_DATE_RANGE_MAX_BLOCKS
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

  // Query 1: journal pages (may be empty), in the order entries are returned. A `null` answer is not
  // an empty one (BR-0011, #269): it reads as no journals here, and a warning says it was no answer.
  let journals: PageEntity[];
  let unavailable: ResultWarning[] = [];
  let rangeStart: number;
  let rangeEnd: number;

  if (selection.mode === 'range') {
    rangeStart = selection.start;
    rangeEnd = selection.end;
    const pagesQuery = DatalogQueryBuilder.getJournalPagesInRange(rangeStart, rangeEnd);
    const found = await fetchPages(client, pagesQuery);
    if (found === null) unavailable = [journalsUnavailable()];
    journals = found ?? [];
    journals.sort((a, b) => (a.journalDay || 0) - (b.journalDay || 0));
  } else {
    const pagesQuery = DatalogQueryBuilder.getJournalPagesUpTo(selection.latest);
    const found = await fetchPages(client, pagesQuery);
    if (found === null) unavailable = [journalsUnavailable()];
    const all = found ?? [];
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
    const blockRows = await queryParsed(client, responses.nullableBlockRows, blocksQuery.query, ...blocksQuery.inputs);
    // `null` here would otherwise show journal pages that exist with no blocks, as if the days were empty
    if (blockRows === null) unavailable = [blocksUnavailable(journals.length)];
    const flatBlocks = (blockRows ?? [])
      .map(row => row[0])
      .filter(block => block != null)
      .map(block => {
        // The query pulls each ref as a page map. Keep the concepts for the roll-up
        // and hand the tree the bare `{id}` refs the Editor API returns.
        if (!Array.isArray(block.refs)) return block;
        refsByBlock.set(block.id, extractConceptRefs(block));
        return {
          ...block,
          refs: block.refs.map(ref => ({ id: entityId(ref) }))
        };
      });
    treesByPage = buildBlockTrees(flatBlocks, journals.map(page => page.id));
  }

  // A search term that names a page with aliases also finds blocks written under the
  // other names (#69). One query, only when there is something to search; null for any
  // text that is not such a page. After the journal queries, so it never delays them.
  const aliasSet =
    searchTerm && journals.length > 0 ? await resolveAliasSetByName(client, searchTerm) : null;
  const matchesSearch = searchTerm ? blockMatcher(searchTerm, aliasSet) : null;
  const allEntries: DateRangeResult['entries'] = [];
  let totalBlocks = 0;

  for (const page of journals) {
    // buildBlockTrees registers every journal page, so a page with no blocks has []
    const blocks = treesByPage.get(page.id)!;

    // Filter top-level blocks by search term if provided
    const filteredBlocks = matchesSearch ? blocks.filter(matchesSearch) : blocks;

    if (filteredBlocks.length > 0 || !searchTerm) {
      allEntries.push({
        date: page.journalDay!,
        page,
        blocks: filteredBlocks
      });

      totalBlocks += filteredBlocks.length;
    }
  }

  const dateRange = { start: rangeStart, end: rangeEnd };
  // The summary describes every block found, cut or not (#61), so a cut result still shows what the period was about
  const summary: DateRangeSummary = { totalDays: allEntries.length, totalBlocks, searchTerm };
  if (topConceptsLimit > 0) {
    summary.topConcepts = rollUpTopConcepts(allEntries, refsByBlock, topConceptsLimit);
  }

  // Cap the blocks (#61) on data already fetched, so it adds no API call. At or below the
  // cap nothing changes. What comes after (resolving refs, slimming) sees only the kept blocks.
  const cap = Math.min(Math.max(0, Math.floor(maxBlocks)), MAX_DATE_RANGE_BLOCKS);
  const cut = capEntries(allEntries, cap, includeContent);
  const entries = cut ? cut.entries : allEntries;

  // Which names the search covered (#69); absent unless the term named a page with aliases
  const aliasCoverage: ResolvedAliases = aliasSet ? resolvedAliases(aliasSet) : {};
  const warnings: ResultWarning[] = [...(aliasSet ? aliasSetWarnings(aliasSet) : []), ...unavailable];
  if (cut) {
    warnings.push(
      blocksTruncated(cut, cap, {
        nested: includeContent,
        newestFirst: selection.mode === 'last_n',
        start: rangeStart,
        end: rangeEnd,
        requested: maxBlocks
      })
    );
  }
  // The totals come only with a cut, so output below the cap is unchanged
  const totals = cut ? { blocks: cut.total, days: allEntries.length } : undefined;
  const cutMeta: ResolveRefsMeta & Pick<ResultMeta, 'totals'> =
    warnings.length > 0 ? buildResultMeta(warnings, totals) : {};

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
      ...cutMeta
    };
  }

  // Opt-in (#18): resolve once over every returned block, whatever the number of days.
  // Only the kept blocks: each block resolves on its own, so their output is the same, and
  // the batched queries never carry the refs of blocks that were cut.
  let resolveMeta: ResolveRefsMeta & Pick<ResultMeta, 'totals'> = cutMeta;
  if (resolveRefs) {
    const resolved = await resolveBlockRefs(client, entries.flatMap(entry => entry.blocks));
    let offset = 0;
    for (const entry of entries) {
      entry.blocks = resolved.blocks.slice(offset, offset + entry.blocks.length);
      offset += entry.blocks.length;
    }
    resolveMeta = buildResultMeta([...warnings, ...resolved.warnings], totals);
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
