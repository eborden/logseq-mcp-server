import { describe, it, expect, vi } from 'vitest';
import { getBacklinks, getBacklinksWithMeta } from './get-backlinks.js';
import { LogseqClient } from '../client.js';

// Synthetic graph from the issue: "Jordan" declares `alias:: Jordan Rivera`.
// Block 100 links [[Jordan]] on a journal page, block 200 links [[Jordan Rivera]] on a plain page.
const file = { id: 900 };
const jordan = { id: 1, name: 'jordan', 'original-name': 'Jordan', file, alias: [{ id: 2 }] };
const jordanRivera = { id: 2, name: 'jordan rivera', 'original-name': 'Jordan Rivera', alias: [{ id: 1 }] };
const member = (p: { id: number; name: string; 'original-name': string }) => ({
  id: p.id,
  name: p.name,
  'original-name': p['original-name']
});
// Source pages as the query pulls them: `journal-day` only on a journal
const journal = { id: 50, name: 'jan 1st, 2025', 'original-name': 'Jan 1st, 2025', 'journal-day': 20250101 };
const notes = { id: 51, name: 'my page', 'original-name': 'My page' };
const refBlock = (id: number, page: Record<string, unknown>, content: string) => ({
  id,
  uuid: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  content,
  'path-refs': [{ id: 1 }],
  page
});

function fakeClient() {
  const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
    if (query.includes(':in $ ?n')) {
      // resolver: "jordan" is a real page; "jordan rivera" is an alias stub of it
      return inputs[0] === 'jordan rivera'
        ? [[jordanRivera, 'name'], [jordan, 'alias']]
        : [[jordan, 'name']];
    }
    if (query.includes('?start')) return [[1, member(jordan)], [1, member(jordanRivera)]];
    if (query.includes(':block/path-refs')) {
      return [
        [refBlock(100, journal, 'Ship the migration [[Jordan]]')],
        [refBlock(200, notes, 'Review with [[Jordan Rivera]]')],
        [refBlock(100, journal, 'Ship the migration [[Jordan]]')] // same block twice
      ];
    }
    throw new Error(`unexpected query: ${query}`);
  });
  const callAPI = vi.fn();
  return { client: { executeDatalogQuery, callAPI } as unknown as LogseqClient, executeDatalogQuery, callAPI };
}

const blockIds = (results: Array<[unknown, Array<{ id: number }>]> | null) =>
  (results ?? []).flatMap(([, blocks]) => blocks.map(b => b.id)).sort((a, b) => a - b);

describe('get_backlinks across an alias group (#69)', () => {
  it('returns the references to every name of the page, once each, from one Datalog query', async () => {
    const { client, callAPI } = fakeClient();

    const { results } = await getBacklinksWithMeta(client, 'Jordan');

    expect(blockIds(results as any)).toEqual([100, 200]);
    // not the Editor call: it would need one request per name
    expect(callAPI).not.toHaveBeenCalled();
  });

  it('gives the same blocks whether asked by the canonical name or the alias', async () => {
    const byName = await getBacklinksWithMeta(fakeClient().client, 'Jordan');
    const byAlias = await getBacklinksWithMeta(fakeClient().client, 'Jordan Rivera');

    expect(blockIds(byAlias.results as any)).toEqual(blockIds(byName.results as any));
    expect(byAlias.meta?.resolvedAliases).toEqual(['Jordan', 'Jordan Rivera']);
  });

  it('shapes the tuples like the Editor API: [page, blocks] with camelCase keys', async () => {
    const { results } = await getBacklinksWithMeta(fakeClient().client, 'Jordan');

    const [page, blocks] = results!.find(([p]) => p.id === 50) as any;
    expect(blocks[0].pathRefs).toEqual([{ id: 1 }]);
    expect(blocks[0].page).toEqual(page);
  });

  it('gives each source page the keys the Editor call gives it, journalDay included on a journal', async () => {
    // What logseq.Editor.getPageLinkedReferences returns as a source page (checked on a live graph)
    const editorShaped = {
      50: { id: 50, name: 'jan 1st, 2025', originalName: 'Jan 1st, 2025', journalDay: 20250101 },
      51: { id: 51, name: 'my page', originalName: 'My page' }
    } as Record<number, unknown>;

    const { results } = await getBacklinksWithMeta(fakeClient().client, 'Jordan');

    expect(results).toHaveLength(2);
    for (const [page, blocks] of results!) {
      expect(page).toStrictEqual(editorShaped[page.id]);
      for (const block of blocks) expect(block.page).toStrictEqual(editorShaped[page.id]);
    }
  });

  it('lists the covered names, original case, in meta.resolvedAliases', async () => {
    const { meta } = await getBacklinksWithMeta(fakeClient().client, 'Jordan');

    expect(meta).toEqual({
      hasMore: false,
      warnings: [],
      resolvedAliases: ['Jordan', 'Jordan Rivera']
    });
  });

  it('costs one query more than a page without aliases: resolver, alias set, references', async () => {
    const { client, executeDatalogQuery } = fakeClient();

    await getBacklinks(client, 'Jordan');

    expect(executeDatalogQuery).toHaveBeenCalledTimes(3);
  });

  it('leaves a page with no aliases exactly as before: one Editor call, no meta', async () => {
    const alice = { id: 9, name: 'alice', 'original-name': 'Alice', file };
    const callAPI = vi.fn().mockResolvedValue([]);
    const executeDatalogQuery = vi.fn().mockResolvedValue([[alice, 'name']]);
    const client = { callAPI, executeDatalogQuery } as unknown as LogseqClient;

    const { results, meta } = await getBacklinksWithMeta(client, 'Alice');

    expect(results).toEqual([]);
    expect(meta).toBeNull();
    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    expect(callAPI).toHaveBeenCalledWith('logseq.Editor.getPageLinkedReferences', ['Alice']);
  });
});
