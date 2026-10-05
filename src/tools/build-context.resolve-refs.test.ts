import { describe, it, expect, vi } from 'vitest';
import { buildContextForTopic } from './build-context.js';
import { fakeRefGraph, uuidN } from '../../tests/helpers/ref-graph.js';
import type { LogseqClient } from '../client.js';

const REF = uuidN(7);
const embedded = uuidN(8);

/**
 * The topic page and its blocks come from fixed data, backlinks through the
 * Editor API, and ref lookups from an in-memory graph. Everything is counted.
 */
function setup(opts: { manyEmbedChildren?: number } = {}) {
  const children = Array.from({ length: opts.manyEmbedChildren ?? 0 }, (_, i) => ({
    uuid: uuidN(200 + i),
    content: `kid ${i}`,
    page: 'Elsewhere',
    parent: embedded
  }));
  const graph = fakeRefGraph({
    pages: ['Elsewhere'],
    blocks: [
      { uuid: REF, content: 'quoted words', page: 'Elsewhere' },
      { uuid: embedded, content: 'embedded root', page: 'Elsewhere' },
      ...children
    ]
  });
  const direct = [
    { id: 10, uuid: uuidN(10), content: `topic block ((${REF}))` },
    { id: 11, uuid: uuidN(11), content: 'plain block' }
  ];
  const backlink = { id: 20, uuid: uuidN(20), content: `elsewhere {{embed ((${embedded}))}}` };

  const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
    if (query.includes(':block/uuid ?u')) return graph.executeDatalogQuery(query, ...inputs);
    if (query.includes(':block/page ?page')) return direct.map(b => [b]);
    return [[{ id: 1, name: 'topic', properties: {} }]];
  });
  const callAPI = vi.fn(async () => [[{ id: 3, name: 'elsewhere' }, [backlink]]]);
  const client = { config: {}, executeDatalogQuery, callAPI } as unknown as LogseqClient;
  return { client, executeDatalogQuery, callAPI };
}

describe('buildContextForTopic resolve_refs', () => {
  it('off: 2 Datalog queries + 1 API call, no resolved fields', async () => {
    const { client, executeDatalogQuery, callAPI } = setup();
    const result = await buildContextForTopic(client, 'Topic', {});
    expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
    expect(callAPI).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/resolved/);
  });

  it('off: explicit false returns exactly what omitting it returns', async () => {
    const a = await buildContextForTopic(setup().client, 'Topic', {});
    const b = await buildContextForTopic(setup().client, 'Topic', { resolveRefs: false });
    expect(b).toEqual(a);
  });

  it('on: resolves direct blocks and reference blocks with one extra query', async () => {
    const { client, executeDatalogQuery, callAPI } = setup();
    const result = await buildContextForTopic(client, 'Topic', { resolveRefs: true });

    expect(executeDatalogQuery).toHaveBeenCalledTimes(3); // 2 + one batched resolve (<= depth + 1)
    expect(callAPI).toHaveBeenCalledTimes(1);

    const [first, second] = result.directBlocks as any[];
    expect(first.content).toBe(`topic block ((${REF}))`);
    expect(first.resolvedContent).toBe('topic block quoted words');
    expect(second.resolvedContent).toBeUndefined();

    const reference = result.references[0].block as any;
    expect(reference.resolvedContent).toBe('elsewhere embedded root');
    expect(reference.resolvedRefs[0]).toMatchObject({ uuid: embedded, embed: 'block', status: 'ok' });
    expect(result.references[0].sourcePage).toEqual({ id: 3, name: 'elsewhere' });

    expect(result.warnings).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.summary.totalBlocks).toBe(2);
  });

  it('on: a capped embed adds a warning and sets hasMore', async () => {
    const { client } = setup({ manyEmbedChildren: 25 });
    const result = await buildContextForTopic(client, 'Topic', { resolveRefs: true });
    expect(result.warnings.map(w => w.code)).toEqual(['embed_truncated']);
    expect(result.warnings[0].howToFetchAll).toContain('logseq_get_block');
    expect(result.hasMore).toBe(true);
  });

  it('on: keeps the other cap warnings alongside', async () => {
    const { client } = setup();
    const result = await buildContextForTopic(client, 'Topic', { resolveRefs: true, maxBlocks: 1 });
    expect(result.warnings.map(w => w.code)).toEqual(['blocks_truncated']);
    expect(result.directBlocks).toHaveLength(1);
  });
});
