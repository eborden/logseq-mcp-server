import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBacklinks, getBacklinksWithMeta } from './get-backlinks.js';
import { LogseqClient } from '../client.js';
import { AmbiguousPageError, LogSeqTimeoutError, PageNotFoundError } from '../errors.js';

describe('getBacklinks', () => {
  let mockClient: LogseqClient;

  beforeEach(() => {
    // The name resolves to an existing page unless a test says otherwise
    mockClient = {
      callAPI: vi.fn(),
      executeDatalogQuery: vi.fn().mockResolvedValue([[{ id: 1, name: 'test page' }, 'name']])
    } as any;
  });

  it('should call logseq.Editor.getPageLinkedReferences with page name', async () => {
    const mockBacklinks = [
      [
        { id: 1, uuid: 'block-uuid-1', content: 'Reference to [[test page]]', page: { id: 2 } },
        { id: 2, uuid: 'page-uuid-2', name: 'source page' }
      ]
    ];

    (mockClient.callAPI as any).mockResolvedValue(mockBacklinks);

    const result = await getBacklinks(mockClient, 'test page');

    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getPageLinkedReferences', ['test page']);
    expect(result).toEqual(mockBacklinks);
  });

  it('should return array of tuples with block and page', async () => {
    const mockBacklinks = [
      [
        { id: 10, uuid: 'block-uuid-1', content: 'First reference [[target]]', page: { id: 20 } },
        { id: 20, uuid: 'page-uuid-1', name: 'page one' }
      ],
      [
        { id: 11, uuid: 'block-uuid-2', content: 'Second reference [[target]]', page: { id: 21 } },
        { id: 21, uuid: 'page-uuid-2', name: 'page two' }
      ]
    ];

    (mockClient.callAPI as any).mockResolvedValue(mockBacklinks);

    const result = await getBacklinks(mockClient, 'target');

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(2);
    expect(result[0][0]).toHaveProperty('content', 'First reference [[target]]');
    expect(result[0][1]).toHaveProperty('name', 'page one');
    expect(result[1][0]).toHaveProperty('content', 'Second reference [[target]]');
    expect(result[1][1]).toHaveProperty('name', 'page two');
  });

  it('should return empty array when no backlinks found', async () => {
    (mockClient.callAPI as any).mockResolvedValue([]);

    const result = await getBacklinks(mockClient, 'no-refs-page');

    expect(result).toEqual([]);
  });

  it('should return null when the page exists but the API returns null', async () => {
    (mockClient.callAPI as any).mockResolvedValue(null);

    const result = await getBacklinks(mockClient, 'test page');

    expect(result).toBeNull();
  });

  it('should resolve an alias and ask for the backlinks of the page behind it', async () => {
    (mockClient.executeDatalogQuery as any).mockResolvedValue([
      [{ id: 7, name: 'project atlas', 'original-name': 'Project Atlas' }, 'alias'],
      [{ id: 8, name: 'atlas', 'original-name': 'Atlas' }, 'name']
    ]);
    (mockClient.callAPI as any).mockResolvedValue([]);

    await getBacklinks(mockClient, 'Atlas');

    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getPageLinkedReferences', ['project atlas']);
  });

  describe('getBacklinksWithMeta', () => {
    it('has no meta for an exact name, so default output is unchanged', async () => {
      (mockClient.callAPI as any).mockResolvedValue([]);

      const { results, meta } = await getBacklinksWithMeta(mockClient, 'test page');

      expect(results).toEqual([]);
      expect(meta).toBeNull();
    });

    it('says which page the backlinks belong to when the name was an alias', async () => {
      (mockClient.executeDatalogQuery as any).mockResolvedValue([
        [{ id: 7, name: 'project atlas', 'original-name': 'Project Atlas' }, 'alias'],
        [{ id: 8, name: 'atlas', 'original-name': 'Atlas' }, 'name']
      ]);
      (mockClient.callAPI as any).mockResolvedValue([]);

      const { meta } = await getBacklinksWithMeta(mockClient, 'Atlas');

      expect(meta).toEqual({
        hasMore: false,
        warnings: [],
        resolvedFrom: { name: 'Atlas', matchedBy: 'alias', resolvedTo: 'Project Atlas' }
      });
    });

    it('says so when the name was a namespace leaf', async () => {
      (mockClient.executeDatalogQuery as any)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([[{ id: 5, name: 'work/atlas', 'original-name': 'Work/Atlas' }]]);
      (mockClient.callAPI as any).mockResolvedValue([]);

      const { meta } = await getBacklinksWithMeta(mockClient, 'Atlas');

      expect(meta?.resolvedFrom).toEqual({ name: 'Atlas', matchedBy: 'namespace-leaf', resolvedTo: 'Work/Atlas' });
      expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getPageLinkedReferences', ['work/atlas']);
    });
  });

  it('should throw PageNotFoundError guidance when no page matches', async () => {
    (mockClient.executeDatalogQuery as any).mockResolvedValue([]);
    (mockClient.callAPI as any).mockResolvedValue([]);

    await expect(getBacklinks(mockClient, 'nonexistent-page')).rejects.toThrow(PageNotFoundError);
    expect(mockClient.callAPI).not.toHaveBeenCalledWith('logseq.Editor.getPageLinkedReferences', expect.anything());
  });

  it('should throw AmbiguousPageError without fetching when an alias is shared', async () => {
    (mockClient.executeDatalogQuery as any).mockResolvedValue([
      [{ id: 7, name: 'project atlas', 'original-name': 'Project Atlas' }, 'alias'],
      [{ id: 9, name: 'atlas cafe', 'original-name': 'Atlas Cafe' }, 'alias']
    ]);

    await expect(getBacklinks(mockClient, 'Atlas')).rejects.toThrow(AmbiguousPageError);
    expect(mockClient.callAPI).not.toHaveBeenCalled();
  });

  it('should propagate infrastructure errors from the page lookup', async () => {
    const error = new LogSeqTimeoutError('http://test', 1000);
    (mockClient.executeDatalogQuery as any).mockRejectedValue(error);

    await expect(getBacklinks(mockClient, 'test page')).rejects.toBe(error);
  });

  it('should handle blocks with properties and metadata', async () => {
    const mockBacklinks = [
      [
        {
          id: 100,
          uuid: 'block-uuid-complex',
          content: 'Complex block referencing [[target]]',
          page: { id: 200 },
          properties: { tags: ['important'] },
          level: 2,
          format: 'markdown'
        },
        {
          id: 200,
          uuid: 'page-uuid-complex',
          name: 'complex page',
          originalName: 'Complex Page'
        }
      ]
    ];

    (mockClient.callAPI as any).mockResolvedValue(mockBacklinks);

    const result = await getBacklinks(mockClient, 'target');

    expect(result[0][0]).toHaveProperty('properties');
    expect(result[0][0].properties).toEqual({ tags: ['important'] });
    expect(result[0][0]).toHaveProperty('level', 2);
    expect(result[0][1]).toHaveProperty('originalName', 'Complex Page');
  });

  it('should propagate errors from the API client', async () => {
    (mockClient.callAPI as any).mockRejectedValue(
      new Error('Failed to connect to LogSeq API')
    );

    await expect(
      getBacklinks(mockClient, 'test page')
    ).rejects.toThrow('Failed to connect to LogSeq API');
  });
});
