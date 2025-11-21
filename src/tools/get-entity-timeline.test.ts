import { describe, it, expect, vi } from 'vitest';
import { getEntityTimeline } from './get-entity-timeline.js';
import { LogseqClient } from '../client.js';

describe('getEntityTimeline', () => {
  it('should return blocks mentioning entity sorted by date', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock search results
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'Mention of [[Entity]]',
        page: { journalDay: 20251120, name: 'nov 20th, 2025' }
      },
      {
        id: 2,
        content: 'Earlier mention of [[Entity]]',
        page: { journalDay: 20251110, name: 'nov 10th, 2025' }
      }
    ]);

    const result = await getEntityTimeline(mockClient, 'Entity');

    expect(result).toHaveProperty('entity', 'Entity');
    expect(result).toHaveProperty('timeline');
    expect(result.timeline).toHaveLength(2);
    expect(result.timeline[0].date).toBe(20251110); // Earlier date first
    expect(result.timeline[1].date).toBe(20251120);
  });

  it('should filter by date range', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'Recent mention',
        page: { journalDay: 20251120 }
      },
      {
        id: 2,
        content: 'Old mention',
        page: { journalDay: 20230101 }
      }
    ]);

    const result = await getEntityTimeline(
      mockClient,
      'Entity',
      20251101,
      20251231
    );

    expect(result.timeline).toHaveLength(1);
    expect(result.timeline[0].date).toBe(20251120);
  });

  it('should handle non-journal pages', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'Mention in regular page',
        page: { name: 'Regular Page', 'journal?': false }
      }
    ]);

    const result = await getEntityTimeline(mockClient, 'Entity');

    expect(result.timeline).toHaveLength(1);
    expect(result.timeline[0].date).toBeNull();
  });
});
