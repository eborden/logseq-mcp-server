// Parity cases for logseq_get_concept_evolution (#313, #61, #69, #249, ADR-0025). Every page, block and
// name here is made up (BR-0001). Each case lists the LogSeq calls the TypeScript server makes, in
// order, with the answer the stub gives; the result the server printed for it is in
// ../expected/get-concept-evolution.json.
//
// The tool reads no clock: the weeks and months come from the YYYYMMDD number alone, and the harness
// runs both servers in America/New_York, where the days around 2025-03-09 and 2025-11-02 are the ones
// a local-time computation would put in the wrong week (#249). The week cases hold those days.
import type { ParityCase } from '../harness.js';
import {
  ALICE,
  ALICE_NOTES,
  ATLAS,
  ATLAS_RETRO,
  ATLAS_STUB,
  ATLAS_WITH_ALIAS,
  BOB,
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
  uuid,
  type Page
} from '../context-fixtures.js';

const TOOL = 'logseq_get_concept_evolution';
const TREE = 'logseq.Editor.getPageBlocksTree';
const GET_PAGE = 'logseq.Editor.getPage';

// ---- the mentions queries, as they go over the wire (the TypeScript text with its whitespace collapsed)

const PULL = '(pull ?block [:db/id :block/uuid :block/content :block/marker :block/properties :block/format {:block/page [*]}])';
const MENTIONS = `[:find ${PULL} :in $ ?page-name :where [?page :block/name ?page-name] [?block :block/refs ?page]]`;
const groupMentions = (refs: number[], own: number[]) =>
  `[:find ${PULL} :where (or-join [?block] (and [(ground [${refs.join(' ')}]) [?ref ...]] [?block :block/refs ?ref]) ` +
  `(and [(ground [${own.join(' ')}]) [?own ...]] [?block :block/page ?own]))]`;

// ---- pages and blocks

/** A journal page, made up from its day. */
const journal = (day: number, id: number): Page => {
  const label = `day ${day}`;
  return { id, name: label, originalName: `Day ${day}`, journalDay: day };
};

const MARCH_TENTH = journal(20250310, 31);

/** A page as the Editor API's `getPage` sends it: camelCase keys. */
const editorPage = ({ id, name, originalName, journalDay }: Page) => ({
  id,
  uuid: uuid(id),
  name,
  originalName,
  ...(journalDay ? { 'journal?': true, journalDay } : { 'journal?': false }),
  createdAt: 1735689600000 + id
});

/** A block of the page's own tree, as the Editor API sends it: a bare `{ id }` for page, parent and left. */
const treeBlock = (id: number, content: string, extra: Record<string, unknown> = {}, page: Page = ATLAS) => ({
  id,
  uuid: uuid(id),
  content,
  format: 'markdown',
  page: { id: page.id },
  parent: { id: page.id },
  left: { id: page.id },
  ...extra
});

/** A block that mentions the page, as the Datalog pull gives it: kebab-case keys, its page whole. */
const mention = (id: number, page: Page, extra: Record<string, unknown> = {}, content = `Mentions [[Project Atlas]] (${id})`) => [
  { id, uuid: uuid(id), content, format: 'markdown', page: pulled(page), ...extra }
];

// ---- the calls

const typed = (input: string) => input.trim();

/** The resolver, the tree, the page and the mentions of an exact name, for a page with no alias links. */
const exact = (page: Page, input: string, tree: unknown, concept: unknown, mentions: unknown): ParityCase['steps'] => [
  [query(RESOLVE_BY_NAME, [JSON.stringify(typed(input).toLowerCase())], [[pulled(page), 'name']])],
  [editor(TREE, [typed(input)], tree)],
  [editor(GET_PAGE, [typed(input)], concept)],
  [query(MENTIONS, [JSON.stringify(typed(input).toLowerCase())], mentions)]
];

const call = (name: string, args: Record<string, unknown>, steps: ParityCase['steps']): ParityCase => ({
  name: `evolution: ${name}`,
  tool: TOOL,
  arguments: { concept_name: 'Project Atlas', ...args },
  steps
});

/** Mentions on journals, handed over out of date order, plus the page's own undated blocks. */
const SCATTERED = [
  mention(501, NEW_YEAR),
  mention(502, MARCH_TENTH),
  mention(503, NEW_YEAR, { marker: 'DONE', properties: { status: 'done', '2': 'two', '1': 'one' } }),
  mention(504, BOB)
];
const OWN_TREE = [
  treeBlock(101, 'Kickoff with [[Alice]]', { children: [treeBlock(102, 'A child block', { parent: { id: 101 }, left: { id: 101 } })] }),
  treeBlock(103, 'Second top block', { left: { id: 101 } })
];

// ---- days around the changes of daylight-saving time, and the turn of two years, handed over out of order
const DST_DAYS = [20250309, 20250101, 20241231, 20250310, 20251102, 20250308, 20251101, 20250406, 20250311, 20251231];
const DST_MENTIONS = DST_DAYS.map((day, i) => mention(600 + i, journal(day, 900 + i)));

/** `n` mentions on `n` consecutive made-up days, each on a page with only the keys the tool reads. */
const manyMentions = (n: number, base: number, start = 20240101) =>
  Array.from({ length: n }, (_, i) => [
    {
      id: base + i,
      uuid: uuid(base + i),
      content: `Mention ${i + 1}`,
      page: { id: 70000 + i, name: `day ${start + i}`, 'journal-day': start + i }
    }
  ]);

/** The alias group Project Atlas (10) and Atlas (11), asked for by the declaring page's name. */
const aliasWalk = (tree: unknown, concept: unknown, mentions: unknown, input = 'Project Atlas'): ParityCase['steps'] => [
  [query(RESOLVE_BY_NAME, [JSON.stringify(typed(input).toLowerCase())], [[pulled(ATLAS_WITH_ALIAS), 'name']])],
  [query(aliasSetsQuery([10]), [], [member(10, ATLAS), member(10, ATLAS_STUB)])],
  [editor(TREE, [typed(input)], tree)],
  [editor(GET_PAGE, [typed(input)], concept)],
  [query(groupMentions([10, 11], [11]), [], mentions)]
];

export const getConceptEvolutionCases: ParityCase[] = [
  call('exact name, the page and its mentions, undated last', {}, exact(ATLAS, 'Project Atlas', OWN_TREE, editorPage(ATLAS), SCATTERED)),
  call('group by day', { group_by: 'day' }, exact(ATLAS, 'Project Atlas', OWN_TREE, editorPage(ATLAS), SCATTERED)),
  call('group by week, in the order the mentions came', { group_by: 'week' }, exact(ATLAS, 'Project Atlas', [], editorPage(ATLAS), DST_MENTIONS)),
  call('group by month', { group_by: 'month' }, exact(ATLAS, 'Project Atlas', OWN_TREE, editorPage(ATLAS), [...SCATTERED, ...DST_MENTIONS])),
  call('group by day, in the order the mentions came', { group_by: 'day' }, exact(ATLAS, 'Project Atlas', [], editorPage(ATLAS), DST_MENTIONS)),
  call(
    // Only the days inside the bounds, both ends included; the page's own undated blocks and a mention on a page with no day stay
    'start and end date',
    { start_date: 20250101, end_date: 20250309 },
    exact(ATLAS, 'Project Atlas', OWN_TREE, editorPage(ATLAS), [...DST_MENTIONS, ...SCATTERED])
  ),
  call('start date alone', { start_date: 20250310 }, exact(ATLAS, 'Project Atlas', OWN_TREE, editorPage(ATLAS), DST_MENTIONS)),
  call('end date alone', { end_date: 20250101 }, exact(ATLAS, 'Project Atlas', OWN_TREE, editorPage(ATLAS), DST_MENTIONS)),
  call('a bound of 0 is no bound', { start_date: 0, end_date: 0 }, exact(ATLAS, 'Project Atlas', [], editorPage(ATLAS), DST_MENTIONS)),
  call(
    // The tree's block that links its own page comes back from the query too: one block, in the tree's place, as the pull gave it
    'a block in the tree and in the mentions is one block, as the query pulled it',
    {},
    exact(ATLAS, 'Project Atlas', [treeBlock(101, 'Mentions [[Project Atlas]] on its own page'), treeBlock(102, 'Plain', { left: { id: 101 } })], editorPage(ATLAS), [
      mention(101, ATLAS, { 'path-refs': [{ id: 10 }] }, 'Mentions [[Project Atlas]] on its own page'),
      mention(501, NEW_YEAR)
    ])
  ),
  call(
    // The concept is a journal: the page names a day, and the tree's blocks get it
    'a journal by its ISO date: its own blocks are dated',
    { concept_name: '2025-01-01', group_by: 'day' },
    [
      [query(RESOLVE_WITH_DAY, ['"2025-01-01"', '20250101'], [[pulled(NEW_YEAR), 'journal-date']])],
      [editor(TREE, ['jan 1st, 2025'], [treeBlock(301, 'Planned the day', {}, NEW_YEAR)])],
      [editor(GET_PAGE, ['jan 1st, 2025'], editorPage(NEW_YEAR))],
      [query(MENTIONS, ['"jan 1st, 2025"'], [mention(401, ALICE, {}, 'Alice mentions [[Jan 1st, 2025]]'), mention(402, MARCH_TENTH)])]
    ]
  ),
  call(
    'a namespace leaf',
    { concept_name: 'retro' },
    [
      [query(RESOLVE_BY_NAME, ['"retro"'], [])],
      [query(NAMESPACE_LEAF, ['"/retro"'], [[pulled(ATLAS_RETRO)]])],
      [editor(TREE, ['project atlas/retro'], [treeBlock(601, 'What went well', {}, ATLAS_RETRO)])],
      [editor(GET_PAGE, ['project atlas/retro'], editorPage(ATLAS_RETRO))],
      [query(MENTIONS, ['"project atlas/retro"'], [])]
    ]
  ),
  call(
    // An alias name resolves to the declaring page, whose own name is what the Editor calls get
    'asked by an alias name',
    { concept_name: 'Atlas' },
    [
      [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulled(ATLAS_STUB), 'name'], [pulled(ATLAS_WITH_ALIAS), 'alias']])],
      [query(aliasSetsQuery([10]), [], [member(10, ATLAS), member(10, ATLAS_STUB)])],
      [editor(TREE, ['project atlas'], OWN_TREE)],
      [editor(GET_PAGE, ['project atlas'], editorPage(ATLAS))],
      [query(groupMentions([10, 11], [11]), [], SCATTERED)]
    ]
  ),
  call(
    // One query covers every name of the group: the references to any of them and the blocks of the other pages
    'a page with aliases covers the whole group',
    { group_by: 'month' },
    aliasWalk(OWN_TREE, editorPage(ATLAS), [...SCATTERED, mention(1101, ATLAS_STUB, {}, 'On the stub page itself')])
  ),
  call(
    // A page that has an alias link but whose group is the page alone: the one-name query, no aliases reported
    'an alias link whose group is the page alone',
    {},
    [
      [query(RESOLVE_BY_NAME, ['"project atlas"'], [[pulled(ATLAS_WITH_ALIAS), 'name']])],
      [query(aliasSetsQuery([10]), [], [member(10, ATLAS)])],
      [editor(TREE, ['Project Atlas'], OWN_TREE)],
      [editor(GET_PAGE, ['Project Atlas'], editorPage(ATLAS))],
      [query(MENTIONS, ['"project atlas"'], SCATTERED)]
    ]
  ),
  call(
    // The group is cut at 50: the page and 49 aliases, and the cut is said
    'an alias group past the cap',
    {},
    [
      [query(RESOLVE_BY_NAME, ['"project atlas"'], [[pulled({ ...ATLAS, alias: [100] }), 'name']])],
      [
        query(aliasSetsQuery([10]), [], [
          member(10, ATLAS),
          ...Array.from({ length: 60 }, (_, i) =>
            member(10, { id: 100 + i, name: `member ${String(59 - i).padStart(2, '0')}`, originalName: `Member ${String(59 - i).padStart(2, '0')}` })
          )
        ])
      ],
      [editor(TREE, ['Project Atlas'], [])],
      [editor(GET_PAGE, ['Project Atlas'], editorPage(ATLAS))],
      // `member 00` has id 159, `member 01` 158 and so on: the first 49 by name are 159 down to 111
      [query(groupMentions([10, ...Array.from({ length: 49 }, (_, k) => 159 - k)], Array.from({ length: 49 }, (_, k) => 159 - k)), [], SCATTERED.slice(0, 1))]
    ]
  ),
  call('name with spaces and capitals', { concept_name: '  Project ATLAS ' }, exact(ATLAS, '  Project ATLAS ', OWN_TREE, editorPage(ATLAS), SCATTERED.slice(0, 2))),
  {
    // `name`, `page` and `page_name` stand in for `concept_name` (BR-0008)
    name: 'evolution: parameter alias',
    tool: TOOL,
    arguments: { page_name: 'Project Atlas' },
    steps: exact(ATLAS, 'Project Atlas', OWN_TREE, editorPage(ATLAS), [])
  },

  // ---- the cap on mentions
  call(
    // Oldest first, then the undated: the cap keeps the first three, ends on a dated one and says where to go on
    'max_entries below what there is, cut on a dated mention',
    { max_entries: 3 },
    exact(ATLAS, 'Project Atlas', OWN_TREE, editorPage(ATLAS), SCATTERED)
  ),
  call(
    'a cut that leaves only undated mentions out',
    { max_entries: 4, group_by: 'day' },
    exact(ATLAS, 'Project Atlas', OWN_TREE, editorPage(ATLAS), SCATTERED)
  ),
  {
    ...call('max_entries 0 keeps none and says what there was', { max_entries: 0, group_by: 'week' }, exact(ATLAS, 'Project Atlas', OWN_TREE, editorPage(ATLAS), SCATTERED)),
    // nothing of the mentions is shown but their counts, which no string in them changes
    perturbed: [[{ id: 1 }]]
  },
  call(
    // More than the default of 100: the cut is below the maximum, so a larger max_entries gets the rest
    'more mentions than the default cap',
    {},
    exact(ATLAS, 'Project Atlas', [], editorPage(ATLAS), manyMentions(120, 1000))
  ),
  call(
    // More than 200 with the cap just below them: the suggestion is a large result
    'a cut whose suggested raise is a large result',
    { max_entries: 201 },
    exact(ATLAS, 'Project Atlas', [], editorPage(ATLAS), manyMentions(210, 1000))
  ),
  call(
    // Past the maximum of 500: no way to fetch the rest, whatever is asked for
    'max_entries past the maximum of 500',
    { max_entries: 700 },
    exact(ATLAS, 'Project Atlas', [], editorPage(ATLAS), manyMentions(510, 1000, 20230101))
  ),
  call(
    'the summary counts what the cap cut',
    { max_entries: 1, start_date: 20250101 },
    exact(ATLAS, 'Project Atlas', OWN_TREE, editorPage(ATLAS), SCATTERED)
  ),

  // ---- what LogSeq does not answer
  call('nothing links the page and it has no blocks', {}, exact(ATLAS, 'Project Atlas', [], editorPage(ATLAS), [])),
  call(
    // PARITY: a null block tree is read as no blocks (suspected TS bug, BR-0011)
    'the block tree answers null',
    {},
    exact(ATLAS, 'Project Atlas', null, editorPage(ATLAS), SCATTERED)
  ),
  call(
    // The page is unknown to the Editor API: the tree's blocks keep their bare page, so they have no day
    'the page answers null',
    {},
    exact(ATLAS, 'Project Atlas', OWN_TREE, null, SCATTERED.slice(0, 1))
  ),
  call(
    // PARITY: a null answer for the mentions is read as no mentions (suspected TS bug, BR-0011)
    'the mentions answer null',
    {},
    exact(ATLAS, 'Project Atlas', OWN_TREE, editorPage(ATLAS), null)
  ),
  call('everything answers null', {}, exact(ATLAS, 'Project Atlas', null, null, null)),
  call(
    'the aliased mentions answer null',
    {},
    aliasWalk(OWN_TREE, editorPage(ATLAS), null)
  ),

  // ---- a name that is not one page
  {
    name: 'evolution: no such page',
    tool: TOOL,
    arguments: { concept_name: 'Projct Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"projct atlas"'], [])],
      [query(NAMESPACE_LEAF, ['"/projct atlas"'], [])],
      [editor(GET_ALL_PAGES, [], [{ originalName: 'Project Atlas' }, { originalName: 'Alice' }, { originalName: 'Bob' }])]
    ]
  },
  {
    name: 'evolution: a name two pages declare is ambiguous',
    tool: TOOL,
    arguments: { concept_name: 'al' },
    steps: [[query(RESOLVE_BY_NAME, ['"al"'], [[pulled(ALICE_NOTES), 'alias'], [pulled(ALICE), 'alias']])]]
  },

  // ---- what propagates
  call(
    'LogSeq error from the block tree',
    {},
    [[query(RESOLVE_BY_NAME, ['"project atlas"'], [[pulled(ATLAS), 'name']])], [editor(TREE, ['Project Atlas'], { error: 'Query timed out' })]]
  ),
  call(
    'LogSeq error from the page',
    {},
    [
      [query(RESOLVE_BY_NAME, ['"project atlas"'], [[pulled(ATLAS), 'name']])],
      [editor(TREE, ['Project Atlas'], [])],
      [editor(GET_PAGE, ['Project Atlas'], { error: 'Query timed out' })]
    ]
  ),
  call('LogSeq error from the mentions', {}, exact(ATLAS, 'Project Atlas', [], editorPage(ATLAS), { error: 'Query timed out' })),
  {
    ...call('a tree block in a shape the server cannot read', {}, exact(ATLAS, 'Project Atlas', [{ id: 1, content: 'no uuid' }], editorPage(ATLAS), []).slice(0, 2)),
    // a whole answer instead: the server would go on to ask for the page
    perturbed: []
  },
  call('a tree that is not a list', {}, exact(ATLAS, 'Project Atlas', { id: 1 }, editorPage(ATLAS), []).slice(0, 2)),
  {
    ...call('a page in a shape the server cannot read', {}, exact(ATLAS, 'Project Atlas', [], { id: 10, originalName: 'Project Atlas' }, []).slice(0, 3)),
    perturbed: editorPage(ATLAS)
  },
  call('a null cell among the mentions', {}, exact(ATLAS, 'Project Atlas', [], editorPage(ATLAS), [[null]])),
  call('a mention in a shape the server cannot read', {}, exact(ATLAS, 'Project Atlas', [], editorPage(ATLAS), [[{ id: 1, uuid: 7 }]])),
  call('a mention row with no block', {}, exact(ATLAS, 'Project Atlas', [], editorPage(ATLAS), [[]])),
  call('a mention row that is not a row', {}, exact(ATLAS, 'Project Atlas', [], editorPage(ATLAS), [3])),

  // ---- arguments, checked before any call
  { name: 'evolution: no concept', tool: TOOL, arguments: { group_by: 'day' }, steps: [] },
  { name: 'evolution: a concept that is not text', tool: TOOL, arguments: { concept_name: 5 }, steps: [] },
  { name: 'evolution: a grouping that is not one', tool: TOOL, arguments: { concept_name: 'Project Atlas', group_by: 'year' }, steps: [] },
  { name: 'evolution: a negative max_entries', tool: TOOL, arguments: { concept_name: 'Project Atlas', max_entries: -1 }, steps: [] },
  { name: 'evolution: a fraction for max_entries', tool: TOOL, arguments: { concept_name: 'Project Atlas', max_entries: 2.5 }, steps: [] },
  { name: 'evolution: a date that is text', tool: TOOL, arguments: { concept_name: 'Project Atlas', start_date: '20250101' }, steps: [] },
  { name: 'evolution: an end date that is text', tool: TOOL, arguments: { concept_name: 'Project Atlas', end_date: 'soon' }, steps: [] }
];
