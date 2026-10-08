// Parity cases for logseq_get_current_context (#315, ADR-0025). Every page, block and name here is
// made up (BR-0001). Each case lists the LogSeq calls the TypeScript server makes, in order, with the
// answer the stub gives; the result the server printed for it is in ../expected/.
//
// The first step is always the three Editor calls the tool makes at once (the harness compares the
// calls of a step as a set); a second step is the one Datalog query that names the pages of the
// blocks, made only when a block's page is not already known.
import { DATASCRIPT_QUERY, type CannedCall } from '../stub-logseq.js';
import type { ParityCase } from '../harness.js';

const TOOL = 'logseq_get_current_context';

const PAGES_BY_IDS_PREFIX = '[:find (pull ?p [*]) :where ';
const pagesQuery = (ids: number[]) => `${PAGES_BY_IDS_PREFIX}[(ground [${ids.join(' ')}]) [?p ...]] [?p :block/name]]`;

const editor = (method: string, response: unknown): CannedCall => ({ method, args: [], response });

/**
 * The three calls of the first step, with what each answers. The calls of a step are compared as a set, so
 * `last` only says which one the self-check perturbs: the selected blocks, unless a case is about another.
 */
const open = (currentPage: unknown, currentBlock: unknown, selected: unknown, last: 'page' | 'block' | 'selected' = 'selected'): CannedCall[] => {
  const calls = {
    page: editor('logseq.Editor.getCurrentPage', currentPage),
    block: editor('logseq.Editor.getCurrentBlock', currentBlock),
    selected: editor('logseq.Editor.getSelectedBlocks', selected)
  };
  return [...(['page', 'block', 'selected'] as const).filter(name => name !== last).map(name => calls[name]), calls[last]];
};

const pages = (ids: number[], response: unknown): CannedCall => ({ method: DATASCRIPT_QUERY, args: [pagesQuery(ids)], response });

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

/** A page as `getCurrentPage` returns it: the Editor API's camelCase keys. */
const editorPage = (id: number, name: string, originalName: string, extra: Record<string, unknown> = {}) => ({
  id,
  uuid: uuid(id),
  name,
  originalName,
  'journal?': false,
  file: { id: id + 5000 },
  createdAt: 1735700000000,
  updatedAt: 1735700001000,
  ...extra
});

/** A page as a `pull [*]` returns it: LogSeq's own kebab-case keys. */
const pulledPage = (id: number, name: string | undefined, originalName: string | undefined, extra: Record<string, unknown> = {}) => [
  {
    id,
    uuid: uuid(id),
    ...(name === undefined ? {} : { name }),
    ...(originalName === undefined ? {} : { 'original-name': originalName }),
    'journal?': false,
    file: { id: id + 5000 },
    'created-at': 1735700000000,
    'updated-at': 1735700001000,
    ...extra
  }
];

/** A block as the Editor API returns it: the page and parent are bare `{ id }`. */
const block = (id: number, content: string | undefined, page: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({
  id,
  uuid: uuid(id),
  ...(content === undefined ? {} : { content }),
  format: 'markdown',
  left: { id: id - 1 },
  parent: { id: page?.id ?? 1 },
  ...(page ? { page } : {}),
  ...extra
});

const ATLAS = editorPage(10, 'project atlas', 'Project Atlas', { properties: { type: 'project', empty: '' } });
const BOB_ROW = pulledPage(20, 'bob', 'Bob');
const ATLAS_ROW = pulledPage(10, 'project atlas', 'Project Atlas');
const JOURNAL = editorPage(30, 'jan 1st, 2025', 'Jan 1st, 2025', { 'journal?': true, journalDay: 20250101 });

const ON_ATLAS = block(512, 'TODO ship the [[Importer]] with #urgent and #later', { id: 10 }, { marker: 'TODO', properties: { status: 'open', owner: '', count: 0 } });
const ON_BOB = block(105, 'Bob owns the importer', { id: 20 });

export const getCurrentContextCases: ParityCase[] = [
  {
    name: 'current context: a page is open and nothing else',
    tool: TOOL,
    arguments: {},
    steps: [open(ATLAS, null, null)]
  },
  {
    // The arguments are ignored, whatever they are
    name: 'current context: unknown arguments are ignored',
    tool: TOOL,
    arguments: { page_name: 'ignored', limit: 'x' },
    steps: [open(ATLAS, null, [])]
  },
  {
    name: 'current context: a journal page is open',
    tool: TOOL,
    arguments: {},
    steps: [open(JOURNAL, null, null)]
  },
  {
    // The open page is already known, so a block on it costs no lookup
    name: 'current context: a focused block on the open page',
    tool: TOOL,
    arguments: {},
    steps: [open(ATLAS, ON_ATLAS, null)]
  },
  {
    // Children arrive as unfetched `["uuid", id]` tuples, and as blocks when LogSeq sent them whole: only whole ones with text stay
    name: 'current context: a focused block with unfetched and fetched children',
    tool: TOOL,
    arguments: {},
    steps: [
      open(
        ATLAS,
        block(600, 'parent block', { id: 10 }, {
          children: [['uuid', uuid(601)], block(601, 'whole child #kept', { id: 10 }, { children: [['uuid', uuid(602)], block(602, 'grandchild', { id: 10 })] }), { id: 603 }, 'text'],
          childrenTruncated: true
        }),
        null
      )
    ]
  },
  {
    name: 'current context: children that are not a list are left out',
    tool: TOOL,
    arguments: {},
    steps: [open(ATLAS, block(600, 'parent block', { id: 10 }, { children: { id: 601 } }), [])]
  },
  {
    // The selection on the open page, and a block on another: one lookup, for the other page only
    name: 'current context: selected blocks, one on another page',
    tool: TOOL,
    arguments: {},
    steps: [
      open(ATLAS, ON_ATLAS, [ON_BOB, block(106, 'second on bob', { id: 20 }), block(513, '[[Alice]] said hi', { id: 10 })]),
      [pages([20], [BOB_ROW])]
    ]
  },
  {
    // No page is open: the page of the focused block stands in, and a lookup names it
    name: 'current context: no page open, a focused block',
    tool: TOOL,
    arguments: {},
    steps: [open(null, ON_BOB, null), [pages([20], [BOB_ROW])]]
  },
  {
    // The page that stands in is the focused block's, lowercased for `name`
    name: 'current context: no page open, a selection only',
    tool: TOOL,
    arguments: {},
    steps: [open(null, null, [ON_ATLAS, ON_BOB]), [pages([10, 20], [ATLAS_ROW, BOB_ROW])]]
  },
  {
    // `getCurrentPage` answers the zoomed block: it is the focused block when `getCurrentBlock` has none
    name: 'current context: zoomed into a block',
    tool: TOOL,
    arguments: {},
    steps: [open(ON_ATLAS, null, null), [pages([10], [ATLAS_ROW])]]
  },
  {
    // `getCurrentBlock` wins over the zoomed block, which is then not looked at
    name: 'current context: zoomed into a block while another is focused',
    tool: TOOL,
    arguments: {},
    steps: [open(ON_ATLAS, ON_BOB, null), [pages([20], [BOB_ROW])]]
  },
  {
    // An answer with no `name` and no `page` is not a zoomed block: it is read as a page, whatever it holds
    name: 'current context: an answer with neither name nor page is read as a page',
    tool: TOOL,
    arguments: {},
    steps: [open(block(700, 'a block with no page', undefined, { properties: { kind: 'odd' } }), null, null)]
  },
  {
    // Nothing is open: the page is null and the message says so
    name: 'current context: nothing open',
    tool: TOOL,
    arguments: {},
    steps: [open(null, null, null)]
  },
  {
    name: 'current context: nothing open, an empty selection',
    tool: TOOL,
    arguments: {},
    steps: [open(null, null, [])]
  },
  {
    // A block with no page id has nothing to look up: no second call, and no page name
    name: 'current context: no page open, a block with no page',
    tool: TOOL,
    arguments: {},
    steps: [open(null, block(800, 'a block with no page', undefined), [block(801, 'another', undefined)])]
  },
  {
    // A page id spelled `db/id`, as an older LogSeq or a test double sends it
    name: 'current context: a block page id spelled db/id',
    tool: TOOL,
    arguments: {},
    steps: [open(null, block(900, 'on bob', { 'db/id': 20 }), null), [pages([20], [BOB_ROW])]]
  },
  {
    // The ids are looked up once each, focused block first
    name: 'current context: page ids are looked up once, focused block first',
    tool: TOOL,
    arguments: {},
    steps: [
      open(null, block(900, 'on bob', { id: 20 }), [block(901, 'on atlas', { id: 10 }), block(902, 'on bob again', { id: 20 }), block(903, 'on a page not found', { id: 40 })]),
      [pages([20, 10, 40], [BOB_ROW, ATLAS_ROW])]
    ]
  },
  {
    // A null cell and a page with no id are skipped; a page with no original name shows its name; a page with neither shows ''
    name: 'current context: lookup rows that are null or name nothing',
    tool: TOOL,
    arguments: {},
    steps: [
      open(null, null, [block(900, 'one', { id: 20 }), block(901, 'two', { id: 21 }), block(902, 'three', { id: 22 }), block(903, 'four', { id: 23 })]),
      [pages([20, 21, 22, 23], [[null], pulledPage(21, 'plain name', undefined), pulledPage(22, undefined, undefined), [{ name: 'no id', 'original-name': 'No Id' }]])]
    ]
  },
  {
    // A page that stands in must have a name; an empty one means no page is open
    name: 'current context: the page that stands in has no name',
    tool: TOOL,
    arguments: {},
    steps: [open(null, block(900, 'on a page with no name', { id: 22 }), null), [pages([22], [pulledPage(22, undefined, undefined)])]],
    perturbed: [pulledPage(22, 'named', 'Named')]
  },
  {
    // An empty original name counts as missing
    name: 'current context: an empty original name falls back to the name',
    tool: TOOL,
    arguments: {},
    steps: [open(null, block(900, 'on bob', { id: 20 }), null), [pages([20], [pulledPage(20, 'bob', '')])]]
  },
  {
    // A null answer to the lookup is read as no pages (PARITY: BR-0011 would say the names were unavailable)
    name: 'current context: the page lookup answers null',
    tool: TOOL,
    arguments: {},
    steps: [open(null, ON_BOB, null), [pages([20], null)]],
    perturbed: [BOB_ROW]
  },
  {
    // A focused and a selected block on the open page both take its name from the open page, with no lookup
    // (TypeScript never pulls an id it already has)
    name: 'current context: a block on the open page takes its name from it',
    tool: TOOL,
    arguments: {},
    steps: [open(editorPage(10, 'project atlas', 'Project Atlas'), block(512, 'on atlas', { id: 10 }), [block(513, 'also on atlas', { id: 10 })])]
  },
  {
    name: 'current context: slim properties and page references of a selected block',
    tool: TOOL,
    arguments: {},
    steps: [
      open(null, null, [
        block(512, '[[Atlas]] [[Bob Smith]] #a#b', { id: 10 }, { properties: { zero: 0, no: false, empty: [], blank: '  ', nested: { a: '' } } }),
        block(513, undefined, { id: 10 })
      ]),
      [pages([10], [ATLAS_ROW])]
    ]
  },
  {
    // LogSeq answers an error: it is an error result (BR-0003), whichever call it fails
    name: 'current context: LogSeq error for the open page',
    tool: TOOL,
    arguments: {},
    steps: [open({ error: 'MethodNotExist: logseq.Editor.getCurrentPage' }, null, null, 'page')],
    perturbed: null
  },
  {
    name: 'current context: LogSeq error for the page lookup',
    tool: TOOL,
    arguments: {},
    steps: [open(null, ON_BOB, null), [pages([20], { error: 'boom' })]]
  },
  {
    name: 'current context: the open page is in a shape the server cannot read',
    tool: TOOL,
    arguments: {},
    steps: [open(editorPage(10, 'project atlas', 'Project Atlas', { originalName: 3 }), null, null, 'page')],
    perturbed: null
  },
  {
    name: 'current context: the open page has a null name',
    tool: TOOL,
    arguments: {},
    steps: [open({ id: 10, uuid: uuid(10), name: null }, null, null, 'page')],
    perturbed: null
  },
  {
    name: 'current context: the open page is a number',
    tool: TOOL,
    arguments: {},
    steps: [open(5, null, null, 'page')],
    perturbed: null
  },
  {
    name: 'current context: the open page is a list',
    tool: TOOL,
    arguments: {},
    steps: [open([], null, null, 'page')],
    perturbed: null
  },
  {
    name: 'current context: the open page is text',
    tool: TOOL,
    arguments: {},
    steps: [open('Project Atlas', null, null, 'page')],
    perturbed: null
  },
  {
    name: 'current context: the zoomed block is in a shape the server cannot read',
    tool: TOOL,
    arguments: {},
    steps: [open({ id: 11, page: { id: 10 } }, null, null, 'page')],
    perturbed: null
  },
  {
    name: 'current context: the focused block is in a shape the server cannot read',
    tool: TOOL,
    arguments: {},
    steps: [open(null, { id: 11, uuid: uuid(11), content: 5 }, null, 'block')],
    perturbed: null
  },
  {
    name: 'current context: the selection is not a list',
    tool: TOOL,
    arguments: {},
    steps: [open(null, null, { id: 11 })],
    perturbed: null
  },
  {
    name: 'current context: a selected block is in a shape the server cannot read',
    tool: TOOL,
    arguments: {},
    steps: [open(null, null, [block(11, 'fine', { id: 10 }), { id: 12, uuid: uuid(12), page: { id: 'ten' } }])],
    perturbed: []
  },
  {
    name: 'current context: the page lookup is not a list of rows',
    tool: TOOL,
    arguments: {},
    steps: [open(null, ON_BOB, null), [pages([20], { rows: [] })]],
    perturbed: { error: 'parity harness: perturbed answer' }
  },
  {
    name: 'current context: a page lookup row is in a shape the server cannot read',
    tool: TOOL,
    arguments: {},
    steps: [open(null, ON_BOB, null), [pages([20], [[{ id: 20, name: 7 }]])]]
  },
  {
    name: 'current context: a page lookup row with a second cell',
    tool: TOOL,
    arguments: {},
    steps: [open(null, ON_BOB, null), [pages([20], [[BOB_ROW[0], 'extra']])]],
    perturbed: [BOB_ROW]
  },
  {
    name: 'current context: a page lookup row with no cells',
    tool: TOOL,
    arguments: {},
    steps: [open(null, ON_BOB, null), [pages([20], [[]])]]
  }
];
