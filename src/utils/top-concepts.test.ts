import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_CONCEPTS,
  extractConceptRefs,
  rollUpTopConcepts,
  type ConceptRef
} from './top-concepts.js';
import type { BlockEntity } from '../types.js';

// Only `id` and `children` matter to the roll-up
const blk = (id: number, children?: BlockEntity[]): BlockEntity =>
  ({ id, uuid: `u${id}`, content: `b${id}`, ...(children ? { children } : {}) }) as BlockEntity;

const concept = (id: number, name: string): ConceptRef => ({ id, name });

describe('extractConceptRefs', () => {
  it('returns an empty list when the block has no refs, or refs that are not a list', () => {
    expect(extractConceptRefs({})).toEqual([]);
    expect(extractConceptRefs({ refs: undefined })).toEqual([]);
    // an object is not iterable, so without the guard this throws
    expect(extractConceptRefs({ refs: { 0: { id: 1, name: 'alice' } } })).toEqual([]);
  });

  it('skips a ref that is null or not an object, and keeps the ones around it', () => {
    const out = extractConceptRefs({ refs: [null, 'alice', 7, { id: 1, name: 'alice' }] });

    expect(out).toEqual([{ id: 1, name: 'alice' }]);
  });

  it('drops a ref with no numeric id', () => {
    const out = extractConceptRefs({
      refs: [{ name: 'no id' }, { id: '2', name: 'text id' }, { id: 3, name: 'kept' }]
    });

    expect(out).toEqual([{ id: 3, name: 'kept' }]);
  });

  it('drops a ref whose name is missing, empty or not text (a block ref)', () => {
    const out = extractConceptRefs({
      refs: [
        { id: 1 },
        { id: 2, name: '', 'original-name': 'Empty Name' },
        { id: 3, name: 42, 'original-name': 'Numeric Name' },
        { id: 4, name: 'kept' }
      ]
    });

    expect(out).toEqual([{ id: 4, name: 'kept' }]);
  });

  it('reads the id from db/id when id is absent', () => {
    expect(extractConceptRefs({ refs: [{ 'db/id': 5, name: 'alice' }] })).toEqual([
      { id: 5, name: 'alice' }
    ]);
  });

  it('drops a journal page marked only by journal?', () => {
    const out = extractConceptRefs({
      refs: [
        { id: 1, name: 'day one', 'journal?': true },
        { id: 2, name: 'kept', 'journal?': false }
      ]
    });

    expect(out).toEqual([{ id: 2, name: 'kept' }]);
  });

  it('drops a journal page marked only by journal-day', () => {
    const out = extractConceptRefs({
      refs: [{ id: 1, name: 'day one', 'journal-day': 20250101 }, { id: 2, name: 'kept' }]
    });

    expect(out).toEqual([{ id: 2, name: 'kept' }]);
  });

  it('drops every built-in concept and keeps a page that merely contains one', () => {
    const refs = [...BUILT_IN_CONCEPTS].map((name, i) => ({ id: i + 1, name }));
    refs.push({ id: 100, name: 'todo list' });

    expect(extractConceptRefs({ refs })).toEqual([{ id: 100, name: 'todo list' }]);
  });

  it('names a page by its original-case name, else its lowercase name', () => {
    const out = extractConceptRefs({
      refs: [
        { id: 1, name: 'alice', 'original-name': 'Alice' },
        { id: 2, name: 'bob' },
        { id: 3, name: 'carol', 'original-name': '' },
        { id: 4, name: 'dave', 'original-name': 7 }
      ]
    });

    expect(out).toEqual([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'bob' },
      { id: 3, name: 'carol' },
      { id: 4, name: 'dave' }
    ]);
  });

  it('lists a page once, however often it appears, keeping the first spelling', () => {
    const out = extractConceptRefs({
      refs: [
        { id: 1, name: 'alice', 'original-name': 'Alice' },
        { id: 2, name: 'bob' },
        { id: 1, name: 'alice', 'original-name': 'ALICE' }
      ]
    });

    expect(out).toEqual([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'bob' }
    ]);
  });
});

describe('rollUpTopConcepts', () => {
  it('counts blocks and distinct days, with nested children included', () => {
    const refs = new Map<number, ConceptRef[]>([
      [10, [concept(1, 'Alice')]],
      [11, [concept(1, 'Alice')]],
      [12, [concept(1, 'Alice'), concept(2, 'Bob')]],
      [20, [concept(1, 'Alice')]]
    ]);
    const entries = [
      { date: 20250101, blocks: [blk(10, [blk(11), blk(12)])] },
      { date: 20250102, blocks: [blk(20)] }
    ];

    expect(rollUpTopConcepts(entries, refs, 10)).toEqual([
      { name: 'Alice', count: 4, days: 2 },
      { name: 'Bob', count: 1, days: 1 }
    ]);
  });

  it('visits a block that has no children field, and a block with no refs', () => {
    const refs = new Map<number, ConceptRef[]>([[2, [concept(1, 'Alice')]]]);
    const entries = [{ date: 20250101, blocks: [blk(1), blk(2)] }];

    expect(rollUpTopConcepts(entries, refs, 10)).toEqual([{ name: 'Alice', count: 1, days: 1 }]);
  });

  it('counts a page once per block that references it', () => {
    const refs = new Map<number, ConceptRef[]>([
      [1, [concept(1, 'Alice')]],
      [2, [concept(1, 'Alice')]]
    ]);
    const entries = [{ date: 20250101, blocks: [blk(1), blk(2)] }];

    expect(rollUpTopConcepts(entries, refs, 10)).toEqual([{ name: 'Alice', count: 2, days: 1 }]);
  });

  it('merges pages on id and reports the name of the first block that referenced it', () => {
    const refs = new Map<number, ConceptRef[]>([
      [1, [concept(7, 'Alice')]],
      [2, [concept(7, 'alice')]]
    ]);
    const entries = [{ date: 20250101, blocks: [blk(1), blk(2)] }];

    expect(rollUpTopConcepts(entries, refs, 10)).toEqual([{ name: 'Alice', count: 2, days: 1 }]);
  });

  it('ranks by count, highest first, whatever order the pages were first seen in', () => {
    // first seen: Bob, Carol, Alice. Counts: Carol 3, Bob 2, Alice 1
    const refs = new Map<number, ConceptRef[]>([
      [1, [concept(2, 'Bob'), concept(3, 'Carol')]],
      [2, [concept(3, 'Carol')]],
      [3, [concept(3, 'Carol')]],
      [4, [concept(2, 'Bob')]],
      [5, [concept(1, 'Alice')]]
    ]);
    const entries = [{ date: 20250101, blocks: [1, 2, 3, 4, 5].map(id => blk(id)) }];

    expect(rollUpTopConcepts(entries, refs, 10).map(c => [c.name, c.count])).toEqual([
      ['Carol', 3],
      ['Bob', 2],
      ['Alice', 1]
    ]);
  });

  it('breaks a tie on count by days, highest first', () => {
    // both have 2 blocks; Alice is first seen and sorts first by name, but sits on one day, Bob on two
    const refs = new Map<number, ConceptRef[]>([
      [1, [concept(1, 'Alice')]],
      [2, [concept(1, 'Alice')]],
      [3, [concept(2, 'Bob')]],
      [4, [concept(2, 'Bob')]]
    ]);
    const entries = [
      { date: 20250101, blocks: [blk(1), blk(2), blk(3)] },
      { date: 20250102, blocks: [blk(4)] }
    ];

    expect(rollUpTopConcepts(entries, refs, 10)).toEqual([
      { name: 'Bob', count: 2, days: 2 },
      { name: 'Alice', count: 2, days: 1 }
    ]);
  });

  it('breaks a tie on count and days by name, ignoring case', () => {
    // first seen: Bob, carol, alice, so neither that order nor its reverse (alice, carol, Bob) is the answer
    const refs = new Map<number, ConceptRef[]>([
      [1, [concept(1, 'Bob')]],
      [2, [concept(2, 'carol')]],
      [3, [concept(3, 'alice')]]
    ]);
    const entries = [{ date: 20250101, blocks: [blk(1), blk(2), blk(3)] }];

    expect(rollUpTopConcepts(entries, refs, 10).map(c => c.name)).toEqual(['alice', 'Bob', 'carol']);
  });

  it('puts a capital first when two names differ only by case, in either first-seen order', () => {
    const refs = new Map<number, ConceptRef[]>([
      [1, [concept(1, 'Alice')]],
      [2, [concept(2, 'alice')]]
    ]);
    const upperFirst = [{ date: 20250101, blocks: [blk(1), blk(2)] }];
    const lowerFirst = [{ date: 20250101, blocks: [blk(2), blk(1)] }];

    expect(rollUpTopConcepts(upperFirst, refs, 10).map(c => c.name)).toEqual(['Alice', 'alice']);
    expect(rollUpTopConcepts(lowerFirst, refs, 10).map(c => c.name)).toEqual(['Alice', 'alice']);
  });

  it('keeps the best `limit` and drops the rest', () => {
    const refs = new Map<number, ConceptRef[]>([
      [1, [concept(1, 'Alice')]],
      [2, [concept(2, 'Bob'), concept(1, 'Alice')]],
      [3, [concept(3, 'Carol'), concept(1, 'Alice'), concept(2, 'Bob')]]
    ]);
    const entries = [{ date: 20250101, blocks: [blk(1), blk(2), blk(3)] }];

    expect(rollUpTopConcepts(entries, refs, 2).map(c => c.name)).toEqual(['Alice', 'Bob']);
    expect(rollUpTopConcepts(entries, refs, 1).map(c => c.name)).toEqual(['Alice']);
  });

  it('keeps none for a limit of zero or less, even with refs to rank', () => {
    const refs = new Map<number, ConceptRef[]>([
      [1, [concept(1, 'Alice'), concept(2, 'Bob'), concept(3, 'Carol')]]
    ]);
    const entries = [{ date: 20250101, blocks: [blk(1)] }];

    expect(rollUpTopConcepts(entries, refs, 0)).toEqual([]);
    expect(rollUpTopConcepts(entries, refs, -1)).toEqual([]);
  });

  it('returns an empty list when nothing is referenced', () => {
    expect(rollUpTopConcepts([{ date: 20250101, blocks: [blk(1)] }], new Map(), 10)).toEqual([]);
    expect(rollUpTopConcepts([], new Map(), 10)).toEqual([]);
  });
});
