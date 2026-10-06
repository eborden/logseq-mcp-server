import { describe, it, expect } from 'vitest';
import { resolveBlockRefs, DEFAULT_REF_DEPTH } from './resolve-refs.js';
import { fakeRefGraph, uuidN } from '../../tests/helpers/ref-graph.js';
import { LogSeqTimeoutError } from '../errors.js';

const A = uuidN(1);
const B = uuidN(2);
const C = uuidN(3);
const D = uuidN(4);
const MISSING = uuidN(99);

const ref = (uuid: string) => `((${uuid}))`;

describe('resolveBlockRefs', () => {
  it('makes no call and returns the blocks as they were when nothing has a ref', async () => {
    const { client, executeDatalogQuery } = fakeRefGraph({ pages: ['Alpha'], blocks: [] });
    const blocks = [{ uuid: A, content: 'plain text', children: [{ uuid: B, content: 'also (( not a ref ))' }] }];
    const result = await resolveBlockRefs(client, blocks);
    expect(executeDatalogQuery).not.toHaveBeenCalled();
    expect(result.blocks).toBe(blocks);
    expect(result.warnings).toEqual([]);
  });

  it('resolves a single ref inline, keeps content, and reports the page', async () => {
    const { client, queries } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [{ uuid: B, content: 'the quoted text', page: 'Alpha' }]
    });
    const root = { uuid: A, content: `see ${ref(B)} for more` };
    const { blocks, warnings } = await resolveBlockRefs(client, [root]);

    expect(blocks[0].content).toBe(`see ${ref(B)} for more`);
    expect((blocks[0] as any).resolvedContent).toBe('see the quoted text for more');
    expect((blocks[0] as any).resolvedRefs).toEqual([
      { uuid: B, content: 'the quoted text', page: 'Alpha', status: 'ok' }
    ]);
    expect(warnings).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(root).toEqual({ uuid: A, content: `see ${ref(B)} for more` }); // input not mutated
  });

  it('strips the id:: property line from the resolved text only', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [{ uuid: B, content: `quoted\nid:: ${B}`, page: 'Alpha' }]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: `x ${ref(B)}` }]);
    expect((blocks[0] as any).resolvedContent).toBe('x quoted');
  });

  it('follows a chain A -> B -> C within the depth limit, one query per level', async () => {
    const { client, queries } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [
        { uuid: B, content: `b says ${ref(C)}`, page: 'Alpha' },
        { uuid: C, content: 'c text', page: 'Alpha' }
      ]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: ref(B) }], { maxDepth: 2 });
    expect((blocks[0] as any).resolvedContent).toBe('b says c text');
    const refs = (blocks[0] as any).resolvedRefs;
    expect(refs.map((r: any) => [r.uuid, r.status])).toEqual([[B, 'ok'], [C, 'ok']]);
    expect(refs[0].content).toBe('b says c text');
    expect(queries).toHaveLength(2);
  });

  it('cuts the chain off at the depth limit and leaves the deeper ref as written', async () => {
    const { client, queries } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [
        { uuid: B, content: `b ${ref(C)}`, page: 'Alpha' },
        { uuid: C, content: `c ${ref(D)}`, page: 'Alpha' },
        { uuid: D, content: 'd text', page: 'Alpha' }
      ]
    });
    const { blocks, warnings } = await resolveBlockRefs(client, [{ uuid: A, content: ref(B) }], { maxDepth: 2 });
    expect((blocks[0] as any).resolvedContent).toBe(`b c ${ref(D)}`);
    const statuses = Object.fromEntries((blocks[0] as any).resolvedRefs.map((r: any) => [r.uuid, r.status]));
    expect(statuses).toEqual({ [B]: 'ok', [C]: 'ok', [D]: 'depth_limit' });
    expect(queries).toHaveLength(2); // the depth limit is never fetched
    expect(warnings.map(w => w.code)).toEqual(['refs_depth_limit']);
    expect(warnings[0].howToFetchAll).toContain('logseq_get_block');
  });

  it('defaults to a depth of 2', async () => {
    expect(DEFAULT_REF_DEPTH).toBe(2);
    const { client, queries } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [
        { uuid: B, content: `b ${ref(C)}`, page: 'Alpha' },
        { uuid: C, content: `c ${ref(D)}`, page: 'Alpha' },
        { uuid: D, content: 'd text', page: 'Alpha' }
      ]
    });
    await resolveBlockRefs(client, [{ uuid: A, content: ref(B) }]);
    expect(queries).toHaveLength(2);
  });

  it('does no fetch at all with a depth of 0', async () => {
    const { client, executeDatalogQuery } = fakeRefGraph({ pages: ['Alpha'], blocks: [] });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: ref(B) }], { maxDepth: 0 });
    expect(executeDatalogQuery).not.toHaveBeenCalled();
    expect((blocks[0] as any).resolvedContent).toBe(ref(B));
    expect((blocks[0] as any).resolvedRefs[0].status).toBe('depth_limit');
  });

  it('detects a cycle A -> B -> A, leaves it as written and terminates', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [
        { uuid: A, content: `a ${ref(B)}`, page: 'Alpha' },
        { uuid: B, content: `b ${ref(A)}`, page: 'Alpha' }
      ]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: `a ${ref(B)}` }], { maxDepth: 5 });
    expect((blocks[0] as any).resolvedContent).toBe(`a b ${ref(A)}`);
    const statuses = Object.fromEntries((blocks[0] as any).resolvedRefs.map((r: any) => [r.uuid, r.status]));
    expect(statuses).toEqual({ [B]: 'ok', [A]: 'cycle' });
  });

  it('marks a block that refers to itself as a cycle', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [{ uuid: A, content: `me ${ref(A)}`, page: 'Alpha' }]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: `me ${ref(A)}` }]);
    expect((blocks[0] as any).resolvedRefs[0].status).toBe('cycle');
  });

  it('resolves two siblings that reference the same block (diamond), not just the first', async () => {
    const { client, queries } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [
        { uuid: B, content: `b ${ref(D)}`, page: 'Alpha' },
        { uuid: C, content: `c ${ref(D)}`, page: 'Alpha' },
        { uuid: D, content: 'shared', page: 'Alpha' }
      ]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: `${ref(B)} and ${ref(C)}` }], {
      maxDepth: 3
    });
    expect((blocks[0] as any).resolvedContent).toBe('b shared and c shared');
    const refs = (blocks[0] as any).resolvedRefs;
    expect(refs.filter((r: any) => r.uuid === D)).toHaveLength(1); // listed once
    expect(refs.every((r: any) => r.status === 'ok')).toBe(true);
    expect(queries).toHaveLength(2); // D is fetched once, at level 2
  });

  it('resolves the same block twice in one text', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [{ uuid: B, content: 'twice', page: 'Alpha' }]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: `${ref(B)} ${ref(B)}` }]);
    expect((blocks[0] as any).resolvedContent).toBe('twice twice');
  });

  it('marks a missing uuid and leaves it in place', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [{ uuid: B, content: 'here', page: 'Alpha' }]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: `${ref(MISSING)} then ${ref(B)}` }]);
    expect((blocks[0] as any).resolvedContent).toBe(`${ref(MISSING)} then here`);
    expect((blocks[0] as any).resolvedRefs).toEqual([
      { uuid: MISSING, content: null, page: null, status: 'missing' },
      { uuid: B, content: 'here', page: 'Alpha', status: 'ok' }
    ]);
  });

  it('does not fetch a missing uuid again at the next level', async () => {
    const { client, queries } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [{ uuid: B, content: `b ${ref(MISSING)}`, page: 'Alpha' }]
    });
    await resolveBlockRefs(client, [
      { uuid: A, content: `${ref(MISSING)} ${ref(B)}` }
    ]);
    expect(queries).toHaveLength(1); // level 2 has nothing new to ask for
    expect(queries[0].split(MISSING)).toHaveLength(2); // asked for once
  });

  it('ignores malformed uuids and never puts them in a query', async () => {
    const { client, executeDatalogQuery } = fakeRefGraph({ pages: ['Alpha'], blocks: [] });
    const content = [
      '((not-a-uuid))',
      '((00000000-0000-4000-8000-00000000000g))',
      '((00000000-0000-4000-8000-000000000001)',
      '(( 00000000-0000-4000-8000-000000000001 ))',
      '((00000000-0000-4000-8000-000000000001"]) #uuid "x))',
      '{{embed ((nope))}}'
    ].join('\n');
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content }]);
    expect(executeDatalogQuery).not.toHaveBeenCalled();
    expect((blocks[0] as any).resolvedContent).toBeUndefined();
  });

  it('only annotates blocks that hold a ref, and walks children', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [{ uuid: B, content: 'quoted', page: 'Alpha' }]
    });
    const tree = [
      {
        uuid: A,
        content: 'parent, no ref',
        children: [{ uuid: C, content: `child ${ref(B)}`, children: [] as any[] }]
      }
    ];
    const { blocks } = await resolveBlockRefs(client, tree);
    expect((blocks[0] as any).resolvedContent).toBeUndefined();
    expect((blocks[0].children![0] as any).resolvedContent).toBe('child quoted');
  });

  it('batches refs from many blocks into one query per level', async () => {
    const { client, queries } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [
        { uuid: B, content: 'b', page: 'Alpha' },
        { uuid: C, content: 'c', page: 'Alpha' },
        { uuid: D, content: 'd', page: 'Alpha' }
      ]
    });
    await resolveBlockRefs(client, [
      { uuid: uuidN(10), content: ref(B) },
      { uuid: uuidN(11), content: ref(C), children: [{ uuid: uuidN(12), content: ref(D) }] }
    ]);
    expect(queries).toHaveLength(1);
    for (const u of [B, C, D]) expect(queries[0]).toContain(u);
  });

  it('is case-insensitive about uuids', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [{ uuid: B, content: 'quoted', page: 'Alpha' }]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: ref(B.toUpperCase()) }]);
    expect((blocks[0] as any).resolvedContent).toBe('quoted');
  });

  it('propagates infrastructure errors instead of returning unresolved blocks', async () => {
    const { client, executeDatalogQuery } = fakeRefGraph({ pages: ['Alpha'], blocks: [] });
    executeDatalogQuery.mockRejectedValueOnce(new LogSeqTimeoutError('http://localhost:12315', 100));
    await expect(resolveBlockRefs(client, [{ uuid: A, content: ref(B) }])).rejects.toBeInstanceOf(
      LogSeqTimeoutError
    );
  });

  it('rejects an invalid depth or embed limit', async () => {
    const { client } = fakeRefGraph({ pages: [], blocks: [] });
    await expect(resolveBlockRefs(client, [], { maxDepth: -1 })).rejects.toThrow(/Invalid ref depth/);
    await expect(resolveBlockRefs(client, [], { maxDepth: 1.5 })).rejects.toThrow(/Invalid ref depth/);
    await expect(resolveBlockRefs(client, [], { embedLimit: 0 })).rejects.toThrow(/Invalid embed limit/);
  });
});

describe('resolveBlockRefs: embeds', () => {
  const embedBlock = (uuid: string) => `{{embed ((${uuid}))}}`;
  const embedPage = (name: string) => `{{embed [[${name}]]}}`;

  it('embeds a block with its children, indented, in order', async () => {
    const { client, queries } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [
        { uuid: B, content: 'root', page: 'Alpha' },
        { uuid: C, content: 'first child', page: 'Alpha', parent: B },
        { uuid: D, content: 'grandchild', page: 'Alpha', parent: C },
        { uuid: uuidN(5), content: 'second child', page: 'Alpha', parent: B }
      ]
    });
    const { blocks, warnings } = await resolveBlockRefs(client, [{ uuid: A, content: embedBlock(B) }]);
    expect((blocks[0] as any).resolvedContent).toBe(
      ['root', '  - first child', '    - grandchild', '  - second child'].join('\n')
    );
    expect((blocks[0] as any).resolvedRefs).toEqual([
      expect.objectContaining({ uuid: B, embed: 'block', page: 'Alpha', status: 'ok' })
    ]);
    expect(warnings).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('?ru');
  });

  it('caps a block embed and warns with a way to fetch the rest', async () => {
    const children = Array.from({ length: 5 }, (_, i) => ({
      uuid: uuidN(20 + i),
      content: `child ${i}`,
      page: 'Alpha',
      parent: B
    }));
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [{ uuid: B, content: 'root', page: 'Alpha' }, ...children]
    });
    const { blocks, warnings } = await resolveBlockRefs(client, [{ uuid: A, content: embedBlock(B) }], {
      embedLimit: 3
    });
    expect((blocks[0] as any).resolvedContent).toBe(
      ['root', '  - child 0', '  - child 1', '[... 3 more blocks not shown]'].join('\n')
    );
    expect(warnings).toEqual([
      {
        code: 'embed_truncated',
        message: `Embed of block ${B} shows 3 of 6 blocks.`,
        howToFetchAll: `Call logseq_get_block with block_uuid "${B}" and include_children true.`
      }
    ]);
  });

  it('embeds a page as its top-level blocks only, case-insensitively', async () => {
    const { client, queries, executeDatalogQuery } = fakeRefGraph({
      pages: ['My Page'],
      blocks: [
        { uuid: B, content: 'top one', page: 'My Page' },
        { uuid: C, content: 'nested', page: 'My Page', parent: B },
        { uuid: D, content: 'top two', page: 'My Page' }
      ]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: embedPage('my PAGE') }]);
    expect((blocks[0] as any).resolvedContent).toBe('- top one\n- top two');
    expect((blocks[0] as any).resolvedRefs).toEqual([
      { embed: 'page', content: '- top one\n- top two', page: 'My Page', status: 'ok' }
    ]);
    expect(queries).toHaveLength(1);
    expect(executeDatalogQuery.mock.calls[0].slice(1)).toEqual([['my page']]);
  });

  it('caps a page embed and warns', async () => {
    const tops = Array.from({ length: 4 }, (_, i) => ({
      uuid: uuidN(30 + i),
      content: `top ${i}`,
      page: 'Alpha'
    }));
    const { client } = fakeRefGraph({ pages: ['Alpha'], blocks: tops });
    const { blocks, warnings } = await resolveBlockRefs(client, [{ uuid: A, content: embedPage('Alpha') }], {
      embedLimit: 2
    });
    expect((blocks[0] as any).resolvedContent).toBe('- top 0\n- top 1\n[... 2 more top-level blocks not shown]');
    expect(warnings).toEqual([
      {
        code: 'embed_truncated',
        message: 'Embed of page "Alpha" shows 2 of 4 top-level blocks.',
        howToFetchAll: 'Call logseq_get_page with page_name "Alpha" and include_children true.'
      }
    ]);
  });

  it('marks an embed of a page that does not exist as missing and leaves it', async () => {
    const { client } = fakeRefGraph({ pages: ['Alpha'], blocks: [] });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: embedPage('Nowhere') }]);
    expect((blocks[0] as any).resolvedContent).toBe(embedPage('Nowhere'));
    expect((blocks[0] as any).resolvedRefs).toEqual([
      { embed: 'page', content: null, page: 'Nowhere', status: 'missing' }
    ]);
  });

  it('marks an embed of a deleted block as missing', async () => {
    const { client } = fakeRefGraph({ pages: ['Alpha'], blocks: [] });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: embedBlock(MISSING) }]);
    expect((blocks[0] as any).resolvedContent).toBe(embedBlock(MISSING));
    expect((blocks[0] as any).resolvedRefs[0]).toMatchObject({ uuid: MISSING, embed: 'block', status: 'missing' });
  });

  it('resolves refs inside embedded children at the next level', async () => {
    const { client, queries } = fakeRefGraph({
      pages: ['Alpha', 'Beta'],
      blocks: [
        { uuid: B, content: 'root', page: 'Alpha' },
        { uuid: C, content: `child ${ref(D)}`, page: 'Alpha', parent: B },
        { uuid: D, content: 'deep', page: 'Beta' }
      ]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: embedBlock(B) }]);
    expect((blocks[0] as any).resolvedContent).toBe('root\n  - child deep');
    expect(queries).toHaveLength(2);
  });

  it('detects a page that embeds itself', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [{ uuid: B, content: embedPage('Alpha'), page: 'Alpha' }]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: embedPage('Alpha') }], {
      maxDepth: 4
    });
    const refs = (blocks[0] as any).resolvedRefs;
    expect(refs.map((r: any) => r.status)).toEqual(['ok', 'cycle']);
    expect((blocks[0] as any).resolvedContent).toBe(`- ${embedPage('Alpha')}`);
  });

  it('fetches the children of a block that was first seen as a plain ref and later embedded', async () => {
    const { client, queries } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [
        { uuid: B, content: `b ${embedBlock(C)}`, page: 'Alpha' },
        { uuid: C, content: 'c root', page: 'Alpha' },
        { uuid: D, content: 'c child', page: 'Alpha', parent: C }
      ]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: `${ref(C)} ${ref(B)}` }]);
    expect((blocks[0] as any).resolvedContent).toBe('c root b c root\n  - c child');
    expect(queries).toHaveLength(2);
  });
});

// LogSeq 0.10 makes a placeholder entity for a uuid no block has: no page, content `id:: <uuid>` (#138)
describe('resolveBlockRefs with placeholder rows for missing uuids', () => {
  const PLACEHOLDER = uuidN(98);
  const embedBlock = (uuid: string) => `{{embed ((${uuid}))}}`;

  it('marks a ref whose target is a placeholder as missing and leaves it in place', async () => {
    const { client, queries } = fakeRefGraph({ pages: ['Alpha'], blocks: [], placeholders: [PLACEHOLDER] });
    const { blocks, warnings } = await resolveBlockRefs(client, [{ uuid: A, content: `see ${ref(PLACEHOLDER)}` }]);
    expect((blocks[0] as any).content).toBe(`see ${ref(PLACEHOLDER)}`);
    expect((blocks[0] as any).resolvedContent).toBe(`see ${ref(PLACEHOLDER)}`);
    expect((blocks[0] as any).resolvedRefs).toEqual([
      { uuid: PLACEHOLDER, content: null, page: null, status: 'missing' }
    ]);
    expect(warnings).toEqual([]);
    expect(queries).toHaveLength(1);
  });

  it('marks a block embed of a placeholder as missing and leaves it in place', async () => {
    const { client, queries } = fakeRefGraph({ pages: ['Alpha'], blocks: [], placeholders: [PLACEHOLDER] });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: embedBlock(PLACEHOLDER) }]);
    expect((blocks[0] as any).resolvedContent).toBe(embedBlock(PLACEHOLDER));
    expect((blocks[0] as any).resolvedRefs).toEqual([
      { uuid: PLACEHOLDER, embed: 'block', content: null, page: null, status: 'missing' }
    ]);
    expect(queries).toHaveLength(1);
  });

  it('still resolves a real block whose content is only its id:: line', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [{ uuid: B, content: `id:: ${B}`, page: 'Alpha' }]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: `x ${ref(B)}` }]);
    expect((blocks[0] as any).resolvedRefs).toEqual([{ uuid: B, content: '', page: 'Alpha', status: 'ok' }]);
  });

  it('keeps a ref to a page entity ok, with the page name as its text', async () => {
    // A page has a uuid but no :block/page, like a placeholder; its name is what tells them apart
    const PAGE_UUID = uuidN(97);
    const { client, queries } = fakeRefGraph({
      pages: ['My Page'],
      blocks: [],
      pageUuids: { 'My Page': PAGE_UUID },
      placeholders: [PLACEHOLDER]
    });
    const { blocks } = await resolveBlockRefs(client, [
      { uuid: A, content: `see ${ref(PAGE_UUID)} and ${ref(PLACEHOLDER)}` }
    ]);
    expect((blocks[0] as any).resolvedContent).toBe(`see My Page and ${ref(PLACEHOLDER)}`);
    expect((blocks[0] as any).resolvedRefs).toEqual([
      { uuid: PAGE_UUID, content: 'My Page', page: 'My Page', status: 'ok' },
      { uuid: PLACEHOLDER, content: null, page: null, status: 'missing' }
    ]);
    expect(queries).toHaveLength(1);
  });

  it('keeps real targets ok next to a placeholder, and other statuses unchanged', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [
        { uuid: B, content: `b ${ref(C)}`, page: 'Alpha' },
        { uuid: C, content: `c ${ref(D)}`, page: 'Alpha' },
        { uuid: D, content: 'd', page: 'Alpha' }
      ],
      placeholders: [PLACEHOLDER]
    });
    const { blocks } = await resolveBlockRefs(client, [
      { uuid: A, content: `${ref(PLACEHOLDER)} ${ref(B)} ${ref(A)}` }
    ]);
    const statuses = (blocks[0] as any).resolvedRefs.map((r: any) => [r.uuid, r.status]);
    expect(statuses).toEqual([
      [PLACEHOLDER, 'missing'],
      [B, 'ok'],
      [C, 'ok'],
      [D, 'depth_limit'],
      [A, 'cycle']
    ]);
    expect((blocks[0] as any).resolvedContent).toBe(`${ref(PLACEHOLDER)} b c ${ref(D)} ${ref(A)}`);
  });

  it('makes the same calls as a uuid with no row at all', async () => {
    const run = async (placeholders: string[]) => {
      const { client, queries } = fakeRefGraph({
        pages: ['Alpha'],
        blocks: [{ uuid: B, content: `b ${ref(PLACEHOLDER)} ${embedBlock(PLACEHOLDER)}`, page: 'Alpha' }],
        placeholders
      });
      const { blocks } = await resolveBlockRefs(client, [
        { uuid: A, content: `${ref(PLACEHOLDER)} ${ref(B)} ${embedBlock(PLACEHOLDER)}` }
      ]);
      return { queries, refs: (blocks[0] as any).resolvedRefs };
    };
    const withPlaceholder = await run([PLACEHOLDER]);
    const withoutRow = await run([]);
    expect(withPlaceholder.queries).toEqual(withoutRow.queries);
    expect(withPlaceholder.queries).toHaveLength(1); // level 2 asks for nothing new
    expect(withPlaceholder.refs).toEqual(withoutRow.refs);
    expect(withPlaceholder.refs.filter((r: any) => r.uuid === PLACEHOLDER).map((r: any) => r.status)).toEqual([
      'missing',
      'missing'
    ]);
  });
});
