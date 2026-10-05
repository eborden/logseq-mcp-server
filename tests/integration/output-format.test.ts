import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';
import { access } from 'fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../../src/config.js';
import { LogseqClient } from '../../src/client.js';
import { createServer } from '../../src/index.js';

/**
 * The page outline tool and `format: "markdown"` / `compact` (#43) against a live
 * graph, through the real MCP server.
 *
 * Read-only. The pages are discovered in whatever graph is running, and every
 * assertion is on structure: counts, booleans, shapes. Nothing is asserted on or
 * printed from page names or block text, so a failure cannot echo graph data.
 *
 * Needs LogSeq running; see tests/integration/setup.md. The graph needs a page
 * with a file and at least 3 blocks, a page that declares an alias nobody else
 * declares, and a journal page with content (the same data page-resolution.test.ts uses).
 */

const SETUP_HINT = 'See tests/integration/setup.md';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

describe('page outline and markdown output against a live graph (#43)', () => {
  let mcp: Client;
  let logseq: LogseqClient;
  let apiCalls = 0;
  /** The page with the most blocks, among pages with a file */
  let big: string;
  /** The most-referenced page with a file */
  let hub: string;
  let aliasStub: string;
  let isoDay: string;

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = (await mcp.callTool({ name, arguments: args })) as ToolResult;
    // A failure message may quote a page name, so only the tool name is reported
    expect(result.isError, `${name} returned an error`).toBeFalsy();
    return result;
  }
  const json = async (name: string, args: Record<string, unknown>) => JSON.parse((await call(name, args)).content[0].text);
  const bytes = (result: ToolResult) => result.content.reduce((n, b) => n + Buffer.byteLength(b.text, 'utf8'), 0);

  beforeAll(async () => {
    const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');
    try {
      await access(configPath);
    } catch {
      throw new Error(`Config file not found at ~/.logseq-mcp/config.json. ${SETUP_HINT}`);
    }
    logseq = new LogseqClient(await loadConfig(configPath));
    const original = logseq.callAPI.bind(logseq);
    logseq.callAPI = (async (method: string, args?: any[]) => {
      apiCalls++;
      return original(method, args);
    }) as typeof logseq.callAPI;

    const server = createServer(logseq);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcp = new Client({ name: 'output-format-test', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

    const raw = (q: string) => original<any[]>('logseq.DB.datascriptQuery', [q]);

    const sizes = await raw(`[:find ?n (count ?b) :where [?b :block/page ?p] [?p :block/name ?n] [?p :block/file]]`);
    const biggest = [...sizes].sort((a, b) => b[1] - a[1])[0];
    expect(biggest && biggest[1] >= 3, `No page with a file and at least 3 blocks. ${SETUP_HINT}`).toBe(true);
    big = biggest[0];

    const refRows = await raw(`[:find ?n ?b :where [?b :block/refs ?p] [?p :block/name ?n] [?p :block/file]]`);
    const refCounts = new Map<string, number>();
    for (const [n] of refRows) refCounts.set(n, (refCounts.get(n) ?? 0) + 1);
    const topRef = [...refCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    expect(topRef !== undefined, `No page with a file is referenced. ${SETUP_HINT}`).toBe(true);
    hub = topRef[0];

    const aliasRows = await raw(`[:find ?n ?sn :where [?a :block/name ?n] (not [?a :block/file]) [?p :block/alias ?a] [?p :block/name ?sn]]`);
    const sourcesByStub = new Map<string, number>();
    for (const [stub] of aliasRows) sourcesByStub.set(stub, (sourcesByStub.get(stub) ?? 0) + 1);
    const unique = [...sourcesByStub.entries()].find(([, count]) => count === 1);
    expect(unique !== undefined, `No page with an alias that only it declares. ${SETUP_HINT}`).toBe(true);
    aliasStub = unique![0];

    const days = await raw(`[:find ?d :where [?p :block/name] [?p :block/journal-day ?d] [?b :block/page ?p]]`);
    expect(days.length, `No journal page with content. ${SETUP_HINT}`).toBeGreaterThan(0);
    const day = String(days[days.length >> 1][0]);
    isoDay = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
  });

  afterAll(async () => {
    await mcp?.close();
  });

  describe('logseq_get_page_outline', () => {
    it('lists the top-level blocks of a page with a snippet and a child count each', async () => {
      const outline = await json('logseq_get_page_outline', { page_name: big });

      expect(outline.blocks.length).toBeGreaterThan(0);
      expect(outline.blocks.every((b: any) => UUID.test(b.uuid))).toBe(true);
      expect(outline.blocks.every((b: any) => typeof b.snippet === 'string' && b.snippet.length <= 80)).toBe(true);
      expect(outline.blocks.every((b: any) => Number.isInteger(b.childCount) && b.childCount >= 0)).toBe(true);
      expect(outline.blocks.some((b: any) => b.snippet !== '')).toBe(true);
      expect(outline.totals.blocks).toBeGreaterThanOrEqual(outline.blocks.length);
      expect(outline.warnings.every((w: any) => w.code === 'outline_truncated')).toBe(true);
      expect(outline.hasMore).toBe(false);
    });

    it('agrees with the Editor API tree: same top-level blocks, same order, same direct child counts', async () => {
      const outline = await json('logseq_get_page_outline', { page_name: big });
      const tree = await logseq.callAPI<any[]>('logseq.Editor.getPageBlocksTree', [big]);

      const shown = tree.slice(0, outline.blocks.length);
      expect(outline.blocks.length).toBe(Math.min(tree.length, 200));
      expect(shown.every((b: any, i: number) => b.uuid === outline.blocks[i].uuid)).toBe(true);
      expect(shown.every((b: any, i: number) => (b.children?.length ?? 0) === outline.blocks[i].childCount)).toBe(true);
    });

    it('makes at most 2 API calls for an exact name, an alias and an ISO date', async () => {
      for (const name of [big, aliasStub, isoDay]) {
        const before = apiCalls;
        await call('logseq_get_page_outline', { page_name: name });
        expect(apiCalls - before).toBeLessThanOrEqual(2);
      }
    });

    it('is much smaller than the page with its children', async () => {
      const outline = bytes(await call('logseq_get_page_outline', { page_name: big }));
      const page = bytes(await call('logseq_get_page', { page_name: big, include_children: true }));
      expect(outline).toBeLessThan(page);
    });

    it('resolves an alias to the declaring page and an ISO date to a journal, and says so', async () => {
      const viaAlias = await json('logseq_get_page_outline', { page_name: aliasStub });
      expect(viaAlias.resolvedFrom?.matchedBy).toBe('alias');
      const viaDate = await json('logseq_get_page_outline', { page_name: isoDay });
      // Absent when the graph titles its journals in ISO format, so the name is already exact
      expect([undefined, 'journal-date']).toContain(viaDate.resolvedFrom?.matchedBy);
      expect(Array.isArray(viaDate.blocks)).toBe(true);
    });

    it('reports a page that does not exist as an error that points at the list tool', async () => {
      const result = (await mcp.callTool({ name: 'logseq_get_page_outline', arguments: { page_name: 'no such page 43 probe' } })) as ToolResult;
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toContain('logseq_list_pages');
    });
  });

  describe('format: "markdown"', () => {
    it('get_page returns one plain text block: a title, then top-level bullets', async () => {
      const result = await call('logseq_get_page', { page_name: big, include_children: true, format: 'markdown' });
      const text = result.content[0].text;
      const tree = await logseq.callAPI<any[]>('logseq.Editor.getPageBlocksTree', [big]);

      expect(result.content).toHaveLength(1);
      expect(text.startsWith('# ')).toBe(true);
      expect(() => JSON.parse(text)).toThrow();
      const topBullets = text.split('\n').filter(line => line.startsWith('- ')).length;
      // The page-properties block is rendered as properties instead of a bullet
      expect(topBullets === tree.length || topBullets === tree.length - 1).toBe(true);
    });

    it('get_page is smaller than its JSON, which stays the default', async () => {
      const asJson = await call('logseq_get_page', { page_name: big, include_children: true });
      const asMarkdown = await call('logseq_get_page', { page_name: big, include_children: true, format: 'markdown' });

      expect(() => JSON.parse(asJson.content[0].text)).not.toThrow();
      expect(bytes(asMarkdown)).toBeLessThan(bytes(asJson));
    });

    it('prints each page\'s property block exactly as stored, and not again as a bullet (#80)', async () => {
      const rows = await logseq.callAPI<any[][]>('logseq.DB.datascriptQuery', [
        `[:find ?n ?c :where [?b :block/pre-block? true] [?b :block/page ?p] [?p :block/name ?n] [?b :block/content ?c]]`,
      ]);
      const sample = rows.filter(([, content]) => typeof content === 'string' && content.trim() !== '').slice(0, 15);
      expect(sample.length, `No page with a property block. ${SETUP_HINT}`).toBeGreaterThan(0);

      let notVerbatim = 0;
      let repeatedAsBullet = 0;
      for (const [name, content] of sample) {
        const text = (await call('logseq_get_page', { page_name: name, include_children: true, format: 'markdown' })).content[0].text;
        if (!text.includes(String(content).trimEnd())) notVerbatim++;
        if (text.includes(`\n- ${String(content).split('\n')[0]}`)) repeatedAsBullet++;
      }
      // Counts only: a failure must not echo a property key or value
      expect(notVerbatim, `${notVerbatim} of ${sample.length} pages did not print their property block verbatim`).toBe(0);
      expect(repeatedAsBullet, `${repeatedAsBullet} of ${sample.length} pages repeated the property block as a bullet`).toBe(0);
    });

    it('build_context renders the blocks, related pages and references as sections', async () => {
      const text = (await call('logseq_build_context', { topic_name: hub, format: 'markdown' })).content[0].text;

      expect(text.startsWith('# ')).toBe(true);
      expect(text.includes('## Blocks (') || text.includes('(this page has no blocks)')).toBe(true);
      expect(text.includes('## References (')).toBe(true);
      expect(text.includes('### [[')).toBe(true);
      expect(() => JSON.parse(text)).toThrow();
    });

    it('get_context_for_query and get_concept_network render too', async () => {
      const query = (await call('logseq_get_context_for_query', { query: `about [[${hub}]]`, format: 'markdown' })).content[0].text;
      expect(query.startsWith('# Context for: ')).toBe(true);
      expect(query.includes('Topics: [[')).toBe(true);

      const network = (await call('logseq_get_concept_network', { concept_name: hub, max_depth: 1, format: 'markdown' })).content[0].text;
      expect(network.startsWith('# Concept network: [[')).toBe(true);
      expect(network.includes('## Depth 1 (') && network.includes('## Links (')).toBe(true);
    });

    it('get_block renders a block of the outline', async () => {
      const outline = await json('logseq_get_page_outline', { page_name: big });
      const uuid = outline.blocks[0].uuid;
      const text = (await call('logseq_get_block', { block_uuid: uuid, include_children: true, format: 'markdown' })).content[0].text;

      expect(text.startsWith(`# Block ((${uuid}))`)).toBe(true);
      expect(text.split('\n').some(line => line.startsWith('- '))).toBe(true);
    });

    it('rejects an unknown format', async () => {
      const result = (await mcp.callTool({ name: 'logseq_get_page', arguments: { page_name: big, format: 'html' } })) as ToolResult;
      expect(result.isError).toBe(true);
    });
  });

  describe('compact', () => {
    it('build_context JSON keeps uuids and snippets and drops block bodies', async () => {
      const full = await json('logseq_build_context', { topic_name: hub });
      const compact = await json('logseq_build_context', { topic_name: hub, compact: true });

      expect(compact.directBlocks.length).toBe(full.directBlocks.length);
      expect(compact.directBlocks.every((b: any) => UUID.test(b.uuid) && b.snippet.length <= 80 && !('content' in b))).toBe(true);
      expect(compact.references.every((r: any) => UUID.test(r.block.uuid) && !('content' in r.block))).toBe(true);
      expect(compact.summary).toEqual(full.summary);
      expect(compact.totals).toEqual(full.totals);
      expect(compact.hasMore).toBe(full.hasMore);
    });

    it('build_context compact markdown carries uuids instead of bodies', async () => {
      const text = (await call('logseq_build_context', { topic_name: hub, format: 'markdown', compact: true })).content[0].text;
      // The footer (after the `---` rule) has bullets of its own: warnings and tips
      const body = text.split('\n---\n')[0];
      const bullets = body.split('\n').filter(line => /^\t*- /.test(line));

      expect(bullets.length).toBeGreaterThan(0);
      expect(bullets.every(line => /\(\([0-9a-f-]{36}\)\)$/.test(line.trimEnd()))).toBe(true);
    });
  });
});
