import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { connectFixture } from './helpers/fixture-client.js';
import { connectMcp } from './helpers/server-under-test.js';

/**
 * The cursor of `get_page` with `detail: "outline"` (ADR-0038, #553), against the fixture's `quartz outline` page
 * (tests/fixtures/README.md, "A page with many top-level blocks"): 450 top-level blocks, `Row 001` to `Row 450`, 200 with
 * a short first line and 250 with a long one, and one child under each row whose number is a multiple of 5. An outline
 * read to the end must hold every top-level block once, in page order, in pages of at most 200 blocks and the budget. The
 * expected rows are the bullets of the committed fixture file, so nothing here is discovered at run time. Read-only.
 */

const BUDGET = 30000;
const PAGE_SIZE = 200;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'graph', 'pages', 'quartz outline.md');

interface Entry {
  uuid: string;
  snippet: string;
  childCount: number;
}

interface Result {
  page?: string;
  blocks?: Entry[];
  hasMore?: boolean;
  nextCursor?: string;
  warnings?: Array<{ code: string; message: string; howToFetchAll?: string }>;
  totals?: { blocks: number };
}

/** The top-level rows of the fixture file, in page order: "Row 001" and so on. */
function rows(): string[] {
  return readFileSync(FIXTURE, 'utf-8')
    .split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).split(' ').slice(0, 2).join(' '));
}

describe('an outline of more top-level blocks than a page holds is read to the end with its cursor (#553)', () => {
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
    const result = (await mcp.callTool({ name: 'logseq_get_page', arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    const sent = result.content.reduce((sum, block) => sum + [...block.text].length, 0);
    const text = result.content[0].text;
    return { text, sent, isError: result.isError };
  }

  /** Every page of a JSON read, first call to last, each at most the budget. */
  async function readToTheEnd(args: Record<string, unknown>): Promise<Result[]> {
    const pages: Result[] = [];
    let next: Record<string, unknown> | undefined = args;
    while (next) {
      const { text, sent, isError } = await call(next);
      expect(isError, text).toBeFalsy();
      expect(sent, `page ${pages.length + 1} is at most the budget`).toBeLessThanOrEqual(BUDGET);
      const body = JSON.parse(text) as Result;
      pages.push(body);
      expect(pages.length, 'a cursor that never ends').toBeLessThan(20);
      expect(body.blocks!.length).toBeLessThanOrEqual(PAGE_SIZE);
      expect(body.hasMore ?? false, 'hasMore is true exactly when there is a nextCursor').toBe(body.nextCursor !== undefined);
      next = body.nextCursor ? { cursor: body.nextCursor } : undefined;
    }
    return pages;
  }

  it('is 450 top-level rows, as the fixture file says', () => {
    expect(rows()).toHaveLength(450);
    expect(rows()[0]).toBe('Row 001');
    expect(rows()[449]).toBe('Row 450');
  });

  it('reads the outline to the end in JSON with every top-level block once, in page order', async () => {
    const pages = await readToTheEnd({ page: 'quartz outline', detail: 'outline' });
    expect(pages).toHaveLength(3);
    const blocks = pages.flatMap(page => page.blocks!);
    expect(blocks.map(block => block.snippet.split(' ').slice(0, 2).join(' '))).toEqual(rows());
    expect(new Set(blocks.map(block => block.uuid)).size).toBe(450);
    // a child under every fifth row, and no other block has one
    blocks.forEach((block, at) => expect(block.childCount, block.snippet).toBe((at + 1) % 5 === 0 ? 1 : 0));
    for (const page of pages) {
      expect(page.page).toBe('quartz outline');
      expect(page.totals).toEqual({ blocks: 450 });
    }
  });

  it('cuts the first page by the page size and the second by the budget, each saying so and leading with the cursor', async () => {
    const [first, second, third] = await readToTheEnd({ page: 'quartz outline', detail: 'outline' });
    expect(first.blocks).toHaveLength(PAGE_SIZE);
    expect(first.warnings!.map(warning => warning.code)).toEqual(['outline_truncated']);
    expect(first.warnings![0].message).toBe('Showing 1-200 of 450 top-level blocks.');
    expect(first.warnings![0].howToFetchAll).toBe('Pass nextCursor as cursor, with no other argument, to read the next page.');

    expect(second.blocks!.length).toBeGreaterThan(100);
    expect(second.blocks!.length).toBeLessThan(PAGE_SIZE);
    expect(second.warnings!.map(warning => warning.code)).toEqual(['result_size_truncated']);
    expect(second.warnings![0].howToFetchAll).toBe('Pass nextCursor as cursor, with no other argument, to read the next page.');
    expect(second.blocks![0].snippet.startsWith('Row 201')).toBe(true);

    expect(third.nextCursor).toBeUndefined();
    expect(third.warnings).toEqual([]);
    expect(third.hasMore).toBe(false);
    expect(third.blocks![third.blocks!.length - 1].snippet.startsWith('Row 450')).toBe(true);
  });

  it('reads the outline to the end in TOON, with the cursor in its meta, and every row once', async () => {
    const seen: string[] = [];
    let next: Record<string, unknown> | undefined = { page: 'quartz outline', detail: 'outline', format: 'toon' };
    let pages = 0;
    while (next) {
      const { text, sent, isError } = await call(next);
      expect(isError, text).toBeFalsy();
      expect(sent).toBeLessThanOrEqual(BUDGET);
      expect(text.startsWith('{'), 'TOON, not JSON').toBe(false);
      seen.push(...[...text.matchAll(/Row (\d{3})/g)].map(match => `Row ${match[1]}`));
      const token = /^nextCursor: "?([A-Za-z0-9_-]+)"?$/m.exec(text)?.[1];
      next = token ? { cursor: token } : undefined;
      pages += 1;
      expect(pages, 'a cursor that never ends').toBeLessThan(20);
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(rows());
  });

  it('takes no other argument with a cursor, and refuses a token that is not an outline cursor', async () => {
    const [first] = await readToTheEnd({ page: 'quartz outline', detail: 'outline' }).then(pages => pages.slice(0, 1));
    const refused = await call({ cursor: first.nextCursor, detail: 'outline' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Invalid parameter 'detail'");
    const garbage = await call({ cursor: 'not-a-cursor' });
    expect(garbage.isError).toBe(true);
    expect(garbage.text).toContain("Invalid parameter 'cursor'");
  });

  it('is unchanged for an outline of one page: no cursor, no warning, hasMore false', async () => {
    const { body } = await readToTheEnd({ page: 'quartz log', detail: 'outline' }).then(pages => ({ body: pages[0] }));
    expect(body.nextCursor).toBeUndefined();
    expect(body.hasMore).toBe(false);
    expect(body.warnings).toEqual([]);
    expect(body.totals!.blocks).toBe(body.blocks!.length);
  });
});
