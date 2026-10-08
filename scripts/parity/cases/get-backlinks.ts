// Parity cases for logseq_get_backlinks and the alias groups it uses (#307, #299, ADR-0025). Every
// page, block and name here is made up (BR-0001). Each case lists the LogSeq calls the TypeScript
// server makes, in order, with the answer the stub gives; the result the server printed for it is
// in ../expected/get-backlinks.json.
import { DATASCRIPT_QUERY, type CannedCall } from '../stub-logseq.js';
import type { ParityCase } from '../harness.js';

const TOOL = 'logseq_get_backlinks';
const LINKED_REFERENCES = 'logseq.Editor.getPageLinkedReferences';

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

const aliasSetsQuery = (ids: number[]) =>
  `[:find ?start (pull ?m [:db/id :block/name :block/original-name]) :where [(ground [${ids.join(' ')}]) [?start ...]] ` +
  '(or-join [?start ?m] (or-join [?start ?m] [?start :block/alias ?m] [?m :block/alias ?start]) ' +
  '(and (or-join [?start ?alias-mid] [?start :block/alias ?alias-mid] [?alias-mid :block/alias ?start]) ' +
  '(or-join [?alias-mid ?m] [?alias-mid :block/alias ?m] [?m :block/alias ?alias-mid])))]';

const linkedReferencesQuery = (ids: number[]) =>
  '[:find (pull ?block [* {:block/page [:db/id :block/name :block/original-name :block/journal-day]}]) :where ' +
  `[(ground [${ids.join(' ')}]) [?p ...]] [?block :block/path-refs ?p] [?block :block/page ?source] ` +
  `(not [(ground [${ids.join(' ')}]) [?source ...]])]`;

const query = (text: string, inputs: string[], response: unknown): CannedCall => ({
  method: DATASCRIPT_QUERY,
  args: [text, ...inputs],
  response
});

const editorCall = (name: string, response: unknown): CannedCall => ({ method: LINKED_REFERENCES, args: [name], response });

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

/** A page as the Editor API sends a source page of a linked reference: camelCase keys. */
const editorPage = ({ id, name, originalName, journalDay }: Page) => ({
  id,
  name,
  originalName,
  ...(journalDay ? { 'journal?': true, journalDay } : { 'journal?': false })
});

/** A page's alias-group row: `[startId, member]`. */
const member = (start: number, { id, name, originalName }: Page) => [start, { id, name, 'original-name': originalName }];

const ATLAS: Page = { id: 10, name: 'atlas', originalName: 'Atlas' };
const ATLAS_WITH_ALIAS: Page = { ...ATLAS, alias: [11] };
const PROJECT_ATLAS: Page = { id: 11, name: 'project atlas', originalName: 'Project Atlas', file: false, alias: [10] };
const ALICE: Page = { id: 40, name: 'alice', originalName: 'Alice' };
const ALICE_NOTES: Page = { id: 41, name: 'alice notes', originalName: 'Alice Notes' };
const BOB: Page = { id: 20, name: 'bob', originalName: 'Bob' };
const CAROL: Page = { id: 21, name: 'carol', originalName: 'Carol' };
const NEW_YEAR: Page = { id: 30, name: 'jan 1st, 2025', originalName: 'Jan 1st, 2025', journalDay: 20250101 };
const ATLAS_RETRO: Page = { id: 60, name: 'atlas/retro', originalName: 'Atlas/Retro' };

/** A linking block as the Editor API sends it: camelCase keys, a bare `{ id }` for page, parent and left. */
const editorBlock = (id: number, page: number, extra: Record<string, unknown> = {}) => ({
  id,
  uuid: uuid(id),
  content: `Mentions [[Atlas]] (${id})`,
  format: 'markdown',
  page: { id: page },
  parent: { id: page },
  left: { id: page },
  ...extra
});

/** The blocks of a source page, `count` of them numbered from `base`. */
const editorBlocks = (page: Page, count: number, base: number) =>
  Array.from({ length: count }, (_, i) => editorBlock(base + i, page.id, { 'journal?': false }));

/** A block as the aliased Datalog query pulls it: kebab-case keys, its page nested. */
const pulledBlock = (id: number, page: Page, extra: Record<string, unknown> = {}) => [
  {
    id,
    uuid: uuid(id),
    content: `Mentions [[Project Atlas]] (${id})`,
    format: 'markdown',
    'path-refs': [{ id: 11 }],
    parent: { id: page.id },
    left: { id: page.id },
    page: {
      id: page.id,
      name: page.name,
      'original-name': page.originalName,
      ...(page.journalDay ? { 'journal-day': page.journalDay } : {})
    },
    ...extra
  }
];

/** `n` source pages named `page 00`, `page 01`, ..., each with `blocksEach` blocks. */
const manyPages = (n: number, blocksEach: number, base = 100) =>
  Array.from({ length: n }, (_, i): [unknown, unknown[]] => {
    const page: Page = { id: base + i, name: `page ${String(i).padStart(2, '0')}`, originalName: `Page ${String(i).padStart(2, '0')}` };
    return [editorPage(page), editorBlocks(page, blocksEach, (base + i) * 1000)];
  });

/** The resolver and the Editor call for an exact name on a page with no aliases. */
const exactSteps = (page: Page, input: string, answer: unknown): CannedCall[][] => [
  [query(RESOLVE_BY_NAME, [JSON.stringify(input.trim().toLowerCase())], [[pulled(page), 'name']])],
  [editorCall(input.trim(), answer)]
];

export const getBacklinksCases: ParityCase[] = [
  {
    // Ranked by linking blocks, then name, then id; the blocks keep LogSeq's keys, and a property
    // name that is an integer comes first, as JSON.parse and JSON.stringify have it
    name: 'backlinks: exact name, ranked, entities as sent',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: exactSteps(ATLAS, 'Atlas', [
      [editorPage(BOB), [editorBlock(201, 20)]],
      [editorPage(ALICE), [editorBlock(401, 40, { properties: { status: 'done', '2024': 'kickoff' } }), editorBlock(402, 40)]],
      [editorPage(CAROL), [editorBlock(211, 21)]],
      [editorPage(NEW_YEAR), [editorBlock(301, 30, { 'journal?': true, journalDay: 20250101 })]]
    ])
  },
  {
    // The tuple's page can be null: the blocks name the source (rank, and the warning's name)
    name: 'backlinks: a tuple with no page',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_blocks_per_page: 1 },
    steps: exactSteps(ATLAS, 'Atlas', [
      [null, [{ ...editorBlock(501, 50), page: { id: 50, name: 'zed', originalName: 'Zed' } }, editorBlock(502, 50)]],
      [editorPage(BOB), [editorBlock(201, 20)]]
    ])
  },
  {
    // Plain code-unit order, as `<` compares: an astral character (a surrogate pair, D83D) is
    // below U+E000, though it is the greater code point
    name: 'backlinks: tie broken by code unit',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: exactSteps(ATLAS, 'Atlas', [
      [{ id: 71, name: 'a', originalName: 'A' }, [editorBlock(701, 71)]],
      [{ id: 72, name: 'a\u{1F680}', originalName: 'A\u{1F680}' }, [editorBlock(702, 72)]],
      [{ id: 73, name: 'a', originalName: 'A' }, [editorBlock(703, 73)]]
    ])
  },
  {
    name: 'backlinks: no page links here',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: exactSteps(ATLAS, 'Atlas', [])
  },
  {
    // null is not []: the result is `null`, there is no meta and no tip (BR-0011)
    name: 'backlinks: LogSeq answers null',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: exactSteps(ATLAS, 'Atlas', null)
  },
  {
    // The exact name's own text is handed on, trimmed; the tip names the page as it was typed
    name: 'backlinks: name with spaces around it',
    tool: TOOL,
    arguments: { page_name: '  Atlas ' },
    steps: exactSteps(ATLAS, '  Atlas ', [[editorPage(BOB), [editorBlock(201, 20)]]])
  },
  {
    // A name that isn't exact says which page it is (resolvedFrom) and hands on the page's own name
    name: 'backlinks: alias name',
    tool: TOOL,
    arguments: { page_name: 'Project Alpha' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"project alpha"'], [[pulled(ATLAS), 'alias']])],
      [editorCall('atlas', [[editorPage(BOB), [editorBlock(201, 20)]]])]
    ]
  },
  {
    name: 'backlinks: ISO date of a journal',
    tool: TOOL,
    arguments: { page_name: '2025-01-01' },
    steps: [
      [query(RESOLVE_WITH_DAY, ['"2025-01-01"', '20250101'], [[pulled(NEW_YEAR), 'journal-date']])],
      [editorCall('jan 1st, 2025', [[editorPage(ALICE), [editorBlock(401, 40)]]])]
    ]
  },
  {
    name: 'backlinks: namespace leaf',
    tool: TOOL,
    arguments: { page_name: 'retro' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"retro"'], [])],
      [query(NAMESPACE_LEAF, ['"/retro"'], [[pulled(ATLAS_RETRO)]])],
      [editorCall('atlas/retro', [])]
    ]
  },
  {
    // `name` and `page` are accepted for `page_name` (BR-0008)
    name: 'backlinks: parameter alias',
    tool: TOOL,
    arguments: { page: 'Atlas' },
    steps: exactSteps(ATLAS, 'Atlas', [[editorPage(BOB), [editorBlock(201, 20)]]])
  },

  // --- alias groups --------------------------------------------------------------------------
  {
    // One alias query for the group, then one Datalog query over every id of it in place of the
    // Editor call: entities camelCased, a repeated block once, blocks by id, pages most-linking
    // first, and the names the call covered
    name: 'aliases: a page with aliases reads the whole group from one query',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulled(ATLAS_WITH_ALIAS), 'name']])],
      [query(aliasSetsQuery([10]), [], [member(10, ATLAS), member(10, PROJECT_ATLAS)])],
      [
        query(linkedReferencesQuery([10, 11]), [], [
          pulledBlock(405, ALICE, { properties: { 'logseq.order-list-type': 'number', status: 'done' }, 'properties-order': ['logseq.order-list-type', 'status'] }),
          pulledBlock(201, BOB),
          [null],
          pulledBlock(401, ALICE),
          pulledBlock(401, ALICE, { content: 'The same block again' }),
          pulledBlock(301, NEW_YEAR),
          pulledBlock(402, ALICE, { 'properties-text-values': { 'my-key': 'x' } })
        ])
      ]
    ]
  },
  {
    // Asked by the other name of the group: the same blocks, and resolvedFrom says what was asked
    name: 'aliases: the alias name of a page with aliases',
    tool: TOOL,
    arguments: { page_name: 'Project Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"project atlas"'], [[pulled(PROJECT_ATLAS), 'name'], [pulled(ATLAS_WITH_ALIAS), 'alias']])],
      [query(aliasSetsQuery([10]), [], [member(10, PROJECT_ATLAS), member(10, ATLAS)])],
      [query(linkedReferencesQuery([10, 11]), [], [pulledBlock(201, BOB)])]
    ]
  },
  {
    // An alias link with nothing else in the group: no aliases to report, and the Editor call
    name: 'aliases: an alias link whose group is the page alone',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulled(ATLAS_WITH_ALIAS), 'name']])],
      [query(aliasSetsQuery([10]), [], [member(10, ATLAS)])],
      [editorCall('Atlas', [[editorPage(BOB), [editorBlock(201, 20)]]])]
    ]
  },
  {
    name: 'aliases: the alias lookup finds no row for the page',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulled(ATLAS_WITH_ALIAS), 'name']])],
      [query(aliasSetsQuery([10]), [], [])],
      [editorCall('Atlas', [])]
    ]
  },
  {
    // A page that has no `alias` key has no aliases, so no alias query is made (checked by the calls)
    name: 'aliases: a page with no alias key makes no alias query',
    tool: TOOL,
    arguments: { page_name: 'Bob' },
    steps: exactSteps(BOB, 'Bob', [[editorPage(ATLAS), [editorBlock(101, 10)]]])
  },
  {
    // A group of 60 is cut to the page and 49 aliases, by name, and the cut is said
    name: 'aliases: a group past the cap',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulled({ ...ATLAS, alias: [100] }), 'name']])],
      [
        query(aliasSetsQuery([10]), [], [
          member(10, ATLAS),
          ...Array.from({ length: 60 }, (_, i) =>
            member(10, { id: 100 + i, name: `member ${String(59 - i).padStart(2, '0')}`, originalName: `Member ${String(59 - i).padStart(2, '0')}` })
          )
        ])
      ],
      // `member 00` has id 159, `member 01` 158 and so on: the first 49 by name are 159 down to 111
      [query(linkedReferencesQuery([10, ...Array.from({ length: 49 }, (_, k) => 159 - k)]), [], [pulledBlock(201, BOB)])]
    ]
  },
  {
    // Names that differ only in accents or case sort the same on every host
    name: 'aliases: resolvedAliases order',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulled({ ...ATLAS, alias: [12, 13, 14] }), 'name']])],
      [
        query(aliasSetsQuery([10]), [], [
          member(10, ATLAS),
          member(10, { id: 12, name: 'zeta', originalName: 'Zeta' }),
          member(10, { id: 13, name: 'álvaro', originalName: 'Álvaro' }),
          member(10, { id: 14, name: 'alvaro', originalName: 'alvaro' })
        ])
      ],
      [query(linkedReferencesQuery([10, 14, 13, 12]), [], [])]
    ]
  },
  {
    // The aliased path cuts like the Editor path: after the fetch, with the same warnings
    name: 'aliases: the cut on the aliased path',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_pages: 1, max_blocks_per_page: 1 },
    steps: [
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulled(ATLAS_WITH_ALIAS), 'name']])],
      [query(aliasSetsQuery([10]), [], [member(10, ATLAS), member(10, PROJECT_ATLAS)])],
      [
        query(linkedReferencesQuery([10, 11]), [], [
          pulledBlock(401, ALICE),
          pulledBlock(402, ALICE),
          pulledBlock(201, BOB),
          pulledBlock(202, BOB),
          pulledBlock(211, CAROL)
        ])
      ]
    ]
  },
  {
    // The aliased query answered with nothing (null): read as no rows, so an empty list (suspected TS bug, BR-0011)
    name: 'aliases: the aliased query answers null',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulled(ATLAS_WITH_ALIAS), 'name']])],
      [query(aliasSetsQuery([10]), [], [member(10, ATLAS), member(10, PROJECT_ATLAS)])],
      [query(linkedReferencesQuery([10, 11]), [], null)]
    ]
  },
  {
    // The alias lookup answered null: read as no aliases, so the Editor call (suspected TS bug, BR-0011)
    name: 'aliases: the alias lookup answers null',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulled(ATLAS_WITH_ALIAS), 'name']])],
      [query(aliasSetsQuery([10]), [], null)],
      [editorCall('Atlas', [])]
    ]
  },
  {
    name: 'aliases: LogSeq error from the alias lookup',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulled(ATLAS_WITH_ALIAS), 'name']])],
      [query(aliasSetsQuery([10]), [], { error: 'Query timed out' })]
    ]
  },
  {
    name: 'aliases: alias lookup in a shape the server cannot read',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulled(ATLAS_WITH_ALIAS), 'name']])],
      // no string in the answer, so the self-check can perturb it into an error of another kind
      [query(aliasSetsQuery([10]), [], [[true, { id: 10 }]])]
    ]
  },
  {
    name: 'aliases: blocks in a shape the server cannot read',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulled(ATLAS_WITH_ALIAS), 'name']])],
      [query(aliasSetsQuery([10]), [], [member(10, ATLAS), member(10, PROJECT_ATLAS)])],
      [query(linkedReferencesQuery([10, 11]), [], [[{ id: 1 }]])]
    ]
  },

  // --- caps ---------------------------------------------------------------------------------
  {
    // 25 source pages, the default cap is 20: raise max_pages to 25
    name: 'caps: more source pages than the default',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: exactSteps(ATLAS, 'Atlas', manyPages(25, 1))
  },
  {
    // The answer holds no text, so the self-check can perturb it: nothing of a page is shown at 0
    name: 'caps: max_pages 0 keeps no page',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_pages: 0 },
    steps: exactSteps(ATLAS, 'Atlas', [[{ id: 100 }, []], [{ id: 101 }, []]])
  },
  {
    // 120 pages and a cap of 50: more is there, up to the maximum of 100
    name: 'caps: below the maximum and over it in total',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_pages: 50 },
    steps: exactSteps(ATLAS, 'Atlas', manyPages(120, 1))
  },
  {
    // 101 pages and 150 asked for: clamped to 100, and the message says what was asked
    name: 'caps: max_pages above the maximum',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_pages: 150 },
    steps: exactSteps(ATLAS, 'Atlas', manyPages(101, 1))
  },
  {
    // Raising to the total returns more blocks than plausibly come back inline: the note says so
    name: 'caps: a raise that may be saved to a file',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_pages: 10, max_blocks_per_page: 5 },
    steps: exactSteps(ATLAS, 'Atlas', manyPages(60, 5))
  },
  {
    // Two pages hold 12 and 14 blocks, the cap is the default 10
    name: 'caps: blocks past the per-page cap, raise to the largest page',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: exactSteps(ATLAS, 'Atlas', [
      [editorPage(ALICE), editorBlocks(ALICE, 12, 4000)],
      [editorPage(BOB), editorBlocks(BOB, 14, 2000)],
      [editorPage(CAROL), editorBlocks(CAROL, 3, 2100)]
    ])
  },
  {
    // Seven pages are affected: five are named, two are counted
    name: 'caps: seven pages with more blocks than the cap',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_blocks_per_page: 2 },
    steps: exactSteps(ATLAS, 'Atlas', manyPages(7, 3))
  },
  {
    // A page with 60 blocks: the per-page maximum is 50, so no parameter fetches the rest
    name: 'caps: blocks past the per-page maximum',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_blocks_per_page: 50 },
    steps: exactSteps(ATLAS, 'Atlas', [[editorPage(ALICE), editorBlocks(ALICE, 60, 4000)]])
  },
  {
    name: 'caps: max_blocks_per_page above the maximum',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_blocks_per_page: 200 },
    steps: exactSteps(ATLAS, 'Atlas', [[editorPage(ALICE), editorBlocks(ALICE, 60, 4000)]])
  },
  {
    // Five pages of 60 blocks: the raise to 50 a page may not come back inline
    name: 'caps: a per-page raise that may be saved to a file',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_blocks_per_page: 5 },
    steps: exactSteps(ATLAS, 'Atlas', manyPages(5, 60))
  },
  {
    name: 'caps: max_blocks_per_page 0 keeps no block',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_blocks_per_page: 0 },
    steps: exactSteps(ATLAS, 'Atlas', manyPages(3, 2))
  },
  {
    // Both caps bite in one call: the pages warning comes first
    name: 'caps: both caps bite',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_pages: 2, max_blocks_per_page: 2 },
    steps: exactSteps(ATLAS, 'Atlas', [
      [editorPage(ALICE), editorBlocks(ALICE, 4, 4000)],
      [editorPage(BOB), editorBlocks(BOB, 3, 2000)],
      [editorPage(CAROL), editorBlocks(CAROL, 1, 2100)]
    ])
  },
  {
    // A page that was found by alias and is cut: resolvedFrom comes after the totals
    name: 'caps: the cut on a page found by alias',
    tool: TOOL,
    arguments: { page_name: 'Project Alpha', max_pages: 1 },
    steps: [
      [query(RESOLVE_BY_NAME, ['"project alpha"'], [[pulled(ATLAS), 'alias']])],
      [editorCall('atlas', manyPages(3, 1))]
    ]
  },

  // --- failures -----------------------------------------------------------------------------
  {
    name: 'failure: missing page with suggestions',
    tool: TOOL,
    arguments: { page_name: 'Alce' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"alce"'], [])],
      [query(NAMESPACE_LEAF, ['"/alce"'], [])],
      [
        {
          method: 'logseq.Editor.getAllPages',
          args: [],
          response: [ALICE, ALICE_NOTES, BOB, ATLAS].map(({ id, name, originalName }) => ({ id, name, originalName }))
        }
      ]
    ]
  },
  {
    name: 'failure: ambiguous alias',
    tool: TOOL,
    arguments: { page_name: 'al' },
    steps: [[query(RESOLVE_BY_NAME, ['"al"'], [[pulled(ALICE_NOTES), 'alias'], [pulled(ALICE), 'alias']])]]
  },
  {
    name: 'failure: LogSeq error from the resolver',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: [[query(RESOLVE_BY_NAME, ['"atlas"'], { error: 'Query timed out' })]]
  },
  {
    // An error from LogSeq is an error result, not an empty list (BR-0003)
    name: 'failure: LogSeq error from the linked references call',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: exactSteps(ATLAS, 'Atlas', { error: 'Page not found' })
  },
  {
    name: 'failure: linked references in a shape the server cannot read',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: exactSteps(ATLAS, 'Atlas', [[null, [{ id: 201 }]]])
  },
  {
    name: 'failure: a source page that is not a page',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: exactSteps(ATLAS, 'Atlas', [[{ id: true }, []]])
  },
  {
    name: 'failure: a row that is not a tuple',
    tool: TOOL,
    arguments: { page_name: 'Atlas' },
    steps: exactSteps(ATLAS, 'Atlas', [[null, [], 3]])
  },
  {
    name: 'failure: missing page_name',
    tool: TOOL,
    arguments: { page_name: null },
    steps: []
  },
  {
    name: 'failure: page_name is a number',
    tool: TOOL,
    arguments: { page_name: 42 },
    steps: []
  },
  {
    name: 'failure: parameter aliases that disagree',
    tool: TOOL,
    arguments: { page_name: 'Bob', name: 'Alice' },
    steps: []
  },
  {
    name: 'failure: max_pages is a fraction',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_pages: 2.5 },
    steps: []
  },
  {
    name: 'failure: max_pages is a string',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_pages: '5' },
    steps: []
  },
  {
    name: 'failure: max_pages is below its minimum',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_pages: -1 },
    steps: []
  },
  {
    name: 'failure: max_blocks_per_page is a boolean',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_blocks_per_page: true },
    steps: []
  },
  {
    name: 'failure: max_blocks_per_page is too big',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_blocks_per_page: 1e300 },
    steps: []
  },
  {
    // `null` is absent: the defaults apply
    name: 'failure: null counts are absent',
    tool: TOOL,
    arguments: { page_name: 'Atlas', max_pages: null, max_blocks_per_page: null },
    steps: exactSteps(ATLAS, 'Atlas', [])
  }
];
