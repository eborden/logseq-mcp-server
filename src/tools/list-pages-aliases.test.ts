import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listPages } from './list-pages.js';
import { LogseqClient } from '../client.js';
import { PageEntity } from '../types.js';

/**
 * Aliases in the page list (#171). `getAllPages` carries `alias: [{ id }]` on
 * every page that has an `alias::` link, and `file: { id }` on pages that are
 * backed by a file. The names here are made up.
 */

let nextId = 1;
const ids = (...pages: PageEntity[]) => pages.map(p => ({ id: p.id }));

/** A page with a file: the one that wrote `alias::`. */
const written = (originalName: string, extra: Partial<PageEntity> = {}): PageEntity => {
  const id = nextId++;
  return { id, uuid: `u${id}`, name: originalName.toLowerCase(), originalName, file: { id: 1000 + id }, ...extra };
};

/** A stub: LogSeq made it for an alias name, and nothing wrote it. */
const stub = (originalName: string, extra: Partial<PageEntity> = {}): PageEntity => {
  const id = nextId++;
  return { id, uuid: `u${id}`, name: originalName.toLowerCase(), originalName, ...extra };
};

/** `alias:: ...stubs` on `page`, stored in both directions as LogSeq does. */
function declare(page: PageEntity, ...stubs: PageEntity[]) {
  page.alias = ids(...stubs);
  for (const s of stubs) s.alias = [...(s.alias ?? []), { id: page.id }];
}

/** The same group as a clique, as LogSeq keeps a group of three or more: every stub links every other. */
function declareClique(page: PageEntity, ...stubs: PageEntity[]) {
  declare(page, ...stubs);
  for (const s of stubs) s.alias = [...s.alias!, ...ids(...stubs.filter(other => other !== s))];
}

describe('listPages with aliases (#171)', () => {
  let mockClient: LogseqClient;
  const serve = (pages: PageEntity[] | null) => (mockClient.callAPI as any).mockResolvedValue(pages);

  beforeEach(() => {
    nextId = 1;
    mockClient = { callAPI: vi.fn() } as any;
  });

  describe('shape', () => {
    it('nests an alias under its page and leaves it out of the top level', async () => {
      const alex = written('Alex');
      const rivera = stub('Alex Rivera');
      declare(alex, rivera);
      serve([rivera, alex, written('Alexandra')]);

      const result = await listPages(mockClient);

      expect(result).toEqual({
        pages: [{ name: 'Alex', aliases: ['Alex Rivera'] }, { name: 'Alexandra' }],
        total: 2,
      });
    });

    it('leaves the aliases key off a page that has none', async () => {
      serve([written('Alice'), stub('Bob')]);

      const result = await listPages(mockClient);

      expect(result.pages).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
      for (const page of result.pages) expect(page).not.toHaveProperty('aliases');
    });

    it('keeps original casing and sorts aliases by name', async () => {
      const page = written('Project Atlas');
      const b = stub('B-side');
      const a = stub('ATLAS');
      const c = stub('c team');
      declare(page, b, c, a);
      serve([page, a, b, c]);

      expect((await listPages(mockClient)).pages).toEqual([
        { name: 'Project Atlas', aliases: ['ATLAS', 'B-side', 'c team'] },
      ]);
    });

    it('gives the same list whatever order getAllPages returns the pages in', async () => {
      const page = written('Alex');
      const x = stub('Xena');
      const y = stub('Yan');
      declare(page, x, y);
      const other = written('Zed');
      const all = [page, x, y, other];

      serve(all);
      const forward = await listPages(mockClient);
      serve([...all].reverse());
      const backward = await listPages(mockClient);

      expect(backward).toEqual(forward);
    });

    it('reads a link stored in one direction only, from either end', async () => {
      const fromPage = written('Declarer');
      const fromStub = written('Other');
      const s1 = stub('First stub');
      const s2 = stub('Second stub');
      fromPage.alias = ids(s1); // the stub does not link back
      s2.alias = ids(fromStub); // the page does not link to the stub
      serve([fromPage, fromStub, s1, s2]);

      expect((await listPages(mockClient)).pages).toEqual([
        { name: 'Declarer', aliases: ['First stub'] },
        { name: 'Other', aliases: ['Second stub'] },
      ]);
    });

    it('treats a page whose alias list is empty like a page without one', async () => {
      serve([written('Alice', { alias: [] })]);

      expect((await listPages(mockClient)).pages).toEqual([{ name: 'Alice' }]);
    });
  });

  describe('which page is canonical (the resolver\'s rule: the page with a file)', () => {
    it('nests every name of a clique of three or more under the declaring page', async () => {
      const page = written('Jordan');
      const s1 = stub('Jordan Rivera');
      const s2 = stub('J. Rivera');
      const s3 = stub('Jo');
      declareClique(page, s1, s2, s3);
      serve([s1, s2, s3, page]);

      const result = await listPages(mockClient);

      expect(result).toEqual({
        pages: [{ name: 'Jordan', aliases: ['J. Rivera', 'Jo', 'Jordan Rivera'] }],
        total: 1,
      });
    });

    it('does not list the page as an alias of itself, nor a stub twice, in a clique', async () => {
      const page = written('Jordan');
      const s1 = stub('Stub one');
      const s2 = stub('Stub two');
      declareClique(page, s1, s2);
      page.alias = [...page.alias!, { id: page.id }, { id: s1.id }]; // a self-link and a repeat
      serve([page, s1, s2]);

      expect((await listPages(mockClient)).pages).toEqual([{ name: 'Jordan', aliases: ['Stub one', 'Stub two'] }]);
    });

    it('lists a name two file-backed pages both declare under both, like the resolver\'s ambiguous alias', async () => {
      const borealis = written('Project Borealis');
      const cascade = written('Project Cascade');
      const shared = stub('Roadmap');
      declare(borealis, shared);
      declare(cascade, shared);
      serve([cascade, shared, borealis]);

      const result = await listPages(mockClient);

      expect(result).toEqual({
        pages: [
          { name: 'Project Borealis', aliases: ['Roadmap'] },
          { name: 'Project Cascade', aliases: ['Roadmap'] },
        ],
        total: 2,
      });
    });

    it('keeps two pages with files separate even when one declares the other', async () => {
      const a = written('Page A');
      const b = written('Page B');
      declare(a, b);
      serve([a, b]);

      expect(await listPages(mockClient)).toEqual({ pages: [{ name: 'Page A' }, { name: 'Page B' }], total: 2 });
    });

    it('keeps a stub that links no page with a file as a page of its own', async () => {
      const s1 = stub('Lonely one');
      const s2 = stub('Lonely two');
      s1.alias = ids(s2);
      s2.alias = ids(s1);
      serve([s1, s2]);

      expect(await listPages(mockClient)).toEqual({ pages: [{ name: 'Lonely one' }, { name: 'Lonely two' }], total: 2 });
    });

    it('ignores a link to a journal page, and a journal page that links out', async () => {
      const page = written('Alex');
      const day = stub('Jan 1st, 2025', { journal: true });
      const real = stub('Al');
      declare(page, day, real);
      serve([page, day, real]);

      expect((await listPages(mockClient)).pages).toEqual([{ name: 'Alex', aliases: ['Al'] }]);
    });

    it('ignores a link to a page the list does not hold', async () => {
      serve([written('Alex', { alias: [{ id: 99999 }] })]);

      expect((await listPages(mockClient)).pages).toEqual([{ name: 'Alex' }]);
    });
  });

  describe('name_contains', () => {
    const graph = () => {
      const alex = written('Alex');
      const rivera = stub('Alex Rivera');
      const lex = stub('Lexi');
      declare(alex, rivera, lex);
      const borealis = written('Project Borealis');
      const cascade = written('Project Cascade');
      const roadmap = stub('Roadmap');
      declare(borealis, roadmap);
      declare(cascade, roadmap);
      return [rivera, lex, alex, written('Alexandra'), borealis, cascade, roadmap, written('Zed')];
    };

    it('matches an alias and returns the canonical page with its full alias list', async () => {
      serve(graph());

      const result = await listPages(mockClient, { nameContains: 'rivera' });

      expect(result).toEqual({ pages: [{ name: 'Alex', aliases: ['Alex Rivera', 'Lexi'] }], total: 1 });
    });

    it('matches the alias case-insensitively', async () => {
      serve(graph());

      expect((await listPages(mockClient, { nameContains: 'LEXI' })).pages).toEqual([
        { name: 'Alex', aliases: ['Alex Rivera', 'Lexi'] },
      ]);
    });

    it('returns a page once when its name and several aliases all match', async () => {
      serve(graph());

      const result = await listPages(mockClient, { nameContains: 'ale' });

      expect(result.pages).toEqual([
        { name: 'Alex', aliases: ['Alex Rivera', 'Lexi'] },
        { name: 'Alexandra' },
      ]);
      expect(result.total).toBe(2);
    });

    it('returns every canonical page an ambiguous alias belongs to', async () => {
      serve(graph());

      const result = await listPages(mockClient, { nameContains: 'roadmap' });

      expect(result).toEqual({
        pages: [
          { name: 'Project Borealis', aliases: ['Roadmap'] },
          { name: 'Project Cascade', aliases: ['Roadmap'] },
        ],
        total: 2,
      });
    });

    it('matches a canonical name and still lists all its aliases, including ones that did not match', async () => {
      serve(graph());

      expect((await listPages(mockClient, { nameContains: 'alex' })).pages[0]).toEqual({
        name: 'Alex',
        aliases: ['Alex Rivera', 'Lexi'],
      });
    });

    it('does not list a matching stub on its own', async () => {
      serve(graph());

      const result = await listPages(mockClient, { nameContains: 'lexi' });

      expect(result.pages.map(p => p.name)).toEqual(['Alex']);
    });

    it('does not match the canonical page by the name of a journal alias', async () => {
      const page = written('Alex');
      const day = stub('Jan 1st, 2025', { journal: true });
      declare(page, day);
      serve([page, day]);

      expect((await listPages(mockClient, { nameContains: 'jan' })).pages).toEqual([]);
    });
  });

  describe('total, sort and paging', () => {
    /** Pages p00..p(n-1), each with two aliases whose names sort after every page name. */
    const withAliases = (n: number): PageEntity[] => {
      const all: PageEntity[] = [];
      for (let i = 0; i < n; i++) {
        const page = written(`p${String(i).padStart(2, '0')}`);
        const first = stub(`zz alias ${i} a`);
        const second = stub(`zz alias ${i} b`);
        declareClique(page, first, second);
        all.push(page, first, second);
      }
      return all;
    };
    const expected = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, k) => {
        const i = from + k;
        return { name: `p${String(i).padStart(2, '0')}`, aliases: [`zz alias ${i} a`, `zz alias ${i} b`] };
      });

    it('counts distinct canonical pages, not aliases', async () => {
      serve(withAliases(5));

      const result = await listPages(mockClient);

      expect(result.total).toBe(5);
      expect(result.pages).toHaveLength(5);
    });

    it('sorts by canonical name, not by alias name', async () => {
      const zeta = written('Zeta');
      const aardvark = stub('Aardvark');
      declare(zeta, aardvark);
      serve([aardvark, zeta, written('Mid')]);

      expect((await listPages(mockClient)).pages.map(p => p.name)).toEqual(['Mid', 'Zeta']);
    });

    it('spends one limit slot per page, however many aliases it has', async () => {
      serve(withAliases(10));

      const result = await listPages(mockClient, { limit: 3 });

      expect(result.pages).toEqual(expected(0, 3));
      expect(result.total).toBe(10);
    });

    it('offsets by pages, not by names', async () => {
      serve(withAliases(10));

      expect((await listPages(mockClient, { limit: 3, offset: 4 })).pages).toEqual(expected(4, 7));
    });

    it('warns about the pages left, counting pages and not aliases', async () => {
      serve(withAliases(10));

      const result = await listPages(mockClient, { limit: 3, offset: 2 });

      expect(result.hasMore).toBe(true);
      expect(result.warnings).toEqual([
        {
          code: 'pages_truncated',
          message: 'Showing 3 of 8 pages from offset 2. Page through the rest with offset.',
          howToFetchAll: 'Set offset to 5 for the next page. Or set limit to 8 (or higher) to get all 8 in one call.',
        },
      ]);
    });

    it('adds no warning when the window reaches the last page', async () => {
      serve(withAliases(10));

      expect(await listPages(mockClient, { limit: 3, offset: 7 })).toEqual({ pages: expected(7, 10), total: 10 });
    });

    it('pages through every page and every alias exactly once', async () => {
      serve(withAliases(10));
      const seen: Array<{ name: string; aliases?: string[] }> = [];
      let offset = 0;
      for (let calls = 0; calls < 10; calls++) {
        const result = await listPages(mockClient, { limit: 4, offset });
        seen.push(...result.pages);
        if (!result.hasMore) break;
        offset = Number(result.warnings![0].howToFetchAll!.match(/Set offset to (\d+)/)![1]);
      }

      expect(seen).toEqual(expected(0, 10));
    });

    it('counts total after the filter: a filter on an alias counts its page once', async () => {
      serve(withAliases(10));

      const result = await listPages(mockClient, { nameContains: 'zz alias', limit: 2 });

      expect(result.total).toBe(10);
      expect(result.pages).toEqual(expected(0, 2));
    });
  });

  describe('cost and failures', () => {
    it('makes the one getAllPages call, however many aliases there are', async () => {
      const page = written('Alex');
      const stubs = Array.from({ length: 20 }, (_, i) => stub(`alias ${i}`));
      declareClique(page, ...stubs);
      serve([page, ...stubs]);

      await listPages(mockClient, { nameContains: 'alias' });

      expect(mockClient.callAPI).toHaveBeenCalledTimes(1);
      expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getAllPages');
    });

    it('keeps the pages_unavailable warning for null: no pages, no aliases, no hasMore of its own', async () => {
      serve(null);

      const result = await listPages(mockClient, { nameContains: 'rivera' });

      expect(result).toEqual({
        pages: [],
        total: 0,
        hasMore: false,
        warnings: [expect.objectContaining({ code: 'pages_unavailable' })],
      });
      expect(mockClient.callAPI).toHaveBeenCalledTimes(1);
    });

    it('does not turn an empty list into a warning when every page is an alias of a page that is filtered out', async () => {
      const page = written('Alex');
      const rivera = stub('Alex Rivera');
      declare(page, rivera);
      serve([page, rivera]);

      expect(await listPages(mockClient, { nameContains: 'zzz' })).toEqual({ pages: [], total: 0 });
    });

    it('propagates an API error', async () => {
      (mockClient.callAPI as any).mockRejectedValue(new Error('API error'));

      await expect(listPages(mockClient)).rejects.toThrow('API error');
    });
  });
});
