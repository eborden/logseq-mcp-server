import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getGraphInfo } from './get-graph-info.js';
import { LogseqClient } from '../client.js';
import { GraphInfo } from '../types.js';

describe('getGraphInfo', () => {
  let mockClient: LogseqClient;

  beforeEach(() => {
    mockClient = {
      callAPI: vi.fn()
    } as any;
  });

  it('should call logseq.App.getCurrentGraph with no arguments', async () => {
    const mockGraphInfo: GraphInfo = {
      url: 'logseq_local_/Users/test/Documents/Logs',
      name: 'Logs',
      path: '/Users/test/Documents/Logs'
    };

    (mockClient.callAPI as any).mockResolvedValue(mockGraphInfo);

    const result = await getGraphInfo(mockClient);

    expect(mockClient.callAPI).toHaveBeenCalledWith('logseq.App.getCurrentGraph', []);
    expect(result).toEqual(mockGraphInfo);
  });

  it('should return GraphInfo with all properties', async () => {
    const mockGraphInfo: GraphInfo = {
      url: 'logseq_local_/Users/evanborden/Documents/Logs',
      name: 'Logs',
      path: '/Users/evanborden/Documents/Logs'
    };

    (mockClient.callAPI as any).mockResolvedValue(mockGraphInfo);

    const result = await getGraphInfo(mockClient);

    expect(result).toEqual(mockGraphInfo);
    expect(result.url).toBe('logseq_local_/Users/evanborden/Documents/Logs');
    expect(result.name).toBe('Logs');
    expect(result.path).toBe('/Users/evanborden/Documents/Logs');
  });

  it('should throw error if graph info cannot be retrieved (result is null)', async () => {
    (mockClient.callAPI as any).mockResolvedValue(null);

    await expect(
      getGraphInfo(mockClient)
    ).rejects.toThrow('Failed to retrieve graph information');
  });

  it('should propagate errors from the API client', async () => {
    (mockClient.callAPI as any).mockRejectedValue(
      new Error('Failed to connect to LogSeq API')
    );

    await expect(
      getGraphInfo(mockClient)
    ).rejects.toThrow('Failed to connect to LogSeq API');
  });

  it('should handle graph in different location', async () => {
    const mockGraphInfo: GraphInfo = {
      url: 'logseq_local_/home/user/knowledge-base',
      name: 'knowledge-base',
      path: '/home/user/knowledge-base'
    };

    (mockClient.callAPI as any).mockResolvedValue(mockGraphInfo);

    const result = await getGraphInfo(mockClient);

    expect(result.path).toBe('/home/user/knowledge-base');
    expect(result.name).toBe('knowledge-base');
  });
});
