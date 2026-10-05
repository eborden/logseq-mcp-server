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
      const mockResponse = { result: 'success' };
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
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockData
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
      ).rejects.toThrow(/Cannot connect to LogSeq/);
    });

    it('should throw error on network timeout', async () => {
      const timeoutError = new Error('fetch failed');
      (timeoutError as any).code = 'ETIMEDOUT';
      global.fetch = vi.fn().mockRejectedValue(timeoutError) as any;

      await expect(
        client.callAPI('logseq.Editor.getBlock', ['block-uuid'])
      ).rejects.toThrow(/Cannot connect to LogSeq/);
    });

    it('should handle API error response', async () => {
      const mockResponse = {
        error: 'Invalid method'
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
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockData
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

  describe('executeDatalogQuery', () => {
    it('should execute Datalog query via logseq.DB.datascriptQuery', async () => {
      const mockResponse = [
        [{ id: 1, name: 'Page A' }],
        [{ id: 2, name: 'Page B' }]
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      }) as any;

      const query = '[:find (pull ?p [*]) :where [?p :block/name]]';
      const result = await client.executeDatalogQuery(query);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:12315/api',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            method: 'logseq.DB.datascriptQuery',
            args: [query]
          })
        })
      );

      expect(result).toEqual(mockResponse);
    });

    describe('inputs', () => {
      const query = '[:find ?p :in $ ?name :where [?p :block/name ?name]]';

      async function sentArgs(...inputs: unknown[]): Promise<unknown[]> {
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => []
        }) as any;
        await client.executeDatalogQuery(query, ...inputs);
        const [, init] = (global.fetch as any).mock.calls[0];
        return JSON.parse(init.body).args;
      }

      it('sends no extra args when there are no inputs', async () => {
        expect(await sentArgs()).toEqual([query]);
      });

      it('EDN-quotes a string input so LogSeq reads a string, not a symbol', async () => {
        // The input travels as the JSON text of a string: "\"my page\""
        expect(await sentArgs('my page')).toEqual([query, '"my page"']);
      });

      it('escapes double quotes', async () => {
        expect(await sentArgs('foo "bar')).toEqual([query, '"foo \\"bar"']);
      });

      it('escapes backslashes', async () => {
        expect(await sentArgs('a\\b')).toEqual([query, '"a\\\\b"']);
      });

      it('escapes newlines', async () => {
        expect(await sentArgs('line1\nline2')).toEqual([query, '"line1\\nline2"']);
      });

      it('sends inputs in order', async () => {
        expect(await sentArgs('a', 'b')).toEqual([query, '"a"', '"b"']);
      });

      it('encodes numbers as EDN numbers', async () => {
        expect(await sentArgs(42)).toEqual([query, '42']);
      });
    });
  });
});
