import { describe, it, expect, vi } from 'vitest';
import { buildContextForTopicHTTP } from './build-context-http.js';
import { LogseqClient } from '../client.js';

describe('buildContextForTopicHTTP', () => {
  it('should gather comprehensive context for a topic', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock getPage
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      uuid: 'page-uuid-1',
      name: 'Test Topic',
      originalName: 'Test Topic',
      properties: { type: 'concept' }
    });

    // Mock page blocks
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 10,
        uuid: 'block-uuid-10',
        content: 'Main definition of [[Test Topic]]',
        page: { id: 1 },
        parent: { id: 1 },
        left: { id: 1 }
      },
      {
        id: 11,
        uuid: 'block-uuid-11',
        content: 'Related information',
        page: { id: 1 },
        parent: { id: 1 },
        left: { id: 10 }
      }
    ]);

    // Mock related pages
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 2, uuid: 'page-uuid-2', name: 'Related Page 1', originalName: 'Related Page 1' }
    ]);

    // Mock backlinks
    (mockClient.callAPI as any).mockResolvedValueOnce([
      [
        {
          id: 20,
          uuid: 'block-uuid-20',
          content: 'References [[Test Topic]]',
          page: { id: 3 },
          parent: { id: 3 },
          left: { id: 3 }
        },
        {
          id: 3,
          uuid: 'page-uuid-3',
          name: 'Referencing Page',
          originalName: 'Referencing Page'
        }
      ]
    ]);

    const result = await buildContextForTopicHTTP(mockClient, 'Test Topic');

    expect(result).toHaveProperty('topic', 'Test Topic');
    expect(result).toHaveProperty('mainPage');
    expect(result).toHaveProperty('directBlocks');
    expect(result).toHaveProperty('relatedPages');
    expect(result).toHaveProperty('references');
    expect(result).toHaveProperty('summary');
  });

  it('should limit context size', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      uuid: 'page-uuid-1',
      name: 'Topic',
      originalName: 'Topic'
    });

    // Return many blocks
    const manyBlocks = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      uuid: `block-uuid-${i}`,
      content: `Block ${i}`,
      page: { id: 1 },
      parent: { id: 1 },
      left: { id: i > 0 ? i - 1 : 1 }
    }));

    (mockClient.callAPI as any).mockResolvedValueOnce(manyBlocks);
    (mockClient.callAPI as any).mockResolvedValue([]);

    const result = await buildContextForTopicHTTP(
      mockClient,
      'Topic',
      { maxBlocks: 10 }
    );

    expect(result.directBlocks.length).toBeLessThanOrEqual(10);
  });

  it('should include temporal context for journal pages', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      uuid: 'journal-uuid',
      name: 'nov 20th, 2025',
      originalName: 'nov 20th, 2025',
      journalDay: 20251120,
      journal: true
    });

    (mockClient.callAPI as any).mockResolvedValue([]);

    const result = await buildContextForTopicHTTP(mockClient, 'nov 20th, 2025');

    expect(result).toHaveProperty('temporalContext');
    expect(result.temporalContext).toHaveProperty('isJournal', true);
    expect(result.temporalContext).toHaveProperty('date', 20251120);
  });

  it('should handle missing page gracefully', async () => {
    const mockClient = {
      callAPI: vi.fn().mockResolvedValue(null)
    } as unknown as LogseqClient;

    await expect(buildContextForTopicHTTP(mockClient, 'NonExistent'))
      .rejects.toThrow('Page not found: NonExistent');
  });
});
