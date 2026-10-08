// Parity cases for the closest names of a page-not-found message (#335, ADR-0032). A second implementation
// is held to rules for that list, not to the reference's bytes, and the recorded set has to exercise every
// rule: an exact hit, a prefix hit, more than three exact or prefix matches, no suggestion for an input no page
// covers, a name that contains `, `, and a name that ends with a full stop. The other cases the ADR requires
// are in get-page.ts (a typo with no prefix match), get-page-outline.ts (an ISO date) and page-resource.ts
// (the resource's error). Every page and name here is made up (BR-0001).
//
// The stubbed resolver finds no page for each name, though `getAllPages` still lists it, which is how an
// exact hit arises. Each case is `logseq_get_page` on a name that is missing: 3 resolver calls and the list.
import type { ParityCase } from '../harness.js';
import { NAMESPACE_LEAF, RESOLVE_BY_NAME, editor, query } from '../ref-fixtures.js';

const GET_PAGE = 'logseq.Editor.getPage';
const GET_ALL_PAGES = 'logseq.Editor.getAllPages';

/** `logseq_get_page` for a name no page has, with `pages` as the names `getAllPages` lists */
const missing = (name: string, input: string, pages: string[], extra: Partial<ParityCase> = {}): ParityCase => ({
  name: `suggestions: ${name}`,
  tool: 'logseq_get_page',
  arguments: { page_name: input },
  steps: [
    [editor(GET_PAGE, [input], null)],
    [query(RESOLVE_BY_NAME, [JSON.stringify(input.toLowerCase())], [])],
    [query(NAMESPACE_LEAF, [JSON.stringify(`/${input.toLowerCase()}`)], [])],
    [editor(GET_ALL_PAGES, [], pages.map(originalName => ({ originalName })))]
  ],
  ...extra
});

export const suggestionsCases: ParityCase[] = [
  // E and P both non-empty: the exact name comes before the names that start with it
  missing('an exact hit comes before the prefix hits', 'alice', ['Bob', 'Alice Notes', 'Alice Cooper', 'Alice', 'Project Atlas']),
  // E empty, P non-empty
  missing('a prefix hit', 'proj', ['Bob', 'Alice', 'Project Atlas', 'Project Zed']),
  // More than three in T: only three are listed, all of them exact or prefix matches
  missing('more than three prefix hits', 'al', ['Bob', 'Alice', 'Alice Notes', 'Alan', 'Alba', 'Albert', 'Project Atlas']),
  // N is empty, so the message has no list
  // (the self-check lists a page that covers it, since a suffix on the names changes nothing the message says)
  missing('no page covers the input', 'zzz', ['Project Atlas', 'Alice', 'Bob'], { perturbed: [{ originalName: 'Zzz Notes' }] }),
  // A name with `, ` in it, which the list is split around
  missing('a name that contains a comma and a space', 'smth', ['Smith, Alice', 'Smith, Bob', 'Bob', 'Project Atlas']),
  // A name that ends with a full stop, so the list ends in two of them before the guidance
  missing('a name that ends with a full stop', 'notes v', ['Notes v1.', 'Notes v2.', 'Bob']),
  // A quote and a backslash in the input and a name: the message is read decoded, not as escaped
  missing('a name with a quote and a backslash', 'say "hi"', ['Say "hi" \\ bye', 'Bob']),
  // A name made of capitals and accents, which the fold treats as the input typed in lowercase
  missing('capitals and accents', 'cafe', ['Café Notes', 'CAFÉ', 'Bob']),
  // Letters of Latin Extended Additional (stacked accents), which a matcher's own accent table can get wrong
  missing('stacked accents in a name', 'nguyen', ['Nguyễn', 'Bob', 'Project Atlas']),
  // An accent on the input side, in the second word, against a name that has none
  missing('an accent in the input', 'menu café', ['Cafe Menu', 'Bob', 'Project Atlas']),
  // A letter that NFD doesn't split: the fold leaves it, so the unaccented input covers nothing
  // (the self-check lists a page that covers it, as in the case above)
  missing('a letter with no decomposition', 'bjorn', ['Bjørn', 'Bob', 'Project Atlas'], { perturbed: [{ originalName: 'Bjorn Notes' }] })
];
