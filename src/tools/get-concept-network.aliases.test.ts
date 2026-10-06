import { describe, it, expect, vi } from 'vitest';
import { getConceptNetwork } from './get-concept-network.js';
import { LogseqClient } from '../client.js';

// Synthetic graph from the issue: "Jordan" (id 1) declares `alias:: Jordan Rivera` (id 2, the stub).
const file = { id: 900 };
const jordan = { id: 1, name: 'jordan', 'original-name': 'Jordan', file, alias: [{ id: 2 }] };
const jordanRivera = { id: 2, name: 'jordan rivera', 'original-name': 'Jordan Rivera', alias: [{ id: 1 }] };
const alicePage = { id: 9, name: 'alice', 'original-name': 'Alice', file };
const member = (p: { id: number; name: string; 'original-name': string }) => ({
  id: p.id,
  name: p.name,
  'original-name': p['original-name']
});

const row = (source: number, connected: number, rel: 'outbound' | 'inbound', count = 1, name = `page ${connected}`) => [
  source, connected, name.toLowerCase(), name, false, rel, count
];

/** Resolver, alias-set and batched-walk answers; `levels` are the walk's answers in order. */
function fakeClient(levels: unknown[][][]) {
  const queue = [...levels];
  const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
    if (query.includes(':in $ ?n')) {
      return inputs[0] === 'jordan rivera'
        ? [[jordanRivera, 'name'], [jordan, 'alias']]
        : [[jordan, 'name']];
    }
    if (query.includes('?start')) return [[1, member(jordan)], [1, member(jordanRivera)]];
    return queue.shift() ?? [];
  });
  return { client: { config: {}, executeDatalogQuery, callAPI: vi.fn() } as unknown as LogseqClient, executeDatalogQuery };
}

describe('get_concept_network across an alias group (#69)', () => {
  it('walks from every name at depth 1, grouped under the root', async () => {
    const { client, executeDatalogQuery } = fakeClient([[row(1, 3, 'inbound', 2, 'Team Atlas')]]);

    await getConceptNetwork(client, 'Jordan', 1);

    // resolver, alias set, one walk query
    expect(executeDatalogQuery).toHaveBeenCalledTimes(3);
    const walk = executeDatalogQuery.mock.calls[2][0] as string;
    expect(walk).toContain('[(ground [[1 1] [2 1]]) [[?source ?group] ...]]');
    expect(walk).toContain('(count-distinct ?block)');
  });

  it('shows the pages linked from either name as neighbours of one root node', async () => {
    const { client } = fakeClient([
      [
        row(1, 3, 'inbound', 2, 'Team Atlas'), // via [[Jordan]]
        row(1, 4, 'inbound', 1, 'Design Review') // via [[Jordan Rivera]]
      ]
    ]);

    const result = await getConceptNetwork(client, 'Jordan', 1);

    expect(result.nodes.map(n => [n.id, n.name, n.depth])).toEqual([
      [1, 'Jordan', 0],
      [3, 'Team Atlas', 1],
      [4, 'Design Review', 1]
    ]);
    expect(result.edges.map(e => [e.from, e.to, e.count])).toEqual([[1, 3, 2], [1, 4, 1]]);
    expect(result.resolvedAliases).toEqual(['Jordan', 'Jordan Rivera']);
  });

  it('does not make the other name a node: links among the names are dropped', async () => {
    const { client } = fakeClient([
      [row(1, 2, 'outbound', 1, 'Jordan Rivera'), row(1, 3, 'inbound', 1, 'Team Atlas')]
    ]);

    const result = await getConceptNetwork(client, 'Jordan', 1);

    expect(result.nodes.map(n => n.id)).toEqual([1, 3]);
    expect(result.edges.map(e => [e.from, e.to])).toEqual([[1, 3]]);
  });

  it('relabels a neighbour the fanout cap dropped at depth 1 when the root is an alias group (#155)', async () => {
    const { client, executeDatalogQuery } = fakeClient([
      // Grouped depth-1 query: both names are one source (id 1). Page 4 is dropped by maxFanout 1.
      [row(1, 3, 'inbound', 5, 'Team Atlas'), row(1, 4, 'inbound', 1, 'Design Review')],
      // Depth 2 from page 3: back to the other name (dropped) and on to page 4
      [row(3, 2, 'outbound', 1, 'Jordan Rivera'), row(3, 4, 'outbound', 1, 'Design Review')]
    ]);

    const result = await getConceptNetwork(client, 'Jordan', 2, { maxFanout: 1 });

    expect(result.nodes.map(n => [n.id, n.depth])).toEqual([[1, 0], [3, 1], [4, 1]]);
    expect(result.edges.map(e => [e.from, e.to])).toEqual([[1, 3], [1, 4], [3, 4]]);
    expect(result.truncated).toBe(true);
    // resolver, alias set, grouped depth 1, depth 2: the relabel adds no call
    expect(executeDatalogQuery).toHaveBeenCalledTimes(4);
  });

  it('gives the same network for the alias and the canonical name', async () => {
    const level = [[row(1, 3, 'inbound', 2, 'Team Atlas')]];
    const byName = await getConceptNetwork(fakeClient(level).client, 'Jordan', 1);
    const byAlias = await getConceptNetwork(fakeClient(level).client, 'Jordan Rivera', 1);

    expect(byAlias.nodes).toEqual(byName.nodes);
    expect(byAlias.edges).toEqual(byName.edges);
    expect(byAlias.resolvedAliases).toEqual(byName.resolvedAliases);
  });

  it('keeps the unioned count at depth 2: later rows back to a name do not overwrite it', async () => {
    const { client } = fakeClient([
      [row(1, 3, 'inbound', 5, 'Team Atlas')],
      // from Team Atlas, the walk sees its links back to the stub name and to the root
      [row(3, 1, 'outbound', 2, 'Jordan'), row(3, 2, 'outbound', 3, 'Jordan Rivera'), row(3, 7, 'outbound', 1, 'Q3 Plan')]
    ]);

    const result = await getConceptNetwork(client, 'Jordan', 2);

    const edge = result.edges.find(e => e.from === 1 && e.to === 3)!;
    expect(edge).toMatchObject({ inbound: 5 });
    expect(result.nodes.map(n => n.id)).toEqual([1, 3, 7]);
  });

  it('costs one query more than a root without aliases, and none at depth 0', async () => {
    const withAliases = fakeClient([[], []]);
    await getConceptNetwork(withAliases.client, 'Jordan', 2);
    expect(withAliases.executeDatalogQuery).toHaveBeenCalledTimes(3); // resolver, alias set, depth 1 (no frontier left)

    const depthZero = fakeClient([]);
    await getConceptNetwork(depthZero.client, 'Jordan', 0);
    expect(depthZero.executeDatalogQuery).toHaveBeenCalledTimes(1);
  });

  it('is unchanged for a root without aliases: the plain frontier query, no resolvedAliases', async () => {
    const executeDatalogQuery = vi.fn(async (query: string) =>
      query.includes(':in $ ?n') ? [[alicePage, 'name']] : [row(9, 3, 'outbound')]
    );
    const client = { config: {}, executeDatalogQuery, callAPI: vi.fn() } as unknown as LogseqClient;

    const result = await getConceptNetwork(client, 'Alice', 1);

    expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
    expect(executeDatalogQuery.mock.calls[1][0]).toContain('[(ground [9]) [?source ...]]');
    expect(result).not.toHaveProperty('resolvedAliases');
  });
});
