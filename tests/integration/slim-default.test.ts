import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/index.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Slim output is the default through the real MCP server (#42): the same call
 * with and without `slim_results: false` returns the same blocks, the slim form
 * is smaller, and every content block is minified JSON. Against the fixture graph:
 * "importer" is in 11 blocks, and January 2025 holds seven journals.
 */
describe('slim_results default (#42)', () => {
  let mcp: Client;

  beforeAll(async () => {
    const { client } = await connectFixture();
    const server = createServer(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcp = new Client({ name: 'slim-default-test', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  });

  afterAll(async () => {
    await mcp?.close();
  });

  async function call(name: string, args: Record<string, unknown>) {
    const result = (await mcp.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    for (const block of result.content) {
      expect(JSON.stringify(JSON.parse(block.text)), 'content block is minified JSON').toBe(block.text);
    }
    return { data: JSON.parse(result.content[0].text), bytes: result.content.reduce((n, b) => n + b.text.length, 0) };
  }

  it('search_blocks: default is slim, slim_results: false is full, same blocks, slim is smaller', async () => {
    const args = { query: 'importer', limit: 20 };
    const slim = await call('logseq_search_blocks', args);
    const full = await call('logseq_search_blocks', { ...args, slim_results: false });

    expect(slim.data).toHaveLength(11);
    expect(slim.data.every((b: any) => typeof b.pageName === 'string' && b.pageName !== '')).toBe(true);
    expect(slim.data.map((b: any) => b.uuid)).toEqual(full.data.map((b: any) => b.uuid));
    for (const block of slim.data) {
      expect(block).not.toHaveProperty('id');
      expect(block).not.toHaveProperty('page');
      expect(block.pageName === undefined || block.pageName !== '').toBe(true);
    }
    for (const block of full.data) {
      expect(block).toHaveProperty('id');
      expect(block).not.toHaveProperty('pageName');
    }
    expect(slim.bytes).toBeLessThan(full.bytes);
  });

  it('query_by_date_range: default is slim, entries name the page and blocks do not repeat it', async () => {
    const range = { start_date: 20250101, end_date: 20250131 };
    const slim = await call('logseq_query_by_date_range', range);
    const full = await call('logseq_query_by_date_range', { ...range, slim_results: false });

    expect(slim.data.entries.map((e: any) => e.pageName)).toEqual([
      'Jan 2nd, 2025', 'Jan 6th, 2025', 'Jan 7th, 2025', 'Jan 8th, 2025', 'Jan 10th, 2025', 'Jan 13th, 2025',
      'Jan 15th, 2025',
    ]);
    expect(slim.data.entries.map((e: any) => e.date)).toEqual(full.data.entries.map((e: any) => e.date));
    const walk = (blocks: any[]) => {
      for (const block of blocks) {
        expect(block).not.toHaveProperty('pageName');
        expect(block).not.toHaveProperty('id');
        walk(block.children ?? []);
      }
    };
    for (const entry of slim.data.entries) {
      expect(entry).not.toHaveProperty('page');
      expect(typeof entry.pageName).toBe('string');
      walk(entry.blocks);
    }
    for (const entry of full.data.entries) expect(entry).toHaveProperty('page');
    expect(slim.bytes).toBeLessThan(full.bytes);
  });
});
