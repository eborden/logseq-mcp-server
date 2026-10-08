import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LogseqClient } from '../../../src/client.js';
import { DatalogQueryBuilder } from '../../../src/datalog/queries.js';
import { getBlock, getPage } from '../helpers/tools.js';
import { ResolvedRef } from '../../../src/types.js';
import { connectFixture } from '../helpers/fixture-client.js';

/**
 * resolve_refs on refs and embeds of blocks that do not exist (#138), against the fixture graph.
 *
 * Part of `npm run test:integration`, which runs every suite against tests/fixtures/graph (#90).
 * The file stays in fixture-only/ because BR-0007 cites this path.
 *
 * Read-only. The page `block refs` (tests/fixtures/graph/pages/block refs.md) holds a ref to
 * `...00000000dead` and an embed of `...00000000beef`, which no block has. LogSeq 0.10 makes a
 * placeholder entity for each (no page, content `id:: <uuid>`), and the resolver must still call
 * them `missing`.
 */

const PAGE = 'block refs';
const DEAD = '0088f1a0-0000-4000-8000-00000000dead';
const BEEF = '0088f1a0-0000-4000-8000-00000000beef';
const REAL_TARGET = '0088f1a0-0000-4000-8000-000000000002';
/** The block whose content is a plain ref to REAL_TARGET */
const PLAIN_REF = '0088f1a0-0000-4000-8000-000000000003';

interface TreeBlock {
  uuid: string;
  content: string;
  children?: TreeBlock[];
  resolvedContent?: string;
  resolvedRefs?: ResolvedRef[];
}

const flatten = (blocks: TreeBlock[]): TreeBlock[] =>
  blocks.flatMap(block => [block, ...flatten(block.children ?? [])]);

describe('resolve_refs on missing targets in the fixture graph (#138)', () => {
  let client: LogseqClient;
  let blocks: TreeBlock[];
  let refBlock: TreeBlock;
  let embedBlock: TreeBlock;

  beforeAll(async () => {
    ({ client } = await connectFixture());

    const page = await getPage(client, PAGE, true, { resolveRefs: true });
    blocks = flatten((page.children ?? []) as unknown as TreeBlock[]);
    const holding = (uuid: string) => {
      const found = blocks.filter(block => block.content.includes(uuid));
      if (found.length !== 1) {
        throw new Error(`Expected one block on "${PAGE}" holding ${uuid}, found ${found.length}. Re-index the fixture graph.`);
      }
      return found[0];
    };
    refBlock = holding(`((${DEAD}))`);
    embedBlock = holding(`{{embed ((${BEEF}))}}`);
  });

  it('the fixture still has the placeholder rows this guards against', async () => {
    const { query, inputs } = DatalogQueryBuilder.refTargets({ blockUuids: [DEAD, BEEF] });
    const rows = ((await client.executeDatalogQuery<Array<[any]>>(query, ...inputs)) ?? []).map(row => row[0]);
    expect(rows.map(row => row.uuid).sort()).toEqual([BEEF, DEAD]);
    expect(rows.every(row => row.page === undefined && row.name === undefined)).toBe(true);
  });

  it('a ref to a missing block is missing and stays as written', () => {
    expect(refBlock.resolvedRefs).toEqual([{ uuid: DEAD, content: null, page: null, status: 'missing' }]);
    expect(refBlock.resolvedContent).toBe(refBlock.content);
  });

  it('an embed of a missing block is missing and stays as written', () => {
    expect(embedBlock.resolvedRefs).toEqual([
      { uuid: BEEF, embed: 'block', content: null, page: null, status: 'missing' }
    ]);
    expect(embedBlock.resolvedContent).toBe(embedBlock.content);
  });

  it('a real target on the same page still resolves ok', () => {
    const plainRef = blocks.find(block => block.uuid === PLAIN_REF);
    expect(plainRef?.resolvedRefs).toEqual([
      { uuid: REAL_TARGET, content: expect.any(String), page: PAGE, status: 'ok' }
    ]);
  });

  it('getBlock on the missing ref costs the fetch plus one Datalog query', async () => {
    const spy = vi.spyOn(client, 'callAPI');
    try {
      const block = await getBlock(client, refBlock.uuid, false, { resolveRefs: true });
      expect(block.resolvedRefs?.map(ref => ref.status)).toEqual(['missing']);
      expect(spy.mock.calls.length).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
