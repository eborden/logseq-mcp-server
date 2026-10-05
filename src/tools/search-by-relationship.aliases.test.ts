import { describe, it, expect, vi } from 'vitest';
import { searchByRelationship } from './search-by-relationship.js';
import { LogseqClient } from '../client.js';
import { LogSeqTimeoutError } from '../errors.js';

// Synthetic graph from the issue: "Jordan" (id 1) declares `alias:: Jordan Rivera` (id 2, the stub).
// "Alice" (id 9) has no aliases; "Atlas" (id 20) is aliased by "Project Atlas" (id 21).
const file = { id: 900 };
const jordan = { id: 1, name: 'jordan', 'original-name': 'Jordan', file, alias: [{ id: 2 }] };
const jordanRivera = { id: 2, name: 'jordan rivera', 'original-name': 'Jordan Rivera', alias: [{ id: 1 }] };
const alice = { id: 9, name: 'alice', 'original-name': 'Alice', file };
const atlas = { id: 20, name: 'atlas', 'original-name': 'Atlas', file, alias: [{ id: 21 }] };
const projectAtlas = { id: 21, name: 'project atlas', 'original-name': 'Project Atlas', alias: [{ id: 20 }] };

const PAGES: Record<string, any> = { jordan, 'jordan rivera': jordanRivera, alice, atlas, 'project atlas': projectAtlas };
const GROUPS: Record<number, any[]> = { 1: [jordan, jordanRivera], 20: [atlas, projectAtlas] };
const member = (p: any) => ({ id: p.id, name: p.name, 'original-name': p['original-name'] });

// Links between pages, either direction. As on a real graph, a declaring page's `alias::` block
// refs its alias stub, so each declarer and its stub are neighbours of each other.
const ALIAS_EDGES: Array<[number, number]> = [[1, 2], [20, 21]];

function fakeClient(opts: { edges?: Array<[number, number]>; aliasError?: Error } = {}) {
  const edges = [...ALIAS_EDGES, ...(opts.edges ?? [])];
  const neighborsOf = (ids: number[]) => [
    ...new Set(edges.flatMap(([a, b]) => [...(ids.includes(a) ? [b] : []), ...(ids.includes(b) ? [a] : [])]))
  ];
  const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
    if (query.includes(':in $ ?n')) {
      const name = inputs[0] as string;
      // "jordan rivera" and "project atlas" are file-less stubs, so the resolver redirects to the declarer
      if (name === 'jordan rivera') return [[jordanRivera, 'name'], [jordan, 'alias']];
      if (name === 'project atlas') return [[projectAtlas, 'name'], [atlas, 'alias']];
      return [[PAGES[name], 'name']];
    }
    if (query.includes('?start')) {
      if (opts.aliasError) throw opts.aliasError;
      const starts = [...query.matchAll(/\(ground \[([\d ]+)\]\) \[\?start/g)][0][1].split(' ').map(Number);
      return starts.flatMap(start => (GROUPS[start] ?? []).map(p => [start, member(p)]));
    }
    if (query.includes('?p ...')) {
      const frontier = [...query.matchAll(/\(ground \[([\d ]+)\]\) \[\?p/g)][0][1].split(' ').map(Number);
      return neighborsOf(frontier).map(id => [id]);
    }
    return [[{ id: 500, content: 'a matching block' }]];
  });
  const callAPI = vi.fn(async (method: string, args: unknown[]) =>
    method === 'logseq.Editor.getPageBlocksTree' ? [{ id: 600, content: `tree of ${args[0]}` }] : []
  );
  return { client: { executeDatalogQuery, callAPI } as unknown as LogseqClient, executeDatalogQuery, callAPI };
}

const dataQuery = (calls: unknown[][]) => calls[calls.length - 1][0] as string;

describe('search_by_relationship across alias groups (#69)', () => {
  it('references: matches blocks on any name of topic A that link any name of topic B', async () => {
    const { client, executeDatalogQuery } = fakeClient();

    const result = await searchByRelationship(client, 'Jordan', 'Atlas', 'references');

    const query = dataQuery(executeDatalogQuery.mock.calls);
    expect(query).toContain('[(ground [1 2]) [?page ...]]');
    expect(query).toContain('[(ground [20 21]) [?ref ...]]');
    expect(result.results.map(b => b.id)).toEqual([500]);
    expect(result.resolvedAliases).toEqual({
      topicA: ['Jordan', 'Jordan Rivera'],
      topicB: ['Atlas', 'Project Atlas']
    });
  });

  it('in-pages-linking-to: uses the ids of both groups', async () => {
    const { client, executeDatalogQuery } = fakeClient();

    await searchByRelationship(client, 'Alice', 'Jordan Rivera', 'in-pages-linking-to');

    const query = dataQuery(executeDatalogQuery.mock.calls);
    expect(query).toContain('[(ground [9]) [?a ...]]');
    expect(query).toContain('[(ground [1 2]) [?b ...]]');
  });

  it('queries the alias and the canonical name as the same topic', async () => {
    const byName = fakeClient();
    const byAlias = fakeClient();

    const a = await searchByRelationship(byName.client, 'Jordan', 'Alice', 'references');
    const b = await searchByRelationship(byAlias.client, 'Jordan Rivera', 'Alice', 'references');

    expect(dataQuery(byAlias.executeDatalogQuery.mock.calls)).toBe(dataQuery(byName.executeDatalogQuery.mock.calls));
    expect(b.resolvedAliases).toEqual(a.resolvedAliases);
    expect(b.results).toEqual(a.results);
  });

  it('costs one query more than topics without aliases, for both topics together', async () => {
    const { client, executeDatalogQuery } = fakeClient();

    await searchByRelationship(client, 'Jordan', 'Atlas', 'references');

    // 2 resolvers, 1 alias query for both topics, 1 data query
    expect(executeDatalogQuery).toHaveBeenCalledTimes(4);
  });

  it('is unchanged when neither topic has aliases: name-based query, no resolvedAliases', async () => {
    const { client, executeDatalogQuery } = fakeClient();

    const result = await searchByRelationship(client, 'Alice', 'Alice', 'references');

    expect(executeDatalogQuery).toHaveBeenCalledTimes(2); // one resolver (same name), one data query
    expect(dataQuery(executeDatalogQuery.mock.calls)).toContain(':in $ ?page-name ?ref-name');
    expect(result).not.toHaveProperty('resolvedAliases');
  });

  it('connected-within: starts from every name of A and ends at any name of B', async () => {
    // hop 1 from {1, 2} reaches page 21, a name of Atlas (B), through a link on the stub
    const { client, executeDatalogQuery, callAPI } = fakeClient({ edges: [[1, 30], [2, 21]] });

    const result = await searchByRelationship(client, 'Jordan', 'Atlas', 'connected-within', 2);

    const hop = executeDatalogQuery.mock.calls.find(([q]) => (q as string).includes('?p ...'))!;
    expect(hop[0]).toContain('[(ground [1 2]) [?p ...]]');
    expect(result.results.map(b => b.id)).toEqual([600, 600]);
    expect(callAPI).toHaveBeenCalledWith('logseq.Editor.getPageBlocksTree', ['Jordan']);
    expect(callAPI).toHaveBeenCalledWith('logseq.Editor.getPageBlocksTree', ['Atlas']);
  });

  it('connected-within: two names of one page are the same topic, not a connection', async () => {
    // hop 1 from {1, 2} would reach 1 and 2 again through the alias block, plus page 30
    const { client, executeDatalogQuery, callAPI } = fakeClient({ edges: [[1, 30]] });

    const result = await searchByRelationship(client, 'Jordan', 'Jordan Rivera', 'connected-within', 2);

    expect(result.results).toEqual([]);
    expect(result.warnings.map(w => w.code)).toEqual(['same_topic']);
    expect(result.hasMore).toBe(false);
    expect(executeDatalogQuery.mock.calls.some(([q]) => (q as string).includes('?p ...'))).toBe(false);
    expect(callAPI).not.toHaveBeenCalled();
  });

  it('connected-within: the same name twice is the same topic, with or without aliases', async () => {
    for (const name of ['Alice', 'Jordan']) {
      const { client, executeDatalogQuery } = fakeClient({ edges: [[9, 1]] });

      const result = await searchByRelationship(client, name, name, 'connected-within', 3);

      expect(result.results).toEqual([]);
      expect(result.warnings.map(w => w.code)).toEqual(['same_topic']);
      expect(executeDatalogQuery.mock.calls.some(([q]) => (q as string).includes('?p ...'))).toBe(false);
    }
  });

  it('connected-within: a link between the alias groups of two pages is a connection', async () => {
    // Alice links the stub "Jordan Rivera" only
    const { client, callAPI } = fakeClient({ edges: [[9, 2]] });

    const result = await searchByRelationship(client, 'Alice', 'Jordan', 'connected-within', 1);

    expect(result.results.map(b => b.id)).toEqual([600, 600]);
    expect(result.warnings).toEqual([]);
    expect(callAPI).toHaveBeenCalledWith('logseq.Editor.getPageBlocksTree', ['Jordan']);
  });

  it('propagates a failed alias lookup instead of searching under one name', async () => {
    const { client } = fakeClient({ aliasError: new LogSeqTimeoutError('http://127.0.0.1:12315', 30000) });

    await expect(searchByRelationship(client, 'Jordan', 'Alice', 'references')).rejects.toBeInstanceOf(
      LogSeqTimeoutError
    );
  });
});
