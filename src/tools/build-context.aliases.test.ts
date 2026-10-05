import { describe, it, expect, vi } from 'vitest';
import { buildContextForTopic } from './build-context.js';
import { LogseqClient } from '../client.js';
import { LogSeqTimeoutError } from '../errors.js';

// Synthetic graph from the issue: "Jordan" declares `alias:: Jordan Rivera`.
const file = { id: 900 };
const jordan = { id: 1, name: 'jordan', 'original-name': 'Jordan', file, alias: [{ id: 2 }] };
const jordanRivera = { id: 2, name: 'jordan rivera', 'original-name': 'Jordan Rivera', alias: [{ id: 1 }] };
const member = (p: { id: number; name: string; 'original-name': string }) => ({
  id: p.id,
  name: p.name,
  'original-name': p['original-name']
});
const refBlock = (id: number, pageId: number, pageName: string) => ({
  id,
  content: `block ${id}`,
  'path-refs': [{ id: 1 }],
  page: { id: pageId, name: pageName, 'original-name': pageName }
});

function fakeClient(opts: { aliasError?: Error } = {}) {
  const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
    if (query.includes(':in $ ?n')) {
      return inputs[0] === 'jordan rivera'
        ? [[jordanRivera, 'name'], [jordan, 'alias']]
        : [[jordan, 'name']];
    }
    if (query.includes('?start')) {
      if (opts.aliasError) throw opts.aliasError;
      return [[1, member(jordan)], [1, member(jordanRivera)]];
    }
    if (query.includes(':block/path-refs')) {
      return [[refBlock(100, 50, 'day a')], [refBlock(200, 51, 'day b')]];
    }
    if (query.includes('ground [1 2]')) {
      // blocks on either page of the group, aliases' blocks returned first on purpose
      return [
        [{ id: 31, content: 'own block of the alias page', page: { id: 2 } }],
        [{ id: 30, content: 'own block of the page', page: { id: 1 } }]
      ];
    }
    return [];
  });
  const callAPI = vi.fn().mockResolvedValue([]);
  return { client: { config: {}, executeDatalogQuery, callAPI } as unknown as LogseqClient, executeDatalogQuery, callAPI };
}

describe('build_context across an alias group (#69)', () => {
  it('unions references and blocks of every name, and lists the names covered', async () => {
    const { client, callAPI } = fakeClient();

    const result = await buildContextForTopic(client, 'Jordan');

    expect(result.references.map(r => r.block.id).sort()).toEqual([100, 200]);
    expect(result.directBlocks.map(b => b.id)).toEqual([30, 31]); // the page's own blocks first
    expect(result.resolvedAliases).toEqual(['Jordan', 'Jordan Rivera']);
    expect(callAPI).not.toHaveBeenCalled();
  });

  it('gives the same blocks whether asked by the canonical name or the alias', async () => {
    const byName = await buildContextForTopic(fakeClient().client, 'Jordan');
    const byAlias = await buildContextForTopic(fakeClient().client, 'Jordan Rivera');

    const ids = (r: typeof byName) => [
      ...r.directBlocks.map(b => b.id),
      ...r.references.map(x => x.block.id)
    ].sort();
    expect(ids(byAlias)).toEqual(ids(byName));
    expect(byAlias.resolvedAliases).toEqual(byName.resolvedAliases);
    expect(byAlias.resolvedFrom).toEqual({ name: 'Jordan Rivera', matchedBy: 'alias', resolvedTo: 'Jordan' });
  });

  it('costs one query more than a page without aliases', async () => {
    const aliased = fakeClient();
    await buildContextForTopic(aliased.client, 'Jordan');
    // resolver, alias set, blocks, linked references
    expect(aliased.executeDatalogQuery).toHaveBeenCalledTimes(4);
    expect(aliased.callAPI).toHaveBeenCalledTimes(0);

    const executeDatalogQuery = vi.fn(async (query: string) =>
      query.includes(':in $ ?n') ? [[{ id: 9, name: 'alice', file }, 'name']] : []
    );
    const callAPI = vi.fn().mockResolvedValue([]);
    const plain = { config: {}, executeDatalogQuery, callAPI } as unknown as LogseqClient;
    const result = await buildContextForTopic(plain, 'Alice');
    expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
    expect(callAPI).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty('resolvedAliases');
  });

  it('propagates a failed alias lookup instead of returning a partial context', async () => {
    const { client } = fakeClient({ aliasError: new LogSeqTimeoutError('http://127.0.0.1:12315', 30000) });

    await expect(buildContextForTopic(client, 'Jordan')).rejects.toBeInstanceOf(LogSeqTimeoutError);
  });
});
