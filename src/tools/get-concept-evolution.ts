import { LogseqClient } from '../client.js';
import { BlockEntity } from '../types.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import { requirePage, resolvedFrom, ResolvedFrom } from '../utils/resolve-page.js';
import {
  ResolvedAliases,
  aliasIds,
  aliasSetWarnings,
  hasAliases,
  resolveAliasSet,
  resolvedAliases
} from '../utils/alias-set.js';
import { buildResultMeta, cappedTruncationWarning, INLINE_ITEMS } from '../utils/result-meta.js';
import { entityId, journalDayOf } from '../utils/entity-fields.js';
import type { ResolveRefsMeta, ResultMeta, ResultWarning } from '../types.js';
import { callParsed, queryParsed } from '../utils/parse-response.js';
import { responses } from '../response-schemas.js';

/** Every grouping period, in the order `group_by` advertises them (#60). */
export const GROUP_BY_PERIODS = ['day', 'week', 'month'] as const;

export type GroupByPeriod = (typeof GROUP_BY_PERIODS)[number];

/** Mentions (blocks in the timeline) kept when `maxEntries` is absent. */
export const DEFAULT_MAX_ENTRIES = 100;

/**
 * Most mentions one call returns (#61). A larger `maxEntries` is clamped to it,
 * and a cut at the maximum is reported by an `entries_truncated` warning with no
 * `howToFetchAll`. The dates reach later dated mentions only: mentions on
 * non-journal pages pass every date filter, so no date range narrows them.
 */
export const MAX_ENTRIES = 500;

type TimelineEntry = { date: number | null; blocks: BlockEntity[] };

const mentionCount = (entries: TimelineEntry[], dated: boolean) =>
  entries.filter(e => (e.date !== null) === dated).reduce((sum, e) => sum + e.blocks.length, 0);

/**
 * The `entries_truncated` warning for a timeline cut from `full` to `kept`. Says where
 * the timeline ends when it ends on a dated mention, so the caller can continue from
 * there, and says what the dates can reach: the date filter keeps every block with no
 * journal day, so they never narrow the undated mentions, which are cut first.
 */
function entriesTruncated(
  full: TimelineEntry[],
  kept: TimelineEntry[],
  total: number,
  shown: number,
  requested: number
): ResultWarning {
  const last = kept[kept.length - 1];
  const endsAt = last && last.date !== null ? last.date : null;
  const datedCut = mentionCount(full, true) > mentionCount(kept, true);
  let narrower: string;
  if (datedCut && endsAt !== null) {
    // One day can be split across the cut, so starting there repeats its kept blocks
    narrower = `Set start_date to ${endsAt} for later dated mentions (that day repeats its kept blocks). Mentions on non-journal pages ignore the dates.`;
  } else if (datedCut) {
    narrower = 'Narrow start_date and end_date to see dated mentions. Mentions on non-journal pages ignore the dates.';
  } else {
    narrower = "Mentions on non-journal pages ignore start_date and end_date, so narrowing the dates can't reach the rest.";
  }
  return cappedTruncationWarning({
    what: `mentions (oldest first, undated last${endsAt !== null ? `; the timeline ends at ${endsAt}` : ''})`,
    shown,
    total,
    param: 'max_entries',
    max: MAX_ENTRIES,
    narrower,
    requested,
    code: 'entries_truncated',
    inlineMax: INLINE_ITEMS.blocks
  });
}

export interface ConceptEvolutionOptions {
  startDate?: number;
  endDate?: number;
  groupBy?: GroupByPeriod;
  /**
   * Mentions kept (default 100), clamped to 0..`MAX_ENTRIES` (500) and floored.
   * The timeline's order decides which: oldest first, mentions with no date last.
   */
  maxEntries?: number;
}

/**
 * `hasMore` / `warnings` are present only when a warning applies (an alias group
 * cut at its maximum, or mentions cut at `maxEntries`), so default output is
 * unchanged. `totals.mentions` accompanies a cut: how many mentions there were.
 * `summary` always describes every mention found, so its counts can exceed what
 * `timeline` holds when a cut is reported.
 */
export interface ConceptEvolutionResult extends ResolvedFrom, ResolvedAliases, ResolveRefsMeta {
  totals?: ResultMeta['totals'];
  concept: string;
  timeline: Array<{
    date: number | null;
    blocks: BlockEntity[];
  }>;
  groupedTimeline?: Record<string, BlockEntity[]>;
  summary: {
    totalMentions: number;
    dateRange: {
      earliest: number | null;
      latest: number | null;
    };
    journalMentions: number;
    nonJournalMentions: number;
  };
}

/**
 * Get week number for a date
 * @param date - Date in YYYYMMDD format
 * @returns Week identifier string (YYYY-WW)
 */
function getWeekIdentifier(date: number): string {
  const str = date.toString();
  const year = str.substring(0, 4);
  const month = parseInt(str.substring(4, 6));
  const day = parseInt(str.substring(6, 8));

  // Simple week calculation (not ISO week). Both dates are UTC midnights, so the difference is a whole
  // number of days in every time zone; local-time dates are an hour short after a daylight-saving change
  // and the floor would put a week's first day in the previous week (#249).
  const startOfYear = Date.UTC(parseInt(year), 0, 1);
  const currentDate = Date.UTC(parseInt(year), month - 1, day);
  const dayOfYear = Math.floor((currentDate - startOfYear) / (1000 * 60 * 60 * 24));
  const weekNum = Math.floor(dayOfYear / 7) + 1;

  return `${year}-W${weekNum.toString().padStart(2, '0')}`;
}

/**
 * Get month identifier for a date
 * @param date - Date in YYYYMMDD format
 * @returns Month identifier string (YYYY-MM)
 */
function getMonthIdentifier(date: number): string {
  const str = date.toString();
  return str.substring(0, 6);
}

/**
 * Track how a concept evolves over time
 * @param client - LogseqClient instance
 * @param conceptName - Page name, alias, or ISO date (`2025-01-01`) of the concept; throws
 *   PageNotFoundError if none matches and AmbiguousPageError if several do
 * @param options - Options for evolution tracking
 * @returns ConceptEvolutionResult with timeline of mentions. When the name was an alias,
 *   date or namespace leaf rather than an exact name, `resolvedFrom` says which page was used.
 *   Mentions under any alias of the page are included (blocks that link one name, and the
 *   blocks of the alias pages themselves); `resolvedAliases` lists the names covered.
 */
export async function getConceptEvolution(
  client: LogseqClient,
  conceptName: string,
  options: ConceptEvolutionOptions = {}
): Promise<ConceptEvolutionResult> {
  const { startDate, endDate, groupBy, maxEntries = DEFAULT_MAX_ENTRIES } = options;

  // Resolve the name first (exact name, alias or ISO date, in one query).
  // Throws PageNotFoundError (with suggestions) or AmbiguousPageError (with candidates).
  const resolved = await requirePage(client, conceptName);
  const lookupName = resolved.lookupName;

  // The names this page goes by (#69): a page with no `alias::` costs no call here
  const aliasSet = await resolveAliasSet(client, resolved.page);

  // Search for blocks mentioning the concept
  const blocks = await callParsed(client, responses.blocks, 'logseq.Editor.getPageBlocksTree', [lookupName]);

  // Get full page data for the concept page to enrich blocks from getPageBlocksTree
  const conceptPage = await callParsed(client, responses.editorPage, 'logseq.Editor.getPage', [lookupName]);

  // Enrich blocks from getPageBlocksTree with full page data
  if (blocks && conceptPage) {
    for (const block of blocks) {
      block.page = conceptPage;
    }
  }

  // Also search for inline mentions using Datalog
  // For an alias group, one query matches references to any of its names and
  // adds the blocks of the alias pages (the page's own come from the tree above).
  const mainPageId = entityId(resolved.page);
  const { query: mentionsQuery, inputs: mentionsInputs } = hasAliases(aliasSet)
    ? DatalogQueryBuilder.getBlocksReferencingPages(
        aliasIds(aliasSet),
        aliasIds(aliasSet).filter(id => id !== mainPageId)
      )
    : DatalogQueryBuilder.getBlocksReferencingPage(lookupName);
  const searchResults = await queryParsed(client, responses.blockRows, mentionsQuery, ...mentionsInputs);
  const searchBlocks = (searchResults || []).map(r => r[0]);

  // Combine and deduplicate
  const allBlocks = [...(blocks || []), ...searchBlocks];
  const uniqueBlocks = Array.from(
    new Map(allBlocks.map(b => [b.id, b])).values()
  );

  // Filter by date range
  let filteredBlocks = uniqueBlocks;
  if (startDate || endDate) {
    filteredBlocks = uniqueBlocks.filter(block => {
      // The page is camelCase (HTTP API) or kebab-case (Datalog); journalDayOf reads both
      const blockDate = journalDayOf(block.page) || undefined;
      if (!blockDate) return true; // Keep non-journal blocks

      if (startDate && blockDate < startDate) return false;
      if (endDate && blockDate > endDate) return false;
      return true;
    });
  }

  // Mentions there are before the cap (#61): the summary and the warning count them all
  const total = filteredBlocks.length;

  // Build timeline
  const timelineMap = new Map<number | null, BlockEntity[]>();

  for (const block of filteredBlocks) {
    const date = journalDayOf(block.page) || null;

    if (!timelineMap.has(date)) {
      timelineMap.set(date, []);
    }

    timelineMap.get(date)!.push(block);
  }

  // Sort by date
  const fullTimeline = Array.from(timelineMap.entries())
    .map(([date, blocks]) => ({ date, blocks }))
    .sort((a, b) => {
      if (a.date === null && b.date === null) return 0;
      if (a.date === null) return 1;
      if (b.date === null) return -1;
      return a.date - b.date;
    });

  // Cap the mentions (#61) in timeline order: oldest first, undated last. The
  // timeline and the grouping keep the first `cap` of them. At or below the cap
  // nothing changes.
  const cap = Math.min(Math.max(0, Math.floor(maxEntries)), MAX_ENTRIES);
  let timeline = fullTimeline;
  let shownBlocks = filteredBlocks;
  if (total > cap) {
    let room = cap;
    timeline = [];
    for (const { date, blocks } of fullTimeline) {
      if (room === 0) break;
      const taken = blocks.slice(0, room);
      timeline.push({ date, blocks: taken });
      room -= taken.length;
    }
    const kept = new Set(timeline.flatMap(entry => entry.blocks));
    shownBlocks = filteredBlocks.filter(block => kept.has(block));
  }

  // Group by period if requested
  let groupedTimeline: Map<string, BlockEntity[]> | undefined;

  if (groupBy) {
    groupedTimeline = new Map();

    for (const block of shownBlocks) {
      const date = journalDayOf(block.page);
      if (!date) continue;

      let periodKey: string;
      switch (groupBy) {
        case 'day':
          periodKey = date.toString();
          break;
        case 'week':
          periodKey = getWeekIdentifier(date);
          break;
        case 'month':
          periodKey = getMonthIdentifier(date);
          break;
      }

      if (!groupedTimeline.has(periodKey)) {
        groupedTimeline.set(periodKey, []);
      }

      groupedTimeline.get(periodKey)!.push(block);
    }
  }

  // Build summary
  const dates = filteredBlocks
    .map(b => journalDayOf(b.page) || undefined)
    .filter((d): d is number => d !== undefined);

  const summary = {
    totalMentions: filteredBlocks.length,
    dateRange: {
      earliest: dates.length > 0 ? Math.min(...dates) : null,
      latest: dates.length > 0 ? Math.max(...dates) : null
    },
    journalMentions: dates.length,
    nonJournalMentions: filteredBlocks.length - dates.length
  };

  const warnings = aliasSetWarnings(aliasSet);
  if (total > shownBlocks.length) {
    warnings.push(
      entriesTruncated(fullTimeline, timeline, total, shownBlocks.length, maxEntries)
    );
  }
  // The total comes only with a cut, so output below the cap is unchanged
  const meta: ResolveRefsMeta & Pick<ConceptEvolutionResult, 'totals'> =
    warnings.length > 0
      ? buildResultMeta(warnings, total > shownBlocks.length ? { mentions: total } : undefined)
      : {};

  return {
    concept: conceptName,
    ...resolvedFrom(conceptName, resolved),
    ...resolvedAliases(aliasSet),
    ...meta,
    timeline,
    groupedTimeline: groupedTimeline ? Object.fromEntries(groupedTimeline) : undefined,
    summary
  };
}
