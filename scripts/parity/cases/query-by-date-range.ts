// Parity cases for logseq_query_by_date_range (#311, #299, ADR-0025). Every page, block and name here
// is made up (BR-0001). Each case lists the LogSeq calls the TypeScript server makes, in order, with
// the answer the stub gives; the result the server printed for it is in ../expected/.
//
// Dates that depend on today (`last_n`, a preset) are relative to the instant the harness fixes for
// every server (`PARITY_NOW_MS` in ../harness.ts): the evening of Tuesday 2025-03-11 in
// America/New_York, which is already the 12th in UTC. Queries are written out in full, as they go over
// the wire, and the bounds are the JSON text of the numbers.
import { DATASCRIPT_QUERY, type CannedCall } from '../stub-logseq.js';
import type { ParityCase } from '../harness.js';
import { ATLAS, BOB, pulledPage, refQuery, target, uuid, type PageSpec } from '../ref-fixtures.js';

const PAGES_IN_RANGE =
  '[:find (pull ?page [*]) :in $ ?start ?end :where [?page :block/name] [?page :block/journal-day ?day] ' +
  '[(>= ?day ?start)] [(<= ?day ?end)]]';

const BLOCKS_IN_RANGE =
  '[:find (pull ?block [* {:block/refs [:db/id :block/name :block/original-name :block/journal? :block/journal-day]}]) ' +
  ':in $ ?start ?end :where [?page :block/name] [?page :block/journal-day ?day] [(>= ?day ?start)] [(<= ?day ?end)] ' +
  '[?block :block/page ?page]]';

const PAGES_UP_TO =
  '[:find (pull ?page [:db/id :block/uuid :block/name :block/original-name :block/journal-day :block/journal?]) ' +
  ':in $ ?latest :where [?page :block/name] [?page :block/journal-day ?day] [(<= ?day ?latest)]]';

const ALIAS_BY_NAME =
  '[:find (pull ?s [:db/id :block/name :block/original-name]) (pull ?m [:db/id :block/name :block/original-name]) ' +
  ':in $ ?page-name :where [?s :block/name ?page-name] ' +
  '(or-join [?s ?m] (or-join [?s ?m] [?s :block/alias ?m] [?m :block/alias ?s]) ' +
  '(and (or-join [?s ?alias-mid] [?s :block/alias ?alias-mid] [?alias-mid :block/alias ?s]) ' +
  '(or-join [?alias-mid ?m] [?alias-mid :block/alias ?m] [?m :block/alias ?alias-mid])))]';

const query = (text: string, inputs: string[], response: unknown): CannedCall => ({ method: DATASCRIPT_QUERY, args: [text, ...inputs], response });

const TOOL = 'logseq_query_by_date_range';

// ---- pages

const ordinal = (n: number) => (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');

/** The journal page of January `n`, 2025. */
const january = (n: number): PageSpec => ({
  id: 300 + n,
  name: `jan ${n}${ordinal(n)}, 2025`,
  originalName: `Jan ${n}${ordinal(n)}, 2025`,
  file: true,
  journalDay: 20250100 + n
});

const CARA: PageSpec = { id: 21, name: 'cara', originalName: 'Cara' };

/** A journal page as the range query's `pull [*]` answers it, with one more key after the usual ones. */
const journalRow = (page: PageSpec) => [{ ...pulledPage(page), 'created-at': 1735689600000 + page.id }];

/** A journal page as the up-to query pulls it: only the attributes it asks for. */
const upToRow = (page: PageSpec) => [
  { id: page.id, uuid: uuid(page.id), name: page.name, 'original-name': page.originalName, 'journal-day': page.journalDay, 'journal?': true }
];

// ---- blocks

interface Ref {
  id?: number;
  name?: string;
  originalName?: string;
  journalDay?: number;
}

/** A ref as the blocks query pulls it: the page's own map. A ref to a block has no name. */
const ref = ({ id, name, originalName, journalDay }: Ref) => ({
  ...(id === undefined ? {} : { id }),
  ...(name === undefined ? {} : { name }),
  ...(originalName === undefined ? {} : { 'original-name': originalName }),
  ...(journalDay ? { 'journal?': true, 'journal-day': journalDay } : name === undefined ? {} : { 'journal?': false })
});

const ATLAS_REF = ref({ id: ATLAS.id, name: ATLAS.name, originalName: ATLAS.originalName });
const BOB_REF = ref({ id: BOB.id, name: BOB.name, originalName: BOB.originalName });
const CARA_REF = ref({ id: CARA.id, name: CARA.name, originalName: CARA.originalName });
/** The page LogSeq makes for a TODO marker, which is never a concept */
const TODO_REF = ref({ id: 11, name: 'todo' });

interface BlockSpec {
  id: number;
  page: number;
  /** Defaults to the page: a top-level block */
  parent?: number;
  /** Defaults to the parent: the first sibling */
  left?: number;
  content?: string;
  refs?: unknown[];
  /** More keys, written last */
  extra?: Record<string, unknown>;
}

/** A block as the blocks query pulls it: LogSeq's own kebab-case keys, `refs` as page maps. */
const block = ({ id, page, parent = page, left = parent, content = `Block ${id}`, refs, extra }: BlockSpec) => [
  {
    id,
    uuid: uuid(id),
    content,
    page: { id: page },
    parent: { id: parent },
    left: { id: left },
    format: 'markdown',
    'pre-block?': false,
    'path-refs': [{ id: page }],
    properties: {},
    ...(refs === undefined ? {} : { refs }),
    ...(extra ?? {})
  }
];

/** `count` top-level blocks of `page` with ids from `firstId`, in page order, each saying `content`. */
const topBlocks = (page: PageSpec, firstId: number, count: number, content = 'x') =>
  Array.from({ length: count }, (_, i) => block({ id: firstId + i, page: page.id, left: i === 0 ? page.id : firstId + i - 1, content }));

// ---- cases

interface Journey {
  /** The journal pages the first query finds */
  pages: unknown;
  /** The blocks the second query finds. Left out when no second query is made */
  blocks?: unknown;
  /** The answer to the alias group query of the search term, when one is made */
  alias?: unknown;
  /** The ref lookups a `resolve_refs` call makes, one per level */
  refs?: CannedCall[];
  perturbed?: unknown;
}

const bounds = (start: number, end: number) => [JSON.stringify(start), JSON.stringify(end)];

/** A case that asks for the days `start` to `end` and gets `journey`. */
function rangeCase(name: string, start: number, end: number, args: Record<string, unknown>, journey: Journey): ParityCase {
  const steps: CannedCall[][] = [[query(PAGES_IN_RANGE, bounds(start, end), journey.pages)]];
  if (journey.blocks !== undefined) steps.push([query(BLOCKS_IN_RANGE, bounds(start, end), journey.blocks)]);
  if (journey.alias !== undefined) steps.push([query(ALIAS_BY_NAME, [JSON.stringify(String(args.search_term).toLowerCase())], journey.alias)]);
  for (const level of journey.refs ?? []) steps.push([level]);
  return {
    name: `date range: ${name}`,
    tool: TOOL,
    arguments: { start_date: start, end_date: end, ...args },
    steps,
    ...(journey.perturbed === undefined ? {} : { perturbed: journey.perturbed })
  };
}

/** A case that asks for the `count` latest journals (today is 20250311) and gets `journey`. */
function lastNCase(name: string, count: number, args: Record<string, unknown>, pages: PageSpec[], blocks?: unknown, perturbed?: unknown): ParityCase {
  const found = pages.map(upToRow);
  const days = pages.map(page => page.journalDay!).sort((a, b) => b - a).slice(0, count);
  const steps: CannedCall[][] = [[query(PAGES_UP_TO, [JSON.stringify(20250311)], found)]];
  if (blocks !== undefined) steps.push([query(BLOCKS_IN_RANGE, bounds(days[days.length - 1], days[0]), blocks)]);
  return {
    name: `date range: ${name}`,
    tool: TOOL,
    arguments: { last_n: count, ...args },
    steps,
    ...(perturbed === undefined ? {} : { perturbed })
  };
}

/** A case with no LogSeq call: the arguments are refused first. */
const refused = (name: string, args: Record<string, unknown>): ParityCase => ({ name: `date range: ${name}`, tool: TOOL, arguments: args, steps: [] });

const [JAN1, JAN2, JAN3, JAN4, JAN5] = [1, 2, 3, 4, 5].map(january);

/** Three days: two with a small tree of blocks that reference pages, one with no block at all. */
const WEEK_PAGES = [journalRow(JAN2), journalRow(JAN3), journalRow(JAN1)];
const WEEK_BLOCKS = [
  block({ id: 1001, page: JAN1.id, content: 'Kickoff for [[Project Atlas]] with #urgent', refs: [ATLAS_REF, TODO_REF, ref({ id: JAN1.id, name: JAN1.name, originalName: JAN1.originalName, journalDay: JAN1.journalDay })] }),
  block({ id: 2001, page: JAN2.id, content: 'Standup with [[Bob]]', refs: [BOB_REF] }),
  block({ id: 1003, page: JAN1.id, left: 1001, content: 'TODO review the plan', refs: [TODO_REF, ATLAS_REF], extra: { marker: 'TODO' } }),
  block({ id: 1002, page: JAN1.id, parent: 1001, content: 'Owner is [[Bob]] for [[Project Atlas]]', refs: [BOB_REF, ATLAS_REF, ref({ id: 99 })], extra: { properties: { owner: 'bob' }, 'created-at': 1735689601000 } }),
  block({ id: 2002, page: JAN2.id, parent: 2001, content: 'Ask [[Bob]] and [[Cara]] about it', refs: [BOB_REF, CARA_REF, { id: 77 }] }),
  block({ id: 2003, page: JAN2.id, parent: 2002, content: 'deep note', refs: [] })
];

const cases: ParityCase[] = [
  // ---- explicit dates
  rangeCase('slim by default: days oldest first, trees by the left chain, the top concepts of the period', 20250101, 20250103, {}, {
    pages: WEEK_PAGES,
    blocks: [...WEEK_BLOCKS, [null]],
    alias: undefined
  }),
  rangeCase('full entities: the page as the Editor API spells it, each block with its level and children', 20250101, 20250103, { slim_results: false }, {
    pages: WEEK_PAGES,
    blocks: WEEK_BLOCKS
  }),
  rangeCase('top_concepts_limit 1 keeps the best, 0 leaves topConcepts out and the tip with it', 20250101, 20250103, { top_concepts_limit: 1 }, {
    pages: WEEK_PAGES,
    blocks: WEEK_BLOCKS
  }),
  rangeCase('top_concepts_limit 0', 20250101, 20250103, { top_concepts_limit: 0 }, { pages: WEEK_PAGES, blocks: WEEK_BLOCKS }),
  rangeCase('a range with no journal page makes one call', 20250101, 20250107, {}, { pages: [] }),
  rangeCase('a range of one day', 20250102, 20250102, {}, { pages: [journalRow(JAN2)], blocks: WEEK_BLOCKS.filter(b => b[0].page.id === JAN2.id) }),
  rangeCase('day 31 of a short month is a valid bound', 20250228, 20250231, {}, { pages: [] }),
  rangeCase('a journal page with no block is an entry with none', 20250103, 20250103, {}, { pages: [journalRow(JAN3)], blocks: [] }),
  rangeCase('a journal with a block with no refs array and a null cell in the answer', 20250104, 20250104, {}, {
    pages: [journalRow(JAN4)],
    blocks: [[null], block({ id: 4001, page: JAN4.id, content: 'No refs key here' })]
  }),

  // ---- the outline
  rangeCase('include_content false: counts and the first line of each top-level block', 20250101, 20250103, { include_content: false }, {
    pages: WEEK_PAGES,
    blocks: WEEK_BLOCKS
  }),
  rangeCase('the outline snippets: blank first line, a long line, an emoji cut by the 80 character limit, no content', 20250105, 20250105, { include_content: false }, {
    pages: [journalRow(JAN5)],
    blocks: [
      block({ id: 5001, page: JAN5.id, content: '\n\nsecond line only' }),
      block({ id: 5002, page: JAN5.id, left: 5001, content: `  ${'long '.repeat(30)}  ` }),
      block({ id: 5003, page: JAN5.id, left: 5002, content: `${'x'.repeat(76)}\u{1F680}${'y'.repeat(10)}` }),
      // a block with no :block/content has no such key
      block({ id: 5004, page: JAN5.id, left: 5003 }).map(({ content: _content, ...rest }) => rest)
    ],
    // every snippet is cut or blank, so a suffix on the text would not show
    perturbed: [block({ id: 5001, page: JAN5.id, content: 'perturbed' })]
  }),
  rangeCase('the outline ignores slim_results and resolve_refs', 20250102, 20250102, { include_content: false, slim_results: false, resolve_refs: true }, {
    pages: [journalRow(JAN2)],
    blocks: [block({ id: 2001, page: JAN2.id, content: `See ((${uuid(777)}))`, refs: [{ id: 777 }] })]
  }),

  // ---- search_term
  rangeCase('search_term that is no page keeps the blocks that say it and drops the days that have none', 20250101, 20250103, { search_term: 'STANDUP' }, {
    pages: WEEK_PAGES,
    blocks: WEEK_BLOCKS,
    alias: []
  }),
  rangeCase('search_term with no match leaves no day', 20250101, 20250103, { search_term: 'nothing says this' }, {
    pages: WEEK_PAGES,
    blocks: WEEK_BLOCKS,
    alias: []
  }),
  rangeCase('an empty search_term is no search and costs no alias query', 20250101, 20250103, { search_term: '' }, { pages: WEEK_PAGES, blocks: WEEK_BLOCKS }),
  rangeCase('search_term with no journal in range makes no alias query', 20250101, 20250103, { search_term: 'atlas' }, { pages: [] }),
  aliasCase(false),
  aliasCase(true),
  rangeCase('an alias group of more than 50 pages is cut and says so', 20250102, 20250102, { search_term: 'atlas' }, {
    pages: [journalRow(JAN2)],
    blocks: [block({ id: 2001, page: JAN2.id, content: 'an atlas of maps' })],
    alias: [
      ...Array.from({ length: 52 }, (_, i) => [
        { id: ATLAS.id, name: 'atlas', 'original-name': 'Atlas' },
        { id: 500 + i, name: `atlas alias ${String(i).padStart(2, '0')}`, 'original-name': `Atlas Alias ${String(i).padStart(2, '0')}` }
      ])
    ]
  }),
  rangeCase('a search_term that names a page with no alias is the same as any other text', 20250102, 20250102, { search_term: 'bob' }, {
    pages: [journalRow(JAN2)],
    blocks: WEEK_BLOCKS.filter(b => b[0].page.id === JAN2.id),
    alias: [[{ id: BOB.id, name: 'bob', 'original-name': 'Bob' }, { id: BOB.id, name: 'bob', 'original-name': 'Bob' }]],
    // a group of one is no group, whatever the names say; a real alias would be
    perturbed: [[{ id: BOB.id, name: 'bob', 'original-name': 'Bob' }, { id: 22, name: 'robert', 'original-name': 'Robert' }]]
  }),

  rangeCase('other names of the group are compared as the regular expression\'s case folding compares them', 20250102, 20250102, { search_term: 'orb' }, {
    pages: [journalRow(JAN2)],
    blocks: [
      // long s folds to s, so it is `sam`; the word may end at a stop
      block({ id: 2001, page: JAN2.id, content: 'call \u017fam now', refs: [] }),
      block({ id: 2002, page: JAN2.id, left: 2001, content: 'sam.', refs: [] }),
      // a letter after the name makes it part of a longer word
      block({ id: 2003, page: JAN2.id, left: 2002, content: '\u017famuel', refs: [] }),
      // sharp s is not simple-folded to ss, and a dotless i is not an i
      block({ id: 2004, page: JAN2.id, left: 2003, content: 'a stra\u00dfe', refs: [] }),
      block({ id: 2005, page: JAN2.id, left: 2004, content: '\u0131r\u0131s', refs: [] }),
      block({ id: 2006, page: JAN2.id, left: 2005, content: 'IRIS here', refs: [] }),
      block({ id: 2007, page: JAN2.id, left: 2006, content: 'x-sam-y', refs: [] }),
      block({ id: 2008, page: JAN2.id, left: 2007, content: '5sam', refs: [] })
    ],
    alias: ['orb', 'sam', 'strasse', 'iris'].map((name, i) => [
      { id: 30, name: 'orb', 'original-name': 'Orb' },
      { id: 30 + i, name, 'original-name': name.charAt(0).toUpperCase() + name.slice(1) }
    ])
  }),

  // ---- last_n
  lastNCase('last_n: the newest first, one query for the span between them', 2, {}, [JAN4, JAN1, JAN5, JAN2], [
    block({ id: 4001, page: JAN4.id, content: 'Planning #urgent', refs: [ref({ id: 12, name: 'urgent', originalName: 'urgent' })] }),
    block({ id: 5001, page: JAN5.id, content: 'Review [[Bob]]', refs: [BOB_REF] })
  ]),
  lastNCase('last_n with full entities: the page holds only the attributes the query pulls', 2, { slim_results: false }, [JAN4, JAN2, JAN1], [
    block({ id: 4001, page: JAN4.id, content: 'Planning' })
  ]),
  lastNCase('last_n with the outline', 3, { include_content: false }, [JAN1, JAN2, JAN3], WEEK_BLOCKS),
  lastNCase('last_n fewer pages than asked', 5, {}, [JAN2], [block({ id: 2001, page: JAN2.id, content: 'Only day' })]),
  lastNCase('last_n with no journal page', 7, {}, []),

  // ---- presets (today is Tuesday 2025-03-11 here; the UTC date is the 12th)
  presetCase('today', 20250311, 20250311),
  presetCase('yesterday', 20250310, 20250310),
  presetCase('this_week', 20250310, 20250316),
  presetCase('last_week', 20250303, 20250309),
  presetCase('this_month', 20250301, 20250331),
  presetCase('last_month', 20250201, 20250228),
  presetCase('this_year', 20250101, 20251231),
  presetCase('year_to_date', 20250101, 20250311),
  {
    name: 'date range: a preset with journals in it',
    tool: TOOL,
    arguments: { preset: 'this_year', search_term: 'plan' },
    steps: [
      [query(PAGES_IN_RANGE, bounds(20250101, 20251231), [journalRow(JAN1)])],
      [query(BLOCKS_IN_RANGE, bounds(20250101, 20251231), WEEK_BLOCKS.filter(b => b[0].page.id === JAN1.id))],
      [query(ALIAS_BY_NAME, [JSON.stringify('plan')], [])]
    ]
  },

  // ---- max_blocks
  rangeCase('max_blocks cuts between days and says where to read on', 20250101, 20250103, { max_blocks: 3 }, { pages: WEEK_PAGES, blocks: WEEK_BLOCKS }),
  rangeCase('max_blocks cuts inside a later day that fits, which repeats its kept blocks, and a block loses children', 20250101, 20250103, { max_blocks: 5 }, {
    pages: WEEK_PAGES,
    blocks: WEEK_BLOCKS
  }),
  rangeCase('max_blocks cuts inside the last day: a call from it reads the rest', 20250101, 20250102, { max_blocks: 5, slim_results: false }, {
    pages: [journalRow(JAN2), journalRow(JAN1)],
    blocks: WEEK_BLOCKS
  }),
  rangeCase('max_blocks cuts a block\'s children and says the block shows fewer than it has', 20250101, 20250101, { max_blocks: 1 }, {
    pages: [journalRow(JAN1)],
    blocks: WEEK_BLOCKS.filter(b => b[0].page.id === JAN1.id)
  }),
  rangeCase('max_blocks 0 keeps nothing and says to raise it', 20250101, 20250103, { max_blocks: 0 }, { pages: WEEK_PAGES, blocks: WEEK_BLOCKS }),
  rangeCase('max_blocks 0 over more than the maximum says to narrow the dates', 20250105, 20250105, { max_blocks: 0 }, {
    pages: [journalRow(JAN5)],
    blocks: topBlocks(JAN5, 6000, 1001),
    // nothing is kept, so only the count shows: fewer blocks than the maximum change the advice
    perturbed: topBlocks(JAN5, 6000, 5)
  }),
  rangeCase('a day that fits the maximum but not the cap is read whole at a higher cap', 20250105, 20250105, { max_blocks: 3, include_content: false }, {
    pages: [journalRow(JAN5)],
    blocks: topBlocks(JAN5, 6000, 8, 'row')
  }),
  rangeCase('a first day over the maximum cannot be read whole, and there is a later day to page to', 20250104, 20250105, { max_blocks: 2, include_content: false }, {
    pages: [journalRow(JAN4), journalRow(JAN5)],
    blocks: [...topBlocks(JAN4, 7000, 1001), ...topBlocks(JAN5, 9000, 2)]
  }),
  rangeCase('a last day over the maximum, under the maximum cap, says how to read a part of it', 20250104, 20250105, { max_blocks: 3, include_content: false }, {
    pages: [journalRow(JAN4), journalRow(JAN5)],
    blocks: [...topBlocks(JAN4, 7000, 1), ...topBlocks(JAN5, 9000, 1200)]
  }),
  rangeCase('max_blocks past the maximum is clamped and the cut at it has nothing more to fetch', 20250105, 20250105, { max_blocks: 5000, include_content: false }, {
    pages: [journalRow(JAN5)],
    blocks: topBlocks(JAN5, 6000, 1200)
  }),
  rangeCase('max_blocks at the maximum with a day after it: the way on is that day', 20250104, 20250105, { max_blocks: 1000, include_content: false }, {
    pages: [journalRow(JAN4), journalRow(JAN5)],
    blocks: [...topBlocks(JAN4, 7000, 1100), ...topBlocks(JAN5, 9000, 3)]
  }),
  rangeCase('the outline counts top-level blocks against max_blocks, and blockCount counts the nested ones', 20250101, 20250103, { include_content: false, max_blocks: 3 }, {
    pages: WEEK_PAGES,
    blocks: WEEK_BLOCKS
  }),
  lastNCase('last_n cut: the way on is older days', 3, { max_blocks: 3 }, [JAN1, JAN2, JAN3], WEEK_BLOCKS),

  // ---- resolve_refs
  rangeCase('resolve_refs with no ref in a block makes no extra call and still says hasMore and warnings', 20250101, 20250101, { resolve_refs: true }, {
    pages: [journalRow(JAN1)],
    blocks: WEEK_BLOCKS.filter(b => b[0].page.id === JAN1.id)
  }),
  rangeCase('resolve_refs adds resolvedContent and resolvedRefs to the blocks, slim and nested', 20250102, 20250102, { resolve_refs: true }, {
    pages: [journalRow(JAN2)],
    blocks: [
      block({ id: 2001, page: JAN2.id, content: `Follow up on ((${uuid(701)}))`, refs: [{ id: 701 }] }),
      block({ id: 2002, page: JAN2.id, parent: 2001, content: 'plain child', refs: [] })
    ],
    refs: [refQuery({ blocks: [uuid(701)] }, [target(701, 'The plan is final', { page: ATLAS.id })])]
  }),
  rangeCase('resolve_refs with full entities and a cut says both', 20250101, 20250102, { resolve_refs: true, slim_results: false, max_blocks: 1 }, {
    pages: [journalRow(JAN1), journalRow(JAN2)],
    blocks: [
      block({ id: 1001, page: JAN1.id, content: `Decision ((${uuid(701)}))`, refs: [{ id: 701 }] }),
      block({ id: 2001, page: JAN2.id, content: `Cut ((${uuid(702)}))`, refs: [{ id: 702 }] })
    ],
    refs: [refQuery({ blocks: [uuid(701)] }, [target(701, 'Kept ref target', { page: ATLAS.id })])]
  }),

  // ---- LogSeq answers null (BR-0011)
  rangeCase('a null answer to the journal query is not an empty range', 20250101, 20250103, {}, { pages: null }),
  rangeCase('a null answer to the blocks query is not a range of empty days', 20250101, 20250103, {}, { pages: WEEK_PAGES, blocks: null }),
  {
    name: 'date range: a null answer to the up-to query is not a graph with no journals',
    tool: TOOL,
    arguments: { last_n: 2 },
    steps: [[query(PAGES_UP_TO, [JSON.stringify(20250311)], null)]]
  },

  // ---- arguments that are refused before any call
  refused('no selection', {}),
  refused('two selections', { last_n: 3, preset: 'today' }),
  refused('all three selections', { start_date: 20250101, end_date: 20250102, last_n: 3, preset: 'today' }),
  refused('a date with no partner', { start_date: 20250101 }),
  refused('an end date with no start', { end_date: 20250101 }),
  refused('a start date that is no YYYYMMDD', { start_date: 2025011, end_date: 20250102 }),
  refused('a fractional start date', { start_date: 20250101.5, end_date: 20250102 }),
  refused('an end date with a month 13', { start_date: 20250101, end_date: 20251301 }),
  refused('a year out of range', { start_date: 18991231, end_date: 20250102 }),
  refused('a range that runs backwards', { start_date: 20250107, end_date: 20250101 }),
  refused('a start date that is text', { start_date: '20250101', end_date: 20250102 }),
  refused('last_n below 1', { last_n: 0 }),
  refused('last_n that is a fraction', { last_n: 2.5 }),
  refused('a preset that does not exist', { preset: 'next_week' }),
  refused('a negative top_concepts_limit', { last_n: 1, top_concepts_limit: -1 }),
  refused('max_blocks that is text', { last_n: 1, max_blocks: '10' }),
  refused('include_content that is not a boolean', { last_n: 1, include_content: 'no' }),
  refused('the first bad argument in schema order is the one named', { last_n: 0, preset: 'bogus', slim_results: 'x' })
];

function presetCase(preset: string, start: number, end: number): ParityCase {
  return {
    name: `date range: preset ${preset}`,
    tool: TOOL,
    arguments: { preset },
    steps: [[query(PAGES_IN_RANGE, bounds(start, end), [])]]
  };
}

/**
 * A search_term that names a page with aliases: "atlas" with the pages "Project Atlas" and "PA". A
 * block matches by the term inside a word, another name of the group as a whole word, or a reference
 * to a page of the group, whatever it says.
 */
function aliasCase(outline: boolean): ParityCase {
  const group = [
    [{ id: 10, name: 'atlas', 'original-name': 'Atlas' }, { id: 10, name: 'atlas', 'original-name': 'Atlas' }],
    [{ id: 10, name: 'atlas', 'original-name': 'Atlas' }, { id: 12, name: 'project atlas', 'original-name': 'Project Atlas' }],
    [{ id: 10, name: 'atlas', 'original-name': 'Atlas' }, { id: 13, name: 'pa', 'original-name': 'PA' }]
  ];
  const day = JAN2;
  return rangeCase(
    `search_term that names a page with aliases${outline ? ' (the outline)' : ''}: other names as whole words and references to the group`,
    20250102,
    20250103,
    { search_term: 'Atlas', ...(outline ? { include_content: false } : {}) },
    {
      pages: [journalRow(JAN3), journalRow(day)],
      blocks: [
        block({ id: 2001, page: day.id, content: 'worked on Project Atlas today', refs: [] }),
        block({ id: 2002, page: day.id, left: 2001, content: 'pa sync at noon', refs: [] }),
        block({ id: 2003, page: day.id, left: 2002, content: 'she paused the call and said no', refs: [] }),
        block({ id: 2004, page: day.id, left: 2003, content: 'unrelated words', refs: [ref({ id: 13, name: 'pa', originalName: 'PA' })] }),
        block({ id: 2005, page: day.id, left: 2004, content: 'an ATLAS of maps', refs: [] }),
        block({ id: 2006, page: day.id, left: 2005, content: 'nothing relevant (PA)', refs: [] }),
        block({ id: 3001, page: JAN3.id, content: 'no match on this day', refs: [CARA_REF] })
      ],
      alias: group
    }
  );
}

export const queryByDateRangeCases = cases;
