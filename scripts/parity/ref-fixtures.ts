// What the parity cases of logseq_get_block, logseq_get_page and the ref resolver share (#308,
// ADR-0025): the queries as they go over the wire, and the shapes LogSeq answers with. Every page,
// block and name is made up (BR-0001).
//
// Queries are written out here in full, not built with the TypeScript query builders, so a change
// to a builder that changes the query LogSeq receives fails the case, and a second implementation
// is held to what the first one sends, not to the code that sends it.
import { DATASCRIPT_QUERY, type CannedCall } from './stub-logseq.js';

export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

/** A uuid with hex letters, to be written in either case */
export const HEX_UUID = '0000000a-0000-4000-8000-00000000000b';

export const query = (text: string, inputs: string[], response: unknown): CannedCall => ({
  method: DATASCRIPT_QUERY,
  args: [text, ...inputs],
  response
});

export const editor = (method: string, args: unknown[], response: unknown): CannedCall => ({ method, args, response });

// ---- the page resolver (BR-0010)

export const RESOLVE_BY_NAME =
  '[:find (pull ?page [*]) ?via :in $ ?n :where (or-join [?n ?page ?via] ' +
  '(and [?page :block/name ?n] [(ground "name") ?via]) ' +
  '(and [?stub :block/name ?n] [?page :block/alias ?stub] [(ground "alias") ?via]))]';

export const RESOLVE_WITH_DAY =
  '[:find (pull ?page [*]) ?via :in $ ?n ?day :where (or-join [?n ?day ?page ?via] ' +
  '(and [?page :block/name ?n] [(ground "name") ?via]) ' +
  '(and [?stub :block/name ?n] [?page :block/alias ?stub] [(ground "alias") ?via]) ' +
  '(and [?page :block/name] [?page :block/journal-day ?day] [(ground "journal-date") ?via]))]';

export const NAMESPACE_LEAF =
  '[:find (pull ?page [*]) :in $ ?suffix :where [?page :block/name ?n] [?page :block/namespace] ' +
  '[(clojure.string/ends-with? ?n ?suffix)]]';

// ---- the ref lookup (BR-0007)

const REF_PULL =
  '[:find (pull ?e [:db/id :block/uuid :block/content :block/name :block/original-name ' +
  '{:block/left [:db/id]} {:block/parent [:db/id]} ' +
  '{:block/page [:db/id :block/name :block/original-name]}])';

const grounded = (uuids: string[], variable: string) => `[(ground [${uuids.map(u => `#uuid "${u}"`).join(' ')}]) [${variable} ...]]`;

/** The one query a level of ref lookups makes, and the input it binds (page names, if any). */
export function refQuery(spec: { blocks?: string[]; descendants?: string[]; pages?: string[] }, response: unknown): CannedCall {
  const { blocks = [], descendants = [], pages = [] } = spec;
  const branches: string[] = [];
  if (blocks.length > 0) branches.push(`(and ${grounded(blocks, '?u')} [?e :block/uuid ?u])`);
  if (descendants.length > 0) {
    branches.push(
      `(and ${grounded(descendants, '?ru')} [?r :block/uuid ?ru] (or-join [?r ?e] [?e :block/parent ?r] ` +
        '(and [?m1 :block/parent ?r] [?e :block/parent ?m1]) ' +
        '(and [?m1 :block/parent ?r] [?m2 :block/parent ?m1] [?e :block/parent ?m2])))'
    );
  }
  if (pages.length > 0) {
    branches.push('[?e :block/name ?n]');
    branches.push('(and [?pg :block/name ?n] [?e :block/parent ?pg])');
  }
  const text =
    `${REF_PULL}${pages.length > 0 ? ' :in $ [?n ...]' : ''} :where ` +
    `(or-join ${pages.length > 0 ? '[?e ?n]' : '[?e]'} ${branches.join(' ')})]`;
  return query(text, pages.length > 0 ? [JSON.stringify(pages)] : [], response);
}

// ---- pages

export interface PageSpec {
  id: number;
  name: string;
  originalName: string;
  /** Backed by a file: not a stub */
  file?: boolean;
  journalDay?: number;
  /** More keys, written last */
  extra?: Record<string, unknown>;
}

/** A page as `logseq.Editor.getPage` answers it: camelCase keys. */
export const editorPage = ({ id, name, originalName, file, journalDay, extra }: PageSpec) => ({
  id,
  uuid: uuid(id),
  name,
  originalName,
  ...(journalDay ? { 'journal?': true, journalDay } : { 'journal?': false }),
  ...(file ? { file: { id: id + 5000 } } : {}),
  createdAt: 1735689600000 + id,
  updatedAt: 1735689600000 + id * 2,
  ...(extra ?? {})
});

/** A page as the resolver's `pull [*]` answers it: kebab-case keys. */
export const pulledPage = ({ id, name, originalName, file, journalDay }: PageSpec) => ({
  id,
  uuid: uuid(id),
  name,
  'original-name': originalName,
  ...(file ? { file: { id: id + 5000 } } : {}),
  ...(journalDay ? { 'journal?': true, 'journal-day': journalDay } : { 'journal?': false })
});

export const ATLAS: PageSpec = { id: 10, name: 'project atlas', originalName: 'Project Atlas', file: true };
export const BOB: PageSpec = { id: 20, name: 'bob', originalName: 'Bob' };
export const NEW_YEAR: PageSpec = { id: 30, name: 'jan 1st, 2025', originalName: 'Jan 1st, 2025', file: true, journalDay: 20250101 };
export const ALICE: PageSpec = { id: 40, name: 'alice', originalName: 'Alice', file: true };
export const ALICE_NOTES: PageSpec = { id: 41, name: 'alice notes', originalName: 'Alice Notes', file: true };
export const ATLAS_LOG: PageSpec = { id: 50, name: 'project atlas/log', originalName: 'Project Atlas/Log', file: true };

// ---- blocks

/** A block as `logseq.Editor.getBlock` and `getPageBlocksTree` answer it: camelCase keys, `page` and `parent` as bare ids. */
export function editorBlock(
  id: number,
  content: string,
  options: { page?: number; parent?: number; children?: unknown[]; properties?: Record<string, unknown> } = {}
) {
  const { page = ATLAS.id, parent = page, children, properties } = options;
  return {
    id,
    uuid: uuid(id),
    content,
    ...(properties ? { properties } : {}),
    page: { id: page },
    parent: { id: parent },
    left: { id: parent },
    format: 'markdown',
    ...(children ? { children } : {})
  };
}

/** What `((uuid))` points at, as the ref lookup pulls it: LogSeq's own keys, on the page "Project Atlas" unless said. */
export function target(id: number, content: string, options: { parent?: number; left?: number; page?: number; uuid?: string } = {}) {
  const { parent = ATLAS.id, left = parent, page = ATLAS.id, uuid: own = uuid(id) } = options;
  return [
    {
      id,
      uuid: own,
      content,
      left: { id: left },
      parent: { id: parent },
      page: { id: page, name: ATLAS.name, 'original-name': ATLAS.originalName }
    }
  ];
}

/** The row LogSeq 0.10 makes for a `((uuid))` nobody has: no page, no parent, no name (#138). */
export const placeholder = (id: number, ref: string) => [{ id, uuid: ref, content: `id:: ${ref}` }];

/** The row of a page entity, as a page embed pulls it. */
export const pageRow = ({ id, name, originalName }: PageSpec) => [{ id, name, 'original-name': originalName }];
