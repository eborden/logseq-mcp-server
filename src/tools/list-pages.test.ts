import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listPages } from './list-pages.js';
import { LogseqClient } from '../client.js';
import { PageEntity } from '../types.js';

describe('listPages', () => {
  let mockClient: LogseqClient;

  beforeEach(() => {
    mockClient = {
      callAPI: vi.fn(),
    } as any;
  });

  it('should return pages as string array', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'u1', name: 'alpha', originalName: 'Alpha' },
      { id: 2, uuid: 'u2', name: 'beta', originalName: 'Beta' },
    ];
    (mockClient.callAPI as any).mockResolvedValue(mockPages);

    const result = await listPages(mockClient);

    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getAllPages');
    expect(result.pages).toEqual(['Alpha', 'Beta']);
    expect(result.total).toBe(2);
  });

  it('should exclude journal pages', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'u1', name: 'project', originalName: 'Project' },
      { id: 2, uuid: 'u2', name: 'nov 15th, 2025', originalName: 'Nov 15th, 2025', 'journal?': true },
      { id: 3, uuid: 'u3', name: 'dec 1st, 2025', originalName: 'Dec 1st, 2025', journal: true },
    ];
    (mockClient.callAPI as any).mockResolvedValue(mockPages);

    const result = await listPages(mockClient);

    expect(result.pages).toEqual(['Project']);
    expect(result.total).toBe(1);
  });

  it('should filter by name case-insensitively', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'u1', name: 'engineering', originalName: 'Engineering' },
      { id: 2, uuid: 'u2', name: 'experiment', originalName: 'Experiment' },
      { id: 3, uuid: 'u3', name: 'project', originalName: 'Project' },
    ];
    (mockClient.callAPI as any).mockResolvedValue(mockPages);

    const result = await listPages(mockClient, { nameContains: 'EXP' });

    expect(result.pages).toEqual(['Experiment']);
  });

  // #64: null is not an empty graph. The list stays empty (backward compatible)
  // and a ResultMeta warning says LogSeq returned no page list.
  describe('when getAllPages returns null (#64)', () => {
    const warning = {
      code: 'pages_unavailable',
      message: expect.stringContaining('LogSeq returned no page list'),
    };

    it('returns an empty list plus a pages_unavailable warning', async () => {
      (mockClient.callAPI as any).mockResolvedValue(null);

      const result = await listPages(mockClient);

      expect(result).toEqual({ pages: [], total: 0, hasMore: false, warnings: [warning] });
      expect(mockClient.callAPI).toHaveBeenCalledTimes(1);
      expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getAllPages');
    });

    it('tells the caller the empty list may be wrong and how to check', async () => {
      (mockClient.callAPI as any).mockResolvedValue(null);

      const [w] = (await listPages(mockClient)).warnings!;

      expect(w.message).toContain('may not mean the graph is empty');
      expect(w.message).toContain('logseq_get_graph_info');
      expect(w.message).toMatch(/retry/i);
    });

    it('keeps hasMore false: nothing can be fetched by raising a parameter', async () => {
      (mockClient.callAPI as any).mockResolvedValue(null);

      const result = await listPages(mockClient);

      expect(result.hasMore).toBe(false);
      expect(result.warnings![0].howToFetchAll).toBeUndefined();
    });

    it('returns the same empty list and warning when a name filter is given', async () => {
      (mockClient.callAPI as any).mockResolvedValue(null);

      const result = await listPages(mockClient, { nameContains: 'anything' });

      expect(result).toEqual({ pages: [], total: 0, hasMore: false, warnings: [warning] });
    });
  });

  describe('when getAllPages returns an empty array (a genuinely empty graph)', () => {
    it('returns an empty list with no warning and no meta fields', async () => {
      (mockClient.callAPI as any).mockResolvedValue([]);

      const result = await listPages(mockClient);

      expect(result).toEqual({ pages: [], total: 0 });
      expect(result).not.toHaveProperty('warnings');
      expect(result).not.toHaveProperty('hasMore');
    });

    it('adds no warning when every page is a journal or filtered out', async () => {
      (mockClient.callAPI as any).mockResolvedValue([
        { id: 1, uuid: 'u1', name: 'jan 1st, 2025', originalName: 'Jan 1st, 2025', 'journal?': true },
        { id: 2, uuid: 'u2', name: 'alpha', originalName: 'Alpha' },
      ]);

      const result = await listPages(mockClient, { nameContains: 'zzz' });

      expect(result).toEqual({ pages: [], total: 0 });
    });
  });

  it('should propagate API errors', async () => {
    (mockClient.callAPI as any).mockRejectedValue(new Error('API error'));

    await expect(listPages(mockClient)).rejects.toThrow('API error');
  });

  it('should return pages sorted alphabetically', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'u1', name: 'zebra', originalName: 'Zebra' },
      { id: 2, uuid: 'u2', name: 'alpha', originalName: 'Alpha' },
    ];
    (mockClient.callAPI as any).mockResolvedValue(mockPages);

    const result = await listPages(mockClient);

    expect(result.pages).toEqual(['Alpha', 'Zebra']);
  });

  it('should sort by lowercase name but return original casing', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'u1', name: 'api', originalName: 'API' },
      { id: 2, uuid: 'u2', name: 'apple', originalName: 'Apple' },
      { id: 3, uuid: 'u3', name: 'aaa', originalName: 'AAA' },
    ];
    (mockClient.callAPI as any).mockResolvedValue(mockPages);

    const result = await listPages(mockClient);

    // Sorted by lowercase: aaa, api, apple
    // Returns original casing: AAA, API, Apple
    expect(result.pages).toEqual(['AAA', 'API', 'Apple']);
  });
});
