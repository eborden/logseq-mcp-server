// Parity cases for the `logseq://page/{name}` resource (#310, #46, ADR-0025): `resources/read` of a page,
// the errors it answers with, and the template `resources/templates/list` shows. Every page, block
// and name here is made up (BR-0001). Each case lists the LogSeq calls the TypeScript server makes,
// in order, with the answer the stub gives; the result the server printed for it is in ../expected/.
//
// A read is `logseq_get_page` with its blocks (two calls for an exact name) rendered by the same
// Markdown renderer, cut at 50,000 characters. `tool` is only the label the cases are reported under.
//
// Not here: `logseq://guide`, `resources/list` and an unknown URI. The guide lists the prompts and
// tools, so the Rust server doesn't have it until #316.
import type { ParityCase } from '../harness.js';
import {
  ALICE,
  ALICE_NOTES,
  ATLAS,
  NAMESPACE_LEAF,
  RESOLVE_BY_NAME,
  RESOLVE_WITH_DAY,
  NEW_YEAR,
  editor,
  editorBlock,
  editorPage,
  pulledPage,
  query,
  uuid
} from '../ref-fixtures.js';

const TOOL = 'resource logseq://page/{name}';
const GET_PAGE = 'logseq.Editor.getPage';
const BLOCKS_TREE = 'logseq.Editor.getPageBlocksTree';
const GET_ALL_PAGES = 'logseq.Editor.getAllPages';
const getPage = (name: string, response: unknown) => editor(GET_PAGE, [name], response);
const tree = (name: string, response: unknown) => editor(BLOCKS_TREE, [name], response);

const read = (name: string, uri: string, steps: ParityCase['steps'], extra: Partial<ParityCase> = {}): ParityCase => ({
  name: `page resource: ${name}`,
  tool: TOOL,
  arguments: {},
  readResource: uri,
  steps,
  ...extra
});

const BLOCKS = [
  editorBlock(101, 'Kickoff with [[Alice]]\nsecond line', { children: [editorBlock(103, 'Alice owns the schema', { parent: 101 })] }),
  editorBlock(102, 'Milestones – café \u{1F680}')
];

/** `count` blocks of `text` each, which together are longer than the 50,000 characters a read returns */
const long = (count: number, text: string) => Array.from({ length: count }, (_, i) => editorBlock(200 + i, text));

export const pageResourceCases: ParityCase[] = [
  {
    name: 'page resource: the template',
    tool: TOOL,
    arguments: {},
    listResourceTemplates: true,
    steps: []
  },
  read('an exact name with its blocks', 'logseq://page/Project%20Atlas', [[getPage('Project Atlas', editorPage(ATLAS))], [tree('Project Atlas', BLOCKS)]]),
  read('the name in capitals, padded and encoded', 'logseq://page/%20PROJECT%20ATLAS%0A', [
    [getPage('PROJECT ATLAS', editorPage(ATLAS))],
    [tree('PROJECT ATLAS', BLOCKS)]
  ]),
  read('a page with no blocks says so', 'logseq://page/Project%20Atlas', [[getPage('Project Atlas', editorPage(ATLAS))], [tree('Project Atlas', [])]]),
  read('a null block tree is no blocks', 'logseq://page/Project%20Atlas', [[getPage('Project Atlas', editorPage(ATLAS))], [tree('Project Atlas', null)]]),
  read('properties from the pre-block, verbatim', 'logseq://page/Project%20Atlas', [
    [getPage('Project Atlas', editorPage({ ...ATLAS, extra: { properties: { projectStatus: 'active' } } }))],
    [tree('Project Atlas', [{ ...editorBlock(100, 'project-status:: active\nrelated-to:: [[Alice]]\n'), 'preBlock?': true }, ...BLOCKS])]
  ]),
  read('an alias', 'logseq://page/atlas', [
    [getPage('atlas', null)],
    [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulledPage(ATLAS), 'alias']])],
    [getPage('project atlas', editorPage(ATLAS))],
    [tree('project atlas', BLOCKS)]
  ]),
  read('an ISO date of a journal', 'logseq://page/2025-01-01', [
    [getPage('2025-01-01', null)],
    [query(RESOLVE_WITH_DAY, ['"2025-01-01"', '20250101'], [[pulledPage(NEW_YEAR), 'journal-date']])],
    [getPage('jan 1st, 2025', editorPage(NEW_YEAR))],
    [tree('jan 1st, 2025', [editorBlock(301, 'Start of the year', { page: NEW_YEAR.id })])]
  ]),
  read('a name with characters that need escaping', 'logseq://page/Caf%C3%A9%20%F0%9F%9A%80%2F%23x%3F', [
    [getPage('Café 🚀/#x?', editorPage({ ...ATLAS, name: 'café 🚀/#x?', originalName: 'Café 🚀/#x?' }))],
    [tree('Café 🚀/#x?', BLOCKS)]
  ]),
  read('a page with no name takes the title from the URI', 'logseq://page/Odd%20Name', [
    [getPage('Odd Name', editorPage({ ...ATLAS, name: '', originalName: '' }))],
    [tree('Odd Name', [])]
  ]),

  // ---- the cap
  read('a long page is cut between blocks, counting UTF-16 code units, and says so', 'logseq://page/Project%20Atlas', [
    [getPage('Project Atlas', editorPage(ATLAS))],
    [tree('Project Atlas', long(30, '\u{1F680}'.repeat(1000)))]
  ]),
  read('a first block longer than the cap keeps its start and a marker', 'logseq://page/Project%20Atlas', [
    [getPage('Project Atlas', editorPage(ATLAS))],
    [tree('Project Atlas', [editorBlock(200, `START ${'y'.repeat(60000)}`), editorBlock(201, 'never shown')])]
  ], {
    // the tail of the first block is cut, so a suffix on the strings would change nothing the read prints
    perturbed: [editorBlock(200, `OTHER ${'y'.repeat(60000)}`)]
  }),
  // Each block costs its `- `, its text and a newline. 24 blocks of 1998 characters are 48,024; the last one
  // makes 50,000 with 1973 characters, which is not over the cap, and 50,001 with 1974, which is
  read('a page of exactly the cap is not cut', 'logseq://page/Project%20Atlas', [
    [getPage('Project Atlas', editorPage(ATLAS))],
    [tree('Project Atlas', [...long(24, 'x'.repeat(1998)), editorBlock(300, 'z'.repeat(1973))])]
  ]),
  read('a page one character over the cap loses its last block', 'logseq://page/Project%20Atlas', [
    [getPage('Project Atlas', editorPage(ATLAS))],
    [tree('Project Atlas', [...long(24, 'x'.repeat(1998)), editorBlock(300, 'z'.repeat(1974))])]
  ]),

  // ---- errors
  read(
    'no such page, with the closest names',
    'logseq://page/Projct%20Atlas',
    [
      [getPage('Projct Atlas', null)],
      [query(RESOLVE_BY_NAME, ['"projct atlas"'], [])],
      [query(NAMESPACE_LEAF, ['"/projct atlas"'], [])],
      [editor(GET_ALL_PAGES, [], [{ originalName: 'Project Atlas' }, { originalName: 'Alice' }])]
    ]
  ),
  read('an ambiguous name', 'logseq://page/al', [
    [getPage('al', null)],
    [query(RESOLVE_BY_NAME, ['"al"'], [[pulledPage(ALICE_NOTES), 'alias'], [pulledPage(ALICE), 'alias']])]
  ]),
  read('the page vanishes between the two lookups', 'logseq://page/atlas', [
    [getPage('atlas', null)],
    [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulledPage(ATLAS), 'alias']])],
    [getPage('project atlas', null)]
  ]),
  read('an answer that is not a page is an internal error', 'logseq://page/Project%20Atlas', [[getPage('Project Atlas', { id: 10, originalName: 'Project Atlas' })]], {
    perturbed: { id: 10, name: 11 }
  }),
  read('a block tree that is not a list of blocks is an internal error', 'logseq://page/Project%20Atlas', [
    [getPage('Project Atlas', editorPage(ATLAS))],
    [tree('Project Atlas', [{ id: 101, uuid: uuid(101) }, { id: 102 }])]
  ], { perturbed: [{ id: 101, uuid: uuid(101) }, { id: 102, uuid: 5 }] }),
  read('a bad escape is an encoding error', 'logseq://page/50%25%', []),
  read('bytes that are not UTF-8 are an encoding error', 'logseq://page/%E0%A4%A', []),
  read('no name', 'logseq://page/', []),
  read('a blank name', 'logseq://page/%20%09%20', []),
  read('a name of 200 characters is looked up', `logseq://page/${'a'.repeat(200)}`, [
    [getPage('a'.repeat(200), editorPage({ ...ATLAS, name: 'a'.repeat(200), originalName: 'A'.repeat(200) }))],
    [tree('a'.repeat(200), [])]
  ]),
  read('a name of 201 characters is too long', `logseq://page/${'a'.repeat(201)}`, []),
  read('a name of 101 rockets is 202 characters', `logseq://page/${encodeURIComponent('\u{1F680}'.repeat(101))}`, [])
];
