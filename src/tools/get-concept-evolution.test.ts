import { describe, it, expect, vi } from 'vitest';
import { getConceptEvolution } from './get-concept-evolution.js';
import { LogseqClient } from '../client.js';

describe('getConceptEvolution', () => {
  it('should track how concept appears over time', async () => {
    const mockClient = {
      callAPI: vi.fn(),
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Mock search for concept - getPageBlocksTree
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'First mention of [[Concept]]',
        page: { journalDay: 20251101, name: 'nov 1st, 2025' }
      },
      {
        id: 2,
        content: 'Later thoughts on [[Concept]]',
        page: { journalDay: 20251115, name: 'nov 15th, 2025' }
      },
      {
        id: 3,
        content: 'Updated understanding of [[Concept]]',
        page: { journalDay: 20251120, name: 'nov 20th, 2025' }
      }
    ]);

    // Mock Datalog query for inline mentions
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([]);

    const result = await getConceptEvolution(mockClient, 'Concept');

    expect(result).toHaveProperty('concept', 'Concept');
    expect(result).toHaveProperty('timeline');
    expect(result.timeline).toHaveLength(3);
    expect(result.timeline[0].date).toBe(20251101);
    expect(result.timeline[2].date).toBe(20251120);
  });

  it('should group mentions by time period', async () => {
    const mockClient = {
      callAPI: vi.fn(),
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'Week 1 mention',
        page: { journalDay: 20251101 }
      },
      {
        id: 2,
        content: 'Also week 1',
        page: { journalDay: 20251102 }
      },
      {
        id: 3,
        content: 'Week 2 mention',
        page: { journalDay: 20251108 }
      }
    ]);

    // Mock Datalog query for inline mentions
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([]);

    const result = await getConceptEvolution(
      mockClient,
      'Concept',
      { groupBy: 'week' }
    );

    expect(result).toHaveProperty('groupedTimeline');
    expect(result.groupedTimeline).toBeDefined();
  });

  it('should handle concepts with no temporal data', async () => {
    const mockClient = {
      callAPI: vi.fn(),
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'Non-journal mention',
        page: { name: 'Regular Page', 'journal?': false }
      }
    ]);

    // Mock Datalog query for inline mentions
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([]);

    const result = await getConceptEvolution(mockClient, 'Concept');

    expect(result.timeline).toHaveLength(1);
    expect(result.timeline[0].date).toBeNull();
  });

  it('should filter by date range', async () => {
    const mockClient = {
      callAPI: vi.fn(),
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'Old mention',
        page: { journalDay: 20240101 }
      },
      {
        id: 2,
        content: 'Recent mention',
        page: { journalDay: 20251115 }
      }
    ]);

    // Mock Datalog query for inline mentions
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([]);

    const result = await getConceptEvolution(
      mockClient,
      'Concept',
      { startDate: 20251101, endDate: 20251231 }
    );

    expect(result.timeline).toHaveLength(1);
    expect(result.timeline[0].date).toBe(20251115);
  });

  it('should enrich blocks with full page data', async () => {
    const mockClient = {
      callAPI: vi.fn(),
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Mock getPageBlocksTree - blocks with minimal page data (just ID)
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'First mention',
        page: { id: 100 }  // Only ID, no journalDay
      },
      {
        id: 2,
        content: 'Second mention',
        page: { id: 200 }  // Only ID, no journalDay
      }
    ]);

    // Mock Datalog query for inline mentions - empty
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([]);

    // Mock Datalog query for page enrichment - return full page data
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ 'db/id': 100, id: 100, journalDay: 20251101, name: 'nov 1st, 2025' }],
      [{ 'db/id': 200, id: 200, journalDay: 20251102, name: 'nov 2nd, 2025' }]
    ]);

    const result = await getConceptEvolution(mockClient, 'Concept');

    // Verify enrichment worked
    expect(result.timeline).toHaveLength(2);
    expect(result.timeline[0].date).toBe(20251101);
    expect(result.timeline[1].date).toBe(20251102);

    // Verify the enrichment query was called
    expect(mockClient.executeDatalogQuery).toHaveBeenCalledTimes(2);

    // Verify the second call is the page enrichment query
    const enrichmentCall = (mockClient.executeDatalogQuery as any).mock.calls[1][0];
    expect(enrichmentCall).toContain('ground');
    expect(enrichmentCall).toContain('100 200');
  });
});
