import { describe, it, expect, vi } from 'vitest';
import { getConceptNetwork } from './get-concept-network.js';
import { LogseqClient } from '../client.js';

describe('getConceptNetwork (Datalog)', () => {
  it('should execute multi-query BFS and transform results to network', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 0: Get root page (depth=0)
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 1, name: 'Root Page' }]
    ]);

    // Mock Query 1: Get pages connected to root (depth=1)
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [1, { id: 2, name: 'Connected A' }, 'outbound'],
      [1, { id: 3, name: 'Connected B' }, 'inbound']
    ]);

    // Mock Query 2: Get pages connected to depth=1 nodes (depth=2)
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [2, { id: 4, name: 'Level 2 Page' }, 'outbound']
    ]);

    const result = await getConceptNetwork(mockClient, 'Root Page', 2);

    // Should make 3 queries (depth 0, 1, 2)
    expect(mockClient.executeDatalogQuery).toHaveBeenCalledTimes(3);

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
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 0: Get root page (depth=0)
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 1, name: 'Isolated Page' }]
    ]);

    // Mock Query 1: No connections found (empty results)
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([]);

    const result = await getConceptNetwork(mockClient, 'Isolated Page', 2);

    expect(result.nodes.length).toBe(1);
    expect(result.edges.length).toBe(0);
  });

  it('should handle case-insensitive page names', async () => {
    const mockClient = {
      config: {},
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    // Mock Query 0: Get root page - name stored lowercase in DB
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([
      [{ id: 1, name: 'christy' }]
    ]);

    // Mock Query 1: No connections
    (mockClient.executeDatalogQuery as any).mockResolvedValueOnce([]);

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
