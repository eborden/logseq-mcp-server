import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getContextForQuery } from './get-context-for-query.js';
import { LogseqClient } from '../client.js';
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
});
