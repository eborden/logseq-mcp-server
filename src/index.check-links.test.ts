import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';
import { MAX_LINK_TERMS, MAX_TEXT_CHARS } from './tools/check-links.js';

/**
 * logseq_check_links through the MCP server (#146): arguments are parsed and
 * bounded before any LogSeq call, and the result is one minified JSON object
 * with the four checks and ResultMeta.
 */

afterEach(() => vi.restoreAllMocks());

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

async function withServer<T>(rows: unknown[], fn: (mcp: Client, calls: unknown[][]) => Promise<T>): Promise<T> {
  const calls: unknown[][] = [];
  const logseq = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' });
  vi.spyOn(logseq, 'callAPI').mockImplementation(async (method: string) => {
    throw new Error(`unexpected Editor call ${method}`);
  });
  vi.spyOn(logseq, 'executeDatalogQuery').mockImplementation(async (...args: unknown[]) => {
    calls.push(args);
    return rows as any;
  });
  const server = createServer(logseq, { tips: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    return await fn(mcp, calls);
  } finally {
    await mcp.close();
  }
}

const call = (mcp: Client, args: Record<string, unknown>) =>
  mcp.callTool({ name: 'logseq_check_links', arguments: args }) as Promise<ToolResult>;

describe('logseq_check_links (#146)', () => {
  it('returns the four checks and meta in one block, after one Datalog query', async () => {
    const alice = { id: 1, name: 'alice', 'original-name': 'Alice', file: { id: 9 } };
    await withServer([[alice, 'name', 'alice']], async (mcp, calls) => {
      const result = await call(mcp, { before: 'Alice met Bob', after: '[[Alice]] met [[Bob]]' });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);
      expect(JSON.parse(result.content[0].text)).toEqual({
        ok: false,
        prose: { ok: true },
        brackets: { ok: true, opens: 2, closes: 2 },
        refs: {
          ok: false,
          resolved: [{ term: 'Alice', page: 'Alice', matchedBy: 'name' }],
          unresolved: ['Bob'],
          ambiguous: [],
        },
        refsPreserved: { ok: true, removed: [] },
        hasMore: false,
        warnings: [],
        totals: { refsBefore: 0, refsAfter: 2, terms: 2 },
      });
      expect(calls).toHaveLength(1);
    });
  });

  it.each(['before', 'after'])('rejects a %s over the size cap before any LogSeq call', async param => {
    await withServer([], async (mcp, calls) => {
      const args = { before: 'x', after: 'x', [param]: 'x'.repeat(MAX_TEXT_CHARS + 1) };

      const result = await call(mcp, args);

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toContain(`Invalid parameter '${param}'`);
      expect(calls).toEqual([]);
    });
  });

  it('accepts a text exactly at the cap', async () => {
    await withServer([], async mcp => {
      const text = 'x'.repeat(MAX_TEXT_CHARS);
      const result = await call(mcp, { before: text, after: text });

      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0].text).ok).toBe(true);
    });
  });

  it.each(['before', 'after'])('requires %s, and takes an empty string as a text', async param => {
    await withServer([], async (mcp, calls) => {
      const missing = await call(mcp, param === 'before' ? { after: '' } : { before: '' });
      expect(missing.isError).toBe(true);
      expect(JSON.parse(missing.content[0].text).error).toContain(`Invalid parameter '${param}'`);

      const empty = await call(mcp, { before: '', after: '' });
      expect(JSON.parse(empty.content[0].text).ok).toBe(true);
      expect(calls).toEqual([]);
    });
  });

  it(`rejects more than ${MAX_LINK_TERMS} distinct terms before any LogSeq call`, async () => {
    await withServer([], async (mcp, calls) => {
      const after = Array.from({ length: MAX_LINK_TERMS + 1 }, (_, i) => `[[t${i}]]`).join(' ');

      const result = await call(mcp, { before: '', after });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toContain("Invalid parameter 'after'");
      expect(calls).toEqual([]);
    });
  });
});
