import { describe, it, expect, vi } from 'vitest';
import { queryByDateRange, queryJournals } from './query-by-date-range.js';
import { LogseqClient } from '../client.js';

// Datalog pull `[*]` shapes: kebab-case keys, refs as `{id}`, no children/level.
function journalPage(id: number, day: number, label: string) {
  return {
    id,
    uuid: `page-uuid-${id}`,
    name: label.toLowerCase(),
    'original-name': label,
    'journal-day': day,
    'journal?': true
  };
}

function block(id: number, pageId: number, parentId: number, leftId: number, content: string, extra: Record<string, any> = {}) {
  return {
    id,
    uuid: `block-uuid-${id}`,
    content,
    format: 'markdown',
    page: { id: pageId },
    parent: { id: parentId },
    left: { id: leftId },
    ...extra
  };
}

/** Client whose Datalog calls resolve to `pages` first, then `blocks`. */
function mockClient(pages: any[], blocks: any[]) {
  const executeDatalogQuery = vi
    .fn()
    .mockResolvedValueOnce(pages.map(p => [p]))
    .mockResolvedValueOnce(blocks.map(b => [b]))
    .mockResolvedValue([]); // a search term's alias lookup
  return { client: { executeDatalogQuery } as unknown as LogseqClient, executeDatalogQuery };
}

describe('queryByDateRange', () => {
  it('should return journal entries within date range', async () => {
    const { client } = mockClient(
      [journalPage(1, 20250101, 'Day One'), journalPage(2, 20250105, 'Day Five')],
      [block(10, 1, 1, 1, 'Entry one'), block(20, 2, 2, 2, 'Entry five')]
    );

    const result = await queryByDateRange(client, 20250101, 20250105);

    expect(result.dateRange).toEqual({ start: 20250101, end: 20250105 });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map(e => e.date)).toEqual([20250101, 20250105]);
    expect(result.summary).toEqual({ totalDays: 2, totalBlocks: 2, searchTerm: undefined, topConcepts: [] });
  });

  it('should send the date bounds as :in inputs and use at most 2 calls', async () => {
    const { client, executeDatalogQuery } = mockClient(
      [journalPage(1, 20250101, 'Day One')],
      [block(10, 1, 1, 1, 'Entry')]
    );

    await queryByDateRange(client, 20250101, 20250131);

    expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
    for (const [query, ...inputs] of executeDatalogQuery.mock.calls) {
      expect(query).toContain(':in $ ?start ?end');
      expect(query).toContain(':block/journal-day');
      expect(query).not.toContain('20250101');
      expect(inputs).toEqual([20250101, 20250131]);
    }
  });

  it('should not scale calls with the length of the range', async () => {
    const pages = Array.from({ length: 31 }, (_, i) => journalPage(i + 1, 20250101 + i, `Day ${i + 1}`));
    const blocks = pages.map(p => block(p.id * 100, p.id, p.id, p.id, 'Entry'));
    const callAPI = vi.fn();
    const { client, executeDatalogQuery } = mockClient(pages, blocks);
    (client as any).callAPI = callAPI;

    const result = await queryByDateRange(client, 20250101, 20250131);

    expect(result.entries).toHaveLength(31);
    expect(executeDatalogQuery.mock.calls.length).toBeLessThanOrEqual(2);
    expect(callAPI).not.toHaveBeenCalled();
  });

  it('should sort entries by date even when the query returns them out of order', async () => {
    const { client } = mockClient(
      [journalPage(2, 20250103, 'Day Three'), journalPage(1, 20250101, 'Day One')],
      []
    );

    const result = await queryByDateRange(client, 20250101, 20250103);

    expect(result.entries.map(e => e.date)).toEqual([20250101, 20250103]);
  });

  it('should return Editor-API-shaped pages and blocks (camelCase, children, level)', async () => {
    const { client } = mockClient(
      [journalPage(1, 20250101, 'Day One')],
      [block(10, 1, 1, 1, 'Entry', { 'path-refs': [{ id: 1 }] })]
    );

    const result: any = await queryByDateRange(client, 20250101, 20250101);

    expect(result.entries[0].page).toMatchObject({
      id: 1,
      journalDay: 20250101,
      originalName: 'Day One',
      'journal?': true
    });
    expect(result.entries[0].blocks[0]).toMatchObject({
      id: 10,
      uuid: 'block-uuid-10',
      content: 'Entry',
      pathRefs: [{ id: 1 }],
      level: 1,
      children: []
    });
  });

  describe('block tree rebuild', () => {
    it('should nest children under their parents', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101, 'Day One')],
        [
          block(10, 1, 1, 1, 'Top'),
          block(11, 1, 10, 10, 'Child'),
          block(12, 1, 11, 11, 'Grandchild')
        ]
      );

      const result: any = await queryByDateRange(client, 20250101, 20250101);

      const top = result.entries[0].blocks;
      expect(top).toHaveLength(1);
      expect(top[0].children.map((b: any) => b.content)).toEqual(['Child']);
      expect(top[0].children[0].children.map((b: any) => b.content)).toEqual(['Grandchild']);
      expect(top[0].level).toBe(1);
      expect(top[0].children[0].level).toBe(2);
      expect(top[0].children[0].children[0].level).toBe(3);
      expect(result.summary.totalBlocks).toBe(1);
    });

    it('should order siblings by the :block/left chain, not by result order', async () => {
      // Chain: first (left = page) -> second -> third. Results arrive shuffled.
      const { client } = mockClient(
        [journalPage(1, 20250101, 'Day One')],
        [
          block(30, 1, 1, 20, 'third'),
          block(10, 1, 1, 1, 'first'),
          block(20, 1, 1, 10, 'second')
        ]
      );

      const result: any = await queryByDateRange(client, 20250101, 20250101);

      const top = result.entries[0].blocks;
      expect(top.map((b: any) => b.content)).toEqual(['first', 'second', 'third']);
    });

    it('should order nested siblings by the left chain', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101, 'Day One')],
        [
          block(10, 1, 1, 1, 'parent'),
          block(13, 1, 10, 12, 'c'),
          block(11, 1, 10, 10, 'a'),
          block(12, 1, 10, 11, 'b')
        ]
      );

      const result: any = await queryByDateRange(client, 20250101, 20250101);

      expect(result.entries[0].blocks[0].children.map((b: any) => b.content)).toEqual(['a', 'b', 'c']);
    });

    it('should keep every block when the left chain is broken', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101, 'Day One')],
        [block(10, 1, 1, 1, 'one'), block(20, 1, 1, 999, 'two'), block(30, 1, 1, 998, 'three')]
      );

      const result: any = await queryByDateRange(client, 20250101, 20250101);

      expect(result.entries[0].blocks.map((b: any) => b.content).sort()).toEqual(['one', 'three', 'two']);
    });

    it('should assign blocks to the page they belong to', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101, 'Day One'), journalPage(2, 20250102, 'Day Two')],
        [
          block(20, 2, 2, 2, 'on day two'),
          block(10, 1, 1, 1, 'on day one'),
          block(21, 2, 20, 20, 'child on day two')
        ]
      );

      const result: any = await queryByDateRange(client, 20250101, 20250102);

      expect(result.entries[0].blocks.map((b: any) => b.content)).toEqual(['on day one']);
      expect(result.entries[1].blocks.map((b: any) => b.content)).toEqual(['on day two']);
      expect(result.entries[1].blocks[0].children[0].content).toBe('child on day two');
    });
  });

  describe('search term', () => {
    it('should filter top-level blocks case-insensitively and keep their children', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101, 'Day One')],
        [
          block(10, 1, 1, 1, 'Important MEETING notes'),
          block(11, 1, 10, 10, 'unrelated child'),
          block(12, 1, 1, 10, 'Random thoughts')
        ]
      );

      const result: any = await queryByDateRange(client, 20250101, 20250101, 'meeting');

      expect(result.entries[0].blocks).toHaveLength(1);
      expect(result.entries[0].blocks[0].content).toContain('MEETING');
      expect(result.entries[0].blocks[0].children).toHaveLength(1);
      expect(result.summary).toMatchObject({ totalBlocks: 1, searchTerm: 'meeting' });
    });

    it('should not match on children alone and drops days with no matches', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101, 'Day One'), journalPage(2, 20250102, 'Day Two')],
        [
          block(10, 1, 1, 1, 'Top'),
          block(11, 1, 10, 10, 'needle in a child'),
          block(20, 2, 2, 2, 'has needle')
        ]
      );

      const result: any = await queryByDateRange(client, 20250101, 20250102, 'needle');

      expect(result.entries.map((e: any) => e.date)).toEqual([20250102]);
      expect(result.summary.totalDays).toBe(1);
    });
  });

  describe('days without blocks', () => {
    it('should return an entry with no blocks when there is no search term', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101, 'Day One'), journalPage(2, 20250102, 'Day Two')],
        [block(20, 2, 2, 2, 'only day two')]
      );

      const result = await queryByDateRange(client, 20250101, 20250102);

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].blocks).toEqual([]);
      expect(result.summary.totalDays).toBe(2);
      expect(result.summary.totalBlocks).toBe(1);
    });

    it('should handle an empty date range', async () => {
      const executeDatalogQuery = vi.fn().mockResolvedValue([]);
      const client = { executeDatalogQuery } as unknown as LogseqClient;

      const result = await queryByDateRange(client, 20990101, 20990102);

      expect(result.entries).toHaveLength(0);
      expect(result.summary).toMatchObject({ totalDays: 0, totalBlocks: 0 });
    });

    it('should report a real empty answer without a warning', async () => {
      const executeDatalogQuery = vi.fn().mockResolvedValue([]);
      const client = { executeDatalogQuery } as unknown as LogseqClient;

      const result = await queryByDateRange(client, 20990101, 20990102);

      expect(result).not.toHaveProperty('warnings');
      expect(result).not.toHaveProperty('hasMore');
    });

    // BR-0011: a null answer is not an empty one (#269)
    it('should warn, not report no journals, when the page query answers null', async () => {
      const executeDatalogQuery = vi.fn().mockResolvedValue(null);
      const client = { executeDatalogQuery } as unknown as LogseqClient;

      const result = await queryByDateRange(client, 20990101, 20990102);

      expect(result.entries).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.warnings).toEqual([
        {
          code: 'journals_unavailable',
          message:
            'LogSeq returned no answer when looking up journal pages (possibly no graph open or a re-index ' +
            'in progress), so the empty result may not mean there are no journals in this range. ' +
            'Retry in a moment, or call logseq_get_graph_info to check which graph is open.'
        }
      ]);
      // no howToFetchAll: no parameter fetches what LogSeq did not answer
      expect(result.warnings![0]).not.toHaveProperty('howToFetchAll');
      // nothing to look blocks up on, so the block query is not sent
      expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    });

    it('should warn on a null page answer for lastN too, and in slim and outline output', async () => {
      const executeDatalogQuery = vi.fn().mockResolvedValue(null);
      const client = { executeDatalogQuery } as unknown as LogseqClient;
      const now = new Date(2026, 0, 15);

      for (const extra of [{}, { slimResults: false, includeContent: false }, { slimResults: true }]) {
        const result = await queryJournals(client, { lastN: 3, ...extra }, now);
        expect(result.entries).toEqual([]);
        expect(result.warnings?.map(w => w.code)).toEqual(['journals_unavailable']);
      }
    });

    it('should warn, not show journals with no blocks, when the block query answers null', async () => {
      const executeDatalogQuery = vi
        .fn()
        .mockResolvedValueOnce([[journalPage(1, 20250101, 'Day One')], [journalPage(2, 20250102, 'Day Two')]])
        .mockResolvedValueOnce(null);
      const client = { executeDatalogQuery } as unknown as LogseqClient;

      const result = await queryByDateRange(client, 20250101, 20250102);

      // the pages are real, so they are listed; their blocks are what is unknown
      expect(result.entries.map(e => e.date)).toEqual([20250101, 20250102]);
      expect(result.hasMore).toBe(false);
      expect(result.warnings).toEqual([
        {
          code: 'blocks_unavailable',
          message:
            'LogSeq returned no answer when looking up the blocks on 2 journal page(s) (possibly no graph ' +
            'open or a re-index in progress), so their blocks are missing from this result. This does not ' +
            'mean the days are empty. Retry in a moment, or call logseq_get_graph_info to check which graph is open.'
        }
      ]);
      expect(result.warnings![0]).not.toHaveProperty('howToFetchAll');
    });

    it('should keep the blocks_unavailable warning next to a resolve_refs result', async () => {
      const executeDatalogQuery = vi
        .fn()
        .mockResolvedValueOnce([[journalPage(1, 20250101, 'Day One')]])
        .mockResolvedValueOnce(null);
      const client = { executeDatalogQuery } as unknown as LogseqClient;

      const result = await queryJournals(client, { startDate: 20250101, endDate: 20250101, resolveRefs: true });

      expect(result.warnings?.map(w => w.code)).toEqual(['blocks_unavailable']);
    });

    it('should not warn when the block query answers a real empty array', async () => {
      const executeDatalogQuery = vi
        .fn()
        .mockResolvedValueOnce([[journalPage(1, 20250101, 'Day One')]])
        .mockResolvedValueOnce([]);
      const client = { executeDatalogQuery } as unknown as LogseqClient;

      const result = await queryByDateRange(client, 20250101, 20250101);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].blocks).toEqual([]);
      expect(result).not.toHaveProperty('warnings');
    });
  });

  describe('validation', () => {
    it('should reject an invalid start date without querying', async () => {
      const executeDatalogQuery = vi.fn();
      const client = { executeDatalogQuery } as unknown as LogseqClient;

      await expect(queryByDateRange(client, 99999999, 20251120)).rejects.toThrow(/Invalid parameter.*start_date/);
      expect(executeDatalogQuery).not.toHaveBeenCalled();
    });

    it.each([NaN, Infinity, 20250101.5])('should reject non-integer date %s', async (bad) => {
      const executeDatalogQuery = vi.fn();
      const client = { executeDatalogQuery } as unknown as LogseqClient;

      await expect(queryByDateRange(client, bad, 20251120)).rejects.toThrow(/Invalid parameter/);
      await expect(queryByDateRange(client, 20250101, bad)).rejects.toThrow(/Invalid parameter/);
      expect(executeDatalogQuery).not.toHaveBeenCalled();
    });

    it('should reject start after end', async () => {
      const client = { executeDatalogQuery: vi.fn() } as unknown as LogseqClient;

      await expect(queryByDateRange(client, 20250105, 20250101)).rejects.toThrow(/date_range/);
    });
  });

  // Slim results tests
  describe('slim results mode', () => {
    it('should return slim results when slimResults=true', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101, 'Day One')],
        [block(10, 1, 1, 1, 'Meeting with #team about [[Project]]')]
      );

      const result = await queryByDateRange(client, 20250101, 20250101, undefined, true);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toHaveProperty('pageName', 'Day One');
      expect(result.entries[0]).not.toHaveProperty('page');

      const slim = result.entries[0].blocks[0];
      expect(slim).toHaveProperty('content', 'Meeting with #team about [[Project]]');
      // The entry names the page; its blocks don't repeat it (#42)
      expect(slim).not.toHaveProperty('pageName');
      expect(slim).toHaveProperty('tags', ['team']);
      expect(slim).toHaveProperty('pageRefs', ['Project']);
      expect(slim).toHaveProperty('uuid', 'block-uuid-10');
      expect(slim).not.toHaveProperty('id');
      expect(slim).not.toHaveProperty('page');
    });

    it('should preserve block hierarchy in slim results', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101, 'Day One')],
        [block(10, 1, 1, 1, 'Parent block'), block(11, 1, 10, 10, 'Child block')]
      );

      const result = await queryByDateRange(client, 20250101, 20250101, undefined, true);

      const slim = result.entries[0].blocks[0];
      expect(slim.children).toHaveLength(1);
      expect(slim.children![0].content).toBe('Child block');
      expect(slim.children![0].uuid).toBe('block-uuid-11');
      expect(slim.children![0]).not.toHaveProperty('id');
    });

    it('should return full results when slimResults=false (default)', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101, 'Day One')],
        [block(10, 1, 1, 1, 'Test block')]
      );

      const result = await queryByDateRange(client, 20250101, 20250101, undefined, false);

      expect(result.entries[0]).toHaveProperty('page');
      expect(result.entries[0]).not.toHaveProperty('pageName');
      expect(result.entries[0].blocks[0]).toMatchObject({ id: 10, uuid: 'block-uuid-10' });
      expect(result.entries[0].blocks[0]).toHaveProperty('page');
    });

    it('should omit empty fields in slim results', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101, 'Day One')],
        [block(10, 1, 1, 1, 'Simple block with no extras')]
      );

      const result = await queryByDateRange(client, 20250101, 20250101, undefined, true);

      const slim = result.entries[0].blocks[0];
      expect(slim).not.toHaveProperty('properties');
      expect(slim).not.toHaveProperty('marker');
      expect(slim).not.toHaveProperty('tags');
      expect(slim).not.toHaveProperty('pageRefs');
      expect(slim).not.toHaveProperty('children');
    });
  });
});
