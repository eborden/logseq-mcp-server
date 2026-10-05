import { describe, it, expect, vi } from 'vitest';
import {
  ambiguousPageResult,
  isoDateToJournalDay,
  requirePage,
  resolvePage,
  resolvedFrom,
  suggestPages,
  MAX_CANDIDATES
} from './resolve-page.js';
import { LogseqClient } from '../client.js';
import {
  AmbiguousPageError,
  LogSeqAuthError,
  LogSeqNotRunningError,
  LogSeqTimeoutError,
  PageNotFoundError
} from '../errors.js';

const page = (id: number, name: string, originalName: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  'original-name': originalName,
  file: { id: 900 + id },
  ...extra
});
/** A page LogSeq created because something aliases or links to it: no file, no blocks. */
const stub = (id: number, name: string, originalName: string) => page(id, name, originalName, { file: undefined });

/**
 * Fake client: the resolve query returns `resolveRows`, the namespace-leaf
 * query returns `leafRows`, and the Editor API's page list is `allPages`.
 */
function fakeClient(
  opts: { resolveRows?: unknown[]; leafRows?: unknown[]; allPages?: unknown[] } = {}
) {
  const executeDatalogQuery = vi.fn(async (query: string) => {
    if (query.includes(':in $ ?suffix')) return opts.leafRows ?? [];
    if (query.includes(':in $ ?n')) return opts.resolveRows ?? [];
    throw new Error(`unexpected query: ${query}`);
  });
  const callAPI = vi.fn(async () => opts.allPages ?? []);
  return { client: { executeDatalogQuery, callAPI } as unknown as LogseqClient, executeDatalogQuery, callAPI };
}

describe('isoDateToJournalDay', () => {
  it.each([
    ['2025-01-01', 20250101],
    ['2024-02-29', 20240229],
    [' 2025-12-31 ', 20251231]
  ])('turns %s into %i', (input, expected) => {
    expect(isoDateToJournalDay(input)).toBe(expected);
  });

  it.each(['2025-02-30', '2023-02-29', '2025-13-01', '2025-00-10', '2025-1-1', '20250101', 'jan 1st, 2025', ''])(
    'rejects %j',
    input => {
      expect(isoDateToJournalDay(input)).toBeNull();
    }
  );
});

describe('resolvePage', () => {
  it('resolves an exact name in one query', async () => {
    const { client, executeDatalogQuery, callAPI } = fakeClient({ resolveRows: [[page(1, 'alice', 'Alice'), 'name']] });

    const result = await resolvePage(client, 'Alice');

    expect(result).toMatchObject({ kind: 'found', name: 'alice', originalName: 'Alice', matchedBy: 'name', lookupName: 'Alice' });
    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    expect(executeDatalogQuery.mock.calls[0].slice(1)).toEqual(['alice']);
    expect(callAPI).not.toHaveBeenCalled();
  });

  it('trims the name', async () => {
    const { client, executeDatalogQuery } = fakeClient({ resolveRows: [[page(1, 'alice', 'Alice'), 'name']] });

    await resolvePage(client, '  Alice ');

    expect(executeDatalogQuery.mock.calls[0].slice(1)).toEqual(['alice']);
  });

  it('accepts a row without a "via" as an exact match', async () => {
    const { client } = fakeClient({ resolveRows: [[page(1, 'alice', 'Alice')]] });

    expect(await resolvePage(client, 'alice')).toMatchObject({ kind: 'found', matchedBy: 'name' });
  });

  describe('aliases', () => {
    it('resolves a bare alias stub to the one page that declares the alias', async () => {
      const { client, executeDatalogQuery } = fakeClient({
        resolveRows: [
          [stub(2, 'bob', 'Bob'), 'name'],
          [page(1, 'robert smith', 'Robert Smith'), 'alias']
        ]
      });

      const result = await resolvePage(client, 'bob');

      expect(result).toMatchObject({
        kind: 'found',
        name: 'robert smith',
        originalName: 'Robert Smith',
        matchedBy: 'alias',
        lookupName: 'robert smith'
      });
      expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    });

    it('ignores the other stubs of a group of three or more: only the page with a file declares the name (#69)', async () => {
      // `alias:: bob, rob` on one page: stubs "bob" and "rob" point at each other as well as at the page
      const { client } = fakeClient({
        resolveRows: [
          [stub(3, 'bob', 'Bob'), 'name'],
          [page(1, 'robert smith', 'Robert Smith'), 'alias'],
          [stub(4, 'rob', 'Rob'), 'alias']
        ]
      });

      const result = await resolvePage(client, 'Bob');

      expect(result).toMatchObject({ kind: 'found', name: 'robert smith', matchedBy: 'alias' });
    });

    it('is ambiguous when several pages declare the alias, listing why each matched', async () => {
      const { client } = fakeClient({
        resolveRows: [
          [stub(3, 'bob', 'Bob'), 'name'],
          [page(2, 'robert jones', 'Robert Jones'), 'alias'],
          [page(1, 'robert smith', 'Robert Smith'), 'alias']
        ]
      });

      const result = await resolvePage(client, 'Bob');

      expect(result).toEqual({
        kind: 'ambiguous',
        totalCandidates: 2,
        candidates: [
          { name: 'robert jones', originalName: 'Robert Jones', matchedBy: 'alias', reason: 'declares alias "Bob"' },
          { name: 'robert smith', originalName: 'Robert Smith', matchedBy: 'alias', reason: 'declares alias "Bob"' }
        ]
      });
    });

    it('lets a real page (one with a file) keep its own name even when other pages alias it', async () => {
      const { client } = fakeClient({
        resolveRows: [
          [page(1, 'alice', 'Alice'), 'name'],
          [page(2, 'ally', 'Ally'), 'alias'],
          [page(3, 'al', 'Al'), 'alias']
        ]
      });

      expect(await resolvePage(client, 'alice')).toMatchObject({ kind: 'found', name: 'alice', matchedBy: 'name' });
    });

    it('ignores a page that lists itself as an alias', async () => {
      const { client } = fakeClient({
        resolveRows: [
          [stub(2, 'bob', 'Bob'), 'name'],
          [stub(2, 'bob', 'Bob'), 'alias'],
          [page(1, 'robert smith', 'Robert Smith'), 'alias']
        ]
      });

      expect(await resolvePage(client, 'bob')).toMatchObject({ kind: 'found', name: 'robert smith' });
    });

    it('lists a page once even if two rows carry it', async () => {
      const { client } = fakeClient({
        resolveRows: [
          [stub(3, 'bob', 'Bob'), 'name'],
          [page(1, 'robert smith', 'Robert Smith'), 'alias'],
          [page(1, 'robert smith', 'Robert Smith'), 'alias']
        ]
      });

      expect(await resolvePage(client, 'bob')).toMatchObject({ kind: 'found', name: 'robert smith' });
    });

    it('caps the candidate list but reports the real total', async () => {
      const sources = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => [
        page(10 + i, `page ${String(i).padStart(2, '0')}`, `Page ${i}`),
        'alias'
      ]);
      const { client } = fakeClient({ resolveRows: [[stub(2, 'bob', 'Bob'), 'name'], ...sources] });

      const result = await resolvePage(client, 'bob');

      expect(result).toMatchObject({ kind: 'ambiguous', totalCandidates: MAX_CANDIDATES + 5 });
      expect((result as any).candidates).toHaveLength(MAX_CANDIDATES);
    });
  });

  describe('ISO dates', () => {
    it('queries by journal day and resolves the journal page', async () => {
      const journal = page(5, 'jan 1st, 2025', 'Jan 1st, 2025', { 'journal-day': 20250101 });
      const { client, executeDatalogQuery } = fakeClient({ resolveRows: [[journal, 'journal-date']] });

      const result = await resolvePage(client, '2025-01-01');

      expect(executeDatalogQuery.mock.calls[0][0]).toContain(':in $ ?n ?day');
      expect(executeDatalogQuery.mock.calls[0].slice(1)).toEqual(['2025-01-01', 20250101]);
      expect(result).toMatchObject({ kind: 'found', matchedBy: 'journal-date', name: 'jan 1st, 2025', lookupName: 'jan 1st, 2025' });
      expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    });

    it('prefers a page literally named like the date', async () => {
      const { client } = fakeClient({
        resolveRows: [
          [page(1, '2025-01-01', '2025-01-01'), 'name'],
          [page(5, 'jan 1st, 2025', 'Jan 1st, 2025'), 'journal-date']
        ]
      });

      expect(await resolvePage(client, '2025-01-01')).toMatchObject({ matchedBy: 'name', name: '2025-01-01' });
    });

    it('prefers the journal over a file-less stub that only has the date as its name', async () => {
      // `[[2025-01-01]]` or `date:: 2025-01-01` in a graph with another journal title format
      const { client } = fakeClient({
        resolveRows: [
          [stub(1, '2025-01-01', '2025-01-01'), 'name'],
          [page(5, 'jan 1st, 2025', 'Jan 1st, 2025'), 'journal-date']
        ]
      });

      expect(await resolvePage(client, '2025-01-01')).toMatchObject({
        kind: 'found',
        matchedBy: 'journal-date',
        name: 'jan 1st, 2025',
        lookupName: 'jan 1st, 2025'
      });
    });

    it('keeps the stub when no journal exists for the day', async () => {
      const { client } = fakeClient({ resolveRows: [[stub(1, '2025-01-01', '2025-01-01'), 'name']] });

      expect(await resolvePage(client, '2025-01-01')).toMatchObject({ matchedBy: 'name', name: '2025-01-01' });
    });

    it('does not mistake the journal for a different page when it is itself named like the date', async () => {
      // yyyy-MM-dd journal titles: one page matches by name and by journal-day
      const journal = stub(7, '2025-01-01', '2025-01-01');
      const { client } = fakeClient({
        resolveRows: [
          [journal, 'name'],
          [journal, 'journal-date']
        ]
      });

      expect(await resolvePage(client, '2025-01-01')).toMatchObject({ matchedBy: 'name', name: '2025-01-01' });
    });

    it('is not found when there is no journal for the day, without a namespace lookup', async () => {
      const { client, executeDatalogQuery } = fakeClient();

      expect(await resolvePage(client, '2025-01-01')).toEqual({ kind: 'not_found' });
      expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('namespace leaves', () => {
    it('is looked up only after every other route found nothing, with a "/leaf" suffix', async () => {
      const { client, executeDatalogQuery } = fakeClient({ leafRows: [[page(4, 'work/atlas', 'Work/Atlas')]] });

      const result = await resolvePage(client, 'Atlas');

      expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
      expect(executeDatalogQuery.mock.calls[1][0]).toContain(':in $ ?suffix');
      expect(executeDatalogQuery.mock.calls[1].slice(1)).toEqual(['/atlas']);
      expect(result).toMatchObject({ kind: 'found', matchedBy: 'namespace-leaf', name: 'work/atlas', lookupName: 'work/atlas' });
    });

    it('is ambiguous when several namespaces hold the leaf', async () => {
      const { client } = fakeClient({
        leafRows: [[page(4, 'work/atlas', 'Work/Atlas')], [page(3, 'home/atlas', 'Home/Atlas')]]
      });

      const result = await resolvePage(client, 'atlas');

      expect(result).toMatchObject({ kind: 'ambiguous', totalCandidates: 2 });
      expect((result as any).candidates.map((c: any) => [c.name, c.matchedBy])).toEqual([
        ['home/atlas', 'namespace-leaf'],
        ['work/atlas', 'namespace-leaf']
      ]);
    });

    it('is never used when an exact name or alias matched', async () => {
      const { client, executeDatalogQuery } = fakeClient({ resolveRows: [[page(1, 'atlas', 'Atlas'), 'name']] });

      await resolvePage(client, 'atlas');

      expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    });
  });

  it('is not found when no route matches, and treats null results as empty', async () => {
    const executeDatalogQuery = vi.fn().mockResolvedValue(null);
    const client = { executeDatalogQuery, callAPI: vi.fn() } as unknown as LogseqClient;

    expect(await resolvePage(client, 'nope')).toEqual({ kind: 'not_found' });
    expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
  });

  it('is deterministic whatever order the rows arrive in', async () => {
    const rowsA = [[stub(3, 'bob', 'Bob'), 'name'], [page(2, 'b page', 'B Page'), 'alias'], [page(1, 'a page', 'A Page'), 'alias']];
    const rowsB = [...rowsA].reverse();

    const a = await resolvePage(fakeClient({ resolveRows: rowsA }).client, 'bob');
    const b = await resolvePage(fakeClient({ resolveRows: rowsB }).client, 'bob');

    expect(a).toEqual(b);
  });

  describe('infrastructure errors', () => {
    const errors: Array<[string, () => Error]> = [
      ['LogSeqNotRunningError', () => new LogSeqNotRunningError('http://test')],
      ['LogSeqTimeoutError', () => new LogSeqTimeoutError('http://test', 1000)],
      ['LogSeqAuthError', () => new LogSeqAuthError('http://test')]
    ];

    it.each(errors)('propagates %s from the resolve query', async (_name, makeError) => {
      const error = makeError();
      const client = { executeDatalogQuery: vi.fn().mockRejectedValue(error), callAPI: vi.fn() } as unknown as LogseqClient;

      await expect(resolvePage(client, 'x')).rejects.toBe(error);
    });

    it.each(errors)('propagates %s from the namespace-leaf query', async (_name, makeError) => {
      const error = makeError();
      const executeDatalogQuery = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(error);
      const client = { executeDatalogQuery, callAPI: vi.fn() } as unknown as LogseqClient;

      await expect(resolvePage(client, 'x')).rejects.toBe(error);
    });

    it.each(errors)('propagates %s from the suggestion lookup instead of reporting page not found', async (_name, makeError) => {
      const error = makeError();
      const client = {
        executeDatalogQuery: vi.fn().mockResolvedValue([]),
        callAPI: vi.fn().mockRejectedValue(error)
      } as unknown as LogseqClient;

      await expect(requirePage(client, 'x')).rejects.toBe(error);
    });
  });
});

describe('requirePage', () => {
  it('returns the resolved page', async () => {
    const { client } = fakeClient({ resolveRows: [[page(1, 'alice', 'Alice'), 'name']] });

    expect(await requirePage(client, 'alice')).toMatchObject({ name: 'alice', matchedBy: 'name' });
  });

  it('throws AmbiguousPageError carrying the candidates and a message that names them', async () => {
    const { client, callAPI } = fakeClient({
      resolveRows: [[stub(3, 'bob', 'Bob'), 'name'], [page(2, 'robert jones', 'Robert Jones'), 'alias'], [page(1, 'robert smith', 'Robert Smith'), 'alias']]
    });

    const error = await requirePage(client, 'Bob').catch(e => e);

    expect(error).toBeInstanceOf(AmbiguousPageError);
    expect(error.candidates).toHaveLength(2);
    expect(error.message).toContain('matches 2 pages');
    expect(error.message).toContain('"Robert Jones"');
    expect(error.message).toContain('"Robert Smith"');
    expect(callAPI).not.toHaveBeenCalled();
  });

  it('throws PageNotFoundError with the closest names', async () => {
    const { client } = fakeClient({
      allPages: [
        { originalName: 'Project Atlas' },
        { originalName: 'Project Apollo' },
        { originalName: 'Groceries' }
      ]
    });

    const error = await requirePage(client, 'proj atlas').catch(e => e);

    expect(error).toBeInstanceOf(PageNotFoundError);
    expect(error.suggestions[0]).toBe('Project Atlas');
    expect(error.message).toMatch(/^No page "proj atlas"\. Closest: Project Atlas/);
    expect(error.message).toContain('logseq_search_blocks');
    expect(error.message).toContain('logseq_list_pages');
  });
});

describe('suggestPages', () => {
  it('returns at most three names', async () => {
    const { client } = fakeClient({ allPages: ['a1', 'a2', 'a3', 'a4', 'a5'].map(n => ({ originalName: `Atlas ${n}` })) });

    expect(await suggestPages(client, 'atlas')).toHaveLength(3);
  });

  it('is empty, and makes no call, for an ISO date', async () => {
    const { client, callAPI } = fakeClient();

    expect(await suggestPages(client, '2025-01-01')).toEqual([]);
    expect(callAPI).not.toHaveBeenCalled();
  });
});

describe('result helpers', () => {
  it('resolvedFrom is empty for an exact match', () => {
    expect(resolvedFrom('x', { matchedBy: 'name' } as any)).toEqual({});
  });

  it('resolvedFrom reports how another route matched', () => {
    expect(resolvedFrom('x', { matchedBy: 'alias', originalName: 'Y' } as any)).toEqual({
      resolvedFrom: { name: 'x', matchedBy: 'alias', resolvedTo: 'Y' }
    });
  });

  it('ambiguousPageResult has hasMore false and a single warning when every candidate is listed', () => {
    const candidates = [
      { name: 'a', originalName: 'A', matchedBy: 'alias' as const, reason: 'declares alias "x"' },
      { name: 'b', originalName: 'B', matchedBy: 'alias' as const, reason: 'declares alias "x"' }
    ];
    const result = ambiguousPageResult(new AmbiguousPageError('x', candidates));

    expect(result).toMatchObject({
      ambiguous: true,
      pageName: 'x',
      candidates,
      totalCandidates: 2,
      hasMore: false,
      totals: { candidates: 2 }
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe('ambiguous_page');
    expect(result.warnings[0].howToFetchAll).toBeUndefined();
    expect(result.warnings[0].message).not.toContain('logseq_list_pages');
  });

  it('ambiguousPageResult warns that the list was cut, with the real count and how to narrow it', () => {
    const candidates = Array.from({ length: MAX_CANDIDATES }, (_, i) => ({
      name: `p${i}`,
      originalName: `P${i}`,
      matchedBy: 'namespace-leaf' as const,
      reason: 'namespace page'
    }));
    const result = ambiguousPageResult(new AmbiguousPageError('x', candidates, MAX_CANDIDATES + 5));

    expect(result.totalCandidates).toBe(MAX_CANDIDATES + 5);
    expect(result.totals).toEqual({ candidates: MAX_CANDIDATES + 5 });
    // A hard maximum: no parameter fetches the rest, so hasMore stays false and the warning is the signal
    expect(result.hasMore).toBe(false);
    expect(result.warnings.map(w => w.code)).toEqual(['ambiguous_page', 'candidates_truncated']);
    expect(result.warnings.every(w => w.howToFetchAll === undefined)).toBe(true);
    const note = result.warnings[1].message;
    expect(note).toContain(`Showing ${MAX_CANDIDATES} of ${MAX_CANDIDATES + 5}`);
    expect(note).toContain("can't be fetched in one call");
    expect(note).toContain('logseq_list_pages');
    expect(note).toContain('name_contains');
    expect(result.warnings[0].message).toContain('and 5 more');
    expect(result.warnings[0].message).toContain('logseq_list_pages');
  });
});
