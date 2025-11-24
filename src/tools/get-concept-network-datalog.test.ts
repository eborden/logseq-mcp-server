import { describe, it, expect, vi } from 'vitest';
import { getConceptNetwork } from './get-concept-network.js';
import { LogseqClient } from '../client.js';

describe('getConceptNetwork (Datalog)', () => {
  it('should execute multi-query BFS and transform results to network', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn(),
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 0: Get root page (depth=0)
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 1, name: 'Root Page' }]
    ]);

    // Mock HTTP API call for depth=1: getConnectedPageIds('Root Page')
    (mockClient.callAPI as any).mockResolvedValueOnce([
      [{ id: 2, name: 'Connected A' }, []],
      [{ id: 3, name: 'Connected B' }, []]
    ]);

    // Mock Datalog queries for fetching page details at depth=1
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([[{ id: 2, name: 'Connected A' }]]);
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([[{ id: 3, name: 'Connected B' }]]);

    // Mock HTTP API call for depth=2: getConnectedPageIds for nodes 2 and 3
    (mockClient.callAPI as any).mockResolvedValueOnce([
      [{ id: 4, name: 'Level 2 Page' }, []]
    ]);

    // Mock Datalog query for fetching page 4 details
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([[{ id: 4, name: 'Level 2 Page' }]]);

    const result = await getConceptNetwork(mockClient, 'Root Page', 2);

    expect(result.concept).toBe('Root Page');
    expect(result.nodes.length).toBe(4);
    expect(result.nodes).toContainEqual({ id: 1, name: 'Root Page', depth: 0 });
    expect(result.nodes).toContainEqual(expect.objectContaining({ id: 2, name: 'Connected A', depth: 1 }));
    expect(result.nodes).toContainEqual(expect.objectContaining({ id: 3, name: 'Connected B', depth: 1 }));
    expect(result.nodes).toContainEqual(expect.objectContaining({ id: 4, name: 'Level 2 Page', depth: 2 }));
    expect(result.edges.length).toBe(3);
  });

  it('should throw error when page not found', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Empty results = page not found
    (mockClient.executeDatalogQuery as any).mockResolvedValue([]);

    await expect(
      getConceptNetwork(mockClient, 'NonExistent', 2)
    ).rejects.toThrow('Page not found: NonExistent');
  });

  it('should handle page with no connections', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn(),
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 0: Get root page (depth=0)
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 1, name: 'Isolated Page' }]
    ]);

    // Mock HTTP API call: No connections
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    const result = await getConceptNetwork(mockClient, 'Isolated Page', 2);

    expect(result.nodes.length).toBe(1);
    expect(result.edges.length).toBe(0);
  });

  it('should handle case-insensitive page names', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn(),
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 0: Get root page - name stored lowercase in DB
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 1, name: 'christy' }]
    ]);

    // Mock HTTP API call: No connections
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    // Should work with capital C
    const result = await getConceptNetwork(mockClient, 'Christy', 1);

    expect(result.concept).toBe('Christy');
    expect(result.nodes[0].name).toBe('christy'); // DB returns lowercase

    // Verify query has lowercase embedded in it
    expect(mockClient.executeDatalogQuery).toHaveBeenCalledWith(
      expect.stringContaining('christy')  // Lowercased embedded in query
    );
  });
});
