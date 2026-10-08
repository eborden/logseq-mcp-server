import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { connectFixture } from './helpers/fixture-client.js';
import { connectMcp } from './helpers/server-under-test.js';

/**
 * The page outline tool and `format: "markdown"` / `compact` (#43) against the
 * fixture graph, through the real MCP server.
 *
 * Read-only. `project atlas` has page properties, five top-level blocks (one with
 * three children) and the alias `atlas`; `hub central` has 71 blocks and is linked
 * from 66; the journal is Jan 6th, 2025. See tests/fixtures/README.md.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

describe('page outline and markdown output against the fixture graph (#43)', () => {
  let mcp: Client;
  let logseq: LogseqClient;
  let apiCalls = 0;
  /** A page with a property block and nested blocks */
  const big = 'project atlas';
  /** A page linked from many blocks */
  const hub = 'hub central';
  const aliasStub = 'atlas';
  const isoDay = '2025-01-06';

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = (await mcp.callTool({ name, arguments: args })) as ToolResult;
    // A failure message may quote a page name, so only the tool name is reported
    expect(result.isError, `${name} returned an error`).toBeFalsy();
    return result;
  }
  const json = async (name: string, args: Record<string, unknown>) => JSON.parse((await call(name, args)).content[0].text);
  const bytes = (result: ToolResult) => result.content.reduce((n, b) => n + Buffer.byteLength(b.text, 'utf8'), 0);

  beforeAll(async () => {
    ({ client: logseq } = await connectFixture());
    const original = logseq.callAPI.bind(logseq);
    logseq.callAPI = (async (method: string, args?: any[]) => {
      apiCalls++;
      return original(method, args);
    }) as typeof logseq.callAPI;

    mcp = await connectMcp(logseq);
  });

  afterAll(async () => {
    await mcp?.close();
  });

  describe('logseq_get_page_outline', () => {
    it('lists the top-level blocks of a page with a snippet and a child count each', async () => {
      const outline = await json('logseq_get_page_outline', { page_name: big });

      // The property block, then four blocks; "Goals for the first release" has three children
      expect(outline.blocks.map((b: any) => b.childCount)).toEqual([0, 0, 3, 0, 0]);
      expect(outline.blocks[0].snippet.startsWith('alias:: atlas')).toBe(true);
      expect(outline.totals).toEqual({ blocks: 5 });
      expect(outline.warnings).toEqual([]);
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
      expect(viaAlias.resolvedFrom).toEqual({ name: 'atlas', matchedBy: 'alias', resolvedTo: 'project atlas' });
      expect(viaAlias.blocks).toHaveLength(5);
      // The fixture titles journals "MMM do, yyyy", so an ISO date always goes through the resolver
      const viaDate = await json('logseq_get_page_outline', { page_name: isoDay });
      expect(viaDate.resolvedFrom).toEqual({ name: isoDay, matchedBy: 'journal-date', resolvedTo: 'Jan 6th, 2025' });
      expect(viaDate.blocks.map((b: any) => b.childCount)).toEqual([2, 0, 0]);
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
      // The footer (after the `---` rule) has bullets of its own: tips
      const topBullets = text.split('\n---\n')[0].split('\n').filter(line => line.startsWith('- ')).length;
      // The page-properties block is rendered as properties instead of a bullet
      expect(text.startsWith('# project atlas\n\nalias:: atlas\n')).toBe(true);
      expect(tree).toHaveLength(5);
      expect(topBullets).toBe(4);
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
      const sample = rows.filter(([, content]) => typeof content === 'string' && content.trim() !== '');
      expect(sample.map(([name]) => name).sort()).toEqual([
        'alice', 'bob', 'logseq-mcp-fixture-sentinel', 'project atlas', 'project borealis', 'project cascade',
        'property types',
      ]);

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

      expect(text.startsWith('# hub central\n')).toBe(true);
      expect(text.includes('## Blocks (50 of 71)')).toBe(true);
      expect(text.includes('## Related pages (10 of 61)')).toBe(true);
      expect(text.includes('## References (20 of 66)')).toBe(true);
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
      expect(compact.directBlocks).toHaveLength(50);
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
