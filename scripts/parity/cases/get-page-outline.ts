// Parity cases for logseq_get_page_outline (#124, ADR-0025). Every page, block and name here is
// made up (BR-0001). Each case lists the LogSeq calls the TypeScript server makes, in order, with
// the answer the stub gives; the result the server printed for it is in ../expected/.
//
// Calls are written as they go over the wire: a Datalog query's inputs are the EDN (JSON) text
// the client sends, so `'"project atlas"'` is the string input and `'20250101'` the number.
import { DATASCRIPT_QUERY, type CannedCall } from '../stub-logseq.js';
import type { ParityCase } from '../harness.js';

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

const outlineQuery = (pageId: number) =>
  '[:find (pull ?b [:db/id :block/uuid :block/content :block/left :block/parent]) :where ' +
  `[(ground [${pageId}]) [?page ...]] [?page :block/name] (or-join [?page ?b] ` +
  '(and [?b :block/parent ?page] [?b :block/page ?page]) (and [?top :block/parent ?page] [?b :block/parent ?top]))]';

const query = (text: string, inputs: string[], response: unknown): CannedCall => ({
  method: DATASCRIPT_QUERY,
  args: [text, ...inputs],
  response
});

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

interface Page {
  id: number;
  name: string;
  originalName: string;
  file?: boolean;
  journalDay?: number;
}

/** A page as `pull [*]` returns it: kebab-case keys. */
const pulled = ({ id, name, originalName, file, journalDay }: Page) => ({
  id,
  uuid: uuid(id),
  name,
  'original-name': originalName,
  ...(file ? { file: { id: id + 5000 } } : {}),
  ...(journalDay ? { 'journal?': true, 'journal-day': journalDay } : { 'journal?': false })
});

interface Block {
  id: number;
  /** Absent: the row has no `parent` at all */
  parent?: number;
  left: number;
  content?: string;
  /** Send `parent` as a bare number, which the outline accepts as well as `{ id }` */
  bareParent?: boolean;
}

const row = ({ id, parent, left, content, bareParent }: Block) => [
  {
    id,
    uuid: uuid(id),
    ...(content === undefined ? {} : { content }),
    left: { id: left },
    ...(parent === undefined ? {} : { parent: bareParent ? parent : { id: parent } })
  }
];

const ATLAS: Page = { id: 10, name: 'project atlas', originalName: 'Project Atlas', file: true };
const BOB: Page = { id: 20, name: 'bob', originalName: 'Bob' };
const NEW_YEAR: Page = { id: 30, name: 'jan 1st, 2025', originalName: 'Jan 1st, 2025', file: true, journalDay: 20250101 };
const ALICE: Page = { id: 40, name: 'alice', originalName: 'Alice', file: true };
const ALICE_NOTES: Page = { id: 41, name: 'alice notes', originalName: 'Alice Notes', file: true };
const ATLAS_LOG: Page = { id: 50, name: 'project atlas/log', originalName: 'Project Atlas/Log', file: true };
const RETRO: Page = { id: 60, name: 'project atlas/retro', originalName: 'Project Atlas/Retro', file: true };

// Four top-level blocks, sent out of page order with their children mixed in: the outline must
// order them by the :block/left chain and count only direct children.
const ATLAS_BLOCKS: Block[] = [
  { id: 103, parent: 10, left: 102, content: `Risks: ${'the importer may drop rows when a field is empty, '.repeat(3)}` },
  { id: 201, parent: 101, left: 101, content: 'Alice owns the schema' },
  { id: 101, parent: 10, left: 10, content: 'Kickoff with [[Alice]] and [[Bob]] about "scope" & <dates>' },
  { id: 202, parent: 101, left: 201, content: 'Bob owns the importer' },
  { id: 104, parent: 10, left: 103 },
  { id: 102, parent: 10, left: 101, content: 'Milestones – café \u{1F680}\n- ship the importer\n- write the docs' },
  { id: 203, parent: 103, left: 103, content: 'Mitigation: validate first', bareParent: true }
];

/** 201 top-level blocks, one more than the outline lists, in reverse page order. */
const LOG_BLOCKS: Block[] = Array.from({ length: 201 }, (_, i) => ({
  id: 1000 + i,
  parent: 50,
  left: i === 0 ? 50 : 1000 + i - 1,
  content: `Log entry ${i + 1}`
})).reverse();

export const getPageOutlineCases: ParityCase[] = [
  {
    name: 'exact name, blocks out of order with children',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: 'Project Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"project atlas"'], [[pulled(ATLAS), 'name']])],
      [query(outlineQuery(ATLAS.id), [], ATLAS_BLOCKS.map(row))]
    ]
  },
  {
    name: 'alias',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: 'atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulled(ATLAS), 'alias']])],
      [query(outlineQuery(ATLAS.id), [], ATLAS_BLOCKS.slice(0, 3).map(row))]
    ]
  },
  {
    name: 'ISO date of a journal',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: '2025-01-01' },
    steps: [
      [query(RESOLVE_WITH_DAY, ['"2025-01-01"', '20250101'], [[pulled(NEW_YEAR), 'journal-date']])],
      [query(outlineQuery(NEW_YEAR.id), [], [row({ id: 301, parent: 30, left: 30, content: 'Planned the [[Project Atlas]] year' })])]
    ]
  },
  {
    name: 'page with no blocks',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: 'BOB' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"bob"'], [[pulled(BOB), 'name']])],
      [query(outlineQuery(BOB.id), [], [])]
    ]
  },
  {
    name: 'null rows from the outline query',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: 'bob' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"bob"'], [[pulled(BOB), 'name']])],
      [query(outlineQuery(BOB.id), [], null)]
    ]
  },
  {
    name: 'namespace leaf',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: 'retro' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"retro"'], [])],
      [query(NAMESPACE_LEAF, ['"/retro"'], [[pulled(RETRO)]])],
      [query(outlineQuery(RETRO.id), [], [row({ id: 601, parent: 60, left: 60, content: 'What went well' })])]
    ]
  },
  {
    name: 'ambiguous alias',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: 'al' },
    steps: [[query(RESOLVE_BY_NAME, ['"al"'], [[pulled(ALICE_NOTES), 'alias'], [pulled(ALICE), 'alias']])]]
  },
  {
    name: 'missing page with suggestions',
    tool: 'logseq_get_page_outline',
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
    name: 'more top-level blocks than the cap',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: 'Project Atlas/Log' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"project atlas/log"'], [[pulled(ATLAS_LOG), 'name']])],
      [query(outlineQuery(ATLAS_LOG.id), [], LOG_BLOCKS.map(row))]
    ]
  },
  {
    // A null cell is skipped, a row with no parent is neither a top-level block nor a child
    name: 'null cell and a row with no parent',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: 'Alice' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"alice"'], [[pulled(ALICE), 'name']])],
      [
        query(outlineQuery(ALICE.id), [], [
          [null],
          row({ id: 401, parent: 40, left: 40, content: 'Alice works on [[Project Atlas]]' }),
          row({ id: 402, left: 401, content: 'A row LogSeq sent without a parent' }),
          row({ id: 403, parent: 401, left: 401, content: 'Since 2025' })
        ])
      ]
    ]
  },
  {
    // 411 and 412 point at each other and 413 at a block that isn't there: the chain from 413
    // comes first, then the blocks no chain reached, by id
    name: 'broken and cyclic left chain',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: 'Alice Notes' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"alice notes"'], [[pulled(ALICE_NOTES), 'name']])],
      [
        query(
          outlineQuery(ALICE_NOTES.id),
          [],
          [
            row({ id: 411, parent: 41, left: 412, content: 'Cycle one' }),
            row({ id: 412, parent: 41, left: 411, content: 'Cycle two' }),
            row({ id: 414, parent: 41, left: 413, content: 'After the orphan' }),
            row({ id: 413, parent: 41, left: 999, content: 'Left of a missing block' })
          ]
        )
      ]
    ]
  },
  {
    // `name` and `page` are accepted for `page_name` (BR-0008), and are not in the schema
    name: 'parameter alias',
    tool: 'logseq_get_page_outline',
    arguments: { name: 'Bob' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"bob"'], [[pulled(BOB), 'name']])],
      [query(outlineQuery(BOB.id), [], [row({ id: 701, parent: 20, left: 20, content: 'Bob owns the importer' })])]
    ]
  },
  {
    name: 'parameter aliases that disagree',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: 'Bob', page: 'Alice' },
    steps: []
  },
  {
    // `null` is the same as absent, so the required parameter is missing
    name: 'missing page_name',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: null },
    steps: []
  },
  {
    // The snippet is cut at 77 UTF-16 units, which falls inside the emoji: the lone half is written
    // as an escape, as JSON.stringify writes it
    name: 'snippet cut inside an emoji',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: 'Bob' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"bob"'], [[pulled(BOB), 'name']])],
      [
        query(outlineQuery(BOB.id), [], [
          row({ id: 711, parent: 20, left: 20, content: `${'x'.repeat(76)}\u{1F680} and then some more words after it` }),
          row({ id: 712, parent: 20, left: 711, content: `${'y'.repeat(75)} \u{1F680} and more` })
        ])
      ]
    ]
  },
  {
    // A shape the server can't read is an error that names the path and no value (#202). The
    // answer holds no text, so the self-check can perturb it into an error of another kind.
    name: 'resolver row in a shape the server cannot read',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: 'Bob' },
    steps: [[query(RESOLVE_BY_NAME, ['"bob"'], [[{ id: BOB.id, 'journal?': 1 }]])]]
  },
  {
    // A stub nobody wrote (no file) that another page aliases gives way to that page
    name: 'bare alias target',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: 'Bob' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"bob"'], [[pulled(BOB), 'name'], [pulled(ALICE), 'alias']])],
      [query(outlineQuery(ALICE.id), [], [row({ id: 721, parent: 40, left: 40, content: 'Alice, also known as Bob' })])]
    ]
  },
  {
    // Twelve pages declare the alias: ten are listed, in name order, and the cut is said
    name: 'more candidates than the list holds',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: ' team ' },
    steps: [
      [
        query(
          RESOLVE_BY_NAME,
          ['"team"'],
          Array.from({ length: 12 }, (_, i): unknown[] => [
            pulled({ id: 800 + i, name: `team page ${11 - i}`, originalName: `Team Page ${11 - i}`, file: true }),
            'alias'
          ])
        )
      ]
    ]
  },
  {
    // An ISO date nobody has a journal for: no leaf query and no suggestions
    name: 'missing journal date',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: '2031-12-31' },
    steps: [[query(RESOLVE_WITH_DAY, ['"2031-12-31"', '20311231'], [])]]
  },
  {
    // An error from LogSeq is an error result, not an empty outline (BR-0003)
    name: 'LogSeq error from the resolver',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: 'Bob' },
    steps: [[query(RESOLVE_BY_NAME, ['"bob"'], { error: 'Query timed out' })]]
  },
  {
    name: 'bad argument',
    tool: 'logseq_get_page_outline',
    arguments: { page_name: 42 },
    steps: []
  }
];
