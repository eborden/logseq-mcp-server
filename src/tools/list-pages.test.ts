import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DEFAULT_LIST_PAGES_LIMIT,
  DEFAULT_LIST_PAGES_OFFSET,
  MAX_LIST_PAGES_LIMIT,
  listPages,
} from './list-pages.js';
import { LogseqClient } from '../client.js';
import { PageEntity } from '../types.js';

describe('listPages', () => {
  let mockClient: LogseqClient;

  beforeEach(() => {
    mockClient = {
      callAPI: vi.fn(),
    } as any;
  });

  it('should return pages as { name } objects, with no aliases key', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'u1', name: 'alpha', originalName: 'Alpha' },
      { id: 2, uuid: 'u2', name: 'beta', originalName: 'Beta' },
    ];
    (mockClient.callAPI as any).mockResolvedValue(mockPages);

    const result = await listPages(mockClient);

    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getAllPages');
    expect(result.pages).toEqual([{ name: 'Alpha' }, { name: 'Beta' }]);
    expect(result.total).toBe(2);
  });

  it('should exclude journal pages', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'u1', name: 'project', originalName: 'Project' },
      { id: 2, uuid: 'u2', name: 'nov 15th, 2025', originalName: 'Nov 15th, 2025', 'journal?': true },
      { id: 3, uuid: 'u3', name: 'dec 1st, 2025', originalName: 'Dec 1st, 2025', journal: true },
    ];
    (mockClient.callAPI as any).mockResolvedValue(mockPages);

    const result = await listPages(mockClient);

    expect(result.pages).toEqual([{ name: 'Project' }]);
    expect(result.total).toBe(1);
  });

  it('should filter by name case-insensitively', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'u1', name: 'engineering', originalName: 'Engineering' },
      { id: 2, uuid: 'u2', name: 'experiment', originalName: 'Experiment' },
      { id: 3, uuid: 'u3', name: 'project', originalName: 'Project' },
    ];
    (mockClient.callAPI as any).mockResolvedValue(mockPages);

    const result = await listPages(mockClient, { nameContains: 'EXP' });

    expect(result.pages).toEqual([{ name: 'Experiment' }]);
  });

  // #64: null is not an empty graph. The list stays empty (backward compatible)
  // and a ResultMeta warning says LogSeq returned no page list.
  describe('when getAllPages returns null (#64)', () => {
    const warning = {
      code: 'pages_unavailable',
      message: expect.stringContaining('LogSeq returned no page list'),
    };

    it('returns an empty list plus a pages_unavailable warning', async () => {
      (mockClient.callAPI as any).mockResolvedValue(null);

      const result = await listPages(mockClient);

      expect(result).toEqual({ pages: [], total: 0, hasMore: false, warnings: [warning] });
      expect(mockClient.callAPI).toHaveBeenCalledTimes(1);
      expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getAllPages');
    });

    it('tells the caller the empty list may be wrong and how to check', async () => {
      (mockClient.callAPI as any).mockResolvedValue(null);

      const [w] = (await listPages(mockClient)).warnings!;

      expect(w.message).toContain('may not mean the graph is empty');
      expect(w.message).toContain('logseq_get_graph_info');
      expect(w.message).toMatch(/retry/i);
    });

    it('keeps hasMore false: nothing can be fetched by raising a parameter', async () => {
      (mockClient.callAPI as any).mockResolvedValue(null);

      const result = await listPages(mockClient);

      expect(result.hasMore).toBe(false);
      expect(result.warnings![0].howToFetchAll).toBeUndefined();
    });

    it('returns the same empty list and warning when a name filter is given', async () => {
      (mockClient.callAPI as any).mockResolvedValue(null);

      const result = await listPages(mockClient, { nameContains: 'anything' });

      expect(result).toEqual({ pages: [], total: 0, hasMore: false, warnings: [warning] });
    });
  });

  describe('when getAllPages returns an empty array (a genuinely empty graph)', () => {
    it('returns an empty list with no warning and no meta fields', async () => {
      (mockClient.callAPI as any).mockResolvedValue([]);

      const result = await listPages(mockClient);

      expect(result).toEqual({ pages: [], total: 0 });
      expect(result).not.toHaveProperty('warnings');
      expect(result).not.toHaveProperty('hasMore');
    });

    it('adds no warning when every page is a journal or filtered out', async () => {
      (mockClient.callAPI as any).mockResolvedValue([
        { id: 1, uuid: 'u1', name: 'jan 1st, 2025', originalName: 'Jan 1st, 2025', 'journal?': true },
        { id: 2, uuid: 'u2', name: 'alpha', originalName: 'Alpha' },
      ]);

      const result = await listPages(mockClient, { nameContains: 'zzz' });

      expect(result).toEqual({ pages: [], total: 0 });
    });
  });

  it('should propagate API errors', async () => {
    (mockClient.callAPI as any).mockRejectedValue(new Error('API error'));

    await expect(listPages(mockClient)).rejects.toThrow('API error');
  });

  it('should return pages sorted alphabetically', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'u1', name: 'zebra', originalName: 'Zebra' },
      { id: 2, uuid: 'u2', name: 'alpha', originalName: 'Alpha' },
    ];
    (mockClient.callAPI as any).mockResolvedValue(mockPages);

    const result = await listPages(mockClient);

    expect(result.pages).toEqual([{ name: 'Alpha' }, { name: 'Zebra' }]);
  });

  it('should sort by lowercase name but return original casing', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'u1', name: 'api', originalName: 'API' },
      { id: 2, uuid: 'u2', name: 'apple', originalName: 'Apple' },
      { id: 3, uuid: 'u3', name: 'aaa', originalName: 'AAA' },
    ];
    (mockClient.callAPI as any).mockResolvedValue(mockPages);

    const result = await listPages(mockClient);

    // Sorted by lowercase: aaa, api, apple
    // Returns original casing: AAA, API, Apple
    expect(result.pages).toEqual([{ name: 'AAA' }, { name: 'API' }, { name: 'Apple' }]);
  });

  // #61: a default cap of 200, a maximum of 1000, and offset to page past them
  describe('limit and offset (#61)', () => {
    /** `n` non-journal pages named p0000, p0001, ... so name order is index order. */
    const graph = (n: number): PageEntity[] =>
      Array.from({ length: n }, (_, i) => {
        const name = `p${String(i).padStart(4, '0')}`;
        return { id: i + 1, uuid: `u${i}`, name, originalName: name.toUpperCase() };
      });
    const names = (from: number, to: number) => graph(to).slice(from).map(p => ({ name: p.originalName }));
    const nameOnly = (pages: Array<{ name: string }>) => pages.map(p => p.name);
    const list = (n: number, options: Parameters<typeof listPages>[1] = {}) => {
      (mockClient.callAPI as any).mockResolvedValue(graph(n));
      return listPages(mockClient, options);
    };

    it('exports the default, the maximum and the default offset', () => {
      expect(DEFAULT_LIST_PAGES_LIMIT).toBe(200);
      expect(MAX_LIST_PAGES_LIMIT).toBe(1000);
      expect(DEFAULT_LIST_PAGES_OFFSET).toBe(0);
    });

    it('is unchanged when 200 or fewer pages match: every page, no meta fields', async () => {
      for (const n of [0, 1, 199, 200]) {
        const result = await list(n);
        expect(result, `${n} pages`).toEqual({ pages: names(0, n), total: n });
      }
    });

    it('cuts at 200 by default and names both ways to get the rest', async () => {
      const result = await list(500);

      expect(result).toEqual({
        pages: names(0, 200),
        total: 500,
        hasMore: true,
        warnings: [
          {
            code: 'pages_truncated',
            message: 'Showing 200 of 500 pages.',
            howToFetchAll: 'Set limit to 500 (or higher) to get all 500. Set offset to 200 for the next page.',
          },
        ],
      });
    });

    it('keeps total as the count of every matching page, not the page returned', async () => {
      const result = await list(1500, { limit: 10, offset: 700 });

      expect(result.pages).toEqual(names(700, 710));
      expect(result.total).toBe(1500);
    });

    it('counts total after the name filter, before offset and limit', async () => {
      (mockClient.callAPI as any).mockResolvedValue([
        ...graph(300),
        { id: 9001, uuid: 'j', name: 'jan 1st, 2025', originalName: 'Jan 1st, 2025', 'journal?': true },
        { id: 9002, uuid: 'x', name: 'other', originalName: 'Other' },
      ]);

      const result = await listPages(mockClient, { nameContains: 'P0', limit: 50 });

      expect(result.total).toBe(300);
      expect(result.pages).toEqual(names(0, 50));
      expect(result.warnings![0].message).toBe('Showing 50 of 300 pages.');
    });

    it('returns the page at offset, and no warning once nothing is left after it', async () => {
      expect(await list(500, { offset: 400 })).toEqual({ pages: names(400, 500), total: 500 });
      expect(await list(500, { offset: 300, limit: 200 })).toEqual({ pages: names(300, 500), total: 500 });
    });

    it('counts the warning from offset when pages remain after the page returned', async () => {
      const [w] = (await list(500, { offset: 100, limit: 50 })).warnings!;

      expect(w).toEqual({
        code: 'pages_truncated',
        message: 'Showing 50 of 400 pages from offset 100.',
        howToFetchAll: 'Set limit to 400 (or higher) to get all 400. Set offset to 150 for the next page.',
      });
    });

    it('returns no pages and no warning for an offset past the end, with the real total', async () => {
      expect(await list(30, { offset: 30 })).toEqual({ pages: [], total: 30 });
      expect(await list(30, { offset: 5000 })).toEqual({ pages: [], total: 30 });
    });

    it('suggests the maximum, never a value past it, when more than 1000 remain', async () => {
      const result = await list(1500);

      expect(result.pages).toHaveLength(200);
      expect(result.hasMore).toBe(true);
      expect(result.warnings).toEqual([
        {
          code: 'pages_truncated',
          message: 'Showing 200 of 1500 pages.',
          howToFetchAll: 'Set limit to 1000 (the maximum) to get 1000 of 1500. Set offset to 200 for the next page.',
        },
      ]);
    });

    it('keeps hasMore true at the maximum: the next offset fetches the rest', async () => {
      const result = await list(1500, { limit: 1000 });

      expect(result.pages).toEqual(names(0, 1000));
      expect(result.hasMore).toBe(true);
      expect(result.warnings).toEqual([
        {
          code: 'pages_truncated',
          message: 'Showing 1000 of 1500 pages: limit is capped at its maximum of 1000.',
          howToFetchAll: 'Set offset to 1000 for the next page.',
        },
      ]);
    });

    it('clamps a limit above the maximum to 1000 and names the value asked for', async () => {
      const result = await list(2500, { limit: 5000, offset: 1000 });

      expect(result.pages).toEqual(names(1000, 2000));
      expect(result.total).toBe(2500);
      expect(result.warnings).toEqual([
        {
          code: 'pages_truncated',
          message: 'Showing 1000 of 1500 pages from offset 1000: limit is capped at its maximum of 1000 (5000 was asked for).',
          howToFetchAll: 'Set offset to 2000 for the next page.',
        },
      ]);
    });

    it('returns the same pages for any limit at or above the maximum', async () => {
      const at1000 = await list(1200, { limit: 1000 });
      const at5000 = await list(1200, { limit: 5000 });

      expect(at5000.pages).toEqual(at1000.pages);
      expect(at5000.pages).toHaveLength(MAX_LIST_PAGES_LIMIT);
      expect(at5000.hasMore).toBe(true);
    });

    it('adds no warning above the maximum when every remaining page fits', async () => {
      expect(await list(1000, { limit: 5000 })).toEqual({ pages: names(0, 1000), total: 1000 });
      expect(await list(1500, { limit: 5000, offset: 500 })).toEqual({ pages: names(500, 1500), total: 1500 });
    });

    it('never suggests a limit past the maximum, and always names the next offset', async () => {
      for (const [n, limit, offset] of [
        [201, undefined, 0],
        [999, 10, 0],
        [1001, undefined, 0],
        [5000, 999, 0],
        [5000, 1000, 0],
        [5000, 20_000, 3000],
        [1300, 100, 250],
      ] as const) {
        const result = await list(n, { limit, offset });
        const [w] = result.warnings!;
        const label = `${n} pages, limit ${limit}, offset ${offset}`;
        for (const m of w.howToFetchAll!.matchAll(/Set limit to (\d+)/g)) {
          expect(Number(m[1]), label).toBeLessThanOrEqual(MAX_LIST_PAGES_LIMIT);
        }
        expect(w.howToFetchAll, label).toContain(`offset to ${offset + result.pages.length} for the next page`);
        expect(result.hasMore, label).toBe(true);
      }
    });

    it('pages through the whole list with the offset each warning names', async () => {
      (mockClient.callAPI as any).mockResolvedValue(graph(2345));
      const seen: Array<{ name: string }> = [];
      let offset = 0;
      for (let calls = 0; calls < 10; calls++) {
        const result = await listPages(mockClient, { limit: 5000, offset });
        seen.push(...result.pages);
        if (!result.hasMore) break;
        offset = Number(result.warnings![0].howToFetchAll!.match(/Set offset to (\d+)/)![1]);
      }
      expect(seen).toEqual(names(0, 2345));
      expect(mockClient.callAPI).toHaveBeenCalledTimes(3);
    });

    it('keeps total constant at every offset for a fixed page list, and the pages add up to it', async () => {
      const all = graph(1494);
      (mockClient.callAPI as any).mockResolvedValue(all);
      for (const limit of [1, 7, 200, 999, 1000]) {
        const seen: Array<{ name: string }> = [];
        for (let offset = 0; offset < all.length + limit; offset += limit) {
          const result = await listPages(mockClient, { limit, offset });
          expect(result.total, `limit ${limit}, offset ${offset}`).toBe(1494);
          seen.push(...result.pages);
        }
        expect(seen.length, `limit ${limit}: no duplicates or gaps`).toBe(1494);
        expect(new Set(nameOnly(seen)).size, `limit ${limit}: no duplicates`).toBe(1494);
        expect(seen, `limit ${limit}: every page, in order`).toEqual(names(0, 1494));
      }
    });

    it('treats limit 0 as a count: no pages, the total, and no next offset that would not move', async () => {
      const result = await list(50, { limit: 0 });

      expect(result.pages).toEqual([]);
      expect(result.total).toBe(50);
      expect(result.warnings).toEqual([
        {
          code: 'pages_truncated',
          message: 'Showing 0 of 50 pages.',
          howToFetchAll: 'Set limit to 50 (or higher) to get all 50.',
        },
      ]);
      expect((await list(1500, { limit: 0 })).warnings![0].howToFetchAll).toBe(
        'Set limit to 1000 (the maximum) to get 1000 of 1500. Narrow name_contains to see the rest.'
      );
    });

    it('reads a negative limit as 0 and a negative offset as 0, and floors fractions', async () => {
      expect((await list(5, { limit: -3 })).pages).toEqual([]);
      expect(await list(5, { offset: -10 })).toEqual({ pages: names(0, 5), total: 5 });
      expect((await list(20, { limit: 2.9, offset: 3.7 })).pages).toEqual(names(3, 5));
    });

    it('orders names that localeCompare ties the same way whatever order getAllPages returns', async () => {
      const nfc = '\u00e9a'; // é as one code point
      const nfd = 'e\u0301a'; // e plus a combining accent
      const plain = 'ab';
      const zws = 'a\u200bb'; // a zero-width space
      expect(nfc.localeCompare(nfd)).toBe(0);
      expect(plain.localeCompare(zws)).toBe(0);
      const entities = [nfc, nfd, plain, zws].map((name, i) => ({ id: i + 1, uuid: `u${i}`, name, originalName: name }));

      const orders = [entities, [...entities].reverse(), [entities[1], entities[3], entities[0], entities[2]]];
      const listings: Array<Array<{ name: string }>> = [];
      for (const order of orders) {
        (mockClient.callAPI as any).mockResolvedValue(order);
        listings.push((await listPages(mockClient)).pages);
      }

      for (const pages of listings) expect(pages).toEqual(listings[0]);
      expect(new Set(nameOnly(listings[0]))).toEqual(new Set([nfc, nfd, plain, zws]));
      // Paging one name at a time visits each exactly once, even with the input order changing per call
      const paged: Array<{ name: string }> = [];
      for (let offset = 0; offset < 4; offset++) {
        (mockClient.callAPI as any).mockResolvedValue(orders[offset % orders.length]);
        paged.push(...(await listPages(mockClient, { limit: 1, offset })).pages);
      }
      expect(paged).toEqual(listings[0]);
    });

    it('makes one API call whatever the limit and offset', async () => {
      await list(5000, { limit: 1000, offset: 2000 });

      expect(mockClient.callAPI).toHaveBeenCalledTimes(1);
      expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getAllPages');
    });

    it('keeps the pages_unavailable warning alone for null, whatever limit and offset are', async () => {
      (mockClient.callAPI as any).mockResolvedValue(null);

      const result = await listPages(mockClient, { limit: 1, offset: 5 });

      expect(result.pages).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
      expect(result.warnings!.map(w => w.code)).toEqual(['pages_unavailable']);
    });
  });
});
