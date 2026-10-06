import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBacklinks, getBacklinksWithMeta } from './get-backlinks.js';
import { LogseqClient } from '../client.js';
import { AmbiguousPageError, LogSeqTimeoutError, PageNotFoundError } from '../errors.js';
import { BlockEntity, PageEntity } from '../types.js';

// What logseq.Editor.getPageLinkedReferences returns: one [source page, its blocks] tuple per source page
type Backlink = [PageEntity, BlockEntity[]];

const sourcePage = (id: number, name: string, originalName: string): PageEntity => ({
  id,
  uuid: `page-uuid-${id}`,
  name,
  originalName
});

const refBlock = (id: number, pageId: number, content: string, extra: Partial<BlockEntity> = {}): BlockEntity => ({
  id,
  uuid: `block-uuid-${id}`,
  content,
  page: { id: pageId },
  parent: { id: pageId },
  left: { id: pageId },
  ...extra
});

describe('getBacklinks', () => {
  // The calls are typed so a test can't hand back a value the real client wouldn't
  const callAPI = vi.fn<(method: string, args?: unknown[]) => Promise<unknown>>();
  const executeDatalogQuery = vi.fn<(query: string, ...inputs: unknown[]) => Promise<unknown>>();
  const mockClient = { callAPI, executeDatalogQuery } as unknown as LogseqClient;
  /** The backlinks call answers with these tuples (or null), and nothing else compiles. */
  const answerWith = (backlinks: Backlink[] | null) => callAPI.mockResolvedValue(backlinks);

  beforeEach(() => {
    callAPI.mockReset();
    executeDatalogQuery.mockReset();
    // The name resolves to an existing page unless a test says otherwise
    executeDatalogQuery.mockResolvedValue([[{ id: 1, name: 'test page' }, 'name']]);
  });

  it('should call logseq.Editor.getPageLinkedReferences with page name', async () => {
    const mockBacklinks: Backlink[] = [
      [
        sourcePage(2, 'source page', 'Source Page'),
        [refBlock(1, 2, 'Reference to [[test page]]')]
      ]
    ];

    answerWith(mockBacklinks);

    const result = await getBacklinks(mockClient, 'test page');

    expect(callAPI).toHaveBeenCalledWith('logseq.Editor.getPageLinkedReferences', ['test page']);
    expect(result).toEqual(mockBacklinks);
  });

  it('should return one [page, blocks[]] tuple per source page', async () => {
    const mockBacklinks: Backlink[] = [
      [
        sourcePage(20, 'page one', 'Page One'),
        [refBlock(10, 20, 'First reference [[target]]'), refBlock(12, 20, 'Another on page one [[target]]')]
      ],
      [
        sourcePage(21, 'page two', 'Page Two'),
        [refBlock(11, 21, 'Second reference [[target]]')]
      ]
    ];

    answerWith(mockBacklinks);

    const result = (await getBacklinks(mockClient, 'target'))!; // the mock returns tuples, never null

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(2);
    expect(result[0][0]).toHaveProperty('name', 'page one');
    expect(result[0][1]).toHaveLength(2);
    expect(result[0][1][0]).toHaveProperty('content', 'First reference [[target]]');
    expect(result[1][0]).toHaveProperty('name', 'page two');
    expect(result[1][1]).toHaveLength(1);
    expect(result[1][1][0]).toHaveProperty('content', 'Second reference [[target]]');
  });

  it('should return empty array when no backlinks found', async () => {
    answerWith([]);

    const result = await getBacklinks(mockClient, 'no-refs-page');

    expect(result).toEqual([]);
  });

  it('should return null when the page exists but the API returns null', async () => {
    answerWith(null);

    const result = await getBacklinks(mockClient, 'test page');

    expect(result).toBeNull();
  });

  it('should resolve an alias and ask for the backlinks of the page behind it', async () => {
    executeDatalogQuery.mockResolvedValue([
      [{ id: 7, name: 'project atlas', 'original-name': 'Project Atlas' }, 'alias'],
      [{ id: 8, name: 'atlas', 'original-name': 'Atlas' }, 'name']
    ]);
    answerWith([]);

    await getBacklinks(mockClient, 'Atlas');

    expect(callAPI).toHaveBeenCalledWith('logseq.Editor.getPageLinkedReferences', ['project atlas']);
  });

  describe('getBacklinksWithMeta', () => {
    it('has no meta for an exact name, so default output is unchanged', async () => {
      answerWith([]);

      const { results, meta } = await getBacklinksWithMeta(mockClient, 'test page');

      expect(results).toEqual([]);
      expect(meta).toBeNull();
    });

    it('says which page the backlinks belong to when the name was an alias', async () => {
      executeDatalogQuery.mockResolvedValue([
        [{ id: 7, name: 'project atlas', 'original-name': 'Project Atlas' }, 'alias'],
        [{ id: 8, name: 'atlas', 'original-name': 'Atlas' }, 'name']
      ]);
      answerWith([]);

      const { meta } = await getBacklinksWithMeta(mockClient, 'Atlas');

      expect(meta).toEqual({
        hasMore: false,
        warnings: [],
        resolvedFrom: { name: 'Atlas', matchedBy: 'alias', resolvedTo: 'Project Atlas' }
      });
    });

    it('says so when the name was a namespace leaf', async () => {
      executeDatalogQuery
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([[{ id: 5, name: 'work/atlas', 'original-name': 'Work/Atlas' }]]);
      answerWith([]);

      const { meta } = await getBacklinksWithMeta(mockClient, 'Atlas');

      expect(meta?.resolvedFrom).toEqual({ name: 'Atlas', matchedBy: 'namespace-leaf', resolvedTo: 'Work/Atlas' });
      expect(callAPI).toHaveBeenCalledWith('logseq.Editor.getPageLinkedReferences', ['work/atlas']);
    });
  });

  it('should throw PageNotFoundError guidance when no page matches', async () => {
    executeDatalogQuery.mockResolvedValue([]);
    answerWith([]);

    await expect(getBacklinks(mockClient, 'nonexistent-page')).rejects.toThrow(PageNotFoundError);
    expect(callAPI).not.toHaveBeenCalledWith('logseq.Editor.getPageLinkedReferences', expect.anything());
  });

  it('should throw AmbiguousPageError without fetching when an alias is shared', async () => {
    executeDatalogQuery.mockResolvedValue([
      [{ id: 7, name: 'project atlas', 'original-name': 'Project Atlas' }, 'alias'],
      [{ id: 9, name: 'atlas cafe', 'original-name': 'Atlas Cafe' }, 'alias']
    ]);

    await expect(getBacklinks(mockClient, 'Atlas')).rejects.toThrow(AmbiguousPageError);
    expect(callAPI).not.toHaveBeenCalled();
  });

  it('should propagate infrastructure errors from the page lookup', async () => {
    const error = new LogSeqTimeoutError('http://test', 1000);
    executeDatalogQuery.mockRejectedValue(error);

    await expect(getBacklinks(mockClient, 'test page')).rejects.toBe(error);
  });

  it('should handle blocks with properties and metadata', async () => {
    const mockBacklinks: Backlink[] = [
      [
        { ...sourcePage(200, 'complex page', 'Complex Page'), uuid: 'page-uuid-complex' },
        [
          refBlock(100, 200, 'Complex block referencing [[target]]', {
            uuid: 'block-uuid-complex',
            properties: { tags: ['important'] },
            level: 2,
            format: 'markdown'
          })
        ]
      ]
    ];

    answerWith(mockBacklinks);

    const result = (await getBacklinks(mockClient, 'target'))!; // the mock returns tuples, never null

    expect(result[0][0]).toHaveProperty('originalName', 'Complex Page');
    expect(result[0][1][0]).toHaveProperty('properties', { tags: ['important'] });
    expect(result[0][1][0]).toHaveProperty('level', 2);
  });

  it('should propagate errors from the API client', async () => {
    callAPI.mockRejectedValue(
      new Error('Failed to connect to LogSeq API')
    );

    await expect(
      getBacklinks(mockClient, 'test page')
    ).rejects.toThrow('Failed to connect to LogSeq API');
  });
});
