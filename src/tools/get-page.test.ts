import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPage } from './get-page.js';
import { LogseqClient } from '../client.js';
import { PageEntity } from '../types.js';
import {
  AmbiguousPageError,
  PageNotFoundError,
  LogSeqNotRunningError,
  LogSeqTimeoutError,
  LogSeqAuthError
} from '../errors.js';

/** A Datalog pull of a page, as the resolver sees it (kebab-case keys). */
const pulled = (name: string, originalName: string, extra: Record<string, unknown> = {}) => ({
  id: 1,
  name,
  'original-name': originalName,
  file: { id: 99 },
  ...extra
});

describe('getPage', () => {
  let mockClient: LogseqClient;
  let datalog: ReturnType<typeof vi.fn>;

  /** The resolver's first query returns `rows`; Editor.getPage returns `entity`. */
  function setup(rows: unknown[], entity: PageEntity | null, tree: unknown[] = []) {
    datalog.mockResolvedValue(rows);
    (mockClient.callAPI as any).mockImplementation(async (method: string) => {
      if (method === 'logseq.Editor.getPage') return entity === null ? null : { ...entity };
      if (method === 'logseq.Editor.getPageBlocksTree') return tree;
      return [];
    });
  }

  beforeEach(() => {
    datalog = vi.fn();
    mockClient = { callAPI: vi.fn(), executeDatalogQuery: datalog } as any;
  });

  it('calls logseq.Editor.getPage with the name as given and skips the blocks tree when includeChildren is false', async () => {
    const mockPage: PageEntity = { id: 1, uuid: 'page-uuid-123', name: 'test page', originalName: 'Test Page' };
    setup([[pulled('test page', 'Test Page'), 'name']], mockPage);

    const result = await getPage(mockClient, 'test page', false);

    expect(mockClient.callAPI).toHaveBeenCalledTimes(1);
    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getPage', ['test page']);
    expect(result).toEqual(mockPage);
    expect(result.children).toBeUndefined();
    expect(result.resolvedFrom).toBeUndefined();
  });

  it('costs one resolver query on top of the page fetch for an exact match', async () => {
    setup([[pulled('test page', 'Test Page'), 'name']], { id: 1, uuid: 'u', name: 'test page', originalName: 'Test Page' });

    await getPage(mockClient, 'Test Page', false);

    expect(datalog).toHaveBeenCalledTimes(1);
    expect(datalog.mock.calls[0][0]).toContain(':in $ ?n');
    expect(datalog.mock.calls[0].slice(1)).toEqual(['test page']);
    expect(mockClient.callAPI).toHaveBeenCalledTimes(1);
  });

  it('fetches the blocks tree separately and sets it as children when includeChildren is true', async () => {
    const mockPage: PageEntity = { id: 1, uuid: 'page-uuid-123', name: 'test page', originalName: 'Test Page' };
    const tree = [
      { id: 10, uuid: 'block-uuid-1', content: 'First block' },
      { id: 11, uuid: 'block-uuid-2', content: 'Second block' }
    ];
    setup([[pulled('test page', 'Test Page'), 'name']], mockPage, tree);

    const result = await getPage(mockClient, 'test page', true);

    expect(mockClient.callAPI).toHaveBeenCalledTimes(2);
    expect(mockClient.callAPI).toHaveBeenNthCalledWith(1, 'logseq.Editor.getPage', ['test page']);
    expect(mockClient.callAPI).toHaveBeenNthCalledWith(2, 'logseq.Editor.getPageBlocksTree', ['test page']);
    expect(result.children).toEqual(tree);
  });

  it('leaves children unset when the blocks tree is empty', async () => {
    setup([[pulled('empty page', 'Empty Page'), 'name']], { id: 1, uuid: 'u', name: 'empty page', originalName: 'Empty Page' }, []);

    const result = await getPage(mockClient, 'empty page', true);

    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getPageBlocksTree', ['empty page']);
    expect(result.children).toBeUndefined();
  });

  it('returns the PageEntity with all properties', async () => {
    const mockPage: PageEntity = {
      id: 42,
      uuid: 'page-uuid-456',
      name: 'my awesome page',
      originalName: 'My Awesome Page',
      properties: { tags: ['important', 'project'], customProp: 'value' },
      journal: false,
      updatedAt: 1699999999000
    };
    setup([[pulled('my awesome page', 'My Awesome Page'), 'name']], mockPage);

    const result = await getPage(mockClient, 'my awesome page', false);

    expect(result).toEqual(mockPage);
  });

  describe('aliases', () => {
    it('resolves an alias to the page that declares it and says so', async () => {
      const mockPage: PageEntity = { id: 7, uuid: 'u7', name: 'project atlas', originalName: 'Project Atlas' };
      setup([[pulled('project atlas', 'Project Atlas', { id: 7 }), 'alias'], [pulled('atlas', 'Atlas', { id: 9, file: undefined }), 'name']], mockPage, [
        { id: 70, uuid: 'b70', content: 'hello' }
      ]);

      const result = await getPage(mockClient, 'Atlas', true);

      // Follow-up calls use the resolved page, not the alias
      expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getPage', ['project atlas']);
      expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getPageBlocksTree', ['project atlas']);
      expect(result.name).toBe('project atlas');
      expect(result.resolvedFrom).toEqual({ name: 'Atlas', matchedBy: 'alias', resolvedTo: 'Project Atlas' });
      expect(datalog).toHaveBeenCalledTimes(1);
    });

    it('throws AmbiguousPageError listing every page that declares a shared alias', async () => {
      setup(
        [
          [pulled('project atlas', 'Project Atlas', { id: 7 }), 'alias'],
          [pulled('atlas cafe', 'Atlas Cafe', { id: 8 }), 'alias'],
          [pulled('atlas', 'Atlas', { id: 9, file: undefined }), 'name']
        ],
        null
      );

      const error = await getPage(mockClient, 'Atlas', false).catch(e => e);

      expect(error).toBeInstanceOf(AmbiguousPageError);
      expect(error.candidates.map((c: any) => [c.name, c.originalName, c.matchedBy])).toEqual([
        ['atlas cafe', 'Atlas Cafe', 'alias'],
        ['project atlas', 'Project Atlas', 'alias']
      ]);
      expect(error.candidates[0].reason).toContain('alias');
      // Nothing was fetched: no page was picked
      expect(mockClient.callAPI).not.toHaveBeenCalled();
    });
  });

  describe('ISO dates', () => {
    it('resolves an ISO date to the journal page by journal-day', async () => {
      const journal = { id: 5, uuid: 'j5', name: 'jan 1st, 2025', originalName: 'Jan 1st, 2025', journal: true, journalDay: 20250101 };
      setup([[pulled('jan 1st, 2025', 'Jan 1st, 2025', { 'journal-day': 20250101 }), 'journal-date']], journal);

      const result = await getPage(mockClient, '2025-01-01', false);

      expect(datalog.mock.calls[0][0]).toContain(':in $ ?n ?day');
      expect(datalog.mock.calls[0].slice(1)).toEqual(['2025-01-01', 20250101]);
      expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getPage', ['jan 1st, 2025']);
      expect(result.journalDay).toBe(20250101);
      expect(result.resolvedFrom).toEqual({ name: '2025-01-01', matchedBy: 'journal-date', resolvedTo: 'Jan 1st, 2025' });
    });

    it('treats an impossible date as an ordinary page name', async () => {
      setup([[pulled('2025-02-30', '2025-02-30'), 'name']], { id: 1, uuid: 'u', name: '2025-02-30', originalName: '2025-02-30' });

      await getPage(mockClient, '2025-02-30', false);

      expect(datalog.mock.calls[0][0]).not.toContain('?day');
    });
  });

  describe('not found', () => {
    it('throws guidance with the closest names and the tools to try', async () => {
      const allPages: PageEntity[] = [
        { id: 1, uuid: 'u1', name: 'project atlas', originalName: 'Project Atlas' },
        { id: 2, uuid: 'u2', name: 'project apollo', originalName: 'Project Apollo' },
        { id: 3, uuid: 'u3', name: 'groceries', originalName: 'Groceries' }
      ];
      datalog.mockResolvedValue([]);
      (mockClient.callAPI as any).mockResolvedValue(allPages);

      const promise = getPage(mockClient, 'proj atlas', false);

      await expect(promise).rejects.toThrow(PageNotFoundError);
      await expect(promise).rejects.toThrow(/^No page "proj atlas"\. Closest: .*Project Atlas.*\. Try logseq_search_blocks .*logseq_list_pages/);
    });

    it('leaves out "Closest" when there is nothing to suggest', async () => {
      datalog.mockResolvedValue([]);
      (mockClient.callAPI as any).mockResolvedValue([]);

      const error = await getPage(mockClient, 'missing page', false).catch(e => e);

      expect(error).toBeInstanceOf(PageNotFoundError);
      expect(error.message).not.toContain('Closest');
      expect(error.message).toContain('logseq_list_pages');
      expect(error.suggestions).toEqual([]);
    });

    it('does not fuzzy-match an ISO date, which costs no getAllPages call', async () => {
      datalog.mockResolvedValue([]);

      await expect(getPage(mockClient, '2025-01-01', false)).rejects.toThrow(PageNotFoundError);
      expect(mockClient.callAPI).not.toHaveBeenCalled();
    });

    it('still throws PageNotFoundError when the suggestion lookup fails unexpectedly', async () => {
      datalog.mockResolvedValue([]);
      (mockClient.callAPI as any).mockRejectedValue(new Error('boom'));

      await expect(getPage(mockClient, 'missing page', false)).rejects.toThrow(PageNotFoundError);
    });

    it('throws PageNotFoundError if the page vanishes between the lookup and the fetch', async () => {
      setup([[pulled('test page', 'Test Page'), 'name']], null);

      await expect(getPage(mockClient, 'test page', false)).rejects.toThrow(PageNotFoundError);
    });
  });

  describe('infrastructure errors', () => {
    const infrastructureErrors: Array<[string, () => Error]> = [
      ['LogSeqNotRunningError', () => new LogSeqNotRunningError('http://test')],
      ['LogSeqTimeoutError', () => new LogSeqTimeoutError('http://test', 1000)],
      ['LogSeqAuthError', () => new LogSeqAuthError('http://test')]
    ];

    it.each(infrastructureErrors)('propagates %s from the page resolver', async (_name, makeError) => {
      const error = makeError();
      datalog.mockRejectedValue(error);

      await expect(getPage(mockClient, 'test page', false)).rejects.toBe(error);
      expect(mockClient.callAPI).not.toHaveBeenCalled();
    });

    it.each(infrastructureErrors)('propagates %s from the Editor.getPage call', async (_name, makeError) => {
      const error = makeError();
      datalog.mockResolvedValue([[pulled('test page', 'Test Page'), 'name']]);
      (mockClient.callAPI as any).mockRejectedValue(error);

      await expect(getPage(mockClient, 'test page', false)).rejects.toBe(error);
    });

    it.each(infrastructureErrors)('propagates %s from the suggestion lookup instead of reporting page not found', async (_name, makeError) => {
      const error = makeError();
      datalog.mockResolvedValue([]);
      (mockClient.callAPI as any).mockRejectedValue(error);

      await expect(getPage(mockClient, 'missing page', false)).rejects.toBe(error);
    });

    it('propagates an unexpected error from the Editor.getPage call', async () => {
      datalog.mockResolvedValue([[pulled('test page', 'Test Page'), 'name']]);
      (mockClient.callAPI as any).mockRejectedValue(new Error('Failed to connect to LogSeq API'));

      await expect(getPage(mockClient, 'test page', false)).rejects.toThrow('Failed to connect to LogSeq API');
    });
  });
});
