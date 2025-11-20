import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPage } from './get-page.js';
import { LogseqClient } from '../client.js';
import { PageEntity } from '../types.js';

describe('getPage', () => {
  let mockClient: LogseqClient;

  beforeEach(() => {
    mockClient = {
      callAPI: vi.fn()
    } as any;
  });

  it('should call logseq.Editor.getPage with page name only when includeChildren is false', async () => {
    const mockPage: PageEntity = {
      id: 1,
      uuid: 'page-uuid-123',
      name: 'test page',
      originalName: 'Test Page'
    };

    (mockClient.callAPI as any).mockResolvedValue(mockPage);

    const result = await getPage(mockClient, 'test page', false);

    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getPage', ['test page']);
    expect(result).toEqual(mockPage);
  });

  it('should call logseq.Editor.getPage with page name and options when includeChildren is true', async () => {
    const mockPage: PageEntity = {
      id: 1,
      uuid: 'page-uuid-123',
      name: 'test page',
      originalName: 'Test Page',
      children: []
    };

    (mockClient.callAPI as any).mockResolvedValue(mockPage);

    const result = await getPage(mockClient, 'test page', true);

    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getPage', [
      'test page',
      { includeChildren: true }
    ]);
    expect(result).toEqual(mockPage);
  });

  it('should throw error if page not found (result is null)', async () => {
    (mockClient.callAPI as any).mockResolvedValue(null);

    await expect(
      getPage(mockClient, 'nonexistent-page', false)
    ).rejects.toThrow('Page not found: nonexistent-page');
  });

  it('should return PageEntity with all properties', async () => {
    const mockPage: PageEntity = {
      id: 42,
      uuid: 'page-uuid-456',
      name: 'my awesome page',
      originalName: 'My Awesome Page',
      properties: {
        tags: ['important', 'project'],
        customProp: 'value'
      },
      journal: false,
      updatedAt: 1699999999000
    };

    (mockClient.callAPI as any).mockResolvedValue(mockPage);

    const result = await getPage(mockClient, 'my awesome page', false);

    expect(result).toEqual(mockPage);
    expect(result.id).toBe(42);
    expect(result.uuid).toBe('page-uuid-456');
    expect(result.name).toBe('my awesome page');
    expect(result.properties).toEqual({
      tags: ['important', 'project'],
      customProp: 'value'
    });
  });

  it('should handle journal pages', async () => {
    const mockPage: PageEntity = {
      id: 100,
      uuid: 'journal-uuid',
      name: '2024-11-20',
      originalName: '2024-11-20',
      journal: true,
      journalDay: 20241120
    };

    (mockClient.callAPI as any).mockResolvedValue(mockPage);

    const result = await getPage(mockClient, '2024-11-20', false);

    expect(result.journal).toBe(true);
    expect(result.journalDay).toBe(20241120);
  });

  it('should handle pages with children when includeChildren is true', async () => {
    const mockPage: PageEntity = {
      id: 1,
      uuid: 'page-uuid-123',
      name: 'test page',
      originalName: 'Test Page',
      children: [
        {
          id: 10,
          uuid: 'block-uuid-1',
          content: 'First block',
          page: { id: 1 },
          parent: { id: 1 },
          left: { id: 1 }
        },
        {
          id: 11,
          uuid: 'block-uuid-2',
          content: 'Second block',
          page: { id: 1 },
          parent: { id: 1 },
          left: { id: 10 }
        }
      ]
    };

    (mockClient.callAPI as any).mockResolvedValue(mockPage);

    const result = await getPage(mockClient, 'test page', true);

    expect(result.children).toHaveLength(2);
    expect(result.children?.[0]).toHaveProperty('content', 'First block');
    expect(result.children?.[1]).toHaveProperty('content', 'Second block');
  });

  it('should propagate errors from the API client', async () => {
    (mockClient.callAPI as any).mockRejectedValue(
      new Error('Failed to connect to LogSeq API')
    );

    await expect(
      getPage(mockClient, 'test page', false)
    ).rejects.toThrow('Failed to connect to LogSeq API');
  });
});
