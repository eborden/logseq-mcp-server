import { describe, it, expect, vi } from 'vitest';
import { buildContextForTopic } from './build-context.js';
import { LogseqClient } from '../client.js';

describe('buildContextForTopic', () => {
  it('should execute Datalog query and transform results to context', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 1: Get page and blocks
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 1, name: 'Topic', properties: {} }, { id: 10, content: 'Block 1' }],
      [{ id: 1, name: 'Topic', properties: {} }, { id: 11, content: 'Block 2' }]
    ]);

    // Mock Query 2: Get connected pages
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [1, { id: 2, name: 'Related Page' }, 'outbound']
    ]);

    const result = await buildContextForTopic(mockClient, 'Topic', {});

    // Should make 2 queries (page+blocks, then connections)
    expect(mockClient.executeDatalogQuery).toHaveBeenCalledTimes(2);
    expect(result.topic).toBe('Topic');
    expect(result.mainPage.id).toBe(1);
    expect(result.directBlocks.length).toBe(2); // Two blocks found
    expect(result.relatedPages.length).toBe(1); // One related page found
  });

  it('should throw error when page not found', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Empty results = page not found
    (mockClient.executeDatalogQuery as any).mockResolvedValue([]);

    await expect(
      buildContextForTopic(mockClient, 'NonExistent', {})
    ).rejects.toThrow('Page not found: NonExistent');
  });

  it('should respect limits from options', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    const manyBlocks = Array.from({ length: 100 }, (_, i) => [
      { id: 1, name: 'Topic', properties: {} },
      { id: 10 + i, content: `Block ${i}` }
    ]);

    (mockClient.executeDatalogQuery as any).mockResolvedValue(manyBlocks);

    const result = await buildContextForTopic(mockClient, 'Topic', {
      maxBlocks: 10
    });

    expect(result.directBlocks.length).toBeLessThanOrEqual(10);
  });
});
