// What the parity cases of logseq_build_context and logseq_get_context_for_query share (#312,
// ADR-0025): the queries as they go over the wire, and the shapes LogSeq answers with. Every page,
// block and name is made up (BR-0001).
//
// Queries are written out here in full, not built with the TypeScript query builders, so a change
// to a builder that changes the query LogSeq receives fails the case, and a second implementation
// is held to what the first one sends, not to the code that sends it.
import { DATASCRIPT_QUERY, type CannedCall } from './stub-logseq.js';
import { editor, query, uuid } from './ref-fixtures.js';

export { NAMESPACE_LEAF, RESOLVE_BY_NAME, RESOLVE_WITH_DAY, editor, query, refQuery, target, uuid } from './ref-fixtures.js';

export const GET_ALL_PAGES = 'logseq.Editor.getAllPages';
export const LINKED_REFERENCES = 'logseq.Editor.getPageLinkedReferences';

// ---- the queries these tools make

/** A page's blocks: one query, bound by name. */
export const PAGE_BLOCKS =
  '[:find (pull ?block [*]) :in $ ?page-name :where [?page :block/name ?page-name] [?block :block/page ?page]]';

/** The blocks of every page of an alias group. */
export const blocksOnPages = (ids: number[]) =>
  `[:find (pull ?block [*]) :where [(ground [${ids.join(' ')}]) [?page ...]] [?block :block/page ?page]]`;

export const aliasSetsQuery = (ids: number[]) =>
  `[:find ?start (pull ?m [:db/id :block/name :block/original-name]) :where [(ground [${ids.join(' ')}]) [?start ...]] ` +
  '(or-join [?start ?m] (or-join [?start ?m] [?start :block/alias ?m] [?m :block/alias ?start]) ' +
  '(and (or-join [?start ?alias-mid] [?start :block/alias ?alias-mid] [?alias-mid :block/alias ?start]) ' +
  '(or-join [?alias-mid ?m] [?alias-mid :block/alias ?m] [?m :block/alias ?alias-mid])))]';

export const linkedReferencesQuery = (ids: number[]) =>
  '[:find (pull ?block [* {:block/page [:db/id :block/name :block/original-name :block/journal-day]}]) :where ' +
  `[(ground [${ids.join(' ')}]) [?p ...]] [?block :block/path-refs ?p] [?block :block/page ?source] ` +
  `(not [(ground [${ids.join(' ')}]) [?source ...]])]`;

/** The keyword search of `get_context_for_query`: the same query `logseq_search_blocks` makes. */
export const SEARCH =
  '[:find (pull ?b [* {:block/page [:db/id :block/name :block/original-name]}]) :in $ ?pattern :where ' +
  '[?b :block/content ?c] [(re-pattern ?pattern) ?re] [(re-find ?re ?c)]]';

/** The input LogSeq receives for a search text: `(?i)` and the text with its regex characters escaped. */
export const searchPattern = (text: string) => JSON.stringify(`(?i)${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

export const search = (text: string, response: unknown): CannedCall => ({
  method: DATASCRIPT_QUERY,
  args: [SEARCH, searchPattern(text)],
  response
});

/** The pages of the hits kept, in one query, for Markdown. */
export const pagesQuery = (ids: number[]) => `[:find (pull ?p [*]) :where [(ground [${ids.join(' ')}]) [?p ...]] [?p :block/name]]`;

// ---- pages

export interface Page {
  id: number;
  name: string;
  originalName: string;
  /** Backed by a file: not a stub (default) */
  file?: boolean;
  /** Ids of the pages this one is linked to by `alias::` */
  alias?: number[];
  journalDay?: number;
  properties?: Record<string, unknown>;
}

export const ATLAS: Page = { id: 10, name: 'project atlas', originalName: 'Project Atlas' };
export const ATLAS_WITH_ALIAS: Page = { ...ATLAS, alias: [11] };
export const ATLAS_STUB: Page = { id: 11, name: 'atlas', originalName: 'Atlas', file: false, alias: [10] };
export const BOB: Page = { id: 20, name: 'bob', originalName: 'Bob' };
export const CAROL: Page = { id: 21, name: 'carol', originalName: 'Carol' };
export const NEW_YEAR: Page = { id: 30, name: 'jan 1st, 2025', originalName: 'Jan 1st, 2025', journalDay: 20250101 };
export const ALICE: Page = { id: 40, name: 'alice', originalName: 'Alice' };
export const ALICE_NOTES: Page = { id: 41, name: 'alice notes', originalName: 'Alice Notes' };
export const ATLAS_RETRO: Page = { id: 60, name: 'project atlas/retro', originalName: 'Project Atlas/Retro' };

/** A page as the resolver's `pull [*]` answers it: kebab-case keys. */
export const pulled = ({ id, name, originalName, file = true, alias, journalDay, properties }: Page) => ({
  id,
  uuid: uuid(id),
  name,
  'original-name': originalName,
  ...(file ? { file: { id: id + 5000 } } : {}),
  ...(alias ? { alias: alias.map(a => ({ id: a })) } : {}),
  ...(journalDay ? { 'journal?': true, 'journal-day': journalDay } : { 'journal?': false }),
  ...(properties ? { properties } : {}),
  'created-at': 1735689600000 + id
});

/** An alias group's row: `[startId, member]`. */
export const member = (start: number, { id, name, originalName }: Page) => [start, { id, name, 'original-name': originalName }];

/** A source page as the Editor API sends it in a linked reference: camelCase keys. */
export const sourcePage = ({ id, name, originalName, journalDay }: Page) => ({
  id,
  name,
  originalName,
  ...(journalDay ? { 'journal?': true, journalDay } : { 'journal?': false })
});

/** A page as `pull [*]` returns it for a page lookup by id: a row of one page. */
export const pageRow = (page: Page) => [pulled(page)];

// ---- blocks

/** A flat block as the Datalog pull gives it: LogSeq's own keys, a bare `{ id }` for page, parent and left. */
export function flatBlock(
  id: number,
  content: string,
  options: { page?: number; parent?: number; left?: number; extra?: Record<string, unknown> } = {}
) {
  const { page = ATLAS.id, parent = page, left = parent, extra } = options;
  return [
    {
      id,
      uuid: uuid(id),
      content,
      format: 'markdown',
      page: { id: page },
      parent: { id: parent },
      left: { id: left },
      'path-refs': [],
      ...(extra ?? {})
    }
  ];
}

/** A block that links the topic, as `getPageLinkedReferences` sends it: camelCase keys, `page` as a bare id. */
export function linkingBlock(id: number, page: number, content = `Mentions [[Project Atlas]] (${id})`, extra: Record<string, unknown> = {}) {
  return {
    id,
    uuid: uuid(id),
    content,
    format: 'markdown',
    page: { id: page },
    parent: { id: page },
    left: { id: page },
    ...extra
  };
}

/** A linking block as the aliased Datalog query pulls it: kebab-case keys, its page nested with the keys of a source page. */
export function pulledLinkingBlock(id: number, page: Page, content = `Mentions [[Atlas]] (${id})`) {
  return [
    {
      id,
      uuid: uuid(id),
      content,
      format: 'markdown',
      'path-refs': [{ id: 11 }],
      parent: { id: page.id },
      left: { id: page.id },
      page: { id: page.id, name: page.name, 'original-name': page.originalName, ...(page.journalDay ? { 'journal-day': page.journalDay } : {}) }
    }
  ];
}

// ---- the calls of one topic

/** The resolver's one query for an exact name, answered with the page. */
export const resolveExact = (input: string, page: Page, resolverQuery: string): CannedCall =>
  query(resolverQuery, [JSON.stringify(input.trim().toLowerCase())], [[pulled(page), 'name']]);

export { DATASCRIPT_QUERY };

/**
 * The calls `build_context` makes for an exact name on a page with no aliases: the resolver, the
 * page's blocks, then the Editor API's linked references (`lookupName` is the name as typed, trimmed).
 */
export function exactSteps(resolverQuery: string, page: Page, input: string, blocks: unknown[], references: unknown): CannedCall[][] {
  const typed = input.trim();
  return [
    [resolveExact(input, page, resolverQuery)],
    [query(PAGE_BLOCKS, [JSON.stringify(typed.toLowerCase())], blocks)],
    [editor(LINKED_REFERENCES, [typed], references)]
  ];
}
