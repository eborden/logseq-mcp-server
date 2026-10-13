import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { exploreNetwork, exploreNetworkPath } from './helpers/tools.js';
import { PageNotFoundError } from './helpers/errors.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Integration tests for explore_network (the network, and the path to a second page) against the fixture graph.
 *
 * `Bob` has 11 neighbours, under every cap. `hub central` (tests/fixtures/README.md, "The hub")
 * has 120 non-journal neighbours and one journal, so the caps bite. Where a cap keeps a subset
 * picked by `:db/id` order (ties at the same reference count), only counts are asserted; the
 * README lists which cases are fixed by name. Read-only.
 */

const BOB_NETWORK = [
  'Alice', 'Bob', 'Jan 10th, 2025', 'Jan 15th, 2025', 'Jan 6th, 2025', 'Jan 7th, 2025', 'block refs',
  'project atlas', 'project atlas/meetings', 'project cascade', 'property types', 'role',
];

const range = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`);

describe('Graph Traversal Tools Integration Tests', () => {
  let client: LogseqClient;

  beforeAll(async () => {
    ({ client } = await connectFixture());
  });

  describe('logseq_explore_network, the network', () => {
    it('returns every neighbour of a page under the caps, one edge each', async () => {
      const result = await exploreNetwork(client, 'bob', 1);

      expect(result.page).toBe('bob');
      expect(result.nodes.map(n => n.name).sort()).toEqual(BOB_NETWORK);
      expect(result.nodes.filter(n => n.depth === 0).map(n => n.name)).toEqual(['Bob']);
      expect(result.edges).toHaveLength(11);
      const root = result.nodes.find(n => n.depth === 0)!.id;
      expect(result.edges.every(e => e.from === root || e.to === root)).toBe(true);
      expect(result.edges.every(e => ['reference', 'backlink'].includes(e.type))).toBe(true);
      expect(result).toMatchObject({ truncated: false, hasMore: false, warnings: [] });
    });

    it('should respect maxDepth parameter', async () => {
      const depth0 = await exploreNetwork(client, 'Bob', 0);
      expect(depth0.nodes.map(n => [n.name, n.depth])).toEqual([['Bob', 0]]);
      expect(depth0.edges).toHaveLength(0);

      const depth1 = await exploreNetwork(client, 'Bob', 1);
      expect(depth1.nodes.every(n => n.depth <= 1)).toBe(true);

      const depth2 = await exploreNetwork(client, 'Bob', 2);
      expect(depth2.nodes.every(n => n.depth <= 2)).toBe(true);
      expect(depth2.nodes.length).toBeGreaterThan(depth1.nodes.length);
    });

    it('returns only the root for a page with no links', async () => {
      for (const name of ['archive', 'empty page']) {
        const result = await exploreNetwork(client, name, 2);
        expect(result.nodes.map(n => n.depth), name).toEqual([0]);
        expect(result.edges, name).toEqual([]);
        expect(result.truncated, name).toBe(false);
      }
    });

    it('should throw error for non-existent page', async () => {
      await expect(
        exploreNetwork(client, 'NonExistentConceptForGraphTools12345', 2)
      ).rejects.toThrow(/^No page "/);
    });
  });

  describe('caps on the hub (#3, #89)', () => {
    it('depth 1 with the defaults keeps exactly the 15 pages with two references', async () => {
      const result = await exploreNetwork(client, 'hub central', 1);

      expect(result.nodes.map(n => n.name).sort()).toEqual(
        ['hub central', ...range('neighbour-both', 10), ...range('neighbour-in', 5)].sort()
      );
      expect(result.truncated).toBe(true);
      expect(result.hasMore).toBe(true);
      expect(result.warnings.map(w => w.code)).toEqual(['network_truncated']);
    });

    it('depth 2 with the defaults stops at max_nodes 50', async () => {
      const result = await exploreNetwork(client, 'hub central', 2);

      expect(result.nodes).toHaveLength(50);
      // 1 + 15 + 34: which 34 of the 40 fringe pages depends on id order, the split does not
      expect(result.nodes.filter(n => n.depth === 1)).toHaveLength(15);
      expect(result.nodes.filter(n => n.depth === 2)).toHaveLength(34);
      expect(result.nodes.filter(n => n.depth === 2).every(n => n.name.startsWith('fringe-'))).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.warnings.map(w => w.code)).toEqual(['network_truncated']);
    });

    it('depth 1 at the largest caps a client can ask for keeps 100 of 121 candidates', async () => {
      const result = await exploreNetwork(client, 'hub central', 1, { maxNodes: 500, maxFanout: 100 });

      expect(result.nodes).toHaveLength(101);
      expect(result.truncated).toBe(true);
      // The journal ranks last among the candidates, so the fanout cap drops it
      expect(result.nodes.some(n => n.name === 'Jun 17th, 2024')).toBe(false);
    });

    it('a journal is a leaf by default, and expand_journals walks through it', async () => {
      const leaf = await exploreNetwork(client, 'journal-topic-01', 2);
      expect(leaf.nodes.map(n => n.name).sort()).toEqual(['Jun 17th, 2024', 'journal-topic-01']);
      expect(leaf.truncated).toBe(false);

      const expanded = await exploreNetwork(client, 'journal-topic-01', 2, { expandJournals: true });
      expect(expanded.nodes).toHaveLength(17);
      expect(expanded.truncated).toBe(true);
      expect(expanded.warnings.map(w => w.code)).toEqual(['network_truncated']);

      const wide = await exploreNetwork(client, 'journal-topic-01', 2, { expandJournals: true, maxFanout: 100 });
      expect(wide.nodes).toHaveLength(32);
      expect(wide.nodes.some(n => n.name === 'hub central')).toBe(true);
      expect(wide.truncated).toBe(false);
    });
  });

  describe('logseq_explore_network with to (#494)', () => {
    it('pages that link are a path of one edge, with the reference counts of both directions', async () => {
      const result = await exploreNetworkPath(client, 'alice', 'project atlas', 2);

      expect(result).toMatchObject({ page: 'alice', to: 'project atlas', hops: 1, hasMore: false, warnings: [] });
      expect(result.nodes.map(n => [n.name, n.depth])).toEqual([['Alice', 0], ['project atlas', 1]]);
      const [alice, atlas] = result.nodes;
      // Alice's block links project atlas, and a block of project atlas links Alice
      expect(result.edges).toEqual([{ from: alice.id, to: atlas.id, type: 'reference', count: 2, outbound: 1, inbound: 1 }]);
    });

    it('a link in one direction only is an edge with the other count at zero, whatever the casing', async () => {
      const result = await exploreNetworkPath(client, 'ALICE', 'BOB', 1);

      expect(result.nodes.map(n => n.name)).toEqual(['Alice', 'Bob']);
      expect(result.edges.map(e => [e.type, e.count, e.outbound, e.inbound])).toEqual([['reference', 1, 1, 0]]);
      // asked from the other side, the edge starts at Bob and reads as a backlink
      const back = await exploreNetworkPath(client, 'Bob', 'Alice', 1);
      expect(back.nodes.map(n => n.name)).toEqual(['Bob', 'Alice']);
      expect(back.edges.map(e => [e.type, e.count, e.outbound, e.inbound])).toEqual([['backlink', 1, 0, 1]]);
    });

    it('a page asked by its alias is the page, and says so', async () => {
      const result = await exploreNetworkPath(client, 'Alice', 'atlas', 2);

      expect(result.resolvedFrom).toEqual({ to: { name: 'atlas', matchedBy: 'alias', resolvedTo: 'project atlas' } });
      expect(result.resolvedAliases).toEqual({ to: ['atlas', 'project atlas'] });
      expect(result.nodes.map(n => n.name)).toEqual(['Alice', 'project atlas']);
    });

    it('a journal that links both is a bridge of two hops, and one hop is not enough', async () => {
      const result = await exploreNetworkPath(client, 'journal-topic-01', 'hub central', 2);

      expect(result.hops).toBe(2);
      expect(result.nodes.map(n => [n.name, n.depth])).toEqual([['journal-topic-01', 0], ['Jun 17th, 2024', 1], ['hub central', 2]]);
      expect(result.edges.map(e => [e.from, e.to])).toEqual([[result.nodes[0].id, result.nodes[1].id], [result.nodes[1].id, result.nodes[2].id]]);
      expect(result.edges.map(e => e.count)).toEqual([1, 1]);

      const short = await exploreNetworkPath(client, 'journal-topic-01', 'hub central', 1);
      expect(short.nodes).toEqual([]);
      expect(short.hasMore).toBe(true);
      expect(short.warnings.map(w => w.code)).toEqual(['no_path_within']);
      expect(short.warnings[0].message).toBe('No path from "journal-topic-01" to "hub central" within 1 hop.');
      expect(short.warnings[0].howToFetchAll).toBe('Set max_depth to 2 to look one hop further (max 3).');
    });

    it('a page that nothing links to has no path, and the walk says it ran out of pages', async () => {
      for (const [page, to] of [['archive', 'Bob'], ['empty page', 'Bob']]) {
        const result = await exploreNetworkPath(client, page, to, 3);
        expect(result.nodes, page).toEqual([]);
        expect(result.edges, page).toEqual([]);
        expect(result.hasMore, page).toBe(false);
        expect(result.warnings.map(w => w.code), page).toEqual(['no_path_within']);
        expect(result.warnings[0].message, page).toBe(`No path from "${page}" to "${to}": every page linked within 1 hop was reached and none is "${to}". A larger max_depth finds nothing more.`);
      }
    });

    it('no path within the maximum depth says the depth is capped, and a larger one is capped to it', async () => {
      const result = await exploreNetworkPath(client, 'Alice', 'archive', 9);

      expect(result.hasMore).toBe(false);
      expect(result.warnings.map(w => w.code)).toEqual(['no_path_within']);
      expect(result.warnings[0].message).toBe(
        'No path from "Alice" to "archive" within 3 hops. max_depth 9 was capped at 3. max_depth is capped at 3, so no longer path can be searched.'
      );
    });

    it('a page and its alias are one page: no path, no walk', async () => {
      // the calls it takes are counted in alias-sets.test.ts
      const result = await exploreNetworkPath(client, 'project atlas', 'atlas', 2);
      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
      expect(result.warnings.map(w => w.code)).toEqual(['same_page']);
    });

    it('a page that does not exist is an error whichever side it is on', async () => {
      await expect(exploreNetworkPath(client, 'NonExistentPathPage12345', 'Bob', 2)).rejects.toBeInstanceOf(PageNotFoundError);
      await expect(exploreNetworkPath(client, 'Bob', 'NonExistentPathPage12345', 2)).rejects.toBeInstanceOf(PageNotFoundError);
    });
  });
});
