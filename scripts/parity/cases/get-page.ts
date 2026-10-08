// Parity cases for logseq_get_page (#308, ADR-0025), with and without include_children and
// resolve_refs. Every page, block and name here is made up (BR-0001). Each case lists the LogSeq
// calls the TypeScript server makes, in order, with the answer the stub gives; the result the
// server printed for it is in ../expected/.
//
// The exact name of a page with a file costs one call. Anything else goes through the page resolver
// (BR-0010) as well, and the case names say which route.
import type { ParityCase } from '../harness.js';
import {
  ALICE,
  ALICE_NOTES,
  ATLAS,
  ATLAS_LOG,
  BOB,
  NAMESPACE_LEAF,
  NEW_YEAR,
  RESOLVE_BY_NAME,
  RESOLVE_WITH_DAY,
  editor,
  editorBlock,
  editorPage,
  pageRow,
  pulledPage,
  query,
  refQuery,
  target,
  uuid
} from '../ref-fixtures.js';

const GET_PAGE = 'logseq.Editor.getPage';
const BLOCKS_TREE = 'logseq.Editor.getPageBlocksTree';
const GET_ALL_PAGES = 'logseq.Editor.getAllPages';

const getPage = (name: string, response: unknown) => editor(GET_PAGE, [name], response);
const tree = (name: string, response: unknown) => editor(BLOCKS_TREE, [name], response);

// Two top-level blocks, the first with a child and a property map whose number-like keys sort first
const ATLAS_BLOCKS = [
  editorBlock(101, 'Kickoff with [[Alice]] and [[Bob]] about "scope" & <dates>', {
    properties: { status: 'doing', '2': 'two', '1': 'one' },
    children: [editorBlock(103, 'Alice owns the schema', { parent: 101 })]
  }),
  editorBlock(102, 'Milestones – café \u{1F680}\n- ship the importer')
];

export const getPageCases: ParityCase[] = [
  {
    name: 'get_page: exact name of a page with a file',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas' },
    steps: [[getPage('Project Atlas', editorPage({ ...ATLAS, extra: { properties: { title: 'Project Atlas', '3': 'three' } } }))]]
  },
  {
    name: 'get_page: exact name, typed padded and in capitals',
    tool: 'logseq_get_page',
    arguments: { page_name: '  PROJECT ATLAS \n' },
    steps: [[getPage('PROJECT ATLAS', editorPage(ATLAS))]]
  },
  {
    name: 'get_page: exact name with its blocks',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', include_children: true },
    steps: [[getPage('Project Atlas', editorPage(ATLAS))], [tree('Project Atlas', ATLAS_BLOCKS)]]
  },
  {
    name: 'get_page: a page with no blocks gets no children key',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', include_children: true },
    steps: [[getPage('Project Atlas', editorPage(ATLAS))], [tree('Project Atlas', [])]]
  },
  {
    name: 'get_page: a null block tree gets no children key',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', include_children: true },
    steps: [[getPage('Project Atlas', editorPage(ATLAS))], [tree('Project Atlas', null)]]
  },
  {
    name: 'get_page: page alias for the name parameter',
    tool: 'logseq_get_page',
    arguments: { page: 'Project Atlas', name: 'Project Atlas', include_children: false },
    steps: [[getPage('Project Atlas', editorPage(ATLAS))]]
  },
  {
    name: 'get_page: name and page with different values',
    tool: 'logseq_get_page',
    arguments: { page: 'Project Atlas', name: 'Bob' },
    steps: []
  },
  {
    name: 'get_page: a stub that is not an alias target',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Bob' },
    steps: [
      [getPage('Bob', editorPage(BOB))],
      [query(RESOLVE_BY_NAME, ['"bob"'], [[pulledPage(BOB), 'name']])]
    ]
  },
  {
    name: 'get_page: a stub that is an alias target resolves to the page that declares it',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Atlas', include_children: true },
    steps: [
      [getPage('Atlas', editorPage({ id: 70, name: 'atlas', originalName: 'Atlas' }))],
      [
        query(RESOLVE_BY_NAME, ['"atlas"'], [
          [pulledPage({ id: 70, name: 'atlas', originalName: 'Atlas' }), 'name'],
          [pulledPage(ATLAS), 'alias']
        ])
      ],
      [getPage('project atlas', editorPage(ATLAS))],
      [tree('project atlas', ATLAS_BLOCKS)]
    ]
  },
  {
    name: 'get_page: alias',
    tool: 'logseq_get_page',
    arguments: { page_name: ' atlas ', include_children: true },
    steps: [
      [getPage('atlas', null)],
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulledPage(ATLAS), 'alias']])],
      [getPage('project atlas', editorPage(ATLAS))],
      [tree('project atlas', ATLAS_BLOCKS.slice(0, 1))]
    ]
  },
  {
    name: 'get_page: ISO date of a journal',
    tool: 'logseq_get_page',
    arguments: { page_name: '2025-01-01' },
    steps: [
      [getPage('2025-01-01', null)],
      [query(RESOLVE_WITH_DAY, ['"2025-01-01"', '20250101'], [[pulledPage(NEW_YEAR), 'journal-date']])],
      [getPage('jan 1st, 2025', editorPage(NEW_YEAR))]
    ]
  },
  {
    name: 'get_page: namespace leaf',
    tool: 'logseq_get_page',
    arguments: { page_name: 'log' },
    steps: [
      [getPage('log', null)],
      [query(RESOLVE_BY_NAME, ['"log"'], [])],
      [query(NAMESPACE_LEAF, ['"/log"'], [[pulledPage(ATLAS_LOG)]])],
      [getPage('project atlas/log', editorPage(ATLAS_LOG))]
    ]
  },
  {
    name: 'get_page: page not found, with the closest names',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Projct Atlas' },
    steps: [
      [getPage('Projct Atlas', null)],
      [query(RESOLVE_BY_NAME, ['"projct atlas"'], [])],
      [query(NAMESPACE_LEAF, ['"/projct atlas"'], [])],
      [editor(GET_ALL_PAGES, [], [{ originalName: 'Project Atlas' }, { originalName: 'Alice' }, { originalName: 'Bob' }])]
    ]
  },
  {
    name: 'get_page: a name that two pages declare is ambiguous',
    tool: 'logseq_get_page',
    arguments: { page_name: 'al' },
    steps: [
      [getPage('al', null)],
      [query(RESOLVE_BY_NAME, ['"al"'], [[pulledPage(ALICE_NOTES), 'alias'], [pulledPage(ALICE), 'alias']])]
    ]
  },
  {
    name: 'get_page: the page vanishes between the two lookups',
    tool: 'logseq_get_page',
    arguments: { page_name: 'atlas' },
    steps: [
      [getPage('atlas', null)],
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulledPage(ATLAS), 'alias']])],
      [getPage('project atlas', null)]
    ]
  },
  {
    name: 'get_page: resolve_refs on the blocks of a page',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', include_children: true, resolve_refs: true },
    steps: [
      [getPage('Project Atlas', editorPage(ATLAS))],
      [
        tree('Project Atlas', [
          editorBlock(101, `Owner: ((${uuid(7)}))`, { children: [editorBlock(103, `{{embed ((${uuid(8)}))}}`, { parent: 101 })] }),
          editorBlock(102, 'No refs here')
        ])
      ],
      [refQuery({ blocks: [uuid(7), uuid(8)], descendants: [uuid(8)] }, [target(7, 'Alice'), target(8, 'Plan', {}), target(9, 'Step one', { parent: 8 })])]
    ]
  },
  {
    name: 'get_page: resolve_refs with no blocks asked for adds only the meta',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', resolve_refs: true },
    steps: [[getPage('Project Atlas', editorPage(ATLAS))]]
  },
  {
    name: 'get_page: resolve_refs on an empty block tree adds only the meta',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', include_children: true, resolve_refs: true },
    steps: [[getPage('Project Atlas', editorPage(ATLAS))], [tree('Project Atlas', [])]]
  },
  {
    name: 'get_page: resolve_refs on an alias keeps resolvedFrom before the meta',
    tool: 'logseq_get_page',
    arguments: { page_name: 'atlas', include_children: true, resolve_refs: true },
    steps: [
      [getPage('atlas', null)],
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulledPage(ATLAS), 'alias']])],
      [getPage('project atlas', editorPage(ATLAS))],
      [tree('project atlas', [editorBlock(101, `{{embed [[Project Atlas]]}}`)])],
      [refQuery({ pages: ['project atlas'] }, [pageRow(ATLAS), target(11, 'First', { parent: ATLAS.id, left: ATLAS.id })])]
    ]
  },
  {
    name: 'get_page: page_name missing',
    tool: 'logseq_get_page',
    arguments: { include_children: true },
    steps: []
  },
  {
    name: 'get_page: page_name is not a string',
    tool: 'logseq_get_page',
    arguments: { page_name: ['Project Atlas'] },
    steps: []
  },
  {
    name: 'get_page: format is not a known one',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', format: 'html' },
    steps: []
  },
  {
    name: 'get_page: an answer that is not a page',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas' },
    steps: [[getPage('Project Atlas', { id: 10, originalName: 'Project Atlas' })]],
    perturbed: { id: 10, name: 11 }
  },
  {
    name: 'get_page: a block tree that is not a list of blocks',
    tool: 'logseq_get_page',
    arguments: { page_name: 'Project Atlas', include_children: true },
    steps: [[getPage('Project Atlas', editorPage(ATLAS))], [tree('Project Atlas', [{ id: 101, uuid: uuid(101) }, { id: 102 }])]],
    perturbed: [{ id: 101, uuid: uuid(101) }, { id: 102, uuid: 5 }]
  }
];
