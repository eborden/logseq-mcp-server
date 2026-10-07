import { describe, it, expect, vi } from 'vitest';
import { resolveBlockRefs } from './resolve-refs.js';
import { fakeRefGraph, uuidN } from '../../tests/helpers/ref-graph.js';
import { EMBED_DESCENDANT_LEVELS } from '../datalog/queries.js';
import type { LogseqClient } from '../client.js';

// Detail tests for resolve-refs.ts (#206): uuid casing, id:: stripping, nesting depth, embed caps,
// cache reuse between levels and the shapes of the rows LogSeq may answer with.
// uuidN makes digit-only uuids, which hide casing bugs, so these use a uuid with hex letters.
const hexUuid = (n: number) => `abcdefab-cdef-4abc-8def-${String(n).padStart(12, 'a')}`;

const A = uuidN(1);
const B = uuidN(2);
const C = uuidN(3);
const D = uuidN(4);
const E = uuidN(5);
const F = uuidN(6);
const MISSING = uuidN(99);

const ref = (uuid: string) => `((${uuid}))`;
const embedBlock = (uuid: string) => `{{embed ((${uuid}))}}`;
const embedPage = (name: string) => `{{embed [[${name}]]}}`;

interface Annotated {
  content?: string;
  resolvedContent?: string;
  resolvedRefs?: Array<Record<string, unknown>>;
}
const annotated = (block: unknown) => block as Annotated;

/** A client that answers every query with these rows, one per result row, as a pull of one entity does. */
function rawClient(rows: unknown[]) {
  const executeDatalogQuery = vi.fn(async () => rows.map(row => [row]));
  const client = { executeDatalogQuery, callAPI: vi.fn() } as unknown as LogseqClient;
  return { client, executeDatalogQuery };
}

const alphaPage = { id: 1000, name: 'alpha', 'original-name': 'Alpha' };

describe('resolveBlockRefs: uuid casing', () => {
  it('resolves a ref written in upper case to the lower-case block', async () => {
    const target = hexUuid(2);
    expect(target).not.toBe(target.toUpperCase()); // the casing is observable
    const { client } = fakeRefGraph({ pages: ['Alpha'], blocks: [{ uuid: target, content: 'quoted', page: 'Alpha' }] });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: `see ${ref(target.toUpperCase())}` }]);
    expect(annotated(blocks[0]).resolvedContent).toBe('see quoted');
    expect(annotated(blocks[0]).resolvedRefs).toEqual([{ uuid: target, content: 'quoted', page: 'Alpha', status: 'ok' }]);
  });

  it('resolves a block embed written in upper case to the lower-case block', async () => {
    const target = hexUuid(2);
    const { client } = fakeRefGraph({ pages: ['Alpha'], blocks: [{ uuid: target, content: 'quoted', page: 'Alpha' }] });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: embedBlock(target.toUpperCase()) }]);
    expect(annotated(blocks[0]).resolvedContent).toBe('quoted');
    expect(annotated(blocks[0]).resolvedRefs).toEqual([
      { uuid: target, embed: 'block', content: 'quoted', page: 'Alpha', status: 'ok' }
    ]);
  });

  it('finds a cycle back to the root block whichever case the root uuid is in', async () => {
    const root = hexUuid(1);
    const run = async (rootUuid: string) => {
      const { client } = fakeRefGraph({
        pages: ['Alpha'],
        blocks: [{ uuid: root, content: `me ${ref(root)}`, page: 'Alpha' }]
      });
      const { blocks } = await resolveBlockRefs(client, [{ uuid: rootUuid, content: `me ${ref(root)}` }]);
      return annotated(blocks[0]);
    };
    for (const rootUuid of [root, root.toUpperCase()]) {
      const result = await run(rootUuid);
      expect(result.resolvedRefs).toEqual([{ uuid: root, content: null, page: 'Alpha', status: 'cycle' }]);
      expect(result.resolvedContent).toBe(`me ${ref(root)}`);
    }
  });
});

describe('resolveBlockRefs: the id:: line', () => {
  it('strips the id:: line wherever it sits, with any spacing and line ending, and only at the start of a line', async () => {
    const cases: Array<[string, string]> = [
      [`quoted\nid:: ${B}`, 'quoted'],
      [`quoted\nid::${B}`, 'quoted'], // no space after the colons
      [`quoted\nid::   ${B}`, 'quoted'],
      [`quoted\nid:: ${B}   `, 'quoted'], // trailing spaces
      [`id:: ${B}\nquoted`, 'quoted'], // first line, followed by text
      [`id:: ${B}\r\nquoted`, 'quoted'], // CRLF
      [`quoted\nid:: ${B}\nmore`, 'quoted\nmore'], // in the middle
      [`foo id:: ${B}`, `foo id:: ${B}`] // not at the start of a line: it is text
    ];
    for (const [content, expected] of cases) {
      const { client } = fakeRefGraph({ pages: ['Alpha'], blocks: [{ uuid: C, content, page: 'Alpha' }] });
      const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: ref(C) }]);
      expect(annotated(blocks[0]).resolvedContent, JSON.stringify(content)).toBe(expected);
    }
  });
});

describe('resolveBlockRefs: page embeds', () => {
  it('resolves refs held by the top-level blocks of an embedded page, one level further', async () => {
    const { client, queries } = fakeRefGraph({
      pages: ['Alpha', 'Beta'],
      blocks: [
        { uuid: B, content: `top ${ref(C)}`, page: 'Alpha' },
        { uuid: C, content: 'deep', page: 'Beta' }
      ]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: embedPage('Alpha') }]);
    expect(annotated(blocks[0]).resolvedContent).toBe('- top deep');
    expect(queries).toHaveLength(2);
  });

  it('does not look up the refs of page blocks that the embed cap hides', async () => {
    const tops = Array.from({ length: 4 }, (_, i) => ({
      uuid: uuidN(20 + i),
      content: i === 3 ? `hidden ${ref(D)}` : `top ${i}`,
      page: 'Alpha'
    }));
    const { client, queries } = fakeRefGraph({
      pages: ['Alpha', 'Beta'],
      blocks: [...tops, { uuid: D, content: 'never asked for', page: 'Beta' }]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: embedPage('Alpha') }], { embedLimit: 2 });
    expect(annotated(blocks[0]).resolvedContent).toBe('- top 0\n- top 1\n[... 2 more top-level blocks not shown]');
    expect(queries).toHaveLength(1);
    expect(queries.join('\n')).not.toContain(D);
  });

  it('does not look up the refs of embedded descendants that the embed cap hides', async () => {
    const children = Array.from({ length: 5 }, (_, i) => ({
      uuid: uuidN(20 + i),
      content: i === 4 ? `hidden ${ref(D)}` : `child ${i}`,
      page: 'Alpha',
      parent: B
    }));
    const { client, queries } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [
        { uuid: B, content: 'root', page: 'Alpha' },
        ...children,
        { uuid: D, content: 'never asked for', page: 'Alpha' }
      ]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: embedBlock(B) }], { embedLimit: 3 });
    expect(annotated(blocks[0]).resolvedContent).toBe(
      ['root', '  - child 0', '  - child 1', '[... 3 more blocks not shown]'].join('\n')
    );
    expect(queries).toHaveLength(1);
    expect(queries.join('\n')).not.toContain(D);
  });

  it('accepts an embed limit of 1', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [
        { uuid: B, content: 'root', page: 'Alpha' },
        { uuid: C, content: 'child', page: 'Alpha', parent: B }
      ]
    });
    const { blocks, warnings } = await resolveBlockRefs(client, [{ uuid: A, content: embedBlock(B) }], {
      embedLimit: 1
    });
    expect(annotated(blocks[0]).resolvedContent).toBe('root\n[... 1 more blocks not shown]');
    expect(warnings.map(w => w.message)).toEqual([`Embed of block ${B} shows 1 of 2 blocks.`]);
  });

  it('embeds a page that has no blocks as an empty ok result', async () => {
    const { client } = fakeRefGraph({ pages: ['Empty'], blocks: [] });
    const { blocks, warnings } = await resolveBlockRefs(client, [{ uuid: A, content: embedPage('Empty') }]);
    expect(annotated(blocks[0]).resolvedContent).toBe('');
    expect(annotated(blocks[0]).resolvedRefs).toEqual([{ embed: 'page', content: '', page: 'Empty', status: 'ok' }]);
    expect(warnings).toEqual([]);
  });

  it('reads a padded page name as the trimmed name, found or missing', async () => {
    const { client, executeDatalogQuery } = fakeRefGraph({
      pages: ['My Page'],
      blocks: [{ uuid: B, content: 'top one', page: 'My Page' }]
    });
    const found = await resolveBlockRefs(client, [{ uuid: A, content: embedPage('  My Page  ') }]);
    expect(annotated(found.blocks[0]).resolvedContent).toBe('- top one');
    expect(executeDatalogQuery.mock.calls[0].slice(1)).toEqual([['my page']]);

    const missing = await resolveBlockRefs(client, [{ uuid: A, content: embedPage('  Nowhere  ') }]);
    expect(annotated(missing.blocks[0]).resolvedRefs).toEqual([
      { embed: 'page', content: null, page: 'Nowhere', status: 'missing' }
    ]);
  });

  it('takes the embedded page from the rows by name, among block and page rows of other refs', async () => {
    const PAGE_ONE_UUID = uuidN(97);
    const { client } = fakeRefGraph({
      pages: ['Page One', 'Page Two'],
      pageUuids: { 'Page One': PAGE_ONE_UUID },
      blocks: [
        { uuid: B, content: 'a block', page: 'Page One' },
        { uuid: C, content: 'two top', page: 'Page Two' }
      ]
    });
    // The level asks for a block, a page entity (by uuid) and the page to embed; the rows hold all of them
    const { blocks } = await resolveBlockRefs(client, [
      { uuid: A, content: `${ref(B)} ${ref(PAGE_ONE_UUID)} ${embedPage('Page Two')}` }
    ]);
    expect(annotated(blocks[0]).resolvedContent).toBe('a block Page One - two top');
    expect(annotated(blocks[0]).resolvedRefs).toEqual([
      { uuid: B, content: 'a block', page: 'Page One', status: 'ok' },
      { uuid: PAGE_ONE_UUID, content: 'Page One', page: 'Page One', status: 'ok' },
      { embed: 'page', content: '- two top', page: 'Page Two', status: 'ok' }
    ]);
  });

  it('expands a page embedded inside another page embed', async () => {
    const { client } = fakeRefGraph({
      pages: ['Outer', 'Inner'],
      blocks: [
        { uuid: B, content: embedPage('Inner'), page: 'Outer' },
        { uuid: C, content: 'inner top', page: 'Inner' }
      ]
    });
    const nested = await resolveBlockRefs(client, [{ uuid: A, content: embedPage('Outer') }]);
    expect(annotated(nested.blocks[0]).resolvedContent).toBe('- - inner top');
    expect((annotated(nested.blocks[0]).resolvedRefs ?? []).map(r => [r.page, r.status])).toEqual([
      ['Outer', 'ok'],
      ['Inner', 'ok']
    ]);
  });

  it('marks a self-embedding page a cycle named as written, and fetches the page once', async () => {
    const { client, queries } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [{ uuid: D, content: embedPage('alpha'), page: 'Alpha' }] // written in lower case
    });
    const cycle = await resolveBlockRefs(client, [{ uuid: A, content: embedPage('Alpha') }], { maxDepth: 4 });
    expect(annotated(cycle.blocks[0]).resolvedRefs).toEqual([
      { embed: 'page', content: `- ${embedPage('alpha')}`, page: 'Alpha', status: 'ok' }, // the stored name
      { embed: 'page', content: null, page: 'alpha', status: 'cycle' } // the name as written
    ]);
    // The same page is never asked for again at a deeper level
    expect(queries).toHaveLength(1);
  });
});

describe('resolveBlockRefs: embedded trees', () => {
  it('shows an embedded block at most EMBED_DESCENDANT_LEVELS levels down, though the answer holds deeper blocks', async () => {
    expect(EMBED_DESCENDANT_LEVELS).toBe(3); // the fake graph answers three levels, as the real query does
    const [X, c1, c2, c3, c4, c5, c6] = [10, 11, 12, 13, 14, 15, 16].map(uuidN);
    // c3 sits at the bottom of X's tree and is embedded too, so the answer also holds its own descendants
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [
        { uuid: X, content: 'x', page: 'Alpha' },
        { uuid: c1, content: 'c1', page: 'Alpha', parent: X },
        { uuid: c2, content: 'c2', page: 'Alpha', parent: c1 },
        { uuid: c3, content: 'c3', page: 'Alpha', parent: c2 },
        { uuid: c4, content: 'c4', page: 'Alpha', parent: c3 },
        { uuid: c5, content: 'c5', page: 'Alpha', parent: c4 },
        { uuid: c6, content: 'c6', page: 'Alpha', parent: c5 }
      ]
    });
    const { blocks } = await resolveBlockRefs(client, [
      { uuid: A, content: `${embedBlock(X)}\n${embedBlock(c3)}` }
    ]);
    expect(annotated(blocks[0]).resolvedContent).toBe(
      [
        'x', '  - c1', '    - c2', '      - c3',
        'c3', '  - c4', '    - c5', '      - c6'
      ].join('\n')
    );
  });

  it('reads an embedded block as an ok ref next to a plain ref of the same block', async () => {
    const { client } = fakeRefGraph({ pages: ['Alpha'], blocks: [{ uuid: B, content: 'b', page: 'Alpha' }] });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: `${ref(B)} ${embedBlock(B)}` }]);
    expect(annotated(blocks[0]).resolvedRefs).toEqual([
      { uuid: B, content: 'b', page: 'Alpha', status: 'ok' },
      { uuid: B, embed: 'block', content: 'b', page: 'Alpha', status: 'ok' }
    ]);
  });

  it('lists one warning per truncated embed, and one for an embed that appears twice', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [
        { uuid: B, content: 'b root', page: 'Alpha' },
        { uuid: uuidN(20), content: 'b child', page: 'Alpha', parent: B },
        { uuid: C, content: 'c root', page: 'Alpha' },
        { uuid: uuidN(21), content: 'c child', page: 'Alpha', parent: C }
      ]
    });
    const { warnings } = await resolveBlockRefs(
      client,
      [{ uuid: A, content: `${embedBlock(B)} ${embedBlock(C)} ${embedBlock(B)}` }],
      { embedLimit: 1 }
    );
    expect(warnings.map(w => [w.code, w.message])).toEqual([
      ['embed_truncated', `Embed of block ${B} shows 1 of 2 blocks.`],
      ['embed_truncated', `Embed of block ${C} shows 1 of 2 blocks.`]
    ]);
  });
});

describe('resolveBlockRefs: the depth limit', () => {
  // D is fetched at level 1 (the root names it). Reached again three levels down it is still past
  // the limit of 2, though its row is in hand.
  it('leaves a ref at the depth limit as written even when an earlier level already fetched it', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [
        { uuid: B, content: `b ${ref(C)}`, page: 'Alpha' },
        { uuid: C, content: `c ${ref(D)}`, page: 'Alpha' },
        { uuid: D, content: 'd text', page: 'Alpha' }
      ]
    });
    const { blocks, warnings } = await resolveBlockRefs(client, [{ uuid: A, content: `${ref(D)} ${ref(B)}` }]);
    expect(annotated(blocks[0]).resolvedContent).toBe(`d text b c ${ref(D)}`);
    expect((annotated(blocks[0]).resolvedRefs ?? []).map(r => [r.uuid, r.status])).toEqual([
      [D, 'ok'],
      [B, 'ok'],
      [C, 'ok'],
      [D, 'depth_limit']
    ]);
    expect(warnings.map(w => w.code)).toEqual(['refs_depth_limit']);
  });

  it('counts a block embed as one level, for the members it shows', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [
        { uuid: E, content: 'e root', page: 'Alpha' },
        { uuid: F, content: `f ${ref(C)}`, page: 'Alpha', parent: E },
        { uuid: C, content: `c ${ref(D)}`, page: 'Alpha' },
        { uuid: D, content: 'd text', page: 'Alpha' }
      ]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: `${ref(D)} ${embedBlock(E)}` }]);
    expect(annotated(blocks[0]).resolvedContent).toBe(`d text e root\n  - f c ${ref(D)}`);
    expect((annotated(blocks[0]).resolvedRefs ?? []).map(r => [r.uuid, r.status])).toEqual([
      [D, 'ok'],
      [E, 'ok'],
      [C, 'ok'],
      [D, 'depth_limit']
    ]);
  });

  it('counts a page embed as one level, for the blocks it shows', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha', 'Beta'],
      blocks: [
        { uuid: B, content: `top ${ref(C)}`, page: 'Alpha' },
        { uuid: C, content: `c ${ref(D)}`, page: 'Beta' },
        { uuid: D, content: 'd text', page: 'Beta' }
      ]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: `${ref(D)} ${embedPage('Alpha')}` }]);
    expect(annotated(blocks[0]).resolvedContent).toBe(`d text - top c ${ref(D)}`);
    expect((annotated(blocks[0]).resolvedRefs ?? []).map(r => [r.uuid ?? r.embed, r.status])).toEqual([
      [D, 'ok'],
      ['page', 'ok'],
      [C, 'ok'],
      [D, 'depth_limit']
    ]);
  });

  it('says how many distinct refs were left and how to fetch them', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [{ uuid: B, content: `b ${ref(C)} ${ref(D)} ${ref(C)}`, page: 'Alpha' }]
    });
    const { warnings } = await resolveBlockRefs(client, [{ uuid: A, content: ref(B) }], { maxDepth: 1 });
    expect(warnings).toEqual([
      {
        code: 'refs_depth_limit',
        message: '2 reference(s) were not followed because they are more than 1 levels deep. They are left as written.',
        howToFetchAll:
          'Fetch each ref whose status is "depth_limit" with logseq_get_block (its uuid) or logseq_get_page (its page).'
      }
    ]);
  });
});

describe('resolveBlockRefs: cycles', () => {
  it('names the page of a block that refers back to itself', async () => {
    const { client } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [{ uuid: A, content: `me ${ref(A)}`, page: 'Alpha' }]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: `me ${ref(A)}` }]);
    expect(annotated(blocks[0]).resolvedRefs).toEqual([{ uuid: A, content: null, page: 'Alpha', status: 'cycle' }]);
  });
});

describe('resolveBlockRefs: what is fetched at each level', () => {
  it('does not ask again for a block that a ref found missing and a later embed names', async () => {
    const { client, queries } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [{ uuid: B, content: `b ${embedBlock(MISSING)}`, page: 'Alpha' }]
    });
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: `${ref(MISSING)} ${ref(B)}` }]);
    expect(queries).toHaveLength(1);
    expect((annotated(blocks[0]).resolvedRefs ?? []).map(r => [r.uuid, r.embed, r.status])).toEqual([
      [MISSING, undefined, 'missing'],
      [B, undefined, 'ok'],
      [MISSING, 'block', 'missing']
    ]);
  });

  it('does not ask again for a block that an embed already fetched and a later ref names', async () => {
    const { client, queries } = fakeRefGraph({
      pages: ['Alpha'],
      blocks: [
        { uuid: C, content: 'c text', page: 'Alpha' },
        { uuid: B, content: 'b root', page: 'Alpha' },
        { uuid: F, content: `f ${ref(C)}`, page: 'Alpha', parent: B }
      ]
    });
    const { blocks } = await resolveBlockRefs(client, [
      { uuid: A, content: `${embedBlock(C)} ${embedBlock(B)}` }
    ]);
    expect(annotated(blocks[0]).resolvedContent).toBe('c text b root\n  - f c text');
    expect(queries).toHaveLength(1);
  });
});

describe('resolveBlockRefs: blocks without content', () => {
  it('leaves a block with no content alone and resolves the refs of its children', async () => {
    const { client } = fakeRefGraph({ pages: ['Alpha'], blocks: [{ uuid: B, content: 'quoted', page: 'Alpha' }] });
    const tree = [{ uuid: A, children: [{ uuid: C, content: `child ${ref(B)}` }] }];
    const { blocks } = await resolveBlockRefs(client, tree);
    expect('resolvedContent' in blocks[0]).toBe(false);
    expect('resolvedRefs' in blocks[0]).toBe(false);
    expect(annotated(blocks[0].children![0]).resolvedContent).toBe('child quoted');
  });
});

describe('resolveBlockRefs: rows as LogSeq may answer them', () => {
  const blockRow = (uuid: string, extra: Record<string, unknown> = {}) => ({
    id: 1,
    uuid,
    content: 'quoted',
    page: alphaPage,
    ...extra
  });

  it('skips a null row in the answer', async () => {
    const { client } = rawClient([null, blockRow(B)]);
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: ref(B) }]);
    expect(annotated(blocks[0]).resolvedRefs).toEqual([{ uuid: B, content: 'quoted', page: 'Alpha', status: 'ok' }]);
  });

  it('skips a row with no uuid', async () => {
    const { client } = rawClient([{ id: 9, name: 'stray', 'original-name': 'Stray' }, blockRow(B)]);
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: ref(B) }]);
    expect(annotated(blocks[0]).resolvedRefs).toEqual([{ uuid: B, content: 'quoted', page: 'Alpha', status: 'ok' }]);
  });

  it('reads a block with no content as empty text', async () => {
    const { client } = rawClient([{ id: 1, uuid: B, page: alphaPage }]);
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: `see ${ref(B)}` }]);
    expect(annotated(blocks[0]).resolvedContent).toBe('see ');
    expect(annotated(blocks[0]).resolvedRefs).toEqual([{ uuid: B, content: '', page: 'Alpha', status: 'ok' }]);
  });

  it('reports no page for a block whose page has no name', async () => {
    const { client } = rawClient([blockRow(B, { page: { id: 1000 } })]);
    const { blocks } = await resolveBlockRefs(client, [{ uuid: A, content: ref(B) }]);
    expect(annotated(blocks[0]).resolvedRefs).toEqual([{ uuid: B, content: 'quoted', page: null, status: 'ok' }]);
  });
});

// BR-0011: a null answer is not an empty one (#260). A real [] still means the targets do not exist.
describe('resolveBlockRefs: a null answer from the ref lookup (#260)', () => {
  const unavailable = (count: number) => ({
    code: 'refs_unavailable',
    message:
      `LogSeq returned no answer when looking up ${count} reference(s) (possibly no graph open or a re-index ` +
      'in progress), so they were not resolved and are left as written. This does not mean they are missing. ' +
      'Retry in a moment, or call logseq_get_graph_info to check which graph is open.'
  });
  const nullClient = () => {
    const executeDatalogQuery = vi.fn(async () => null);
    return { client: { executeDatalogQuery, callAPI: vi.fn() } as unknown as LogseqClient, executeDatalogQuery };
  };

  it('does not report a ref as missing, and warns that the lookup had no answer', async () => {
    const { client } = nullClient();
    const { blocks, warnings } = await resolveBlockRefs(client, [{ uuid: A, content: `see ${ref(B)}` }]);
    expect(annotated(blocks[0]).resolvedContent).toBe(`see ${ref(B)}`);
    // `depth_limit` is the existing "not followed, left as written" status; BR-0007 lists no other
    expect(annotated(blocks[0]).resolvedRefs).toEqual([{ uuid: B, content: null, page: null, status: 'depth_limit' }]);
    expect(warnings).toEqual([unavailable(1)]);
  });

  it('carries no howToFetchAll, so it does not claim a parameter fetches the rest', async () => {
    const { client } = nullClient();
    const { warnings } = await resolveBlockRefs(client, [{ uuid: A, content: ref(B) }]);
    expect(warnings[0]).not.toHaveProperty('howToFetchAll');
  });

  it('does not add the depth-limit warning, since depth is not why the refs were not followed', async () => {
    const { client } = nullClient();
    const { warnings } = await resolveBlockRefs(client, [{ uuid: A, content: ref(B) }]);
    expect(warnings.map(w => w.code)).toEqual(['refs_unavailable']);
  });

  it('counts each distinct ref once, however often it appears or in how many blocks', async () => {
    const { client } = nullClient();
    const { warnings } = await resolveBlockRefs(client, [
      { uuid: A, content: `${ref(B)} and ${ref(B)} and ${ref(C)}` },
      { uuid: D, content: ref(B) }
    ]);
    expect(warnings).toEqual([unavailable(2)]);
  });

  it('leaves block embeds and page embeds as written, with the same status and warning', async () => {
    const { client } = nullClient();
    const content = `${embedBlock(B)} ${embedPage('Some Page')}`;
    const { blocks, warnings } = await resolveBlockRefs(client, [{ uuid: A, content }]);
    expect(annotated(blocks[0]).resolvedContent).toBe(content);
    expect(annotated(blocks[0]).resolvedRefs).toEqual([
      { uuid: B, embed: 'block', content: null, page: null, status: 'depth_limit' },
      { embed: 'page', content: null, page: 'Some Page', status: 'depth_limit' }
    ]);
    expect(warnings).toEqual([unavailable(2)]);
  });

  it('keeps what an earlier level found when only a later level has no answer', async () => {
    const executeDatalogQuery = vi
      .fn()
      .mockResolvedValueOnce([[{ id: 1, uuid: B, content: `inner ${ref(C)}`, page: alphaPage }]])
      .mockResolvedValueOnce(null);
    const client = { executeDatalogQuery, callAPI: vi.fn() } as unknown as LogseqClient;
    const { blocks, warnings } = await resolveBlockRefs(client, [{ uuid: A, content: ref(B) }]);
    expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
    expect(annotated(blocks[0]).resolvedContent).toBe(`inner ${ref(C)}`);
    expect(annotated(blocks[0]).resolvedRefs).toEqual([
      { uuid: B, content: `inner ${ref(C)}`, page: 'Alpha', status: 'ok' },
      { uuid: C, content: null, page: null, status: 'depth_limit' }
    ]);
    expect(warnings).toEqual([unavailable(1)]);
  });

  it('does not show half an embed when its block was fetched earlier but its children got no answer', async () => {
    const executeDatalogQuery = vi
      .fn()
      .mockResolvedValueOnce([
        [{ id: 1, uuid: B, content: 'plain', page: alphaPage }],
        [{ id: 2, uuid: C, content: `see ${embedBlock(B)}`, page: alphaPage }]
      ])
      .mockResolvedValueOnce(null);
    const client = { executeDatalogQuery, callAPI: vi.fn() } as unknown as LogseqClient;
    const { blocks, warnings } = await resolveBlockRefs(client, [{ uuid: A, content: `${ref(B)} ${ref(C)}` }]);
    expect(annotated(blocks[0]).resolvedRefs).toEqual([
      { uuid: B, content: 'plain', page: 'Alpha', status: 'ok' },
      { uuid: C, content: `see ${embedBlock(B)}`, page: 'Alpha', status: 'ok' },
      { uuid: B, embed: 'block', content: null, page: null, status: 'depth_limit' }
    ]);
    expect(warnings).toEqual([unavailable(1)]);
  });

  it('asks once for refs shared between blocks', async () => {
    const { client, executeDatalogQuery } = nullClient();
    await resolveBlockRefs(client, [
      { uuid: A, content: ref(B) },
      { uuid: D, content: ref(B) }
    ]);
    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
  });

  it('does not ask again after a null answer, however many levels are left', async () => {
    const executeDatalogQuery = vi
      .fn()
      .mockResolvedValueOnce([[{ id: 1, uuid: B, content: `inner ${ref(C)}`, page: alphaPage }]])
      .mockResolvedValue(null);
    const client = { executeDatalogQuery, callAPI: vi.fn() } as unknown as LogseqClient;
    const { warnings } = await resolveBlockRefs(client, [{ uuid: A, content: ref(B) }], { maxDepth: 3 });
    // level 1 finds B, level 2 asks for the C inside it and gets null, and level 3 has nothing new to ask
    // for, so C is not asked for again: 2 queries, not 3
    expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
    expect(warnings.map(w => w.code)).toEqual(['refs_unavailable']);
  });

  it('does not ask again for a null-answered ref that a ref already found shows again (#258)', async () => {
    const executeDatalogQuery = vi
      .fn()
      .mockResolvedValueOnce([
        [{ id: 1, uuid: B, content: `${ref(E)} ${ref(C)}`, page: alphaPage }],
        [{ id: 2, uuid: E, content: ref(C), page: alphaPage }]
      ])
      .mockResolvedValue(null);
    const client = { executeDatalogQuery, callAPI: vi.fn() } as unknown as LogseqClient;
    await resolveBlockRefs(client, [{ uuid: A, content: `${ref(B)} ${ref(E)}` }], { maxDepth: 3 });
    // level 2 asks for C and gets null, which caches nothing. E, found at level 1, shows C again, but E was
    // already scanned, so level 3 asks for nothing: 2 queries. Without the scanned set it would be 3.
    expect(executeDatalogQuery).toHaveBeenCalledTimes(2);
  });

  it('still reports a ref as missing, with no warning, when the answer is a real empty array', async () => {
    const { client } = rawClient([]);
    const { blocks, warnings } = await resolveBlockRefs(client, [{ uuid: A, content: ref(B) }]);
    expect(annotated(blocks[0]).resolvedRefs).toEqual([{ uuid: B, content: null, page: null, status: 'missing' }]);
    expect(warnings).toEqual([]);
  });
});
