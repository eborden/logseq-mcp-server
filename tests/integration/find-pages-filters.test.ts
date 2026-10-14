import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { findPages, findPagesNext } from './helpers/tools.js';
import type { FindPagesResult } from './helpers/types.js';
import { connectFixture, recordCalls } from './helpers/fixture-client.js';
import { InvalidParameterError } from './helpers/errors.js';

/**
 * The `names` and `property` + `value` filters of logseq_find_pages (#490), against the fixture graph.
 *
 * Read-only. The pages are those of tests/fixtures/README.md: `alice` and `bob` carry a page property (`role`);
 * `project atlas`, `project borealis` and `project cascade` are the three project pages (`type`, `status`,
 * `owner`, `tags`), with `atlas` as the alias of the first and `roadmap` the alias both of the others declare;
 * `property types` holds the typed page properties; `carol` and `archive` are pages with no file; `dave` is absent
 * on purpose. Every result is exact, since the fixture's pages are known.
 */

describe('logseq_find_pages names and page properties, against the fixture graph', () => {
  let client: LogseqClient;
  let calls: string[];

  const names = (result: FindPagesResult) => result.pages.map(page => page.name);
  const withProperty = async (property: string, value: string | number | boolean) => names(await findPages(client, { property, value }));

  beforeAll(async () => {
    ({ client } = await connectFixture());
    ({ calls } = recordCalls(client));
  });

  describe('names', () => {
    it('answers each name with its page, in the order it was sent, whether it is a name or an alias', async () => {
      const result = await findPages(client, { names: ['alice', 'ATLAS', 'carol', 'archive', 'logseq-mcp-fixture-sentinel'] });

      expect(result.names).toEqual([
        { name: 'alice', page: 'Alice' },
        { name: 'ATLAS', page: 'project atlas' },
        { name: 'carol', page: 'Carol' },
        { name: 'archive', page: 'archive' },
        { name: 'logseq-mcp-fixture-sentinel', page: 'logseq-mcp-fixture-sentinel' },
      ]);
      // the pages are the one list, with the alias nested under the page that declares it
      expect(result.pages).toEqual([
        { name: 'Alice' },
        { name: 'archive' },
        { name: 'Carol' },
        { name: 'logseq-mcp-fixture-sentinel' },
        { name: 'project atlas', aliases: ['atlas'] },
      ]);
      expect(result.total).toBe(5);
    });

    it('answers a name with no page with null, and the closest names when there are any', async () => {
      const result = await findPages(client, { names: ['dave', 'Property Type', 'alice'] });

      expect(result.names).toEqual([
        { name: 'dave', page: null },
        { name: 'Property Type', page: null, suggestions: ['property types'] },
        { name: 'alice', page: 'Alice' },
      ]);
      expect(names(result)).toEqual(['Alice']);
      expect(result.total).toBe(1);
    });

    it('answers a name that two pages declare with no page and the pages that do', async () => {
      const result = await findPages(client, { names: ['roadmap'] });

      expect(result.names).toEqual([{ name: 'roadmap', page: null, candidates: ['project borealis', 'project cascade'] }]);
      expect(result.pages).toEqual([
        { name: 'project borealis', aliases: ['roadmap'] },
        { name: 'project cascade', aliases: ['roadmap'] },
      ]);
    });

    it('is not a journal finder: the name of a journal day has no page here', async () => {
      const result = await findPages(client, { names: ['jan 15th, 2025'] });

      expect(result.names).toEqual([{ name: 'jan 15th, 2025', page: null }]);
      expect(result.pages).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('makes the one call for a single name and for fifty', async () => {
      calls.length = 0;
      await findPages(client, { names: ['alice'] });
      expect(calls).toEqual(['logseq.Editor.getAllPages']);

      calls.length = 0;
      const fifty = ['alice', ...Array.from({ length: 49 }, (_, i) => `no such page ${i}`)];
      const result = await findPages(client, { names: fifty });
      expect(calls).toEqual(['logseq.Editor.getAllPages']);
      expect(result.names).toHaveLength(50);
      expect(result.names![0]).toEqual({ name: 'alice', page: 'Alice' });
      expect(result.names!.slice(1).every(answer => answer.page === null)).toBe(true);
    });

    it('refuses an empty list and more than fifty names, before any call', async () => {
      calls.length = 0;
      await expect(findPages(client, { names: [] })).rejects.toBeInstanceOf(InvalidParameterError);
      await expect(findPages(client, { names: Array.from({ length: 51 }, (_, i) => `page ${i}`) })).rejects.toBeInstanceOf(InvalidParameterError);
      expect(calls).toEqual([]);
    });
  });

  describe('property and value', () => {
    it('finds the pages whose page property holds the value', async () => {
      expect(await withProperty('status', 'active')).toEqual(['project atlas', 'project cascade']);
      expect(await withProperty('type', 'project')).toEqual(['project atlas', 'project borealis', 'project cascade']);
      expect(await withProperty('role', 'designer')).toEqual(['Alice']);
      expect(await withProperty('role', 'engineer')).toEqual(['Bob']);
    });

    it('keeps the aliases of the pages it finds, as every list does', async () => {
      const result = await findPages(client, { property: 'status', value: 'active' });

      expect(result.pages).toEqual([
        { name: 'project atlas', aliases: ['atlas'] },
        { name: 'project cascade', aliases: ['roadmap'] },
      ]);
      expect(result.total).toBe(2);
    });

    it('takes the key as LogSeq stores it or as the Editor API spells it, and any case', async () => {
      for (const key of ['created-by', 'createdBy', 'CREATED_BY']) {
        expect(await withProperty(key, 'Alice'), key).toEqual(['property types']);
      }
    });

    it('matches a multi-value property on any one value, and a page reference by the name written', async () => {
      expect(await withProperty('owner', 'Alice')).toEqual(['project atlas']);
      expect(await withProperty('category', 'test data')).toEqual(['property types']);
      expect(await withProperty('tags', 'planning')).toEqual(['project cascade']);
    });

    it('matches a number as the text JavaScript writes it', async () => {
      // `fixture-version:: 1` on the sentinel page
      expect(await withProperty('fixture-version', 1)).toEqual(['logseq-mcp-fixture-sentinel']);
      expect(await withProperty('fixture-version', '1')).toEqual(['logseq-mcp-fixture-sentinel']);
    });

    it('matches the exact value, and finds nothing for a part of it, another case, or a block property', async () => {
      expect(await withProperty('status', 'act')).toEqual([]);
      expect(await withProperty('status', 'Active')).toEqual([]);
      // `status:: testing` and `effort:: 3` are properties of blocks of `property types`, not of the page
      expect(await withProperty('status', 'testing')).toEqual([]);
      expect(await withProperty('effort', 3)).toEqual([]);
    });

    it('makes one call, and says nothing is there with an empty list and no warning', async () => {
      calls.length = 0;
      const result = await findPages(client, { property: 'nothing-has-this', value: 'x' });

      expect(calls).toEqual(['logseq.Editor.getAllPages']);
      expect(result).toEqual({ total: 0, pages: [] });
    });

    it('refuses one of the two without the other, and a key LogSeq cannot store, before any call', async () => {
      calls.length = 0;
      await expect(findPages(client, { property: 'status' })).rejects.toBeInstanceOf(InvalidParameterError);
      await expect(findPages(client, { value: 'active' })).rejects.toBeInstanceOf(InvalidParameterError);
      await expect(findPages(client, { property: 'not a key', value: 'x' })).rejects.toBeInstanceOf(InvalidParameterError);
      expect(calls).toEqual([]);
    });
  });

  describe('the filters together', () => {
    it('AND: the pages every filter keeps, while a name is still answered with a page the others drop', async () => {
      const result = await findPages(client, { names: ['project atlas', 'project borealis', 'alice'], property: 'status', value: 'active' });

      expect(names(result)).toEqual(['project atlas']);
      expect(result.names).toEqual([
        { name: 'project atlas', page: 'project atlas' },
        { name: 'project borealis', page: 'project borealis' },
        { name: 'alice', page: 'Alice' },
      ]);
    });

    it('AND with text, and limit and the cursor page the pages and never the names', async () => {
      const text = await findPages(client, { text: 'cascade', property: 'type', value: 'project' });
      expect(names(text)).toEqual(['project cascade']);

      const page = await findPages(client, { names: ['alice', 'bob', 'carol', 'dave'], limit: 1 });
      expect(names(page)).toEqual(['Alice']);
      expect(page.total).toBe(3);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toEqual(expect.any(String));
      expect(page.warnings?.map(warning => warning.code)).toEqual(['pages_truncated']);
      expect(page.names).toHaveLength(4);

      // the pages after the first read on from the token, which holds the names: they are answered once, on page 1
      const next = await findPagesNext(client, page.nextCursor);
      expect(names(next)).toEqual(['Bob']);
      expect(next.total).toBe(3);
      expect(next.names).toBeUndefined();
      expect(next.hasMore).toBe(true);
    });
  });
});
