import { LogseqClient } from '../client.js';
import { PageEntity, BlockEntity } from '../types.js';

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

/**
 * Validate date is in YYYYMMDD format
 * @param date - Date in YYYYMMDD format
 * @returns true if valid
 */
function isValidDateFormat(date: number): boolean {
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
 * @returns DateRangeResult with journal entries in range
 */
export async function queryByDateRange(
  client: LogseqClient,
  startDate: number,
  endDate: number,
  searchTerm?: string
): Promise<DateRangeResult> {
  // Validate dates
  if (!isValidDateFormat(startDate)) {
    throw new Error(`Invalid date format: ${startDate}`);
  }
  if (!isValidDateFormat(endDate)) {
    throw new Error(`Invalid date format: ${endDate}`);
  }
  if (startDate > endDate) {
    throw new Error('Start date must be before or equal to end date');
  }

  // Query for all journal pages using Editor API
  const allPages = await client.callAPI<PageEntity[]>(
    'logseq.Editor.getAllPages'
  );

  // Filter by journal pages in date range
  const journalsInRange = (allPages || []).filter(page => {
    return (
      page.journal &&
      page.journalDay &&
      page.journalDay >= startDate &&
      page.journalDay <= endDate
    );
  });

  // Sort by date
  journalsInRange.sort((a, b) => (a.journalDay || 0) - (b.journalDay || 0));

  // Get blocks for each journal page
  const entries: DateRangeResult['entries'] = [];
  let totalBlocks = 0;

  for (const page of journalsInRange) {
    const blocks = await client.callAPI<BlockEntity[]>(
      'logseq.Editor.getPageBlocksTree',
      [page.name]
    );

    // Filter by search term if provided
    let filteredBlocks = blocks || [];
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
