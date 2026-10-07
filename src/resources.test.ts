import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { TOOL_DESCRIPTIONS } from './tool-descriptions.js';
import { listPrompts } from './prompts.js';
import { GUIDE_URI, MAX_PAGE_CHARS, PAGE_URI_TEMPLATE, buildGuide, registerResources } from './resources.js';

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
        { id: 10, uuid: 'u-10', content: 'first line\nsecond line', children: [{ content: 'child', children: [{ content: 'grandchild' }] }] },
        { id: 11, uuid: 'u-11', content: 'sibling', children: ['uuid', '123'] },
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
        { id: 10, uuid: 'u-10', content: preBlock.join('\n'), 'pre-block?': true },
        { id: 11, uuid: 'u-11', content: 'a block', children: [{ content: 'a child' }] },
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
      const tree = [{ id: 10, uuid: 'u-10', content: 'type:: person', 'pre-block?': true }, { id: 11, uuid: 'u-11', content: 'a block' }];
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
      const big = Array.from({ length: 400 }, (_, i) => ({ id: i + 1, uuid: `u-${i}`, content: `${i} ${'x'.repeat(200)}` }));
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
      const huge = [{ id: 1, uuid: 'u-1', content: `START-OF-BLOCK ${'y'.repeat(MAX_PAGE_CHARS * 2)}` }];
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

  describe('listings and errors, pinned exactly (mutation-hardening, #206)', () => {
    it('resources/list returns the guide entry with its name, title and description', async () => {
      const { mcp } = await connect();
      try {
        expect((await mcp.listResources()).resources).toEqual([
          {
            uri: 'logseq://guide',
            name: 'guide',
            title: 'LogSeq reading guide',
            description: "How to read this server's results, which tool to start with, and an index of tools and prompts.",
            mimeType: 'text/markdown',
          },
        ]);
      } finally {
        await mcp.close();
      }
    });

    it('resources/templates/list returns the page template with its name, title and description', async () => {
      const { mcp } = await connect();
      try {
        expect((await mcp.listResourceTemplates()).resourceTemplates).toEqual([
          {
            uriTemplate: 'logseq://page/{name}',
            name: 'page',
            title: 'LogSeq page',
            description:
              'One page and its blocks as Markdown text. The name is case-insensitive and may be an alias or an ISO date (2025-01-01) for a journal.',
            mimeType: 'text/markdown',
          },
        ]);
      } finally {
        await mcp.close();
      }
    });

    it('names the resources it has when a URI is unknown, and says which URI it was', async () => {
      const { mcp } = await connect();
      try {
        for (const uri of ['logseq://nothing', 'logseq://page', 'logseq://pages/x', 'logseq://guide/extra']) {
          await expect(mcp.readResource({ uri }), uri).rejects.toMatchObject({
            code: RESOURCE_NOT_FOUND,
            message: expect.stringContaining(`Unknown resource ${JSON.stringify(uri)}. Available: logseq://guide, logseq://page/{name}.`),
          });
        }
      } finally {
        await mcp.close();
      }
    });

    it('says what to do for each bad page name', async () => {
      const { mcp } = await connect();
      try {
        await expect(mcp.readResource({ uri: 'logseq://page/' })).rejects.toMatchObject({
          code: ErrorCode.InvalidParams,
          message: expect.stringContaining(`No page name in logseq://page/. Use logseq://page/{name}.`),
        });
        await expect(mcp.readResource({ uri: 'logseq://page/%20%20' })).rejects.toMatchObject({
          code: ErrorCode.InvalidParams,
          message: expect.stringContaining(`No page name in logseq://page/%20%20. Use logseq://page/{name}.`),
        });
        await expect(mcp.readResource({ uri: 'logseq://page/%E0%A4%A' })).rejects.toMatchObject({
          code: ErrorCode.InvalidParams,
          message: expect.stringContaining(`Invalid page name encoding in logseq://page/%E0%A4%A. URL-encode the page name.`),
        });
        await expect(mcp.readResource({ uri: `logseq://page/${'a'.repeat(201)}` })).rejects.toMatchObject({
          code: ErrorCode.InvalidParams,
          message: expect.stringContaining(`Page name is 201 characters; the limit is 200.`),
        });
      } finally {
        await mcp.close();
      }
    });

    it('accepts a name of exactly 200 characters, counted after trimming', async () => {
      const { mcp, callAPI } = await connect();
      try {
        const name = 'a'.repeat(200);
        // the page does not exist: reaching the lookup and failing as "not found" proves the length passed
        await expect(mcp.readResource({ uri: `logseq://page/%20${name}%20` })).rejects.toMatchObject({ code: RESOURCE_NOT_FOUND });
        expect(callAPI).toHaveBeenCalledWith('logseq.Editor.getPage', [name]);
      } finally {
        await mcp.close();
      }
    });

    it('trims the decoded name before looking the page up', async () => {
      const { mcp, callAPI } = await connect(method => (method === 'logseq.Editor.getPage' ? { ...aliceEntity } : []));
      try {
        await mcp.readResource({ uri: 'logseq://page/%20Alice%20' });
        expect(callAPI).toHaveBeenCalledWith('logseq.Editor.getPage', ['Alice']);
        expect(callAPI).not.toHaveBeenCalledWith('logseq.Editor.getPage', [' Alice ']);
      } finally {
        await mcp.close();
      }
    });

    it('returns the URI as given, and uses the decoded name as the title when the page has none', async () => {
      const { mcp } = await connect(method => (method === 'logseq.Editor.getPage' ? { id: 1, name: 'project atlas', file: { id: 5 } } : []));
      try {
        const result = await mcp.readResource({ uri: 'logseq://page/project%20atlas' });
        expect(result.contents[0]).toMatchObject({ uri: 'logseq://page/project%20atlas', mimeType: 'text/markdown' });
        expect(textOf(result).startsWith('# project atlas\n')).toBe(true);
      } finally {
        await mcp.close();
      }
    });

    it('carries the URI in the data of each resource error', async () => {
      // The client side drops `data`, so call the registered handler as the server would.
      const logseq = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' });
      vi.spyOn(logseq, 'callAPI').mockResolvedValue(null as any);
      const stub = { id: 3, name: 'bob', 'original-name': 'Bob' };
      const sources = [
        [{ id: 1, name: 'robert smith', 'original-name': 'Robert Smith', file: { id: 9 } }, 'alias'],
        [{ id: 2, name: 'robert jones', 'original-name': 'Robert Jones', file: { id: 10 } }, 'alias'],
      ];
      const executeDatalogQuery = vi.spyOn(logseq, 'executeDatalogQuery').mockResolvedValue([] as any);
      const handlers = new Map<unknown, any>();
      registerResources({ setRequestHandler: (schema: unknown, handler: unknown) => handlers.set(schema, handler) } as any, logseq);
      const read = handlers.get(ReadResourceRequestSchema);
      const dataOf = async (uri: string) => {
        const error: any = await read({ params: { uri } }).catch((e: unknown) => e);
        return { code: error.code, data: error.data };
      };

      expect(await dataOf('logseq://nothing')).toEqual({ code: RESOURCE_NOT_FOUND, data: { uri: 'logseq://nothing' } });
      expect(await dataOf('logseq://page/No%20Such%20Page')).toEqual({
        code: RESOURCE_NOT_FOUND,
        data: { uri: 'logseq://page/No%20Such%20Page' },
      });
      executeDatalogQuery.mockResolvedValue([[stub, 'name'], ...sources] as any);
      expect(await dataOf('logseq://page/Bob')).toEqual({ code: ErrorCode.InvalidParams, data: { uri: 'logseq://page/Bob' } });
    });

    it('reports a LogSeq outage as an internal error, not as invalid params or not found', async () => {
      const { mcp } = await connect(() => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:12315');
      });
      try {
        const error: any = await mcp.readResource({ uri: 'logseq://page/Alice' }).catch(e => e);
        expect(error.code).toBe(ErrorCode.InternalError);
        expect(error.code).not.toBe(ErrorCode.InvalidParams);
        expect(error.code).not.toBe(RESOURCE_NOT_FOUND);
      } finally {
        await mcp.close();
      }
    });
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

describe('buildGuide layout (mutation-hardening, #206)', () => {
  // Built inside each test, from the real imports, so nothing here runs at collection time.
  const indexLines = (entries: [string, string][]) => entries.map(([name, text]) => `- ${name}: ${text}`);

  it('is the instructions, then a tool index of first lines, a prompt index and the resource list', () => {
    const tools = Object.entries(TOOL_DESCRIPTIONS).map(([name, description]) => [name, description.split('\n')[0].trim()] as [string, string]);
    const prompts = listPrompts().map(p => [p.name, p.description ?? ''] as [string, string]);
    expect(buildGuide()).toBe(
      [
        '# LogSeq MCP guide',
        '',
        SERVER_INSTRUCTIONS,
        '',
        '## Tools',
        '',
        ...indexLines(tools),
        '',
        '## Prompts',
        '',
        ...indexLines(prompts),
        '',
        '## Resources',
        '',
        '- logseq://guide: this guide',
        '- logseq://page/{name}: one page as text (URL-encode the name; aliases and ISO dates work)',
        '',
      ].join('\n')
    );
  });

  it('keeps only the trimmed first line of a tool description in the index', () => {
    const descriptions = TOOL_DESCRIPTIONS as Record<string, string>;
    descriptions.logseq_padded_example = '  First line of the example.  \n\n**Use when:** later detail';
    try {
      const lines = buildGuide().split('\n');
      expect(lines).toContain('- logseq_padded_example: First line of the example.');
      expect(buildGuide()).not.toContain('later detail');
    } finally {
      delete descriptions.logseq_padded_example;
    }
  });
});
