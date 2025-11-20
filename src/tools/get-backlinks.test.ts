import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBacklinks } from './get-backlinks.js';
import { LogseqClient } from '../client.js';

describe('getBacklinks', () => {
  let mockClient: LogseqClient;

  beforeEach(() => {
    mockClient = {
      callAPI: vi.fn()
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

  it('should return null when API returns null', async () => {
    (mockClient.callAPI as any).mockResolvedValue(null);

    const result = await getBacklinks(mockClient, 'nonexistent-page');

    expect(result).toBeNull();
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
