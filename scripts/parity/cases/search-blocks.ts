// Parity cases for logseq_search_blocks (#306, ADR-0025). Every page, block and name here is made
// up (BR-0001). Each case lists the LogSeq calls the TypeScript server makes, in order, with the
// answer the stub gives; the result the server printed for it is in ../expected/.
//
// Calls are written as they go over the wire: a Datalog query's inputs are the EDN (JSON) text the
// client sends, so the search pattern is the JSON text of the string `(?i)` plus the escaped query.
import { DATASCRIPT_QUERY, type CannedCall } from '../stub-logseq.js';
import type { ParityCase } from '../harness.js';

const SEARCH =
  '[:find (pull ?b [* {:block/page [:db/id :block/name :block/original-name]}]) :in $ ?pattern :where ' +
  '[?b :block/content ?c] [(re-pattern ?pattern) ?re] [(re-find ?re ?c)]]';

const pagesQuery = (ids: number[]) => `[:find (pull ?p [*]) :where [(ground [${ids.join(' ')}]) [?p ...]] [?p :block/name]]`;

/** The input LogSeq receives for a search text: `(?i)` and the text with its regex characters escaped. */
const pattern = (text: string) => JSON.stringify(`(?i)${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

const search = (text: string, response: unknown): CannedCall => ({
  method: DATASCRIPT_QUERY,
  args: [SEARCH, pattern(text)],
  response
});

const pages = (ids: number[], response: unknown): CannedCall => ({ method: DATASCRIPT_QUERY, args: [pagesQuery(ids)], response });

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

interface Hit {
  id: number;
  content?: unknown;
  page?: NestedPage;
  /** More keys of the block, written after `page` */
  extra?: Record<string, unknown>;
  /** Keys written before `content`, e.g. `properties` */
  before?: Record<string, unknown>;
}

/** A block as `pull [* {:block/page ...}]` returns it: LogSeq's own keys. */
const hit = ({ id, content, page, extra, before }: Hit) => [
  {
    id,
    uuid: uuid(id),
    ...(content === undefined ? {} : { content }),
    ...(before ?? {}),
    format: 'markdown',
    left: { id: id - 1 },
    parent: { id: page?.id ?? 1 },
    ...(page ? { page } : {}),
    ...(extra ?? {})
  }
];

/** A page as `pull [*]` returns it. */
const pulledPage = (id: number, name: string, originalName: string | undefined, extra: Record<string, unknown> = {}) => [
  {
    id,
    uuid: uuid(id),
    name,
    ...(originalName === undefined ? {} : { 'original-name': originalName }),
    'journal?': false,
    file: { id: id + 5000 },
    'created-at': 1735700000000,
    'updated-at': 1735700001000,
    ...extra
  }
];

const ATLAS_ROW = pulledPage(10, 'project atlas', 'Project Atlas', { properties: { type: 'project', empty: '' }, 'properties-text-values': { type: 'project' } });
const BOB_ROW = pulledPage(20, 'bob', 'Bob');
const JOURNAL_ROW = pulledPage(30, 'jan 1st, 2025', 'Jan 1st, 2025', {
  'journal?': true,
  'journal-day': 20250101,
  file: undefined
});

const IMPORTER_HITS = [
  hit({ id: 105, content: 'Bob owns the importer', page: BOB_PAGE }),
  hit({
    id: 512,
    content: 'TODO ship the [[Importer]] with #urgent and #later',
    page: ATLAS_PAGE,
    before: { marker: 'TODO', properties: { status: 'open', owner: '', done: false, count: 0, tags: [], note: '  ' } }
  }),
  hit({ id: 340, content: 'The importer drops rows when a field is empty', page: JOURNAL_PAGE }),
  hit({ id: 77, content: 'importer', page: BARE_PAGE }),
  hit({ id: 201, content: 'No page on this importer block' })
];

/** n hits, ids 1000 to 1000 + n - 1, in an order that is not id order. */
const manyHits = (n: number) =>
  Array.from({ length: n }, (_, i) => hit({ id: 1000 + ((i * 37) % n), content: `Log entry ${i} mentions the importer`, page: ATLAS_PAGE }));

export const searchBlocksCases: ParityCase[] = [
  {
    name: 'slim hits, newest first',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer' },
    steps: [[search('importer', IMPORTER_HITS)]]
  },
  {
    // Every key of the block as LogSeq sent it, in its order: an integer-like property key is
    // written first, as JavaScript writes it
    name: 'full hits as they came',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', slim_results: false },
    steps: [
      [
        search('importer', [
          hit({ id: 512, content: 'TODO ship the importer', page: ATLAS_PAGE, before: { marker: 'TODO', properties: { b: 'x', '2': 'two', a: { nested: [1, 2.5] } } }, extra: { 'path-refs': [{ id: 10 }], refs: [{ id: 10, name: 'project atlas' }] } }),
          hit({ id: 105, content: 'Bob owns the importer', page: BOB_PAGE })
        ])
      ]
    ]
  },
  {
    name: 'slim hits with context',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', include_context: true },
    steps: [
      [search('importer', IMPORTER_HITS)],
      // the pages of the hits kept, once each, in the order of the hits (newest first): Atlas, Journal, Bob, Bare.
      // The bare page (40) is not in the answer, so its block gets no context
      [pages([10, 30, 20, 40], [ATLAS_ROW, JOURNAL_ROW, BOB_ROW])]
    ]
  },
  {
    name: 'full hits with context',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', include_context: true, slim_results: false },
    steps: [
      [search('importer', IMPORTER_HITS)],
      [pages([10, 30, 20, 40], [ATLAS_ROW, JOURNAL_ROW, BOB_ROW])]
    ]
  },
  {
    // The page is pulled with LogSeq's kebab-case keys, and the context page carries the camelCase
    // spellings after them (original-name stays too); a pull that already has `originalName` keeps its place
    name: 'context page with every renamed key',
    tool: 'logseq_search_blocks',
    arguments: { query: 'atlas', include_context: true, slim_results: false },
    steps: [
      [search('atlas', [hit({ id: 9, content: 'atlas', page: ATLAS_PAGE })])],
      [
        pages([10], [
          [
            {
              id: 10,
              'original-name': 'Project Atlas',
              name: 'project atlas',
              'journal-day': 20250101,
              'journal?': true,
              'created-at': 1,
              'updated-at': 2,
              'properties-text-values': { a: 'b' },
              originalName: 'Atlas (already camel)',
              properties: { x: 'y' }
            }
          ]
        ])
      ]
    ]
  },
  {
    name: 'context for slim journal page',
    tool: 'logseq_search_blocks',
    arguments: { query: 'new year', include_context: true },
    steps: [
      [search('new year', [hit({ id: 9, content: 'New year [[Resolutions]] #planning', page: JOURNAL_PAGE })])],
      [pages([30], [JOURNAL_ROW])]
    ]
  },
  {
    // No block has a page id: no second call
    name: 'context with no page ids',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', include_context: true },
    steps: [[search('importer', [hit({ id: 5, content: 'importer without a page' })])]]
  },
  {
    // A page id spelled `db/id`, as an older LogSeq or a test double sends it
    name: 'context for a page id spelled db/id',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', include_context: true },
    steps: [
      [search('importer', [hit({ id: 5, content: 'importer', page: { 'db/id': 20, name: 'bob' } })])],
      [pages([20], [BOB_ROW])]
    ]
  },
  {
    // A null answer to the page lookup drops every context, with no warning (suspected TypeScript bug)
    name: 'null answer to the context lookup',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', include_context: true },
    steps: [
      [search('importer', [hit({ id: 5, content: 'importer', page: BOB_PAGE })])],
      [pages([20], null)]
    ]
  },
  {
    name: 'a page row that is not a page',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', include_context: true },
    steps: [
      [search('importer', [hit({ id: 5, content: 'importer', page: BOB_PAGE })])],
      [pages([20], [[null]])]
    ]
  },
  {
    // Context is looked up for the hits kept only: the page of the cut hit is not asked for
    name: 'limit cuts the list and the context lookup',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', limit: 2, include_context: true },
    steps: [
      [search('importer', IMPORTER_HITS)],
      [pages([10, 30], [ATLAS_ROW, JOURNAL_ROW])]
    ]
  },
  {
    name: 'limit cuts the list',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', limit: 3 },
    steps: [[search('importer', IMPORTER_HITS)]]
  },
  {
    // limit 0 returns no blocks and the totals; a search that matched is not a miss, so no tip
    name: 'limit zero',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', limit: 0 },
    perturbed: [],
    steps: [[search('importer', IMPORTER_HITS)]]
  },
  {
    name: 'default limit cuts at 100',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer' },
    steps: [[search('importer', manyHits(130))]]
  },
  {
    // Unslimmed blocks come back larger, so the same raise adds the note about a large result
    name: 'full hits cut with a large raise',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', slim_results: false },
    steps: [[search('importer', manyHits(130))]]
  },
  {
    name: 'raise limit to the maximum, with more matches than that',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', limit: 150 },
    steps: [[search('importer', manyHits(520))]]
  },
  {
    // The maximum is reached: no parameter fetches the rest, and the request for more is named
    name: 'limit past the maximum is clamped',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', limit: 600 },
    steps: [[search('importer', manyHits(520))]]
  },
  {
    name: 'limit at the maximum with matches left',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', limit: 500 },
    steps: [[search('importer', manyHits(520))]]
  },
  {
    name: 'limit past the safe range of a count',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', limit: 9007199254740991 },
    steps: [[search('importer', manyHits(520))]]
  },
  {
    // Two hits with one id keep the order LogSeq sent them in
    name: 'hits with one id',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer' },
    steps: [
      [
        search('importer', [
          hit({ id: 8, content: 'importer first', page: BOB_PAGE }),
          hit({ id: 9, content: 'importer newer', page: BOB_PAGE }),
          hit({ id: 8, content: 'importer second', page: BOB_PAGE })
        ])
      ]
    ]
  },
  {
    name: 'no match',
    tool: 'logseq_search_blocks',
    arguments: { query: '  importer rows ' },
    steps: [[search('  importer rows ', [])]]
  },
  {
    name: 'no match for a blank query',
    tool: 'logseq_search_blocks',
    arguments: { query: ' ' },
    steps: [[search(' ', [])]]
  },
  {
    // The empty text is a text: every block holding any content matches it
    name: 'empty query',
    tool: 'logseq_search_blocks',
    arguments: { query: '' },
    steps: [[search('', [hit({ id: 3, content: 'anything', page: BOB_PAGE })])]]
  },
  {
    // `null` is not "no matches" (BR-0011): the result is null, with no meta block
    name: 'null answer to the search',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer' },
    steps: [[search('importer', null)]]
  },
  {
    // A null cell, and a block with no text or text that is not a string, are skipped
    name: 'rows with nothing to search',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer' },
    steps: [
      [
        search('importer', [
          [null],
          hit({ id: 4, page: BOB_PAGE }),
          hit({ id: 5, content: 7, page: BOB_PAGE }),
          hit({ id: 6, content: 'importer kept', page: BOB_PAGE })
        ])
      ]
    ]
  },
  {
    name: 'regex characters in the query are escaped',
    tool: 'logseq_search_blocks',
    arguments: { query: 'a.b (c) [d] \\ "q" ^$|?*+{}' },
    steps: [[search('a.b (c) [d] \\ "q" ^$|?*+{}', [hit({ id: 3, content: 'a.b (c) [d] \\ "q" ^$|?*+{}', page: BOB_PAGE })])]]
  },
  {
    name: 'unicode query and content',
    tool: 'logseq_search_blocks',
    arguments: { query: 'café \u{1F680}' },
    steps: [[search('café \u{1F680}', [hit({ id: 3, content: 'Café \u{1F680} #naïve [[Zoë]]', page: BOB_PAGE })])]]
  },
  {
    // Refs and tags are read as the TypeScript regexes read them
    name: 'refs and tags in odd places',
    tool: 'logseq_search_blocks',
    arguments: { query: 'ref' },
    steps: [
      [
        search('ref', [
          hit({ id: 3, content: 'ref [[a]][[b]] [[[c]] [[]] [[d]e]] #t1#t2 # x # y #end', page: BOB_PAGE }),
          hit({ id: 2, content: 'ref [[multi\nline]] #', page: BOB_PAGE })
        ])
      ]
    ]
  },
  {
    // Slim hits that sit on journal pages, with no tags: the tip names the most common journal page
    name: 'tip: only journal pages',
    tool: 'logseq_search_blocks',
    arguments: { query: 'standup', include_context: true },
    steps: [
      [search('standup', [hit({ id: 9, content: 'standup notes', page: JOURNAL_PAGE }), hit({ id: 8, content: 'standup again', page: JOURNAL_PAGE })])],
      [pages([30], [JOURNAL_ROW])]
    ]
  },
  {
    name: 'tip: a tag when every page is a journal',
    tool: 'logseq_search_blocks',
    arguments: { query: 'standup', include_context: true },
    steps: [
      [search('standup', [hit({ id: 9, content: 'standup #team', page: JOURNAL_PAGE }), hit({ id: 8, content: 'standup #team #notes', page: JOURNAL_PAGE })])],
      [pages([30], [JOURNAL_ROW])]
    ]
  },
  {
    name: 'tip: a page that is not a journal',
    tool: 'logseq_search_blocks',
    arguments: { query: 'standup', include_context: true },
    steps: [
      [search('standup', [hit({ id: 9, content: 'standup #team', page: JOURNAL_PAGE }), hit({ id: 8, content: 'standup', page: ATLAS_PAGE })])],
      [pages([30, 10], [JOURNAL_ROW, ATLAS_ROW])]
    ]
  },
  {
    name: 'tip: hits that carry page ids only',
    tool: 'logseq_search_blocks',
    arguments: { query: 'standup' },
    steps: [[search('standup', [hit({ id: 9, content: 'standup', page: BARE_PAGE })])]]
  },
  {
    name: 'tip: a page whose kind is unknown, from full hits',
    tool: 'logseq_search_blocks',
    arguments: { query: 'standup', slim_results: false },
    steps: [[search('standup', [hit({ id: 9, content: 'standup', page: BOB_PAGE }), hit({ id: 8, content: 'standup', page: ATLAS_PAGE }), hit({ id: 7, content: 'standup', page: ATLAS_PAGE })])]]
  },
  {
    name: 'hit that is not in the shape the server can read: no uuid',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer' },
    perturbed: [],
    steps: [[search('importer', [[{ id: 4, content: 'importer' }]])]]
  },
  {
    name: 'hit that is not in the shape the server can read: no id',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer' },
    perturbed: [],
    steps: [[search('importer', [[{ uuid: uuid(4), content: 'importer' }]])]]
  },
  {
    // The path is the hit's place among the hits that are kept, after the skipped ones
    name: 'hit that is not in the shape the server can read: a page of the wrong type',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer' },
    perturbed: [],
    steps: [[search('importer', [[null], hit({ id: 4, content: 'importer' }), [{ id: 5, uuid: uuid(5), content: 'importer', page: { name: 3 } }]])]]
  },
  {
    name: 'row that is not a list',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer' },
    steps: [[search('importer', [7])]]
  },
  {
    name: 'row with two cells',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer' },
    steps: [[search('importer', [[{ id: 4 }, { id: 5 }]])]]
  },
  {
    name: 'answer that is not a list',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer' },
    steps: [[search('importer', { rows: 3 })]]
  },
  {
    name: 'page row in a shape the server cannot read',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', include_context: true },
    steps: [
      [search('importer', [hit({ id: 5, content: 'importer', page: BOB_PAGE })])],
      [pages([20], [[{ id: 20, name: 4 }]])]
    ]
  },
  {
    // An error from LogSeq is an error result, not "no matches" (BR-0003)
    name: 'LogSeq error for the search',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer' },
    steps: [[search('importer', { error: 'Query timed out' })]]
  },
  {
    name: 'LogSeq error for the context lookup',
    tool: 'logseq_search_blocks',
    arguments: { query: 'importer', include_context: true },
    steps: [
      [search('importer', [hit({ id: 5, content: 'importer', page: BOB_PAGE })])],
      [pages([20], { error: 'Query timed out' })]
    ]
  },
  { name: 'missing query', tool: 'logseq_search_blocks', arguments: {}, steps: [] },
  { name: 'bad query', tool: 'logseq_search_blocks', arguments: { query: 42 }, steps: [] },
  { name: 'bad limit: a string', tool: 'logseq_search_blocks', arguments: { query: 'x', limit: '5' }, steps: [] },
  { name: 'bad limit: a fraction', tool: 'logseq_search_blocks', arguments: { query: 'x', limit: 2.5 }, steps: [] },
  { name: 'bad limit: below the minimum', tool: 'logseq_search_blocks', arguments: { query: 'x', limit: -1 }, steps: [] },
  { name: 'bad limit: past the range of a count', tool: 'logseq_search_blocks', arguments: { query: 'x', limit: 1e300 }, steps: [] },
  { name: 'bad limit: a boolean', tool: 'logseq_search_blocks', arguments: { query: 'x', limit: true }, steps: [] },
  { name: 'bad include_context', tool: 'logseq_search_blocks', arguments: { query: 'x', include_context: 'yes' }, steps: [] },
  { name: 'bad slim_results', tool: 'logseq_search_blocks', arguments: { query: 'x', slim_results: 0 }, steps: [] },
  {
    // The first argument in the order of the schema that is wrong is the one reported
    name: 'two bad arguments',
    tool: 'logseq_search_blocks',
    arguments: { query: 'x', slim_results: 'no', limit: [1] },
    steps: []
  },
  {
    name: 'null arguments are absent',
    tool: 'logseq_search_blocks',
    arguments: { query: 'bob', limit: null, include_context: null, slim_results: null },
    steps: [[search('bob', [hit({ id: 3, content: 'Bob', page: BOB_PAGE })])]]
  }
];
