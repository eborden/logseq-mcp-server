import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchBlocks } from './search-blocks.js';
import { LogseqClient } from '../client.js';
import { BlockEntity, PageEntity } from '../types.js';

describe('searchBlocks', () => {
  let mockClient: LogseqClient;

  beforeEach(() => {
    mockClient = {
      callAPI: vi.fn(),
      executeDatalogQuery: vi.fn()
    } as any;
  });

  it('should use Editor API to search blocks', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
    ];

    const mockBlocks: BlockEntity[] = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Test search term',
        page: { id: 1 },
        parent: { id: 1 },
        left: { id: 1 }
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages)  // getAllPages
      .mockResolvedValueOnce(mockBlocks); // getPageBlocksTree

    const result = await searchBlocks(mockClient, 'search term');

    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getAllPages');
    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getPageBlocksTree', ['test-page']);
    expect(result).toHaveLength(1);
    expect(result![0].content).toBe('Test search term');
  });

  it('should return array of blocks matching search query', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'page-uuid-1', name: 'page1', originalName: 'Page 1' },
      { id: 2, uuid: 'page-uuid-2', name: 'page2', originalName: 'Page 2' }
    ];

    const mockBlocks1: BlockEntity[] = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'First match for keyword',
        page: { id: 1 },
        parent: { id: 1 },
        left: { id: 1 }
      }
    ];

    const mockBlocks2: BlockEntity[] = [
      {
        id: 2,
        uuid: 'block-uuid-2',
        content: 'Second match with keyword',
        page: { id: 2 },
        parent: { id: 2 },
        left: { id: 2 }
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages)   // getAllPages
      .mockResolvedValueOnce(mockBlocks1) // getPageBlocksTree for page1
      .mockResolvedValueOnce(mockBlocks2); // getPageBlocksTree for page2

    const result = await searchBlocks(mockClient, 'keyword');

    expect(result).toHaveLength(2);
    expect(result![0]).toHaveProperty('content', 'First match for keyword');
    expect(result![1]).toHaveProperty('content', 'Second match with keyword');
  });

  it('should return empty array when no matches found', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
    ];

    const mockBlocks: BlockEntity[] = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Different content',
        page: { id: 1 },
        parent: { id: 1 },
        left: { id: 1 }
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages)  // getAllPages
      .mockResolvedValueOnce(mockBlocks); // getPageBlocksTree

    const result = await searchBlocks(mockClient, 'nonexistent');

    expect(result).toEqual([]);
  });

  it('should include page context in results', async () => {
    const mockPages: PageEntity[] = [
      { id: 100, uuid: 'page-uuid-1', name: 'test page', originalName: 'Test Page' }
    ];

    const mockBlocks: BlockEntity[] = [
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

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages)  // getAllPages
      .mockResolvedValueOnce(mockBlocks); // getPageBlocksTree

    const result = await searchBlocks(mockClient, 'context');

    expect(result![0].page).toHaveProperty('id', 100);
    expect(result![0].page).toHaveProperty('uuid', 'page-uuid-1');
    expect(result![0].page).toHaveProperty('name', 'test page');
  });

  it('should handle blocks with properties', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
    ];

    const mockBlocks: BlockEntity[] = [
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

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages)  // getAllPages
      .mockResolvedValueOnce(mockBlocks); // getPageBlocksTree

    const result = await searchBlocks(mockClient, 'properties');

    expect(result![0]).toHaveProperty('properties');
    expect(result![0].properties).toEqual({
      tags: ['important'],
      status: 'done'
    });
    expect(result![0].level).toBe(2);
  });

  it('should handle special characters in search query', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
    ];

    const mockBlocks: BlockEntity[] = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Block with "quotes"',
        page: { id: 10 },
        parent: { id: 10 },
        left: { id: 10 }
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages)  // getAllPages
      .mockResolvedValueOnce(mockBlocks); // getPageBlocksTree

    const result = await searchBlocks(mockClient, 'quotes');

    expect(result).toHaveLength(1);
    expect(result![0].content).toBe('Block with "quotes"');
  });

  it('should return null when API returns null', async () => {
    (mockClient.callAPI as any).mockResolvedValueOnce(null); // getAllPages returns null

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

  it('should search nested children blocks recursively', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
    ];

    const mockBlocks: BlockEntity[] = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Parent block',
        page: { id: 1 },
        parent: { id: 1 },
        left: { id: 1 },
        children: [
          {
            id: 2,
            uuid: 'block-uuid-2',
            content: 'Child block with keyword',
            page: { id: 1 },
            parent: { id: 1 },
            left: { id: 1 }
          }
        ]
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages)  // getAllPages
      .mockResolvedValueOnce(mockBlocks); // getPageBlocksTree

    const result = await searchBlocks(mockClient, 'keyword');

    expect(result).toHaveLength(1);
    expect(result![0].content).toBe('Child block with keyword');
  });

  it('should respect limit parameter', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
    ];

    const mockBlocks: BlockEntity[] = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'First match',
        page: { id: 1 },
        parent: { id: 1 },
        left: { id: 1 }
      },
      {
        id: 2,
        uuid: 'block-uuid-2',
        content: 'Second match',
        page: { id: 1 },
        parent: { id: 1 },
        left: { id: 1 }
      },
      {
        id: 3,
        uuid: 'block-uuid-3',
        content: 'Third match',
        page: { id: 1 },
        parent: { id: 1 },
        left: { id: 1 }
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages)  // getAllPages
      .mockResolvedValueOnce(mockBlocks); // getPageBlocksTree

    const result = await searchBlocks(mockClient, 'match', 2);

    expect(result).toHaveLength(2);
    expect(result![0].content).toBe('First match');
    expect(result![1].content).toBe('Second match');
  });

  it('should perform case-insensitive search', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
    ];

    const mockBlocks: BlockEntity[] = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Block with UPPERCASE keyword',
        page: { id: 1 },
        parent: { id: 1 },
        left: { id: 1 }
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages)  // getAllPages
      .mockResolvedValueOnce(mockBlocks); // getPageBlocksTree

    const result = await searchBlocks(mockClient, 'uppercase');

    expect(result).toHaveLength(1);
    expect(result![0].content).toBe('Block with UPPERCASE keyword');
  });

  it('should include semantic context when requested', async () => {
    const mockPages: PageEntity[] = [
      { id: 100, uuid: 'page-uuid-1', name: 'Container Page', originalName: 'Container Page' }
    ];

    const mockBlocks: BlockEntity[] = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Test block with [[PageA]] and #tag1',
        page: {
          id: 100,
          uuid: 'page-uuid-1',
          name: 'Container Page',
          originalName: 'Container Page'
        },
        parent: { id: 100 },
        left: { id: 100 }
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages)      // getAllPages
      .mockResolvedValueOnce(mockBlocks);    // getPageBlocksTree

    const result = await searchBlocks(mockClient, 'Test', undefined, true);

    expect(result).toHaveLength(1);
    expect(result![0]).toHaveProperty('context');
    expect(result![0].context).toHaveProperty('page');
    expect(result![0].context!.page).toEqual(mockPages[0]);
    expect(result![0].context).toHaveProperty('references');
    expect(result![0].context!.references).toEqual(['PageA']);
    expect(result![0].context).toHaveProperty('tags');
    expect(result![0].context!.tags).toEqual(['tag1']);
  });

  it('should extract multiple references and tags from block content', async () => {
    const mockPages: PageEntity[] = [
      { id: 100, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
    ];

    const mockBlocks: BlockEntity[] = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Complex block [[PageA]] [[PageB]] #tag1 #tag2 #tag-with-dash',
        page: {
          id: 100,
          uuid: 'page-uuid-1',
          name: 'test-page',
          originalName: 'Test Page'
        },
        parent: { id: 100 },
        left: { id: 100 }
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages)      // getAllPages
      .mockResolvedValueOnce(mockBlocks);    // getPageBlocksTree

    const result = await searchBlocks(mockClient, 'Complex', undefined, true);

    expect(result![0].context!.references).toEqual(['PageA', 'PageB']);
    expect(result![0].context!.tags).toEqual(['tag1', 'tag2', 'tag-with-dash']);
  });

  it('should not include context when includeContext is false', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
    ];

    const mockBlocks: BlockEntity[] = [
      {
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Test block',
        page: { id: 1 },
        parent: { id: 1 },
        left: { id: 1 }
      }
    ];

    (mockClient.callAPI as any)
      .mockResolvedValueOnce(mockPages)  // getAllPages
      .mockResolvedValueOnce(mockBlocks); // getPageBlocksTree

    const result = await searchBlocks(mockClient, 'Test', undefined, false);

    expect(result).toHaveLength(1);
    expect(result![0]).not.toHaveProperty('context');
  });

  // Slim results tests
  describe('slim results mode', () => {
    it('should return slim results when slimResults=true', async () => {
      const mockPages: PageEntity[] = [
        { id: 1, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
      ];

      const mockBlocks: BlockEntity[] = [
        {
          id: 10,
          uuid: 'block-uuid',
          content: 'Search with #tag and [[Reference]]',
          page: { id: 1 },
          parent: { id: 1 },
          left: { id: 1 }
        }
      ];

      (mockClient.callAPI as any)
        .mockResolvedValueOnce(mockPages)
        .mockResolvedValueOnce(mockBlocks);

      const result = await searchBlocks(mockClient, 'Search', 100, false, true);

      expect(result).toHaveLength(1);
      const block = result![0];
      expect(block).toHaveProperty('content', 'Search with #tag and [[Reference]]');
      expect(block).toHaveProperty('pageName', 'Test Page');
      expect(block).toHaveProperty('tags', ['tag']);
      expect(block).toHaveProperty('pageRefs', ['Reference']);
      expect(block).toHaveProperty('uuid', 'block-uuid');
      expect(block).not.toHaveProperty('id');
      expect(block).not.toHaveProperty('page');
    });

    it('should return slim results with context when both includeContext and slimResults are true', async () => {
      const mockPages: PageEntity[] = [
        {
          id: 100,
          uuid: 'page-uuid-1',
          name: 'container page',
          originalName: 'Container Page',
          properties: { type: 'notes' },
          'journal?': false
        }
      ];

      const mockBlocks: BlockEntity[] = [
        {
          id: 10,
          uuid: 'block-uuid',
          content: 'Block with [[Link]] and #hashtag',
          page: { id: 100 },
          parent: { id: 100 },
          left: { id: 100 }
        }
      ];

      (mockClient.callAPI as any)
        .mockResolvedValueOnce(mockPages)
        .mockResolvedValueOnce(mockBlocks);

      const result = await searchBlocks(mockClient, 'Block', 100, true, true);

      expect(result).toHaveLength(1);
      const block = result![0];

      // Check slim block properties
      expect(block).toHaveProperty('content');
      expect(block).toHaveProperty('pageName', 'Container Page');
      expect(block).toHaveProperty('uuid', 'block-uuid');
      expect(block).not.toHaveProperty('id');

      // Check slim context
      expect(block).toHaveProperty('context');
      expect(block.context!.page).toEqual({
        name: 'container page',
        originalName: 'Container Page',
        properties: { type: 'notes' }
      });
      expect(block.context!.references).toEqual(['Link']);
      expect(block.context!.tags).toEqual(['hashtag']);

      // Verify context.page doesn't have verbose fields
      expect(block.context!.page).not.toHaveProperty('id');
      expect(block.context!.page).not.toHaveProperty('uuid');
    });

    it('should preserve nested children in slim results', async () => {
      const mockPages: PageEntity[] = [
        { id: 1, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
      ];

      const mockBlocks: BlockEntity[] = [
        {
          id: 10,
          uuid: 'parent-uuid',
          content: 'Parent with keyword',
          page: { id: 1 },
          parent: { id: 1 },
          left: { id: 1 },
          children: [
            {
              id: 11,
              uuid: 'child-uuid',
              content: 'Child block',
              page: { id: 1 },
              parent: { id: 10 },
              left: { id: 10 }
            }
          ]
        }
      ];

      (mockClient.callAPI as any)
        .mockResolvedValueOnce(mockPages)
        .mockResolvedValueOnce(mockBlocks);

      const result = await searchBlocks(mockClient, 'keyword', 100, false, true);

      expect(result).toHaveLength(1);
      const block = result![0];
      expect(block.children).toHaveLength(1);
      expect(block.children![0].content).toBe('Child block');
      expect(block.children![0].uuid).toBe('child-uuid');
      expect(block.children![0]).not.toHaveProperty('id');
    });

    it('should return full results when slimResults=false (default)', async () => {
      const mockPages: PageEntity[] = [
        { id: 1, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
      ];

      const mockBlocks: BlockEntity[] = [
        {
          id: 10,
          uuid: 'block-uuid',
          content: 'Test block',
          page: { id: 1 },
          parent: { id: 1 },
          left: { id: 1 }
        }
      ];

      (mockClient.callAPI as any)
        .mockResolvedValueOnce(mockPages)
        .mockResolvedValueOnce(mockBlocks);

      const result = await searchBlocks(mockClient, 'Test', 100, false, false);

      expect(result).toHaveLength(1);
      const block = result![0];
      expect(block).toHaveProperty('id', 10);
      expect(block).toHaveProperty('uuid', 'block-uuid');
      expect(block).toHaveProperty('page');
    });

    it('should omit empty fields in slim results', async () => {
      const mockPages: PageEntity[] = [
        { id: 1, uuid: 'page-uuid-1', name: 'test-page', originalName: 'Test Page' }
      ];

      const mockBlocks: BlockEntity[] = [
        {
          id: 10,
          uuid: 'block-uuid',
          content: 'Simple block no extras',
          page: { id: 1 },
          parent: { id: 1 },
          left: { id: 1 }
        }
      ];

      (mockClient.callAPI as any)
        .mockResolvedValueOnce(mockPages)
        .mockResolvedValueOnce(mockBlocks);

      const result = await searchBlocks(mockClient, 'Simple', 100, false, true);

      const block = result![0];
      expect(block).not.toHaveProperty('properties');
      expect(block).not.toHaveProperty('marker');
      expect(block).not.toHaveProperty('tags');
      expect(block).not.toHaveProperty('pageRefs');
      expect(block).not.toHaveProperty('children');
    });
  });
});
