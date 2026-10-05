import { describe, it, expect, vi } from 'vitest';
import { queryJournals } from './query-by-date-range.js';
import { LogseqClient } from '../client.js';
import { LogSeqTimeoutError } from '../errors.js';

// Synthetic graph from the issue: "Jordan" (id 1) declares `alias:: Jordan Rivera` (id 2).
const jordan = { id: 1, name: 'jordan', 'original-name': 'Jordan' };
const jordanRivera = { id: 2, name: 'jordan rivera', 'original-name': 'Jordan Rivera' };

const journalPage = (id: number, day: number, label: string) => ({
  id,
  uuid: `page-uuid-${id}`,
  name: label.toLowerCase(),
  'original-name': label,
  'journal-day': day,
  'journal?': true
});

/** A top-level journal block; `refs` are page maps the way the range query pulls them. */
const block = (id: number, pageId: number, content: string, refs: Array<{ id: number; name: string }> = []) => ({
  id,
  uuid: `block-uuid-${id}`,
  content,
  format: 'markdown',
  page: { id: pageId },
  parent: { id: pageId },
  left: { id: pageId },
  refs
});

const PAGES = [journalPage(50, 20250101, 'Day One'), journalPage(51, 20250102, 'Day Two'), journalPage(52, 20250103, 'Day Three')];
const BLOCKS = [
  block(10, 50, 'Shipped the migration [[Jordan]]', [jordan]),
  block(11, 51, 'Reviewed the design doc [[Jordan Rivera]]', [jordanRivera]),
  block(12, 52, 'Standup notes with no names at all', [jordan]), // links the page through a property-style ref only
  block(13, 52, 'Unrelated lunch plans')
];

// A short alias, for whole-word matching: "JO" is a name of the group, "Joined" is not
const jo = { id: 3, name: 'jo', 'original-name': 'JO' };
const SHORT_ALIAS_BLOCKS = [block(14, 52, 'Joined the call late'), block(15, 52, 'Notes from JO, then lunch')];

function fakeClient(opts: { aliasError?: Error; pages?: unknown[]; shortAlias?: boolean } = {}) {
  const group = opts.shortAlias ? [jordan, jordanRivera, jo] : [jordan, jordanRivera];
  const blocks = opts.shortAlias ? [...BLOCKS, ...SHORT_ALIAS_BLOCKS] : BLOCKS;
  const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
    if (query.includes('?alias-mid')) {
      if (opts.aliasError) throw opts.aliasError;
      const start = group.find(p => p.name === inputs[0]);
      return start ? group.map(p => [start, p]) : [];
    }
    if (query.includes(':block/page ?page')) return blocks.map(b => [b]);
    return (opts.pages ?? PAGES).map(p => [p]);
  });
  return { client: { executeDatalogQuery } as unknown as LogseqClient, executeDatalogQuery };
}

const range = { startDate: 20250101, endDate: 20250103 };
const ids = (result: any) =>
  result.entries.flatMap((e: any) => e.blocks.map((b: any) => b.id)).sort((a: number, b: number) => a - b);

describe('query_by_date_range search_term across an alias group (#69)', () => {
  it('finds blocks written under either name, and blocks that only reference the page', async () => {
    const { client } = fakeClient();

    const result = await queryJournals(client, { ...range, searchTerm: 'Jordan Rivera' });

    expect(ids(result)).toEqual([10, 11, 12]);
  });

  it('matches the other names as whole words only, so a short alias does not match inside a word', async () => {
    const result = await queryJournals(fakeClient({ shortAlias: true }).client, { ...range, searchTerm: 'Jordan' });

    expect(ids(result)).toEqual([10, 11, 12, 15]); // not 14, "Joined"
  });

  it('still matches the term itself inside a word, as without aliases', async () => {
    const result = await queryJournals(fakeClient({ shortAlias: true }).client, { ...range, searchTerm: 'JO' });

    expect(ids(result)).toEqual([10, 11, 12, 14, 15]);
  });

  it('gives the same blocks for the alias and the canonical name', async () => {
    const byName = await queryJournals(fakeClient().client, { ...range, searchTerm: 'Jordan' });
    const byAlias = await queryJournals(fakeClient().client, { ...range, searchTerm: 'Jordan Rivera' });

    expect(ids(byAlias)).toEqual(ids(byName));
    expect((byAlias as any).resolvedAliases).toEqual(['Jordan', 'Jordan Rivera']);
    expect((byName as any).resolvedAliases).toEqual(['Jordan', 'Jordan Rivera']);
  });

  it('reports the names covered in full, slim and outline results', async () => {
    const full: any = await queryJournals(fakeClient().client, { ...range, searchTerm: 'Jordan' });
    const slim: any = await queryJournals(fakeClient().client, { ...range, searchTerm: 'Jordan', slimResults: true });
    const outline: any = await queryJournals(fakeClient().client, { ...range, searchTerm: 'Jordan', includeContent: false });

    for (const result of [full, slim, outline]) {
      expect(result.resolvedAliases).toEqual(['Jordan', 'Jordan Rivera']);
    }
  });

  it('adds one query when searching, and none without a search term', async () => {
    const searching = fakeClient();
    await queryJournals(searching.client, { ...range, searchTerm: 'Jordan' });
    expect(searching.executeDatalogQuery).toHaveBeenCalledTimes(3); // journals, blocks, alias group

    const plain = fakeClient();
    const result: any = await queryJournals(plain.client, range);
    expect(plain.executeDatalogQuery).toHaveBeenCalledTimes(2);
    expect(result).not.toHaveProperty('resolvedAliases');
  });

  it('keeps matching literally when the term is not a page name', async () => {
    const { client } = fakeClient();

    const result: any = await queryJournals(client, { ...range, searchTerm: 'lunch' });

    expect(ids(result)).toEqual([13]);
    expect(result).not.toHaveProperty('resolvedAliases');
  });

  it('skips the alias lookup when no journal page is in range', async () => {
    const { client, executeDatalogQuery } = fakeClient({ pages: [] });

    const result: any = await queryJournals(client, { ...range, searchTerm: 'Jordan' });

    expect(result.entries).toEqual([]);
    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed alias lookup instead of searching under one name', async () => {
    const { client } = fakeClient({ aliasError: new LogSeqTimeoutError('http://127.0.0.1:12315', 30000) });

    await expect(queryJournals(client, { ...range, searchTerm: 'Jordan' })).rejects.toBeInstanceOf(
      LogSeqTimeoutError
    );
  });
});
