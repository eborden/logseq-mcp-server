import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPageOutline, MAX_OUTLINE_BLOCKS } from './get-page-outline.js';
import { LogseqClient } from '../client.js';
import { AmbiguousPageError, LogSeqNotRunningError, PageNotFoundError } from '../errors.js';
import { SNIPPET_MAX_CHARS } from '../utils/snippet.js';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A page as the resolver's Datalog pull returns it. */
const page = { id: 1, name: 'project atlas', 'original-name': 'Project Atlas', file: { id: 9 } };

/** A pulled block row, as `pageOutlineBlocks` returns it. */
const block = (id: number, parent: number, left: number, content: string) => ({
  id,
  uuid: U(id),
  content,
  parent: { id: parent },
  left: { id: left },
});

describe('getPageOutline', () => {
  let datalog: ReturnType<typeof vi.fn>;
  let callAPI: ReturnType<typeof vi.fn>;
  let client: LogseqClient;

  /** The resolver's query answers `resolverRows`; the outline's query answers `blockRows`. */
  function setup(resolverRows: unknown[], blockRows: unknown[]) {
    datalog.mockImplementation(async (query: string) => (query.includes(':in $ ?n') ? resolverRows : blockRows.map(b => [b])));
  }

  beforeEach(() => {
    datalog = vi.fn();
    callAPI = vi.fn().mockResolvedValue(null);
    client = { callAPI, executeDatalogQuery: datalog } as unknown as LogseqClient;
  });

  it('lists the top-level blocks with a snippet and a child count each', async () => {
    setup(
      [[page, 'name']],
      [
        block(10, 1, 1, 'first block'),
        block(11, 1, 10, 'second block\nwith more lines'),
        block(20, 10, 10, 'child of first'),
        block(21, 10, 20, 'another child of first'),
        block(22, 11, 11, 'child of second'),
      ]
    );

    const outline = await getPageOutline(client, 'Project Atlas');

    expect(outline.page).toBe('Project Atlas');
    expect(outline.blocks).toEqual([
      { uuid: U(10), snippet: 'first block', childCount: 2 },
      { uuid: U(11), snippet: 'second block', childCount: 1 },
    ]);
    expect(outline.hasMore).toBe(false);
    expect(outline.warnings).toEqual([]);
    expect(outline.totals).toEqual({ blocks: 2 });
    expect(outline.resolvedFrom).toBeUndefined();
  });

  it('orders the blocks by the left chain, not by the order the query returned them', async () => {
    setup([[page, 'name']], [block(12, 1, 11, 'third'), block(10, 1, 1, 'first'), block(11, 1, 10, 'second')]);

    const outline = await getPageOutline(client, 'Project Atlas');

    expect(outline.blocks.map(b => b.snippet)).toEqual(['first', 'second', 'third']);
  });

  it('cuts a long first line to the snippet cap', async () => {
    setup([[page, 'name']], [block(10, 1, 1, `${'word '.repeat(60)}\nsecond line`)]);

    const [only] = (await getPageOutline(client, 'Project Atlas')).blocks;

    expect(only.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    expect(only.snippet.endsWith('...')).toBe(true);
  });

  it('counts direct children only', async () => {
    // 11 is a child of 10; 12 is a grandchild and its row is not part of the outline query
    setup([[page, 'name']], [block(10, 1, 1, 'top'), block(11, 10, 10, 'child')]);

    expect((await getPageOutline(client, 'Project Atlas')).blocks[0].childCount).toBe(1);
  });

  describe('API calls', () => {
    it('is two Datalog queries for an exact name, and no Editor API call', async () => {
      setup([[page, 'name']], [block(10, 1, 1, 'a')]);

      await getPageOutline(client, 'Project Atlas');

      expect(datalog).toHaveBeenCalledTimes(2);
      expect(callAPI).not.toHaveBeenCalled();
    });

    it('stays at two queries however many blocks the page has: no call per block', async () => {
      const many = Array.from({ length: 150 }, (_, i) => block(100 + i, 1, i === 0 ? 1 : 99 + i, `block ${i}`));
      const kids = Array.from({ length: 150 }, (_, i) => block(1000 + i, 100 + i, 100 + i, `kid ${i}`));
      setup([[page, 'name']], [...many, ...kids]);

      const outline = await getPageOutline(client, 'Project Atlas');

      expect(outline.blocks).toHaveLength(150);
      expect(datalog).toHaveBeenCalledTimes(2);
      expect(callAPI).not.toHaveBeenCalled();
    });

    it('binds the page by id, so no name is embedded in the blocks query', async () => {
      setup([[page, 'name']], []);

      await getPageOutline(client, "O'Brien \"quoted\" page");

      const [query, ...inputs] = datalog.mock.calls[1];
      expect(query).toContain('[(ground [1]) [?page ...]]');
      expect(query).not.toContain('quoted');
      expect(inputs).toEqual([]);
    });
  });

  describe('page resolution', () => {
    it('follows an alias to the page that declares it, and says so', async () => {
      const stub = { id: 3, name: 'atlas', 'original-name': 'Atlas' };
      setup([[stub, 'name'], [page, 'alias']], [block(10, 1, 1, 'a')]);

      const outline = await getPageOutline(client, 'Atlas');

      expect(outline.page).toBe('Project Atlas');
      expect(outline.resolvedFrom).toEqual({ name: 'Atlas', matchedBy: 'alias', resolvedTo: 'Project Atlas' });
      expect(datalog).toHaveBeenCalledTimes(2);
      // The blocks are those of the declaring page (id 1), not of the empty stub (id 3)
      expect(datalog.mock.calls[1][0]).toContain('[(ground [1]) [?page ...]]');
    });

    it('resolves an ISO date to the journal page for that day', async () => {
      const journal = { id: 7, name: 'jan 1st, 2025', 'original-name': 'Jan 1st, 2025', 'journal-day': 20250101, file: { id: 2 } };
      setup([[journal, 'journal-date']], [block(30, 7, 7, 'morning')]);

      const outline = await getPageOutline(client, '2025-01-01');

      expect(outline.page).toBe('Jan 1st, 2025');
      expect(outline.resolvedFrom).toMatchObject({ name: '2025-01-01', matchedBy: 'journal-date' });
      expect(datalog.mock.calls[0].slice(1)).toEqual(['2025-01-01', 20250101]);
      expect(datalog.mock.calls[1][0]).toContain('[(ground [7]) [?page ...]]');
    });

    it('is case-insensitive', async () => {
      setup([[page, 'name']], []);

      await getPageOutline(client, 'PROJECT ATLAS');

      expect(datalog.mock.calls[0].slice(1)).toEqual(['project atlas']);
    });

    it('throws PageNotFoundError with the closest names when nothing matches', async () => {
      datalog.mockResolvedValue([]);
      callAPI.mockResolvedValue([{ id: 1, name: 'project atlas', originalName: 'Project Atlas' }]);

      const error = await getPageOutline(client, 'Project Atlass').catch(e => e);

      expect(error).toBeInstanceOf(PageNotFoundError);
      expect(error.message).toContain('Project Atlas');
    });

    it('throws AmbiguousPageError with the candidates when several pages answer to the name', async () => {
      const stub = { id: 3, name: 'bob', 'original-name': 'Bob' };
      const sources = [
        [{ id: 1, name: 'robert smith', 'original-name': 'Robert Smith', file: { id: 9 } }, 'alias'],
        [{ id: 2, name: 'robert jones', 'original-name': 'Robert Jones', file: { id: 10 } }, 'alias'],
      ];
      datalog.mockResolvedValue([[stub, 'name'], ...sources]);

      const error = await getPageOutline(client, 'Bob').catch(e => e);

      expect(error).toBeInstanceOf(AmbiguousPageError);
      expect(error.candidates.map((c: any) => c.originalName)).toEqual(['Robert Jones', 'Robert Smith']);
      expect(datalog).toHaveBeenCalledTimes(1);
    });
  });

  describe('empty and capped pages', () => {
    it('returns an empty outline for a page with no blocks, not an error', async () => {
      setup([[page, 'name']], []);

      const outline = await getPageOutline(client, 'Project Atlas');

      expect(outline.blocks).toEqual([]);
      expect(outline.page).toBe('Project Atlas');
      expect(outline.hasMore).toBe(false);
      expect(outline.warnings).toEqual([]);
      expect(outline.totals).toEqual({ blocks: 0 });
    });

    it('treats a null query result as no blocks', async () => {
      datalog.mockImplementation(async (query: string) => (query.includes(':in $ ?n') ? [[page, 'name']] : null));

      expect((await getPageOutline(client, 'Project Atlas')).blocks).toEqual([]);
    });

    it('cuts a very long page at the cap and says so, without claiming more can be fetched', async () => {
      const total = MAX_OUTLINE_BLOCKS + 25;
      setup(
        [[page, 'name']],
        Array.from({ length: total }, (_, i) => block(100 + i, 1, i === 0 ? 1 : 99 + i, `block ${i}`))
      );

      const outline = await getPageOutline(client, 'Project Atlas');

      expect(outline.blocks).toHaveLength(MAX_OUTLINE_BLOCKS);
      expect(outline.blocks[0].snippet).toBe('block 0');
      expect(outline.totals).toEqual({ blocks: total });
      expect(outline.warnings).toHaveLength(1);
      expect(outline.warnings[0].code).toBe('outline_truncated');
      expect(outline.warnings[0].message).toContain(`first ${MAX_OUTLINE_BLOCKS} of ${total}`);
      expect(outline.warnings[0].message).toContain('logseq_get_page');
      // No parameter fetches the rest of an outline, so hasMore stays false
      expect(outline.warnings[0].howToFetchAll).toBeUndefined();
      expect(outline.hasMore).toBe(false);
    });
  });

  it('does not turn a LogSeq outage into an empty outline', async () => {
    setup([[page, 'name']], []);
    datalog.mockImplementation(async (query: string) => {
      if (query.includes(':in $ ?n')) return [[page, 'name']];
      throw new LogSeqNotRunningError('http://test');
    });

    await expect(getPageOutline(client, 'Project Atlas')).rejects.toBeInstanceOf(LogSeqNotRunningError);
  });
});
