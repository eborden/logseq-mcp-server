import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { getBacklinksWithMeta, getConceptNetwork, getPage, searchBlocks } from './helpers/tools.js';
import { PageNotFoundError } from './helpers/errors.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Integration tests for :in inputs (issue #6, ADR-0013), through the tools.
 *
 * Verifies end to end that the server's queries, which bind every string with `:in`, run against a real
 * LogSeq, that casing does not matter, and that names containing characters that used to break embedded
 * queries are handled as plain data. The TypeScript version of this suite ran the query builders directly;
 * the Rust server has no builder to call, so the same promises are held at the tool.
 *
 * Runs against the fixture graph (tests/integration/setup.md). The page is `Bob`
 * (tests/fixtures/graph/pages/Bob.md): a property block and two blocks, linking `project atlas` and
 * `project cascade`, and linked from blocks on 10 pages. Read-only.
 */

const PAGE = 'Bob';

describe('Datalog :in inputs Integration Tests', () => {
  let client: LogseqClient;
  let pageId: number;

  beforeAll(async () => {
    ({ client } = await connectFixture());
    pageId = (await getPage(client, PAGE, false)).id;
  });

  it('get_page finds the page through the :in path', async () => {
    const page = await getPage(client, PAGE, false);

    expect(page.name).toBe('bob');
    expect(page.originalName).toBe('Bob');
    expect(Number.isInteger(pageId)).toBe(true);
  });

  it('every tool that takes a page name is case-insensitive', async () => {
    for (const name of ['bob', 'BOB', 'bOb']) {
      expect((await getPage(client, name, false)).id, name).toBe(pageId);
      const network = await getConceptNetwork(client, name, 0);
      expect(network.nodes.map((n: { id: number }) => n.id), name).toEqual([pageId]);
    }
  });

  it('get_concept_network depth 1 finds every page the page links and every page that links it', async () => {
    const network = await getConceptNetwork(client, 'BOB', 1);

    // `role:: engineer` makes the property page `role` a ref of the property block
    expect(network.nodes.filter((n: { depth: number }) => n.depth === 1).map((n: { name: string }) => n.name).sort()).toEqual([
      'Alice', 'Jan 10th, 2025', 'Jan 15th, 2025', 'Jan 6th, 2025', 'Jan 7th, 2025', 'block refs',
      'project atlas', 'project atlas/meetings', 'project cascade', 'property types', 'role',
    ]);
    // One edge per pair, whichever way the links run
    expect(network.edges).toHaveLength(11);
  });

  it('get_backlinks finds the same blocks on the same pages, whatever the casing', async () => {
    for (const name of ['Bob', 'bob']) {
      const { results, meta } = await getBacklinksWithMeta(client, name, { maxPages: 100, maxBlocksPerPage: 50 });
      const bySource = Object.fromEntries(results.map(([page, blocks]: [{ name: string }, unknown[]]) => [page.name, blocks.length]));

      // The linking blocks, grouped by their page (13 hold the link, the others sit under one that does)
      expect(bySource, name).toEqual({
        'jan 6th, 2025': 6,
        'project atlas': 2,
        'project atlas/meetings': 2,
        'property types': 2,
        alice: 1,
        'block refs': 1,
        'jan 10th, 2025': 1,
        'jan 15th, 2025': 1,
        'jan 7th, 2025': 1,
        'project cascade': 1,
      });
      // Nothing was cut, so there is no meta block
      expect(meta, name).toBeNull();
    }
  });

  // These names used to produce "Unexpected EOF reading string" or a malformed query. As :in inputs they are
  // just strings that match no page, so the tool answers "No page", not a LogSeq error.
  it.each([
    ['a double quote', 'foo "bar'],
    ['a backslash', 'a\\b'],
    ['a newline', 'line1\nline2'],
    ['query-closing characters', 'x"]] [?p :block/name'],
  ])('treats a name containing %s as data and finds no page', async (_label, name) => {
    await expect(getPage(client, name, true)).rejects.toBeInstanceOf(PageNotFoundError);
    await expect(getConceptNetwork(client, name, 0)).rejects.toBeInstanceOf(PageNotFoundError);
    await expect(getConceptNetwork(client, name, 1)).rejects.toBeInstanceOf(PageNotFoundError);
    await expect(getBacklinksWithMeta(client, name)).rejects.toBeInstanceOf(PageNotFoundError);
    // A search term is data too: it matches no block, and the regex it becomes is escaped
    expect(await searchBlocks(client, name)).toEqual([]);
  });

  it('a name the error message quotes keeps its characters', async () => {
    const error = await getPage(client, 'foo "bar', false).catch(e => e);

    expect(error).toBeInstanceOf(PageNotFoundError);
    expect((error as PageNotFoundError).pageName).toBe('foo "bar');
  });
});
