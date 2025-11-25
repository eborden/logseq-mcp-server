import { LogseqClient } from '../client.js';
import { BlockEntity, PageEntity } from '../types.js';

export type GroupByPeriod = 'day' | 'week' | 'month';

export interface ConceptEvolutionOptions {
  startDate?: number;
  endDate?: number;
  groupBy?: GroupByPeriod;
}

export interface ConceptEvolutionResult {
  concept: string;
  timeline: Array<{
    date: number | null;
    blocks: BlockEntity[];
  }>;
  groupedTimeline?: Map<string, BlockEntity[]>;
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

  // Simple week calculation (not ISO week)
  const startOfYear = new Date(parseInt(year), 0, 1);
  const currentDate = new Date(parseInt(year), month - 1, day);
  const dayOfYear = Math.floor(
    (currentDate.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24)
  );
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
 * @param conceptName - Name of the concept to track
 * @param options - Options for evolution tracking
 * @returns ConceptEvolutionResult with timeline of mentions
 */
export async function getConceptEvolution(
  client: LogseqClient,
  conceptName: string,
  options: ConceptEvolutionOptions = {}
): Promise<ConceptEvolutionResult> {
  const { startDate, endDate, groupBy } = options;

  const conceptNameLower = conceptName.toLowerCase();

  // Search for blocks mentioning the concept
  const blocks = await client.callAPI<BlockEntity[]>(
    'logseq.Editor.getPageBlocksTree',
    [conceptName]
  );

  // Get full page data for the concept page to enrich blocks from getPageBlocksTree
  const conceptPage = await client.callAPI<PageEntity>(
    'logseq.Editor.getPage',
    [conceptName]
  );

  // Enrich blocks from getPageBlocksTree with full page data
  if (blocks && conceptPage) {
    for (const block of blocks) {
      block.page = conceptPage as any;
    }
  }

  // Also search for inline mentions using Datalog
  // Use nested pull pattern {:block/page [*]} to get full page data including journalDay
  const inlineMentionsQuery = `[:find (pull ?block [:db/id :block/uuid :block/content :block/marker :block/properties :block/format {:block/page [*]}])
                                 :where
                                 [?page :block/name "${conceptNameLower}"]
                                 [?block :block/refs ?page]]`;

  const searchResults = await client.executeDatalogQuery(inlineMentionsQuery);
  const searchBlocks = (searchResults || []).map((r: any[]) => r[0] as BlockEntity);

  // Combine and deduplicate
  const allBlocks = [...(blocks || []), ...searchBlocks];
  const uniqueBlocks = Array.from(
    new Map(allBlocks.map(b => [b.id, b])).values()
  );

  // Filter by date range
  let filteredBlocks = uniqueBlocks;
  if (startDate || endDate) {
    filteredBlocks = uniqueBlocks.filter(block => {
      // Type guard to check if page has journalDay property
      // Handle both camelCase (HTTP API) and kebab-case (Datalog)
      const page = block.page as any;
      const blockDate = page?.journalDay || page?.['journal-day'];
      if (!blockDate) return true; // Keep non-journal blocks

      if (startDate && blockDate < startDate) return false;
      if (endDate && blockDate > endDate) return false;
      return true;
    });
  }

  // Build timeline
  const timelineMap = new Map<number | null, BlockEntity[]>();

  for (const block of filteredBlocks) {
    // Type guard to check if page has journalDay property
    // Handle both camelCase (HTTP API) and kebab-case (Datalog)
    const page = block.page as any;
    const date = page?.journalDay || page?.['journal-day'] || null;

    if (!timelineMap.has(date)) {
      timelineMap.set(date, []);
    }

    timelineMap.get(date)!.push(block);
  }

  // Sort by date
  const timeline = Array.from(timelineMap.entries())
    .map(([date, blocks]) => ({ date, blocks }))
    .sort((a, b) => {
      if (a.date === null && b.date === null) return 0;
      if (a.date === null) return 1;
      if (b.date === null) return -1;
      return a.date - b.date;
    });

  // Group by period if requested
  let groupedTimeline: Map<string, BlockEntity[]> | undefined;

  if (groupBy) {
    groupedTimeline = new Map();

    for (const block of filteredBlocks) {
      // Handle both camelCase (HTTP API) and kebab-case (Datalog)
      const page = block.page as any;
      const date = page?.journalDay || page?.['journal-day'];
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
    .map(b => {
      // Handle both camelCase (HTTP API) and kebab-case (Datalog)
      const page = b.page as any;
      return page?.journalDay || page?.['journal-day'];
    })
    .filter((d): d is number => d !== undefined && d !== null);

  const summary = {
    totalMentions: filteredBlocks.length,
    dateRange: {
      earliest: dates.length > 0 ? Math.min(...dates) : null,
      latest: dates.length > 0 ? Math.max(...dates) : null
    },
    journalMentions: dates.length,
    nonJournalMentions: filteredBlocks.length - dates.length
  };

  return {
    concept: conceptName,
    timeline,
    groupedTimeline,
    summary
  };
}
