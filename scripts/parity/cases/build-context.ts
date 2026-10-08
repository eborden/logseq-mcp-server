// Parity cases for logseq_build_context (#312, #43, ADR-0025): JSON, `compact` and `format:
// "markdown"`. Every page, block and name here is made up (BR-0001). Each case lists the LogSeq
// calls the TypeScript server makes, in order, with the answer the stub gives; the result the
// server printed for it is in ../expected/build-context.json.
//
// The Markdown cases re-run the JSON cases of the same shape with `format: "markdown"` added, so a
// route, a cap and an error are held to the same text in both, and the LogSeq calls are the same.
import type { ParityCase } from '../harness.js';
import {
  ALICE,
  ALICE_NOTES,
  ATLAS,
  ATLAS_RETRO,
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
  pulled,
  pulledLinkingBlock,
  query,
  refQuery,
  sourcePage,
  target,
  uuid
} from '../context-fixtures.js';

const TOOL = 'logseq_build_context';

/** The page's properties as the pull sends them: an integer-like key is written first, as JavaScript has it. */
const PROJECT: typeof ATLAS = { ...ATLAS, properties: { type: 'project', tags: ['alpha', 'beta'], '2': 'two', '1': 'one' } };

// Rows come in query order, not page order: the `:block/left` chain gives the order back
const BLOCKS = [
  flatBlock(103, 'Second top block, with a ((ref)) left as written', { left: 101 }),
  flatBlock(102, 'Alice owns the schema\nand a second line', { parent: 101, left: 101 }),
  flatBlock(101, 'Kickoff with [[Alice]] and [[Bob]]', { extra: { properties: { status: 'doing', '2': 'two', '1': 'one' } } })
];

const REFERENCES = [
  [sourcePage(BOB), [linkingBlock(201, BOB.id), linkingBlock(202, BOB.id, 'Bob again links [[Project Atlas]]\nover two lines')]],
  [sourcePage(ALICE), [linkingBlock(401, ALICE.id, 'Alice tags #[[Project Atlas]]', { properties: { status: 'done' } })]],
  [sourcePage(NEW_YEAR), [linkingBlock(301, NEW_YEAR.id, 'Journal mentions [[Project Atlas]]', { 'journal?': true, journalDay: 20250101 })]]
];

/** n top-level blocks on the page, one after the other. */
const chain = (n: number, base = 1000) =>
  Array.from({ length: n }, (_, i) => flatBlock(base + i, `Entry ${i + 1}`, { left: i === 0 ? ATLAS.id : base + i - 1 }));

const exact = (page: typeof ATLAS, input: string, blocks: unknown[], references: unknown) => exactSteps(RESOLVE_BY_NAME, page, input, blocks, references);

/** The alias group Project Atlas (10) and Atlas (11), asked for by the stub's name. */
const aliasGroupSteps = (blocks: unknown[], references: unknown[]) => [
  [query(RESOLVE_BY_NAME, ['"atlas"'], [[pulled(ATLAS_STUB), 'name'], [pulled(ATLAS_WITH_ALIAS), 'alias']])],
  [query(aliasSetsQuery([10]), [], [member(10, ATLAS), member(10, ATLAS_STUB)])],
  [query(blocksOnPages([10, 11]), [], blocks)],
  [query(linkedReferencesQuery([10, 11]), [], references)]
];

// The group's blocks: the stub's come first in the answer, the page asked about is shown first
const GROUP_BLOCKS = [
  flatBlock(1101, 'On the stub', { page: 11 }),
  flatBlock(101, 'On the page asked about', { page: 10 }),
  flatBlock(1102, 'Second on the stub', { page: 11, left: 1101 }),
  flatBlock(102, 'Second on the page asked about', { page: 10, left: 101 })
];

const GROUP_REFERENCES = [pulledLinkingBlock(405, ALICE), pulledLinkingBlock(201, BOB), pulledLinkingBlock(301, NEW_YEAR), pulledLinkingBlock(401, ALICE)];

/** A block with a ref in the page and one in a linking block, and what the refs point at. */
const REF_BLOCKS = [flatBlock(101, `See ((${uuid(2)})) for the plan`), flatBlock(102, 'Plain', { left: 101 })];
const REF_REFERENCES = [[sourcePage(BOB), [linkingBlock(201, BOB.id, `Cites ((${uuid(3)})) in passing`)]]];
const REF_STEPS = (blocks = REF_BLOCKS, references: unknown = REF_REFERENCES): ParityCase['steps'] => [
  ...exact(ATLAS, 'Project Atlas', blocks, references),
  [refQuery({ blocks: [uuid(2), uuid(3)] }, [target(2, `plan from ((${uuid(4)}))\nover two lines`), target(3, 'the cited text')])],
  [refQuery({ blocks: [uuid(4)] }, [target(4, 'the end of the chain')])]
];

/** The JSON cases that are run again as Markdown. */
const SHAPES: ParityCase[] = [
  {
    name: 'build_context: exact name, blocks in page order, linking pages and blocks as sent',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas' },
    steps: exact(PROJECT, 'Project Atlas', BLOCKS, REFERENCES)
  },
  {
    // The tuple's page can be null: the block's own page names the source, and a block with none is skipped
    name: 'build_context: a linking tuple with no page',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas' },
    steps: exact(ATLAS, 'Project Atlas', [flatBlock(101, 'Only block')], [
      [null, [{ ...linkingBlock(501, 50), page: { id: 50, name: 'zed', originalName: 'Zed' } }, linkingBlock(502, 51, 'No page name'), { id: 503, uuid: uuid(503), content: 'No page at all' }]],
      [sourcePage(BOB), [linkingBlock(201, BOB.id)]]
    ])
  },
  {
    name: 'build_context: a page with no blocks and no links',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas' },
    steps: exact(ATLAS, 'Project Atlas', [], [])
  },
  {
    name: 'build_context: caps below what there is',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas', max_blocks: 2, max_references: 3, max_related_pages: 1 },
    steps: exact(PROJECT, 'Project Atlas', [...BLOCKS, flatBlock(104, 'Fourth block', { left: 103 })], [
      ...REFERENCES,
      [sourcePage(CAROL), [linkingBlock(211, CAROL.id), linkingBlock(212, CAROL.id)]]
    ])
  },
  {
    // The journal is found by its ISO date: resolvedFrom, temporalContext with the day, and its own name handed on
    name: 'build_context: ISO date of a journal',
    tool: TOOL,
    arguments: { topic_name: '2025-01-01' },
    steps: [
      [query(RESOLVE_WITH_DAY, ['"2025-01-01"', '20250101'], [[pulled(NEW_YEAR), 'journal-date']])],
      [query(PAGE_BLOCKS, ['"jan 1st, 2025"'], [flatBlock(301, 'Planned the day', { page: 30 })])],
      [editor(LINKED_REFERENCES, ['jan 1st, 2025'], [[sourcePage(ALICE), [linkingBlock(401, ALICE.id, 'Alice mentions [[Jan 1st, 2025]]')]]])]
    ]
  },
  {
    name: 'build_context: namespace leaf',
    tool: TOOL,
    arguments: { topic_name: 'retro' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"retro"'], [])],
      [query(NAMESPACE_LEAF, ['"/retro"'], [[pulled(ATLAS_RETRO)]])],
      [query(PAGE_BLOCKS, ['"project atlas/retro"'], [flatBlock(601, 'What went well', { page: 60 })])],
      [editor(LINKED_REFERENCES, ['project atlas/retro'], [])]
    ]
  },
  {
    // The group is read from one query each: its blocks (the page asked about first) and the linking blocks
    name: 'build_context: a page with aliases covers the whole group',
    tool: TOOL,
    arguments: { topic_name: 'Atlas' },
    steps: aliasGroupSteps(GROUP_BLOCKS, GROUP_REFERENCES)
  },
  {
    // The resolver found a page and says so; its blocks are the stub's and the page's
    name: 'build_context: no blocks and no links anywhere in the alias group',
    tool: TOOL,
    arguments: { topic_name: 'Atlas' },
    steps: aliasGroupSteps([], [])
  },
  {
    // A page that has an alias link but whose group is the page alone: the Editor call, no aliases reported
    name: 'build_context: an alias link whose group is the page alone',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"project atlas"'], [[pulled(ATLAS_WITH_ALIAS), 'name']])],
      [query(aliasSetsQuery([10]), [], [member(10, ATLAS)])],
      [query(PAGE_BLOCKS, ['"project atlas"'], [flatBlock(101, 'Only block')])],
      [editor(LINKED_REFERENCES, ['Project Atlas'], [[sourcePage(BOB), [linkingBlock(201, BOB.id)]]])]
    ]
  },
  {
    // `resolve_refs`: one query per level over the blocks and the linking blocks together
    name: 'build_context: resolve_refs in the blocks and the linking blocks',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas', resolve_refs: true },
    steps: REF_STEPS()
  },
  {
    // Compact skips it, with a warning, and makes no ref query
    name: 'build_context: resolve_refs skipped under compact',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas', resolve_refs: true, compact: true },
    steps: exact(ATLAS, 'Project Atlas', REF_BLOCKS, REF_REFERENCES)
  },
  {
    // A ref that goes on past depth 2 is left as written, with a warning
    name: 'build_context: resolve_refs past the depth limit',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas', resolve_refs: true },
    steps: [
      ...exact(ATLAS, 'Project Atlas', REF_BLOCKS, []),
      [refQuery({ blocks: [uuid(2)] }, [target(2, `mid ((${uuid(3)}))`)])],
      [refQuery({ blocks: [uuid(3)] }, [target(3, `end ((${uuid(4)}))`)])]
    ]
  },
  {
    name: 'build_context: compact',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas', compact: true },
    steps: exact(PROJECT, 'Project Atlas', BLOCKS, REFERENCES)
  }
];

const asMarkdown = (cases: readonly ParityCase[]): ParityCase[] =>
  cases.map(c => ({ ...c, name: c.name.replace('build_context:', 'build_context markdown:'), arguments: { ...c.arguments, format: 'markdown' } }));

const PRE_BLOCK = flatBlock(100, 'type:: project\nstatus:: active\n', { extra: { 'pre-block?': true } });

export const buildContextCases: ParityCase[] = [
  ...SHAPES,

  // ---- what stays the same whatever the cap
  {
    // With a cap of 0 nothing of that kind is kept, and the totals say what there was
    name: 'build_context: caps at 0',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas', max_blocks: 0, max_references: 0, max_related_pages: 0 },
    steps: exact(ATLAS, 'Project Atlas', BLOCKS, REFERENCES),
    // nothing of the answer is shown but its counts
    perturbed: [[sourcePage(BOB), [linkingBlock(201, BOB.id)]]]
  },
  {
    name: 'build_context: temporal context left out',
    tool: TOOL,
    arguments: { topic_name: '2025-01-01', include_temporal_context: false },
    steps: [
      [query(RESOLVE_WITH_DAY, ['"2025-01-01"', '20250101'], [[pulled(NEW_YEAR), 'journal-date']])],
      [query(PAGE_BLOCKS, ['"jan 1st, 2025"'], [])],
      [editor(LINKED_REFERENCES, ['jan 1st, 2025'], [])]
    ]
  },
  {
    // More blocks than the default cap and than a result is said to fit: the warning says so too
    name: 'build_context: more blocks than the inline estimate',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas' },
    steps: exact(ATLAS, 'Project Atlas', chain(201), [])
  },
  {
    // The name as typed, trimmed, is what the Editor call gets; the query gets it lowercased
    name: 'build_context: name with spaces and capitals',
    tool: TOOL,
    arguments: { topic_name: '  Project ATLAS ' },
    steps: exact(ATLAS, '  Project ATLAS ', [flatBlock(101, 'Only block')], [])
  },
  {
    // `name`, `page` and `page_name` stand in for `topic_name` (BR-0008)
    name: 'build_context: parameter alias',
    tool: TOOL,
    arguments: { page_name: 'Project Atlas' },
    steps: exact(ATLAS, 'Project Atlas', [flatBlock(101, 'Only block')], [])
  },

  // ---- aliases
  {
    // The alias group is cut at 50: the page and 49 aliases, and the cut is said
    name: 'build_context: an alias group past the cap',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas' },
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
      // `member 00` has id 159, `member 01` 158 and so on: the first 49 by name are 159 down to 111
      [query(blocksOnPages([10, ...Array.from({ length: 49 }, (_, k) => 159 - k)]), [], [flatBlock(101, 'Only block')])],
      [query(linkedReferencesQuery([10, ...Array.from({ length: 49 }, (_, k) => 159 - k)]), [], [pulledLinkingBlock(201, BOB)])]
    ]
  },
  {
    // The linking pages of a group come back in order of name, then id, not by how many link
    name: 'build_context: the aliased linking pages are in order of name',
    tool: TOOL,
    arguments: { topic_name: 'Atlas' },
    steps: aliasGroupSteps(GROUP_BLOCKS.slice(0, 1), [
      pulledLinkingBlock(411, ALICE),
      pulledLinkingBlock(412, ALICE),
      pulledLinkingBlock(211, CAROL),
      pulledLinkingBlock(201, BOB),
      pulledLinkingBlock(301, NEW_YEAR),
      pulledLinkingBlock(421, ALICE_NOTES)
    ])
  },

  // ---- a name that is not one page
  {
    name: 'build_context: no such page',
    tool: TOOL,
    arguments: { topic_name: 'Projct Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"projct atlas"'], [])],
      [query(NAMESPACE_LEAF, ['"/projct atlas"'], [])],
      [editor(GET_ALL_PAGES, [], [{ originalName: 'Project Atlas' }, { originalName: 'Alice' }, { originalName: 'Bob' }])]
    ]
  },
  {
    name: 'build_context: a name two pages declare is ambiguous',
    tool: TOOL,
    arguments: { topic_name: 'al' },
    steps: [[query(RESOLVE_BY_NAME, ['"al"'], [[pulled(ALICE_NOTES), 'alias'], [pulled(ALICE), 'alias']])]]
  },

  // ---- null is not empty, and what propagates
  {
    // PARITY: a null answer for the blocks is read as no blocks (suspected TS bug, BR-0011)
    name: 'build_context: the blocks query answers null',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas' },
    steps: exact(ATLAS, 'Project Atlas', null as unknown as unknown[], [[sourcePage(BOB), [linkingBlock(201, BOB.id)]]])
  },
  {
    // PARITY: a null answer for the linked references is read as no links (suspected TS bug, BR-0011)
    name: 'build_context: the linked references answer null',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas' },
    steps: exact(ATLAS, 'Project Atlas', [flatBlock(101, 'Only block')], null)
  },
  {
    name: 'build_context: the aliased queries answer null',
    tool: TOOL,
    arguments: { topic_name: 'Atlas' },
    steps: aliasGroupSteps(null as unknown as unknown[], null as unknown as unknown[])
  },
  {
    name: 'build_context: LogSeq error from the blocks query',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"project atlas"'], [[pulled(ATLAS), 'name']])],
      [query(PAGE_BLOCKS, ['"project atlas"'], { error: 'Query timed out' })]
    ]
  },
  {
    name: 'build_context: LogSeq error from the linked references',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"project atlas"'], [[pulled(ATLAS), 'name']])],
      [query(PAGE_BLOCKS, ['"project atlas"'], [flatBlock(101, 'Only block')])],
      [editor(LINKED_REFERENCES, ['Project Atlas'], { error: 'Query timed out' })]
    ]
  },
  {
    name: 'build_context: blocks in a shape the server cannot read',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"project atlas"'], [[pulled(ATLAS), 'name']])],
      // no string in the answer, so the self-check can perturb it into an error of another kind
      [query(PAGE_BLOCKS, ['"project atlas"'], [[{ id: 1 }]])]
    ]
  },
  {
    name: 'build_context: linked references in a shape the server cannot read',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas' },
    steps: [
      [query(RESOLVE_BY_NAME, ['"project atlas"'], [[pulled(ATLAS), 'name']])],
      [query(PAGE_BLOCKS, ['"project atlas"'], [])],
      [editor(LINKED_REFERENCES, ['Project Atlas'], [[{ id: 'one' }, []]])]
    ],
    perturbed: [[{ id: true }, []]]
  },

  // ---- arguments, checked before any call
  { name: 'build_context: a negative cap', tool: TOOL, arguments: { topic_name: 'Project Atlas', max_blocks: -1 }, steps: [] },
  { name: 'build_context: a fraction for a cap', tool: TOOL, arguments: { topic_name: 'Project Atlas', max_references: 2.5 }, steps: [] },
  { name: 'build_context: no topic', tool: TOOL, arguments: { max_blocks: 3 }, steps: [] },
  { name: 'build_context: a topic that is not text', tool: TOOL, arguments: { topic_name: 5 }, steps: [] },
  { name: 'build_context: format is not a known one', tool: TOOL, arguments: { topic_name: 'Project Atlas', format: 'xml' }, steps: [] },
  { name: 'build_context: compact is not a boolean', tool: TOOL, arguments: { topic_name: 'Project Atlas', compact: 'yes' }, steps: [] },

  // ---- Markdown
  ...asMarkdown(SHAPES),
  {
    // The pre-block is the page properties, verbatim, and is not listed again; the page map is not used
    name: 'build_context markdown: the pre-block is the properties',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas', format: 'markdown' },
    steps: exact(PROJECT, 'Project Atlas', [flatBlock(101, 'Body block', { left: 100 }), PRE_BLOCK], [])
  },
  {
    // With no pre-block the properties are rebuilt from the page's map: integer-like keys first, lists as links
    name: 'build_context markdown: properties come from the page map',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas', format: 'markdown' },
    steps: exact(PROJECT, 'Project Atlas', [flatBlock(101, 'Body block')], [])
  },
  {
    name: 'build_context markdown: caps and a long first line, compact',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas', format: 'markdown', compact: true, max_blocks: 2, max_references: 1 },
    steps: exact(PROJECT, 'Project Atlas', [flatBlock(99, `A long first line ${'that goes on and on '.repeat(6)}\nand a second line`), ...BLOCKS.slice(0, 2)], REFERENCES)
  },
  {
    name: 'build_context markdown: resolve_refs shows the resolved text under the block',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas', format: 'markdown', resolve_refs: true },
    steps: REF_STEPS()
  },
  {
    name: 'build_context markdown: a cap and a way to get the rest in the footer',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas', format: 'markdown' },
    steps: exact(ATLAS, 'Project Atlas', chain(201), [])
  },
  {
    name: 'build_context markdown: an alias group, the page asked about first',
    tool: TOOL,
    arguments: { topic_name: 'Atlas', format: 'markdown', compact: true },
    steps: aliasGroupSteps(GROUP_BLOCKS, GROUP_REFERENCES)
  },
  {
    name: 'build_context markdown: a name two pages declare is ambiguous',
    tool: TOOL,
    arguments: { topic_name: 'al', format: 'markdown' },
    steps: [[query(RESOLVE_BY_NAME, ['"al"'], [[pulled(ALICE_NOTES), 'alias'], [pulled(ALICE), 'alias']])]]
  },
  {
    // A block whose parent is not among the blocks shown (the cap cut it) is shown at the top
    name: 'build_context markdown: a block whose parent was cut',
    tool: TOOL,
    arguments: { topic_name: 'Project Atlas', format: 'markdown', max_blocks: 1 },
    steps: exact(ATLAS, 'Project Atlas', [flatBlock(102, 'Child of a block not shown', { parent: 101, left: 101 }), flatBlock(101, 'Parent')], [])
  }
];
