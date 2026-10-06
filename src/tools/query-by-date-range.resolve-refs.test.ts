import { describe, it, expect, vi } from 'vitest';
import { queryJournals } from './query-by-date-range.js';
import { fakeRefGraph, uuidN } from '../../tests/helpers/ref-graph.js';
import type { LogseqClient } from '../client.js';

const REF = uuidN(7);

const page = (id: number, day: number, name: string) => ({
  id,
  uuid: uuidN(100 + id),
  name: name.toLowerCase(),
  'original-name': name,
  'journal-day': day,
  'journal?': true
});

const block = (id: number, pageId: number, content: string, parent = pageId, left = pageId) => ({
  id,
  uuid: uuidN(id),
  content,
  format: 'markdown',
  page: { id: pageId },
  parent: { id: parent },
  left: { id: left }
});

/**
 * A client that answers the two journal queries from fixed data and every ref
 * query from an in-memory graph, counting both.
 */
function setup(blocks: any[]) {
  const graph = fakeRefGraph({
    pages: ['Day One', 'Day Two'],
    blocks: [{ uuid: REF, content: 'quoted words', page: 'Day Two' }]
  });
  const pages = [page(1, 20250101, 'Day One'), page(2, 20250102, 'Day Two')];
  const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
    if (query.includes(':block/uuid ?u') || query.includes(':block/name ?n')) {
      return graph.executeDatalogQuery(query, ...inputs);
    }
    if (query.includes(':block/alias')) return []; // the search term's alias lookup
    return query.includes(':block/page ?page')
      ? blocks.map(b => [b])
      : pages.map(p => [p]);
  });
  return { client: { executeDatalogQuery } as unknown as LogseqClient, executeDatalogQuery };
}

const journalBlocks = () => [
  block(10, 1, `one ((${REF}))`),
  block(11, 1, 'nested', 10, 10),
  block(20, 2, `two ((${REF})) again`),
  block(21, 2, 'no refs', 2, 20)
];

const opts = { startDate: 20250101, endDate: 20250102 };

describe('queryJournals resolve_refs', () => {
  it('off: two calls, identical output, no extra fields', async () => {
    const { client, executeDatalogQuery } = setup(journalBlocks());
    const result: any = await queryJournals(client, opts);
    expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toMatch(/resolved|warnings|hasMore/);
    expect(Object.keys(result)).toEqual(['dateRange', 'entries', 'summary']);
  });

  it('explicit false equals off', async () => {
    const off = setup(journalBlocks());
    const explicit = setup(journalBlocks());
    expect(await queryJournals(explicit.client, { ...opts, resolveRefs: false })).toEqual(
      await queryJournals(off.client, opts)
    );
  });

  it('on: resolves across days with one extra query, however many days', async () => {
    const { client, executeDatalogQuery } = setup(journalBlocks());
    const result: any = await queryJournals(client, { ...opts, resolveRefs: true });

    expect(executeDatalogQuery).toHaveBeenCalledTimes(3); // 2 + one batched resolve, <= depth + 1 extra
    const [dayOne, dayTwo] = result.entries;
    expect(dayOne.blocks[0].content).toBe(`one ((${REF}))`);
    expect(dayOne.blocks[0].resolvedContent).toBe('one quoted words');
    expect(dayOne.blocks[0].resolvedRefs).toEqual([
      { uuid: REF, content: 'quoted words', page: 'Day Two', status: 'ok' }
    ]);
    expect(dayOne.blocks[0].children[0].resolvedContent).toBeUndefined();
    expect(dayTwo.blocks[0].resolvedContent).toBe('two quoted words again');
    expect(dayTwo.blocks[1].resolvedContent).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.summary.totalBlocks).toBe(3);
  });

  it('on with no refs: no extra call, but the meta fields are present', async () => {
    const { client, executeDatalogQuery } = setup([block(10, 1, 'plain')]);
    const result: any = await queryJournals(client, { ...opts, resolveRefs: true });
    expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
    expect(result.warnings).toEqual([]);
  });

  it('slim results carry resolvedContent and resolvedRefs', async () => {
    const { client } = setup(journalBlocks());
    const result: any = await queryJournals(client, { ...opts, resolveRefs: true, slimResults: true });
    const first = result.entries[0].blocks[0];
    expect(first.content).toBe(`one ((${REF}))`);
    expect(first.resolvedContent).toBe('one quoted words');
    expect(first.resolvedRefs[0].status).toBe('ok');
    expect(result.entries[0].blocks[0].children[0].resolvedContent).toBeUndefined();
    expect(result.hasMore).toBe(false);
  });

  it('slim results without resolve_refs have no new fields', async () => {
    const { client } = setup(journalBlocks());
    const result: any = await queryJournals(client, { ...opts, slimResults: true });
    expect(JSON.stringify(result)).not.toMatch(/resolved|warnings|hasMore/);
  });

  it('ignores resolve_refs in outline mode (no blocks are returned)', async () => {
    const { client, executeDatalogQuery } = setup(journalBlocks());
    const result: any = await queryJournals(client, { ...opts, includeContent: false, resolveRefs: true });
    expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toMatch(/resolved/);
  });

  it('resolves only the blocks that survive the search filter', async () => {
    const { client, executeDatalogQuery } = setup([
      block(10, 1, `keep ((${REF}))`),
      block(20, 2, `drop ((${uuidN(55)}))`)
    ]);
    const result: any = await queryJournals(client, { ...opts, searchTerm: 'keep', resolveRefs: true });
    expect(result.entries).toHaveLength(1);
    // journals, blocks, the search term's alias lookup (#69), then the ref query
    const refQuery = executeDatalogQuery.mock.calls.map(c => c[0] as string).find(q => q.includes(REF))!;
    expect(refQuery).toContain(REF);
    expect(refQuery).not.toContain(uuidN(55));
  });
});
