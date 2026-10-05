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

  it('should call logseq.Editor.getPage with page name only and skip the blocks tree when includeChildren is false', async () => {
    const mockPage: PageEntity = {
      id: 1,
      uuid: 'page-uuid-123',
      name: 'test page',
      originalName: 'Test Page'
    };

    (mockClient.callAPI as any).mockResolvedValue(mockPage);

    const result = await getPage(mockClient, 'test page', false);

    expect(mockClient.callAPI).toHaveBeenCalledTimes(1);
    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getPage', ['test page']);
    expect(mockClient.callAPI).not.toHaveBeenCalledWith(
      'logseq.Editor.getPageBlocksTree',
      expect.anything()
    );
    expect(result).toEqual(mockPage);
    expect(result.children).toBeUndefined();
  });

  it('should fetch the blocks tree separately and set it as children when includeChildren is true', async () => {
    const mockPage: PageEntity = {
      id: 1,
      uuid: 'page-uuid-123',
      name: 'test page',
      originalName: 'Test Page'
    };
    const tree = [
      { id: 10, uuid: 'block-uuid-1', content: 'First block' },
      { id: 11, uuid: 'block-uuid-2', content: 'Second block' }
    ];

    (mockClient.callAPI as any).mockImplementation(async (method: string) => {
      if (method === 'logseq.Editor.getPage') return { ...mockPage };
      if (method === 'logseq.Editor.getPageBlocksTree') return tree;
      throw new Error(`unexpected call: ${method}`);
    });

    const result = await getPage(mockClient, 'test page', true);

    expect(mockClient.callAPI).toHaveBeenCalledTimes(2);
    expect(mockClient.callAPI).toHaveBeenNthCalledWith(1, 'logseq.Editor.getPage', ['test page']);
    expect(mockClient.callAPI).toHaveBeenNthCalledWith(2, 'logseq.Editor.getPageBlocksTree', ['test page']);
    expect(result.children).toEqual(tree);
  });

  it('should leave children unset when the blocks tree is empty', async () => {
    const mockPage: PageEntity = {
      id: 1,
      uuid: 'page-uuid-123',
      name: 'empty page',
      originalName: 'Empty Page'
    };

    (mockClient.callAPI as any).mockImplementation(async (method: string) =>
      method === 'logseq.Editor.getPage' ? { ...mockPage } : []
    );

    const result = await getPage(mockClient, 'empty page', true);

    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getPageBlocksTree', ['empty page']);
    expect(result.children).toBeUndefined();
  });

  it('should throw error if page not found (result is null)', async () => {
    (mockClient.callAPI as any).mockResolvedValue(null);

    await expect(
      getPage(mockClient, 'nonexistent-page', false)
    ).rejects.toThrow(/Page not found/);
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

  it('should propagate errors from the API client', async () => {
    (mockClient.callAPI as any).mockRejectedValue(
      new Error('Failed to connect to LogSeq API')
    );

    await expect(
      getPage(mockClient, 'test page', false)
    ).rejects.toThrow('Failed to connect to LogSeq API');
  });
});
