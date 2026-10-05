import { describe, it, expect, vi } from 'vitest';
import { getConceptEvolution } from './get-concept-evolution.js';
import { LogseqClient } from '../client.js';
import { AmbiguousPageError } from '../errors.js';

/** The resolver's answer: the concept page matched by its exact name. */
const RESOLVED_CONCEPT = [[{ id: 100, name: 'concept', 'original-name': 'Concept' }, 'name']];

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
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce(RESOLVED_CONCEPT);
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
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce(RESOLVED_CONCEPT);
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
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce(RESOLVED_CONCEPT);
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
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce(RESOLVED_CONCEPT);
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
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce(RESOLVED_CONCEPT);
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

  it('should pass the lowercased concept name to Datalog as an input', async () => {
    const executeDatalogQuery = vi.fn(async (query: string) =>
      query.includes(':in $ ?n') ? RESOLVED_CONCEPT : []
    );
    const mockClient = {
      callAPI: vi.fn().mockResolvedValue([]),
      executeDatalogQuery
    } as unknown as LogseqClient;

    await getConceptEvolution(mockClient, 'My "Concept"\nB');

    expect(mockClient.executeDatalogQuery).toHaveBeenCalledWith(
      expect.stringContaining(':in $ ?n'),
      'my "concept"\nb'
    );
    expect(mockClient.executeDatalogQuery).toHaveBeenCalledWith(
      expect.stringContaining(':in $ ?page-name'),
      'my "concept"\nb'
    );
  });

  describe('page resolution (#41)', () => {
    it('tracks the page behind an alias, using its name for every lookup', async () => {
      const executeDatalogQuery = vi.fn(async (query: string) =>
        query.includes(':in $ ?n')
          ? [
              [{ id: 100, name: 'concept', 'original-name': 'Concept' }, 'alias'],
              [{ id: 101, name: 'cpt', 'original-name': 'Cpt' }, 'name']
            ]
          : []
      );
      const callAPI = vi.fn().mockResolvedValue([]);
      const mockClient = { callAPI, executeDatalogQuery } as unknown as LogseqClient;

      await getConceptEvolution(mockClient, 'Cpt');

      expect(callAPI).toHaveBeenCalledWith('logseq.Editor.getPageBlocksTree', ['concept']);
      expect(callAPI).toHaveBeenCalledWith('logseq.Editor.getPage', ['concept']);
      expect(executeDatalogQuery).toHaveBeenCalledWith(expect.stringContaining(':in $ ?page-name'), 'concept');
    });

    it('says which page was tracked when the name was an alias', async () => {
      const mockClient = {
        callAPI: vi.fn().mockResolvedValue([]),
        executeDatalogQuery: vi.fn(async (query: string) =>
          query.includes(':in $ ?n') ? [[{ id: 100, name: 'concept', 'original-name': 'Concept' }, 'alias']] : []
        )
      } as unknown as LogseqClient;

      const result = await getConceptEvolution(mockClient, 'Cpt');

      expect(result.concept).toBe('Cpt');
      expect(result.resolvedFrom).toEqual({ name: 'Cpt', matchedBy: 'alias', resolvedTo: 'Concept' });
    });

    it('says which page was tracked when the name was a namespace leaf', async () => {
      const executeDatalogQuery = vi.fn(async (query: string) =>
        query.includes(':in $ ?suffix') ? [[{ id: 5, name: 'work/cpt', 'original-name': 'Work/Cpt' }]] : []
      );
      const mockClient = { callAPI: vi.fn().mockResolvedValue([]), executeDatalogQuery } as unknown as LogseqClient;

      const result = await getConceptEvolution(mockClient, 'Cpt');

      expect(result.resolvedFrom).toEqual({ name: 'Cpt', matchedBy: 'namespace-leaf', resolvedTo: 'Work/Cpt' });
    });

    it('omits resolvedFrom for an exact name', async () => {
      const mockClient = {
        callAPI: vi.fn().mockResolvedValue([]),
        executeDatalogQuery: vi.fn(async (query: string) =>
          query.includes(':in $ ?n') ? [[{ id: 100, name: 'concept', 'original-name': 'Concept' }, 'name']] : []
        )
      } as unknown as LogseqClient;

      const result = await getConceptEvolution(mockClient, 'Concept');

      expect(result).not.toHaveProperty('resolvedFrom');
    });

    it('throws PageNotFoundError guidance instead of an empty timeline for an unknown concept', async () => {
      const mockClient = {
        callAPI: vi.fn().mockResolvedValue([]),
        executeDatalogQuery: vi.fn().mockResolvedValue([])
      } as unknown as LogseqClient;

      await expect(getConceptEvolution(mockClient, 'Nope')).rejects.toThrow(/^No page "Nope"\./);
      expect(mockClient.callAPI).toHaveBeenCalledTimes(1); // only the suggestion lookup
    });

    it('throws AmbiguousPageError when the name matches several pages', async () => {
      const mockClient = {
        callAPI: vi.fn(),
        executeDatalogQuery: vi.fn().mockResolvedValue([
          [{ id: 1, name: 'a/cpt', 'original-name': 'A/Cpt' }],
          [{ id: 2, name: 'b/cpt', 'original-name': 'B/Cpt' }]
        ])
      } as unknown as LogseqClient;
      // Exact and alias routes find nothing; the leaf lookup finds two pages
      (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([]);

      await expect(getConceptEvolution(mockClient, 'Cpt')).rejects.toThrow(AmbiguousPageError);
      expect(mockClient.callAPI).not.toHaveBeenCalled();
    });
  });
});
