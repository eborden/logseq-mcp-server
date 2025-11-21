import { describe, it, expect, vi } from 'vitest';
import { searchByRelationshipHTTP } from './search-by-relationship-http.js';
import { LogseqClient } from '../client.js';

describe('searchByRelationshipHTTP', () => {
  it('should find blocks about topic that reference another page', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock search for topic
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'Discussion about [[Topic]] and [[RelatedPage]]',
        refs: [{ id: 10, name: 'Topic' }, { id: 20, name: 'RelatedPage' }]
      },
      {
        id: 2,
        content: 'Just about [[Topic]]',
        refs: [{ id: 10, name: 'Topic' }]
      }
    ]);

    const result = await searchByRelationshipHTTP(
      mockClient,
      'Topic',
      'RelatedPage',
      'references'
    );

    expect(result).toHaveProperty('query');
    expect(result).toHaveProperty('results');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe(1);
  });

  it('should find blocks in pages that have backlinks to target', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock getting pages that link to target (getPageLinkedReferences returns [BlockEntity, PageEntity][])
    (mockClient.callAPI as any).mockResolvedValueOnce([
      [
        { id: 1, content: 'Links to [[TargetPage]]' },
        { id: 100, name: 'Linking Page 1', uuid: 'page-1', originalName: 'Linking Page 1' }
      ],
      [
        { id: 2, content: 'Also links to [[TargetPage]]' },
        { id: 101, name: 'Linking Page 2', uuid: 'page-2', originalName: 'Linking Page 2' }
      ]
    ]);

    // Mock getting blocks from first page about topic
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 3,
        content: 'About [[Topic]]',
        page: { id: 100 },
        parent: { id: 100 },
        left: { id: 100 },
        uuid: 'block-3'
      }
    ]);

    // Mock getting blocks from second page (no matches)
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    const result = await searchByRelationshipHTTP(
      mockClient,
      'Topic',
      'TargetPage',
      'in-pages-linking-to'
    );

    expect(result.results).toHaveLength(1);
    expect(result.relationshipType).toBe('in-pages-linking-to');
  });

  it('should handle no results gracefully', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValue([]);

    const result = await searchByRelationshipHTTP(
      mockClient,
      'NonExistent',
      'AlsoNonExistent',
      'references'
    );

    expect(result.results).toHaveLength(0);
  });

  it('should support connected-within relationship', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock getting root page
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      uuid: 'page-1',
      name: 'TopicA',
      originalName: 'TopicA'
    });

    // Mock getting blocks from TopicA (contains reference to TopicB)
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        uuid: 'block-1',
        content: 'This links to [[TopicB]]',
        page: { id: 1 },
        parent: { id: 1 },
        left: { id: 1 }
      }
    ]);

    // Mock getting blocks from TopicA again (for final result)
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        uuid: 'block-1',
        content: 'This links to [[TopicB]]',
        page: { id: 1 },
        parent: { id: 1 },
        left: { id: 1 }
      }
    ]);

    // Mock getting blocks from TopicB (for final result)
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 2,
        uuid: 'block-2',
        content: 'TopicB content',
        page: { id: 2 },
        parent: { id: 2 },
        left: { id: 2 }
      }
    ]);

    const result = await searchByRelationshipHTTP(
      mockClient,
      'TopicA',
      'TopicB',
      'connected-within',
      2
    );

    expect(result.relationshipType).toBe('connected-within');
    expect(result.results.length).toBeGreaterThan(0);
  });
});
