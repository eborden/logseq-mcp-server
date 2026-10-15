import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { connectFixture } from './helpers/fixture-client.js';
import { connectMcp } from './helpers/server-under-test.js';

/**
 * The character budget (#507, #485) of the get and find tools, against the fixture graph. Read-only.
 *
 * The fixture is small, so most tools are under 30,000 characters at their largest caps on it, and these tests pin that
 * (a result under the budget comes back as it was). The results the fixture takes past the budget are
 * `explore_context` on the hub at its largest caps, which is cut here, and the full tree of the `quartz log` page
 * and of its first section, which `tree-cursor.test.ts` reads to the end. Every other cut is held by the Rust server's own
 * tests with larger stubs: `tests/budget_get_calls.rs`, `tests/current_context_calls.rs` and the over-budget
 * parity cases (`tests/data/parity/*.json`, named "over the character budget"). Assertions on size and on codes,
 * never on page names from the graph.
 */

const BUDGET = 30000;

interface Meta {
  hasMore: boolean;
  warnings?: Array<{ code: string; message: string; howToFetchAll?: string }>;
}

describe('the character budget of the get and find tools (#507)', () => {
  let mcp: Client;
  let client: LogseqClient;

  beforeAll(async () => {
    ({ client } = await connectFixture());
    mcp = await connectMcp(client, { tips: false });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  async function call(name: string, args: Record<string, unknown>) {
    const result = (await mcp.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    const sent = result.content.reduce((sum, block) => sum + [...block.text].length, 0);
    return { text: result.content[0].text, sent, body: JSON.parse(result.content[0].text) as Meta & Record<string, any> };
  }

  it('cuts the hub at its largest caps to the budget, from the last reference, and reads the rest with the cursor', async () => {
    const caps = { page: 'hub central', max_blocks: 500, max_references: 500, max_related_pages: 500 };
    const { body, sent } = await call('logseq_explore_context', caps);
    expect(sent).toBeLessThanOrEqual(BUDGET);
    // it keeps what fits: a cut that drops more entries than it must is a regression
    expect(sent).toBeGreaterThanOrEqual(28000);
    // the blocks are the answer and stay whole; the related pages go first, then the last references
    expect(body.directBlocks).toHaveLength(71);
    expect(body.relatedPages).toEqual([]);
    expect(body.references.length).toBeGreaterThan(0);
    expect(body.references.length).toBeLessThan(66);
    expect(body.totals).toEqual({ blocks: 71, relatedPages: 61, references: 66 });
    expect((body.warnings ?? []).map(w => w.code)).toEqual(['result_size_truncated']);
    const size = body.warnings![0];
    expect(body.hasMore).toBe(true);
    expect(size.howToFetchAll).toBe('Pass nextCursor as cursor, with no other argument, to read the next page.');
    expect(typeof body.nextCursor).toBe('string');

    // reading on finds every reference and related page left, with nothing repeated and the blocks not read again
    const pages = [body];
    while (pages[pages.length - 1].nextCursor) {
      const next = await call('logseq_explore_context', { cursor: pages[pages.length - 1].nextCursor });
      expect(next.sent).toBeLessThanOrEqual(BUDGET);
      pages.push(next.body);
      expect(pages.length, 'a cursor that never ends').toBeLessThan(10);
    }
    const ids = pages.flatMap(page => page.references.map(reference => reference.block.id));
    expect(ids).toHaveLength(66);
    expect(new Set(ids).size).toBe(66);
    expect(pages.flatMap(page => page.relatedPages)).toHaveLength(61);
    expect(pages.slice(1).every(page => page.directBlocks.length === 0)).toBe(true);
    const last = pages[pages.length - 1];
    expect([last.hasMore, last.nextCursor, last.warnings ?? []]).toEqual([false, undefined, []]);
  });

  it('leaves the hub page, its outline and its first block under the budget as they were', async () => {
    const full = await call('logseq_get_page', { page: 'hub central', detail: 'full' });
    expect(full.sent).toBeLessThan(BUDGET);
    expect(full.body.warnings).toBeUndefined();
    expect(full.body.children).toHaveLength(71);

    const outline = await call('logseq_get_page', { page: 'hub central', detail: 'outline' });
    expect(outline.sent).toBeLessThan(BUDGET);
    expect(outline.body.warnings).toEqual([]);
    expect(outline.body.blocks).toHaveLength(71);

    const first = outline.body.blocks[0] as { uuid: string };
    const block = await call('logseq_get_block', { uuid: first.uuid, include_children: true });
    expect(block.sent).toBeLessThan(BUDGET);
    expect(block.body.warnings).toBeUndefined();
  });

  it('lists every page of the fixture at the largest limit without a cut', async () => {
    const { body, sent } = await call('logseq_find_pages', { limit: 1000 });
    expect(sent).toBeLessThan(BUDGET);
    expect(body.warnings).toBeUndefined();
    expect(body.pages).toHaveLength(body.total);
  });

  it('checks a link to every page of the fixture without a cut', async () => {
    const { body } = await call('logseq_find_pages', { limit: 1000 });
    const names = (body.pages as Array<{ name: string }>).map(page => page.name);
    const checked = await call('logseq_check_links', { before: names.join('\n'), after: names.map(name => `[[${name}]]`).join('\n') });
    expect(checked.sent).toBeLessThan(BUDGET);
    expect(checked.body.warnings).toEqual([]);
    expect(checked.body.refs.resolved).toHaveLength(names.length);
  });
});
