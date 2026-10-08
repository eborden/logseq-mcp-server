// Parity cases for `format: "markdown"` on logseq_get_page and logseq_get_block (#310, #43, ADR-0025).
// Every page, block and name here is made up (BR-0001). Each case lists the LogSeq calls the
// TypeScript server makes, in order, with the answer the stub gives; the result the server printed
// for it is in ../expected/.
//
// Two kinds. The first re-runs every case of the JSON tools (get-page.ts, get-block.ts and the ref
// resolver's resolve-refs.ts) with `format: "markdown"` added, so the same route, error and cap is
// held to the same text in Markdown, and the LogSeq calls are the same as for JSON. The second is
// the renderer's own cases: page properties and the pre-block rule, outline shapes, and the footer.
import type { ParityCase } from '../harness.js';
import { ATLAS, RESOLVE_BY_NAME, editor, editorBlock, editorPage, pulledPage, query, refQuery, target, uuid } from '../ref-fixtures.js';
import { getBlockCases } from './get-block.js';
import { getPageCases } from './get-page.js';
import { resolveRefsCases } from './resolve-refs.js';

const GET_PAGE = 'logseq.Editor.getPage';
const BLOCKS_TREE = 'logseq.Editor.getPageBlocksTree';
const getPage = (name: string, response: unknown) => editor(GET_PAGE, [name], response);
const tree = (name: string, response: unknown) => editor(BLOCKS_TREE, [name], response);

/** The cases again with `format: "markdown"`, except the ones that are about `format` itself. */
const asMarkdown = (cases: readonly ParityCase[], from: string, to: string): ParityCase[] =>
  cases
    .filter(c => !c.name.includes('format is not a known one'))
    .map(c => ({ ...c, name: c.name.replace(from, to), arguments: { ...c.arguments, format: 'markdown' } }));

/** A pre-block, the first block of a page with properties: the Editor API flags it `preBlock?`. */
const preBlock = (id: number, content: string) => ({ ...editorBlock(id, content), 'preBlock?': true });

/** What the Editor API sends as a page's `properties`: camelCased keys, page refs without brackets. */
const PAGE_PROPERTIES = {
  title: 'Project Atlas',
  projectStatus: 'active',
  relatedTo: ['Alice', 'Bob'],
  'see-also': ['[[Project Atlas]]', 'Carol'],
  rating: 3,
  archived: false,
  owner: '[[Alice]]',
  empty: '',
  tags: [],
  nested: { b: 1, a: [true, null] },
  '2': 'two',
  '1': 'one',
  'logseq.orderListType': 'number'
};

const PRE_BLOCK_TEXT = 'project-status:: active\nrelated-to:: [[Alice]], [[Bob]]\nrating:: 3\narchived:: false\n';

/** Blocks of every shape the outline has to lay out */
const SHAPES = [
  editorBlock(101, 'Kickoff with [[Alice]] and [[Bob]]\nsecond line\n\nfourth line after a blank one', {
    children: [
      editorBlock(103, 'Alice owns the schema\nand more', { parent: 101, children: [editorBlock(105, 'Draft', { parent: 103 })] }),
      editorBlock(104, '', { parent: 101 })
    ]
  }),
  editorBlock(102, 'Milestones – café \u{1F680}\r\n- ship the importer\n'),
  editorBlock(106, `a ref ((${uuid(7)})) stays as written`, { children: [['uuid', uuid(107)]] })
];

export const markdownCases: ParityCase[] = [
  ...asMarkdown(getPageCases, 'get_page:', 'get_page markdown:'),
  ...asMarkdown(getBlockCases, 'get_block:', 'get_block markdown:'),
  // The second level of a cycle resolves nothing the text shows, so only an answer LogSeq can't be read from changes it
  ...asMarkdown(resolveRefsCases, 'refs:', 'get_block markdown refs:').map(c =>
    c.name === 'get_block markdown refs: ref cycle' ? { ...c, perturbed: [[{ id: 'two' }]] } : c
  ),

  // ---- the page, its properties and the pre-block rule
  {
    name: 'get_page markdown: properties come from the page map when no blocks were asked for',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', format: 'markdown' },
    steps: [[getPage('Project Atlas', editorPage({ ...ATLAS, extra: { properties: PAGE_PROPERTIES } }))]]
  },
  {
    name: 'get_page markdown: properties come from the page map when the tree has no pre-block',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', include_children: true, format: 'markdown' },
    steps: [[getPage('Project Atlas', editorPage({ ...ATLAS, extra: { properties: PAGE_PROPERTIES } }))], [tree('Project Atlas', SHAPES)]]
  },
  {
    name: 'get_page markdown: the pre-block is the properties, verbatim, and is not listed again',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', include_children: true, format: 'markdown' },
    steps: [
      [getPage('Project Atlas', editorPage({ ...ATLAS, extra: { properties: PAGE_PROPERTIES } }))],
      [tree('Project Atlas', [preBlock(100, PRE_BLOCK_TEXT), ...SHAPES])]
    ]
  },
  {
    name: 'get_page markdown: a pre-block alone leaves a page with no blocks',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', include_children: true, format: 'markdown' },
    steps: [[getPage('Project Atlas', editorPage(ATLAS))], [tree('Project Atlas', [preBlock(100, 'alias:: atlas')])]]
  },
  {
    name: 'get_page markdown: a blank pre-block is no pre-block, so the map is used and the block is listed',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', include_children: true, format: 'markdown' },
    steps: [
      [getPage('Project Atlas', editorPage({ ...ATLAS, extra: { properties: { status: 'doing' } } }))],
      [tree('Project Atlas', [preBlock(100, ' \n'), editorBlock(101, 'Real')])]
    ]
  },
  {
    name: 'get_page markdown: the pre-block is not the first block',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', include_children: true, format: 'markdown' },
    steps: [[getPage('Project Atlas', editorPage(ATLAS))], [tree('Project Atlas', [editorBlock(101, 'Real'), preBlock(100, 'status:: late\n')])]]
  },
  {
    name: 'get_page markdown: blocks of every shape',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', include_children: true, format: 'markdown' },
    steps: [[getPage('Project Atlas', editorPage(ATLAS))], [tree('Project Atlas', SHAPES)]]
  },
  {
    name: 'get_page markdown: the name resolved from, written as JSON',
    tool: 'logseq_get_page',
    arguments: { page_name: ' atlas "Q" \\ ', format: 'markdown' },
    steps: [
      [getPage('atlas "Q" \\', null)],
      [query(RESOLVE_BY_NAME, [JSON.stringify('atlas "q" \\')], [[pulledPage(ATLAS), 'alias']])],
      [getPage('project atlas', editorPage(ATLAS))]
    ]
  },

  // ---- the footer
  {
    name: 'get_page markdown: refs that were not followed give a warning and hasMore in the footer',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', include_children: true, resolve_refs: true, format: 'markdown' },
    steps: [
      [getPage('Project Atlas', editorPage(ATLAS))],
      [tree('Project Atlas', [editorBlock(101, `go ((${uuid(2)}))`), editorBlock(102, 'plain')])],
      [refQuery({ blocks: [uuid(2)] }, [target(2, `mid ((${uuid(3)}))\nover two lines`)])],
      [refQuery({ blocks: [uuid(3)] }, [target(3, `end ((${uuid(4)}))`)])]
    ]
  },
  {
    name: 'get_page markdown: refs LogSeq gave no answer for give a warning without hasMore',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', include_children: true, resolve_refs: true, format: 'markdown' },
    steps: [
      [getPage('Project Atlas', editorPage(ATLAS))],
      [tree('Project Atlas', [editorBlock(101, `see ((${uuid(2)}))`)])],
      [refQuery({ blocks: [uuid(2)] }, null)]
    ]
  },

  // ---- a block on its own
  {
    name: 'get_block markdown: an empty block and a block with a trailing newline',
    tool: 'logseq_get_block',
    arguments: { block_uuid: uuid(101), include_children: true, format: 'markdown' },
    steps: [
      [
        editor('logseq.Editor.getBlock', [uuid(101), { includeChildren: true }], editorBlock(101, '', {
          children: [editorBlock(102, 'ends with a newline\n', { parent: 101 }), editorBlock(103, 'crlf\r\nline', { parent: 101 })]
        }))
      ]
    ]
  },
  {
    name: 'get_block markdown: a block of every shape, children and all',
    tool: 'logseq_get_block',
    arguments: { block_uuid: uuid(101), include_children: true, format: 'markdown' },
    steps: [[editor('logseq.Editor.getBlock', [uuid(101), { includeChildren: true }], SHAPES[0])]]
  }
];
