# Temporal Queries Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add tools for querying LogSeq data across time - journal entries by date range, concept evolution tracking, and temporal analysis

**Architecture:** Leverage LogSeq's journal-based structure. Tools for date range queries, time-series analysis of concepts, and tracking how ideas evolve. Uses journalDay property for efficient temporal indexing.

**Tech Stack:** TypeScript, LogSeq Editor API, date utilities

---

## Task 1: Add query_by_date_range tool

**Files:**
- Create: `src/tools/query-by-date-range.ts`
- Create: `src/tools/query-by-date-range.test.ts`
- Modify: `src/index.ts` (add import, schema, handler)

**Step 1: Write the failing test**

Create `src/tools/query-by-date-range.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { queryByDateRange } from './query-by-date-range.js';
import { LogseqClient } from '../client.js';

describe('queryByDateRange', () => {
  it('should return journal entries within date range', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock query for pages
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        name: 'nov 15th, 2025',
        journalDay: 20251115,
        'journal?': true
      },
      {
        id: 2,
        name: 'nov 20th, 2025',
        journalDay: 20251120,
        'journal?': true
      }
    ]);

    // Mock blocks for each page
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 10, content: 'Entry from Nov 15' }
    ]);

    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 20, content: 'Entry from Nov 20' }
    ]);

    const result = await queryByDateRange(
      mockClient,
      20251115,
      20251120
    );

    expect(result).toHaveProperty('dateRange');
    expect(result.dateRange.start).toBe(20251115);
    expect(result.dateRange.end).toBe(20251120);
    expect(result).toHaveProperty('entries');
    expect(result.entries).toHaveLength(2);
  });

  it('should filter by search term if provided', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        name: 'nov 15th, 2025',
        journalDay: 20251115,
        'journal?': true
      }
    ]);

    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 10, content: 'Important meeting notes' },
      { id: 11, content: 'Random thoughts' }
    ]);

    const result = await queryByDateRange(
      mockClient,
      20251115,
      20251115,
      'meeting'
    );

    expect(result.entries[0].blocks).toHaveLength(1);
    expect(result.entries[0].blocks[0].content).toContain('meeting');
  });

  it('should handle empty date range', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValue([]);

    const result = await queryByDateRange(mockClient, 20990101, 20990102);

    expect(result.entries).toHaveLength(0);
  });

  it('should validate date format', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    await expect(queryByDateRange(mockClient, 99999999, 20251120))
      .rejects.toThrow('Invalid date format');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- query-by-date-range.test.ts`

Expected: FAIL with "Cannot find module './query-by-date-range.js'"

**Step 3: Write minimal implementation**

Create `src/tools/query-by-date-range.ts`:

```typescript
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

  // Query for journal pages in date range
  // Note: LogSeq doesn't have a direct API for this, so we need to query all journals
  // and filter. In a real implementation, you might want to optimize this.
  const allJournals = await client.callAPI<PageEntity[]>(
    'logseq.DB.q',
    ['(page-property :journal? true)']
  );

  // Filter by date range
  const journalsInRange = (allJournals || []).filter(page => {
    return (
      page['journal?'] &&
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
```

**Step 4: Run test to verify it passes**

Run: `npm test -- query-by-date-range.test.ts`

Expected: PASS

**Step 5: Register tool in MCP server**

Add import in `src/index.ts`:
```typescript
import { queryByDateRange } from './tools/query-by-date-range.js';
```

Add tool schema:
```typescript
  {
    name: 'logseq_query_by_date_range',
    description: 'Query journal entries within a date range with optional search filter',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'number',
          description: 'Start date in YYYYMMDD format (e.g., 20251115)',
        },
        end_date: {
          type: 'number',
          description: 'End date in YYYYMMDD format (e.g., 20251120)',
        },
        search_term: {
          type: 'string',
          description: 'Optional search term to filter blocks',
        },
      },
      required: ['start_date', 'end_date'],
    },
  },
```

Add handler case:
```typescript
        case 'logseq_query_by_date_range': {
          const startDate = args?.start_date as number;
          const endDate = args?.end_date as number;
          const searchTerm = args?.search_term as string | undefined;
          const result = await queryByDateRange(
            client,
            startDate,
            endDate,
            searchTerm
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }
```

(Add same case to duplicate handler)

**Step 6: Run all tests**

Run: `npm test`

Expected: All tests PASS

**Step 7: Build**

Run: `npm run build`

Expected: Build succeeds

**Step 8: Commit**

```bash
git add src/tools/query-by-date-range.ts src/tools/query-by-date-range.test.ts src/index.ts
git commit -m "feat: add query_by_date_range for temporal queries"
```

---

## Task 2: Add get_concept_evolution tool

**Files:**
- Create: `src/tools/get-concept-evolution.ts`
- Create: `src/tools/get-concept-evolution.test.ts`
- Modify: `src/index.ts` (add import, schema, handler)

**Step 1: Write the failing test**

Create `src/tools/get-concept-evolution.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { getConceptEvolution } from './get-concept-evolution.js';
import { LogseqClient } from '../client.js';

describe('getConceptEvolution', () => {
  it('should track how concept appears over time', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock search for concept
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'First mention of [[Concept]]',
        page: { journalDay: 20251101, name: 'nov 1st, 2025' }
      },
      {
        id: 2,
        content: 'Later thoughts on [[Concept]]',
        page: { journalDay: 20251115, name: 'nov 15th, 2025' }
      },
      {
        id: 3,
        content: 'Updated understanding of [[Concept]]',
        page: { journalDay: 20251120, name: 'nov 20th, 2025' }
      }
    ]);

    const result = await getConceptEvolution(mockClient, 'Concept');

    expect(result).toHaveProperty('concept', 'Concept');
    expect(result).toHaveProperty('timeline');
    expect(result.timeline).toHaveLength(3);
    expect(result.timeline[0].date).toBe(20251101);
    expect(result.timeline[2].date).toBe(20251120);
  });

  it('should group mentions by time period', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'Week 1 mention',
        page: { journalDay: 20251101 }
      },
      {
        id: 2,
        content: 'Also week 1',
        page: { journalDay: 20251102 }
      },
      {
        id: 3,
        content: 'Week 2 mention',
        page: { journalDay: 20251108 }
      }
    ]);

    const result = await getConceptEvolution(
      mockClient,
      'Concept',
      { groupBy: 'week' }
    );

    expect(result).toHaveProperty('groupedTimeline');
    expect(result.groupedTimeline).toBeDefined();
  });

  it('should handle concepts with no temporal data', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'Non-journal mention',
        page: { name: 'Regular Page', 'journal?': false }
      }
    ]);

    const result = await getConceptEvolution(mockClient, 'Concept');

    expect(result.timeline).toHaveLength(1);
    expect(result.timeline[0].date).toBeNull();
  });

  it('should filter by date range', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'Old mention',
        page: { journalDay: 20240101 }
      },
      {
        id: 2,
        content: 'Recent mention',
        page: { journalDay: 20251115 }
      }
    ]);

    const result = await getConceptEvolution(
      mockClient,
      'Concept',
      { startDate: 20251101, endDate: 20251231 }
    );

    expect(result.timeline).toHaveLength(1);
    expect(result.timeline[0].date).toBe(20251115);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- get-concept-evolution.test.ts`

Expected: FAIL with "Cannot find module './get-concept-evolution.js'"

**Step 3: Write minimal implementation**

Create `src/tools/get-concept-evolution.ts`:

```typescript
import { LogseqClient } from '../client.js';
import { BlockEntity } from '../types.js';

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

  // Search for blocks mentioning the concept
  const blocks = await client.callAPI<BlockEntity[]>(
    'logseq.Editor.getPageBlocksTree',
    [conceptName]
  );

  // Also search for inline mentions
  const searchBlocks = await client.callAPI<BlockEntity[]>(
    'logseq.DB.q',
    [`(block-content "[[${conceptName}]]")`]
  );

  // Combine and deduplicate
  const allBlocks = [...(blocks || []), ...(searchBlocks || [])];
  const uniqueBlocks = Array.from(
    new Map(allBlocks.map(b => [b.id, b])).values()
  );

  // Filter by date range
  let filteredBlocks = uniqueBlocks;
  if (startDate || endDate) {
    filteredBlocks = uniqueBlocks.filter(block => {
      const blockDate = block.page?.journalDay;
      if (!blockDate) return true; // Keep non-journal blocks

      if (startDate && blockDate < startDate) return false;
      if (endDate && blockDate > endDate) return false;
      return true;
    });
  }

  // Build timeline
  const timelineMap = new Map<number | null, BlockEntity[]>();

  for (const block of filteredBlocks) {
    const date = block.page?.journalDay || null;

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
      const date = block.page?.journalDay;
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
    .map(b => b.page?.journalDay)
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
```

**Step 4: Run test to verify it passes**

Run: `npm test -- get-concept-evolution.test.ts`

Expected: PASS

**Step 5: Register tool in MCP server**

Add import in `src/index.ts`:
```typescript
import { getConceptEvolution } from './tools/get-concept-evolution.js';
```

Add tool schema:
```typescript
  {
    name: 'logseq_get_concept_evolution',
    description: 'Track how a concept evolves over time through journal entries',
    inputSchema: {
      type: 'object',
      properties: {
        concept_name: {
          type: 'string',
          description: 'Name of the concept to track',
        },
        start_date: {
          type: 'number',
          description: 'Optional start date in YYYYMMDD format',
        },
        end_date: {
          type: 'number',
          description: 'Optional end date in YYYYMMDD format',
        },
        group_by: {
          type: 'string',
          enum: ['day', 'week', 'month'],
          description: 'Optional grouping period',
        },
      },
      required: ['concept_name'],
    },
  },
```

Add handler case:
```typescript
        case 'logseq_get_concept_evolution': {
          const conceptName = args?.concept_name as string;
          const options = {
            startDate: args?.start_date as number | undefined,
            endDate: args?.end_date as number | undefined,
            groupBy: args?.group_by as any
          };
          const result = await getConceptEvolution(client, conceptName, options);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }
```

(Add same case to duplicate handler)

**Step 6: Run all tests**

Run: `npm test`

Expected: All tests PASS

**Step 7: Build**

Run: `npm run build`

Expected: Build succeeds

**Step 8: Commit**

```bash
git add src/tools/get-concept-evolution.ts src/tools/get-concept-evolution.test.ts src/index.ts
git commit -m "feat: add get_concept_evolution for temporal analysis"
```

---

## Task 3: Integration testing

**Files:**
- Create: `tests/integration/temporal-queries.test.ts`

**Step 1: Write integration tests**

Create `tests/integration/temporal-queries.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { LogseqClient } from '../../src/client.js';

describe('Temporal Queries Integration', () => {
  const shouldRun = !!process.env.LOGSEQ_TEST_API_URL;

  it.skipIf(!shouldRun)('query_by_date_range returns journal entries', async () => {
    const client = new LogseqClient({
      apiUrl: process.env.LOGSEQ_TEST_API_URL!,
      authToken: process.env.LOGSEQ_TEST_TOKEN!
    });

    const { queryByDateRange } = await import(
      '../../src/tools/query-by-date-range.js'
    );

    // Query last 7 days
    const today = new Date();
    const endDate = parseInt(
      today.toISOString().slice(0, 10).replace(/-/g, '')
    );
    const startDate = endDate - 7;

    const result = await queryByDateRange(client, startDate, endDate);

    expect(result).toHaveProperty('entries');
    expect(result).toHaveProperty('summary');
    expect(Array.isArray(result.entries)).toBe(true);
  });

  it.skipIf(!shouldRun)('get_concept_evolution tracks mentions over time', async () => {
    const client = new LogseqClient({
      apiUrl: process.env.LOGSEQ_TEST_API_URL!,
      authToken: process.env.LOGSEQ_TEST_TOKEN!
    });

    const { getConceptEvolution } = await import(
      '../../src/tools/get-concept-evolution.js'
    );

    const result = await getConceptEvolution(client, 'Test Concept');

    expect(result).toHaveProperty('concept');
    expect(result).toHaveProperty('timeline');
    expect(result).toHaveProperty('summary');
    expect(Array.isArray(result.timeline)).toBe(true);
  });
});
```

**Step 2: Run integration tests**

Run: `npm run test:integration`

Expected: Tests skip or PASS if configured

**Step 3: Commit**

```bash
git add tests/integration/temporal-queries.test.ts
git commit -m "test: add integration tests for temporal queries"
```

---

## Task 4: Add date utility helpers

**Files:**
- Create: `src/utils/date-utils.ts`
- Create: `src/utils/date-utils.test.ts`

**Step 1: Write the failing test**

Create `src/utils/date-utils.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  parseLogseqDate,
  formatLogseqDate,
  addDays,
  getDateRange,
  isWeekend
} from './date-utils.js';

describe('Date Utils', () => {
  it('should parse LogSeq date format', () => {
    const result = parseLogseqDate(20251120);
    expect(result).toBeInstanceOf(Date);
    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(10); // November (0-indexed)
    expect(result.getDate()).toBe(20);
  });

  it('should format date to LogSeq format', () => {
    const date = new Date(2025, 10, 20); // Nov 20, 2025
    const result = formatLogseqDate(date);
    expect(result).toBe(20251120);
  });

  it('should add days to LogSeq date', () => {
    const result = addDays(20251120, 3);
    expect(result).toBe(20251123);
  });

  it('should generate date range', () => {
    const result = getDateRange(20251118, 20251120);
    expect(result).toEqual([20251118, 20251119, 20251120]);
  });

  it('should detect weekends', () => {
    expect(isWeekend(20251122)).toBe(true); // Saturday
    expect(isWeekend(20251120)).toBe(false); // Thursday
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- date-utils.test.ts`

Expected: FAIL with "Cannot find module './date-utils.js'"

**Step 3: Write implementation**

Create `src/utils/date-utils.ts`:

```typescript
/**
 * Parse LogSeq date format (YYYYMMDD) to Date object
 * @param logseqDate - Date in YYYYMMDD format
 * @returns Date object
 */
export function parseLogseqDate(logseqDate: number): Date {
  const str = logseqDate.toString();
  const year = parseInt(str.substring(0, 4));
  const month = parseInt(str.substring(4, 6)) - 1; // 0-indexed
  const day = parseInt(str.substring(6, 8));

  return new Date(year, month, day);
}

/**
 * Format Date object to LogSeq date format (YYYYMMDD)
 * @param date - Date object
 * @returns Date in YYYYMMDD format
 */
export function formatLogseqDate(date: Date): number {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');

  return parseInt(`${year}${month}${day}`);
}

/**
 * Add days to a LogSeq date
 * @param logseqDate - Date in YYYYMMDD format
 * @param days - Number of days to add (can be negative)
 * @returns New date in YYYYMMDD format
 */
export function addDays(logseqDate: number, days: number): number {
  const date = parseLogseqDate(logseqDate);
  date.setDate(date.getDate() + days);
  return formatLogseqDate(date);
}

/**
 * Generate array of dates in a range
 * @param startDate - Start date in YYYYMMDD format
 * @param endDate - End date in YYYYMMDD format
 * @returns Array of dates in YYYYMMDD format
 */
export function getDateRange(startDate: number, endDate: number): number[] {
  const dates: number[] = [];
  let current = startDate;

  while (current <= endDate) {
    dates.push(current);
    current = addDays(current, 1);
  }

  return dates;
}

/**
 * Check if a date is a weekend
 * @param logseqDate - Date in YYYYMMDD format
 * @returns true if Saturday or Sunday
 */
export function isWeekend(logseqDate: number): boolean {
  const date = parseLogseqDate(logseqDate);
  const dayOfWeek = date.getDay();
  return dayOfWeek === 0 || dayOfWeek === 6; // Sunday or Saturday
}

/**
 * Get week number for a date
 * @param logseqDate - Date in YYYYMMDD format
 * @returns Week number (1-53)
 */
export function getWeekNumber(logseqDate: number): number {
  const date = parseLogseqDate(logseqDate);
  const startOfYear = new Date(date.getFullYear(), 0, 1);
  const dayOfYear = Math.floor(
    (date.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24)
  );

  return Math.ceil((dayOfYear + startOfYear.getDay() + 1) / 7);
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- date-utils.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/utils/date-utils.ts src/utils/date-utils.test.ts
git commit -m "feat: add date utility helpers for temporal operations"
```

---

## Execution Complete

Temporal query capabilities added:
- ✅ `query_by_date_range` - Query journal entries in date range
- ✅ `get_concept_evolution` - Track concept mentions over time
- ✅ Date utility helpers for temporal operations
- ✅ Support for grouping by day/week/month

**Next steps:**
1. Add calendar view generation
2. Implement habit tracking queries
3. Add statistics (most active days, writing streaks, etc.)
4. Create visualizations for temporal data
