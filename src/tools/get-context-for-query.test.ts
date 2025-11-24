import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getContextForQuery } from './get-context-for-query.js';
import { LogseqClient } from '../client.js';

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

    // Mock executeDatalogQuery to return simple page+block data for any topic
    let callCount = 0;
    (mockClient.executeDatalogQuery as any).mockImplementation(async () => {
      callCount++;
      // Odd calls: page+blocks, Even calls: connections
      if (callCount % 2 === 1) {
        const pageId = Math.floor(callCount / 2) + 1;
        return [[{ id: pageId, name: `Topic ${pageId}`, properties: {} }, { id: pageId * 10, content: `Block ${pageId}` }]];
      } else {
        return []; // No connections
      }
    });

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

    // Mock Datalog queries for both topics
    let callCount = 0;
    (mockClient.executeDatalogQuery as any).mockImplementation(async () => {
      callCount++;
      // Odd calls: page+blocks query, Even calls: connections query
      if (callCount === 1) {
        return [[{ id: 1, name: 'Topic A', properties: {} }, { id: 10, content: 'Block A' }]];
      } else if (callCount === 2) {
        return []; // No connections for Topic A
      } else if (callCount === 3) {
        return [[{ id: 2, name: 'Topic B', properties: {} }, { id: 20, content: 'Block B' }]];
      } else if (callCount === 4) {
        return []; // No connections for Topic B
      }
      return [];
    });

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

    // Mock Datalog queries for hashtag
    let callCount = 0;
    (mockClient.executeDatalogQuery as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First query: page+blocks
        return [[{ id: 1, name: 'important', properties: {} }, { id: 10, content: 'Tagged content' }]];
      } else if (callCount === 2) {
        // Second query: connections
        return [];
      }
      return [];
    });

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

    // Mock Datalog queries - topic appears twice but should only query once
    let callCount = 0;
    (mockClient.executeDatalogQuery as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [[{ id: 1, name: 'Topic', properties: {} }, { id: 10, content: 'Block' }]];
      } else if (callCount === 2) {
        return []; // No connections
      }
      return [];
    });

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

    // Mock Datalog queries
    let callCount = 0;
    (mockClient.executeDatalogQuery as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First topic exists
        return [[{ id: 1, name: 'Exists', properties: {} }, { id: 10, content: 'Block' }]];
      } else if (callCount === 2) {
        // Connections for first topic
        return [];
      } else if (callCount === 3) {
        // Second topic doesn't exist - empty result
        return [];
      }
      return [];
    });

    const result = await getContextForQuery(
      mockClient,
      'Compare [[Exists]] and [[DoesNotExist]]'
    );

    expect(result.extractedTopics).toEqual(['Exists', 'DoesNotExist']);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0].topic).toBe('Exists');
  });
});
