import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPage } from './get-page.js';
import { LogseqClient } from '../client.js';
import { PageEntity } from '../types.js';
import {
  PageNotFoundError,
  LogSeqNotRunningError,
  LogSeqTimeoutError,
  LogSeqAuthError
} from '../errors.js';

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

  describe('error handling', () => {
    const infrastructureErrors: Array<[string, () => Error]> = [
      ['LogSeqNotRunningError', () => new LogSeqNotRunningError('http://test')],
      ['LogSeqTimeoutError', () => new LogSeqTimeoutError('http://test', 1000)],
      ['LogSeqAuthError', () => new LogSeqAuthError('http://test')]
    ];

    it.each(infrastructureErrors)('propagates %s from the initial getPage call', async (_name, makeError) => {
      const error = makeError();
      (mockClient.callAPI as any).mockRejectedValue(error);

      await expect(getPage(mockClient, 'test page', false)).rejects.toBe(error);
      expect(mockClient.callAPI).toHaveBeenCalledTimes(1);
    });

    it.each(infrastructureErrors)('propagates %s from the suggestion lookup instead of reporting page not found', async (_name, makeError) => {
      const error = makeError();
      (mockClient.callAPI as any).mockImplementation(async (method: string) => {
        if (method === 'logseq.Editor.getPage') return null;
        throw error;
      });

      await expect(getPage(mockClient, 'missing page', false)).rejects.toBe(error);
    });

    it('still throws PageNotFoundError when the suggestion lookup fails unexpectedly', async () => {
      (mockClient.callAPI as any).mockImplementation(async (method: string) => {
        if (method === 'logseq.Editor.getPage') return null;
        throw new Error('boom');
      });

      await expect(getPage(mockClient, 'missing page', false)).rejects.toThrow(PageNotFoundError);
    });

    it('throws PageNotFoundError with fuzzy suggestions when the page is missing', async () => {
      const allPages: PageEntity[] = [
        { id: 1, uuid: 'u1', name: 'project atlas', originalName: 'Project Atlas' },
        { id: 2, uuid: 'u2', name: 'project apollo', originalName: 'Project Apollo' },
        { id: 3, uuid: 'u3', name: 'groceries', originalName: 'Groceries' }
      ];
      (mockClient.callAPI as any).mockImplementation(async (method: string) =>
        method === 'logseq.Editor.getPage' ? null : allPages
      );

      const promise = getPage(mockClient, 'proj atlas', false);

      await expect(promise).rejects.toThrow(PageNotFoundError);
      await expect(promise).rejects.toThrow(/Did you mean one of these\?[\s\S]*Project Atlas/);
    });

    it('throws a plain PageNotFoundError when there are no pages to suggest', async () => {
      (mockClient.callAPI as any).mockImplementation(async (method: string) =>
        method === 'logseq.Editor.getPage' ? null : []
      );

      await expect(getPage(mockClient, 'missing page', false)).rejects.toThrow(/Tip: Use logseq_list_pages/);
    });
  });
});
