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

  it('should handle null response', async () => {
    (mockClient.callAPI as any).mockResolvedValue(null);

    const result = await listPages(mockClient);

    expect(result.pages).toEqual([]);
    expect(result.total).toBe(0);
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
