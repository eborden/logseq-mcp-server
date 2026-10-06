import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';
import { DEFAULT_SLIM_RESULTS } from './utils/slim-entities.js';

/**
 * Slim output is the default (#42): `slim_results` omitted means slim, and
 * `slim_results: false` is the opt-out that returns the full entities.
 * These run the real tools behind the MCP server, with only the Datalog client stubbed.
 */

function pulledBlock(id: number, content: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    uuid: `block-uuid-${id}`,
    content,
    format: 'markdown',
    page: { id: 10, name: 'my page', 'original-name': 'My Page' },
    parent: { id: 10 },
    left: { id: 10 },
    ...extra,
  };
}

const journal = {
  id: 20,
  uuid: 'page-uuid-20',
  name: 'jan 1st, 2025',
  'original-name': 'Jan 1st, 2025',
  'journal-day': 20250101,
  'journal?': true,
};

function journalBlock(id: number, content: string) {
  return {
    id,
    uuid: `block-uuid-${id}`,
    content,
    format: 'markdown',
    page: { id: 20 },
    parent: { id: 20 },
    left: { id: 20 },
  };
}

/** Datalog stub: answers each query by its shape, so tests don't depend on call order. */
function stubClient() {
  const client = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' });
  vi.spyOn(client, 'executeDatalogQuery').mockImplementation((async (query: string) => {
    if (query.includes(':block/properties')) {
      return [[pulledBlock(1, 'Task for [[Alice]] #todo', { properties: { status: 'active' } })]];
    }
    if (query.includes(':block/journal-day') && query.includes(':block/name') && !query.includes(':block/page ?page')) {
      return [[journal]];
    }
    if (query.includes(':block/journal-day')) {
      return [[journalBlock(30, 'Met [[Alice]] today')]];
    }
    return [[pulledBlock(1, 'Alice met Bob', { properties: { status: 'active' } })]];
  }) as any);
  return client;
}

async function callRaw(name: string, args: Record<string, unknown>) {
  const server = createServer(stubClient());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  try {
    return (await mcpClient.callTool({ name, arguments: args })) as any;
  } finally {
    await mcpClient.close();
  }
}

async function call(name: string, args: Record<string, unknown>) {
  return JSON.parse((await callRaw(name, args)).content[0].text);
}

const SLIM_ONLY_KEYS = ['pageName'];
const FULL_ONLY_KEYS = ['id', 'page', 'parent', 'left', 'format'];

describe('slim_results default (#42)', () => {
  describe('logseq_search_blocks', () => {
    it('returns slim blocks when slim_results is omitted', async () => {
      const [block] = await call('logseq_search_blocks', { query: 'alice' });
      expect(block).toMatchObject({ uuid: 'block-uuid-1', content: 'Alice met Bob', pageName: 'My Page' });
      for (const key of FULL_ONLY_KEYS) expect(block, key).not.toHaveProperty(key);
    });

    it('returns full blocks with slim_results: false', async () => {
      const [block] = await call('logseq_search_blocks', { query: 'alice', slim_results: false });
      expect(block).toMatchObject({ id: 1, uuid: 'block-uuid-1', format: 'markdown', page: { id: 10 }, parent: { id: 10 } });
      for (const key of SLIM_ONLY_KEYS) expect(block, key).not.toHaveProperty(key);
    });

    it('matches slim_results: true when it is omitted', async () => {
      expect(await call('logseq_search_blocks', { query: 'alice' })).toEqual(
        await call('logseq_search_blocks', { query: 'alice', slim_results: true })
      );
    });
  });

  describe('logseq_query_by_property', () => {
    it('returns slim blocks when slim_results is omitted', async () => {
      const [block] = await call('logseq_query_by_property', { property_key: 'status', property_value: 'active' });
      expect(block).toMatchObject({ uuid: 'block-uuid-1', pageName: 'My Page', properties: { status: 'active' } });
      for (const key of FULL_ONLY_KEYS) expect(block, key).not.toHaveProperty(key);
    });

    it('returns full blocks with slim_results: false', async () => {
      const [block] = await call('logseq_query_by_property', {
        property_key: 'status',
        property_value: 'active',
        slim_results: false,
      });
      expect(block).toMatchObject({ id: 1, page: { id: 10, originalName: 'My Page' } });
      expect(block).not.toHaveProperty('pageName');
    });
  });

  describe('logseq_query_by_date_range', () => {
    it('returns slim entries when slim_results is omitted', async () => {
      const result = await call('logseq_query_by_date_range', { last_n: 1 });
      const [entry] = result.entries;
      expect(entry).toMatchObject({ date: 20250101, pageName: 'Jan 1st, 2025' });
      expect(entry).not.toHaveProperty('page');
      expect(entry.blocks[0]).toMatchObject({ uuid: 'block-uuid-30', content: 'Met [[Alice]] today' });
      expect(entry.blocks[0]).not.toHaveProperty('id');
      // The entry names the page, so its blocks don't (#42)
      expect(entry.blocks[0]).not.toHaveProperty('pageName');
    });

    it('returns full entries with slim_results: false', async () => {
      const result = await call('logseq_query_by_date_range', { last_n: 1, slim_results: false });
      const [entry] = result.entries;
      expect(entry.page).toMatchObject({ id: 20, uuid: 'page-uuid-20' });
      expect(entry).not.toHaveProperty('pageName');
      expect(entry.blocks[0]).toMatchObject({ id: 30, format: 'markdown' });
    });
  });

  describe('empty-field policy', () => {
    it('keeps hasMore: false and warnings: [] in meta, because they say nothing was cut', async () => {
      const result = await callRaw('logseq_search_blocks', { query: 'alice' });
      const { meta } = JSON.parse(result.content[1].text);
      expect(meta.hasMore).toBe(false);
      expect(meta.warnings).toEqual([]);
      expect(meta.totals).toEqual({ matches: 1 });
    });

    it('keeps an empty day in the date-range result: blocks: [] is a day with no entries', async () => {
      const client = stubClient();
      vi.spyOn(client, 'executeDatalogQuery')
        .mockResolvedValueOnce([[journal]])
        .mockResolvedValueOnce([]);
      const server = createServer(client);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
      await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
      try {
        const result = (await mcpClient.callTool({ name: 'logseq_query_by_date_range', arguments: { last_n: 1 } })) as any;
        const [entry] = JSON.parse(result.content[0].text).entries;
        expect(entry).toMatchObject({ date: 20250101, blocks: [] });
      } finally {
        await mcpClient.close();
      }
    });
  });

  describe('handlers default to slim', () => {
    // Every tool with a slim_results parameter must be listed here with a call that returns
    // data. Adding a slim_results parameter to a new tool fails the coverage test until the
    // tool is added, and the other test fails if its handler skips the slim default (the
    // tool functions themselves default to full output).
    const SLIM_CAPABLE_CALLS: Record<string, Record<string, unknown>> = {
      logseq_search_blocks: { query: 'alice' },
      logseq_query_by_property: { property_key: 'status', property_value: 'active' },
      logseq_query_by_date_range: { last_n: 1 },
    };

    it('lists every tool that advertises slim_results', async () => {
      const server = createServer(stubClient());
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
      await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
      try {
        const names = (await mcpClient.listTools()).tools
          .filter(t => 'slim_results' in ((t.inputSchema.properties as object) ?? {}))
          .map(t => t.name)
          .sort();
        expect(names).toEqual(Object.keys(SLIM_CAPABLE_CALLS).sort());
      } finally {
        await mcpClient.close();
      }
    });

    it.each(Object.entries(SLIM_CAPABLE_CALLS))(
      '%s: omitting slim_results matches true and differs from false',
      async (name, args) => {
        const omitted = await call(name, args);
        expect(omitted).toEqual(await call(name, { ...args, slim_results: true }));
        expect(omitted).not.toEqual(await call(name, { ...args, slim_results: false }));
      }
    );
  });

  describe('schema', () => {
    it('advertises default: true on every slim_results parameter, and there are three', async () => {
      expect(DEFAULT_SLIM_RESULTS).toBe(true);
      const server = createServer(stubClient());
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
      await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
      try {
        const tools = (await mcpClient.listTools()).tools;
        const withSlim = tools.filter(t => 'slim_results' in ((t.inputSchema.properties as object) ?? {}));
        expect(withSlim.map(t => t.name).sort()).toEqual([
          'logseq_query_by_date_range',
          'logseq_query_by_property',
          'logseq_search_blocks',
        ]);
        for (const tool of withSlim) {
          const prop = (tool.inputSchema.properties as any).slim_results;
          expect(prop.default, tool.name).toBe(DEFAULT_SLIM_RESULTS);
          expect(prop.description, tool.name).toMatch(/default/i);
        }
      } finally {
        await mcpClient.close();
      }
    });
  });
});
