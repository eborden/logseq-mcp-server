import { describe, it, expect, vi } from 'vitest';
import { getRelatedPages } from './get-related-pages.js';
import { LogseqClient } from '../client.js';

describe('getRelatedPages', () => {
  it('should return pages connected through references', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock getPage call (source page)
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      uuid: 'uuid-1',
      name: 'Test Page',
      originalName: 'Test Page'
    });

    // Mock getPageBlocksTree (for outbound references)
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 100,
        uuid: 'block-uuid-100',
        content: 'This page references [[Outbound Page 1]] and [[Outbound Page 2]]',
        page: { id: 1 },
        parent: { id: 0 },
        left: { id: 0 }
      }
    ]);

    // Mock getPage calls for outbound references
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 4,
      uuid: 'uuid-4',
      name: 'Outbound Page 1',
      originalName: 'Outbound Page 1'
    });
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 5,
      uuid: 'uuid-5',
      name: 'Outbound Page 2',
      originalName: 'Outbound Page 2'
    });

    // Mock getPageLinkedReferences (returns tuples of [BlockEntity, PageEntity])
    (mockClient.callAPI as any).mockResolvedValueOnce([
      [
        { id: 10, uuid: 'block-uuid-1', content: '[[Test Page]]', page: { id: 2 }, parent: { id: 0 }, left: { id: 0 } },
        { id: 2, uuid: 'uuid-2', name: 'Inbound Page 1', originalName: 'Inbound Page 1' }
      ],
      [
        { id: 11, uuid: 'block-uuid-2', content: '[[Test Page]]', page: { id: 3 }, parent: { id: 0 }, left: { id: 0 } },
        { id: 3, uuid: 'uuid-3', name: 'Inbound Page 2', originalName: 'Inbound Page 2' }
      ]
    ]);

    const result = await getRelatedPages(mockClient, 'Test Page', 1);

    expect(result).toHaveProperty('sourcePage');
    expect(result).toHaveProperty('relatedPages');
    expect(result.relatedPages).toHaveLength(4);

    // Verify outbound references
    const outboundRefs = result.relatedPages.filter(r => r.relationshipType === 'outbound-reference');
    expect(outboundRefs).toHaveLength(2);
    expect(outboundRefs[0].page.name).toBe('Outbound Page 1');
    expect(outboundRefs[1].page.name).toBe('Outbound Page 2');

    // Verify inbound references
    const inboundRefs = result.relatedPages.filter(r => r.relationshipType === 'inbound-reference');
    expect(inboundRefs).toHaveLength(2);
    expect(inboundRefs[0].page.name).toBe('Inbound Page 1');
    expect(inboundRefs[1].page.name).toBe('Inbound Page 2');
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

  it('should extract references from nested blocks', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock getPage call (source page)
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      uuid: 'uuid-1',
      name: 'Test Page',
      originalName: 'Test Page'
    });

    // Mock getPageBlocksTree with nested blocks
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 100,
        uuid: 'block-uuid-100',
        content: 'Parent block references [[Page A]]',
        page: { id: 1 },
        parent: { id: 0 },
        left: { id: 0 },
        children: [
          {
            id: 101,
            uuid: 'block-uuid-101',
            content: 'Child block references [[Page B]]',
            page: { id: 1 },
            parent: { id: 100 },
            left: { id: 0 },
            children: [
              {
                id: 102,
                uuid: 'block-uuid-102',
                content: 'Nested child references [[Page C]]',
                page: { id: 1 },
                parent: { id: 101 },
                left: { id: 0 }
              }
            ]
          }
        ]
      }
    ]);

    // Mock getPage calls for outbound references
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 2,
      uuid: 'uuid-2',
      name: 'Page A',
      originalName: 'Page A'
    });
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 3,
      uuid: 'uuid-3',
      name: 'Page B',
      originalName: 'Page B'
    });
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 4,
      uuid: 'uuid-4',
      name: 'Page C',
      originalName: 'Page C'
    });

    // Mock getPageLinkedReferences (no inbound references)
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    const result = await getRelatedPages(mockClient, 'Test Page', 1);

    expect(result.relatedPages).toHaveLength(3);
    expect(result.relatedPages.every(r => r.relationshipType === 'outbound-reference')).toBe(true);
    expect(result.relatedPages.map(r => r.page.name)).toEqual(['Page A', 'Page B', 'Page C']);
  });
});
