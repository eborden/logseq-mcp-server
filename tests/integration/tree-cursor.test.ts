import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { connectFixture } from './helpers/fixture-client.js';
import { connectMcp } from './helpers/server-under-test.js';

/**
 * The cursor of `get_page` with `detail: "full"` and of `get_block` with `include_children` (ADR-0038, #552), against the
 * fixture's `quartz log` page (tests/fixtures/README.md, "A long page"): about 104,000 characters in 101 blocks, the
 * block "Log part 1" with 60 children (one of them with 3 of its own) and 30 top-level entries after it. A tree
 * read to the end must hold every block once, in document order, in pages of at most the budget. The expected blocks are
 * the bullets of the committed fixture file, so nothing here is discovered at run time. Read-only.
 */

const BUDGET = 30000;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'graph', 'pages', 'quartz log.md');
const SECTION_ONE = '0088f1a0-0000-4000-8000-000000000b01';
const SECTION_TWO = '0088f1a0-0000-4000-8000-000000000b02';

interface Block {
  uuid: string;
  content: string;
  children?: Block[];
  childrenTruncated?: boolean;
  ancestors?: Array<{ uuid: string; snippet: string }>;
}

interface Result {
  uuid?: string;
  originalName?: string;
  continued?: boolean;
  children?: Block[];
  hasMore?: boolean;
  nextCursor?: string;
  warnings?: Array<{ code: string; message: string; howToFetchAll?: string }>;
}

/** The first line of every bullet of the fixture file, in document order. */
function bullets(): string[] {
  return readFileSync(FIXTURE, 'utf-8')
    .split('\n')
    .filter(line => /^\t*- /.test(line))
    .map(line => line.replace(/^\t*- /, ''));
}

const firstLine = (block: Block) => block.content.split('\n')[0];

function flatten(blocks: Block[] = []): Block[] {
  return blocks.flatMap(block => [block, ...flatten(block.children)]);
}

describe('a tree larger than the budget is read to the end with its cursor (#552)', () => {
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
    const sent = result.content.reduce((sum, block) => sum + [...block.text].length, 0);
    const text = result.content[0].text;
    // Markdown is plain text, and so is an error's JSON that the caller reads as text
    const json = !result.isError && text.startsWith('{');
    return { text, sent, isError: result.isError, body: json ? (JSON.parse(text) as Result) : undefined };
  }

  /** Every page of a read, first call to last, each at most the budget. */
  async function readToTheEnd(name: string, args: Record<string, unknown>): Promise<Result[]> {
    const pages: Result[] = [];
    let next: Record<string, unknown> | undefined = args;
    while (next) {
      const { body, sent, isError, text } = await call(name, next);
      expect(isError, text).toBeFalsy();
      expect(sent, `page ${pages.length + 1} is at most the budget`).toBeLessThanOrEqual(BUDGET);
      pages.push(body!);
      expect(pages.length, 'a cursor that never ends').toBeLessThan(20);
      expect(body!.hasMore ?? false, 'hasMore is true exactly when there is a nextCursor').toBe(body!.nextCursor !== undefined);
      next = body!.nextCursor ? { cursor: body!.nextCursor } : undefined;
    }
    return pages;
  }

  it('is a page of 101 blocks and 104,000 characters, as the fixture file says', () => {
    expect(bullets()).toHaveLength(101);
    expect(readFileSync(FIXTURE, 'utf-8').length).toBeGreaterThan(3 * BUDGET);
  });

  it('reads the page to the end in JSON with every block once, in document order, and no page over the budget', async () => {
    const pages = await readToTheEnd('logseq_get_page', { page: 'quartz log', detail: 'full' });
    expect(pages.length).toBeGreaterThanOrEqual(4);
    expect(flatten(pages.flatMap(page => page.children)).map(firstLine)).toEqual(bullets());
    for (const [at, page] of pages.entries()) {
      expect(page.originalName, 'the page entity is the frame of every page').toBe('quartz log');
      if (at < pages.length - 1) {
        expect(page.warnings!.map(warning => warning.code)).toEqual(['result_size_truncated']);
        expect(page.warnings![0].howToFetchAll).toBe('Pass nextCursor as cursor, with no other argument, to read the next page.');
      } else {
        expect(page.nextCursor).toBeUndefined();
        expect(page.warnings).toBeUndefined();
        expect(page.hasMore).toBeUndefined();
      }
    }
  });

  it('starts the second page inside the 60 children of part 1 and names the block they sit under', async () => {
    const [first, second] = await readToTheEnd('logseq_get_page', { page: 'quartz log', detail: 'full' });
    // page 1 holds the intro, part 1 and its first children; the block that lost children says so
    const section = first.children![1];
    expect(section.uuid).toBe(SECTION_ONE);
    expect(section.childrenTruncated).toBe(true);
    const kept = section.children!.length;
    expect(kept).toBeGreaterThan(10);
    expect(kept).toBeLessThan(60);
    // page 2 starts with the next children, each under part 1, which is the only block named
    const top = second.children!;
    expect(firstLine(top[0]).startsWith(`Block 1-${String(kept + 1).padStart(2, '0')} `)).toBe(true);
    for (const block of top.filter(block => firstLine(block).startsWith('Block 1-'))) {
      expect(block.ancestors, firstLine(block).slice(0, 14)).toEqual([{ uuid: SECTION_ONE, snippet: 'Log part 1 holds 60 blocks' }]);
    }
    // a block nested in a piece names no ancestors of its own
    expect(flatten(top).filter(block => block.ancestors).every(block => top.includes(block))).toBe(true);
  });

  it('reads the page to the end in Markdown with every bullet once, and says what a page that starts inside a block sits under', async () => {
    let args: Record<string, unknown> = { page: 'quartz log', detail: 'full', format: 'markdown' };
    const seen: string[] = [];
    let unders = 0;
    for (let page = 1; page < 20; page++) {
      const { text, sent, isError } = await call('logseq_get_page', args);
      expect(isError, text).toBeFalsy();
      expect(sent).toBeLessThanOrEqual(BUDGET);
      // the footer after the `---` rule has bullets of its own (warnings), which are no blocks
      const body = text.split('\n---\n')[0];
      seen.push(...body.split('\n').filter(line => /^\t*- /.test(line)).map(line => line.replace(/^\t*- /, '')));
      unders += body.split('\n').filter(line => line === '[under: Log part 1 holds 60 blocks]').length;
      const cursor = text.split('\n').find(line => line.startsWith('nextCursor: '))?.slice('nextCursor: '.length);
      if (!cursor) break;
      args = { cursor };
    }
    expect(seen).toEqual(bullets());
    expect(unders, 'one line for each page that starts under part 1').toBeGreaterThanOrEqual(1);
  });

  it('reads part 1 to the end with its body once and its 60 children and 3 details in order', async () => {
    const pages = await readToTheEnd('logseq_get_block', { uuid: SECTION_ONE, include_children: true });
    expect(pages.length).toBeGreaterThanOrEqual(2);
    const [first, ...later] = pages;
    expect(first.uuid).toBe(SECTION_ONE);
    expect(first.childrenTruncated).toBe(true);
    for (const page of later) {
      expect(page.continued, 'a later page is the frame').toBe(true);
      expect(page.uuid).toBe(SECTION_ONE);
      expect(Object.keys(page).slice(0, 3)).toEqual(['uuid', 'continued', 'children']);
      expect((page as unknown as { content?: string }).content, 'the body of the block is not repeated').toBeUndefined();
    }
    const read = [firstLine(first as unknown as Block), ...flatten(first.children).map(firstLine), ...later.flatMap(page => flatten(page.children).map(firstLine))];
    const lines = bullets();
    const start = lines.findIndex(line => line.startsWith('Log part 1'));
    expect(read).toEqual(lines.slice(start, lines.findIndex(line => line.startsWith('Log part 2'))));
    expect(read).toHaveLength(64);
  });

  it('reads part 1 in Markdown under a continued heading', async () => {
    const first = await call('logseq_get_block', { uuid: SECTION_ONE, include_children: true, format: 'markdown' });
    expect(first.text.startsWith(`# Block ((${SECTION_ONE}))\n`)).toBe(true);
    const cursor = first.text.split('\n').find(line => line.startsWith('nextCursor: '))!.slice('nextCursor: '.length);
    const second = await call('logseq_get_block', { cursor });
    expect(second.text.startsWith(`# Block ((${SECTION_ONE})) (continued)\n`)).toBe(true);
    expect(second.sent).toBeLessThanOrEqual(BUDGET);
  });

  it('leaves a block under the budget as it was, with no cursor', async () => {
    const { body } = await call('logseq_get_block', { uuid: SECTION_TWO, include_children: true });
    expect(body!.nextCursor).toBeUndefined();
    expect(body!.warnings).toBeUndefined();
    expect(flatten(body!.children).map(firstLine)).toEqual(bullets().filter(line => /^Block 2-/.test(line)));
  });

  it('refuses a cursor with any other argument, and a call with neither the name nor a cursor, before it reads', async () => {
    const { body } = await call('logseq_get_page', { page: 'quartz log', detail: 'full' });
    const cursor = body!.nextCursor!;
    for (const [other, value] of [['page', 'quartz log'], ['name', 'quartz log'], ['page_name', 'quartz log'], ['detail', 'full'], ['resolve_refs', false], ['format', 'json']] as const) {
      const refused = await call('logseq_get_page', { cursor, [other]: value });
      expect(refused.isError, other).toBe(true);
      expect(refused.text, other).toContain('left out when cursor is given');
    }
    const blockCursor = (await call('logseq_get_block', { uuid: SECTION_ONE, include_children: true })).body!.nextCursor!;
    for (const [other, value] of [['uuid', SECTION_ONE], ['block_uuid', SECTION_ONE], ['include_children', true]] as const) {
      const refused = await call('logseq_get_block', { cursor: blockCursor, [other]: value });
      expect(refused.isError, other).toBe(true);
      expect(refused.text, other).toContain('left out when cursor is given');
    }
    expect((await call('logseq_get_page', { detail: 'full' })).text).toContain("Invalid parameter 'page': missing");
    expect((await call('logseq_get_block', { include_children: true })).text).toContain("Invalid parameter 'uuid': missing");
    // a cursor of the other tool, and one that is no cursor
    expect((await call('logseq_get_page', { cursor: blockCursor })).text).toContain('made by another tool');
    expect((await call('logseq_get_block', { cursor })).text).toContain('made by another tool');
    expect((await call('logseq_get_page', { cursor: 'not a cursor' })).text).toContain('not base64url text');
  });

  it('takes the alias of the name alone, which a validating client now passes', async () => {
    const byAlias = await call('logseq_get_page', { page_name: 'quartz log', detail: 'full' });
    expect(byAlias.body!.originalName).toBe('quartz log');
    const byBlockAlias = await call('logseq_get_block', { block_uuid: SECTION_TWO, include_children: true });
    expect(byBlockAlias.body!.uuid).toBe(SECTION_TWO);
  });
});
