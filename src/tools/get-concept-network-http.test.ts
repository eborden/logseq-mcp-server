import { describe, it, expect, vi } from 'vitest';
import { getConceptNetworkHTTP } from './get-concept-network-http.js';
import { LogseqClient } from '../client.js';

describe('getConceptNetworkHTTP', () => {
  it('should return network of pages related to concept', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock getPage for root concept
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      name: 'Concept',
      originalName: 'Concept'
    });

    // Mock references
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 2, name: 'Related 1' },
      { id: 3, name: 'Related 2' }
    ]);

    // Mock backlinks
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { page: { id: 4, name: 'Backlink 1' } }
    ]);

    const result = await getConceptNetworkHTTP(mockClient, 'Concept', 2);

    expect(result).toHaveProperty('concept', 'Concept');
    expect(result).toHaveProperty('nodes');
    expect(result).toHaveProperty('edges');
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.edges.length).toBeGreaterThan(0);
  });

  it('should respect max depth', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValue({
      id: 1,
      name: 'Concept'
    });

    const result = await getConceptNetworkHTTP(mockClient, 'Concept', 0);

    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
  });

  it('should detect cycles and not infinite loop', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Root page
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      name: 'Page A'
    });

    // Page A references Page B
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 2, name: 'Page B' }
    ]);
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    // Page B references Page A (cycle!)
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 2,
      name: 'Page B'
    });
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 1, name: 'Page A' }
    ]);

    const result = await getConceptNetworkHTTP(mockClient, 'Page A', 3);

    expect(result.nodes).toHaveLength(2);
    expect(result.edges.some(e => e.from === 1 && e.to === 2)).toBe(true);
  });
});
