import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS, getContextForQuery } from './get-context-for-query.js';
import { LogseqClient } from '../client.js';
import type { SearchBlocksResult } from './search-blocks.js';
import { LogSeqNotRunningError, LogSeqTimeoutError, LogSeqAuthError } from '../errors.js';

// Helper to create mock client with standard Datalog responses
function createMockClient() {
  const mockClient = {
    config: { apiUrl: 'http://test', authToken: 'test' },
    callAPI: vi.fn(),
    executeDatalogQuery: vi.fn()
  } as unknown as LogseqClient;

  // Default mock: return minimal page+block for any Datalog query
  let queryCount = 0;
  (mockClient.executeDatalogQuery as any).mockImplementation(async () => {
    queryCount++;
    if (queryCount % 2 === 1) {
      // Odd calls: page+blocks query
      return [[{ id: queryCount, name: `Page ${queryCount}`, properties: {} }, { id: queryCount * 10, content: `Block ${queryCount}` }]];
    } else {
      // Even calls: connections query
      return [];
    }
  });

  return mockClient;
}

describe('getContextForQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('should extract topics from query and build context', async () => {
    const mockClient = {
      config: { apiUrl: 'http://test', authToken: 'test' },
      callAPI: vi.fn(),
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Mock executeDatalogQuery to return data for any topic (2 queries per topic: page, blocks)
    let callCount = 0;
    (mockClient.executeDatalogQuery as any).mockImplementation(async () => {
      callCount++;
      const topicIndex = Math.floor((callCount - 1) / 2);
      const queryType = (callCount - 1) % 2; // 0=page, 1=blocks

      if (queryType === 0) {
        // Page query
        return [[{ id: topicIndex + 1, name: `Topic ${topicIndex + 1}`, properties: {} }]];
      } else {
        // Blocks query
        return [[{ id: (topicIndex + 1) * 10, content: `Block ${topicIndex + 1}` }]];
      }
    });

    // Mock callAPI for backlinks
    (mockClient.callAPI as any).mockResolvedValue([]);

    const result = await getContextForQuery(
      mockClient,
      'What did we discuss about [[Project X]] in the [[Team Meeting]]?'
    );

    expect(result).toHaveProperty('query');
    expect(result).toHaveProperty('extractedTopics');
    expect(result.extractedTopics).toContain('Project X');
    expect(result.extractedTopics).toContain('Team Meeting');
    expect(result).toHaveProperty('contexts');
    expect(result.contexts).toHaveLength(2);
  });

  it('should handle queries with no explicit topics', async () => {
    const mockClient = {
      config: { apiUrl: 'http://test', authToken: 'test' },
      callAPI: vi.fn(),
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Mock search results
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 1, content: 'Block about databases', page: { name: 'Tech' } }
    ]);

    const result = await getContextForQuery(
      mockClient,
      'How do databases work?'
    );

    expect(result.extractedTopics.length).toBeGreaterThanOrEqual(0);
    expect(result).toHaveProperty('searchResults');
  });

  it('should combine multiple topic contexts efficiently', async () => {
    const mockClient = {
      config: { apiUrl: 'http://test', authToken: 'test' },
      callAPI: vi.fn(),
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Mock Datalog queries for both topics (2 queries per topic: page, blocks)
    let callCount = 0;
    (mockClient.executeDatalogQuery as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Topic A: page
        return [[{ id: 1, name: 'Topic A', properties: {} }]];
      } else if (callCount === 2) {
        // Topic A: blocks
        return [[{ id: 10, content: 'Block A' }]];
      } else if (callCount === 3) {
        // Topic B: page
        return [[{ id: 2, name: 'Topic B', properties: {} }]];
      } else if (callCount === 4) {
        // Topic B: blocks
        return [[{ id: 20, content: 'Block B' }]];
      }
      return [];
    });

    // Mock callAPI for backlinks
    (mockClient.callAPI as any).mockResolvedValue([]);

    const result = await getContextForQuery(
      mockClient,
      'Compare [[Topic A]] and [[Topic B]]'
    );

    expect(result.contexts.length).toBe(2);
    expect(result.extractedTopics).toEqual(['Topic A', 'Topic B']);
  });

  it('should extract hashtags from query', async () => {
    const mockClient = {
      config: { apiUrl: 'http://test', authToken: 'test' },
      callAPI: vi.fn(),
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Mock Datalog queries for hashtag (2 queries: page, blocks)
    let callCount = 0;
    (mockClient.executeDatalogQuery as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Page query
        return [[{ id: 1, name: 'important', properties: {} }]];
      } else if (callCount === 2) {
        // Blocks query
        return [[{ id: 10, content: 'Tagged content' }]];
      }
      return [];
    });

    // Mock callAPI for backlinks
    (mockClient.callAPI as any).mockResolvedValue([]);

    const result = await getContextForQuery(
      mockClient,
      'Show me #important items'
    );

    expect(result.extractedTopics).toContain('important');
    expect(result.contexts).toHaveLength(1);
  });

  it('should deduplicate extracted topics', async () => {
    const mockClient = {
      config: { apiUrl: 'http://test', authToken: 'test' },
      callAPI: vi.fn(),
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Mock Datalog queries - topic appears twice but should only query once (2 queries)
    let callCount = 0;
    (mockClient.executeDatalogQuery as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Page
        return [[{ id: 1, name: 'Topic', properties: {} }]];
      } else if (callCount === 2) {
        // Blocks
        return [[{ id: 10, content: 'Block' }]];
      }
      return [];
    });

    // Mock callAPI for backlinks
    (mockClient.callAPI as any).mockResolvedValue([]);

    const result = await getContextForQuery(
      mockClient,
      'Tell me about [[Topic]] and more about [[Topic]]'
    );

    expect(result.extractedTopics).toEqual(['Topic']);
    expect(result.contexts).toHaveLength(1);
  });

  it('should skip topics that do not exist', async () => {
    const mockClient = {
      config: { apiUrl: 'http://test', authToken: 'test' },
      callAPI: vi.fn(),
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Mock Datalog queries (2 queries per existing topic)
    let callCount = 0;
    (mockClient.executeDatalogQuery as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First topic: page
        return [[{ id: 1, name: 'Exists', properties: {} }]];
      } else if (callCount === 2) {
        // First topic: blocks
        return [[{ id: 10, content: 'Block' }]];
      } else if (callCount === 3) {
        // Second topic: page (doesn't exist - empty result)
        return [];
      }
      return [];
    });

    // Mock callAPI for backlinks
    (mockClient.callAPI as any).mockResolvedValue([]);

    const result = await getContextForQuery(
      mockClient,
      'Compare [[Exists]] and [[DoesNotExist]]'
    );

    expect(result.extractedTopics).toEqual(['Exists', 'DoesNotExist']);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0].topic).toBe('Exists');
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'topic_not_found', topic: 'DoesNotExist' })
    ]);
  });

  describe('error handling', () => {
    const infraErrors: Array<[string, () => Error]> = [
      ['LogSeqNotRunningError', () => new LogSeqNotRunningError('http://test')],
      ['LogSeqTimeoutError', () => new LogSeqTimeoutError('http://test', 1000)],
      ['LogSeqAuthError', () => new LogSeqAuthError('http://test')]
    ];
    const allErrors: Array<[string, () => Error]> = [
      ...infraErrors,
      ['an unexpected Error', () => new Error('boom')]
    ];

    function newClient() {
      return {
        config: { apiUrl: 'http://test', authToken: 'test' },
        callAPI: vi.fn(),
        executeDatalogQuery: vi.fn()
      } as unknown as LogseqClient;
    }

    it('returns an empty warnings array when nothing was skipped', async () => {
      const client = newClient();
      (client.executeDatalogQuery as any)
        .mockResolvedValueOnce([[{ id: 1, name: 'alpha', properties: {} }]])
        .mockResolvedValueOnce([]);
      (client.callAPI as any).mockResolvedValue([]);

      const result = await getContextForQuery(client, 'About [[Alpha]]');

      expect(result.warnings).toEqual([]);
      expect(result.contexts).toHaveLength(1);
    });

    it('returns a page with no backlinks as a context, without warnings', async () => {
      const client = newClient();
      (client.executeDatalogQuery as any)
        .mockResolvedValueOnce([[{ id: 1, name: 'alpha', properties: {} }]])
        .mockResolvedValueOnce([]);
      (client.callAPI as any).mockResolvedValue(null);

      const result = await getContextForQuery(client, 'About [[Alpha]]');

      expect(result.contexts).toHaveLength(1);
      expect(result.contexts[0].references).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('warns about a missing topic and still returns the others', async () => {
      const client = newClient();
      (client.executeDatalogQuery as any)
        .mockResolvedValueOnce([])                                           // first topic: no exact name or alias
        .mockResolvedValueOnce([])                                           // first topic: no namespace leaf either
        .mockResolvedValueOnce([[{ id: 2, name: 'beta', properties: {} }]])  // second topic: page
        .mockResolvedValueOnce([[{ id: 20, content: 'A block' }]]);          // second topic: blocks
      (client.callAPI as any).mockResolvedValue([]);

      const result = await getContextForQuery(client, 'Compare [[Missing Topic]] and [[Beta]]');

      expect(result.contexts.map(c => c.topic)).toEqual(['Beta']);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatchObject({ code: 'topic_not_found', topic: 'Missing Topic' });
      expect(result.summary.totalTopics).toBe(1);
    });

    it('skips an ambiguous topic with an ambiguous_page warning that lists the candidates', async () => {
      const client = newClient();
      (client.executeDatalogQuery as any)
        .mockResolvedValueOnce([
          [{ id: 1, name: 'project atlas', 'original-name': 'Project Atlas' }, 'alias'],
          [{ id: 3, name: 'atlas cafe', 'original-name': 'Atlas Cafe' }, 'alias']
        ])                                                                   // first topic: alias shared by two pages
        .mockResolvedValueOnce([[{ id: 2, name: 'beta', properties: {} }]])  // second topic: page
        .mockResolvedValueOnce([[{ id: 20, content: 'A block' }]]);          // second topic: blocks
      (client.callAPI as any).mockResolvedValue([]);

      const result = await getContextForQuery(client, 'Compare [[Atlas]] and [[Beta]]');

      expect(result.contexts.map(c => c.topic)).toEqual(['Beta']);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatchObject({ code: 'ambiguous_page', topic: 'Atlas' });
      expect(result.warnings[0].candidates?.map(c => c.name)).toEqual(['atlas cafe', 'project atlas']);
      expect(result.hasMore).toBe(false);
    });

    it('tells the model how to narrow an ambiguous topic whose candidate list was cut', async () => {
      const client = newClient();
      (client.executeDatalogQuery as any).mockResolvedValueOnce(
        Array.from({ length: 12 }, (_, i) => [
          { id: 100 + i, name: `team ${i}/atlas`, 'original-name': `Team ${i}/Atlas`, file: { id: 1 } },
          'alias'
        ])
      );
      (client.callAPI as any).mockResolvedValue([]);

      const result = await getContextForQuery(client, 'About [[Atlas]]');

      expect(result.warnings[0]).toMatchObject({ code: 'ambiguous_page', topic: 'Atlas', totalCandidates: 12 });
      expect(result.warnings[0].candidates).toHaveLength(10);
      expect(result.warnings[1]).toMatchObject({ code: 'candidates_truncated', topic: 'Atlas' });
      expect(result.warnings[1].message).toContain('logseq_list_pages');
      // No parameter fetches the rest, so hasMore stays false; the warning is the signal
      expect(result.hasMore).toBe(false);
    });

    it.each(allErrors)('propagates %s from the per-topic context build', async (_name, makeError) => {
      const client = newClient();
      const error = makeError();
      (client.executeDatalogQuery as any).mockRejectedValue(error);

      await expect(getContextForQuery(client, 'About [[Alpha]]')).rejects.toBe(error);
    });

    it.each(allErrors)('propagates %s raised by the backlinks call for a later topic', async (_name, makeError) => {
      const client = newClient();
      const error = makeError();
      (client.executeDatalogQuery as any)
        .mockResolvedValueOnce([[{ id: 1, name: 'alpha', properties: {} }]])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([[{ id: 2, name: 'beta', properties: {} }]])
        .mockResolvedValueOnce([]);
      (client.callAPI as any)
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(error);

      await expect(getContextForQuery(client, 'See [[Alpha]] and [[Beta]]')).rejects.toBe(error);
    });

    it.each(allErrors)('propagates %s from the keyword search', async (_name, makeError) => {
      const client = newClient();
      const error = makeError();
      (client.executeDatalogQuery as any).mockRejectedValue(error);
      (client.callAPI as any).mockRejectedValue(error);

      await expect(
        getContextForQuery(client, 'How do databases work?')
      ).rejects.toBe(error);
    });

    it('treats a null search response as no matches', async () => {
      const client = newClient();
      (client.executeDatalogQuery as any).mockResolvedValue(null);

      const result = await getContextForQuery(client, 'How do databases work?');

      expect(result.searchResults).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('truncation warnings (#40)', () => {
    function newClient() {
      return {
        config: { apiUrl: 'http://test', authToken: 'test' },
        callAPI: vi.fn(),
        executeDatalogQuery: vi.fn()
      } as unknown as LogseqClient;
    }

    it('has no truncation warning and hasMore false when nothing is cut', async () => {
      const client = newClient();
      (client.executeDatalogQuery as any)
        .mockResolvedValueOnce([[{ id: 1, name: 'alpha', properties: {} }]])
        .mockResolvedValueOnce([[{ id: 10, content: 'one' }]]);
      (client.callAPI as any).mockResolvedValue([]);

      const result = await getContextForQuery(client, 'About [[Alpha]]');

      expect(result.warnings).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.contexts[0]).not.toHaveProperty('warnings');
      expect(result.contexts[0]).not.toHaveProperty('totals');
    });

    it('rolls a topic that hit a cap up into a warning with a build_context call', async () => {
      const client = newClient();
      const blocks = Array.from({ length: 14 }, (_, i) => [{ id: 100 + i, content: `b${i}` }]);
      (client.executeDatalogQuery as any)
        .mockResolvedValueOnce([[{ id: 1, name: 'alpha', properties: {} }]])
        .mockResolvedValueOnce(blocks);
      (client.callAPI as any).mockResolvedValue([]);

      const result = await getContextForQuery(client, 'About [[Alpha "x"]]');

      expect(result.contexts[0].directBlocks).toHaveLength(10);
      expect(result.hasMore).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatchObject({ code: 'topic_truncated', topic: 'Alpha "x"' });
      expect(result.warnings[0].message).toContain('10/14 blocks');
      expect(result.warnings[0].howToFetchAll).toContain('logseq_build_context');
      expect(result.warnings[0].howToFetchAll).toContain('topic_name "Alpha \\"x\\""');
      expect(result.warnings[0].howToFetchAll).toContain('max_blocks (14)');
    });

    it('warns when maxTopics drops extracted topics', async () => {
      const client = newClient();
      (client.executeDatalogQuery as any)
        .mockResolvedValueOnce([[{ id: 1, name: 'alpha', properties: {} }]])
        .mockResolvedValueOnce([]);
      (client.callAPI as any).mockResolvedValue([]);

      const result = await getContextForQuery(client, 'See [[Alpha]], [[Beta]] and [[Gamma]]', { maxTopics: 1 });

      expect(result.contexts).toHaveLength(1);
      expect(result.hasMore).toBe(true);
      expect(result.warnings).toEqual([
        {
          code: 'topics_truncated',
          message: 'Found 3 topics; only the first 1 were used.',
          howToFetchAll: 'Set max_topics to 3 (or higher) to use all of them.'
        }
      ]);
    });

    it('does not set hasMore for a skipped topic that has no way to continue', async () => {
      const client = newClient();
      (client.executeDatalogQuery as any).mockResolvedValueOnce([]);

      const result = await getContextForQuery(client, 'About [[Missing]]');

      expect(result.warnings.map(w => w.code)).toEqual(['topic_not_found']);
      expect(result.hasMore).toBe(false);
    });
  });

  describe('max_search_results cap (#61)', () => {
    const QUERY = 'about widgets';

    function newClient() {
      return {
        config: { apiUrl: 'http://test', authToken: 'test' },
        callAPI: vi.fn(),
        executeDatalogQuery: vi.fn()
      } as unknown as LogseqClient;
    }

    /** `n` search rows that all contain the keyword, ids 1..n (so newest first is n..1). */
    function hitRows(n: number, content = (i: number) => `widgets ${i}`) {
      return Array.from({ length: n }, (_, i) => [{ id: i + 1, content: content(i + 1), page: { id: 1000 + i + 1 } }]);
    }

    async function run(rows: unknown, options: Parameters<typeof getContextForQuery>[2] = {}) {
      const client = newClient();
      (client.executeDatalogQuery as any).mockResolvedValueOnce(rows);
      const result = await getContextForQuery(client, QUERY, options);
      return { client, result };
    }

    it('exports the advertised default and maximum', () => {
      expect(DEFAULT_MAX_SEARCH_RESULTS).toBe(20);
      expect(MAX_SEARCH_RESULTS).toBe(100);
    });

    it('keeps the result unchanged when the hits fit the default', async () => {
      const { client, result } = await run(hitRows(20));

      expect(result.searchResults).toHaveLength(20);
      expect(result.searchResults![0].id).toBe(20);
      expect(result.warnings).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(client.executeDatalogQuery).toHaveBeenCalledTimes(1);
    });

    it('reports the slice at the default 20, which used to be silent', async () => {
      const { result } = await run(hitRows(25));

      expect(result.searchResults!.map(b => b.id)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
      expect(result.hasMore).toBe(true);
      expect(result.warnings).toEqual([
        {
          code: 'search_results_truncated',
          message: 'Showing 20 of 25 keyword hits.',
          howToFetchAll: 'Set max_search_results to 25 (or higher) to get all 25.'
        }
      ]);
    });

    it('suggests the maximum, not the total, when more than 100 hits match', async () => {
      const { result } = await run(hitRows(150), { maxSearchResults: 50 });

      expect(result.searchResults).toHaveLength(50);
      expect(result.hasMore).toBe(true);
      expect(result.warnings).toEqual([
        {
          code: 'search_results_truncated',
          message: 'Showing 50 of 150 keyword hits.',
          howToFetchAll:
            'Set max_search_results to 100 (the maximum) to get 100 of 150. Put the most specific words first: only the first three words longer than three letters, other than stop words, are searched.'
        }
      ]);
    });

    it('has hasMore false and no howToFetchAll for a cut at the maximum', async () => {
      const { result } = await run(hitRows(150), { maxSearchResults: 100 });

      expect(result.searchResults).toHaveLength(100);
      expect(result.hasMore).toBe(false);
      expect(result.warnings).toEqual([
        {
          code: 'search_results_truncated',
          message:
            "Showing 100 of 150 keyword hits: max_search_results is capped at its maximum of 100, so the rest can't be fetched in one call. " +
            'Put the most specific words first: only the first three words longer than three letters, other than stop words, are searched.'
        }
      ]);
    });

    it('clamps a value above the maximum to 100 and says what was asked for', async () => {
      const { result } = await run(hitRows(150), { maxSearchResults: 500 });

      expect(result.searchResults).toHaveLength(100);
      expect(result.searchResults![0].id).toBe(150);
      expect(result.hasMore).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].howToFetchAll).toBeUndefined();
      expect(result.warnings[0].message).toContain('capped at its maximum of 100 (500 was asked for)');
    });

    it('returns every hit with no warning when a value above the maximum is not reached', async () => {
      const { result } = await run(hitRows(100), { maxSearchResults: 500 });

      expect(result.searchResults).toHaveLength(100);
      expect(result.warnings).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it('never suggests a value past the maximum', async () => {
      for (const [hits, asked] of [[30, 20], [101, 20], [101, 100], [400, 1000]] as const) {
        const { result } = await run(hitRows(hits), { maxSearchResults: asked });
        expect(result.searchResults!.length).toBeLessThanOrEqual(MAX_SEARCH_RESULTS);
        for (const w of result.warnings) {
          for (const n of `${w.howToFetchAll ?? ''}`.match(/max_search_results to (\d+)/g) ?? []) {
            expect(Number(n.split(' ').pop())).toBeLessThanOrEqual(MAX_SEARCH_RESULTS);
          }
        }
      }
    });

    it('counts only blocks that hold every keyword, and finds them past three times the cap', async () => {
      // 'about widgets gadgets': the newest 10 matches of "widgets" lack "gadgets".
      // The old 3x pre-cut (6 blocks for max 2) would have found none of the 3 that match.
      const rows = hitRows(13, i => (i <= 3 ? `widgets and gadgets ${i}` : `widgets ${i}`));
      const client = newClient();
      (client.executeDatalogQuery as any).mockResolvedValueOnce(rows);

      const result = await getContextForQuery(client, 'about widgets gadgets', { maxSearchResults: 2 });

      expect(result.searchResults!.map(b => b.id)).toEqual([3, 2]);
      expect(result.warnings).toEqual([
        {
          code: 'search_results_truncated',
          message: 'Showing 2 of 3 keyword hits.',
          howToFetchAll: 'Set max_search_results to 3 (or higher) to get all 3.'
        }
      ]);
    });

    describe('searches the longest keyword', () => {
      // A small graph, in no particular order: LogSeq answers a search with the
      // blocks whose content matches the pattern, unsorted.
      const corpus = [
        { id: 7, content: 'that one' },
        { id: 3, content: 'that widgets gadget' },
        { id: 9, content: 'Widgets, that is' },
        { id: 1, content: 'widgets only' },
        { id: 12, content: 'THAT WIDGETS again' },
        { id: 5, content: 'that and that' },
        { id: 10, content: 'widgets that gadget' }
      ].map(block => ({ ...block, page: { id: 100 } }));

      function corpusClient() {
        const client = newClient();
        (client.executeDatalogQuery as any).mockImplementation(async (_query: string, pattern: string) => {
          const re = new RegExp(pattern.replace(/^\(\?i\)/, ''), 'i');
          return corpus.filter(block => re.test(block.content)).map(block => [block]);
        });
        return client;
      }

      it('sends the longest keyword to LogSeq, not the first', async () => {
        const client = corpusClient();
        await getContextForQuery(client, 'that widgets');

        expect(client.executeDatalogQuery).toHaveBeenCalledTimes(1);
        expect((client.executeDatalogQuery as any).mock.calls[0][1]).toBe('(?i)widgets');
      });

      it('takes the first of equally long keywords', async () => {
        const client = corpusClient();
        await getContextForQuery(client, 'gadget widget');

        expect((client.executeDatalogQuery as any).mock.calls[0][1]).toBe('(?i)gadget');
      });

      it('returns the same hits in the same order as searching the first keyword', async () => {
        // What searching "that" (the first keyword) and filtering would give
        const { searchBlocks } = await import('./search-blocks.js');
        const byFirst = ((await searchBlocks(corpusClient(), 'that', Infinity)) as Array<{ id: number; content: string }>)
          .filter(block => block.content.toLowerCase().includes('widgets'))
          .map(block => block.id);

        const result = await getContextForQuery(corpusClient(), 'that widgets', { maxSearchResults: 3 });

        expect(byFirst).toEqual([12, 10, 9, 3]);
        expect(result.searchResults!.map(block => block.id)).toEqual(byFirst.slice(0, 3));
        expect(result.warnings[0].message).toBe('Showing 3 of 4 keyword hits.');
      });
    });

    it('keeps no hits for a negative value, and reports the cut', async () => {
      const { result } = await run(hitRows(5), { maxSearchResults: -1 });

      expect(result.searchResults).toEqual([]);
      expect(result.warnings.map(w => w.code)).toEqual(['search_results_truncated']);
      expect(result.warnings[0].message).toBe('Showing 0 of 5 keyword hits.');
    });

    it('makes one search call at the maximum, and looks up pages only for the hits kept', async () => {
      const client = newClient();
      (client.executeDatalogQuery as any)
        .mockResolvedValueOnce(hitRows(150))
        .mockImplementationOnce(async () =>
          Array.from({ length: 100 }, (_, i) => [{ id: 1150 - i, name: `p${i}`, 'original-name': `P${i}` }])
        );

      const result = await getContextForQuery(client, QUERY, { maxSearchResults: 100, hitPages: true });

      expect(client.executeDatalogQuery).toHaveBeenCalledTimes(2);
      const [, ...pageInputs] = (client.executeDatalogQuery as any).mock.calls[1];
      const pagesQuery: string = (client.executeDatalogQuery as any).mock.calls[1][0];
      const ids = [...pagesQuery.matchAll(/\b1\d{3}\b/g)].map(m => Number(m[0]));
      expect(pageInputs).toEqual([]);
      expect(new Set(ids)).toEqual(new Set(Array.from({ length: 100 }, (_, i) => 1150 - i)));
      expect(result.searchResults).toHaveLength(100);
      expect((result.searchResults![0] as SearchBlocksResult).context?.page.id).toBe(1150);
    });

    it('adds no warning when no keyword survives the stop-word filter', async () => {
      const client = newClient();
      const result = await getContextForQuery(client, 'what is it', { maxSearchResults: 500 });

      expect(result.searchResults).toBeUndefined();
      expect(result.warnings).toEqual([]);
      expect(client.executeDatalogQuery).not.toHaveBeenCalled();
    });
  });
});
