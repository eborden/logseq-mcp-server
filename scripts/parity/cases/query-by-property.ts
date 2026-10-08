// Parity cases for logseq_query_by_property (#309, ADR-0025). Every page, block, property and name
// here is made up (BR-0001). Each case lists the LogSeq calls the TypeScript server makes, in order,
// with the answer the stub gives; the result the server printed for it is in ../expected/.
//
// Calls are written as they go over the wire: a Datalog query's inputs are the EDN (JSON) text the
// client sends, so the property key and the value are each the JSON text of a string.
import { DATASCRIPT_QUERY, type CannedCall } from '../stub-logseq.js';
import type { ParityCase } from '../harness.js';

const BY_PROPERTY =
  '[:find (pull ?b [* {:block/page [:db/id :block/name :block/original-name]}]) :in $ ?key ?value :where ' +
  '[?b :block/properties ?props] [?b :block/page] [(keyword ?key) ?kw] [(get ?props ?kw) ?v] ' +
  '(or-join [?v ?value] (and [(str ?v) ?s] [(= ?s ?value)]) [(contains? ?v ?value)])]';

/** The query for the key LogSeq stores and the value as text, and the answer the stub gives. */
const query = (key: string, value: string, response: unknown): CannedCall => ({
  method: DATASCRIPT_QUERY,
  args: [BY_PROPERTY, JSON.stringify(key), JSON.stringify(value)],
  response
});

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

interface NestedPage {
  id?: number;
  'db/id'?: number;
  name?: string;
  'original-name'?: string;
}

const ATLAS_PAGE: NestedPage = { id: 10, name: 'project atlas', 'original-name': 'Project Atlas' };
const BOB_PAGE: NestedPage = { id: 20, name: 'bob', 'original-name': 'Bob' };
const JOURNAL_PAGE: NestedPage = { id: 30, name: 'jan 1st, 2025', 'original-name': 'Jan 1st, 2025' };
const BARE_PAGE: NestedPage = { id: 40 };

interface Match {
  id: number;
  content?: string;
  page?: NestedPage;
  /** Properties of the block, written before `format` */
  properties?: Record<string, unknown>;
  /** More keys of the block, written after `page` */
  extra?: Record<string, unknown>;
  /** Keys written before `properties` */
  before?: Record<string, unknown>;
}

/** A block as `pull [* {:block/page ...}]` returns it: LogSeq's own kebab-case keys. */
const match = ({ id, content = `Block ${id}`, page, properties = { status: 'doing' }, extra, before }: Match) => [
  {
    id,
    uuid: uuid(id),
    content,
    ...(before ?? {}),
    properties,
    format: 'markdown',
    left: { id: id - 1 },
    parent: { id: page?.id ?? 1 },
    ...(page ? { page } : {}),
    ...(extra ?? {})
  }
];

/** n matches, ids 1000 to 1000 + n - 1, in an order that is not id order. */
const manyMatches = (n: number) =>
  Array.from({ length: n }, (_, i) => match({ id: 1000 + ((i * 37) % n), content: `Task ${i} is doing`, page: ATLAS_PAGE }));

const MIXED_MATCHES = [
  match({ id: 340, content: 'Standup notes are doing', page: JOURNAL_PAGE }),
  match({ id: 105, content: 'Bob owns the importer', page: BOB_PAGE }),
  match({ id: 512, content: 'TODO ship the [[Importer]] with #urgent and #later', page: ATLAS_PAGE, extra: { marker: 'TODO' } }),
  match({ id: 77, content: 'a block on a page that has no name', page: BARE_PAGE }),
  match({ id: 513, content: 'second block on Atlas', page: ATLAS_PAGE })
];

const cases: ParityCase[] = [
  {
    // Sorted by page id, then block id: the answer came in another order. Slim blocks leave out the
    // empty properties and carry tags and refs read from the text
    name: 'slim matches, sorted by page then block',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    steps: [[query('status', 'doing', MIXED_MATCHES)]]
  },
  {
    name: 'slim properties keep false and zero and drop what is empty',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    steps: [
      [
        query('status', 'doing', [
          match({
            id: 5,
            content: 'TODO check',
            page: ATLAS_PAGE,
            properties: { status: 'doing', owner: '', done: false, count: 0, tags: [], note: '  ', empty: {} },
            before: { marker: 'TODO' }
          })
        ])
      ]
    ]
  },
  {
    // Every key camelized as the Editor API spells it: the block's keys, the property names, and the
    // nested page. An integer-like property key is written first, as JavaScript writes it
    name: 'full matches are camelized',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing', slim_results: false },
    steps: [
      [
        query('status', 'doing', [
          match({
            id: 512,
            content: 'TODO ship the importer',
            page: ATLAS_PAGE,
            before: { marker: 'TODO', 'created-at': 1735700000000, 'properties-text-values': { 'created-at': 'x', status: 'doing' } },
            properties: { b: 'x', '2': 'two', 'created-at': 'y', 'logseq.order-list-type': 'number', status: 'doing' },
            extra: { 'path-refs': [{ id: 10 }], refs: [{ id: 10, name: 'project atlas' }], 'properties-order': ['created-at', 'status', 7] }
          }),
          match({ id: 105, content: 'Bob owns the importer', page: BOB_PAGE })
        ])
      ]
    ]
  },
  {
    // `propertiesOrder` already camelCase beside its kebab-case twin: one entry, at the first one's place
    name: 'full matches with a key spelled both ways',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing', slim_results: false },
    steps: [[query('status', 'doing', [match({ id: 8, page: BOB_PAGE, extra: { 'properties-order': ['a-b'], propertiesOrder: ['c-d'] } })])]]
  },
  {
    name: 'a camelCase key is the key LogSeq stores',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'createdAt', property_value: 'today' },
    steps: [[query('created-at', 'today', [match({ id: 3, page: BOB_PAGE, properties: { 'created-at': 'today' } })])]]
  },
  {
    name: 'an underscore key is the key LogSeq stores',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'due_date', property_value: 'soon' },
    steps: [[query('due-date', 'soon', [match({ id: 3, page: BOB_PAGE, properties: { 'due-date': 'soon' } })])]]
  },
  {
    // Matches don't overlap: the capital that ends one hyphen doesn't start the next
    name: 'a key with capitals in a row',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'aBC_dE9F', property_value: 'x' },
    steps: [[query('a-bc-d-e9-f', 'x', [match({ id: 3, page: BOB_PAGE })])]]
  },
  {
    name: 'an uppercase key is lowercased',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'STATUS', property_value: 'doing' },
    steps: [[query('status', 'doing', [match({ id: 3, page: BOB_PAGE })])]]
  },
  {
    name: 'a number is matched as its text',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'priority', property_value: 42 },
    steps: [[query('priority', '42', [match({ id: 3, page: BOB_PAGE, properties: { priority: 42 } })])]]
  },
  {
    name: 'a whole number written with a fraction is matched as a whole one',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'priority', property_value: 3.0 },
    steps: [[query('priority', '3', [match({ id: 3, page: BOB_PAGE, properties: { priority: 3 } })])]]
  },
  {
    name: 'a fraction is matched as its text',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'score', property_value: 2.5 },
    steps: [[query('score', '2.5', [match({ id: 3, page: BOB_PAGE, properties: { score: 2.5 } })])]]
  },
  {
    name: 'a huge number is matched as JavaScript writes it',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'size', property_value: 1e21 },
    steps: [[query('size', '1e+21', [])]]
  },
  {
    name: 'a tiny number is matched as JavaScript writes it',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'size', property_value: 1e-7 },
    steps: [[query('size', '1e-7', [])]]
  },
  {
    name: 'a boolean true is matched as its text',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'done', property_value: true },
    steps: [[query('done', 'true', [match({ id: 3, page: BOB_PAGE, properties: { done: true } })])]]
  },
  {
    name: 'a boolean false is matched as its text',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'done', property_value: false },
    steps: [[query('done', 'false', [match({ id: 3, page: BOB_PAGE, properties: { done: false } })])]]
  },
  {
    // The empty text is a value: it is bound, not left out
    name: 'an empty value',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: '' },
    steps: [[query('status', '', [match({ id: 3, page: BOB_PAGE, properties: { status: '' } })])]]
  },
  {
    // A value is bound with `:in`, so quotes, brackets and a newline are never part of the query
    name: 'a value with quotes, brackets and unicode',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'note', property_value: 'say "hi" [[Zoë]] \u{1F680}\n(x)' },
    steps: [[query('note', 'say "hi" [[Zoë]] \u{1F680}\n(x)', [match({ id: 3, page: BOB_PAGE })])]]
  },
  {
    name: 'a multi-value property',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'type', property_value: 'project' },
    steps: [[query('type', 'project', [match({ id: 3, page: ATLAS_PAGE, properties: { type: ['project', 'internal'] } })])]]
  },
  {
    name: 'no match',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'blocked' },
    steps: [[query('status', 'blocked', [])]]
  },
  {
    // `null` is not "no matches" (BR-0011): the result is null, with no meta block
    name: 'null answer to the query',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    steps: [[query('status', 'doing', null)]]
  },
  {
    name: 'null cells are skipped',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    steps: [[query('status', 'doing', [[null], match({ id: 4, page: BOB_PAGE }), [null]])]]
  },
  {
    // A block with no page sorts as page 0, before every page
    name: 'a match with no page',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    steps: [[query('status', 'doing', [match({ id: 4, page: BOB_PAGE }), match({ id: 9 }), match({ id: 2 })])]]
  },
  {
    // A page id spelled `db/id` is not the page id the sort reads: such a page counts as page 0
    name: 'a page id spelled db/id',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing', slim_results: false },
    steps: [[query('status', 'doing', [match({ id: 4, page: { id: 20, name: 'bob' } }), match({ id: 3, page: { 'db/id': 5, name: 'carol' } })])]]
  },
  {
    // Two matches with one id keep the order LogSeq sent them in
    name: 'matches with one id',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    steps: [
      [
        query('status', 'doing', [
          match({ id: 8, content: 'first', page: BOB_PAGE }),
          match({ id: 9, content: 'newer', page: BOB_PAGE }),
          match({ id: 8, content: 'second', page: BOB_PAGE })
        ])
      ]
    ]
  },
  {
    name: 'limit cuts the list',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing', limit: 3 },
    steps: [[query('status', 'doing', MIXED_MATCHES)]]
  },
  {
    // limit 0 returns no blocks and the totals; there is no tip for an empty list
    name: 'limit zero',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing', limit: 0 },
    perturbed: [],
    steps: [[query('status', 'doing', MIXED_MATCHES)]]
  },
  {
    name: 'default limit cuts at 100',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    steps: [[query('status', 'doing', manyMatches(130))]]
  },
  {
    // Unslimmed blocks come back larger, so the same raise adds the note about a large result
    name: 'full matches cut with a large raise',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing', slim_results: false },
    steps: [[query('status', 'doing', manyMatches(130))]]
  },
  {
    name: 'raise limit to the maximum, with more matches than that',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing', limit: 150 },
    steps: [[query('status', 'doing', manyMatches(520))]]
  },
  {
    // The maximum is reached: no parameter fetches the rest, and the request for more is named
    name: 'limit past the maximum is clamped',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing', limit: 600 },
    steps: [[query('status', 'doing', manyMatches(520))]]
  },
  {
    name: 'limit at the maximum with matches left',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing', limit: 500 },
    steps: [[query('status', 'doing', manyMatches(520))]]
  },
  {
    name: 'limit past the safe range of a count',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing', limit: 9007199254740991 },
    steps: [[query('status', 'doing', manyMatches(520))]]
  },
  {
    name: 'limit that fits every match',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing', limit: 5 },
    steps: [[query('status', 'doing', MIXED_MATCHES)]]
  },
  {
    // The tip names the page most matches are on, among pages known not to be journals; slim blocks
    // carry no journal flag, so the page of unknown kind wins over a tag
    name: 'tip: the page most matches are on',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    steps: [[query('status', 'doing', [match({ id: 9, content: 'a #team', page: BOB_PAGE }), match({ id: 8, content: 'b', page: ATLAS_PAGE }), match({ id: 7, content: 'c', page: ATLAS_PAGE })])]]
  },
  {
    name: 'tip: a tag when the pages are of no known kind',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    steps: [[query('status', 'doing', [match({ id: 9, content: 'a #team', page: BARE_PAGE }), match({ id: 8, content: 'b #team #later', page: BARE_PAGE })])]]
  },
  {
    name: 'tip: only journal pages',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    steps: [[query('status', 'doing', [match({ id: 9, content: 'standup', page: JOURNAL_PAGE }), match({ id: 8, content: 'standup again', page: JOURNAL_PAGE })])]]
  },
  {
    name: 'tip: matches that carry page ids only',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    steps: [[query('status', 'doing', [match({ id: 9, content: 'plain', page: BARE_PAGE })])]]
  },
  {
    name: 'tip: a page whose kind is unknown, from full matches',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing', slim_results: false },
    steps: [[query('status', 'doing', [match({ id: 9, page: BOB_PAGE }), match({ id: 8, page: ATLAS_PAGE }), match({ id: 7, page: ATLAS_PAGE })])]]
  },
  {
    name: 'a match that is not in the shape the server can read: no uuid',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    perturbed: [],
    steps: [[query('status', 'doing', [[{ id: 4, content: 'x', properties: { status: 'doing' } }]])]]
  },
  {
    name: 'a match that is not in the shape the server can read: no id',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    perturbed: [],
    steps: [[query('status', 'doing', [[{ uuid: uuid(4), content: 'x' }]])]]
  },
  {
    name: 'a match that is not in the shape the server can read: a page of the wrong type',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    perturbed: [],
    steps: [[query('status', 'doing', [match({ id: 4, page: BOB_PAGE }), [{ id: 5, uuid: uuid(5), content: 'x', page: { name: 3 } }]])]]
  },
  {
    name: 'a match whose properties are not a map',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    perturbed: [],
    steps: [[query('status', 'doing', [[{ id: 5, uuid: uuid(5), content: 'x', properties: 'status:: doing' }]])]]
  },
  {
    name: 'row that is not a list',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    steps: [[query('status', 'doing', [7])]]
  },
  {
    name: 'row with two cells',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    steps: [[query('status', 'doing', [[{ id: 4 }, { id: 5 }]])]]
  },
  {
    name: 'answer that is not a list',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    steps: [[query('status', 'doing', { rows: 3 })]]
  },
  {
    // An error from LogSeq is an error result, not "no matches" (BR-0003)
    name: 'LogSeq error for the query',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing' },
    steps: [[query('status', 'doing', { error: 'Query timed out' })]]
  },
  { name: 'missing property_key', tool: 'logseq_query_by_property', arguments: { property_value: 'x' }, steps: [] },
  { name: 'bad property_key type', tool: 'logseq_query_by_property', arguments: { property_key: 42, property_value: 'x' }, steps: [] },
  { name: 'missing property_value', tool: 'logseq_query_by_property', arguments: { property_key: 'status' }, steps: [] },
  { name: 'bad property_value: an array', tool: 'logseq_query_by_property', arguments: { property_key: 'status', property_value: ['a'] }, steps: [] },
  { name: 'bad property_value: an object', tool: 'logseq_query_by_property', arguments: { property_key: 'status', property_value: { a: 1 } }, steps: [] },
  { name: 'bad limit: a string', tool: 'logseq_query_by_property', arguments: { property_key: 'status', property_value: 'x', limit: '5' }, steps: [] },
  { name: 'bad limit: a fraction', tool: 'logseq_query_by_property', arguments: { property_key: 'status', property_value: 'x', limit: 2.5 }, steps: [] },
  { name: 'bad limit: below the minimum', tool: 'logseq_query_by_property', arguments: { property_key: 'status', property_value: 'x', limit: -1 }, steps: [] },
  { name: 'bad limit: past the range of a count', tool: 'logseq_query_by_property', arguments: { property_key: 'status', property_value: 'x', limit: 1e300 }, steps: [] },
  { name: 'bad slim_results', tool: 'logseq_query_by_property', arguments: { property_key: 'status', property_value: 'x', slim_results: 0 }, steps: [] },
  {
    // The first argument in the order of the schema that is wrong is the one reported
    name: 'two bad arguments',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: [1], limit: 'a', slim_results: 'no' },
    steps: []
  },
  // A key that can't be one is refused before any LogSeq call, with the name as it was sent
  { name: 'bad key: a space', tool: 'logseq_query_by_property', arguments: { property_key: 'due date', property_value: 'x' }, steps: [] },
  { name: 'bad key: empty', tool: 'logseq_query_by_property', arguments: { property_key: '', property_value: 'x' }, steps: [] },
  { name: 'bad key: starts with a hyphen', tool: 'logseq_query_by_property', arguments: { property_key: '-status', property_value: 'x' }, steps: [] },
  { name: 'bad key: starts with an underscore', tool: 'logseq_query_by_property', arguments: { property_key: '_status', property_value: 'x' }, steps: [] },
  { name: 'bad key: a bracket and a quote', tool: 'logseq_query_by_property', arguments: { property_key: 'a"] [?x', property_value: 'x' }, steps: [] },
  { name: 'bad key: an accent', tool: 'logseq_query_by_property', arguments: { property_key: 'café', property_value: 'x' }, steps: [] },
  { name: 'bad key: a trailing newline', tool: 'logseq_query_by_property', arguments: { property_key: 'status\n', property_value: 'x' }, steps: [] },
  {
    // The key is checked after the arguments are parsed, so a bad limit is reported first
    name: 'bad key and bad limit',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'due date', property_value: 'x', limit: 'a' },
    steps: []
  },
  {
    name: 'null arguments are absent',
    tool: 'logseq_query_by_property',
    arguments: { property_key: 'status', property_value: 'doing', limit: null, slim_results: null },
    steps: [[query('status', 'doing', [match({ id: 3, page: BOB_PAGE })])]]
  }
];

// Case names are unique across every group (runParity refuses a duplicate), and the limit and argument cases
// here read like the other tools', so each name says which tool it is for.
export const queryByPropertyCases: ParityCase[] = cases.map(c => ({ ...c, name: `property: ${c.name}` }));
