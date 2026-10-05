import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../../src/config.js';
import { LogseqClient } from '../../src/client.js';
import { createServer } from '../../src/index.js';

/**
 * Slim output is the default through the real MCP server (#42): the same call
 * with and without `slim_results: false` returns the same blocks, the slim form
 * is smaller, and every content block is minified JSON.
 *
 * Needs LogSeq running; see tests/integration/setup.md.
 */
describe('slim_results default (#42)', () => {
  let mcp: Client;

  beforeAll(async () => {
    const config = await loadConfig(resolve(homedir(), '.logseq-mcp', 'config.json'));
    const server = createServer(new LogseqClient(config));
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
    const args = { query: 'a', limit: 20 };
    const slim = await call('logseq_search_blocks', args);
    const full = await call('logseq_search_blocks', { ...args, slim_results: false });

    expect(slim.data.length, 'the search should match blocks in any graph; see setup.md').toBeGreaterThan(0);
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
    const slim = await call('logseq_query_by_date_range', { last_n: 7 });
    const full = await call('logseq_query_by_date_range', { last_n: 7, slim_results: false });

    expect(slim.data.entries.length, 'the graph needs journal pages; see setup.md').toBeGreaterThan(0);
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
