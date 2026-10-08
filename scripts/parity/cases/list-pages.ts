// Parity cases for logseq_list_pages (#306, ADR-0025). Every page and name here is made up
// (BR-0001). Each case lists the LogSeq calls the TypeScript server makes, in order, with the answer
// the stub gives; the result the server printed for it is in ../expected/.
import type { CannedCall } from '../stub-logseq.js';
import type { ParityCase } from '../harness.js';

const getAllPages = (response: unknown): CannedCall => ({ method: 'logseq.Editor.getAllPages', args: [], response });

interface Page {
  id: number;
  originalName?: string;
  name: string;
  file?: boolean;
  alias?: Array<{ id?: number }>;
  journal?: boolean;
}

/** A page as `getAllPages` returns it: camelCase keys, `alias` as bare ids. */
const page = ({ id, name, originalName, file, alias, journal }: Page) => ({
  id,
  name,
  ...(originalName === undefined ? {} : { originalName }),
  'journal?': journal ?? false,
  ...(file ? { file: { id: id + 5000 } } : {}),
  ...(alias ? { alias } : {})
});

const named = (id: number, originalName: string, extra: Partial<Page> = {}): Page => ({
  id,
  name: originalName.toLowerCase(),
  originalName,
  file: true,
  ...extra
});

// Alice declares two aliases (a clique of three, as LogSeq stores a group of three or more)
const ALICE = named(1, 'Alice Rivera', { alias: [{ id: 2 }, { id: 3 }] });
const AL = { ...named(2, 'Al', { alias: [{ id: 1 }, { id: 3 }] }), file: false };
const ALI = { ...named(3, 'Ali', { alias: [{ id: 1 }, { id: 2 }] }), file: false };
const BOB = named(4, 'Bob');
const ATLAS = named(5, 'Project Atlas', { alias: [{ id: 6 }] });
const ATLAS_STUB = { ...named(6, 'Atlas', { alias: [{ id: 5 }] }), file: false };
const LONELY_STUB = { ...named(7, 'Lonely Stub'), file: false };
const JOURNAL = named(8, 'Jan 1st, 2025', { journal: true });
const TWINS_A = named(9, 'Twin A', { alias: [{ id: 11 }] });
const TWINS_B = named(10, 'Twin B', { alias: [{ id: 11 }] });
const TWINS_STUB = { ...named(11, 'Twin', { alias: [{ id: 9 }, { id: 10 }] }), file: false };
// A page that declares another page with a file as its alias: neither nests
const PEERS_A = named(12, 'Peer A', { alias: [{ id: 13 }] });
const PEERS_B = named(13, 'Peer B', { alias: [{ id: 12 }] });
// A link with no id, and a link to a page that isn't listed
const ODD_LINKS = named(14, 'Odd Links', { alias: [{}, { id: 9999 }] });

const SMALL_GRAPH = [ALICE, AL, ALI, BOB, ATLAS, ATLAS_STUB, LONELY_STUB, JOURNAL, TWINS_A, TWINS_B, TWINS_STUB, PEERS_A, PEERS_B, ODD_LINKS];

/** Names that sort differently by code point and by locale: accents, case, digits, punctuation. */
const SORTED_NAMES = [
  'zebra',
  'Éclair',
  'eclair',
  'Apple',
  'apple',
  'banana',
  '10 ten',
  '2 two',
  '_underscore',
  'Zed',
  'étude',
  'Mango Tree',
  'mango-tree',
  'Mangos'
];

/** n pages named Page 0001 to Page n, none with aliases, in an order that isn't name order. */
const manyPages = (n: number): unknown[] =>
  Array.from({ length: n }, (_, i) => named(100 + i, `Page ${String(((i * 7) % n) + 1).padStart(4, '0')}`)).map(page);

export const listPagesCases: ParityCase[] = [
  {
    name: 'every page, aliases nested',
    tool: 'logseq_list_pages',
    arguments: {},
    steps: [[getAllPages(SMALL_GRAPH.map(page))]]
  },
  {
    name: 'name_contains matches an alias',
    tool: 'logseq_list_pages',
    arguments: { name_contains: 'ALI' },
    steps: [[getAllPages(SMALL_GRAPH.map(page))]]
  },
  {
    name: 'name_contains matches the name of a page',
    tool: 'logseq_list_pages',
    arguments: { name_contains: 'twin' },
    steps: [[getAllPages(SMALL_GRAPH.map(page))]]
  },
  {
    // No made-up name holds this text, so the list is empty (a match here changes when a fixture does)
    name: 'name_contains matches nothing',
    tool: 'logseq_list_pages',
    arguments: { name_contains: 'd)' },
    steps: [[getAllPages(SMALL_GRAPH.map(page))]]
  },
  {
    // An empty filter is no filter, so no tip names a first match
    name: 'empty name_contains',
    tool: 'logseq_list_pages',
    arguments: { name_contains: '' },
    steps: [[getAllPages(SMALL_GRAPH.map(page))]]
  },
  {
    // A blank filter filters (nothing matches a name with no space) and suggests nothing
    name: 'blank name_contains',
    tool: 'logseq_list_pages',
    arguments: { name_contains: ' ' },
    steps: [[getAllPages(SMALL_GRAPH.map(page))]]
  },
  {
    // Page names are compared in the order of localeCompare, with code points to break a tie
    name: 'names in locale order',
    tool: 'logseq_list_pages',
    arguments: {},
    steps: [[getAllPages(SORTED_NAMES.map((name, i) => page(named(200 + i, name))))]]
  },
  {
    // Two distinct names that localeCompare calls equal (NFC and NFD) keep one order
    name: 'names that collate as equal',
    tool: 'logseq_list_pages',
    arguments: {},
    steps: [[getAllPages([page(named(301, 'caf\u{e9}')), page(named(302, 'café')), page(named(303, 'cafe​'))])]]
  },
  {
    // ICU ignores some characters completely: an emoji's variation selector (U+FE0F, which an emoji name
    // typed on a phone carries), bidi embeddings and controls. So "\u2764\ufe0f a" sorts before "\u2764 b"
    // by its letter, where comparing the selector itself would put it after the space
    name: 'names with characters collation ignores',
    tool: 'logseq_list_pages',
    arguments: {},
    steps: [
      [
        getAllPages(
          ['\u2764 b', '\u2764\ufe0f a', '\u2764 c', '\u2764\ufe0f b', 'lrm two', 'lrm\u202a one', 'ctl\u0001 z', 'ctl y'].map((name, i) =>
            page(named(600 + i, name))
          )
        )
      ]
    ]
  },
  {
    name: 'limit cuts the list and says how to page',
    tool: 'logseq_list_pages',
    arguments: { limit: 4 },
    steps: [[getAllPages(SMALL_GRAPH.map(page))]]
  },
  {
    name: 'offset and limit',
    tool: 'logseq_list_pages',
    arguments: { limit: 3, offset: 2 },
    steps: [[getAllPages(SMALL_GRAPH.map(page))]]
  },
  {
    name: 'offset reaches the end',
    tool: 'logseq_list_pages',
    arguments: { offset: 5 },
    steps: [[getAllPages(SMALL_GRAPH.map(page))]]
  },
  {
    // limit 0 shows nothing, so there is no next offset to suggest
    name: 'list: limit zero',
    tool: 'logseq_list_pages',
    arguments: { limit: 0, name_contains: 'e' },
    steps: [[getAllPages(SMALL_GRAPH.map(page))]]
  },
  {
    name: 'a whole number sent as a float',
    tool: 'logseq_list_pages',
    arguments: { limit: 4.0, offset: 1e0 },
    steps: [[getAllPages(SMALL_GRAPH.map(page))]]
  },
  {
    // 1003 pages and the default limit: raising limit to 1000 gets 1000 of the 1003, and the note
    // about a large result is added
    name: 'more pages than the maximum, default limit',
    tool: 'logseq_list_pages',
    arguments: {},
    steps: [[getAllPages(manyPages(1003))]]
  },
  {
    name: 'limit past the maximum is clamped and said so',
    tool: 'logseq_list_pages',
    arguments: { limit: 5000 },
    steps: [[getAllPages(manyPages(1003))]]
  },
  {
    name: 'limit at the maximum with pages left',
    tool: 'logseq_list_pages',
    arguments: { limit: 1000, offset: 1 },
    steps: [[getAllPages(manyPages(1003))]]
  },
  {
    name: 'list: limit past the safe range of a count',
    tool: 'logseq_list_pages',
    arguments: { limit: 9007199254740991 },
    steps: [[getAllPages(manyPages(1003))]]
  },
  {
    name: 'no pages at all',
    tool: 'logseq_list_pages',
    arguments: {},
    steps: [[getAllPages([])]]
  },
  {
    // `null` is not `[]` (BR-0011): the empty list says it may not mean the graph is empty
    name: 'no page list from LogSeq',
    tool: 'logseq_list_pages',
    arguments: {},
    steps: [[getAllPages(null)]]
  },
  {
    // A journal is not listed, whatever the filter
    name: 'journals are left out',
    tool: 'logseq_list_pages',
    arguments: {},
    steps: [[getAllPages([page(JOURNAL), page(BOB)])]]
  },
  {
    // Camel and kebab case keys of a journal flag: `journal` alone also marks one
    name: 'journal flag in its other spelling and an empty original name',
    tool: 'logseq_list_pages',
    arguments: {},
    steps: [
      [
        getAllPages([
          { id: 401, name: 'plain', originalName: '', 'journal?': false },
          { id: 402, name: 'old journal', originalName: 'Old Journal', journal: true },
          { id: 403, name: 'no flag at all', originalName: 'No Flag At All' },
          { id: 404, name: 'kebab', 'original-name': 'Kebab', 'journal?': false }
        ])
      ]
    ]
  },
  {
    name: 'page that is not in the shape the server can read',
    tool: 'logseq_list_pages',
    arguments: {},
    perturbed: [],
    steps: [[getAllPages([page(BOB), { id: 5, name: 7 }])]]
  },
  {
    name: 'page with no name',
    tool: 'logseq_list_pages',
    arguments: {},
    steps: [[getAllPages([{ id: 501 }])]]
  },
  {
    name: 'page list that is not a list',
    tool: 'logseq_list_pages',
    arguments: {},
    steps: [[getAllPages({ pages: 3 })]]
  },
  {
    // An error from LogSeq is an error result, not an empty list (BR-0003)
    name: 'LogSeq error for the page list',
    tool: 'logseq_list_pages',
    arguments: {},
    steps: [[getAllPages({ error: 'Cannot read the graph' })]]
  },
  {
    name: 'bad name_contains',
    tool: 'logseq_list_pages',
    arguments: { name_contains: 3 },
    steps: []
  },
  {
    name: 'list: bad limit: a string',
    tool: 'logseq_list_pages',
    arguments: { limit: 'ten' },
    steps: []
  },
  {
    name: 'list: bad limit: a fraction',
    tool: 'logseq_list_pages',
    arguments: { limit: 2.5 },
    steps: []
  },
  {
    name: 'bad offset: below the minimum',
    tool: 'logseq_list_pages',
    arguments: { offset: -1 },
    steps: []
  },
  {
    // Arguments are read in the order of the schema: limit comes before offset
    name: 'list: two bad arguments',
    tool: 'logseq_list_pages',
    arguments: { offset: 'x', limit: true },
    steps: []
  },
  {
    name: 'limit out of the range of a count',
    tool: 'logseq_list_pages',
    arguments: { limit: 1e300 },
    steps: []
  },
  {
    name: 'list: null arguments are absent',
    tool: 'logseq_list_pages',
    arguments: { name_contains: null, limit: null, offset: null },
    steps: [[getAllPages([page(BOB), page(ATLAS), page(ATLAS_STUB)])]]
  }
];
