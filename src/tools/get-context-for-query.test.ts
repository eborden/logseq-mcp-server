import { describe, it, expect, vi } from 'vitest';
import { getContextForQuery } from './get-context-for-query.js';
import { LogseqClient } from '../client.js';

describe('getContextForQuery', () => {
  it('should extract topics from query and build context', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock search for topics mentioned in query
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      name: 'Project X',
      properties: {}
    });

    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 10, content: 'Relevant block' }
    ]);

    (mockClient.callAPI as any).mockResolvedValueOnce([]);
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 2,
      name: 'Team Meeting',
      properties: {}
    });

    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 11, content: 'Meeting notes' }
    ]);

    (mockClient.callAPI as any).mockResolvedValueOnce([]);
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

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
      callAPI: vi.fn()
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
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock Topic A
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      name: 'Topic A'
    });

    (mockClient.callAPI as any).mockResolvedValueOnce([]);
    (mockClient.callAPI as any).mockResolvedValueOnce([]);
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    // Mock Topic B
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 2,
      name: 'Topic B'
    });

    (mockClient.callAPI as any).mockResolvedValueOnce([]);
    (mockClient.callAPI as any).mockResolvedValueOnce([]);
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    const result = await getContextForQuery(
      mockClient,
      'Compare [[Topic A]] and [[Topic B]]'
    );

    expect(result.contexts.length).toBe(2);
    expect(result.extractedTopics).toEqual(['Topic A', 'Topic B']);
  });

  it('should extract hashtags from query', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock #tag page
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      name: 'important'
    });

    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 10, content: 'Tagged content' }
    ]);

    (mockClient.callAPI as any).mockResolvedValueOnce([]);
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    const result = await getContextForQuery(
      mockClient,
      'Show me #important items'
    );

    expect(result.extractedTopics).toContain('important');
    expect(result.contexts).toHaveLength(1);
  });

  it('should deduplicate extracted topics', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      name: 'Topic'
    });

    (mockClient.callAPI as any).mockResolvedValueOnce([]);
    (mockClient.callAPI as any).mockResolvedValueOnce([]);
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    const result = await getContextForQuery(
      mockClient,
      'Tell me about [[Topic]] and more about [[Topic]]'
    );

    expect(result.extractedTopics).toEqual(['Topic']);
    expect(result.contexts).toHaveLength(1);
  });

  it('should skip topics that do not exist', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // First topic exists
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      name: 'Exists'
    });

    (mockClient.callAPI as any).mockResolvedValueOnce([]);
    (mockClient.callAPI as any).mockResolvedValueOnce([]);
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    // Second topic doesn't exist
    (mockClient.callAPI as any).mockResolvedValueOnce(null);

    const result = await getContextForQuery(
      mockClient,
      'Compare [[Exists]] and [[DoesNotExist]]'
    );

    expect(result.extractedTopics).toEqual(['Exists', 'DoesNotExist']);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0].topic).toBe('Exists');
  });
});
