import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchBlocks } from './search-blocks.js';
import { LogseqClient } from '../client.js';
import { BlockEntity, PageEntity } from '../types.js';

describe('searchBlocks', () => {
  let mockClient: LogseqClient;

  beforeEach(() => {
    mockClient = {
      callAPI: vi.fn()
    } as any;
  });

  it('should call logseq.DB.q with search query', async () => {
    const mockResults = [
      { id: 1, uuid: 'block-uuid-1', content: 'Test search term', page: { id: 10 } }
    ];

    (mockClient.callAPI as any).mockResolvedValue(mockResults);

    const result = await searchBlocks(mockClient, 'search term');

    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.DB.q', [
      '[:find (pull ?b [*]) :where [?b :block/content ?content] [(clojure.string/includes? ?content "search term")]]'
    ]);
    expect(result).toEqual(mockResults);
  });

  it('should return array of blocks matching search query', async () => {
    const mockResults = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'First match for keyword',
        page: { id: 10 }
      },
      {
        id: 2,
        uuid: 'block-uuid-2',
        content: 'Second match with keyword',
        page: { id: 20 }
      }
    ];

    (mockClient.callAPI as any).mockResolvedValue(mockResults);

    const result = await searchBlocks(mockClient, 'keyword');

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty('content', 'First match for keyword');
    expect(result[1]).toHaveProperty('content', 'Second match with keyword');
  });

  it('should return empty array when no matches found', async () => {
    (mockClient.callAPI as any).mockResolvedValue([]);

    const result = await searchBlocks(mockClient, 'nonexistent');

    expect(result).toEqual([]);
  });

  it('should include page context in results', async () => {
    const mockResults = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Block with page context',
        page: {
          id: 100,
          uuid: 'page-uuid-1',
          name: 'test page',
          originalName: 'Test Page'
        },
        parent: { id: 100 },
        left: { id: 100 }
      }
    ];

    (mockClient.callAPI as any).mockResolvedValue(mockResults);

    const result = await searchBlocks(mockClient, 'context');

    expect(result[0].page).toHaveProperty('id', 100);
    expect(result[0].page).toHaveProperty('uuid', 'page-uuid-1');
    expect(result[0].page).toHaveProperty('name', 'test page');
  });

  it('should handle blocks with properties', async () => {
    const mockResults = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Block with properties',
        page: { id: 10 },
        parent: { id: 10 },
        left: { id: 10 },
        properties: {
          tags: ['important'],
          status: 'done'
        },
        level: 2
      }
    ];

    (mockClient.callAPI as any).mockResolvedValue(mockResults);

    const result = await searchBlocks(mockClient, 'properties');

    expect(result[0]).toHaveProperty('properties');
    expect(result[0].properties).toEqual({
      tags: ['important'],
      status: 'done'
    });
    expect(result[0].level).toBe(2);
  });

  it('should handle special characters in search query', async () => {
    const mockResults = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Block with "quotes"',
        page: { id: 10 }
      }
    ];

    (mockClient.callAPI as any).mockResolvedValue(mockResults);

    const result = await searchBlocks(mockClient, 'quotes');

    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.DB.q', [
      '[:find (pull ?b [*]) :where [?b :block/content ?content] [(clojure.string/includes? ?content "quotes")]]'
    ]);
    expect(result).toHaveLength(1);
  });

  it('should return null when API returns null', async () => {
    (mockClient.callAPI as any).mockResolvedValue(null);

    const result = await searchBlocks(mockClient, 'test');

    expect(result).toBeNull();
  });

  it('should propagate errors from the API client', async () => {
    (mockClient.callAPI as any).mockRejectedValue(
      new Error('Failed to connect to LogSeq API')
    );

    await expect(
      searchBlocks(mockClient, 'search term')
    ).rejects.toThrow('Failed to connect to LogSeq API');
  });
});
