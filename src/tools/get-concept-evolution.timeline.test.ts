import { describe, it, expect, vi } from 'vitest';
import { getConceptEvolution } from './get-concept-evolution.js';
import { LogseqClient } from '../client.js';

/** The resolver's answer: the concept page matched by its exact name. */
const RESOLVED_CONCEPT = [[{ id: 100, name: 'concept', 'original-name': 'Concept' }, 'name']];

/** A block from `getPageBlocksTree`: Editor API spelling, and its page is a bare `{ id }`. */
const treeBlock = (id: number, page: Record<string, unknown> = { id: 100 }) => ({
  id,
  uuid: `u-${id}`,
  content: `Block ${id} about [[Concept]]`,
  page
});

/** A block from the mentions query: a Datalog pull, so its page is spelled in kebab-case. */
const pulledBlock = (id: number, page: Record<string, unknown>) => ({
  id,
  uuid: `u-${id}`,
  content: `Block ${id} about [[Concept]]`,
  page
});

/** A journal page as the Editor API spells it. */
const editorJournal = (day: number) => ({ id: 1000 + day, name: `day ${day}`, journalDay: day });

/** A journal page as a Datalog pull spells it. */
const pulledJournal = (day: number) => ({ id: 2000 + day, name: `day ${day}`, 'journal-day': day });

/** The page of a concept that is not a journal. */
const editorConceptPage = { id: 100, name: 'concept', originalName: 'Concept', 'journal?': false };

/**
 * A client whose Editor API answers `tree` for `getPageBlocksTree` and `page` for `getPage`, and whose
 * mentions query answers `mentions`. Both can be `null`, which LogSeq answers for a page with no blocks.
 */
function clientWith(opts: { tree?: unknown[] | null; page?: unknown; mentions?: unknown[] | null }) {
  const { tree = [], page = null, mentions = [] } = opts;
  const callAPI = vi.fn(async (method: string) => {
    if (method === 'logseq.Editor.getPageBlocksTree') return tree;
    if (method === 'logseq.Editor.getPage') return page;
    throw new Error(`unexpected call: ${method}`);
  });
  const executeDatalogQuery = vi.fn(async (query: string) =>
    query.includes(':in $ ?n') ? RESOLVED_CONCEPT : mentions === null ? null : mentions.map(b => [b])
  );
  return { callAPI, executeDatalogQuery } as unknown as LogseqClient;
}

const idsOf = (blocks: Array<{ id: number }>) => blocks.map(b => b.id);

type Result = Awaited<ReturnType<typeof getConceptEvolution>>;

/** The block ids of each group. */
const grouped = (result: Result) =>
  Object.fromEntries(Object.entries(result.groupedTimeline!).map(([key, blocks]) => [key, idsOf(blocks)]));

describe('getConceptEvolution groupBy', () => {
  // Dates are in January and February so the week numbers don't depend on the machine's time zone:
  // the week is counted from local midnight on 1 January, which a daylight-saving change (March on)
  // would shift by an hour. Jan 1 + 6 days is day 6 of the year (week 1), Jan 1 + 7 is week 2.
  const tree = [
    treeBlock(1, editorJournal(20250101)),
    treeBlock(2, editorJournal(20250107)),
    treeBlock(3, editorJournal(20250108)),
    treeBlock(4, editorJournal(20250210)),
    treeBlock(5, editorJournal(20240115))
  ];

  it('groups by day, one key per journal day, keeping every block of a day', async () => {
    const mentions = [pulledBlock(6, pulledJournal(20250101)), pulledBlock(7, { id: 9, name: 'note' })];

    const result = await getConceptEvolution(clientWith({ tree, mentions }), 'Concept', { groupBy: 'day' });

    // Whole-object comparison: integer-like keys come out in numeric order, whatever the insertion order
    expect(grouped(result)).toEqual({ '20250101': [1, 6], '20250107': [2], '20250108': [3], '20250210': [4], '20240115': [5] });
  });

  it('groups by week, numbering weeks from 1 January (zero-padded, with the year)', async () => {
    const result = await getConceptEvolution(clientWith({ tree }), 'Concept', { groupBy: 'week' });

    expect(grouped(result)).toEqual({ '2025-W01': [1, 2], '2025-W02': [3], '2025-W06': [4], '2024-W03': [5] });
  });

  it('groups by month, as YYYYMM', async () => {
    const result = await getConceptEvolution(clientWith({ tree }), 'Concept', { groupBy: 'month' });

    expect(grouped(result)).toEqual({ '202501': [1, 2, 3], '202502': [4], '202401': [5] });
  });

  it.each(['day', 'week', 'month'] as const)('leaves a mention with no journal day out of the %s grouping', async period => {
    const blocks = [treeBlock(1, { id: 100, name: 'concept' }), treeBlock(2, editorJournal(20250101))];

    const result = await getConceptEvolution(clientWith({ tree: blocks }), 'Concept', { groupBy: period });

    expect(Object.values(grouped(result))).toEqual([[2]]);
    expect(result.timeline.flatMap(e => idsOf(e.blocks)).sort()).toEqual([1, 2]); // still in the timeline
  });

  it('groups nothing when no mention has a journal day', async () => {
    const result = await getConceptEvolution(clientWith({ tree: [treeBlock(1, { id: 100 })] }), 'Concept', {
      groupBy: 'week'
    });

    expect(result.groupedTimeline).toEqual({});
  });
});

describe('getConceptEvolution date range', () => {
  const blocks = [
    treeBlock(1, editorJournal(20250101)),
    treeBlock(2, editorJournal(20250105)),
    treeBlock(3, editorJournal(20250110)),
    treeBlock(4, editorJournal(20250115)),
    treeBlock(5, editorJournal(20250120)),
    treeBlock(6, { id: 100, name: 'concept' })
  ];
  const kept = async (options: { startDate?: number; endDate?: number }, mentions: unknown[] = []) => {
    const result = await getConceptEvolution(clientWith({ tree: blocks, mentions }), 'Concept', options);
    return result.timeline.flatMap(e => idsOf(e.blocks)).sort();
  };

  it('keeps a mention on the start day and one on the end day', async () => {
    expect(await kept({ startDate: 20250105, endDate: 20250115 })).toEqual([2, 3, 4, 6]);
  });

  it('applies a start date alone', async () => {
    expect(await kept({ startDate: 20250110 })).toEqual([3, 4, 5, 6]);
  });

  it('applies an end date alone', async () => {
    expect(await kept({ endDate: 20250110 })).toEqual([1, 2, 3, 6]);
  });

  it('keeps a mention with no journal day whatever the dates', async () => {
    expect(await kept({ startDate: 20260101, endDate: 20261231 })).toEqual([6]);
  });

  it('reads the journal day of a mention from a Datalog pull as well', async () => {
    const mentions = [pulledBlock(7, pulledJournal(20250105)), pulledBlock(8, pulledJournal(20250116))];

    expect(await kept({ startDate: 20250105, endDate: 20250115 }, mentions)).toEqual([2, 3, 4, 6, 7]);
  });

  it('counts only the mentions in range in the summary', async () => {
    const result = await getConceptEvolution(clientWith({ tree: blocks }), 'Concept', {
      startDate: 20250105,
      endDate: 20250115
    });

    expect(result.summary).toEqual({
      totalMentions: 4,
      dateRange: { earliest: 20250105, latest: 20250115 },
      journalMentions: 3,
      nonJournalMentions: 1
    });
  });
});

describe('getConceptEvolution page enrichment', () => {
  it('gives the blocks of the concept page the full page, as the tree carries only its id', async () => {
    const result = await getConceptEvolution(
      clientWith({ tree: [treeBlock(1), treeBlock(2)], page: editorConceptPage }),
      'Concept'
    );

    const blocks = result.timeline.flatMap(e => e.blocks);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) expect(block.page).toEqual(editorConceptPage);
  });

  it('dates the blocks of a journal page from the page, since the tree does not say', async () => {
    const result = await getConceptEvolution(
      clientWith({ tree: [treeBlock(1), treeBlock(2)], page: { ...editorJournal(20250301), id: 100 } }),
      'Concept'
    );

    expect(result.timeline.map(e => [e.date, idsOf(e.blocks)])).toEqual([[20250301, [1, 2]]]);
    expect(result.summary.journalMentions).toBe(2);
  });

  it('leaves the blocks as they are when the page is not found', async () => {
    const result = await getConceptEvolution(clientWith({ tree: [treeBlock(1, { id: 100 })], page: null }), 'Concept');

    expect(result.timeline[0].blocks[0].page).toEqual({ id: 100 });
  });
});

describe('getConceptEvolution when LogSeq answers null', () => {
  it('returns the mentions when the page tree is null', async () => {
    const mentions = [pulledBlock(7, pulledJournal(20250105)), pulledBlock(8, { id: 9, name: 'note' })];

    const result = await getConceptEvolution(clientWith({ tree: null, mentions }), 'Concept');

    expect(result.timeline.map(e => [e.date, idsOf(e.blocks)])).toEqual([
      [20250105, [7]],
      [null, [8]]
    ]);
    expect(result.summary.totalMentions).toBe(2);
  });

  it('returns the tree when the mentions query is null', async () => {
    const result = await getConceptEvolution(
      clientWith({ tree: [treeBlock(1, editorJournal(20250105))], mentions: null }),
      'Concept'
    );

    expect(result.timeline.map(e => [e.date, idsOf(e.blocks)])).toEqual([[20250105, [1]]]);
    expect(result.summary.totalMentions).toBe(1);
  });
});

describe('getConceptEvolution summary', () => {
  it('has no date range when no mention has a journal day', async () => {
    const result = await getConceptEvolution(
      clientWith({ tree: [treeBlock(1, { id: 100 }), treeBlock(2, { id: 101 })] }),
      'Concept'
    );

    expect(result.summary).toEqual({
      totalMentions: 2,
      dateRange: { earliest: null, latest: null },
      journalMentions: 0,
      nonJournalMentions: 2
    });
  });

  it('takes the earliest and latest day whatever order the blocks come in', async () => {
    const tree = [20250110, 20250103, 20250120, 20250105].map((day, i) => treeBlock(i + 1, editorJournal(day)));

    const result = await getConceptEvolution(clientWith({ tree }), 'Concept');

    expect(result.summary.dateRange).toEqual({ earliest: 20250103, latest: 20250120 });
  });
});

describe('getConceptEvolution cut warning when only undated mentions are cut', () => {
  it('says dates cannot reach them when every dated mention is kept but fewer undated ones than dated', async () => {
    const dated = [1, 2, 3, 4, 5].map(i => treeBlock(i, editorJournal(20250100 + i)));
    // More than the 500 maximum, so the warning spells out what the dates can reach
    const undated = Array.from({ length: 600 }, (_, i) => treeBlock(1000 + i, { id: 100, name: 'concept' }));

    const result = await getConceptEvolution(clientWith({ tree: [...dated, ...undated] }), 'Concept', { maxEntries: 6 });

    // The 5 dated mentions and 1 undated one are kept: no dated mention is cut, so no date can help
    expect(result.timeline.map(e => e.blocks.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(result.timeline[5].date).toBeNull();
    expect(result.warnings![0].howToFetchAll).toContain("can't reach the rest");
    expect(result.warnings![0].howToFetchAll).not.toContain('Narrow start_date');
  });
});
