import { describe, it, expect, vi } from 'vitest';
import { getConceptNetwork, MAX_FANOUT_LIMIT, MAX_NODES_LIMIT } from './get-concept-network.js';
import { LogseqClient } from '../client.js';

/** A row of DatalogQueryBuilder.connectedPages: source, connected, name, name, journal, rel, count. */
function row(source: number, connected: number, opts: { journal?: boolean } = {}) {
  const name = `page ${connected}`;
  return [source, connected, name, name, opts.journal ?? false, 'outbound', 1];
}

/** The root lookup (the only query with an :in input) returns the root; each batched query the next level. */
function mockClient(levels: unknown[][][]) {
  const queue = [...levels];
  const executeDatalogQuery = vi.fn(async (query: string) => {
    if (query.includes(':in $ ?n')) return [[{ id: 1, name: 'root page', 'original-name': 'Root Page' }, 'name']];
    return queue.shift() ?? [];
  });
  return { config: {}, executeDatalogQuery, callAPI: vi.fn() } as unknown as LogseqClient;
}

/** `n` pages one link from `from`. */
const neighbours = (n: number, from = 1, first = 100) =>
  Array.from({ length: n }, (_, i) => row(from, first + i));

/** Every number that follows "max_nodes to " in a text. */
const suggestedMaxNodes = (text: string) => [...text.matchAll(/max_nodes to (\d+)/g)].map(m => Number(m[1]));

describe('network_truncated at the maximum of max_nodes and max_fanout (#132)', () => {
  it('exports the maxima the handler clamps to', () => {
    expect([MAX_NODES_LIMIT, MAX_FANOUT_LIMIT]).toEqual([500, 100]);
  });

  describe('max_nodes', () => {
    it('at 500 reports the maximum, offers nothing to raise and leaves hasMore false', async () => {
      const client = mockClient([neighbours(600)]);

      const result = await getConceptNetwork(client, 'Root Page', 1, { maxNodes: 500, maxFanout: Infinity });

      expect(result.nodes).toHaveLength(500);
      expect(result.truncated).toBe(true);
      expect(result.hasMore).toBe(false);
      expect(result.warnings).toHaveLength(1);
      const [warning] = result.warnings;
      expect(warning.code).toBe('network_truncated');
      expect(warning).not.toHaveProperty('howToFetchAll');
      expect(warning.message).toContain('Kept 500 pages; at least 101 more connected pages were dropped.');
      expect(warning.message).toContain('max_nodes reached its maximum of 500');
      expect(warning.message).toContain("the rest can't be fetched in one call");
      // Nothing past the maximum, and nothing about raising it
      expect(suggestedMaxNodes(warning.message)).toEqual([]);
      expect(warning.message).not.toContain('max_fanout');
    });

    it('below 500, with more pages than 500 could hold, suggests 500 and no more', async () => {
      const client = mockClient([neighbours(600)]);

      const result = await getConceptNetwork(client, 'Root Page', 1, { maxNodes: 400, maxFanout: Infinity });

      expect(result.nodes).toHaveLength(400);
      expect(result.hasMore).toBe(true);
      expect(result.warnings[0].howToFetchAll).toBe('Set max_nodes to 500 (the maximum). A result this large may be saved to a file by the host instead of shown; the server can\'t tell.');
      expect(result.warnings[0].message).toBe('Kept 400 pages; at least 201 more connected pages were dropped.');
    });

    it('notes that a large result may be saved to a file only past about 200 nodes (#196)', async () => {
      const note = "A result this large may be saved to a file by the host instead of shown; the server can't tell.";
      const at200 = await getConceptNetwork(mockClient([neighbours(199)]), 'Root Page', 1, { maxNodes: 50, maxFanout: Infinity });
      expect(at200.warnings[0].howToFetchAll).toBe('Set max_nodes to 200 (max 500).');

      const at201 = await getConceptNetwork(mockClient([neighbours(200)]), 'Root Page', 1, { maxNodes: 50, maxFanout: Infinity });
      expect(at201.warnings[0].howToFetchAll).toBe(`Set max_nodes to 201 (max 500). ${note}`);

      // No cap at its maximum: the first form of the warning
      const open = await getConceptNetwork(mockClient([neighbours(250)]), 'Root Page', 1, { maxNodes: 50, maxFanout: 99 });
      expect(open.warnings[0].howToFetchAll).toMatch(/^Set max_nodes to \d+ \(max 500\) and\/or max_fanout higher \(max 100\), or set expand_journals to walk through journal pages\. A result this large may be saved to a file/);
    });

    it('below the maxima keeps the warning as it was', async () => {
      const client = mockClient([neighbours(10)]);

      const result = await getConceptNetwork(client, 'Root Page', 1, { maxNodes: 4, maxFanout: 15 });

      expect(result.hasMore).toBe(true);
      expect(result.warnings).toEqual([
        {
          code: 'network_truncated',
          message: 'Kept 4 pages; at least 7 more connected pages were dropped.',
          howToFetchAll:
            'Set max_nodes to 11 (max 500) and/or max_fanout higher (max 100), ' +
            'or set expand_journals to walk through journal pages.'
        }
      ]);
    });
  });

  describe('max_fanout', () => {
    it('at 100 reports the maximum, offers nothing to raise and leaves hasMore false', async () => {
      const client = mockClient([neighbours(150)]);

      const result = await getConceptNetwork(client, 'Root Page', 1, { maxNodes: 500, maxFanout: 100 });

      expect(result.nodes).toHaveLength(101);
      expect(result.hasMore).toBe(false);
      const [warning] = result.warnings;
      expect(warning).not.toHaveProperty('howToFetchAll');
      expect(warning.message).toContain('Kept 101 pages; at least 50 more connected pages were dropped.');
      expect(warning.message).toContain('max_fanout reached its maximum of 100');
      // max_nodes didn't bite, so it isn't named; depth 1 and journals off leave nothing to narrow with
      expect(warning.message).not.toContain('max_nodes');
      expect(warning.message).not.toContain('max_depth');
      expect(warning.message).not.toContain('expand_journals');
    });

    it('at 100 with a deeper walk says lowering max_depth narrows it', async () => {
      const client = mockClient([[row(1, 2), row(1, 3)], neighbours(150, 3, 1000)]);

      const result = await getConceptNetwork(client, 'Root Page', 2, { maxNodes: 500, maxFanout: 100 });

      expect(result.hasMore).toBe(false);
      expect(result.warnings[0]).not.toHaveProperty('howToFetchAll');
      expect(result.warnings[0].message).toContain('max_fanout reached its maximum of 100');
      expect(result.warnings[0].message).toContain('To narrow the walk instead, lower max_depth.');
      expect(result.warnings[0].message).not.toContain('expand_journals');
    });

    it('names expand_journals as a way to narrow only when a journal page was walked through', async () => {
      const levels = () => [[row(1, 2, { journal: true }), row(1, 3)], neighbours(150, 3, 1000)];
      const options = { maxNodes: 500, maxFanout: 100 };

      const expanded = await getConceptNetwork(mockClient(levels()), 'Root Page', 2, {
        ...options,
        expandJournals: true
      });
      const leaves = await getConceptNetwork(mockClient(levels()), 'Root Page', 2, options);

      expect(expanded.warnings[0].message).toContain(
        'lower max_depth or set expand_journals to false so journal pages stay leaves.'
      );
      expect(leaves.warnings[0].message).not.toContain('expand_journals');
    });

    it('does not name max_depth when every drop is at depth 1, however deep the walk may go', async () => {
      const client = mockClient([neighbours(150)]);

      const result = await getConceptNetwork(client, 'Root Page', 3, { maxNodes: 500, maxFanout: 100 });

      expect(result.warnings[0]).not.toHaveProperty('howToFetchAll');
      expect(result.warnings[0].message).toContain('max_fanout reached its maximum of 100');
      expect(result.warnings[0].message).not.toContain('max_depth');
    });

    it('names max_depth when the first drop is at depth 2, even with a walk up to depth 3', async () => {
      const client = mockClient([[row(1, 2), row(1, 3)], neighbours(150, 3, 1000)]);

      const result = await getConceptNetwork(client, 'Root Page', 3, { maxNodes: 500, maxFanout: 100 });

      expect(result.warnings[0].message).toContain('lower max_depth');
    });

    it('does not name expand_journals when the journal pages were expanded only after the first drop', async () => {
      // Depth 1 holds 90 pages and 20 journals; max_fanout 100 drops 10 journals, and the other 10 are expanded
      const journals = Array.from({ length: 20 }, (_, i) => row(1, 500 + i, { journal: true }));
      const client = mockClient([[...neighbours(90), ...journals], []]);

      const result = await getConceptNetwork(client, 'Root Page', 2, {
        maxNodes: 500,
        maxFanout: 100,
        expandJournals: true
      });

      expect(result.nodes).toHaveLength(101);
      expect(result.warnings[0].message).toContain('max_fanout reached its maximum of 100');
      expect(result.warnings[0].message).not.toContain('expand_journals');
      expect(result.warnings[0].message).not.toContain('max_depth');
    });

    it('does not name expand_journals when the journal was admitted at the last depth', async () => {
      const client = mockClient([[...neighbours(150), row(1, 999, { journal: true })]]);

      const result = await getConceptNetwork(client, 'Root Page', 1, {
        maxNodes: 500,
        maxFanout: 100,
        expandJournals: true
      });

      expect(result.warnings[0].message).not.toContain('expand_journals');
    });
  });

  describe('both caps', () => {
    it('with max_fanout at 100 and the node budget short, offers max_nodes for the pages it can hold', async () => {
      // 150 neighbours: max_fanout 100 drops 50, then a budget of 50 drops 51 of the 100 kept
      const client = mockClient([neighbours(150)]);

      const result = await getConceptNetwork(client, 'Root Page', 1, { maxNodes: 50, maxFanout: 100 });

      expect(result.nodes).toHaveLength(50);
      expect(result.hasMore).toBe(true);
      const [warning] = result.warnings;
      expect(warning.message).toBe(
        'Kept 50 pages; at least 101 more connected pages were dropped. max_fanout reached its maximum of 100.'
      );
      // 101 = 50 kept + the 51 the budget dropped. The 50 the fanout cap dropped are not offered.
      expect(warning.howToFetchAll).toBe('Set max_nodes to 101 (max 500).');
    });

    it('with max_nodes at 500, does not offer a larger max_fanout', async () => {
      // 600 neighbours of the root, max_fanout 550 keeps 550 and the budget drops 51 of them
      const client = mockClient([neighbours(600)]);

      const result = await getConceptNetwork(client, 'Root Page', 1, { maxNodes: 500, maxFanout: 550 });

      expect(result.nodes).toHaveLength(500);
      expect(result.hasMore).toBe(false);
      expect(result.warnings[0]).not.toHaveProperty('howToFetchAll');
      expect(result.warnings[0].message).toContain('max_nodes reached its maximum of 500');
      expect(result.warnings[0].message).toContain("the rest can't be fetched in one call");
    });
  });

  describe('every warning', () => {
    it.each([
      [{ maxNodes: 500, maxFanout: Infinity }, 600],
      [{ maxNodes: 400, maxFanout: Infinity }, 600],
      [{ maxNodes: 500, maxFanout: 100 }, 150],
      [{ maxNodes: 50, maxFanout: 100 }, 150],
      [{ maxNodes: 4, maxFanout: 15 }, 10]
    ])('never points a parameter past its maximum: %j with %d neighbours', async (options, n) => {
      const result = await getConceptNetwork(mockClient([neighbours(n)]), 'Root Page', 1, options);

      const text = `${result.warnings[0].message} ${result.warnings[0].howToFetchAll ?? ''}`;
      expect(suggestedMaxNodes(text).every(v => v <= MAX_NODES_LIMIT)).toBe(true);
      // hasMore is true exactly when there is a parameter to raise
      expect(result.hasMore).toBe(result.warnings[0].howToFetchAll !== undefined);
    });
  });
});
