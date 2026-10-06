import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LogseqClient } from './client.js';
import { createServer } from './index.js';
import { LogSeqAuthError, LogSeqResponseError, PageNotFoundError } from './errors.js';
import { responses } from './response-schemas.js';
import { callParsed } from './utils/parse-response.js';
import { getPage } from './tools/get-page.js';
import { getBlock } from './tools/get-block.js';
import { listPages } from './tools/list-pages.js';
import { searchBlocks } from './tools/search-blocks.js';
import { requirePage, suggestPages } from './utils/resolve-page.js';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

/** What a real LogseqClient receives when LogSeq answers `body` to every call. */
function clientAnswering(...bodies: unknown[]) {
  const answers = [...bodies];
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => (answers.length > 1 ? answers.shift() : answers[0]) }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return { client: new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' }), fetchMock };
}

const page = { id: 1, name: 'alice', originalName: 'Alice', file: { id: 9 } };
const block = { id: 5, uuid: '00000000-0000-4000-8000-000000000005', content: 'a block' };

describe('through a real client: an answer that does not parse is an error, never an empty result (BR-0003)', () => {
  it('get_page fails on a page whose id is a string, instead of returning it', async () => {
    const { client } = clientAnswering({ ...page, id: '1' });

    await expect(getPage(client, 'alice', false)).rejects.toBeInstanceOf(LogSeqResponseError);
  });

  it('get_page fails on a block tree that holds a block with no content', async () => {
    const { client } = clientAnswering(page, [{ id: 5, uuid: block.uuid }]);

    const error = await getPage(client, 'alice', true).catch(e => e);

    expect(error).toBeInstanceOf(LogSeqResponseError);
    expect(error.method).toBe('logseq.Editor.getPageBlocksTree');
    expect(error.path).toBe('[0].content');
  });

  it('get_block fails on an answer that is not a block, and still says "not found" for null', async () => {
    await expect(getBlock(clientAnswering(['not', 'a', 'block']).client, block.uuid, false)).rejects.toBeInstanceOf(LogSeqResponseError);
    await expect(getBlock(clientAnswering(null).client, block.uuid, false)).rejects.toThrow(/not found/i);
  });

  it('list_pages fails on a page list with a broken page, but null is still "unavailable" and [] is still empty', async () => {
    await expect(listPages(clientAnswering([{ ...page, name: 7 }]).client)).rejects.toBeInstanceOf(LogSeqResponseError);

    const unavailable = await listPages(clientAnswering(null).client);
    expect(unavailable.pages).toEqual([]);
    expect(unavailable.warnings?.map(w => w.code)).toEqual(['pages_unavailable']);

    const empty = await listPages(clientAnswering([]).client);
    expect(empty.pages).toEqual([]);
    expect(JSON.stringify(empty)).not.toContain('pages_unavailable');
  });

  it('search_blocks fails on a result row that is not a block, and null is still null', async () => {
    await expect(searchBlocks(clientAnswering([[{ id: 1, content: 'x', uuid: 5 }]]).client, 'x')).rejects.toBeInstanceOf(LogSeqResponseError);
    expect(await searchBlocks(clientAnswering(null).client, 'x')).toBeNull();
    expect(await searchBlocks(clientAnswering([]).client, 'x')).toEqual([]);
  });

  it('the page resolver fails on a row that is not a page, instead of reporting "no such page"', async () => {
    const { client } = clientAnswering([['not a page', 'name']]);

    await expect(requirePage(client, 'alice')).rejects.toBeInstanceOf(LogSeqResponseError);
  });

  it('the suggestions for a missing page do not swallow a page list that does not parse', async () => {
    // The best-effort lookup still returns [] for an ordinary failure; an unreadable answer is not one
    const unreadable = clientAnswering({ not: 'a list' }).client;
    await expect(suggestPages(unreadable, 'missing')).rejects.toBeInstanceOf(LogSeqResponseError);

    const noPages = clientAnswering([]).client; // the resolver finds nothing, and so does the page list
    await expect(requirePage(noPages, 'missing')).rejects.toBeInstanceOf(PageNotFoundError);
  });

  it('an MCP tool reports it as an error result with the method and the path, not as an empty list', async () => {
    const { client } = clientAnswering([{ ...page, id: 'x' }]);
    const server = createServer(client, { tips: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    try {
      const result = (await mcp.callTool({ name: 'logseq_list_pages', arguments: {} })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('logseq.Editor.getAllPages');
      expect(result.content[0].text).toContain('[0].id');
    } finally {
      await mcp.close();
    }
  });

  it('a rejected token is still the auth error, not a response error', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401, statusText: 'Unauthorized' })) as unknown as typeof fetch;
    const client = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'bad' });

    await expect(callParsed(client, responses.editorPage, 'logseq.Editor.getPage', ['a'])).rejects.toBeInstanceOf(LogSeqAuthError);
  });
});
