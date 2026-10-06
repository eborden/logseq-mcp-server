import { describe, it, expect, vi } from 'vitest';
import { buildContextForTopic } from './build-context.js';
import { LogseqClient } from '../client.js';
import {
  AmbiguousPageError,
  LogSeqNotRunningError,
  LogSeqTimeoutError,
  LogSeqAuthError,
  PageNotFoundError
} from '../errors.js';

describe('buildContextForTopic', () => {
  it('should execute Datalog queries and transform results to context', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn(),
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 1: Get page
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 1, name: 'Topic', properties: {} }]
    ]);

    // Mock Query 2: Get blocks
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 10, content: 'Block 1' }],
      [{ id: 11, content: 'Block 2' }]
    ]);

    // Mock Query 3: Get backlinks (references) - format: [page, [blocks]]
    // relatedPages will be derived from this
    (mockClient.callAPI as any).mockResolvedValueOnce([
      [{ id: 3, name: 'Source Page' }, [{ id: 20, content: 'Block referencing Topic' }]]
    ]);

    const result = await buildContextForTopic(mockClient, 'Topic', {});

    // Should make 2 Datalog queries (page, blocks) + 1 HTTP API call (backlinks)
    expect(mockClient.executeDatalogQuery).toHaveBeenCalledTimes(2);
    expect(mockClient.callAPI).toHaveBeenCalledTimes(1);
    expect(result.topic).toBe('Topic');
    expect(result.mainPage.id).toBe(1);
    expect(result.directBlocks.length).toBe(2); // Two blocks found
    expect(result.relatedPages.length).toBe(1); // One related page (derived from backlinks)
    expect(result.references.length).toBe(1); // One reference found
  });

  it('should throw error when page not found', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Empty results = page not found
    (mockClient.executeDatalogQuery as any).mockResolvedValue([]);

    await expect(
      buildContextForTopic(mockClient, 'NonExistent', {})
    ).rejects.toThrow(PageNotFoundError);
  });

  describe('page resolution (#41)', () => {
    /** A client whose resolver answers `resolveRows`, then blocks and backlinks are empty. */
    function resolvingClient(resolveRows: unknown[], leafRows: unknown[] = []) {
      const executeDatalogQuery = vi.fn(async (query: string) => {
        if (query.includes(':in $ ?n')) return resolveRows;
        if (query.includes(':in $ ?suffix')) return leafRows;
        return [];
      });
      const callAPI = vi.fn().mockResolvedValue([]);
      return { client: { config: {}, executeDatalogQuery, callAPI } as unknown as LogseqClient, executeDatalogQuery, callAPI };
    }

    it('costs the same as before for an exact match: 2 Datalog queries and 1 API call', async () => {
      const { client, executeDatalogQuery, callAPI } = resolvingClient([[{ id: 1, name: 'topic' }, 'name']]);

      const result = await buildContextForTopic(client, 'Topic');

      expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
      expect(callAPI).toHaveBeenCalledTimes(1);
      expect(result.resolvedFrom).toBeUndefined();
    });

    it('resolves an alias in the same query and uses the real page for the blocks and backlinks', async () => {
      const { client, executeDatalogQuery, callAPI } = resolvingClient([
        [{ id: 7, name: 'project atlas', 'original-name': 'Project Atlas' }, 'alias'],
        [{ id: 9, name: 'atlas', 'original-name': 'Atlas' }, 'name']
      ]);

      const result = await buildContextForTopic(client, 'Atlas');

      expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
      expect(executeDatalogQuery.mock.calls[1].slice(1)).toEqual(['project atlas']);
      expect(callAPI).toHaveBeenCalledWith('logseq.Editor.getPageLinkedReferences', ['project atlas']);
      expect(result.mainPage.id).toBe(7);
      expect(result.topic).toBe('Atlas');
      expect(result.resolvedFrom).toEqual({ name: 'Atlas', matchedBy: 'alias', resolvedTo: 'Project Atlas' });
    });

    it('resolves an ISO date to the journal page', async () => {
      const { client, executeDatalogQuery } = resolvingClient([
        [{ id: 5, name: 'jan 1st, 2025', 'original-name': 'Jan 1st, 2025', 'journal?': true, 'journal-day': 20250101 }, 'journal-date']
      ]);

      const result = await buildContextForTopic(client, '2025-01-01');

      expect(executeDatalogQuery.mock.calls[0].slice(1)).toEqual(['2025-01-01', 20250101]);
      expect(executeDatalogQuery.mock.calls[1].slice(1)).toEqual(['jan 1st, 2025']);
      expect(result.mainPage.id).toBe(5);
      expect(result.temporalContext).toEqual({ isJournal: true, date: 20250101 });
      expect(result.resolvedFrom).toEqual({ name: '2025-01-01', matchedBy: 'journal-date', resolvedTo: 'Jan 1st, 2025' });
    });

    describe('temporalContext (#152)', () => {
      it('reads a Datalog pull: journal? and journal-day', async () => {
        const { client } = resolvingClient([
          [{ id: 5, name: 'jan 6th, 2025', 'journal?': true, 'journal-day': 20250106 }, 'name']
        ]);

        const result = await buildContextForTopic(client, 'Jan 6th, 2025');

        expect(result.temporalContext).toEqual({ isJournal: true, date: 20250106 });
      });

      it('reads the Editor API spelling: journal and journalDay', async () => {
        const { client } = resolvingClient([
          [{ id: 5, name: 'jan 6th, 2025', journal: true, journalDay: 20250106 }, 'name']
        ]);

        const result = await buildContextForTopic(client, 'Jan 6th, 2025');

        expect(result.temporalContext).toEqual({ isJournal: true, date: 20250106 });
      });

      it('reports a non-journal page as not a journal, with no date', async () => {
        const { client } = resolvingClient([
          [{ id: 7, name: 'project atlas', 'journal?': false }, 'name']
        ]);

        const result = await buildContextForTopic(client, 'Project Atlas');

        expect(result.temporalContext).toEqual({ isJournal: false });
        expect(result.temporalContext).not.toHaveProperty('date');
      });

      it('leaves temporalContext out when include_temporal_context is false', async () => {
        const { client } = resolvingClient([
          [{ id: 5, name: 'jan 6th, 2025', 'journal?': true, 'journal-day': 20250106 }, 'name']
        ]);

        const result = await buildContextForTopic(client, 'Jan 6th, 2025', { includeTemporalContext: false });

        expect(result.temporalContext).toBeUndefined();
      });
    });

    it('throws AmbiguousPageError with the candidates when a namespace leaf matches several pages', async () => {
      const { client, executeDatalogQuery, callAPI } = resolvingClient([], [
        [{ id: 2, name: 'work/atlas', 'original-name': 'Work/Atlas' }],
        [{ id: 3, name: 'home/atlas', 'original-name': 'Home/Atlas' }]
      ]);

      const error = await buildContextForTopic(client, 'Atlas').catch(e => e);

      expect(error).toBeInstanceOf(AmbiguousPageError);
      expect(error.candidates.map((c: any) => [c.name, c.matchedBy])).toEqual([
        ['home/atlas', 'namespace-leaf'],
        ['work/atlas', 'namespace-leaf']
      ]);
      expect(executeDatalogQuery).toHaveBeenCalledTimes(2); // resolve + leaf; no blocks query
      expect(callAPI).not.toHaveBeenCalled();
    });

    it('resolves a unique namespace leaf to that page', async () => {
      const { client } = resolvingClient([], [[{ id: 2, name: 'work/atlas', 'original-name': 'Work/Atlas' }]]);

      const result = await buildContextForTopic(client, 'Atlas');

      expect(result.mainPage.id).toBe(2);
      expect(result.resolvedFrom).toEqual({ name: 'Atlas', matchedBy: 'namespace-leaf', resolvedTo: 'Work/Atlas' });
    });

    it('throws guidance with the closest names when nothing matches', async () => {
      const { client, callAPI } = resolvingClient([]);
      callAPI.mockResolvedValue([{ id: 1, name: 'project atlas', originalName: 'Project Atlas' }]);

      const error = await buildContextForTopic(client, 'proj atlas').catch(e => e);

      expect(error).toBeInstanceOf(PageNotFoundError);
      expect(error.message).toMatch(/^No page "proj atlas"\. Closest: Project Atlas\./);
    });
  });

  it('should respect limits from options', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn(),
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 1: Get page
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 1, name: 'Topic', properties: {} }]
    ]);

    // Mock Query 2: Get many blocks
    const manyBlocks = Array.from({ length: 100 }, (_, i) => [
      { id: 10 + i, content: `Block ${i}` }
    ]);
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce(manyBlocks);

    // Mock Query 3: Get backlinks
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    const result = await buildContextForTopic(mockClient, 'Topic', {
      maxBlocks: 10
    });

    expect(result.directBlocks.length).toBeLessThanOrEqual(10);
  });

  it('should handle case-insensitive page names', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn(),
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 1: Get page (lowercase in DB)
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 1, name: 'alice', properties: {} }]
    ]);

    // Mock Query 2: Get blocks (empty)
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([]);

    // Mock Query 3: Get backlinks (empty)
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    // Should work with capital C
    const result = await buildContextForTopic(mockClient, 'Alice', {});

    expect(result.topic).toBe('Alice');
    expect(result.mainPage.id).toBe(1);
    expect(result.directBlocks.length).toBe(0); // No blocks
    expect(result.references.length).toBe(0); // No references

    // Verify the lowercased name is passed as an :in input, not embedded in the query
    expect(mockClient.executeDatalogQuery).toHaveBeenCalledWith(
      expect.stringContaining(':in $ ?page-name'),
      'alice'
    );
  });

  it('should populate references with backlinks', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn(),
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 1: Get page
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 1, name: 'Topic', properties: {} }]
    ]);

    // Mock Query 2: Get blocks
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([]);

    // Mock Query 3: Get backlinks with multiple references - format: [page, [blocks]]
    (mockClient.callAPI as any).mockResolvedValueOnce([
      [{ id: 3, name: 'Page A' }, [{ id: 20, content: 'First reference' }]],
      [{ id: 4, name: 'Page B' }, [{ id: 21, content: 'Second reference' }]]
    ]);

    const result = await buildContextForTopic(mockClient, 'Topic', {});

    expect(result.references.length).toBe(2);
    expect(result.references[0].block.content).toBe('First reference');
    expect(result.references[0].sourcePage.name).toBe('Page A');
    expect(result.references[1].block.content).toBe('Second reference');
    expect(result.references[1].sourcePage.name).toBe('Page B');
    expect(result.summary.totalReferences).toBe(2);
    // Related pages should be derived from backlinks
    expect(result.relatedPages.length).toBe(2);
    expect(result.relatedPages[0].page.name).toBe('Page A');
    expect(result.relatedPages[1].page.name).toBe('Page B');
  });

  it('should handle db/id property format from Datalog queries', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn(),
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 1: Get page with db/id (Datalog format)
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ 'db/id': 22, name: 'bob', properties: {} }]
    ]);

    // Mock Query 2: Get blocks
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([]);

    // Mock Query 3: Get backlinks - relatedPages derived from this
    (mockClient.callAPI as any).mockResolvedValueOnce([
      [{ 'db/id': 95, name: 'Core' }, [{ id: 100, content: 'Mentions Bob' }]]
    ]);

    const result = await buildContextForTopic(mockClient, 'Bob', {});

    expect(result.mainPage['db/id']).toBe(22);
    expect(result.relatedPages.length).toBe(1);
    expect(result.relatedPages[0].page.name).toBe('Core');
    expect(result.relatedPages[0].relationshipType).toBe('inbound');
  });

  describe('truncation warnings (#40)', () => {
    const mkClient = (blockCount: number, backlinks: any[]) => {
      const client = {
        config: {},
        executeDatalogQuery: vi.fn(),
        callAPI: vi.fn()
      } as unknown as LogseqClient;
      (client.executeDatalogQuery as any)
        .mockResolvedValueOnce([[{ id: 1, name: 'Topic', properties: {} }]])
        .mockResolvedValueOnce(
          Array.from({ length: blockCount }, (_, i) => [{ id: 100 + i, content: `Block ${i}` }])
        );
      (client.callAPI as any).mockResolvedValueOnce(backlinks);
      return client;
    };

    // 4 source pages with 2 blocks each: 8 references, 4 related pages
    const backlinks = [1, 2, 3, 4].map(p => [
      { id: 10 + p, name: `Source ${p}` },
      [{ id: 200 + p * 2, content: 'a' }, { id: 201 + p * 2, content: 'b' }]
    ]);

    it('reports no warning and hasMore false when under every cap', async () => {
      const result = await buildContextForTopic(mkClient(3, backlinks), 'Topic', {});

      expect(result.hasMore).toBe(false);
      expect(result.warnings).toEqual([]);
      expect(result.totals).toEqual({ blocks: 3, relatedPages: 4, references: 8 });
    });

    it('reports no warning when exactly at a cap', async () => {
      const result = await buildContextForTopic(mkClient(3, backlinks), 'Topic', {
        maxBlocks: 3,
        maxReferences: 8,
        maxRelatedPages: 4
      });

      expect(result.hasMore).toBe(false);
      expect(result.warnings).toEqual([]);
    });

    it('warns when maxBlocks cuts blocks, with the real total and how to fetch all', async () => {
      const result = await buildContextForTopic(mkClient(7, backlinks), 'Topic', { maxBlocks: 5 });

      expect(result.directBlocks).toHaveLength(5);
      expect(result.hasMore).toBe(true);
      expect(result.totals.blocks).toBe(7);
      expect(result.warnings).toEqual([
        {
          code: 'blocks_truncated',
          message: 'Showing 5 of 7 blocks.',
          howToFetchAll: 'Set max_blocks to 7 (or higher) to get all 7.'
        }
      ]);
      // The summary still counts what is returned
      expect(result.summary.totalBlocks).toBe(5);
    });

    it('says a large raise may be saved to a file only past what plausibly comes back inline (#196)', async () => {
      const note = "A result this large may be saved to a file by the host instead of shown; the server can't tell.";
      // 200 blocks, 150 references and 500 related pages still plausibly come back inline
      const edge = await buildContextForTopic(mkClient(200, []), 'Topic', { maxBlocks: 5 });
      expect(edge.warnings[0].howToFetchAll).toBe('Set max_blocks to 200 (or higher) to get all 200.');

      const big = await buildContextForTopic(mkClient(201, []), 'Topic', { maxBlocks: 5 });
      expect(big.warnings[0].howToFetchAll).toBe(`Set max_blocks to 201 (or higher) to get all 201. ${note}`);

      const many = Array.from({ length: 151 }, (_, i) => [{ id: 1000 + i, name: `Source ${i}` }, [{ id: 5000 + i, content: 'a' }]]);
      const refs = await buildContextForTopic(mkClient(0, many), 'Topic', { maxReferences: 5, maxRelatedPages: 5 });
      expect(refs.warnings.map(w => [w.code, w.howToFetchAll])).toEqual([
        ['references_truncated', `Set max_references to 151 (or higher) to get all 151. ${note}`],
        ['related_pages_truncated', 'Set max_related_pages to 151 (or higher) to get all 151.']
      ]);
    });

    it('warns when maxReferences cuts references', async () => {
      const result = await buildContextForTopic(mkClient(0, backlinks), 'Topic', { maxReferences: 3 });

      expect(result.references).toHaveLength(3);
      expect(result.totals.references).toBe(8);
      expect(result.warnings.map(w => w.code)).toEqual(['references_truncated']);
      expect(result.warnings[0].howToFetchAll).toContain('max_references to 8');
    });

    it('warns when maxRelatedPages cuts related pages', async () => {
      const result = await buildContextForTopic(mkClient(0, backlinks), 'Topic', { maxRelatedPages: 2 });

      expect(result.relatedPages).toHaveLength(2);
      expect(result.totals.relatedPages).toBe(4);
      expect(result.warnings.map(w => w.code)).toEqual(['related_pages_truncated']);
      expect(result.warnings[0].howToFetchAll).toContain('max_related_pages to 4');
    });

    it('emits one warning per cap that bites', async () => {
      const result = await buildContextForTopic(mkClient(7, backlinks), 'Topic', {
        maxBlocks: 1,
        maxReferences: 1,
        maxRelatedPages: 1
      });

      expect(result.warnings.map(w => w.code)).toEqual([
        'blocks_truncated',
        'references_truncated',
        'related_pages_truncated'
      ]);
    });

    it('keeps the call count (totals come from data already fetched)', async () => {
      const client = mkClient(2, backlinks);
      await buildContextForTopic(client, 'Topic', { maxBlocks: 1 });

      // Totals come from data already fetched: 2 Datalog queries + 1 backlinks call
      expect(client.executeDatalogQuery).toHaveBeenCalledTimes(2);
      expect(client.callAPI).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling (backlinks)', () => {
    function clientWithBacklinks(backlinks: () => Promise<unknown>) {
      const mockClient = {
        config: { apiUrl: 'http://test' },
        executeDatalogQuery: vi.fn(),
        callAPI: vi.fn()
      } as unknown as LogseqClient;
      (mockClient.executeDatalogQuery as any)
        .mockResolvedValueOnce([[{ id: 1, name: 'topic', properties: {} }]])
        .mockResolvedValueOnce([[{ id: 10, content: 'A block' }]]);
      (mockClient.callAPI as any).mockImplementation(backlinks);
      return mockClient;
    }

    it.each([
      ['LogSeqNotRunningError', () => new LogSeqNotRunningError('http://test')],
      ['LogSeqTimeoutError', () => new LogSeqTimeoutError('http://test', 1000)],
      ['LogSeqAuthError', () => new LogSeqAuthError('http://test')],
      ['an unexpected Error', () => new Error('boom')]
    ])('propagates %s from the backlinks call', async (_name, makeError) => {
      const error = makeError();
      const client = clientWithBacklinks(async () => { throw error; });

      await expect(buildContextForTopic(client, 'Topic')).rejects.toBe(error);
    });

    it.each([
      ['null', null],
      ['an empty array', []]
    ])('returns an empty context when backlinks are %s', async (_name, value) => {
      const client = clientWithBacklinks(async () => value);

      const result = await buildContextForTopic(client, 'Topic');

      expect(result.directBlocks).toHaveLength(1);
      expect(result.references).toEqual([]);
      expect(result.relatedPages).toEqual([]);
      expect(result.summary.totalReferences).toBe(0);
    });

    it('propagates an infrastructure error raised while looking up suggestions for a missing page', async () => {
      const mockClient = {
        config: { apiUrl: 'http://test' },
        executeDatalogQuery: vi.fn().mockResolvedValue([]),
        callAPI: vi.fn().mockRejectedValue(new LogSeqTimeoutError('http://test', 1000))
      } as unknown as LogseqClient;

      await expect(buildContextForTopic(mockClient, 'Missing')).rejects.toThrow(LogSeqTimeoutError);
    });

    it('still throws PageNotFoundError when the suggestion lookup fails unexpectedly', async () => {
      const mockClient = {
        config: { apiUrl: 'http://test' },
        executeDatalogQuery: vi.fn().mockResolvedValue([]),
        callAPI: vi.fn().mockRejectedValue(new Error('boom'))
      } as unknown as LogseqClient;

      await expect(buildContextForTopic(mockClient, 'Missing')).rejects.toThrow(PageNotFoundError);
    });
  });
});
