import { LogseqClient } from '../client.js';
import { PageEntity, BlockEntity, SlimBlock } from '../types.js';
import { InvalidParameterError } from '../errors.js';
import { toSlimBlock } from '../utils/slim-entities.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import { buildBlockTrees, camelizeKeys } from '../utils/block-tree.js';

export interface DateRangeResult {
  dateRange: {
    start: number;
    end: number;
  };
  entries: Array<{
    date: number;
    page: PageEntity;
    blocks: BlockEntity[];
  }>;
  summary: {
    totalDays: number;
    totalBlocks: number;
    searchTerm?: string;
  };
}

export interface SlimDateRangeResult {
  dateRange: {
    start: number;
    end: number;
  };
  entries: Array<{
    date: number;
    pageName: string;
    blocks: SlimBlock[];
  }>;
  summary: {
    totalDays: number;
    totalBlocks: number;
    searchTerm?: string;
  };
}

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

/**
 * Query journal entries by date range
 * @param client - LogseqClient instance
 * @param startDate - Start date in YYYYMMDD format
 * @param endDate - End date in YYYYMMDD format
 * @param searchTerm - Optional search term to filter blocks
 * @param slimResults - Return slim results (40-50% fewer tokens, essential data only)
 * @returns DateRangeResult or SlimDateRangeResult with journal entries in range
 */
export async function queryByDateRange(
  client: LogseqClient,
  startDate: number,
  endDate: number,
  searchTerm?: string,
  slimResults: boolean = false
): Promise<DateRangeResult | SlimDateRangeResult> {
  // Validate dates
  if (!isValidDateFormat(startDate)) {
    throw new InvalidParameterError(
      'start_date',
      startDate,
      'Date in YYYYMMDD format (8 digits, valid year/month/day)',
      '20251115 for November 15, 2025'
    );
  }
  if (!isValidDateFormat(endDate)) {
    throw new InvalidParameterError(
      'end_date',
      endDate,
      'Date in YYYYMMDD format (8 digits, valid year/month/day)',
      '20251120 for November 20, 2025'
    );
  }
  if (startDate > endDate) {
    throw new InvalidParameterError(
      'date_range',
      `${startDate} to ${endDate}`,
      'start_date must be before or equal to end_date',
      'start_date: 20251115, end_date: 20251120'
    );
  }

  // Query 1: journal pages in range (may be empty)
  const pagesQuery = DatalogQueryBuilder.getJournalPagesInRange(startDate, endDate);
  const pageRows = await client.executeDatalogQuery<Array<[any]>>(
    pagesQuery.query,
    ...pagesQuery.inputs
  );
  const journalsInRange = (pageRows || [])
    .map(row => row[0])
    .filter(page => page != null)
    .map(page => camelizeKeys<PageEntity>(page));

  // Sort by date
  journalsInRange.sort((a, b) => (a.journalDay || 0) - (b.journalDay || 0));

  // Query 2: every block on those pages (may be empty), rebuilt into trees.
  // Skipped when there are no pages; a second query never scales with range length.
  let treesByPage = new Map<number, BlockEntity[]>();
  if (journalsInRange.length > 0) {
    const blocksQuery = DatalogQueryBuilder.getJournalBlocksInRange(startDate, endDate);
    const blockRows = await client.executeDatalogQuery<Array<[any]>>(
      blocksQuery.query,
      ...blocksQuery.inputs
    );
    const flatBlocks = (blockRows || [])
      .map(row => row[0])
      .filter(block => block != null);
    treesByPage = buildBlockTrees(flatBlocks, journalsInRange.map(page => page.id));
  }

  const entries: DateRangeResult['entries'] = [];
  let totalBlocks = 0;

  for (const page of journalsInRange) {
    const blocks = treesByPage.get(page.id) || [];

    // Filter top-level blocks by search term if provided
    let filteredBlocks = blocks;
    if (searchTerm) {
      filteredBlocks = filteredBlocks.filter(block =>
        block.content.toLowerCase().includes(searchTerm.toLowerCase())
      );
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

  // Return slim results if requested
  if (slimResults) {
    const slimEntries = entries.map(entry => ({
      date: entry.date,
      pageName: entry.page.originalName || entry.page['original-name'] || entry.page.name,
      blocks: entry.blocks.map(block => {
        const pageName = entry.page.originalName || entry.page['original-name'] || entry.page.name;
        return toSlimBlock(block, pageName);
      })
    }));

    return {
      dateRange: {
        start: startDate,
        end: endDate
      },
      entries: slimEntries,
      summary: {
        totalDays: entries.length,
        totalBlocks,
        searchTerm
      }
    };
  }

  return {
    dateRange: {
      start: startDate,
      end: endDate
    },
    entries,
    summary: {
      totalDays: entries.length,
      totalBlocks,
      searchTerm
    }
  };
}
