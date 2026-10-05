import { describe, it, expect, vi } from 'vitest';
import { getConceptNetwork } from './get-concept-network.js';
import { LogseqClient } from '../client.js';
import { PageNotFoundError } from '../errors.js';

type Rel = 'outbound' | 'inbound';

/** A row of DatalogQueryBuilder.connectedPages: source, connected, rel, count. */
function row(
  source: number,
  connected: number,
  rel: Rel,
  count: number = 1,
  opts: { name?: string; journal?: boolean } = {}
) {
  const name = opts.name ?? `page ${connected}`;
  return [source, connected, name.toLowerCase(), name, opts.journal ?? false, rel, count];
}

/**
 * Mock client: the root lookup (the only query with an :in input) returns
 * `root`; every batched query returns the next entry of `levels`.
 */
function mockClient(root: unknown[] | null, levels: unknown[][][] = []) {
  const queue = [...levels];
  const executeDatalogQuery = vi.fn(async (query: string) => {
    if (query.includes(':in $ ?n')) {
      return root ? [[root, 'name']] : [];
    }
    return queue.shift() ?? [];
  });
  const callAPI = vi.fn();
  return {
    client: { config: {}, executeDatalogQuery, callAPI } as unknown as LogseqClient,
    executeDatalogQuery,
    callAPI
  };
}

const rootPage = { id: 1, name: 'root page', 'original-name': 'Root Page' };

describe('getConceptNetwork', () => {
  describe('depth', () => {
    it('depth 0 returns only the root and makes a single call', async () => {
      const { client, executeDatalogQuery } = mockClient(rootPage);

      const result = await getConceptNetwork(client, 'Root Page', 0);

      expect(result.concept).toBe('Root Page');
      expect(result.nodes).toEqual([{ id: 1, name: 'Root Page', depth: 0 }]);
      expect(result.edges).toEqual([]);
      expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    });

    it('depth 1 expands only the root, in one batched call', async () => {
      const { client, executeDatalogQuery } = mockClient(rootPage, [
        [row(1, 2, 'outbound'), row(1, 3, 'inbound')]
      ]);

      const result = await getConceptNetwork(client, 'Root Page', 1);

      expect(result.nodes.map(n => [n.id, n.depth])).toEqual([[1, 0], [2, 1], [3, 1]]);
      expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
      expect(executeDatalogQuery.mock.calls[1][0]).toContain('[(ground [1]) [?source ...]]');
    });

    it('depth 2 expands the whole depth-1 frontier in one call', async () => {
      const { client, executeDatalogQuery } = mockClient(rootPage, [
        [row(1, 2, 'outbound'), row(1, 3, 'inbound')],
        [row(2, 4, 'outbound'), row(3, 5, 'inbound')]
      ]);

      const result = await getConceptNetwork(client, 'Root Page', 2);

      expect(result.nodes.map(n => [n.id, n.depth])).toEqual([[1, 0], [2, 1], [3, 1], [4, 2], [5, 2]]);
      expect(executeDatalogQuery).toHaveBeenCalledTimes(3);
      expect(executeDatalogQuery.mock.calls[2][0]).toContain('[(ground [2 3]) [?source ...]]');
    });

    it('never touches the Editor API', async () => {
      const { client, callAPI } = mockClient(rootPage, [[row(1, 2, 'outbound')], [row(2, 3, 'outbound')]]);

      await getConceptNetwork(client, 'Root Page', 2);

      expect(callAPI).not.toHaveBeenCalled();
    });

    it('makes at most maxDepth + 1 calls however wide the graph is', async () => {
      const wide = Array.from({ length: 40 }, (_, i) => row(1, 100 + i, 'inbound'));
      const wide2 = Array.from({ length: 40 }, (_, i) => row(100 + i, 200 + i, 'outbound'));
      const wide3 = Array.from({ length: 40 }, (_, i) => row(200 + i, 300 + i, 'outbound'));

      for (const maxDepth of [0, 1, 2, 3]) {
        const { client, executeDatalogQuery } = mockClient(rootPage, [wide, wide2, wide3]);
        await getConceptNetwork(client, 'Root Page', maxDepth);
        expect(executeDatalogQuery.mock.calls.length).toBeLessThanOrEqual(maxDepth + 1);
      }
    });

    it('stops early when a level finds nothing new', async () => {
      const { client, executeDatalogQuery } = mockClient(rootPage, [[]]);

      const result = await getConceptNetwork(client, 'Root Page', 3);

      expect(result.nodes).toHaveLength(1);
      expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe('edges', () => {
    it('keeps outbound and inbound links as separate counts on one edge per pair', async () => {
      const { client } = mockClient(rootPage, [
        [row(1, 2, 'outbound', 3), row(1, 2, 'inbound', 2), row(1, 3, 'inbound', 4)]
      ]);

      const result = await getConceptNetwork(client, 'Root Page', 1);

      expect(result.edges).toEqual([
        { from: 1, to: 2, type: 'reference', count: 5, outbound: 3, inbound: 2 },
        { from: 1, to: 3, type: 'backlink', count: 4, outbound: 0, inbound: 4 }
      ]);
    });

    it('emits one edge when two frontier pages report the same links from both sides', async () => {
      const { client } = mockClient(rootPage, [
        [row(1, 2, 'outbound'), row(1, 3, 'outbound')],
        // 2 -> 3 (2 blocks) is reported once from each side
        [row(2, 3, 'outbound', 2), row(3, 2, 'inbound', 2)]
      ]);

      const result = await getConceptNetwork(client, 'Root Page', 2);

      const edge = result.edges.find(e => e.from === 2 && e.to === 3);
      expect(edge).toEqual({ from: 2, to: 3, type: 'reference', count: 2, outbound: 2, inbound: 0 });
      expect(result.edges.filter(e => new Set([e.from, e.to]).has(2) && new Set([e.from, e.to]).has(3))).toHaveLength(1);
    });

    it('does not duplicate an edge already found at the previous depth', async () => {
      const { client } = mockClient(rootPage, [
        [row(1, 2, 'outbound', 2)],
        // From page 2's side, the same root link shows up again
        [row(2, 1, 'inbound', 2), row(2, 3, 'outbound')]
      ]);

      const result = await getConceptNetwork(client, 'Root Page', 2);

      expect(result.edges).toEqual([
        { from: 1, to: 2, type: 'reference', count: 2, outbound: 2, inbound: 0 },
        { from: 2, to: 3, type: 'reference', count: 1, outbound: 1, inbound: 0 }
      ]);
    });

    it('orients from -> to by depth, whatever the link direction', async () => {
      const { client } = mockClient(rootPage, [[row(1, 2, 'inbound')], [row(2, 3, 'inbound')]]);

      const result = await getConceptNetwork(client, 'Root Page', 2);

      // Pages 2 and 3 link TO their parents, but `from` is still the nearer page
      expect(result.edges).toEqual([
        { from: 1, to: 2, type: 'backlink', count: 1, outbound: 0, inbound: 1 },
        { from: 2, to: 3, type: 'backlink', count: 1, outbound: 0, inbound: 1 }
      ]);
    });

    it('never emits self-loops, even if one slips through', async () => {
      const { client } = mockClient(rootPage, [
        [row(1, 1, 'outbound', 5), row(1, 2, 'outbound')]
      ]);

      const result = await getConceptNetwork(client, 'Root Page', 1);

      expect(result.nodes.map(n => n.id)).toEqual([1, 2]);
      expect(result.edges.every(e => e.from !== e.to)).toBe(true);
      expect(result.edges).toHaveLength(1);
    });

    it('never emits duplicate nodes', async () => {
      const { client } = mockClient(rootPage, [
        [row(1, 2, 'outbound'), row(1, 2, 'inbound'), row(1, 3, 'outbound')],
        [row(2, 3, 'outbound'), row(3, 2, 'inbound'), row(2, 1, 'inbound'), row(3, 1, 'inbound')]
      ]);

      const result = await getConceptNetwork(client, 'Root Page', 2);

      const ids = result.nodes.map(n => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('lookup', () => {
    it('should throw error when page not found', async () => {
      const { client } = mockClient(null);

      await expect(getConceptNetwork(client, 'NonExistent', 2)).rejects.toThrow(PageNotFoundError);
    });

    it('should handle page with no connections', async () => {
      const { client } = mockClient({ id: 1, name: 'isolated page' }, [[]]);

      const result = await getConceptNetwork(client, 'Isolated Page', 2);

      expect(result.nodes).toHaveLength(1);
      expect(result.edges).toHaveLength(0);
    });

    it('should handle case-insensitive page names', async () => {
      const { client, executeDatalogQuery } = mockClient({ id: 1, name: 'alice' }, [[]]);

      const result = await getConceptNetwork(client, 'Alice', 1);

      expect(result.concept).toBe('Alice');
      expect(result.nodes[0].name).toBe('alice');
      // The lowercased name is an :in input, not embedded in the query
      expect(executeDatalogQuery).toHaveBeenCalledWith(
        expect.stringContaining(':in $ ?n'),
        'alice'
      );
    });

    it('prefers the original-cased name for connected pages', async () => {
      const { client } = mockClient(rootPage, [[row(1, 2, 'outbound', 1, { name: 'Project Atlas' })]]);

      const result = await getConceptNetwork(client, 'Root Page', 1);

      expect(result.nodes[1].name).toBe('Project Atlas');
    });
  });

  describe('caps', () => {
    /** Root links out to pages 100..100+n-1, in descending id order to defeat row-order luck. */
    const fan = (n: number, count: (i: number) => number = () => 1) =>
      Array.from({ length: n }, (_, k) => n - 1 - k).map(i => row(1, 100 + i, 'inbound', count(i)));

    it('is not truncated when nothing is dropped', async () => {
      const { client } = mockClient(rootPage, [fan(3)]);

      const result = await getConceptNetwork(client, 'Root Page', 1);

      expect(result.truncated).toBe(false);
      expect(result.nodes).toHaveLength(4);
    });

    it('has no warning and hasMore false when nothing is dropped', async () => {
      const { client } = mockClient(rootPage, [fan(3)]);

      const result = await getConceptNetwork(client, 'Root Page', 1);

      expect(result.hasMore).toBe(false);
      expect(result.warnings).toEqual([]);
    });

    it('adds a network_truncated warning alongside truncated, with a suggested max_nodes', async () => {
      const { client } = mockClient(rootPage, [fan(10)]);

      const result = await getConceptNetwork(client, 'Root Page', 1, { maxNodes: 4, maxFanout: Infinity });

      expect(result.truncated).toBe(true);
      expect(result.hasMore).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].code).toBe('network_truncated');
      expect(result.warnings[0].message).toBe('Kept 4 pages; at least 7 more connected pages were dropped.');
      expect(result.warnings[0].howToFetchAll).toContain('max_nodes to 11');
    });

    it('defaults to maxNodes 50 and flags truncation', async () => {
      const { client } = mockClient(rootPage, [fan(80)]);

      const result = await getConceptNetwork(client, 'Root Page', 1, { maxFanout: Infinity });

      expect(result.nodes).toHaveLength(50);
      expect(result.truncated).toBe(true);
    });

    it('stops at exactly maxNodes across depths', async () => {
      const { client } = mockClient(rootPage, [
        fan(3),
        [row(100, 200, 'outbound'), row(101, 201, 'outbound'), row(102, 202, 'outbound')]
      ]);

      const result = await getConceptNetwork(client, 'Root Page', 2, { maxNodes: 6 });

      expect(result.nodes).toHaveLength(6);
      expect(result.truncated).toBe(true);
      // Every edge still points at kept nodes
      const ids = new Set(result.nodes.map(n => n.id));
      expect(result.edges.every(e => ids.has(e.from) && ids.has(e.to))).toBe(true);
    });

    it('treats maxNodes as including the root', async () => {
      const { client } = mockClient(rootPage, [fan(5)]);

      const result = await getConceptNetwork(client, 'Root Page', 1, { maxNodes: 1 });

      expect(result.nodes).toHaveLength(1);
      expect(result.edges).toEqual([]);
      expect(result.truncated).toBe(true);
    });

    it('caps how many new pages one page may add (default 15)', async () => {
      const { client } = mockClient(rootPage, [fan(40)]);

      const result = await getConceptNetwork(client, 'Root Page', 1);

      expect(result.nodes).toHaveLength(16);
      expect(result.truncated).toBe(true);
    });

    it('applies the fanout cap per page, not globally', async () => {
      const { client } = mockClient(rootPage, [
        [row(1, 2, 'outbound'), row(1, 3, 'outbound')],
        [
          row(2, 10, 'outbound'), row(2, 11, 'outbound'), row(2, 12, 'outbound'),
          row(3, 20, 'outbound'), row(3, 21, 'outbound'), row(3, 22, 'outbound')
        ]
      ]);

      const result = await getConceptNetwork(client, 'Root Page', 2, { maxFanout: 2 });

      // Each depth-1 page keeps 2 of its 3 new neighbours: 1 + 2 + 4 nodes
      expect(result.nodes).toHaveLength(7);
      expect(result.truncated).toBe(true);
    });

    it('does not count links to already-known pages against the fanout cap', async () => {
      const { client } = mockClient(rootPage, [
        [row(1, 2, 'outbound'), row(1, 3, 'outbound')],
        [row(2, 3, 'outbound'), row(2, 1, 'inbound'), row(2, 4, 'outbound'), row(2, 5, 'outbound')]
      ]);

      const result = await getConceptNetwork(client, 'Root Page', 2, { maxFanout: 2 });

      // Page 2 has four neighbours but only two are new
      expect(result.nodes.map(n => n.id)).toEqual([1, 2, 3, 4, 5]);
      expect(result.truncated).toBe(false);
    });

    it('keeps the highest-count pages when a cap bites, then lowest id', async () => {
      const counts = [1, 5, 5, 2, 9, 1];
      const { client } = mockClient(rootPage, [fan(6, i => counts[i])]);

      const result = await getConceptNetwork(client, 'Root Page', 1, { maxFanout: 4 });

      // 104 (9), 101 (5), 102 (5), then 103 (2)
      expect(result.nodes.slice(1).map(n => n.id)).toEqual([104, 101, 102, 103]);
    });

    it('picks the same survivors whatever order the rows arrive in', async () => {
      const rows = fan(30, i => (i % 4) + 1);
      const reversed = [...rows].reverse();
      const shuffled = [...rows].sort((a, b) => ((a[1] as number) * 7) % 11 - ((b[1] as number) * 7) % 11);

      const run = async (input: unknown[][]) => {
        const { client } = mockClient(rootPage, [input]);
        return getConceptNetwork(client, 'Root Page', 1, { maxNodes: 10 });
      };
      const [a, b, c] = [await run(rows), await run(reversed), await run(shuffled)];

      expect(b).toEqual(a);
      expect(c).toEqual(a);
    });

    it('survivors across frontier pages are chosen by total references to the frontier', async () => {
      const { client } = mockClient(rootPage, [
        [row(1, 2, 'outbound'), row(1, 3, 'outbound')],
        [
          row(2, 10, 'outbound', 1), row(3, 10, 'outbound', 1), // total 2
          row(2, 11, 'outbound', 1),                            // total 1
          row(3, 12, 'outbound', 3)                             // total 3
        ]
      ]);

      const result = await getConceptNetwork(client, 'Root Page', 2, { maxNodes: 5 });

      expect(result.nodes.filter(n => n.depth === 2).map(n => n.id)).toEqual([12, 10]);
      expect(result.truncated).toBe(true);
    });
  });

  describe('journal pages', () => {
    const journalRow = (source: number, id: number) =>
      row(source, id, 'inbound', 1, { name: `journal ${id}`, journal: true });

    it('includes journal pages as leaves but does not expand them by default', async () => {
      const { client, executeDatalogQuery } = mockClient(rootPage, [
        [row(1, 2, 'outbound'), journalRow(1, 50)],
        [row(2, 3, 'outbound')]
      ]);

      const result = await getConceptNetwork(client, 'Root Page', 2);

      expect(result.nodes.map(n => n.id)).toEqual([1, 2, 50, 3]);
      expect(executeDatalogQuery.mock.calls[2][0]).toContain('[(ground [2]) [?source ...]]');
    });

    it('stops after depth 1 when only journal pages were found', async () => {
      const { client, executeDatalogQuery } = mockClient(rootPage, [[journalRow(1, 50), journalRow(1, 51)]]);

      const result = await getConceptNetwork(client, 'Root Page', 3);

      expect(result.nodes).toHaveLength(3);
      expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
    });

    it('expands journal pages when expandJournals is set', async () => {
      const { client, executeDatalogQuery } = mockClient(rootPage, [
        [row(1, 2, 'outbound'), journalRow(1, 50)],
        [row(50, 60, 'outbound')]
      ]);

      const result = await getConceptNetwork(client, 'Root Page', 2, { expandJournals: true });

      expect(executeDatalogQuery.mock.calls[2][0]).toContain('[(ground [2 50]) [?source ...]]');
      expect(result.nodes.map(n => n.id)).toEqual([1, 2, 50, 60]);
    });

    it('still expands a journal page that is the root', async () => {
      const { client } = mockClient({ id: 1, name: 'journal root', 'journal?': true }, [[row(1, 2, 'outbound')]]);

      const result = await getConceptNetwork(client, 'Journal Root', 1);

      expect(result.nodes.map(n => n.id)).toEqual([1, 2]);
    });

    it('ranks concept pages ahead of journal pages when a cap bites', async () => {
      const { client } = mockClient(rootPage, [
        [
          journalRow(1, 50), journalRow(1, 51), journalRow(1, 52),
          row(1, 2, 'outbound'), row(1, 3, 'outbound')
        ]
      ]);

      const result = await getConceptNetwork(client, 'Root Page', 1, { maxFanout: 3 });

      expect(result.nodes.slice(1).map(n => n.id)).toEqual([2, 3, 50]);
      expect(result.truncated).toBe(true);
    });
  });
});
