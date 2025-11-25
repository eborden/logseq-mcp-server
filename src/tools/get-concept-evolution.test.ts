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
    expect(Object.keys(result.groupedTimeline!).length).toBeGreaterThan(0);
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

  it('should enrich blocks with page data from both HTTP and Datalog', async () => {
    const mockClient = {
      callAPI: vi.fn(),
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Mock getPageBlocksTree - returns block from the Concept page
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'On concept page',
        page: { id: 100 }
      }
    ]);

    // Mock getPage - returns full page data for Concept page
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 100,
      name: 'concept',
      'journal?': false,
      journalDay: undefined
    });

    // Mock Datalog query for inline mentions - returns blocks from journal pages
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{
        id: 2,
        content: 'Inline mention in journal',
        page: {
          id: 200,
          name: 'nov 1st, 2025',
          'journal?': true,
          'journal-day': 20251101  // Datalog uses kebab-case
        }
      }]
    ]);

    const result = await getConceptEvolution(mockClient, 'Concept');

    // Should have 1 journal entry and 1 non-journal entry
    expect(result.timeline).toHaveLength(2);
    expect(result.summary.journalMentions).toBe(1);
    expect(result.summary.nonJournalMentions).toBe(1);

    // Find the journal entry
    const journalEntry = result.timeline.find(e => e.date === 20251101);
    expect(journalEntry).toBeDefined();
    expect(journalEntry?.blocks).toHaveLength(1);
  });
});
