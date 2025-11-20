import { describe, it, expect, vi } from 'vitest';
import { getRelatedPages } from './get-related-pages.js';
import { LogseqClient } from '../client.js';

describe('getRelatedPages', () => {
  it('should return pages connected through references', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock getPage call
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      uuid: 'uuid-1',
      name: 'Test Page',
      originalName: 'Test Page'
    });

    // Mock getPageLinkedReferences (returns tuples of [BlockEntity, PageEntity])
    (mockClient.callAPI as any).mockResolvedValueOnce([
      [
        { id: 10, uuid: 'block-uuid-1', content: '[[Test Page]]', page: { id: 2 }, parent: { id: 0 }, left: { id: 0 } },
        { id: 2, uuid: 'uuid-2', name: 'Related Page 1', originalName: 'Related Page 1' }
      ],
      [
        { id: 11, uuid: 'block-uuid-2', content: '[[Test Page]]', page: { id: 3 }, parent: { id: 0 }, left: { id: 0 } },
        { id: 3, uuid: 'uuid-3', name: 'Related Page 2', originalName: 'Related Page 2' }
      ]
    ]);

    const result = await getRelatedPages(mockClient, 'Test Page', 1);

    expect(result).toHaveProperty('sourcePage');
    expect(result).toHaveProperty('relatedPages');
    expect(result.relatedPages).toHaveLength(2);
    expect(result.relatedPages[0].relationshipType).toBe('inbound-reference');
  });

  it('should limit depth of traversal', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValue({
      id: 1,
      uuid: 'uuid-1',
      name: 'Test Page',
      originalName: 'Test Page'
    });

    const result = await getRelatedPages(mockClient, 'Test Page', 0);

    expect(result.relatedPages).toHaveLength(0);
  });

  it('should handle page not found', async () => {
    const mockClient = {
      callAPI: vi.fn().mockResolvedValue(null)
    } as unknown as LogseqClient;

    await expect(getRelatedPages(mockClient, 'Missing Page', 1))
      .rejects.toThrow('Page not found: Missing Page');
  });
});
