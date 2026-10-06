import { describe, it, expect, vi } from 'vitest';
import { queryJournals, queryByDateRange, BUILT_IN_CONCEPTS } from './query-by-date-range.js';
import { LogseqClient } from '../client.js';

// Datalog pull shapes with the nested `:block/refs` pull: each ref is a page map.
function journalPage(id: number, day: number) {
  return {
    id,
    uuid: `page-uuid-${id}`,
    name: `day ${day}`,
    'original-name': `Day ${day}`,
    'journal-day': day,
    'journal?': true
  };
}

/** A pulled ref to an ordinary page; `name` is lowercase, `original-name` keeps case. */
function ref(id: number, original: string) {
  return { id, name: original.toLowerCase(), 'original-name': original, 'journal?': false };
}

function journalRef(id: number, day: number) {
  return {
    id,
    name: `day ${day}`,
    'original-name': `Day ${day}`,
    'journal?': true,
    'journal-day': day
  };
}

function block(
  id: number,
  pageId: number,
  parentId: number,
  leftId: number,
  content: string,
  refs: any[] = []
) {
  return {
    id,
    uuid: `block-uuid-${id}`,
    content,
    format: 'markdown',
    page: { id: pageId },
    parent: { id: parentId },
    left: { id: leftId },
    ...(refs.length > 0 ? { refs } : {})
  };
}

function mockClient(pages: any[], blocks: any[]) {
  const executeDatalogQuery = vi
    .fn()
    .mockResolvedValueOnce(pages.map(p => [p]))
    .mockResolvedValueOnce(blocks.map(b => [b]))
    .mockResolvedValue([]); // a search term's alias lookup
  return { client: { executeDatalogQuery } as unknown as LogseqClient, executeDatalogQuery };
}

const alice = ref(100, 'Alice');
const atlas = ref(101, 'Project Atlas');
const bob = ref(102, 'Bob');

const RANGE = { startDate: 20250101, endDate: 20250103 };

describe('summary.topConcepts', () => {
  it('counts nested children, with original-case names', async () => {
    const { client } = mockClient(
      [journalPage(1, 20250101)],
      [
        block(10, 1, 1, 1, 'Top with [[Alice]]', [alice]),
        block(11, 1, 10, 10, 'Child about [[Alice]] and [[Project Atlas]]', [alice, atlas]),
        block(12, 1, 11, 11, 'Grandchild with [[Project Atlas]]', [atlas])
      ]
    );

    const result = await queryJournals(client, RANGE);

    expect(result.summary.topConcepts).toEqual([
      { name: 'Alice', count: 2, days: 1 },
      { name: 'Project Atlas', count: 2, days: 1 }
    ]);
  });

  it('has count greater than days when a concept repeats within one day', async () => {
    const { client } = mockClient(
      [journalPage(1, 20250101), journalPage(2, 20250102)],
      [
        block(10, 1, 1, 1, 'one', [alice]),
        block(11, 1, 1, 10, 'two', [alice]),
        block(12, 1, 1, 11, 'three', [alice]),
        block(20, 2, 2, 2, 'next day', [alice])
      ]
    );

    const result = await queryJournals(client, RANGE);

    expect(result.summary.topConcepts).toEqual([{ name: 'Alice', count: 4, days: 2 }]);
  });

  it('merges a tag and a [[link]] to the same page (one ref per block, one page id)', async () => {
    const { client } = mockClient(
      [journalPage(1, 20250101)],
      [
        block(10, 1, 1, 1, 'Talked to [[Project Atlas]]', [atlas]),
        block(11, 1, 1, 10, 'Status #[[Project Atlas]]', [atlas]),
        block(12, 1, 1, 11, 'More #project-atlas', [{ ...atlas, 'original-name': 'Project Atlas' }])
      ]
    );

    const result = await queryJournals(client, RANGE);

    expect(result.summary.topConcepts).toEqual([{ name: 'Project Atlas', count: 3, days: 1 }]);
  });

  it('counts a page once per block even if the pull repeats it', async () => {
    const { client } = mockClient(
      [journalPage(1, 20250101)],
      [block(10, 1, 1, 1, 'x', [alice, alice])]
    );

    const result = await queryJournals(client, RANGE);

    expect(result.summary.topConcepts).toEqual([{ name: 'Alice', count: 1, days: 1 }]);
  });

  describe('exclusions', () => {
    it('drops journal pages, built-in markers and refs without a name', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101)],
        [
          block(10, 1, 1, 1, 'TODO call [[Alice]] on [[Jan 2nd, 2025]]', [
            ref(200, 'TODO'),
            alice,
            journalRef(201, 20250102)
          ]),
          block(11, 1, 1, 10, 'a block ref', [{ id: 300 }]),
          block(12, 1, 1, 11, 'DONE', [ref(203, 'DONE'), ref(202, 'card')])
        ]
      );

      const result = await queryJournals(client, RANGE);

      expect(result.summary.topConcepts).toEqual([{ name: 'Alice', count: 1, days: 1 }]);
    });

    it('excludes a journal ref by its journal-day alone', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101)],
        [block(10, 1, 1, 1, 'x', [{ id: 400, name: 'jan 2nd, 2025', 'journal-day': 20250102 }])]
      );

      const result = await queryJournals(client, RANGE);

      expect(result.summary.topConcepts).toEqual([]);
    });

    it.each([...BUILT_IN_CONCEPTS])('excludes the built-in page %s', async name => {
      const { client } = mockClient(
        [journalPage(1, 20250101)],
        [block(10, 1, 1, 1, 'x', [ref(500, name.toUpperCase())])]
      );

      const result = await queryJournals(client, RANGE);

      expect(result.summary.topConcepts).toEqual([]);
    });

    it('lists the markers and the card tag', () => {
      for (const name of ['todo', 'done', 'doing', 'now', 'later', 'card', 'waiting', 'canceled']) {
        expect(BUILT_IN_CONCEPTS.has(name)).toBe(true);
      }
    });
  });

  it('is an empty list for an empty range, with one call', async () => {
    const { client, executeDatalogQuery } = mockClient([], []);

    const result = await queryJournals(client, RANGE);

    expect(result.summary.topConcepts).toEqual([]);
    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
  });

  it('is an empty list when the days have no references', async () => {
    const { client } = mockClient(
      [journalPage(1, 20250101)],
      [block(10, 1, 1, 1, 'plain text')]
    );

    const result = await queryJournals(client, RANGE);

    expect(result.summary.topConcepts).toEqual([]);
  });

  describe('ordering', () => {
    it('sorts by count, then days, then name', async () => {
      const zed = ref(103, 'Zed');
      const amy = ref(104, 'amy');
      const { client } = mockClient(
        [journalPage(1, 20250101), journalPage(2, 20250102)],
        [
          // Alice: 3 blocks on 1 day. Bob: 3 blocks on 2 days. Atlas: 1 block.
          block(10, 1, 1, 1, 'a', [alice]),
          block(11, 1, 1, 10, 'a', [alice]),
          block(12, 1, 1, 11, 'a', [alice, bob]),
          block(13, 1, 1, 12, 'b', [bob]),
          block(20, 2, 2, 2, 'b', [bob]),
          // Zed and amy tie on count 1, days 1: name decides, ignoring case.
          block(14, 1, 1, 13, 'c', [zed, amy, atlas])
        ]
      );

      const result = await queryJournals(client, RANGE);

      expect(result.summary.topConcepts!.map(c => c.name)).toEqual([
        'Bob',
        'Alice',
        'amy',
        'Project Atlas',
        'Zed'
      ]);
      expect(result.summary.topConcepts![0]).toEqual({ name: 'Bob', count: 3, days: 2 });
    });
  });

  describe('top_concepts_limit', () => {
    const setup = () =>
      mockClient(
        [journalPage(1, 20250101)],
        [
          block(10, 1, 1, 1, 'a', [alice, atlas, bob]),
          block(11, 1, 1, 10, 'b', [alice, atlas]),
          block(12, 1, 1, 11, 'c', [alice])
        ]
      );

    it('defaults to 10', async () => {
      const many = Array.from({ length: 12 }, (_, i) => ref(600 + i, `Concept ${i}`));
      const { client } = mockClient(
        [journalPage(1, 20250101)],
        [block(10, 1, 1, 1, 'x', many)]
      );

      const result = await queryJournals(client, RANGE);

      expect(result.summary.topConcepts).toHaveLength(10);
    });

    it('keeps the best N', async () => {
      const { client } = setup();

      const result = await queryJournals(client, { ...RANGE, topConceptsLimit: 2 });

      expect(result.summary.topConcepts).toEqual([
        { name: 'Alice', count: 3, days: 1 },
        { name: 'Project Atlas', count: 2, days: 1 }
      ]);
    });

    it('0 leaves topConcepts out of the summary', async () => {
      const { client } = setup();

      const result = await queryJournals(client, { ...RANGE, topConceptsLimit: 0 });

      expect(result.summary).not.toHaveProperty('topConcepts');
      expect(result.summary.totalBlocks).toBe(3);
    });

    it.each([-1, 1.5, Number.NaN])('rejects %s without calling LogSeq', async limit => {
      const { client, executeDatalogQuery } = setup();

      await expect(queryJournals(client, { ...RANGE, topConceptsLimit: limit })).rejects.toThrow(
        /top_concepts_limit/
      );
      expect(executeDatalogQuery).not.toHaveBeenCalled();
    });
  });

  describe('range modes and result shapes', () => {
    const pages = [journalPage(1, 20250101), journalPage(2, 20250102)];
    const blocks = [
      block(10, 1, 1, 1, 'Met [[Alice]]', [alice]),
      block(20, 2, 2, 2, 'Met [[Alice]] again', [alice])
    ];
    const expected = [{ name: 'Alice', count: 2, days: 2 }];

    it('works for last_n', async () => {
      const { client } = mockClient(pages, blocks);

      const result = await queryJournals(client, { lastN: 2 }, new Date(2025, 0, 3));

      expect(result.summary.topConcepts).toEqual(expected);
    });

    it('works for a preset', async () => {
      const { client } = mockClient(pages, blocks);

      const result = await queryJournals(client, { preset: 'last_week' }, new Date(2025, 0, 8));

      expect(result.summary.topConcepts).toEqual(expected);
    });

    it('works with include_content: false', async () => {
      const { client } = mockClient(pages, blocks);

      const result = await queryJournals(client, { ...RANGE, includeContent: false });

      expect(result.entries[0]).toHaveProperty('snippets');
      expect(result.summary.topConcepts).toEqual(expected);
    });

    it('works with slim results', async () => {
      const { client } = mockClient(pages, blocks);

      const result = await queryJournals(client, { ...RANGE, slimResults: true });

      expect(result.summary.topConcepts).toEqual(expected);
    });

    it('works through queryByDateRange', async () => {
      const { client } = mockClient(pages, blocks);

      const result = await queryByDateRange(client, 20250101, 20250103);

      expect(result.summary.topConcepts).toEqual(expected);
    });

    it('counts only the blocks that are returned when search_term filters', async () => {
      const { client } = mockClient(pages, [
        block(10, 1, 1, 1, 'Met [[Alice]]', [alice]),
        block(11, 1, 1, 10, 'Lunch with [[Bob]]', [bob]),
        block(20, 2, 2, 2, 'Met [[Alice]] again', [alice])
      ]);

      const result = await queryJournals(client, { ...RANGE, searchTerm: 'alice' });

      expect(result.summary.topConcepts).toEqual(expected);
    });
  });

  describe('call count and output shape', () => {
    it('still makes 2 calls and sends no extra query', async () => {
      const { client, executeDatalogQuery } = mockClient(
        [journalPage(1, 20250101)],
        [block(10, 1, 1, 1, 'x', [alice])]
      );

      await queryJournals(client, RANGE);

      expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
    });

    it('returns refs as bare ids in full results, as before', async () => {
      const { client } = mockClient(
        [journalPage(1, 20250101)],
        [block(10, 1, 1, 1, 'x', [alice, { id: 300 }])]
      );

      const result: any = await queryJournals(client, RANGE);

      expect(result.entries[0].blocks[0].refs).toEqual([{ id: 100 }, { id: 300 }]);
    });
  });
});
