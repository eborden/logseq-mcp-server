import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryByProperty } from './query-by-property.js';
import { LogseqClient } from '../client.js';
import { BlockEntity } from '../types.js';

describe('queryByProperty', () => {
  let mockClient: LogseqClient;

  beforeEach(() => {
    mockClient = {
      callAPI: vi.fn()
    } as any;
  });

  it('should call logseq.Editor APIs to search for blocks with property', async () => {
    const mockPages = [
      { id: 10, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
    ];

    const mockBlocks = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Block with property',
        page: { id: 10 },
        parent: { id: 10 },
        left: { id: 10 },
        properties: { status: 'done' }
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages) // getAllPages
      .mockResolvedValueOnce(mockBlocks); // getPageBlocksTree

    const result = await queryByProperty(mockClient, 'status', 'done');

    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getAllPages');
    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getPageBlocksTree', ['test-page']);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(mockBlocks[0]);
  });

  it('should return array of blocks matching property value', async () => {
    const mockPages = [
      { id: 10, uuid: 'page-uuid-1', name: 'page-1', originalName: 'Page 1' },
      { id: 20, uuid: 'page-uuid-2', name: 'page-2', originalName: 'Page 2' }
    ];

    const mockBlocks1 = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'First block',
        page: { id: 10 },
        parent: { id: 10 },
        left: { id: 10 },
        properties: { priority: 'high' }
      }
    ];

    const mockBlocks2 = [
      {
        id: 2,
        uuid: 'block-uuid-2',
        content: 'Second block',
        page: { id: 20 },
        parent: { id: 20 },
        left: { id: 20 },
        properties: { priority: 'high' }
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages) // getAllPages
      .mockResolvedValueOnce(mockBlocks1) // getPageBlocksTree for page-1
      .mockResolvedValueOnce(mockBlocks2); // getPageBlocksTree for page-2

    const result = await queryByProperty(mockClient, 'priority', 'high');

    expect(result).toHaveLength(2);
    expect(result[0].properties).toHaveProperty('priority', 'high');
    expect(result[1].properties).toHaveProperty('priority', 'high');
  });

  it('should return empty array when no matches found', async () => {
    const mockPages = [
      { id: 10, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
    ];

    const mockBlocks = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Block without matching property',
        page: { id: 10 },
        parent: { id: 10 },
        left: { id: 10 },
        properties: { status: 'different' }
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages) // getAllPages
      .mockResolvedValueOnce(mockBlocks); // getPageBlocksTree

    const result = await queryByProperty(mockClient, 'status', 'nonexistent');

    expect(result).toEqual([]);
  });

  it('should include page context in results', async () => {
    const mockPages = [
      { id: 100, uuid: 'page-uuid-1', name: 'test page', originalName: 'Test Page' }
    ];

    const mockBlocks = [
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
        left: { id: 100 },
        properties: { category: 'work' }
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages) // getAllPages
      .mockResolvedValueOnce(mockBlocks); // getPageBlocksTree

    const result = await queryByProperty(mockClient, 'category', 'work');

    expect(result[0].page).toHaveProperty('id', 100);
    expect(result[0].page).toHaveProperty('uuid', 'page-uuid-1');
    expect(result[0].page).toHaveProperty('name', 'test page');
  });

  it('should handle blocks with multiple properties', async () => {
    const mockPages = [
      { id: 10, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
    ];

    const mockBlocks = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Block with multiple properties',
        page: { id: 10 },
        parent: { id: 10 },
        left: { id: 10 },
        properties: {
          status: 'done',
          priority: 'high',
          tags: ['important', 'urgent'],
          customField: 'value'
        },
        level: 2
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages) // getAllPages
      .mockResolvedValueOnce(mockBlocks); // getPageBlocksTree

    const result = await queryByProperty(mockClient, 'status', 'done');

    expect(result[0].properties).toEqual({
      status: 'done',
      priority: 'high',
      tags: ['important', 'urgent'],
      customField: 'value'
    });
    expect(result[0].level).toBe(2);
  });

  it('should handle numeric property values', async () => {
    const mockPages = [
      { id: 10, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
    ];

    const mockBlocks = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Block with numeric property',
        page: { id: 10 },
        parent: { id: 10 },
        left: { id: 10 },
        properties: { count: 42 }
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages) // getAllPages
      .mockResolvedValueOnce(mockBlocks); // getPageBlocksTree

    const result = await queryByProperty(mockClient, 'count', '42');

    expect(result[0].properties).toHaveProperty('count', 42);
  });

  it('should handle boolean property values', async () => {
    const mockPages = [
      { id: 10, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
    ];

    const mockBlocks = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Block with boolean property',
        page: { id: 10 },
        parent: { id: 10 },
        left: { id: 10 },
        properties: { completed: true }
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages) // getAllPages
      .mockResolvedValueOnce(mockBlocks); // getPageBlocksTree

    const result = await queryByProperty(mockClient, 'completed', 'true');

    expect(result[0].properties).toHaveProperty('completed', true);
  });

  it('should return null when getAllPages returns null', async () => {
    (mockClient.callAPI as any).mockResolvedValueOnce(null); // getAllPages returns null

    const result = await queryByProperty(mockClient, 'status', 'done');

    expect(result).toBeNull();
  });

  it('should propagate errors from the API client', async () => {
    (mockClient.callAPI as any).mockRejectedValue(
      new Error('Failed to connect to LogSeq API')
    );

    await expect(
      queryByProperty(mockClient, 'status', 'done')
    ).rejects.toThrow('Failed to connect to LogSeq API');
  });

  it('should search nested blocks recursively', async () => {
    const mockPages = [
      { id: 10, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
    ];

    const mockBlocks = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Parent block',
        page: { id: 10 },
        parent: { id: 10 },
        left: { id: 10 },
        properties: { status: 'pending' },
        children: [
          {
            id: 2,
            uuid: 'block-uuid-2',
            content: 'Nested block',
            page: { id: 10 },
            parent: { id: 1 },
            left: { id: 1 },
            properties: { status: 'done' },
            children: [
              {
                id: 3,
                uuid: 'block-uuid-3',
                content: 'Deeply nested block',
                page: { id: 10 },
                parent: { id: 2 },
                left: { id: 2 },
                properties: { status: 'done' }
              }
            ]
          }
        ]
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages) // getAllPages
      .mockResolvedValueOnce(mockBlocks); // getPageBlocksTree

    const result = await queryByProperty(mockClient, 'status', 'done');

    expect(result).toHaveLength(2);
    expect(result[0].uuid).toBe('block-uuid-2');
    expect(result[1].uuid).toBe('block-uuid-3');
  });
});
