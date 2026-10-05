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
      { id: 1, uuid: 'u1', name: 'alpha', originalName: 'Alpha', content: '' },
      { id: 2, uuid: 'u2', name: 'beta', originalName: 'Beta', content: '' },
    ];
    (mockClient.callAPI as any).mockResolvedValue(mockPages);

    const result = await listPages(mockClient);

    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getAllPages');
    expect(result.pages).toEqual(['Alpha', 'Beta']);
    expect(result.total).toBe(2);
  });

  it('should exclude journal pages', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'u1', name: 'project', originalName: 'Project', content: '' },
      { id: 2, uuid: 'u2', name: 'nov 15th, 2025', originalName: 'Nov 15th, 2025', content: '', 'journal?': true },
      { id: 3, uuid: 'u3', name: 'dec 1st, 2025', originalName: 'Dec 1st, 2025', content: '', journal: true },
    ] as any;
    (mockClient.callAPI as any).mockResolvedValue(mockPages);

    const result = await listPages(mockClient);

    expect(result.pages).toEqual(['Project']);
    expect(result.total).toBe(1);
  });

  it('should filter by name case-insensitively', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'u1', name: 'engineering', originalName: 'Engineering', content: '' },
      { id: 2, uuid: 'u2', name: 'experiment', originalName: 'Experiment', content: '' },
      { id: 3, uuid: 'u3', name: 'project', originalName: 'Project', content: '' },
    ];
    (mockClient.callAPI as any).mockResolvedValue(mockPages);

    const result = await listPages(mockClient, { nameContains: 'EXP' });

    expect(result.pages).toEqual(['Experiment']);
  });

  // CURRENT behavior, pinned by #64. NOT endorsed.
  // When logseq.Editor.getAllPages returns null, listPages reports an empty
  // list: no error, no warning. If null can mean "no graph open" or "mid
  // re-index" rather than "empty graph", this reports a failure as "none"
  // (foundations 2.10, 4.9). Whether to change that is the maintainer's call
  // and would be a separate PR; update this test with that change.
  describe('current behavior when getAllPages returns null (#64, not endorsed)', () => {
    it('returns an empty list with no error or warning', async () => {
      (mockClient.callAPI as any).mockResolvedValue(null);

      const result = await listPages(mockClient);

      expect(result).toEqual({ pages: [], total: 0 });
      expect(mockClient.callAPI).toHaveBeenCalledTimes(1);
      expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.Editor.getAllPages');
    });

    it('returns the same empty list when a name filter is given', async () => {
      (mockClient.callAPI as any).mockResolvedValue(null);

      const result = await listPages(mockClient, { nameContains: 'anything' });

      expect(result).toEqual({ pages: [], total: 0 });
    });

    it('is indistinguishable from an empty array response', async () => {
      (mockClient.callAPI as any).mockResolvedValueOnce(null).mockResolvedValueOnce([]);

      const fromNull = await listPages(mockClient);
      const fromEmpty = await listPages(mockClient);

      expect(fromNull).toEqual(fromEmpty);
    });
  });

  it('should propagate API errors', async () => {
    (mockClient.callAPI as any).mockRejectedValue(new Error('API error'));

    await expect(listPages(mockClient)).rejects.toThrow('API error');
  });

  it('should return pages sorted alphabetically', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'u1', name: 'zebra', originalName: 'Zebra', content: '' },
      { id: 2, uuid: 'u2', name: 'alpha', originalName: 'Alpha', content: '' },
    ];
    (mockClient.callAPI as any).mockResolvedValue(mockPages);

    const result = await listPages(mockClient);

    expect(result.pages).toEqual(['Alpha', 'Zebra']);
  });

  it('should sort by lowercase name but return original casing', async () => {
    const mockPages: PageEntity[] = [
      { id: 1, uuid: 'u1', name: 'api', originalName: 'API', content: '' },
      { id: 2, uuid: 'u2', name: 'apple', originalName: 'Apple', content: '' },
      { id: 3, uuid: 'u3', name: 'aaa', originalName: 'AAA', content: '' },
    ];
    (mockClient.callAPI as any).mockResolvedValue(mockPages);

    const result = await listPages(mockClient);

    // Sorted by lowercase: aaa, api, apple
    // Returns original casing: AAA, API, Apple
    expect(result.pages).toEqual(['AAA', 'API', 'Apple']);
  });
});
