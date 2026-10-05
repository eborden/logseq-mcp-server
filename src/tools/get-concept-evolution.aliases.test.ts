import { describe, it, expect, vi } from 'vitest';
import { getConceptEvolution } from './get-concept-evolution.js';
import { LogseqClient } from '../client.js';
import { LogSeqTimeoutError } from '../errors.js';

// Synthetic graph from the issue: page "Jordan" has a first block `alias:: Jordan Rivera`.
// Block 10 links [[Jordan]], block 11 links [[Jordan Rivera]], block 12 links [[Jordan]].
const file = { id: 900 };
const jordan = { id: 1, name: 'jordan', 'original-name': 'Jordan', file, alias: [{ id: 2 }] };
const jordanRivera = { id: 2, name: 'jordan rivera', 'original-name': 'Jordan Rivera', alias: [{ id: 1 }] };
const member = (p: { id: number; name: string; 'original-name': string }) => ({
  id: p.id,
  name: p.name,
  'original-name': p['original-name']
});
const journalBlock = (id: number, day: number, content: string) => ({
  id,
  content,
  page: { id: 500 + id, name: `day ${day}`, 'journal-day': day }
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
    if (query.includes(':block/refs ?ref')) {
      // 10 and 12 reference the canonical name, 11 the alias; 11 is returned twice
      return [
        [journalBlock(10, 20250101, 'Shipped the migration [[Jordan]]')],
        [journalBlock(11, 20250102, 'Reviewed the design doc [[Jordan Rivera]]')],
        [journalBlock(12, 20250103, 'More from [[Jordan]]')],
        [journalBlock(11, 20250102, 'Reviewed the design doc [[Jordan Rivera]]')]
      ];
    }
    throw new Error(`unexpected query: ${query}`);
  });
  const callAPI = vi.fn(async (method: string) => {
    if (method === 'logseq.Editor.getPageBlocksTree') return [{ id: 1, content: 'alias:: Jordan Rivera' }];
    if (method === 'logseq.Editor.getPage') return { id: 1, name: 'jordan', originalName: 'Jordan' };
    throw new Error(`unexpected call: ${method}`);
  });
  return { client: { executeDatalogQuery, callAPI } as unknown as LogseqClient, executeDatalogQuery, callAPI };
}

const blockIds = (timeline: Array<{ blocks: Array<{ id: number }> }>) =>
  timeline.flatMap(t => t.blocks.map(b => b.id)).sort((a, b) => a - b);

describe('get_concept_evolution across an alias group (#69)', () => {
  it('returns blocks that link either name, once each', async () => {
    const result = await getConceptEvolution(fakeClient().client, 'Jordan');

    expect(blockIds(result.timeline)).toEqual([1, 10, 11, 12]);
    expect(result.summary.totalMentions).toBe(4);
  });

  it('gives the same block set for the alias and the canonical name', async () => {
    const byName = await getConceptEvolution(fakeClient().client, 'Jordan');
    const byAlias = await getConceptEvolution(fakeClient().client, 'Jordan Rivera');

    expect(blockIds(byAlias.timeline)).toEqual(blockIds(byName.timeline));
    expect(byAlias.resolvedAliases).toEqual(['Jordan', 'Jordan Rivera']);
    expect(byName.resolvedAliases).toEqual(['Jordan', 'Jordan Rivera']);
  });

  it('puts the alias pages own blocks in the same query as the references', async () => {
    const { client, executeDatalogQuery } = fakeClient();

    await getConceptEvolution(client, 'Jordan');

    const mentions = executeDatalogQuery.mock.calls.find(([q]) => (q as string).includes(':block/refs ?ref'))!;
    expect(mentions[0]).toContain('[(ground [1 2]) [?ref ...]]');
    expect(mentions[0]).toContain('[(ground [2]) [?own ...]]'); // not page 1: its tree is fetched above
  });

  it('costs one query more than a page without aliases', async () => {
    const { client, executeDatalogQuery, callAPI } = fakeClient();

    await getConceptEvolution(client, 'Jordan');

    // resolver, alias set, mentions; plus the page tree and the page from the Editor API
    expect(executeDatalogQuery).toHaveBeenCalledTimes(3);
    expect(callAPI).toHaveBeenCalledTimes(2);
  });

  it('leaves a page without aliases unchanged: no alias query, no resolvedAliases', async () => {
    const executeDatalogQuery = vi.fn(async (query: string) =>
      query.includes(':in $ ?n') ? [[{ id: 9, name: 'alice', 'original-name': 'Alice', file }, 'name']] : []
    );
    const callAPI = vi.fn().mockResolvedValue([]);
    const client = { executeDatalogQuery, callAPI } as unknown as LogseqClient;

    const result = await getConceptEvolution(client, 'Alice');

    expect(executeDatalogQuery).toHaveBeenCalledTimes(2); // resolver, mentions
    expect(result).not.toHaveProperty('resolvedAliases');
    expect(result).not.toHaveProperty('warnings');
  });

  it('propagates a failed alias lookup', async () => {
    const { client } = fakeClient({ aliasError: new LogSeqTimeoutError('http://127.0.0.1:12315', 30000) });

    await expect(getConceptEvolution(client, 'Jordan')).rejects.toBeInstanceOf(LogSeqTimeoutError);
  });
});
