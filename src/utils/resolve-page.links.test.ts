import { describe, it, expect, vi } from 'vitest';
import { resolveLinkTargets, MAX_CANDIDATES } from './resolve-page.js';
import { LogseqClient } from '../client.js';
import { LogSeqTimeoutError } from '../errors.js';

/** A page as `linkTargets` pulls it. */
const page = (id: number, name: string, originalName: string) => ({
  id,
  name,
  'original-name': originalName,
  file: { id: 900 + id },
});
/** A page LogSeq made because something links or aliases it: no file. */
const stub = (id: number, name: string) => ({ id, name, 'original-name': name });

function fakeClient(rows: unknown) {
  const executeDatalogQuery = vi.fn(async () => rows);
  const callAPI = vi.fn(async () => {
    throw new Error('no Editor call expected');
  });
  return { client: { executeDatalogQuery, callAPI } as unknown as LogseqClient, executeDatalogQuery, callAPI };
}

describe('resolveLinkTargets (#146)', () => {
  it('resolves every name in one query: exact names, aliases, file-less pages, ambiguity and misses', async () => {
    const { client, executeDatalogQuery } = fakeClient([
      [page(1, 'alice', 'Alice'), 'name', 'alice'],
      // `alias:: atlas` on project atlas: the stub is the exact match, the declaring page wins
      [stub(2, 'atlas'), 'name', 'atlas'],
      [page(3, 'project atlas', 'Project Atlas'), 'alias', 'atlas'],
      // A page that exists only as a link target
      [stub(4, 'my page'), 'name', 'my page'],
      // Two pages declare the same alias
      [stub(5, 'roadmap'), 'name', 'roadmap'],
      [page(6, 'project borealis', 'Project Borealis'), 'alias', 'roadmap'],
      [page(7, 'project cascade', 'Project Cascade'), 'alias', 'roadmap'],
    ]);

    const { resolutions, unavailable } = await resolveLinkTargets(client, [
      'Alice',
      'ATLAS',
      ' my page ',
      'roadmap',
      'no such page',
      'alice',
    ]);

    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    // Trimmed, lowercased, sent once each
    expect(executeDatalogQuery.mock.calls[0]).toContainEqual(['alice', 'atlas', 'my page', 'roadmap', 'no such page']);
    expect(unavailable).toBe(false);
    expect(resolutions.get('alice')).toMatchObject({ kind: 'found', originalName: 'Alice', matchedBy: 'name' });
    expect(resolutions.get('atlas')).toMatchObject({ kind: 'found', originalName: 'Project Atlas', matchedBy: 'alias' });
    expect(resolutions.get('my page')).toMatchObject({ kind: 'found', originalName: 'my page', matchedBy: 'name' });
    expect(resolutions.get('roadmap')).toMatchObject({ kind: 'ambiguous', totalCandidates: 2 });
    expect(resolutions.get('no such page')).toEqual({ kind: 'not_found' });
  });

  it('keeps a written page by its own name even when another page aliases it', async () => {
    const { client } = fakeClient([
      [page(1, 'bob', 'Bob'), 'name', 'bob'],
      [page(2, 'robert', 'Robert'), 'alias', 'bob'],
    ]);

    const { resolutions } = await resolveLinkTargets(client, ['Bob']);

    expect(resolutions.get('bob')).toMatchObject({ kind: 'found', originalName: 'Bob', matchedBy: 'name' });
  });

  it('caps the candidates of an ambiguous alias and keeps the real total', async () => {
    const sources = Array.from({ length: MAX_CANDIDATES + 2 }, (_, i) => [page(10 + i, `p${i}`, `P${i}`), 'alias', 'x']);
    const { client } = fakeClient([[stub(1, 'x'), 'name', 'x'], ...sources]);

    const resolution = (await resolveLinkTargets(client, ['x'])).resolutions.get('x');

    expect(resolution).toMatchObject({ kind: 'ambiguous', totalCandidates: MAX_CANDIDATES + 2 });
    expect(resolution?.kind === 'ambiguous' && resolution.candidates).toHaveLength(MAX_CANDIDATES);
  });

  it('makes no call for no names, or for blank ones only', async () => {
    const { client, executeDatalogQuery } = fakeClient([]);

    expect((await resolveLinkTargets(client, [])).resolutions.size).toBe(0);
    expect((await resolveLinkTargets(client, ['  ', ''])).resolutions.size).toBe(0);
    expect(executeDatalogQuery).not.toHaveBeenCalled();
  });

  it('says when LogSeq answered null, rather than report every name as missing', async () => {
    const { client } = fakeClient(null);

    const { resolutions, unavailable } = await resolveLinkTargets(client, ['alice']);

    expect(unavailable).toBe(true);
    expect(resolutions.get('alice')).toEqual({ kind: 'not_found' });
  });

  it('lets infrastructure errors through', async () => {
    const executeDatalogQuery = vi.fn(async () => {
      throw new LogSeqTimeoutError('http://localhost:12315', 30000);
    });
    const client = { executeDatalogQuery, callAPI: vi.fn() } as unknown as LogseqClient;

    await expect(resolveLinkTargets(client, ['alice'])).rejects.toBeInstanceOf(LogSeqTimeoutError);
  });
});
