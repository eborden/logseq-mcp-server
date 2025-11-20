import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogseqClient } from './client.js';

describe('LogseqClient', () => {
  let client: LogseqClient;
  const mockConfig = {
    apiUrl: 'http://localhost:12315',
    authToken: 'test-token-123'
  };

  beforeEach(() => {
    client = new LogseqClient(mockConfig);
    vi.restoreAllMocks();
  });

  describe('callAPI', () => {
    it('should call LogSeq API with correct headers', async () => {
      const mockResponse = { data: { result: 'success' } };
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });
      global.fetch = fetchMock as any;

      await client.callAPI('logseq.Editor.getBlock', ['block-uuid']);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:12315/api',
        {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer test-token-123',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            method: 'logseq.Editor.getBlock',
            args: ['block-uuid']
          })
        }
      );
    });

    it('should return response data on success', async () => {
      const mockData = { id: 1, content: 'test block' };
      const mockResponse = { data: mockData };
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      }) as any;

      const result = await client.callAPI('logseq.Editor.getBlock', ['block-uuid']);

      expect(result).toEqual(mockData);
    });

    it('should throw error on HTTP 401 (unauthorized)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized'
      }) as any;

      await expect(
        client.callAPI('logseq.Editor.getBlock', ['block-uuid'])
      ).rejects.toThrow('HTTP 401: Unauthorized');
    });

    it('should throw error on HTTP 404 (not found)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      }) as any;

      await expect(
        client.callAPI('logseq.Editor.getBlock', ['block-uuid'])
      ).rejects.toThrow('HTTP 404: Not Found');
    });

    it('should throw error on connection failure (ECONNREFUSED)', async () => {
      const connectionError = new Error('fetch failed');
      (connectionError as any).code = 'ECONNREFUSED';
      global.fetch = vi.fn().mockRejectedValue(connectionError) as any;

      await expect(
        client.callAPI('logseq.Editor.getBlock', ['block-uuid'])
      ).rejects.toThrow('Failed to connect to LogSeq API');
    });

    it('should throw error on network timeout', async () => {
      const timeoutError = new Error('fetch failed');
      (timeoutError as any).code = 'ETIMEDOUT';
      global.fetch = vi.fn().mockRejectedValue(timeoutError) as any;

      await expect(
        client.callAPI('logseq.Editor.getBlock', ['block-uuid'])
      ).rejects.toThrow('Failed to connect to LogSeq API');
    });

    it('should handle API error response', async () => {
      const mockResponse = {
        error: {
          message: 'Invalid method',
          code: 'INVALID_METHOD'
        }
      };
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      }) as any;

      await expect(
        client.callAPI('invalid.method', [])
      ).rejects.toThrow('LogSeq API error: Invalid method');
    });

    it('should work with method calls that have no arguments', async () => {
      const mockData = { version: '1.0.0' };
      const mockResponse = { data: mockData };
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      }) as any;

      const result = await client.callAPI('logseq.App.getVersion');

      expect(result).toEqual(mockData);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:12315/api',
        expect.objectContaining({
          body: JSON.stringify({
            method: 'logseq.App.getVersion',
            args: []
          })
        })
      );
    });
  });
});
