import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../src/client.js';
import { DatalogQueryBuilder } from '../../src/datalog/queries.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Integration tests for :in inputs (issue #6)
 *
 * Verifies end to end that builders' :in queries run against a real LogSeq,
 * that casing does not matter, and that names containing characters that
 * used to break embedded queries are handled as plain data.
 *
 * Runs against the fixture graph (tests/integration/setup.md). The page is
 * `Bob` (tests/fixtures/graph/pages/Bob.md): a property block and two blocks,
 * linking `project atlas` and `project cascade`, and linked from 13 blocks
 * on 10 pages. Read-only.
 */

const PAGE = 'Bob';

describe('Datalog :in inputs Integration Tests', () => {
  let client: LogseqClient;
  let pageId: number;

  beforeAll(async () => {
    ({ client } = await connectFixture());
    const rows = await run(DatalogQueryBuilder.getPage(PAGE));
    pageId = rows[0][0].id;
  });

  async function run({ query, inputs }: { query: string; inputs: unknown[] }) {
    return client.executeDatalogQuery<any[]>(query, ...inputs);
  }

  it('getPage finds the page through the :in path', async () => {
    const rows = await run(DatalogQueryBuilder.getPage(PAGE));

    expect(rows).toHaveLength(1);
    expect(rows[0][0].name).toBe('bob');
    expect(rows[0][0]['original-name']).toBe('Bob');
    expect(Number.isInteger(pageId)).toBe(true);
  });

  it('getPage is case-insensitive', async () => {
    for (const name of ['bob', 'BOB', 'bOb']) {
      const rows = await run(DatalogQueryBuilder.getPage(name));
      expect(rows.map(row => row[0].id), name).toEqual([pageId]);
    }
  });

  it('conceptNetwork depth 0 finds the page', async () => {
    const rows = await run(DatalogQueryBuilder.conceptNetwork(PAGE, 0));

    expect(rows.map(row => row[0].id)).toEqual([pageId]);
  });

  it('conceptNetwork depth 1 finds every page it links and every page that links it', async () => {
    const rows = await run(DatalogQueryBuilder.conceptNetwork('BOB', 1));
    const pairs = rows.map(row => `${row[2]} ${row[1].name}`).sort();

    expect(pairs).toEqual([
      'inbound alice',
      'inbound block refs',
      'inbound jan 10th, 2025',
      'inbound jan 15th, 2025',
      'inbound jan 6th, 2025',
      'inbound jan 7th, 2025',
      'inbound project atlas',
      'inbound project atlas/meetings',
      'inbound project cascade',
      'inbound property types',
      'outbound project atlas',
      'outbound project cascade',
      // `role:: engineer` makes the property page `role` a ref of the property block
      'outbound role',
    ]);
  });

  it('getPageBlocks and getBlocksReferencingPage find the exact blocks', async () => {
    const blocks = await run(DatalogQueryBuilder.getPageBlocks(PAGE));
    const refs = await run(DatalogQueryBuilder.getBlocksReferencingPage('bob'));

    // The property block, then the two content blocks
    expect(blocks).toHaveLength(3);
    expect(blocks.every(row => row[0].page.id === pageId)).toBe(true);
    expect(refs).toHaveLength(13);
    expect([...new Set(refs.map(row => row[0].page.name))].sort()).toEqual([
      'alice', 'block refs', 'jan 10th, 2025', 'jan 15th, 2025', 'jan 6th, 2025', 'jan 7th, 2025',
      'project atlas', 'project atlas/meetings', 'project cascade', 'property types',
    ]);
  });

  // These names used to produce "Unexpected EOF reading string" or a
  // malformed query. As :in inputs they are just strings that match no page.
  it.each([
    ['a double quote', 'foo "bar'],
    ['a backslash', 'a\\b'],
    ['a newline', 'line1\nline2'],
    ['query-closing characters', 'x"]] [?p :block/name']
  ])('treats a name containing %s as data and finds no page', async (_label, name) => {
    expect(await run(DatalogQueryBuilder.getPage(name))).toHaveLength(0);
    expect(await run(DatalogQueryBuilder.getPageBlocks(name))).toHaveLength(0);
    expect(await run(DatalogQueryBuilder.conceptNetwork(name, 0))).toHaveLength(0);
    expect(await run(DatalogQueryBuilder.conceptNetwork(name, 1))).toHaveLength(0);
    expect(await run(DatalogQueryBuilder.getBlocksReferencingPage(name))).toHaveLength(0);
  });

  it('groundIds batches integer ids in a real query', async () => {
    // Bind ?p straight to the entity id, then require it to be a page
    const query = `[:find (pull ?p [:db/id]) :where ${DatalogQueryBuilder.groundIds([pageId], '?p')} [?p :block/name]]`;
    const rows = await client.executeDatalogQuery<any[]>(query);

    expect(rows).toEqual([[{ id: pageId }]]);
  });
});
