// Parity cases for logseq_get_context_for_query (#312, #43, ADR-0025): the topics of a query, the
// keyword search of a query with none, and JSON, `compact` and `format: "markdown"`. Every page,
// block and name here is made up (BR-0001). Each case lists the LogSeq calls the TypeScript server
// makes, in order, with the answer the stub gives; the result the server printed for it is in
// ../expected/get-context-for-query.json.
import type { ParityCase } from '../harness.js';
import {
  ALICE,
  ALICE_NOTES,
  ATLAS,
  ATLAS_STUB,
  ATLAS_WITH_ALIAS,
  BOB,
  CAROL,
  GET_ALL_PAGES,
  LINKED_REFERENCES,
  NAMESPACE_LEAF,
  NEW_YEAR,
  PAGE_BLOCKS,
  RESOLVE_BY_NAME,
  RESOLVE_WITH_DAY,
  aliasSetsQuery,
  blocksOnPages,
  editor,
  exactSteps,
  flatBlock,
  linkedReferencesQuery,
  linkingBlock,
  member,
  pagesQuery,
  pageRow,
  pulled,
  pulledLinkingBlock,
  query,
  search,
  sourcePage,
  uuid,
  type Page
} from '../context-fixtures.js';

const TOOL = 'logseq_get_context_for_query';

const exact = (page: Page, input: string, blocks: unknown[], references: unknown) => exactSteps(RESOLVE_BY_NAME, page, input, blocks, references);

/** The calls of a topic that has no page: the resolver, the namespace leaf lookup and the suggestions. */
const missing = (name: string) => [
  [query(RESOLVE_BY_NAME, [JSON.stringify(name.toLowerCase())], [])],
  [query(NAMESPACE_LEAF, [JSON.stringify(`/${name.toLowerCase()}`)], [])],
  [editor(GET_ALL_PAGES, [], [{ originalName: 'Project Atlas' }, { originalName: 'Alice' }, { originalName: 'Bob' }])]
];

const ATLAS_BLOCKS = [flatBlock(102, 'Alice owns the schema', { parent: 101, left: 101 }), flatBlock(101, 'Kickoff with [[Alice]] and [[Bob]]')];
const ATLAS_REFERENCES = [[sourcePage(BOB), [linkingBlock(201, BOB.id), linkingBlock(202, BOB.id, 'Bob again links [[Project Atlas]]')]]];
const BOB_BLOCKS = [flatBlock(211, 'Bob owns the importer', { page: 20 })];
const BOB_REFERENCES = [[sourcePage(ATLAS), [linkingBlock(111, ATLAS.id, 'Kickoff with [[Bob]]')]]];

/** A topic of the query: Project Atlas, then Bob. */
const TWO_TOPICS = [...exact(ATLAS, 'Project Atlas', ATLAS_BLOCKS, ATLAS_REFERENCES), ...exact(BOB, 'bob', BOB_BLOCKS, BOB_REFERENCES)];

/** A search hit as `pull [* {:block/page ...}]` returns it: LogSeq's own keys. */
const hit = (id: number, content: unknown, page: { id: number; name: string; 'original-name': string } | undefined, extra: Record<string, unknown> = {}) => [
  {
    id,
    uuid: uuid(id),
    ...(content === undefined ? {} : { content }),
    format: 'markdown',
    left: { id: id - 1 },
    parent: { id: page?.id ?? 1 },
    ...(page ? { page } : {}),
    ...extra
  }
];

const ATLAS_PAGE = { id: 10, name: 'project atlas', 'original-name': 'Project Atlas' };
const BOB_PAGE = { id: 20, name: 'bob', 'original-name': 'Bob' };
const JOURNAL_PAGE = { id: 30, name: 'jan 1st, 2025', 'original-name': 'Jan 1st, 2025' };

// What the keyword search asks LogSeq for: the longest of the keywords, `importer`. Four blocks match
// it, one of them not `retries`, and they come in no particular order.
const IMPORTER_HITS = [
  hit(150, 'Retries are capped; the importer logs each retry', BOB_PAGE),
  hit(300, 'The importer retries failed rows\nsecond line', ATLAS_PAGE),
  hit(250, 'importer only here', ATLAS_PAGE),
  hit(90, 'IMPORTER RETRIES', JOURNAL_PAGE),
  hit(70, undefined, ATLAS_PAGE)
];
const KEYWORD_QUERY = 'what does the importer do with retries';

/** n hits that hold both keywords, ids 1 to n, in an order that is not id order. */
const manyHits = (n: number) => Array.from({ length: n }, (_, i) => hit(1 + ((i * 37) % n), `Entry ${i} about the importer and its retries`, ATLAS_PAGE));

const TOPIC_CASES: ParityCase[] = [
  {
    name: 'context_for_query: a link and a tag',
    tool: TOOL,
    arguments: { query: 'tell me about [[Project Atlas]] and #bob' },
    steps: TWO_TOPICS
  },
  {
    // A topic with no page is skipped, with a warning, and the next one is built
    name: 'context_for_query: a topic with no page is skipped',
    tool: TOOL,
    arguments: { query: 'about [[Projct Atlas]] and [[Project Atlas]]' },
    steps: [...missing('Projct Atlas'), ...exact(ATLAS, 'Project Atlas', ATLAS_BLOCKS, [])]
  },
  {
    // An ambiguous topic is skipped the same way, and its candidates are kept
    name: 'context_for_query: an ambiguous topic is skipped with its candidates',
    tool: TOOL,
    arguments: { query: 'about [[al]] and [[Project Atlas]]' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"al"'], [[pulled(ALICE_NOTES), 'alias'], [pulled(ALICE), 'alias']])],
      ...exact(ATLAS, 'Project Atlas', ATLAS_BLOCKS, [])
    ]
  },
  {
    // More candidates than are listed: a second warning says the list was cut, and hasMore stays false
    name: 'context_for_query: an ambiguous topic with more candidates than are listed',
    tool: TOOL,
    arguments: { query: 'about [[al]]' },
    steps: [
      [
        query(
          RESOLVE_BY_NAME,
          ['"al"'],
          Array.from({ length: 12 }, (_, i): [unknown, string] => [pulled({ id: 100 + i, name: `page ${String(i).padStart(2, '0')}`, originalName: `Page ${String(i).padStart(2, '0')}` }), 'alias'])
        )
      ]
    ]
  },
  {
    // Only the first max_topics topics are built, and the rest are counted
    name: 'context_for_query: more topics than max_topics',
    tool: TOOL,
    arguments: { query: 'compare [[Project Atlas]] [[Bob]] [[Carol]]', max_topics: 2 },
    steps: [...exact(ATLAS, 'Project Atlas', ATLAS_BLOCKS, []), ...exact(BOB, 'Bob', BOB_BLOCKS, [])]
  },
  {
    // A topic cut at its own caps (10 blocks, 5 related pages, 10 references) says how to get the rest from build_context
    name: 'context_for_query: a topic cut at the caps of a query',
    tool: TOOL,
    arguments: { query: 'about [[Project Atlas]]' },
    steps: exact(
      ATLAS,
      'Project Atlas',
      Array.from({ length: 12 }, (_, i) => flatBlock(1000 + i, `Entry ${i + 1}`, { left: i === 0 ? ATLAS.id : 1000 + i - 1 })),
      Array.from({ length: 7 }, (_, i): [unknown, unknown[]] => [
        sourcePage({ id: 300 + i, name: `source ${i}`, originalName: `Source ${i}` }),
        [linkingBlock(3000 + i, 300 + i), ...(i < 4 ? [linkingBlock(3100 + i, 300 + i)] : [])]
      ])
    )
  },
  {
    // The page's aliases are covered, and reported in the topic's own context
    name: 'context_for_query: a topic with aliases',
    tool: TOOL,
    arguments: { query: 'about [[Atlas]]' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulled(ATLAS_STUB), 'name'], [pulled(ATLAS_WITH_ALIAS), 'alias']])],
      [query(aliasSetsQuery([10]), [], [member(10, ATLAS), member(10, ATLAS_STUB)])],
      [query(blocksOnPages([10, 11]), [], [flatBlock(1101, 'On the stub', { page: 11 }), flatBlock(101, 'On the page asked about', { page: 10 })])],
      [query(linkedReferencesQuery([10, 11]), [], [pulledLinkingBlock(201, BOB)])]
    ]
  },
  {
    // A group past the cap warns in `build_context`, but its warnings are not rolled up here (suspected TS bug)
    name: 'context_for_query: an alias group past the cap is not reported',
    tool: TOOL,
    arguments: { query: 'about [[Project Atlas]]' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"project atlas"'], [[pulled({ ...ATLAS, alias: [100] }), 'name']])],
      [
        query(aliasSetsQuery([10]), [], [
          member(10, ATLAS),
          ...Array.from({ length: 60 }, (_, i) =>
            member(10, { id: 100 + i, name: `member ${String(59 - i).padStart(2, '0')}`, originalName: `Member ${String(59 - i).padStart(2, '0')}` })
          )
        ])
      ],
      [query(blocksOnPages([10, ...Array.from({ length: 49 }, (_, k) => 159 - k)]), [], [flatBlock(101, 'Only block')])],
      [query(linkedReferencesQuery([10, ...Array.from({ length: 49 }, (_, k) => 159 - k)]), [], [])]
    ]
  },
  {
    name: 'context_for_query: a journal by its ISO date, as a tag',
    tool: TOOL,
    arguments: { query: 'what happened #2025-01-01' },
    steps: [
      [query(RESOLVE_WITH_DAY, ['"2025-01-01"', '20250101'], [[pulled(NEW_YEAR), 'journal-date']])],
      [query(PAGE_BLOCKS, ['"jan 1st, 2025"'], [flatBlock(301, 'Planned the day', { page: 30 })])],
      [editor(LINKED_REFERENCES, ['jan 1st, 2025'], [])]
    ]
  },
  {
    // The same topic written twice is built once, a tag and a link of one name too
    name: 'context_for_query: a topic named twice is built once',
    tool: TOOL,
    arguments: { query: '[[Bob]] again [[Bob]] and #Bob #Bob' },
    steps: exact(BOB, 'Bob', BOB_BLOCKS, [])
  },
  {
    // A tag runs to the next space or `#`, so the comma is part of it: this page is named so
    name: 'context_for_query: a tag with punctuation after it',
    tool: TOOL,
    arguments: { query: 'about #bob, and more' },
    steps: exact({ id: 70, name: 'bob,', originalName: 'Bob,' }, 'bob,', [flatBlock(701, 'A page named with a comma', { page: 70 })], [])
  },
  {
    // A link with a `]` inside is not one, and neither is an empty one: no topic, so the keywords are searched
    name: 'context_for_query: brackets that are not links',
    tool: TOOL,
    arguments: { query: 'about [[]] and [[a]b]] importer' },
    steps: [[search('importer', [])]]
  }
];

const SEARCH_CASES: ParityCase[] = [
  {
    // The longest keyword is searched; the blocks that hold every keyword are kept, newest first, whatever their case
    name: 'context_for_query: keywords with no topic',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY },
    steps: [[search('importer', IMPORTER_HITS)]]
  },
  {
    name: 'context_for_query: max_search_results below the hits',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY, max_search_results: 1 },
    steps: [[search('importer', IMPORTER_HITS)]]
  },
  {
    name: 'context_for_query: max_search_results of 0 keeps none',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY, max_search_results: 0 },
    steps: [[search('importer', IMPORTER_HITS)]],
    // only the count of the hits is shown
    perturbed: [hit(300, 'The importer retries failed rows', ATLAS_PAGE)]
  },
  {
    // 101 hits and a request for more than the maximum: 100 are kept, the warning says why and has no way to get the rest
    name: 'context_for_query: more hits than the maximum',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY, max_search_results: 500 },
    steps: [[search('importer', manyHits(101))]]
  },
  {
    // Between the default and the maximum: raising max_search_results gets the rest, and the warning says so
    name: 'context_for_query: more hits than the default',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY },
    steps: [[search('importer', manyHits(30))]]
  },
  {
    name: 'context_for_query: keywords with no hit',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY },
    steps: [[search('importer', [hit(250, 'importer only here', ATLAS_PAGE)])]],
    perturbed: [hit(250, 'importer and retries', ATLAS_PAGE)]
  },
  {
    // PARITY: a null answer is a search with no matches (suspected TS bug, BR-0011)
    name: 'context_for_query: the search answers null',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY },
    steps: [[search('importer', null)]]
  },
  {
    // Only the first three words that are long enough and not stop words are looked for
    name: 'context_for_query: only the first three keywords',
    tool: TOOL,
    arguments: { query: 'Retries  importer\tparsers ignored extra' },
    steps: [
      [
        search('importer', [
          hit(40, 'retries importer parsers', ATLAS_PAGE),
          hit(41, 'retries importer ignored', ATLAS_PAGE),
          hit(42, 'importer parsers', ATLAS_PAGE)
        ])
      ]
    ]
  },
  {
    // The first of two equally long keywords is the one searched; JavaScript lowercases an accented capital
    name: 'context_for_query: equally long keywords and accents',
    tool: TOOL,
    arguments: { query: 'ÉCOLE Retry' },
    steps: [[search('école', [hit(60, 'L’École retry policy', ATLAS_PAGE), hit(61, 'école alone', ATLAS_PAGE)])]]
  },
  {
    // Words of three letters or fewer, and stop words, are no keywords: no search is made
    name: 'context_for_query: no keywords',
    tool: TOOL,
    arguments: { query: 'what is the way of it?' },
    steps: []
  },
  {
    // A search text is escaped before it is a pattern
    name: 'context_for_query: a keyword with regex characters',
    tool: TOOL,
    arguments: { query: 'v1.2 (beta)' },
    steps: [[search('(beta)', [hit(80, 'ships v1.2 (beta) soon', ATLAS_PAGE)])]]
  },
  {
    name: 'context_for_query: LogSeq error from the search',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY },
    steps: [[search('importer', { error: 'Query timed out' })]]
  },
  {
    name: 'context_for_query: search hits in a shape the server cannot read',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY },
    // no string in the answer, so the self-check can perturb it into an error of another kind
    steps: [[search('importer', [[{ id: 'one' }]])]],
    perturbed: [[{ id: true }]]
  },
  {
    // An error that is not a missing page is not a warning: it ends the call
    name: 'context_for_query: LogSeq error from a topic',
    tool: TOOL,
    arguments: { query: 'about [[Project Atlas]]' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"project atlas"'], [[pulled(ATLAS), 'name']])],
      [query(PAGE_BLOCKS, ['"project atlas"'], { error: 'Query timed out' })]
    ]
  },
  {
    name: 'context_for_query: compact topics',
    tool: TOOL,
    arguments: { query: 'about [[Project Atlas]] and #bob', compact: true },
    steps: TWO_TOPICS
  },
  {
    name: 'context_for_query: compact search hits',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY, compact: true },
    steps: [[search('importer', IMPORTER_HITS)]]
  }
];

const ARGUMENT_CASES: ParityCase[] = [
  { name: 'context_for_query: max_topics of 0', tool: TOOL, arguments: { query: 'about [[Project Atlas]]', max_topics: 0 }, steps: [] },
  { name: 'context_for_query: a negative max_search_results', tool: TOOL, arguments: { query: KEYWORD_QUERY, max_search_results: -1 }, steps: [] },
  { name: 'context_for_query: a fraction for max_topics', tool: TOOL, arguments: { query: KEYWORD_QUERY, max_topics: 1.5 }, steps: [] },
  { name: 'context_for_query: no query', tool: TOOL, arguments: { max_topics: 3 }, steps: [] },
  { name: 'context_for_query: a query that is not text', tool: TOOL, arguments: { query: ['a'] }, steps: [] },
  { name: 'context_for_query: format is not a known one', tool: TOOL, arguments: { query: KEYWORD_QUERY, format: 'html' }, steps: [] }
];

/** The cases again as Markdown. */
const markdownOf = (cases: readonly ParityCase[]): ParityCase[] =>
  cases.map(c => ({ ...c, name: c.name.replace('context_for_query:', 'context_for_query markdown:'), arguments: { ...c.arguments, format: 'markdown' } }));

export const getContextForQueryCases: ParityCase[] = [
  ...TOPIC_CASES,
  ...SEARCH_CASES,
  ...ARGUMENT_CASES,

  // ---- Markdown: the topics and the cases that make no search are the JSON cases again
  ...markdownOf(TOPIC_CASES),
  ...markdownOf([
    ...ARGUMENT_CASES.filter(c => !c.name.includes('format is not')),
    SEARCH_CASES.find(c => c.name.endsWith('no keywords'))!,
    SEARCH_CASES.find(c => c.name.endsWith('LogSeq error from a topic'))!
  ]),
  // ---- Markdown names the page of each keyword hit, from one extra query for the hits kept
  {
    name: 'context_for_query markdown: keyword hits name their pages',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY, format: 'markdown' },
    // the pages of the three hits kept, once each, in the order of the hits (newest first): Atlas (300), Bob (150), Journal (90)
    steps: [[search('importer', IMPORTER_HITS)], [query(pagesQuery([10, 20, 30]), [], [pageRow(BOB), pageRow(ATLAS), pageRow({ ...NEW_YEAR, file: false })])]]
  },
  {
    // A hit whose page is not in the answer has no page to name
    name: 'context_for_query markdown: a hit whose page is not found',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY, format: 'markdown' },
    steps: [[search('importer', IMPORTER_HITS)], [query(pagesQuery([10, 20, 30]), [], [pageRow(ATLAS)])]]
  },
  {
    name: 'context_for_query markdown: keyword hits, compact',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY, format: 'markdown', compact: true },
    steps: [[search('importer', IMPORTER_HITS)], [query(pagesQuery([10, 20, 30]), [], [pageRow(BOB), pageRow(ATLAS), pageRow({ ...NEW_YEAR, file: false })])]]
  },
  {
    // No hit is kept, so no page is looked up
    name: 'context_for_query markdown: no hits makes no page lookup',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY, format: 'markdown' },
    steps: [[search('importer', [hit(250, 'importer only here', ATLAS_PAGE)])]],
    perturbed: [hit(250, 'importer and retries', ATLAS_PAGE)]
  },
  {
    name: 'context_for_query markdown: max_search_results of 0 looks up no page',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY, format: 'markdown', max_search_results: 0 },
    steps: [[search('importer', IMPORTER_HITS)]],
    perturbed: [hit(300, 'The importer retries failed rows', ATLAS_PAGE)]
  },
  {
    name: 'context_for_query markdown: the pages of the hits kept only, and the cut in the footer',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY, format: 'markdown', max_search_results: 1 },
    steps: [[search('importer', IMPORTER_HITS)], [query(pagesQuery([10]), [], [pageRow(ATLAS)])]]
  },
  {
    name: 'context_for_query markdown: the search answers null',
    tool: TOOL,
    arguments: { query: KEYWORD_QUERY, format: 'markdown' },
    steps: [[search('importer', null)]]
  },
  {
    name: 'context_for_query markdown: compact topics',
    tool: TOOL,
    arguments: { query: 'about [[Project Atlas]] and #bob', format: 'markdown', compact: true },
    steps: TWO_TOPICS
  },
  {
    // A hit that is on a journal page, from the pages query: the title is the page's original name
    name: 'context_for_query markdown: a journal topic and a topic that is gone',
    tool: TOOL,
    arguments: { query: 'what happened #2025-01-01 and [[Projct Atlas]]', format: 'markdown' },
    steps: [
      // the links are built before the tags
      ...missing('Projct Atlas'),
      [query(RESOLVE_WITH_DAY, ['"2025-01-01"', '20250101'], [[pulled(NEW_YEAR), 'journal-date']])],
      [query(PAGE_BLOCKS, ['"jan 1st, 2025"'], [flatBlock(301, 'Planned the day', { page: 30 })])],
      [editor(LINKED_REFERENCES, ['jan 1st, 2025'], [[sourcePage(CAROL), [linkingBlock(411, CAROL.id, 'Carol mentions [[Jan 1st, 2025]]')]]])]
    ]
  }
];
