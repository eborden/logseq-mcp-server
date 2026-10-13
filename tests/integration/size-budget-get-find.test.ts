import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { connectFixture } from './helpers/fixture-client.js';
import { connectMcp } from './helpers/server-under-test.js';

/**
 * The character budget (#507, #485) of the get and find tools, against the fixture graph. Read-only.
 *
 * The fixture is small, so most tools are under 30,000 characters at their largest caps on it, and these tests pin that
 * (a result under the budget comes back as it was). The one result the fixture takes past the budget is
 * `get_context_for_query` over five busy topics, which is cut here. Every other cut is held by the Rust server's own
 * tests with larger stubs: `rust/tests/budget_get_calls.rs`, `rust/tests/current_context_calls.rs` and the over-budget
 * parity cases (`rust/tests/data/parity/*.json`, named "over the character budget"). Assertions on size and on codes,
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

  it('cuts five busy topics to the budget as a whole, from the last topic, and says what each kept', async () => {
    const query = 'compare [[hub central]], [[project atlas]], [[bob]], [[alice]] and [[project borealis]]';
    const { body, sent } = await call('logseq_get_context_for_query', { query });
    expect(sent).toBeLessThanOrEqual(BUDGET);
    // it keeps what fits: a cut that drops more entries than it must is a regression
    expect(sent).toBeGreaterThanOrEqual(28000);
    expect(body.extractedTopics).toHaveLength(5);
    expect(body.contexts).toHaveLength(5);
    const codes = (body.warnings ?? []).map(w => w.code);
    expect(codes[codes.length - 1]).toBe('result_size_truncated');
    const size = body.warnings!.find(w => w.code === 'result_size_truncated')!;
    expect(size.howToFetchAll).toBeUndefined();
    expect(size.message).toMatch(/^Showing \d+ of \d+ entries \(blocks, then references, then related pages, topic by topic\)/);
    // the first topic keeps its entries and the last loses its first
    const kept = (body.contexts as Array<{ directBlocks: unknown[]; references: unknown[]; relatedPages: unknown[] }>).map(
      context => context.directBlocks.length + context.references.length + context.relatedPages.length
    );
    expect(kept[0]).toBeGreaterThan(0);
    expect(kept[4]).toBeLessThan(kept[0]);
    // a topic cut at the caps says what it shows now
    const capped = body.warnings!.find(w => w.code === 'topic_truncated');
    expect(capped?.howToFetchAll).toMatch(/logseq_build_context/);
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
