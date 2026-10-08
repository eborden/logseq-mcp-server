// Parity cases for logseq_check_links (#314, #299, ADR-0025). Every page, block and name here is
// made up (BR-0001). Each case lists the LogSeq calls the TypeScript server makes, in order, with the
// answer the stub gives; the result the server printed for it is in ../expected/check-links.json.
// The checks that read only the two texts make no call, so most of their cases have no steps.
import { DATASCRIPT_QUERY, type CannedCall } from '../stub-logseq.js';
import type { ParityCase } from '../harness.js';

const TOOL = 'logseq_check_links';

const LINK_TARGETS =
  '[:find (pull ?page [:db/id :block/name :block/original-name :block/file]) ?via ?n :in $ [?n ...] :where ' +
  '(or-join [?n ?page ?via] (and [?page :block/name ?n] [(ground "name") ?via]) ' +
  '(and [?stub :block/name ?n] [?page :block/alias ?stub] [(ground "alias") ?via]))]';

/** The one batched query for these names (already trimmed and lowercased, in the order of the sorted terms). */
const targets = (names: string[], response: unknown): CannedCall => ({
  method: DATASCRIPT_QUERY,
  args: [LINK_TARGETS, JSON.stringify(names)],
  response
});

/** A page as the link-target query pulls it: only the attributes it asks for. */
const page = (id: number, name: string, originalName: string, file = true) => ({
  'db/id': id,
  id,
  name,
  'original-name': originalName,
  ...(file ? { file: { id: id + 5000 } } : {})
});

/** `[page, via, name]`: the page a name reached, and by which route. */
const row = (p: ReturnType<typeof page>, via: 'name' | 'alias', name: string) => [p, via, name];

const ALICE = page(1, 'alice', 'Alice');
const BOB = page(2, 'bob', 'Bob');
const STUB = page(3, 'stub page', 'Stub Page', false);

/** A case whose LogSeq calls, at most one, are listed flat: each is its own step. */
type FlatCase = Omit<ParityCase, 'steps'> & { steps: CannedCall[] };

const flatCases: FlatCase[] = [
  // --- the checks that read only the texts -----------------------------------------------------
  {
    name: 'links: a text with no links makes no call',
    tool: TOOL,
    arguments: { before: 'Alice met Bob.', after: 'Alice met Bob.' },
    steps: []
  },
  {
    // Empty is a text, not a missing one
    name: 'links: two empty texts',
    tool: TOOL,
    arguments: { before: '', after: '' },
    steps: []
  },
  {
    // A pass that changes a word: the first difference, by line and column, with the stretch around it
    name: 'links prose: a changed word on the second line',
    tool: TOOL,
    arguments: { before: 'First line\nAlice met Bob today', after: 'First line\nAlice met [[Bob]] tomorrow' },
    steps: [targets(['bob'], [row(BOB, 'name', 'bob')])]
  },
  {
    // Long lines are cut to 30 characters before and 50 after, with an ellipsis
    name: 'links prose: a long line is cut around the difference',
    tool: TOOL,
    arguments: {
      before: `${'a'.repeat(40)}X${'b'.repeat(60)}`,
      after: `${'a'.repeat(40)}Y${'b'.repeat(60)}`
    },
    steps: []
  },
  {
    name: 'links prose: one text ends where the other goes on',
    tool: TOOL,
    arguments: { before: 'Alice met Bob', after: 'Alice met Bob and Carol' },
    steps: []
  },
  {
    name: 'links prose: the other text is the shorter',
    tool: TOOL,
    arguments: { before: 'Alice met Bob and Carol\nsecond', after: 'Alice met Bob' },
    steps: []
  },
  {
    // Positions count code points, and a difference inside a surrogate pair points at the pair
    name: 'links prose: astral characters',
    tool: TOOL,
    arguments: { before: 'a\u{1F600}\u{1F600} z', after: 'a\u{1F600}\u{1F601} z' },
    steps: []
  },
  {
    name: 'links prose: a column after astral characters',
    tool: TOOL,
    arguments: { before: '\u{1F680}\u{1F680} one', after: '\u{1F680}\u{1F680} two' },
    steps: []
  },
  {
    // A difference at the very start of a text that begins with a newline: the excerpt is empty
    // (the TypeScript lookup finds that first newline as the start of the line)
    name: 'links prose: a difference at a leading newline',
    tool: TOOL,
    arguments: { before: '\nAlice', after: 'Alice' },
    steps: []
  },
  {
    name: 'links prose: a difference on a later line after a leading newline',
    tool: TOOL,
    arguments: { before: '\nAlice\nBob', after: '\nAlice\nBobby' },
    steps: []
  },
  {
    // Carriage returns are characters like any other, and a term can hold one
    name: 'links prose: windows line endings',
    tool: TOOL,
    arguments: { before: 'one\r\ntwo\r\nthree', after: 'one\r\ntwo\r\nthrEe' },
    steps: []
  },
  {
    // Brackets that are not a link are prose, so removing them is a difference
    name: 'links prose: brackets that are not a link',
    tool: TOOL,
    arguments: { before: 'see [[Alice]] and [[]] and [[a\nb]]', after: 'see Alice and [[]] and a\nb' },
    steps: []
  },

  // --- brackets --------------------------------------------------------------------------------
  {
    name: 'links brackets: an unclosed link',
    tool: TOOL,
    arguments: { before: 'Alice met Bob', after: '[[Alice]] met [[Bob' },
    steps: [targets(['alice'], [row(ALICE, 'name', 'alice')])]
  },
  {
    name: 'links brackets: a link opened inside another',
    tool: TOOL,
    arguments: { before: 'Alice and Bob met', after: '[[Alice and [[Bob]] met]]' },
    steps: [targets(['bob'], [row(BOB, 'name', 'bob')])]
  },
  {
    // The nesting is found on its own line, 2 here, and shown with the stretch around it
    name: 'links brackets: nesting on a later line',
    tool: TOOL,
    arguments: { before: 'fine\nsee Alice and Bob here', after: 'fine\nsee [[Alice and [[Bob]] here]]' },
    steps: [targets(['bob'], [row(BOB, 'name', 'bob')])]
  },
  {
    // A newline between the two openers is not nesting, though the brackets do not balance
    name: 'links brackets: two openers on different lines',
    tool: TOOL,
    arguments: { before: 'a\nb', after: '[[a\n[[b]]' },
    steps: [targets(['b'], [row(page(4, 'b', 'B'), 'name', 'b')])]
  },
  {
    name: 'links brackets: three brackets in a row',
    tool: TOOL,
    arguments: { before: 'a', after: '[[[a]]' },
    steps: [targets(['a'], [row(page(4, 'a', 'A'), 'name', 'a')])]
  },
  {
    name: 'links brackets: more closers than openers',
    tool: TOOL,
    arguments: { before: 'a b', after: '[[a]] b]]' },
    steps: [targets(['a'], [row(page(4, 'a', 'A'), 'name', 'a')])]
  },

  // --- refs preserved --------------------------------------------------------------------------
  {
    // Un-bracketing a ref passes the prose check; this one catches it
    name: 'links preserved: a ref removed',
    tool: TOOL,
    arguments: { before: '[[Alice]] met [[Bob]]', after: 'Alice met [[Bob]]' },
    steps: [targets(['bob'], [row(BOB, 'name', 'bob')])]
  },
  {
    // Counted per name, in any casing, and reported by the first spelling in before, in code-unit order
    name: 'links preserved: fewer refs to a name, in any casing',
    tool: TOOL,
    arguments: {
      before: '[[Zed]] [[bob]] [[Bob]] [[Alice]] [[alice]]',
      after: 'Zed [[BOB]] [[Alice]] alice'
    },
    steps: [targets(['alice', 'bob'], [row(ALICE, 'name', 'alice'), row(BOB, 'name', 'bob')])]
  },
  {
    // A ref that moves to a mention spelled another way is kept
    name: 'links preserved: a ref respelled in another case is kept',
    tool: TOOL,
    arguments: { before: '[[alice]]', after: '[[Alice]]' },
    steps: [targets(['alice'], [row(ALICE, 'name', 'alice')])]
  },

  // --- refs resolve ----------------------------------------------------------------------------
  {
    // One query, however many terms: sorted by code unit as written, trimmed, lowercased, once each;
    // a name, an alias and a term with spaces around it
    name: 'links refs: names, an alias and a padded term in one query',
    tool: TOOL,
    arguments: {
      before: 'Bob met alice and Rob and Alice again',
      after: '[[Bob]] met [[alice]] and [[Rob]] and [[ Alice ]] again'
    },
    steps: [
      targets(
        ['alice', 'bob', 'rob'],
        [row(ALICE, 'name', 'alice'), row(BOB, 'name', 'bob'), row(page(5, 'robert', 'Robert'), 'alias', 'rob')]
      )
    ]
  },
  {
    // A page that exists only as a link target (no file) is a page
    name: 'links refs: a page with no file is a page, and a missing one is unresolved',
    tool: TOOL,
    arguments: { before: 'Stub Page and Ghost', after: '[[Stub Page]] and [[Ghost]]' },
    steps: [targets(['ghost', 'stub page'], [row(STUB, 'name', 'stub page')])]
  },
  {
    // The bare alias target (alias:: Bob makes a stub "bob") gives way to the page that declares it
    name: 'links refs: a bare alias target gives way to the page that declares it',
    tool: TOOL,
    arguments: { before: 'Bob', after: '[[Bob]]' },
    steps: [targets(['bob'], [row(page(6, 'bob', 'Bob', false), 'name', 'bob'), row(page(7, 'robert', 'Robert'), 'alias', 'bob')])]
  },
  {
    // An exact page wins over another page's alias of the same name
    name: 'links refs: an exact page wins over an alias of the same name',
    tool: TOOL,
    arguments: { before: 'Bob', after: '[[Bob]]' },
    steps: [targets(['bob'], [row(BOB, 'name', 'bob'), row(page(7, 'robert', 'Robert'), 'alias', 'bob')])]
  },
  {
    // An alias two pages declare is ambiguous; a copy the pass added fails
    name: 'links refs: an ambiguous alias that the pass added',
    tool: TOOL,
    arguments: { before: 'al met Bob', after: '[[al]] met [[Bob]]' },
    steps: [
      targets(
        ['bob', 'al'],
        [row(BOB, 'name', 'bob'), row(page(8, 'alice', 'Alice'), 'alias', 'al'), row(page(9, 'alan', 'Alan'), 'alias', 'al')]
      )
    ]
  },
  {
    // The same ref was already there and no copy was added: reported, not failed
    name: 'links refs: an ambiguous alias that was already linked',
    tool: TOOL,
    arguments: { before: '[[al]] met Bob', after: '[[al]] met [[Bob]]' },
    steps: [
      targets(
        ['bob', 'al'],
        [row(BOB, 'name', 'bob'), row(page(8, 'alice', 'Alice'), 'alias', 'al'), row(page(9, 'alan', 'Alan'), 'alias', 'al')]
      )
    ]
  },
  {
    // A second copy of an ambiguous ref is new, so it fails
    name: 'links refs: an ambiguous alias with a copy added',
    tool: TOOL,
    arguments: { before: '[[al]] and al', after: '[[al]] and [[al]]' },
    steps: [
      targets(['al'], [row(page(8, 'alice', 'Alice'), 'alias', 'al'), row(page(9, 'alan', 'Alan'), 'alias', 'al')])
    ]
  },
  {
    // Twelve pages declare it: ten are listed, and the cut is said
    name: 'links refs: a candidate list past ten',
    tool: TOOL,
    arguments: { before: 'al', after: '[[al]]' },
    steps: [
      targets(
        ['al'],
        Array.from({ length: 12 }, (_, i) => row(page(100 + i, `page ${String(i).padStart(2, '0')}`, `Page ${String(i).padStart(2, '0')}`), 'alias', 'al'))
      )
    ]
  },
  {
    // A stub that two others alias is ambiguous too, but the stubs of a group are not candidates
    name: 'links refs: the stubs of an alias group are not candidates',
    tool: TOOL,
    arguments: { before: 'x', after: '[[x]]' },
    steps: [
      targets(
        ['x'],
        [
          row(page(30, 'declaring', 'Declaring'), 'alias', 'x'),
          row(page(31, 'stub b', 'Stub B', false), 'alias', 'x')
        ]
      )
    ]
  },
  {
    // Accents and case: LogSeq's lowercase name is the key
    name: 'links refs: accented and mixed case names',
    tool: TOOL,
    arguments: { before: 'Élodie and ÉLODIE', after: '[[Élodie]] and [[ÉLODIE]]' },
    steps: [targets(['élodie'], [row(page(10, 'élodie', 'Élodie'), 'name', 'élodie')])]
  },
  {
    // A term of blanks asks nothing, and is unresolved; the others go in one query
    name: 'links refs: a blank term',
    tool: TOOL,
    arguments: { before: 'a b', after: '[[a]] [[ ]] b' },
    steps: [targets(['a'], [row(page(4, 'a', 'A'), 'name', 'a')])]
  },
  {
    // Only a blank term: no call at all
    name: 'links refs: only a blank term makes no call',
    tool: TOOL,
    arguments: { before: ' ', after: '[[ ]]' },
    steps: []
  },
  {
    // A row with no page (null), or a name that is not text, answers no term
    name: 'links refs: rows that answer no term are skipped',
    tool: TOOL,
    arguments: { before: 'a b', after: '[[a]] [[b]]' },
    steps: [targets(['a', 'b'], [[null, 'name', 'a'], [page(4, 'b', 'B'), 'name', 5], row(page(5, 'b', 'B'), 'name', 'b')])]
  },
  {
    // Rows that leave out the name entirely are read all the same
    name: 'links refs: a row with no name cell',
    tool: TOOL,
    arguments: { before: 'a', after: '[[a]]' },
    // perturbed: a whole row, which does answer the term
    perturbed: [[page(4, 'a', 'A'), 'name', 'a']],
    steps: [targets(['a'], [[page(4, 'a', 'A'), 'name']])]
  },
  {
    // null is not []: nothing could be checked, and the pages are not reported missing (BR-0011)
    name: 'links refs: LogSeq answers null',
    tool: TOOL,
    arguments: { before: 'Alice and Bob', after: '[[Alice]] and [[Bob]]' },
    steps: [targets(['alice', 'bob'], null)]
  },
  {
    name: 'links refs: LogSeq error from the query',
    tool: TOOL,
    arguments: { before: 'Alice', after: '[[Alice]]' },
    steps: [targets(['alice'], { error: 'Query timed out' })]
  },
  {
    // No string in the answer, so the self-check can perturb it into an error of another kind
    name: 'links refs: a row in a shape the server cannot read',
    tool: TOOL,
    arguments: { before: 'Alice', after: '[[Alice]]' },
    steps: [targets(['alice'], [[true, false]])]
  },
  {
    name: 'links refs: a row whose route is not text',
    tool: TOOL,
    arguments: { before: 'Alice', after: '[[Alice]]' },
    // perturbed: no row at all, which is a result and not this error
    perturbed: [],
    steps: [targets(['alice'], [[page(1, 'alice', 'Alice'), 7, 'alice']])]
  },
  {
    name: 'links refs: a row that is too short',
    tool: TOOL,
    arguments: { before: 'Alice', after: '[[Alice]]' },
    perturbed: [],
    steps: [targets(['alice'], [[page(1, 'alice', 'Alice')]])]
  },

  // --- everything at once ----------------------------------------------------------------------
  {
    name: 'links: a clean pass',
    tool: TOOL,
    arguments: { before: '- Met Alice and Bob\n  - about Atlas', after: '- Met [[Alice]] and [[Bob]]\n  - about [[Atlas]]' },
    steps: [targets(['alice', 'atlas', 'bob'], [row(ALICE, 'name', 'alice'), row(page(11, 'atlas', 'Atlas'), 'name', 'atlas'), row(BOB, 'name', 'bob')])]
  },

  // --- the cap on distinct terms and the arguments ----------------------------------------------
  {
    // 501 distinct names are refused before any call
    name: 'links arguments: more than 500 distinct terms',
    tool: TOOL,
    arguments: {
      before: '',
      after: Array.from({ length: 501 }, (_, i) => `[[page ${i}]]`).join(' ')
    },
    steps: []
  },
  {
    // 500 distinct names, however many spellings, are resolved
    name: 'links arguments: 500 distinct terms and a respelling',
    tool: TOOL,
    arguments: {
      before: '',
      after: `${Array.from({ length: 500 }, (_, i) => `[[page ${i}]]`).join(' ')} [[PAGE 0]]`
    },
    steps: [
      targets(
        // the terms are sorted by code unit, so `PAGE 0` comes first, and its key `page 0` is the first of the names
        ['page 0', ...Array.from({ length: 499 }, (_, i) => `page ${i + 1}`).sort()],
        []
      )
    ]
  },
  {
    name: 'links arguments: before missing',
    tool: TOOL,
    arguments: { after: 'x' },
    steps: []
  },
  {
    name: 'links arguments: after is not text',
    tool: TOOL,
    arguments: { before: 'x', after: ['x'] },
    steps: []
  },
  {
    // The first bad argument, in schema order, is the one reported
    name: 'links arguments: both are wrong',
    tool: TOOL,
    arguments: { before: 5, after: 6 },
    steps: []
  },
  {
    // A text of 50,000 units passes, and 50,001 is too big, with the whole text shown (zod's message)
    name: 'links arguments: after is one unit over the cap',
    tool: TOOL,
    arguments: { before: '', after: 'x'.repeat(50001) },
    steps: []
  },
  {
    name: 'links arguments: both texts at the cap',
    tool: TOOL,
    arguments: { before: 'x'.repeat(50000), after: 'x'.repeat(50000) },
    steps: []
  }
];

export const checkLinksCases: ParityCase[] = flatCases.map(flat => ({ ...flat, steps: flat.steps.map(call => [call]) }));
