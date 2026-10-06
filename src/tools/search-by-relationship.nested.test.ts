import { describe, it, expect, vi } from 'vitest';
import { MAX_RELATIONSHIP_LIMIT, searchByRelationship } from './search-by-relationship.js';
import { LogseqClient } from '../client.js';
import { BlockEntity } from '../types.js';

/**
 * `connected-within` counts the blocks of the two pages' trees, nested ones included, in
 * document order (topic A's page first, then B's) and cuts subtrees at `limit` (#183). A kept
 * block that lost children has `childrenTruncated: true`. The other relationship types are
 * unchanged. All data is made up: "Alice" (9) and "Bob" (10), no aliases, no real graph.
 */

const file = { id: 900 };
const alice = { id: 9, name: 'alice', 'original-name': 'Alice', file };
const bob = { id: 10, name: 'bob', 'original-name': 'Bob', file };
const PAGES: Record<string, any> = { alice, bob };

/** A block labelled `content`, with the children given. Ids are made unique by the label. */
let nextId = 1;
const block = (content: string, children?: BlockEntity[]): BlockEntity =>
  ({ id: nextId++, uuid: `u-${content}`, content, ...(children ? { children } : {}) }) as unknown as BlockEntity;

/** `n` leaf blocks labelled `${prefix}1..n` */
const leaves = (prefix: string, n: number): BlockEntity[] =>
  Array.from({ length: n }, (_, i) => block(`${prefix}${i + 1}`));

/** Every label in document order: a block, its children, then its next sibling. */
const labels = (blocks: BlockEntity[]): string[] =>
  blocks.flatMap(b => [b.content, ...labels(b.children ?? [])]);

/** Labels of the blocks that carry `childrenTruncated` */
const marked = (blocks: BlockEntity[]): string[] =>
  blocks.flatMap(b => [...(b.childrenTruncated ? [b.content] : []), ...marked(b.children ?? [])]);

/**
 * A client whose resolver answers Alice and Bob, whose one hop finds Bob, and whose page
 * trees are the ones given. Returns the trees as given, so a test can compare to them.
 */
function fakeClient(treeA: BlockEntity[], treeB: BlockEntity[]) {
  const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
    if (query.includes(':in $ ?n')) return [[PAGES[inputs[0] as string], 'name']];
    if (query.includes('?p ...')) return [[10]];
    return [];
  });
  const callAPI = vi.fn(async (method: string, args: unknown[]) => {
    if (method !== 'logseq.Editor.getPageBlocksTree') return [];
    return String(args[0]).toLowerCase() === 'bob' ? treeB : treeA;
  });
  return { client: { executeDatalogQuery, callAPI } as unknown as LogseqClient, executeDatalogQuery, callAPI };
}

const connected = (treeA: BlockEntity[], treeB: BlockEntity[], limit?: number) => {
  const fake = fakeClient(treeA, treeB);
  return searchByRelationship(
    fake.client,
    'Alice',
    'Bob',
    'connected-within',
    2,
    limit === undefined ? {} : { limit }
  ).then(result => ({ result, ...fake }));
};

const capWarning = (result: { warnings: Array<{ code: string; message: string; howToFetchAll?: string }> }) =>
  result.warnings.find(w => w.code === 'results_truncated');

/** Alice: a (a1 (a1x, a1y), a2), b. Bob: c (c1). Eight blocks in all. */
const eightBlocks = () => ({
  a: [block('a', [block('a1', [block('a1x'), block('a1y')]), block('a2')]), block('b')],
  b: [block('c', [block('c1')])]
});

describe('connected-within counts nested blocks', () => {
  it('counts every block of both trees against limit, and reports the count in totals', async () => {
    const { a, b } = eightBlocks();

    const { result } = await connected(a, b, 5);

    // 2 top-level blocks of A and 1 of B, but 8 blocks in all (nested ones count)
    expect(result.totals).toEqual({ blocks: 8 });
    expect(labels(result.results)).toHaveLength(5);
    expect(result.hasMore).toBe(true);
    expect(capWarning(result)?.howToFetchAll).toBe('Set limit to 8 (or higher) to get all 8.');
  });

  it('keeps the first blocks in document order, topic A first', async () => {
    const { a, b } = eightBlocks();

    const { result } = await connected(a, b, 5);

    expect(labels(result.results)).toEqual(['a', 'a1', 'a1x', 'a1y', 'a2']);
  });

  it('continues into topic B when A fits, and cuts there', async () => {
    const { result } = await connected(
      [block('a', [block('a1')]), block('b')],
      [block('c', [block('c1'), block('c2')]), block('d')],
      5
    );

    expect(labels(result.results)).toEqual(['a', 'a1', 'b', 'c', 'c1']);
    expect(marked(result.results)).toEqual(['c']);
    expect(result.totals).toEqual({ blocks: 7 });
  });

  it('marks a kept block that lost children with childrenTruncated: true, and no other', async () => {
    const { a, b } = eightBlocks();

    const { result } = await connected(a, b, 3);

    // a keeps a1, which keeps a1x but not a1y; a's second child a2 is gone too
    expect(labels(result.results)).toEqual(['a', 'a1', 'a1x']);
    expect(marked(result.results)).toEqual(['a', 'a1']);
    expect(result.results[0].childrenTruncated).toBe(true);
    expect(result.results[0].children![0].childrenTruncated).toBe(true);
    expect(result.results[0].children![0].children![0].childrenTruncated).toBeUndefined();
  });

  it('marks a block that kept none of its children, with an empty children array', async () => {
    const { result } = await connected([block('a', [block('a1'), block('a2')]), block('b')], [], 1);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ content: 'a', children: [], childrenTruncated: true });
  });

  it('leaves a block unmarked when all its children fit, and a leaf unmarked', async () => {
    const { a, b } = eightBlocks();

    // 4 blocks: a, a1, a1x, a1y. a1's children all fit; a lost a2
    const { result } = await connected(a, b, 4);

    expect(marked(result.results)).toEqual(['a']);
    expect(result.results[0].children![0].childrenTruncated).toBeUndefined();
    const leaf = result.results[0].children![0].children![1];
    expect(leaf).not.toHaveProperty('childrenTruncated');
    expect(leaf).not.toHaveProperty('children');
  });

  it('does not mark a block cut after its whole subtree, only the block that lost children', async () => {
    // a (a1) takes 2; the cut falls between the top-level blocks a and b
    const { result } = await connected([block('a', [block('a1')]), block('b')], [], 2);

    expect(labels(result.results)).toEqual(['a', 'a1']);
    expect(marked(result.results)).toEqual([]);
    expect(JSON.stringify(result.results)).not.toContain('childrenTruncated');
  });

  it('bounds a single deep tree: one top-level block with many children is cut at the limit', async () => {
    const tree = [block('root', leaves('child', 300))];

    const { result } = await connected(tree, [], 50);

    expect(labels(result.results)).toHaveLength(50);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].children).toHaveLength(49);
    expect(result.results[0].childrenTruncated).toBe(true);
    expect(result.totals).toEqual({ blocks: 301 });
  });

  it('keeps its topic A and B counts in nested units, and says a kept block lost children', async () => {
    const { a, b } = eightBlocks();

    const { result } = await connected(a, b, 3);

    expect(capWarning(result)?.message).toBe(
      "Showing 3 of 8 blocks of the two pages, nested ones counted (kept 3 from topic A and 0 from topic B, of 6 and 2; topic A's first, then topic B's; a kept block shows fewer children than it has (childrenTruncated))."
    );
  });

  it('leaves out the lost-children note when the cut fell between top-level blocks', async () => {
    const { result } = await connected([block('a', [block('a1')]), block('b')], [block('c')], 2);

    expect(capWarning(result)?.message).toBe(
      "Showing 2 of 4 blocks of the two pages, nested ones counted (kept 2 from topic A and 0 from topic B, of 3 and 1; topic A's first, then topic B's)."
    );
  });

  it('counts how many kept blocks came from each topic, when the cut falls inside topic B', async () => {
    const { result } = await connected(
      [block('a', [block('a1')])],
      [block('c', [block('c1'), block('c2'), block('c3')])],
      4
    );

    expect(capWarning(result)?.message).toContain('kept 2 from topic A and 2 from topic B, of 2 and 4');
    expect(labels(result.results)).toEqual(['a', 'a1', 'c', 'c1']);
  });

  it('drops topic B entirely when A fills the limit, and says so', async () => {
    const { result } = await connected([block('a', leaves('a', 4))], [block('c')], 5);

    expect(labels(result.results)).toEqual(['a', 'a1', 'a2', 'a3', 'a4']);
    expect(capWarning(result)?.message).toContain('kept 5 from topic A and 0 from topic B, of 5 and 1');
  });

  it('returns nothing, and says so, for a limit of 0', async () => {
    const { a, b } = eightBlocks();

    const { result } = await connected(a, b, 0);

    expect(result.results).toEqual([]);
    expect(result.totals).toEqual({ blocks: 8 });
    expect(capWarning(result)?.message).toMatch(/^Showing 0 of 8 /);
  });

  it('at the maximum, says the rest cannot be fetched and offers no howToFetchAll', async () => {
    // 3 top-level blocks with 200 children each: 603 blocks, a bit over the maximum
    const tree = [1, 2, 3].map(n => block(`r${n}`, leaves(`r${n}c`, 200)));

    const { result } = await connected(tree, [], 5000);

    expect(labels(result.results)).toHaveLength(MAX_RELATIONSHIP_LIMIT);
    expect(result.totals).toEqual({ blocks: 603 });
    expect(result.hasMore).toBe(false);
    const warning = capWarning(result)!;
    expect(warning.message).toContain('limit is capped at its maximum of 500 (5000 was asked for)');
    expect(warning).not.toHaveProperty('howToFetchAll');
    // Two whole subtrees are 402 blocks, r3 itself is the 403rd: it keeps 97 of its 200 children
    expect(marked(result.results)).toEqual(['r3']);
    expect(result.results[2].children).toHaveLength(97);
  });

  it('does not touch the input trees', async () => {
    const { a, b } = eightBlocks();
    const before = JSON.stringify([a, b]);

    await connected(a, b, 3);

    expect(JSON.stringify([a, b])).toBe(before);
  });

  it('makes the same API calls whether it cuts or not', async () => {
    const whole = await connected(eightBlocks().a, eightBlocks().b, 500);
    const cut = await connected(eightBlocks().a, eightBlocks().b, 2);

    expect(cut.executeDatalogQuery).toHaveBeenCalledTimes(whole.executeDatalogQuery.mock.calls.length);
    expect(cut.callAPI).toHaveBeenCalledTimes(whole.callAPI.mock.calls.length);
  });
});

describe('connected-within below the cap is unchanged', () => {
  it('returns the two trees as they came, byte for byte, with no marker and no totals', async () => {
    const { a, b } = eightBlocks();
    const expected = JSON.stringify([...a, ...b]);

    // 8 blocks: under the default, and exactly at an explicit limit of 8
    for (const limit of [undefined, 8, 500, 5000]) {
      const { result } = await connected(a, b, limit);

      expect(JSON.stringify(result.results), `limit ${String(limit)}`).toBe(expected);
      expect(result.warnings).toEqual([]);
      expect(result.totals).toBeUndefined();
      expect(result.hasMore).toBe(false);
    }
  });

  it('counts nested blocks against the default of 50, not just top-level ones', async () => {
    // 2 top-level blocks, 52 blocks in all: over the default of 50 only when nested ones count
    const tree = [block('a', leaves('a', 30)), block('b', leaves('b', 20))];

    const { result } = await connected(tree, []);

    expect(labels(result.results)).toHaveLength(50);
    expect(result.totals).toEqual({ blocks: 52 });
    expect(marked(result.results)).toEqual(['b']);
  });

  it('is not connected: no trees are fetched and nothing is capped', async () => {
    const fake = fakeClient(eightBlocks().a, eightBlocks().b);
    fake.executeDatalogQuery.mockImplementation(async (query: string, ...inputs: unknown[]) => {
      if (query.includes(':in $ ?n')) return [[PAGES[inputs[0] as string], 'name']];
      return [];
    });

    const result = await searchByRelationship(fake.client, 'Alice', 'Bob', 'connected-within', 2, { limit: 1 });

    expect(result.results).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(fake.callAPI).not.toHaveBeenCalled();
  });
});

describe('the other relationship types are unchanged', () => {
  /** The data query returns `rows` blocks, some with children; every other query is the resolver */
  const datalog = (type: 'references' | 'referenced-by' | 'in-pages-linking-to', rows: BlockEntity[], limit: number) => {
    const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
      if (query.includes(':in $ ?n')) return [[PAGES[inputs[0] as string], 'name']];
      return rows.map(row => [row]);
    });
    const client = { executeDatalogQuery, callAPI: vi.fn(async () => []) } as unknown as LogseqClient;
    return searchByRelationship(client, 'Alice', 'Bob', type, 2, { limit });
  };

  it.each(['references', 'referenced-by', 'in-pages-linking-to'] as const)(
    '%s counts one per matching block, children or not, and marks nothing',
    async type => {
      const rows = [block('m1', leaves('m1c', 5)), block('m2'), block('m3', leaves('m3c', 5))];

      const { results, totals, warnings } = await datalog(type, rows, 2);

      expect(results.map(r => r.content)).toEqual(['m1', 'm2']);
      // Whole blocks, children and all: this type never cuts a subtree
      expect(results[0].children).toHaveLength(5);
      expect(JSON.stringify(results)).not.toContain('childrenTruncated');
      expect(totals).toEqual({ blocks: 3 });
      expect(warnings[0].message).toBe(
        'Showing 2 of 3 matching blocks (the first ones listed, not ranked).'
      );
    }
  );
});
