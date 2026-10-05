import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { TOOL_DESCRIPTIONS } from './tool-descriptions.js';
import { listPrompts } from './prompts.js';
import { GUIDE_URI, MAX_PAGE_CHARS, PAGE_URI_TEMPLATE, buildGuide } from './resources.js';

const RESOURCE_NOT_FOUND = -32002;

describe('MCP resources (#46)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Connect a client to a server whose LogSeq API is replaced by `api`. */
  async function connect(
    api: (method: string, args: unknown[]) => unknown = () => null,
    datalog: (query: string) => unknown = () => []
  ) {
    const logseq = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' });
    const callAPI = vi.spyOn(logseq, 'callAPI').mockImplementation(async (method: string, a: any[] = []) => api(method, a) as any);
    vi.spyOn(logseq, 'executeDatalogQuery').mockImplementation(async (query: string) => datalog(query) as any);
    const server = createServer(logseq);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    return { mcp, callAPI };
  }

  const aliceEntity = { id: 1, name: 'alice', originalName: 'Alice', file: { id: 5 } };
  const textOf = (result: any) => result.contents[0].text as string;

  it('advertises the resources capability', async () => {
    const { mcp } = await connect();
    try {
      expect(mcp.getServerCapabilities()?.resources).toBeDefined();
    } finally {
      await mcp.close();
    }
  });

  describe('logseq://guide', () => {
    it('resources/list lists the guide, as Markdown', async () => {
      const { mcp } = await connect();
      try {
        const { resources } = await mcp.listResources();
        expect(resources).toEqual([expect.objectContaining({ uri: GUIDE_URI, mimeType: 'text/markdown' })]);
        expect(resources[0].description).toBeTruthy();
      } finally {
        await mcp.close();
      }
    });

    it('resources/read returns the server instructions plus a tool and prompt index', async () => {
      const { mcp } = await connect();
      try {
        const result = await mcp.readResource({ uri: GUIDE_URI });
        expect(result.contents).toHaveLength(1);
        expect(result.contents[0]).toMatchObject({ uri: GUIDE_URI, mimeType: 'text/markdown' });
        const text = textOf(result);
        expect(text).toContain(SERVER_INSTRUCTIONS);
        for (const tool of Object.keys(TOOL_DESCRIPTIONS)) expect(text, tool).toContain(`- ${tool}:`);
        for (const prompt of listPrompts()) expect(text, prompt.name).toContain(`- ${prompt.name}:`);
      } finally {
        await mcp.close();
      }
    });

    it('indexes exactly the registered tools', async () => {
      const { mcp } = await connect();
      try {
        const registered = (await mcp.listTools()).tools.map(t => t.name).sort();
        expect(Object.keys(TOOL_DESCRIPTIONS).sort()).toEqual(registered);
      } finally {
        await mcp.close();
      }
    });

    it('does not call LogSeq', async () => {
      const { mcp, callAPI } = await connect();
      try {
        await mcp.readResource({ uri: GUIDE_URI });
        expect(callAPI).not.toHaveBeenCalled();
      } finally {
        await mcp.close();
      }
    });

    it('stays small enough to attach to a conversation', () => {
      expect(buildGuide().length).toBeLessThan(8000);
    });
  });

  describe('logseq://page/{name}', () => {
    it('resources/templates/list advertises the page template', async () => {
      const { mcp } = await connect();
      try {
        const { resourceTemplates } = await mcp.listResourceTemplates();
        expect(resourceTemplates).toEqual([
          expect.objectContaining({ uriTemplate: PAGE_URI_TEMPLATE, mimeType: 'text/markdown' }),
        ]);
      } finally {
        await mcp.close();
      }
    });

    it('reads a page as an outline, with nested blocks indented by tabs', async () => {
      const tree = [
        { content: 'first line\nsecond line', children: [{ content: 'child', children: [{ content: 'grandchild' }] }] },
        { content: 'sibling', children: ['uuid', '123'] },
      ];
      const { mcp } = await connect(method => {
        if (method === 'logseq.Editor.getPage') return { ...aliceEntity };
        if (method === 'logseq.Editor.getPageBlocksTree') return tree;
        return null;
      });
      try {
        const result = await mcp.readResource({ uri: 'logseq://page/Alice' });
        expect(result.contents[0]).toMatchObject({ uri: 'logseq://page/Alice', mimeType: 'text/markdown' });
        expect(textOf(result)).toBe(
          ['# Alice', '', '- first line', '  second line', '\t- child', '\t\t- grandchild', '- sibling', ''].join('\n')
        );
      } finally {
        await mcp.close();
      }
    });

    it('loses nothing the resource printed before the shared renderer: a pre-block with refs, hyphenated keys, numbers (#80)', async () => {
      // Synthetic, in the shapes LogSeq documents: the Editor API camelCases the map's keys
      // and returns multi-value refs as arrays, while the pre-block text is as stored.
      const preBlock = ['project-status:: active', 'related-to:: [[Bob]], [[Carol]]', 'rating:: 3', 'archived:: false'];
      const tree = [
        { content: preBlock.join('\n'), 'pre-block?': true },
        { content: 'a block', children: [{ content: 'a child' }] },
      ];
      const properties = { projectStatus: 'active', relatedTo: ['Bob', 'Carol'], rating: 3, archived: false };
      // What main printed (#46): every block, the pre-block included, as a bullet
      const before = ['# Alice', '', ...preBlock.map((line, i) => (i === 0 ? `- ${line}` : `  ${line}`)), '- a block', '\t- a child', ''].join('\n');

      const { mcp } = await connect(method => {
        if (method === 'logseq.Editor.getPage') return { ...aliceEntity, properties };
        if (method === 'logseq.Editor.getPageBlocksTree') return tree;
        return null;
      });
      try {
        const after = textOf(await mcp.readResource({ uri: 'logseq://page/Alice' }));
        // Same text; the properties are now lines above the outline instead of a first bullet
        expect(after).toBe(['# Alice', '', ...preBlock, '', '- a block', '\t- a child', ''].join('\n'));
        // Every property line main showed is still there, verbatim
        for (const line of before.split('\n').map(l => l.replace(/^(- |  )/, ''))) {
          expect(after).toContain(line);
        }
      } finally {
        await mcp.close();
      }
    });

    it('renders page properties before the blocks, through the shared renderer (#43)', async () => {
      const tree = [{ content: 'type:: person', 'pre-block?': true }, { content: 'a block' }];
      const { mcp } = await connect(method => {
        if (method === 'logseq.Editor.getPage') return { ...aliceEntity, properties: { type: 'person' } };
        if (method === 'logseq.Editor.getPageBlocksTree') return tree;
        return null;
      });
      try {
        expect(textOf(await mcp.readResource({ uri: 'logseq://page/Alice' }))).toBe(
          '# Alice\n\ntype:: person\n\n- a block\n'
        );
      } finally {
        await mcp.close();
      }
    });

    it('decodes a URL-encoded name and passes it to the page lookup', async () => {
      const { mcp, callAPI } = await connect(method => (method === 'logseq.Editor.getPage' ? { ...aliceEntity } : []));
      try {
        await mcp.readResource({ uri: 'logseq://page/project%20atlas%2Fphase%201' });
        expect(callAPI).toHaveBeenCalledWith('logseq.Editor.getPage', ['project atlas/phase 1']);
      } finally {
        await mcp.close();
      }
    });

    it('says so when a page has no blocks', async () => {
      const { mcp } = await connect(method => (method === 'logseq.Editor.getPage' ? { ...aliceEntity } : []));
      try {
        expect(textOf(await mcp.readResource({ uri: 'logseq://page/Alice' }))).toContain('(this page has no blocks)');
      } finally {
        await mcp.close();
      }
    });

    it('cuts a very large page at the cap and says so', async () => {
      const big = Array.from({ length: 400 }, (_, i) => ({ content: `${i} ${'x'.repeat(200)}` }));
      const { mcp } = await connect(method => {
        if (method === 'logseq.Editor.getPage') return { ...aliceEntity };
        if (method === 'logseq.Editor.getPageBlocksTree') return big;
        return null;
      });
      try {
        const text = textOf(await mcp.readResource({ uri: 'logseq://page/Alice' }));
        expect(text.length).toBeLessThan(MAX_PAGE_CHARS + 1000);
        expect(text).toContain(`Cut at ${MAX_PAGE_CHARS} characters`);
        expect(text).toContain('logseq_get_page');
        expect(text).toContain('- 0 xxx');
      } finally {
        await mcp.close();
      }
    });

    it('shows the start of a single block that exceeds the cap, with a notice', async () => {
      const huge = [{ content: `START-OF-BLOCK ${'y'.repeat(MAX_PAGE_CHARS * 2)}` }];
      const { mcp } = await connect(method => {
        if (method === 'logseq.Editor.getPage') return { ...aliceEntity };
        if (method === 'logseq.Editor.getPageBlocksTree') return huge;
        return null;
      });
      try {
        const text = textOf(await mcp.readResource({ uri: 'logseq://page/Alice' }));
        expect(text).not.toContain('(this page has no blocks)');
        expect(text).toContain('- START-OF-BLOCK yyy');
        expect(text).toContain('This block is longer than the limit and was truncated');
        expect(text).toContain(`Cut at ${MAX_PAGE_CHARS} characters`);
        expect(text.length).toBeLessThan(MAX_PAGE_CHARS + 1000);
      } finally {
        await mcp.close();
      }
    });

    it('reports a missing page as resource not found, with guidance', async () => {
      const { mcp } = await connect();
      try {
        await expect(mcp.readResource({ uri: 'logseq://page/No%20Such%20Page' })).rejects.toMatchObject({
          code: RESOURCE_NOT_FOUND,
          message: expect.stringContaining('logseq_list_pages'),
        });
      } finally {
        await mcp.close();
      }
    });

    it('reports an ambiguous name as invalid params, naming the candidates', async () => {
      const stub = { id: 3, name: 'bob', 'original-name': 'Bob' };
      const sources = [
        [{ id: 1, name: 'robert smith', 'original-name': 'Robert Smith', file: { id: 9 } }, 'alias'],
        [{ id: 2, name: 'robert jones', 'original-name': 'Robert Jones', file: { id: 10 } }, 'alias'],
      ];
      const { mcp } = await connect(() => null, () => [[stub, 'name'], ...sources]);
      try {
        await expect(mcp.readResource({ uri: 'logseq://page/Bob' })).rejects.toMatchObject({
          code: ErrorCode.InvalidParams,
          message: expect.stringContaining('Robert Jones'),
        });
      } finally {
        await mcp.close();
      }
    });

    it('rejects an empty name, bad encoding and an over-long name as invalid params', async () => {
      const { mcp } = await connect();
      try {
        for (const uri of ['logseq://page/', 'logseq://page/%E0%A4%A', `logseq://page/${'a'.repeat(201)}`]) {
          await expect(mcp.readResource({ uri }), uri).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
        }
      } finally {
        await mcp.close();
      }
    });

    it('does not turn a LogSeq outage into "not found"', async () => {
      const { mcp } = await connect(() => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:12315');
      });
      try {
        await expect(mcp.readResource({ uri: 'logseq://page/Alice' })).rejects.toMatchObject({
          message: expect.stringContaining('ECONNREFUSED'),
        });
      } finally {
        await mcp.close();
      }
    });
  });

  it('reports an unknown resource as not found', async () => {
    const { mcp } = await connect();
    try {
      await expect(mcp.readResource({ uri: 'logseq://nothing' })).rejects.toMatchObject({ code: RESOURCE_NOT_FOUND });
    } finally {
      await mcp.close();
    }
  });

  it('only reads: no write method is ever called on LogSeq', async () => {
    const { mcp, callAPI } = await connect(method => (method === 'logseq.Editor.getPage' ? { ...aliceEntity } : []));
    try {
      await mcp.readResource({ uri: GUIDE_URI });
      await mcp.readResource({ uri: 'logseq://page/Alice' });
      for (const [method] of callAPI.mock.calls) {
        expect(method, String(method)).toMatch(/^logseq\.(Editor\.get|DB\.)/);
      }
    } finally {
      await mcp.close();
    }
  });
});
