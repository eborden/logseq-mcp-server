import { describe, it, expect, vi } from 'vitest';
import { buildContextForTopicDatalog } from './build-context-datalog.js';
import { LogseqClient } from '../client.js';

describe('buildContextForTopicDatalog', () => {
  it('should execute Datalog query and transform results to context', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Mock Datalog query results: [[page, block]]
    (mockClient.executeDatalogQuery as any).mockResolvedValue([
      [{ id: 1, name: 'Topic', properties: {} }, { id: 10, content: 'Block 1' }],
      [{ id: 1, name: 'Topic', properties: {} }, { id: 11, content: 'Block 2' }],
      [{ id: 1, name: 'Topic', properties: {} }, null] // Page with no block
    ]);

    const result = await buildContextForTopicDatalog(mockClient, 'Topic', {});

    expect(mockClient.executeDatalogQuery).toHaveBeenCalledOnce();
    expect(result.topic).toBe('Topic');
    expect(result.mainPage.id).toBe(1);
    expect(result.directBlocks.length).toBe(2); // Two blocks found
  });

  it('should throw error when page not found', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Empty results = page not found
    (mockClient.executeDatalogQuery as any).mockResolvedValue([]);

    await expect(
      buildContextForTopicDatalog(mockClient, 'NonExistent', {})
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

    const result = await buildContextForTopicDatalog(mockClient, 'Topic', {
      maxBlocks: 10
    });

    expect(result.directBlocks.length).toBeLessThanOrEqual(10);
  });
});
