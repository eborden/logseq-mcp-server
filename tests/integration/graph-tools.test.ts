import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { getConceptNetwork } from './helpers/tools.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Integration tests for get_concept_network against the fixture graph.
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

  describe('logseq_get_concept_network', () => {
    it('returns every neighbour of a page under the caps, one edge each', async () => {
      const result = await getConceptNetwork(client, 'bob', 1);

      expect(result.concept).toBe('bob');
      expect(result.nodes.map(n => n.name).sort()).toEqual(BOB_NETWORK);
      expect(result.nodes.filter(n => n.depth === 0).map(n => n.name)).toEqual(['Bob']);
      expect(result.edges).toHaveLength(11);
      const root = result.nodes.find(n => n.depth === 0)!.id;
      expect(result.edges.every(e => e.from === root || e.to === root)).toBe(true);
      expect(result.edges.every(e => ['reference', 'backlink'].includes(e.type))).toBe(true);
      expect(result).toMatchObject({ truncated: false, hasMore: false, warnings: [] });
    });

    it('should respect maxDepth parameter', async () => {
      const depth0 = await getConceptNetwork(client, 'Bob', 0);
      expect(depth0.nodes.map(n => [n.name, n.depth])).toEqual([['Bob', 0]]);
      expect(depth0.edges).toHaveLength(0);

      const depth1 = await getConceptNetwork(client, 'Bob', 1);
      expect(depth1.nodes.every(n => n.depth <= 1)).toBe(true);

      const depth2 = await getConceptNetwork(client, 'Bob', 2);
      expect(depth2.nodes.every(n => n.depth <= 2)).toBe(true);
      expect(depth2.nodes.length).toBeGreaterThan(depth1.nodes.length);
    });

    it('returns only the root for a page with no links', async () => {
      for (const name of ['archive', 'empty page']) {
        const result = await getConceptNetwork(client, name, 2);
        expect(result.nodes.map(n => n.depth), name).toEqual([0]);
        expect(result.edges, name).toEqual([]);
        expect(result.truncated, name).toBe(false);
      }
    });

    it('should throw error for non-existent page', async () => {
      await expect(
        getConceptNetwork(client, 'NonExistentConceptForGraphTools12345', 2)
      ).rejects.toThrow(/^No page "/);
    });
  });

  describe('caps on the hub (#3, #89)', () => {
    it('depth 1 with the defaults keeps exactly the 15 pages with two references', async () => {
      const result = await getConceptNetwork(client, 'hub central', 1);

      expect(result.nodes.map(n => n.name).sort()).toEqual(
        ['hub central', ...range('neighbour-both', 10), ...range('neighbour-in', 5)].sort()
      );
      expect(result.truncated).toBe(true);
      expect(result.hasMore).toBe(true);
      expect(result.warnings.map(w => w.code)).toEqual(['network_truncated']);
    });

    it('depth 2 with the defaults stops at max_nodes 50', async () => {
      const result = await getConceptNetwork(client, 'hub central', 2);

      expect(result.nodes).toHaveLength(50);
      // 1 + 15 + 34: which 34 of the 40 fringe pages depends on id order, the split does not
      expect(result.nodes.filter(n => n.depth === 1)).toHaveLength(15);
      expect(result.nodes.filter(n => n.depth === 2)).toHaveLength(34);
      expect(result.nodes.filter(n => n.depth === 2).every(n => n.name.startsWith('fringe-'))).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.warnings.map(w => w.code)).toEqual(['network_truncated']);
    });

    it('depth 1 at the largest caps a client can ask for keeps 100 of 121 candidates', async () => {
      const result = await getConceptNetwork(client, 'hub central', 1, { maxNodes: 500, maxFanout: 100 });

      expect(result.nodes).toHaveLength(101);
      expect(result.truncated).toBe(true);
      // The journal ranks last among the candidates, so the fanout cap drops it
      expect(result.nodes.some(n => n.name === 'Jun 17th, 2024')).toBe(false);
    });

    it('a journal is a leaf by default, and expand_journals walks through it', async () => {
      const leaf = await getConceptNetwork(client, 'journal-topic-01', 2);
      expect(leaf.nodes.map(n => n.name).sort()).toEqual(['Jun 17th, 2024', 'journal-topic-01']);
      expect(leaf.truncated).toBe(false);

      const expanded = await getConceptNetwork(client, 'journal-topic-01', 2, { expandJournals: true });
      expect(expanded.nodes).toHaveLength(17);
      expect(expanded.truncated).toBe(true);
      expect(expanded.warnings.map(w => w.code)).toEqual(['network_truncated']);

      const wide = await getConceptNetwork(client, 'journal-topic-01', 2, { expandJournals: true, maxFanout: 100 });
      expect(wide.nodes).toHaveLength(32);
      expect(wide.nodes.some(n => n.name === 'hub central')).toBe(true);
      expect(wide.truncated).toBe(false);
    });
  });
});
