// Parity cases for logseq_get_concept_network (#313, #3, #69, #132, #155, ADR-0025). Every page and
// name here is made up (BR-0001). Each case lists the LogSeq calls the TypeScript server makes, in
// order, with the answer the stub gives; the result the server printed for it is in
// ../expected/get-concept-network.json.
//
// The connected-pages queries are written out in full, not built with the TypeScript query builder, so
// a change to the builder that changes the query LogSeq receives fails the case.
//
// The Markdown cases re-run the JSON cases of the same shape with `format: "markdown"` added.
import type { ParityCase } from '../harness.js';
import {
  ALICE,
  ATLAS,
  ATLAS_RETRO,
  ATLAS_STUB,
  ATLAS_WITH_ALIAS,
  BOB,
  CAROL,
  GET_ALL_PAGES,
  NAMESPACE_LEAF,
  NEW_YEAR,
  RESOLVE_BY_NAME,
  RESOLVE_WITH_DAY,
  aliasSetsQuery,
  editor,
  member,
  pulled,
  query,
  type Page
} from '../context-fixtures.js';

const TOOL = 'logseq_get_concept_network';

const DAVE: Page = { id: 22, name: 'dave', originalName: 'Dave' };
const ERIN: Page = { id: 23, name: 'erin', originalName: 'Erin' };
const FRANK: Page = { id: 24, name: 'frank', originalName: 'Frank' };
const MARCH_TENTH: Page = { id: 31, name: 'mar 10th, 2025', originalName: 'Mar 10th, 2025', journalDay: 20250310 };

// ---- the queries, as they go over the wire (the TypeScript text with its whitespace collapsed)

const connectedQuery = (ids: number[]) =>
  '[:find ?source ?connected ?name ?original-name ?journal ?rel-type (count ?block) :where ' +
  `[(ground [${ids.join(' ')}]) [?source ...]] [?source :block/name] ` +
  '(or-join [?source ?connected ?block ?rel-type] ' +
  ';; Outbound: blocks on the source page that reference other pages ' +
  '(and [?block :block/page ?source] [?block :block/refs ?connected] [(ground "outbound") ?rel-type]) ' +
  ';; Inbound: blocks on other pages that reference the source ' +
  '(and [?block :block/refs ?source] [?block :block/page ?connected] [(ground "inbound") ?rel-type])) ' +
  '[?connected :block/name ?name] [(not= ?source ?connected)] ' +
  '[(get-else $ ?connected :block/original-name "") ?original-name] ' +
  '[(get-else $ ?connected :block/journal? false) ?journal]]';

const groupedQuery = (pairs: Array<[number, number]>) =>
  '[:find ?group ?connected ?name ?original-name ?journal ?rel-type (count-distinct ?block) :where ' +
  `[(ground [${pairs.map(([id, group]) => `[${id} ${group}]`).join(' ')}]) [[?source ?group] ...]] [?source :block/name] ` +
  '(or-join [?source ?connected ?block ?rel-type] ' +
  '(and [?block :block/page ?source] [?block :block/refs ?connected] [(ground "outbound") ?rel-type]) ' +
  '(and [?block :block/refs ?source] [?block :block/page ?connected] [(ground "inbound") ?rel-type])) ' +
  '[?connected :block/name ?name] [(not= ?group ?connected)] ' +
  '[(get-else $ ?connected :block/original-name "") ?original-name] ' +
  '[(get-else $ ?connected :block/journal? false) ?journal]]';

// ---- the rows

type Rel = 'outbound' | 'inbound';

/** `[sourceId, connectedId, name, originalName, isJournal, relType, count]` */
const row = (source: number, page: Page, rel: Rel, count: number, originalName = page.originalName) => [
  source,
  page.id,
  page.name,
  originalName,
  page.journalDay !== undefined,
  rel,
  count
];

/** `n` made-up pages, `page 001`, `page 002`, ..., with ids from `base`. */
const pagesOf = (n: number, base: number, prefix = 'page'): Page[] =>
  Array.from({ length: n }, (_, i) => {
    const label = `${prefix} ${String(i + 1).padStart(3, '0')}`;
    return { id: base + i, name: label, originalName: label.replace(/^./, c => c.toUpperCase()) };
  });

// ---- the calls

const resolveExact = (page: Page, input = page.originalName) => [
  query(RESOLVE_BY_NAME, [JSON.stringify(input.trim().toLowerCase())], [[pulled(page), 'name']])
];

/** The resolver, then each frontier's query in turn, for a page with no alias links. */
const walk = (page: Page, levels: Array<{ ids: number[]; rows: unknown }>, input?: string): ParityCase['steps'] => [
  resolveExact(page, input),
  ...levels.map(({ ids, rows }) => [query(connectedQuery(ids), [], rows)])
];

/** The alias group Project Atlas (10) and Atlas (11), asked for by its declaring page's name. */
const aliasWalk = (levels: Array<{ query: string; rows: unknown }>): ParityCase['steps'] => [
  resolveExact(ATLAS_WITH_ALIAS),
  [query(aliasSetsQuery([10]), [], [member(10, ATLAS), member(10, ATLAS_STUB)])],
  ...levels.map(level => [query(level.query, [], level.rows)])
];

const call = (name: string, args: Record<string, unknown>, steps: ParityCase['steps']): ParityCase => ({
  name: `network: ${name}`,
  tool: TOOL,
  arguments: { concept_name: 'Project Atlas', ...args },
  steps
});

// ---- shapes that are also run as Markdown

/** Bob links the page both ways, Carol and the journal one way; Bob and Carol link each other. */
const TWO_LEVELS = walk(ATLAS, [
  {
    ids: [10],
    rows: [
      row(10, BOB, 'outbound', 3),
      row(10, BOB, 'inbound', 2),
      row(10, CAROL, 'outbound', 1),
      row(10, NEW_YEAR, 'inbound', 4)
    ]
  },
  {
    // The journal is a leaf: it is not in this frontier
    ids: [20, 21],
    rows: [
      row(20, DAVE, 'outbound', 2),
      row(20, CAROL, 'outbound', 1),
      row(21, BOB, 'outbound', 1),
      // Bob's link to Carol, reported again from Carol's side: the count is set, never added
      row(21, BOB, 'inbound', 1),
      row(21, ERIN, 'inbound', 1),
      row(20, ATLAS, 'outbound', 2)
    ]
  }
]);

const SHAPES: ParityCase[] = [
  call('exact name, two levels, both directions, journals as leaves', {}, TWO_LEVELS),
  call('one level only', { max_depth: 1 }, walk(ATLAS, [{ ids: [10], rows: [row(10, BOB, 'outbound', 3), row(10, CAROL, 'inbound', 1)] }])),
  call(
    // The deepest a call may go is 3, whatever is asked for: three queries, and the fourth page is not reached
    'max_depth past the maximum is 3',
    { max_depth: 9 },
    walk(ATLAS, [
      { ids: [10], rows: [row(10, BOB, 'outbound', 1)] },
      { ids: [20], rows: [row(20, CAROL, 'outbound', 1)] },
      { ids: [21], rows: [row(21, DAVE, 'outbound', 1)] }
    ])
  ),
  call(
    // Nothing is fetched at depth 0, not even the alias lookup of a page that has alias links
    'max_depth 0 is the root alone',
    { max_depth: 0 },
    [resolveExact(ATLAS_WITH_ALIAS)]
  ),
  call('a page nothing links to or from', {}, walk(ATLAS, [{ ids: [10], rows: [] }])),
  call(
    // Only journals at depth 1, and they are leaves: there is nothing to expand, so no second query
    'the walk stops when no page is left to expand',
    {},
    walk(ATLAS, [{ ids: [10], rows: [row(10, NEW_YEAR, 'outbound', 2), row(10, MARCH_TENTH, 'inbound', 1)] }])
  ),
  call(
    'a journal is walked through with expand_journals',
    { expand_journals: true },
    walk(ATLAS, [
      { ids: [10], rows: [row(10, BOB, 'outbound', 3), row(10, NEW_YEAR, 'inbound', 4)] },
      { ids: [20, 30], rows: [row(30, ALICE, 'outbound', 1), row(20, DAVE, 'outbound', 1)] }
    ])
  ),
  call(
    'a journal is a leaf without it',
    {},
    walk(ATLAS, [
      { ids: [10], rows: [row(10, BOB, 'outbound', 3), row(10, NEW_YEAR, 'inbound', 4)] },
      { ids: [20], rows: [row(20, DAVE, 'outbound', 1)] }
    ])
  ),
  call(
    // A page with no original name is shown by its lowercase one
    'an empty original name falls back to the name',
    { max_depth: 1 },
    walk(ATLAS, [{ ids: [10], rows: [row(10, BOB, 'outbound', 1, '')] }])
  ),
  call(
    // The group is one node: depth 1 expands both names in one query, a link to a member is dropped at every
    // depth, and the group's count is the page's
    'a page with aliases is one node',
    {},
    aliasWalk([
      {
        query: groupedQuery([
          [10, 10],
          [11, 10]
        ]),
        rows: [
          row(10, BOB, 'outbound', 4),
          row(10, ATLAS_STUB, 'outbound', 2),
          row(10, BOB, 'inbound', 1),
          row(10, NEW_YEAR, 'inbound', 2)
        ]
      },
      { query: connectedQuery([20]), rows: [row(20, DAVE, 'outbound', 1), row(20, ATLAS_STUB, 'outbound', 3), row(20, ATLAS, 'outbound', 2)] }
    ])
  ),
  {
    // Asked by the other name: the declaring page is the root, and the result says so and lists the names
    name: 'network: asked by an alias name',
    tool: TOOL,
    arguments: { concept_name: 'Atlas', max_depth: 1 },
    steps: [
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulled(ATLAS_STUB), 'name'], [pulled(ATLAS_WITH_ALIAS), 'alias']])],
      [query(aliasSetsQuery([10]), [], [member(10, ATLAS), member(10, ATLAS_STUB)])],
      [
        query(
          groupedQuery([
            [10, 10],
            [11, 10]
          ]),
          [],
          [row(10, BOB, 'outbound', 1)]
        )
      ]
    ]
  },
  {
    name: 'network: a journal by its ISO date',
    tool: TOOL,
    arguments: { concept_name: '2025-01-01', max_depth: 1 },
    steps: [
      [query(RESOLVE_WITH_DAY, ['"2025-01-01"', '20250101'], [[pulled(NEW_YEAR), 'journal-date']])],
      [query(connectedQuery([30]), [], [row(30, ALICE, 'outbound', 2), row(30, BOB, 'inbound', 1)])]
    ]
  },
  {
    name: 'network: a namespace leaf',
    tool: TOOL,
    arguments: { concept_name: 'retro', max_depth: 1 },
    steps: [
      [query(RESOLVE_BY_NAME, ['"retro"'], [])],
      [query(NAMESPACE_LEAF, ['"/retro"'], [[pulled(ATLAS_RETRO)]])],
      [query(connectedQuery([60]), [], [row(60, ATLAS, 'outbound', 1)])]
    ]
  },
  call(
    // The fanout cap drops Carol at depth 1; she joins at depth 2 through Bob, but her link to the root is
    // still an edge, so her depth is 1 (#155) and the walk still says it dropped a page (#132)
    'max_fanout 1 drops a neighbour that joins later, at the distance of its edge',
    { max_fanout: 1 },
    walk(ATLAS, [
      { ids: [10], rows: [row(10, BOB, 'outbound', 3), row(10, CAROL, 'outbound', 2)] },
      { ids: [20], rows: [row(20, CAROL, 'outbound', 1), row(20, DAVE, 'outbound', 1)] }
    ])
  ),
  call(
    // The node budget keeps the best by references: non-journal first, then the count, then the lower id
    'max_nodes 3 keeps the best two',
    { max_nodes: 3, max_depth: 1 },
    walk(ATLAS, [
      {
        ids: [10],
        rows: [row(10, ERIN, 'outbound', 1), row(10, BOB, 'outbound', 2), row(10, NEW_YEAR, 'inbound', 9), row(10, CAROL, 'outbound', 2), row(10, DAVE, 'inbound', 5)]
      }
    ])
  ),
  call('max_nodes 1 leaves the root alone', { max_nodes: 1, max_depth: 1 }, walk(ATLAS, [{ ids: [10], rows: [row(10, BOB, 'outbound', 1)] }]))
];

const asMarkdown = (cases: readonly ParityCase[]): ParityCase[] =>
  cases.map(c => ({ ...c, name: c.name.replace('network:', 'network markdown:'), arguments: { ...c.arguments, format: 'markdown' } }));

// ---- the caps at their maxima, with many pages

const MANY = pagesOf(250, 1000);
const FANOUT_100 = pagesOf(130, 2000, 'wide');

/** 100 neighbours of the root (the last a journal), and 5 of them with 100 neighbours of their own. */
const DEEP_FIRST = pagesOf(99, 3000, 'first');
const DEEP_JOURNAL: Page = { id: 3999, name: 'dec 31st, 2024', originalName: 'Dec 31st, 2024', journalDay: 20241231 };
const DEEP_SECOND = (source: Page, k: number) => pagesOf(100, 5000 + k * 100, `second ${k}`).map(page => row(source.id, page, 'outbound', 1));

export const getConceptNetworkCases: ParityCase[] = [
  ...SHAPES,
  ...asMarkdown(SHAPES),
  {
    name: 'network markdown: a cut and a way to get the rest in the footer',
    tool: TOOL,
    arguments: { concept_name: 'Project Atlas', max_nodes: 3, max_depth: 1, format: 'markdown' },
    steps: walk(ATLAS, [{ ids: [10], rows: [row(10, BOB, 'outbound', 2), row(10, CAROL, 'outbound', 2), row(10, DAVE, 'inbound', 5)] }])
  },
  {
    name: 'network markdown: a name two pages declare is ambiguous',
    tool: TOOL,
    arguments: { concept_name: 'al', format: 'markdown' },
    steps: [[query(RESOLVE_BY_NAME, ['"al"'], [[pulled(ALICE), 'alias'], [pulled({ ...ALICE, id: 41, name: 'alice notes', originalName: 'Alice Notes' }), 'alias']])]]
  },

  // ---- the words of the cut
  call(
    // Below both maxima, with a suggestion that is a large result: the note is added
    'a suggestion of more than 200 pages carries the large-result note',
    { max_nodes: 100, max_fanout: 99, max_depth: 1 },
    walk(ATLAS, [{ ids: [10], rows: MANY.map((page, i) => row(10, page, 'outbound', 1 + (i % 3))) }])
  ),
  call(
    // Fanout at its maximum, and the node budget could still be raised: only that is offered
    'max_fanout at its maximum with the node budget short too',
    { max_fanout: 100, max_depth: 1 },
    walk(ATLAS, [{ ids: [10], rows: FANOUT_100.map(page => row(10, page, 'outbound', 1)) }])
  ),
  call(
    // Fanout at its maximum is all that dropped pages: nothing can be raised, and a drop at depth 1 can't be narrowed by depth
    'max_fanout at its maximum is all that cut',
    { max_fanout: 100, max_nodes: 500, max_depth: 1 },
    walk(ATLAS, [{ ids: [10], rows: FANOUT_100.map(page => row(10, page, 'inbound', 1)) }])
  ),
  call(
    // The node budget at its maximum of 500, a journal expanded before the drop: how to narrow the walk instead
    'max_nodes at its maximum, with a journal that was expanded',
    { max_nodes: 500, max_fanout: 100, expand_journals: true },
    walk(ATLAS, [
      { ids: [10], rows: [...DEEP_FIRST.map(page => row(10, page, 'outbound', 2)), row(10, DEEP_JOURNAL, 'outbound', 1)] },
      {
        ids: [...DEEP_FIRST.map(page => page.id), DEEP_JOURNAL.id],
        rows: DEEP_FIRST.slice(0, 5).flatMap((page, k) => DEEP_SECOND(page, k))
      }
    ])
  ),
  call(
    // Limits past the maxima are the maxima: nothing here is cut
    'max_nodes and max_fanout past their maxima',
    { max_nodes: 9999, max_fanout: 9999, max_depth: 1 },
    walk(ATLAS, [{ ids: [10], rows: [row(10, BOB, 'outbound', 1), row(10, CAROL, 'outbound', 1)] }])
  ),
  call('name with spaces and capitals', { concept_name: '  Project ATLAS ', max_depth: 1 }, walk(ATLAS, [{ ids: [10], rows: [row(10, BOB, 'outbound', 1)] }], '  Project ATLAS ')),
  {
    // `name`, `page` and `page_name` stand in for `concept_name` (BR-0008)
    name: 'network: parameter alias',
    tool: TOOL,
    arguments: { page_name: 'Project Atlas', max_depth: 1 },
    steps: walk(ATLAS, [{ ids: [10], rows: [row(10, BOB, 'outbound', 1)] }])
  },

  // ---- a name that is not one page
  {
    name: 'network: no such page',
    tool: TOOL,
    arguments: { concept_name: 'Projct Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"projct atlas"'], [])],
      [query(NAMESPACE_LEAF, ['"/projct atlas"'], [])],
      [editor(GET_ALL_PAGES, [], [{ originalName: 'Project Atlas' }, { originalName: 'Alice' }, { originalName: 'Bob' }])]
    ]
  },
  {
    name: 'network: a name two pages declare is ambiguous',
    tool: TOOL,
    arguments: { concept_name: 'al' },
    steps: [[query(RESOLVE_BY_NAME, ['"al"'], [[pulled({ ...ALICE, id: 41, name: 'alice notes', originalName: 'Alice Notes' }), 'alias'], [pulled(ALICE), 'alias']])]]
  },
  {
    // The resolver found a page with no name to show
    name: 'network: a root page with no name',
    tool: TOOL,
    arguments: { concept_name: 'Project Atlas' },
    steps: [[query(RESOLVE_BY_NAME, ['"project atlas"'], [[{ id: 10, 'journal?': false }, 'name']])]]
  },
  {
    name: 'network: a root page with no id',
    tool: TOOL,
    arguments: { concept_name: 'Project Atlas' },
    steps: [[query(RESOLVE_BY_NAME, ['"project atlas"'], [[{ name: 'project atlas', 'original-name': 'Project Atlas', 'journal?': false }, 'name']])]]
  },

  // ---- null is not empty, and what propagates
  {
    // PARITY: a null answer is read as no connected pages (suspected TS bug, BR-0011)
    name: 'network: the connected pages answer null',
    tool: TOOL,
    arguments: { concept_name: 'Project Atlas' },
    steps: walk(ATLAS, [{ ids: [10], rows: null }]),
    perturbed: { error: 'parity harness: perturbed answer' }
  },
  {
    name: 'network: LogSeq error from the connected pages',
    tool: TOOL,
    arguments: { concept_name: 'Project Atlas' },
    steps: walk(ATLAS, [{ ids: [10], rows: { error: 'Query timed out' } }])
  },
  {
    name: 'network: a row in a shape the server cannot read',
    tool: TOOL,
    arguments: { concept_name: 'Project Atlas' },
    steps: walk(ATLAS, [{ ids: [10], rows: [[10, 20, 'bob', 'Bob', 'no', 'outbound', 1]] }]),
    // the strings of the bad row still make it bad; a whole answer is what changes the result
    perturbed: []
  },
  {
    name: 'network: a relation that is neither direction',
    tool: TOOL,
    arguments: { concept_name: 'Project Atlas' },
    steps: walk(ATLAS, [{ ids: [10], rows: [[10, 20, 'bob', 'Bob', false, 'sideways', 1]] }]),
    // the strings of the bad row still make it bad; a whole answer is what changes the result
    perturbed: []
  },
  {
    name: 'network: a row that is too long',
    tool: TOOL,
    arguments: { concept_name: 'Project Atlas' },
    steps: walk(ATLAS, [{ ids: [10], rows: [[10, 20, 'bob', 'Bob', false, 'outbound', 1, 7]] }]),
    // the strings of the bad row still make it bad; a whole answer is what changes the result
    perturbed: []
  },
  {
    name: 'network: a row that is not a row',
    tool: TOOL,
    arguments: { concept_name: 'Project Atlas' },
    steps: walk(ATLAS, [{ ids: [10], rows: [7] }])
  },
  {
    name: 'network: a second level that fails after the first was read',
    tool: TOOL,
    arguments: { concept_name: 'Project Atlas' },
    steps: walk(ATLAS, [
      { ids: [10], rows: [row(10, BOB, 'outbound', 1)] },
      { ids: [20], rows: { error: 'Query timed out' } }
    ])
  },

  // ---- arguments, checked before any call
  { name: 'network: max_nodes below its minimum', tool: TOOL, arguments: { concept_name: 'Project Atlas', max_nodes: 0 }, steps: [] },
  { name: 'network: max_fanout below its minimum', tool: TOOL, arguments: { concept_name: 'Project Atlas', max_fanout: 0 }, steps: [] },
  { name: 'network: a negative depth', tool: TOOL, arguments: { concept_name: 'Project Atlas', max_depth: -1 }, steps: [] },
  { name: 'network: a fraction for a cap', tool: TOOL, arguments: { concept_name: 'Project Atlas', max_nodes: 2.5 }, steps: [] },
  { name: 'network: a cap that is text', tool: TOOL, arguments: { concept_name: 'Project Atlas', max_fanout: '5' }, steps: [] },
  { name: 'network: no concept', tool: TOOL, arguments: { max_depth: 1 }, steps: [] },
  { name: 'network: a concept that is not text', tool: TOOL, arguments: { concept_name: 5 }, steps: [] },
  { name: 'network: expand_journals is not a boolean', tool: TOOL, arguments: { concept_name: 'Project Atlas', expand_journals: 'yes' }, steps: [] },
  { name: 'network: format is not a known one', tool: TOOL, arguments: { concept_name: 'Project Atlas', format: 'xml' }, steps: [] }
];
