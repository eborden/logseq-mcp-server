// Parity cases for logseq_search_by_relationship (#314, #299, ADR-0025). Every page, block and name
// here is made up (BR-0001). Each case lists the LogSeq calls the TypeScript server makes, in order,
// with the answer the stub gives; the result the server printed for it is in
// ../expected/search-by-relationship.json. The two topics are resolved together, so their two
// resolver calls are one step.
import { DATASCRIPT_QUERY, type CannedCall } from '../stub-logseq.js';
import type { ParityCase } from '../harness.js';

const TOOL = 'logseq_search_by_relationship';
const GET_PAGE_BLOCKS_TREE = 'logseq.Editor.getPageBlocksTree';
const GET_ALL_PAGES = 'logseq.Editor.getAllPages';

const RESOLVE_BY_NAME =
  '[:find (pull ?page [*]) ?via :in $ ?n :where (or-join [?n ?page ?via] ' +
  '(and [?page :block/name ?n] [(ground "name") ?via]) ' +
  '(and [?stub :block/name ?n] [?page :block/alias ?stub] [(ground "alias") ?via]))]';

const RESOLVE_WITH_DAY =
  '[:find (pull ?page [*]) ?via :in $ ?n ?day :where (or-join [?n ?day ?page ?via] ' +
  '(and [?page :block/name ?n] [(ground "name") ?via]) ' +
  '(and [?stub :block/name ?n] [?page :block/alias ?stub] [(ground "alias") ?via]) ' +
  '(and [?page :block/name] [?page :block/journal-day ?day] [(ground "journal-date") ?via]))]';

const NAMESPACE_LEAF =
  '[:find (pull ?page [*]) :in $ ?suffix :where [?page :block/name ?n] [?page :block/namespace] ' +
  '[(clojure.string/ends-with? ?n ?suffix)]]';

const REFS_BY_NAME =
  '[:find (pull ?block [*]) :in $ ?page-name ?ref-name :where [?page :block/name ?page-name] ' +
  '[?ref :block/name ?ref-name] [?block :block/page ?page] [?block :block/refs ?ref]]';

const LINKING_BY_NAME =
  '[:find (pull ?block [*]) :in $ ?a-name ?b-name :where [?a :block/name ?a-name] [?b :block/name ?b-name] ' +
  '[?linker :block/refs ?b] [?linker :block/page ?page] [?block :block/page ?page] [?block :block/refs ?a]]';

const ground = (ids: number[], variable: string) => `[(ground [${ids.join(' ')}]) [${variable} ...]]`;

const refsByIds = (pages: number[], refs: number[]) =>
  `[:find (pull ?block [*]) :where ${ground(pages, '?page')} ${ground(refs, '?ref')} [?block :block/page ?page] [?block :block/refs ?ref]]`;

const linkingByIds = (a: number[], b: number[]) =>
  `[:find (pull ?block [*]) :where ${ground(a, '?a')} ${ground(b, '?b')} [?linker :block/refs ?b] [?linker :block/page ?page] ` +
  '[?block :block/page ?page] [?block :block/refs ?a]]';

const neighborsQuery = (ids: number[]) =>
  `[:find ?neighbor :where ${ground(ids, '?p')} (or-join [?p ?neighbor] ` +
  '(and [?block :block/page ?p] [?block :block/refs ?neighbor] [?neighbor :block/name]) ' +
  '(and [?block :block/refs ?p] [?block :block/page ?neighbor] [?neighbor :block/name]))]';

const aliasSetsQuery = (ids: number[]) =>
  `[:find ?start (pull ?m [:db/id :block/name :block/original-name]) :where ${ground(ids, '?start')} ` +
  '(or-join [?start ?m] (or-join [?start ?m] [?start :block/alias ?m] [?m :block/alias ?start]) ' +
  '(and (or-join [?start ?alias-mid] [?start :block/alias ?alias-mid] [?alias-mid :block/alias ?start]) ' +
  '(or-join [?alias-mid ?m] [?alias-mid :block/alias ?m] [?m :block/alias ?alias-mid])))]';

const query = (text: string, inputs: string[], response: unknown): CannedCall => ({
  method: DATASCRIPT_QUERY,
  args: [text, ...inputs],
  response
});

const treeCall = (name: string, response: unknown): CannedCall => ({ method: GET_PAGE_BLOCKS_TREE, args: [name], response });

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

interface Page {
  id: number;
  name: string;
  originalName: string;
  file?: boolean;
  /** Ids of the pages this one is linked to by `alias::` */
  alias?: number[];
  journalDay?: number;
}

/** A page as `pull [*]` returns it: kebab-case keys. */
const pulled = ({ id, name, originalName, file = true, alias, journalDay }: Page) => ({
  id,
  uuid: uuid(id),
  name,
  'original-name': originalName,
  ...(file ? { file: { id: id + 5000 } } : {}),
  ...(alias ? { alias: alias.map(a => ({ id: a })) } : {}),
  ...(journalDay ? { 'journal?': true, 'journal-day': journalDay } : { 'journal?': false })
});

/** A page's alias-group row: `[startId, member]`. */
const member = (start: number, { id, name, originalName }: Page) => [start, { id, name, 'original-name': originalName }];

const ATLAS: Page = { id: 10, name: 'atlas', originalName: 'Atlas' };
const ATLAS_WITH_ALIAS: Page = { ...ATLAS, alias: [11] };
const PROJECT_ATLAS: Page = { id: 11, name: 'project atlas', originalName: 'Project Atlas', file: false, alias: [10] };
const BOB: Page = { id: 20, name: 'bob', originalName: 'Bob' };
const BOB_WITH_ALIAS: Page = { ...BOB, alias: [21] };
const ROBERT: Page = { id: 21, name: 'robert', originalName: 'Robert', file: false, alias: [20] };
const NEW_YEAR: Page = { id: 30, name: 'jan 1st, 2025', originalName: 'Jan 1st, 2025', journalDay: 20250101 };
const ATLAS_RETRO: Page = { id: 60, name: 'atlas/retro', originalName: 'Atlas/Retro' };
const ALICE: Page = { id: 40, name: 'alice', originalName: 'Alice' };
const ALICE_NOTES: Page = { id: 41, name: 'alice notes', originalName: 'Alice Notes' };

/** A block as the Datalog `[*]` pull sends it: kebab-case keys, bare `{ id }` for page, parent and left. */
const pulledBlock = (id: number, page: number, extra: Record<string, unknown> = {}) => [
  {
    id,
    uuid: uuid(id),
    content: `Block ${id} mentions [[Bob]]`,
    format: 'markdown',
    page: { id: page },
    parent: { id: page },
    left: { id: page },
    refs: [{ id: 20 }],
    'path-refs': [{ id: page }, { id: 20 }],
    ...extra
  }
];

/** A block as the Editor API's page tree sends it: camelCase keys, its children nested. */
const treeBlock = (id: number, page: number, children: unknown[] = []) => ({
  id,
  uuid: uuid(id),
  content: `Tree block ${id}`,
  format: 'markdown',
  page: { id: page },
  parent: { id: page },
  left: { id: page },
  children
});

/** The resolver call for an exact name, answered with the page. */
const resolveExact = (page: Page, input: string, asPulled: object = pulled(page)) =>
  query(RESOLVE_BY_NAME, [JSON.stringify(input.trim().toLowerCase())], [[asPulled, 'name']]);

const base = { topic_a: 'Atlas', topic_b: 'Bob' };

export const searchByRelationshipCases: ParityCase[] = [
  // --- references, referenced-by, in-pages-linking-to ----------------------------------------
  {
    // The blocks keep LogSeq's keys, and a property name that is an integer comes first, as
    // JSON.parse and JSON.stringify have it
    name: 'relationship: references, exact names',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references' },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [
        query(REFS_BY_NAME, ['"atlas"', '"bob"'], [
          pulledBlock(101, 10, { properties: { status: 'done', '2024': 'kickoff' }, 'properties-text-values': { status: 'done' } }),
          pulledBlock(102, 10),
          [null]
        ])
      ]
    ]
  },
  {
    name: 'relationship: in-pages-linking-to',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'in-pages-linking-to' },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(LINKING_BY_NAME, ['"atlas"', '"bob"'], [pulledBlock(301, 30), pulledBlock(302, 31)])]
    ]
  },
  {
    // `referenced-by` runs the same query as in-pages-linking-to, though its description says otherwise
    name: 'relationship: referenced-by',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'referenced-by' },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(LINKING_BY_NAME, ['"atlas"', '"bob"'], [pulledBlock(301, 30)])]
    ]
  },
  {
    name: 'relationship: nothing matches',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references' },
    steps: [[resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')], [query(REFS_BY_NAME, ['"atlas"', '"bob"'], [])]]
  },
  {
    // null is read as no rows, so the result is an empty list (suspected TS bug, BR-0011)
    name: 'relationship: the query answers null',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references' },
    steps: [[resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')], [query(REFS_BY_NAME, ['"atlas"', '"bob"'], null)]]
  },
  {
    // An error from the query is an error result, not an empty list (BR-0003)
    name: 'relationship: LogSeq error from the query',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references' },
    steps: [[resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')], [query(REFS_BY_NAME, ['"atlas"', '"bob"'], { error: 'Query timed out' })]]
  },
  {
    // A block in a shape the server cannot read: no string in the answer, so the self-check can
    // perturb it into an error of another kind
    name: 'relationship: a block in a shape the server cannot read',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references' },
    steps: [[resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')], [query(REFS_BY_NAME, ['"atlas"', '"bob"'], [[{ id: 1 }]])]]
  },
  {
    // The same name (ignoring case and spaces) is resolved once, so there is one resolver call, and
    // the page's own text is handed on for both
    name: 'relationship: the same name twice is resolved once',
    tool: TOOL,
    arguments: { topic_a: 'Atlas', topic_b: '  ATLAS ', relationship_type: 'in-pages-linking-to' },
    steps: [[resolveExact(ATLAS, 'Atlas')], [query(LINKING_BY_NAME, ['"atlas"', '"atlas"'], [pulledBlock(301, 30)])]]
  },
  {
    // An alias and a date say which page they stood for, and hand on the page's own name
    name: 'relationship: topics that are an alias and a date',
    tool: TOOL,
    arguments: { topic_a: 'Project Alpha', topic_b: '2025-01-01', relationship_type: 'references' },
    steps: [
      [
        query(RESOLVE_BY_NAME, ['"project alpha"'], [[pulled(ATLAS), 'alias']]),
        query(RESOLVE_WITH_DAY, ['"2025-01-01"', '20250101'], [[pulled(NEW_YEAR), 'journal-date']])
      ],
      [query(REFS_BY_NAME, ['"atlas"', '"jan 1st, 2025"'], [pulledBlock(101, 10)])]
    ]
  },
  {
    name: 'relationship: a topic that is a namespace leaf',
    tool: TOOL,
    arguments: { topic_a: 'retro', topic_b: 'Bob', relationship_type: 'references' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"retro"'], []), resolveExact(BOB, 'Bob')],
      [query(NAMESPACE_LEAF, ['"/retro"'], [[pulled(ATLAS_RETRO)]])],
      [query(REFS_BY_NAME, ['"atlas/retro"', '"bob"'], [pulledBlock(601, 60)])]
    ]
  },

  // --- alias groups --------------------------------------------------------------------------
  {
    // One alias query for both topics' pages; the query then matches by the ids of each group, and
    // resolvedAliases names the topic that has them
    name: 'relationship aliases: references by the ids of the groups',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references' },
    steps: [
      [resolveExact(ATLAS, 'Atlas', pulled(ATLAS_WITH_ALIAS)), resolveExact(BOB, 'Bob')],
      [query(aliasSetsQuery([10]), [], [member(10, ATLAS), member(10, PROJECT_ATLAS)])],
      [query(refsByIds([10, 11], [20]), [], [pulledBlock(101, 10), pulledBlock(102, 11)])]
    ]
  },
  {
    // Both topics have aliases: one query covers both, and each is reported under its own key
    name: 'relationship aliases: both topics',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'in-pages-linking-to' },
    steps: [
      [resolveExact(ATLAS, 'Atlas', pulled(ATLAS_WITH_ALIAS)), resolveExact(BOB, 'Bob', pulled(BOB_WITH_ALIAS))],
      [
        query(aliasSetsQuery([10, 20]), [], [
          member(10, ATLAS),
          member(10, PROJECT_ATLAS),
          member(20, BOB),
          member(20, ROBERT)
        ])
      ],
      [query(linkingByIds([10, 11], [20, 21]), [], [pulledBlock(301, 30)])]
    ]
  },
  {
    // Only topic B has aliases: topic A's group is the page alone, and its id goes in the query
    name: 'relationship aliases: only the second topic',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references' },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob', pulled(BOB_WITH_ALIAS))],
      [query(aliasSetsQuery([20]), [], [member(20, BOB), member(20, ROBERT)])],
      [query(refsByIds([10], [20, 21]), [], [pulledBlock(101, 10)])]
    ]
  },
  {
    // A page with an alias link whose group is the page alone has no aliases to report
    name: 'relationship aliases: an alias link whose group is the page alone',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references' },
    steps: [
      [resolveExact(ATLAS, 'Atlas', pulled(ATLAS_WITH_ALIAS)), resolveExact(BOB, 'Bob')],
      [query(aliasSetsQuery([10]), [], [member(10, ATLAS)])],
      [query(REFS_BY_NAME, ['"atlas"', '"bob"'], [pulledBlock(101, 10)])]
    ]
  },
  {
    // The alias lookup answered null: read as no aliases (suspected TS bug, BR-0011)
    name: 'relationship aliases: the alias lookup answers null',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references' },
    steps: [
      [resolveExact(ATLAS, 'Atlas', pulled(ATLAS_WITH_ALIAS)), resolveExact(BOB, 'Bob')],
      [query(aliasSetsQuery([10]), [], null)],
      [query(REFS_BY_NAME, ['"atlas"', '"bob"'], [])]
    ]
  },
  {
    // zod's tuple rule (#344): a row two cells short is "Too small" at the row, before any cell is read.
    // No string in the answer, so the self-check can perturb it into an error of another kind
    name: 'relationship aliases: an alias row two cells short',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references' },
    steps: [
      [resolveExact(ATLAS, 'Atlas', pulled(ATLAS_WITH_ALIAS)), resolveExact(BOB, 'Bob')],
      [query(aliasSetsQuery([10]), [], [[]])]
    ]
  },
  {
    // One cell short is read, with the member as undefined, so the error is at the cell and not the row
    name: 'relationship aliases: an alias row one cell short',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references' },
    steps: [
      [resolveExact(ATLAS, 'Atlas', pulled(ATLAS_WITH_ALIAS)), resolveExact(BOB, 'Bob')],
      [query(aliasSetsQuery([10]), [], [[10]])]
    ]
  },
  {
    // A group of 60 is cut to the page and 49 aliases, by name, and the cut is said once for both topics
    name: 'relationship aliases: a group past the cap',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references' },
    steps: [
      [resolveExact(ATLAS, 'Atlas', pulled({ ...ATLAS, alias: [100] })), resolveExact(BOB, 'Bob')],
      [
        query(aliasSetsQuery([10]), [], [
          member(10, ATLAS),
          ...Array.from({ length: 60 }, (_, i) =>
            member(10, { id: 100 + i, name: `member ${String(59 - i).padStart(2, '0')}`, originalName: `Member ${String(59 - i).padStart(2, '0')}` })
          )
        ])
      ],
      // `member 00` has id 159, `member 01` 158 and so on: the first 49 by name are 159 down to 111
      [query(refsByIds([10, ...Array.from({ length: 49 }, (_, k) => 159 - k)], [20]), [], [pulledBlock(101, 10)])]
    ]
  },
  {
    // A topic and its alias are one page: the alias warning is said once, not for each name
    name: 'relationship aliases: a page and its alias are one topic',
    tool: TOOL,
    arguments: { topic_a: 'Atlas', topic_b: 'Project Atlas', relationship_type: 'references' },
    steps: [
      [
        resolveExact(ATLAS, 'Atlas', pulled(ATLAS_WITH_ALIAS)),
        query(RESOLVE_BY_NAME, ['"project atlas"'], [[pulled(PROJECT_ATLAS), 'name'], [pulled(ATLAS_WITH_ALIAS), 'alias']])
      ],
      [query(aliasSetsQuery([10]), [], [member(10, ATLAS), member(10, PROJECT_ATLAS)])],
      [query(refsByIds([10, 11], [10, 11]), [], [pulledBlock(101, 10)])]
    ]
  },

  // --- the cut -------------------------------------------------------------------------------
  {
    name: 'relationship cut: limit below the matches',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references', limit: 2 },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(REFS_BY_NAME, ['"atlas"', '"bob"'], [pulledBlock(101, 10), pulledBlock(102, 10), pulledBlock(103, 10)])]
    ]
  },
  {
    name: 'relationship cut: limit 0 keeps nothing',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'in-pages-linking-to', limit: 0 },
    // perturbed: no block, so nothing is cut and there is no warning
    perturbed: [],
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(LINKING_BY_NAME, ['"atlas"', '"bob"'], [pulledBlock(301, 30)])]
    ]
  },
  {
    // 501 blocks and a limit of 600: the cap is 500, the warning says so and names what was asked for
    name: 'relationship cut: limit past the maximum',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references', limit: 600 },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [
        query(
          REFS_BY_NAME,
          ['"atlas"', '"bob"'],
          Array.from({ length: 501 }, (_, i) => [{ id: 1000 + i, uuid: uuid(1000 + i) }])
        )
      ]
    ]
  },
  {
    // An exact fit is not a cut
    name: 'relationship cut: matches equal to the limit',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references', limit: 2 },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(REFS_BY_NAME, ['"atlas"', '"bob"'], [pulledBlock(101, 10), pulledBlock(102, 10)])]
    ]
  },

  // --- connected-within ----------------------------------------------------------------------
  {
    // Found at the first hop: the walk stops, then the two page trees (topic A's first)
    name: 'connected: found at the first hop',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within' },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(neighborsQuery([10]), [], [[31], [20], [32]])],
      [treeCall('Atlas', [treeBlock(101, 10, [treeBlock(102, 10)])])],
      [treeCall('Bob', [treeBlock(201, 20)])]
    ]
  },
  {
    // Found at the second hop, from the pages the first hop reached (the ones already visited are
    // not walked again)
    name: 'connected: found at the second hop',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within', max_distance: 3 },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(neighborsQuery([10]), [], [[31], [10], [32]])],
      [query(neighborsQuery([31, 32]), [], [[33], [20]])],
      [treeCall('Atlas', [treeBlock(101, 10)])],
      [treeCall('Bob', [])]
    ]
  },
  {
    // Not connected within the distance: no trees, no results, and no warning
    name: 'connected: not connected within the distance',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within', max_distance: 2 },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(neighborsQuery([10]), [], [[31]])],
      [query(neighborsQuery([31]), [], [[32], [31]])]
    ]
  },
  {
    // A walk that runs out of new pages stops before max_distance
    name: 'connected: the walk runs out of pages',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within', max_distance: 5 },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(neighborsQuery([10]), [], [[31]])],
      [query(neighborsQuery([31]), [], [[10]])]
    ]
  },
  {
    // max_distance 1 walks one hop, and 0 walks none
    name: 'connected: one hop only',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within', max_distance: 1 },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(neighborsQuery([10]), [], [[31]])]
    ]
  },
  {
    name: 'connected: distance zero',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within', max_distance: 0 },
    steps: [[resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')]]
  },
  {
    // A walk that finds nothing and a hop answered null: read as no neighbours (suspected TS bug, BR-0011)
    name: 'connected: the hop answers null',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within' },
    steps: [[resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')], [query(neighborsQuery([10]), [], null)]]
  },
  {
    // The tree answered null: read as a page with no blocks (suspected TS bug, BR-0011)
    name: 'connected: a page tree answers null',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within' },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(neighborsQuery([10]), [], [[20]])],
      [treeCall('Atlas', null)],
      [treeCall('Bob', [treeBlock(201, 20)])]
    ]
  },
  {
    // A hop of 600 pages expands the 500 with the lowest ids, and says "not connected" may be wrong
    name: 'connected: a hop past the frontier cap that finds nothing',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within' },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(neighborsQuery([10]), [], Array.from({ length: 600 }, (_, i) => [1599 - i]))],
      [query(neighborsQuery(Array.from({ length: 500 }, (_, i) => 1000 + i)), [], [])]
    ]
  },
  {
    // A found connection is real, so a cut hop before it says nothing
    name: 'connected: a hop past the frontier cap that finds the page',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within' },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(neighborsQuery([10]), [], Array.from({ length: 600 }, (_, i) => [1599 - i]))],
      [query(neighborsQuery(Array.from({ length: 500 }, (_, i) => 1000 + i)), [], [[20]])],
      [treeCall('Atlas', [treeBlock(101, 10)])],
      [treeCall('Bob', [treeBlock(201, 20)])]
    ]
  },
  {
    // The walk starts from every name of topic A and ends at any name of topic B
    name: 'connected aliases: seeded by every name of A, ended by any name of B',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within' },
    steps: [
      [resolveExact(ATLAS, 'Atlas', pulled(ATLAS_WITH_ALIAS)), resolveExact(BOB, 'Bob', pulled(BOB_WITH_ALIAS))],
      [
        query(aliasSetsQuery([10, 20]), [], [
          member(10, ATLAS),
          member(10, PROJECT_ATLAS),
          member(20, BOB),
          member(20, ROBERT)
        ])
      ],
      [query(neighborsQuery([10, 11]), [], [[31], [21]])],
      [treeCall('Atlas', [treeBlock(101, 10)])],
      [treeCall('Bob', [treeBlock(201, 20)])]
    ]
  },
  {
    // A name B shares with A starts the walk, so reaching it proves nothing
    name: 'connected aliases: a name both topics share ends nothing',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within' },
    steps: [
      [resolveExact(ATLAS, 'Atlas', pulled(ATLAS_WITH_ALIAS)), resolveExact(BOB, 'Bob', pulled({ ...BOB, alias: [11] }))],
      [
        query(aliasSetsQuery([10, 20]), [], [
          member(10, ATLAS),
          member(10, PROJECT_ATLAS),
          member(20, BOB),
          member(20, PROJECT_ATLAS)
        ])
      ],
      [query(neighborsQuery([10, 11]), [], [[11], [32]])],
      [query(neighborsQuery([32]), [], [])]
    ]
  },
  {
    // The same name twice: one page, nothing to connect, no walk
    name: 'connected: the same name twice',
    tool: TOOL,
    arguments: { topic_a: 'Atlas', topic_b: 'atlas', relationship_type: 'connected-within' },
    steps: [[resolveExact(ATLAS, 'Atlas')]]
  },
  {
    // A page and its alias are one page: no walk, and a same_topic warning that names both as typed
    name: 'connected aliases: a page and its alias',
    tool: TOOL,
    arguments: { topic_a: 'Atlas', topic_b: 'Project Atlas', relationship_type: 'connected-within' },
    steps: [
      [
        resolveExact(ATLAS, 'Atlas', pulled(ATLAS_WITH_ALIAS)),
        query(RESOLVE_BY_NAME, ['"project atlas"'], [[pulled(PROJECT_ATLAS), 'name'], [pulled(ATLAS_WITH_ALIAS), 'alias']])
      ],
      [query(aliasSetsQuery([10]), [], [member(10, ATLAS), member(10, PROJECT_ATLAS)])]
    ]
  },
  {
    // Asked by the alias alone: the page resolved from the alias is the page
    name: 'connected aliases: an alias and the page it names',
    tool: TOOL,
    arguments: { topic_a: 'Project Alpha', topic_b: 'Atlas', relationship_type: 'connected-within' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"project alpha"'], [[pulled(ATLAS), 'alias']]), resolveExact(ATLAS, 'Atlas')]
    ]
  },
  {
    // limit cuts the two trees together, nested blocks counted, topic A's first. 103 loses its child
    name: 'connected cut: the limit falls inside topic A',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within', limit: 3 },
    // perturbed: topic B's page has no block, so the totals differ
    perturbed: [],
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(neighborsQuery([10]), [], [[20]])],
      [
        treeCall('Atlas', [
          treeBlock(101, 10, [treeBlock(102, 10), treeBlock(103, 10, [treeBlock(104, 10)])]),
          treeBlock(105, 10)
        ])
      ],
      [treeCall('Bob', [treeBlock(201, 20), treeBlock(202, 20)])]
    ]
  },
  {
    // The limit falls inside topic B: all of A, then part of B
    name: 'connected cut: the limit falls inside topic B',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within', limit: 6 },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(neighborsQuery([10]), [], [[20]])],
      [
        treeCall('Atlas', [
          treeBlock(101, 10, [treeBlock(102, 10), treeBlock(103, 10, [treeBlock(104, 10)])]),
          treeBlock(105, 10)
        ])
      ],
      [treeCall('Bob', [treeBlock(201, 20, [treeBlock(203, 20)]), treeBlock(202, 20)])]
    ]
  },
  {
    // A limit that equals the blocks is not a cut
    name: 'connected cut: the limit equals the blocks',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within', limit: 3 },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(neighborsQuery([10]), [], [[20]])],
      [treeCall('Atlas', [treeBlock(101, 10, [treeBlock(102, 10)])])],
      [treeCall('Bob', [treeBlock(201, 20)])]
    ]
  },
  {
    name: 'connected cut: limit 0 keeps nothing',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within', limit: 0 },
    perturbed: [],
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(neighborsQuery([10]), [], [[20]])],
      [treeCall('Atlas', [treeBlock(101, 10)])],
      [treeCall('Bob', [treeBlock(201, 20)])]
    ]
  },
  {
    // maxDistance is in the echoed query only for connected-within
    name: 'connected: the echoed query carries max_distance',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within', max_distance: 1 },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), resolveExact(BOB, 'Bob')],
      [query(neighborsQuery([10]), [], [[20]])],
      [treeCall('Atlas', [])],
      [treeCall('Bob', [])]
    ]
  },

  // --- topics that are not one page ----------------------------------------------------------
  {
    // The second topic is no page: its leaf lookup and the closest names, while the first is resolved
    name: 'relationship errors: a topic that is no page',
    tool: TOOL,
    arguments: { topic_a: 'Atlas', topic_b: 'Bb', relationship_type: 'references' },
    steps: [
      [resolveExact(ATLAS, 'Atlas'), query(RESOLVE_BY_NAME, ['"bb"'], [])],
      [query(NAMESPACE_LEAF, ['"/bb"'], [])],
      [{ method: GET_ALL_PAGES, args: [], response: [{ id: 20, name: 'bob', originalName: 'Bob' }, { id: 10, name: 'atlas', originalName: 'Atlas' }] }]
    ]
  },
  {
    // The first topic is no page and the second is ambiguous: the first's error is the one thrown, with
    // its closest names, while the second's lookup still ran
    name: 'relationship errors: a missing topic and an ambiguous one',
    tool: TOOL,
    arguments: { topic_a: 'Alas', topic_b: 'al', relationship_type: 'references' },
    steps: [
      [
        query(RESOLVE_BY_NAME, ['"alas"'], []),
        query(RESOLVE_BY_NAME, ['"al"'], [[pulled(ALICE), 'alias'], [pulled(ALICE_NOTES), 'alias']])
      ],
      [query(NAMESPACE_LEAF, ['"/alas"'], [])],
      [{ method: GET_ALL_PAGES, args: [], response: [{ id: 10, name: 'atlas', originalName: 'Atlas' }] }]
    ]
  },
  {
    name: 'relationship errors: an ambiguous topic',
    tool: TOOL,
    arguments: { topic_a: 'Atlas', topic_b: 'al', relationship_type: 'references' },
    steps: [
      [
        resolveExact(ATLAS, 'Atlas'),
        query(RESOLVE_BY_NAME, ['"al"'], [[pulled(ALICE), 'alias'], [pulled(ALICE_NOTES), 'alias']])
      ]
    ]
  },
  {
    name: 'relationship errors: LogSeq error from a resolver',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references' },
    steps: [[resolveExact(ATLAS, 'Atlas'), query(RESOLVE_BY_NAME, ['"bob"'], { error: 'Query timed out' })]]
  },

  // --- arguments, read in the order of the schema ---------------------------------------------
  {
    name: 'relationship arguments: topic_a missing',
    tool: TOOL,
    arguments: { topic_b: 'Bob', relationship_type: 'references' },
    steps: []
  },
  {
    name: 'relationship arguments: topic_b is not text',
    tool: TOOL,
    arguments: { topic_a: 'Atlas', topic_b: 5, relationship_type: 'references' },
    steps: []
  },
  {
    name: 'relationship arguments: relationship_type missing',
    tool: TOOL,
    arguments: { ...base },
    steps: []
  },
  {
    name: 'relationship arguments: relationship_type is not one of the words',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'linked-to' },
    steps: []
  },
  {
    name: 'relationship arguments: relationship_type is not text',
    tool: TOOL,
    arguments: { ...base, relationship_type: ['references'] },
    steps: []
  },
  {
    name: 'relationship arguments: max_distance below zero',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'connected-within', max_distance: -1 },
    steps: []
  },
  {
    name: 'relationship arguments: limit is a fraction',
    tool: TOOL,
    arguments: { ...base, relationship_type: 'references', limit: 2.5 },
    steps: []
  },
  {
    // The first bad argument in schema order is the one reported
    name: 'relationship arguments: the first bad one is reported',
    tool: TOOL,
    arguments: { topic_a: 'Atlas', topic_b: 'Bob', relationship_type: 'nope', max_distance: 'far', limit: -1 },
    steps: []
  }
];
