import { describe, it, expect, vi } from 'vitest';
import { queryByDateRange } from './query-by-date-range.js';
import { LogseqClient } from '../client.js';

describe('queryByDateRange', () => {
  it('should return journal entries within date range', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock query for pages
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        uuid: 'uuid-1',
        name: 'nov 15th, 2025',
        originalName: 'Nov 15th, 2025',
        journalDay: 20251115,
        'journal?': true
      },
      {
        id: 2,
        uuid: 'uuid-2',
        name: 'nov 20th, 2025',
        originalName: 'Nov 20th, 2025',
        journalDay: 20251120,
        'journal?': true
      }
    ]);

    // Mock blocks for each page
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 10, content: 'Entry from Nov 15' }
    ]);

    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 20, content: 'Entry from Nov 20' }
    ]);

    const result = await queryByDateRange(
      mockClient,
      20251115,
      20251120
    );

    expect(result).toHaveProperty('dateRange');
    expect(result.dateRange.start).toBe(20251115);
    expect(result.dateRange.end).toBe(20251120);
    expect(result).toHaveProperty('entries');
    expect(result.entries).toHaveLength(2);
  });

  it('should filter by search term if provided', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        uuid: 'uuid-1',
        name: 'nov 15th, 2025',
        originalName: 'Nov 15th, 2025',
        journalDay: 20251115,
        'journal?': true
      }
    ]);

    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 10, content: 'Important meeting notes' },
      { id: 11, content: 'Random thoughts' }
    ]);

    const result = await queryByDateRange(
      mockClient,
      20251115,
      20251115,
      'meeting'
    );

    expect(result.entries[0].blocks).toHaveLength(1);
    expect(result.entries[0].blocks[0].content).toContain('meeting');
  });

  it('should handle empty date range', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValue([]);

    const result = await queryByDateRange(mockClient, 20990101, 20990102);

    expect(result.entries).toHaveLength(0);
  });

  it('should validate date format', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    await expect(queryByDateRange(mockClient, 99999999, 20251120))
      .rejects.toThrow('Invalid date format');
  });
});
