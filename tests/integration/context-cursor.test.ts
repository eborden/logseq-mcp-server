import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { connectFixture } from './helpers/fixture-client.js';
import { connectMcp } from './helpers/server-under-test.js';

/**
 * The cursor of `logseq_explore_context` (ADR-0038, #555), against the fixture's hub (tests/fixtures/README.md, "The
 * hub"): 71 blocks, 66 references on 61 source pages and 61 related pages, each more than one page of the defaults (50,
 * 20 and 10) holds. Read to the end, each list must be there exactly once, in the order of one call that holds them all,
 * each list ending on its own page and the last page with no `nextCursor`. The counts are the fixture's, so nothing here
 * is discovered at run time. Read-only.
 */

const BUDGET = 30000;
const NEXT_PAGE = 'Pass nextCursor as cursor, with no other argument, to read the next page.';

interface ContextPage {
  page: string;
  resolvedFrom?: unknown;
  resolvedAliases?: string[];
  hasMore: boolean;
  nextCursor?: string;
  warnings: Array<{ code: string; message: string; howToFetchAll?: string }>;
  totals: { blocks: number; relatedPages: number; references: number };
  summary: { totalBlocks: number; totalRelatedPages: number; totalReferences: number };
  mainPage: { name: string };
  directBlocks: Array<{ id: number }>;
  relatedPages: Array<{ page: { id: number } }>;
  references: Array<{ block: { id: number } }>;
}

describe('the cursor of logseq_explore_context (#555)', () => {
  let mcp: Client;
  let client: LogseqClient;

  beforeAll(async () => {
    ({ client } = await connectFixture());
    mcp = await connectMcp(client, { tips: false });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  async function call(args: Record<string, unknown>) {
    const result = (await mcp.callTool({ name: 'logseq_explore_context', arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    const text = result.content[0].text;
    return { text, sent: [...text].length, isError: result.isError, body: result.isError || !text.startsWith('{') ? undefined : (JSON.parse(text) as ContextPage) };
  }

  /** Every page of a read, first call to last, each at most the budget. */
  async function readToTheEnd(args: Record<string, unknown>): Promise<ContextPage[]> {
    const pages: ContextPage[] = [];
    let next: Record<string, unknown> | undefined = args;
    while (next) {
      const { body, sent, isError, text } = await call(next);
      expect(isError, text).toBeFalsy();
      expect(sent, `page ${pages.length + 1} is at most the budget`).toBeLessThanOrEqual(BUDGET);
      pages.push(body!);
      expect(pages.length, 'a cursor that never ends').toBeLessThan(20);
      expect(body!.hasMore, 'hasMore is true exactly when there is a nextCursor').toBe(body!.nextCursor !== undefined);
      next = body!.nextCursor ? { cursor: body!.nextCursor } : undefined;
    }
    return pages;
  }

  const sizes = (pages: ContextPage[]) => pages.map(page => [page.directBlocks.length, page.references.length, page.relatedPages.length]);

  it('reads the hub to the end: each list once, in the order of one call that holds them all, each ending on its own page', async () => {
    const pages = await readToTheEnd({ page: 'hub central' });
    // blocks 50 + 21, references 20 + 20 + 20 + 6, related pages 10 x 6 + 1: seven pages, and each list ends on its own
    expect(sizes(pages)).toEqual([
      [50, 20, 10],
      [21, 20, 10],
      [0, 20, 10],
      [0, 6, 10],
      [0, 0, 10],
      [0, 0, 10],
      [0, 0, 1],
    ]);
    const all = <T>(pick: (page: ContextPage) => T[]) => pages.flatMap(pick);
    const blockIds = all(page => page.directBlocks).map(block => block.id);
    const referenceIds = all(page => page.references).map(reference => reference.block.id);
    const relatedIds = all(page => page.relatedPages).map(related => related.page.id);
    expect([blockIds.length, new Set(blockIds).size]).toEqual([71, 71]);
    expect([referenceIds.length, new Set(referenceIds).size]).toEqual([66, 66]);
    expect([relatedIds.length, new Set(relatedIds).size]).toEqual([61, 61]);
    // the references are the ranking of one call that holds them all: the first 20 are the first page's
    expect(referenceIds.slice(0, 20)).toEqual(pages[0].references.map(reference => reference.block.id));

    // every page says which page it is of and what the lists hold in all; how the request was read is the first page's alone
    for (const page of pages) {
      expect([page.page, page.mainPage.name, page.totals]).toEqual(['hub central', 'hub central', { blocks: 71, relatedPages: 61, references: 66 }]);
    }
    // all but the last page lead with the cursor; the last has no cursor, no hasMore and no warning
    const last = pages[pages.length - 1];
    expect([last.hasMore, last.nextCursor, last.warnings]).toEqual([false, undefined, []]);
    for (const page of pages.slice(0, -1)) {
      expect(page.hasMore).toBe(true);
      expect(page.warnings.length).toBeGreaterThan(0);
      for (const warning of page.warnings) expect(warning.howToFetchAll, warning.code).toMatch(new RegExp(`^${NEXT_PAGE}`));
    }
    // a list that is done says nothing on the pages after, and the one still going says where it is
    expect(pages[1].warnings.map(w => w.code)).toEqual(['references_truncated', 'related_pages_truncated']);
    expect(pages[1].warnings[0].message).toBe('Showing 21-40 of 66 references.');
    expect(pages[3].warnings.map(w => w.code)).toEqual(['related_pages_truncated']);
    expect(pages[3].warnings[0].message).toBe('Showing 31-40 of 61 related pages.');
    expect(pages[6].warnings).toEqual([]);
  });

  it('reads the hub in markdown with the cursor in the footer of every page but the last', async () => {
    let next: Record<string, unknown> | undefined = { page: 'hub central', format: 'markdown' };
    let pages = 0;
    let last = '';
    while (next) {
      const { text, sent, isError } = await call(next);
      expect(isError, text).toBeFalsy();
      expect(sent).toBeLessThanOrEqual(BUDGET);
      const cursor = text.split('\n').find(line => line.startsWith('nextCursor: '))?.slice('nextCursor: '.length);
      expect(text.includes('hasMore: true'), `page ${pages + 1}`).toBe(cursor !== undefined);
      next = cursor ? { cursor } : undefined;
      last = text;
      pages++;
      expect(pages, 'a cursor that never ends').toBeLessThan(20);
    }
    expect(pages).toBe(7);
    expect(last).not.toContain('nextCursor');
  });

  it('leaves a list out when its page size is 0, and still reads the others to the end', async () => {
    const pages = await readToTheEnd({ page: 'hub central', max_blocks: 0, max_related_pages: 0 });
    expect(sizes(pages)).toEqual([
      [0, 20, 0],
      [0, 20, 0],
      [0, 20, 0],
      [0, 6, 0],
    ]);
    // the lists left out are said on every page, and the raise only on the first
    expect(pages[0].warnings.map(w => w.code)).toEqual(['blocks_truncated', 'references_truncated', 'related_pages_truncated']);
    expect(pages[0].warnings[0].howToFetchAll).toBe('Set max_blocks to 71 (or higher) to get all 71 in one call.');
    expect(pages[1].warnings[0].howToFetchAll).toBeUndefined();
  });

  it('is correct when its snapshot is gone: a second server reads the same pages from the first page\'s calls', async () => {
    const first = (await call({ page: 'hub central' })).body!;
    // a server that has never seen this cursor (a new process, so its own start time) builds the context again
    const other = await connectMcp(client, { tips: false });
    try {
      const result = (await other.callTool({ name: 'logseq_explore_context', arguments: { cursor: first.nextCursor } })) as { content: Array<{ text: string }> };
      const second = JSON.parse(result.content[0].text) as ContextPage;
      const again = (await call({ cursor: first.nextCursor })).body!;
      expect(second.references.map(reference => reference.block.id)).toEqual(again.references.map(reference => reference.block.id));
      expect(second.directBlocks.map(block => block.id)).toEqual(again.directBlocks.map(block => block.id));
      expect(second.warnings.map(warning => warning.code)).not.toContain('cursor_stale');
    } finally {
      await other.close();
    }
  });
});
