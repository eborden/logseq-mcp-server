import { describe, it, expect, vi } from 'vitest';
import { buildContextForTopic } from './build-context.js';
import { LogseqClient } from '../client.js';

describe('buildContextForTopic', () => {
  it('should execute Datalog queries and transform results to context', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn(),
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 1: Get page
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 1, name: 'Topic', properties: {} }]
    ]);

    // Mock Query 2: Get blocks
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 10, content: 'Block 1' }],
      [{ id: 11, content: 'Block 2' }]
    ]);

    // Mock Query 3: Get backlinks (references) - format: [page, [blocks]]
    // relatedPages will be derived from this
    (mockClient.callAPI as any).mockResolvedValueOnce([
      [{ id: 3, name: 'Source Page' }, [{ id: 20, content: 'Block referencing Topic' }]]
    ]);

    const result = await buildContextForTopic(mockClient, 'Topic', {});

    // Should make 2 Datalog queries (page, blocks) + 1 HTTP API call (backlinks)
    expect(mockClient.executeDatalogQuery).toHaveBeenCalledTimes(2);
    expect(mockClient.callAPI).toHaveBeenCalledTimes(1);
    expect(result.topic).toBe('Topic');
    expect(result.mainPage.id).toBe(1);
    expect(result.directBlocks.length).toBe(2); // Two blocks found
    expect(result.relatedPages.length).toBe(1); // One related page (derived from backlinks)
    expect(result.references.length).toBe(1); // One reference found
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
      executeDatalogQuery: vi.fn(),
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 1: Get page
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 1, name: 'Topic', properties: {} }]
    ]);

    // Mock Query 2: Get many blocks
    const manyBlocks = Array.from({ length: 100 }, (_, i) => [
      { id: 10 + i, content: `Block ${i}` }
    ]);
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce(manyBlocks);

    // Mock Query 3: Get backlinks
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    const result = await buildContextForTopic(mockClient, 'Topic', {
      maxBlocks: 10
    });

    expect(result.directBlocks.length).toBeLessThanOrEqual(10);
  });

  it('should handle case-insensitive page names', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn(),
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 1: Get page (lowercase in DB)
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 1, name: 'christy', properties: {} }]
    ]);

    // Mock Query 2: Get blocks (empty)
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([]);

    // Mock Query 3: Get backlinks (empty)
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    // Should work with capital C
    const result = await buildContextForTopic(mockClient, 'Christy', {});

    expect(result.topic).toBe('Christy');
    expect(result.mainPage.id).toBe(1);
    expect(result.directBlocks.length).toBe(0); // No blocks
    expect(result.references.length).toBe(0); // No references

    // Verify query has lowercase embedded in it
    expect(mockClient.executeDatalogQuery).toHaveBeenCalledWith(
      expect.stringContaining('christy')  // Lowercased embedded in query
    );
  });

  it('should populate references with backlinks', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn(),
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 1: Get page
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 1, name: 'Topic', properties: {} }]
    ]);

    // Mock Query 2: Get blocks
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([]);

    // Mock Query 3: Get backlinks with multiple references - format: [page, [blocks]]
    (mockClient.callAPI as any).mockResolvedValueOnce([
      [{ id: 3, name: 'Page A' }, [{ id: 20, content: 'First reference' }]],
      [{ id: 4, name: 'Page B' }, [{ id: 21, content: 'Second reference' }]]
    ]);

    const result = await buildContextForTopic(mockClient, 'Topic', {});

    expect(result.references.length).toBe(2);
    expect(result.references[0].block.content).toBe('First reference');
    expect(result.references[0].sourcePage.name).toBe('Page A');
    expect(result.references[1].block.content).toBe('Second reference');
    expect(result.references[1].sourcePage.name).toBe('Page B');
    expect(result.summary.totalReferences).toBe(2);
    // Related pages should be derived from backlinks
    expect(result.relatedPages.length).toBe(2);
    expect(result.relatedPages[0].page.name).toBe('Page A');
    expect(result.relatedPages[1].page.name).toBe('Page B');
  });

  it('should handle db/id property format from Datalog queries', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn(),
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 1: Get page with db/id (Datalog format)
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ 'db/id': 22, name: 'zach', properties: {} }]
    ]);

    // Mock Query 2: Get blocks
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([]);

    // Mock Query 3: Get backlinks - relatedPages derived from this
    (mockClient.callAPI as any).mockResolvedValueOnce([
      [{ 'db/id': 95, name: 'Core' }, [{ id: 100, content: 'Mentions Zach' }]]
    ]);

    const result = await buildContextForTopic(mockClient, 'Zach', {});

    expect(result.mainPage['db/id']).toBe(22);
    expect(result.relatedPages.length).toBe(1);
    expect(result.relatedPages[0].page.name).toBe('Core');
    expect(result.relatedPages[0].relationshipType).toBe('inbound');
  });
});
