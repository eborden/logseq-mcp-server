import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBlock } from './get-block.js';
import { LogseqClient } from '../client.js';
import { BlockEntity } from '../types.js';

describe('getBlock', () => {
  let mockClient: LogseqClient;

  beforeEach(() => {
    mockClient = {
      callAPI: vi.fn()
    } as any;
  });

  it('should call logseq.Editor.getBlock with UUID only when includeChildren is false', async () => {
    const mockBlock: BlockEntity = {
      id: 1,
      uuid: 'block-uuid-123',
      content: 'Test block content',
      page: { id: 10 },
      parent: { id: 10 },
      left: { id: 10 }
    };

    (mockClient.callAPI as any).mockResolvedValue(mockBlock);

    const result = await getBlock(mockClient, 'block-uuid-123', false);

    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getBlock', ['block-uuid-123']);
    expect(result).toEqual(mockBlock);
  });

  it('should call logseq.Editor.getBlock with UUID and options when includeChildren is true', async () => {
    const mockBlock: BlockEntity = {
      id: 1,
      uuid: 'block-uuid-123',
      content: 'Parent block',
      page: { id: 10 },
      parent: { id: 10 },
      left: { id: 10 },
      children: []
    };

    (mockClient.callAPI as any).mockResolvedValue(mockBlock);

    const result = await getBlock(mockClient, 'block-uuid-123', true);

    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getBlock', [
      'block-uuid-123',
      { includeChildren: true }
    ]);
    expect(result).toEqual(mockBlock);
  });

  it('should throw error if block not found (result is null)', async () => {
    (mockClient.callAPI as any).mockResolvedValue(null);

    await expect(
      getBlock(mockClient, 'nonexistent-uuid', false)
    ).rejects.toThrow('Block not found: nonexistent-uuid');
  });

  it('should return BlockEntity with all properties', async () => {
    const mockBlock: BlockEntity = {
      id: 42,
      uuid: 'block-uuid-456',
      content: 'Block with properties',
      format: 'markdown',
      page: { id: 100 },
      parent: { id: 100 },
      left: { id: 100 },
      level: 2,
      properties: {
        tags: ['important'],
        customField: 'value'
      },
      unordered: true
    };

    (mockClient.callAPI as any).mockResolvedValue(mockBlock);

    const result = await getBlock(mockClient, 'block-uuid-456', false);

    expect(result).toEqual(mockBlock);
    expect(result.id).toBe(42);
    expect(result.uuid).toBe('block-uuid-456');
    expect(result.content).toBe('Block with properties');
    expect(result.format).toBe('markdown');
    expect(result.level).toBe(2);
    expect(result.properties).toEqual({
      tags: ['important'],
      customField: 'value'
    });
  });

  it('should handle blocks with children when includeChildren is true', async () => {
    const mockBlock: BlockEntity = {
      id: 1,
      uuid: 'parent-uuid',
      content: 'Parent block',
      page: { id: 10 },
      parent: { id: 10 },
      left: { id: 10 },
      children: [
        {
          id: 2,
          uuid: 'child-uuid-1',
          content: 'First child',
          page: { id: 10 },
          parent: { id: 1 },
          left: { id: 1 }
        },
        {
          id: 3,
          uuid: 'child-uuid-2',
          content: 'Second child',
          page: { id: 10 },
          parent: { id: 1 },
          left: { id: 2 }
        }
      ]
    };

    (mockClient.callAPI as any).mockResolvedValue(mockBlock);

    const result = await getBlock(mockClient, 'parent-uuid', true);

    expect(result.children).toHaveLength(2);
    expect(result.children?.[0]).toHaveProperty('content', 'First child');
    expect(result.children?.[1]).toHaveProperty('content', 'Second child');
  });

  it('should handle blocks with metadata', async () => {
    const mockBlock: BlockEntity = {
      id: 100,
      uuid: 'block-with-meta',
      content: 'Block with metadata',
      page: { id: 50 },
      parent: { id: 50 },
      left: { id: 50 },
      meta: {
        startPos: 0,
        endPos: 100,
        properties: { created: 1699999999 },
        timestamps: { created: 1699999999 }
      }
    };

    (mockClient.callAPI as any).mockResolvedValue(mockBlock);

    const result = await getBlock(mockClient, 'block-with-meta', false);

    expect(result.meta).toBeDefined();
    expect(result.meta?.startPos).toBe(0);
    expect(result.meta?.endPos).toBe(100);
  });

  it('should propagate errors from the API client', async () => {
    (mockClient.callAPI as any).mockRejectedValue(
      new Error('Failed to connect to LogSeq API')
    );

    await expect(
      getBlock(mockClient, 'block-uuid-123', false)
    ).rejects.toThrow('Failed to connect to LogSeq API');
  });
});
