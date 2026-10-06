import type { PageLike } from '../response-schemas.js';

/**
 * The one place that knows LogSeq spells an entity two ways (#62).
 *
 * `logseq.Editor.*` camelizes keys: `originalName`, `journalDay`. A Datalog pull keeps
 * LogSeq's own: `original-name`, `journal-day`. `id` and `journal?` are spelled the same by
 * both. A pull can also say `db/id` for the id (Datascript's own spelling; LogSeq 0.10.15 renames
 * it to `id` in query results, but older callers and test doubles still send it).
 * The tools get both kinds of entity, sometimes in one result, and their output has
 * always carried each entity as it came: a full (non-slim) result shows `original-name`
 * for a page that was pulled and `originalName` for one the Editor API sent. So the
 * entities are not rewritten into one shape, and BR-0004 forbids renaming those keys.
 * `src/response-schemas.ts` checks each response and says which spelling it has
 * (`editorPageSchema`, `pulledPageSchema`); these readers pick the field whichever way it
 * is spelled, and every tool reads through them instead of carrying its own `a ?? b ?? c`.
 *
 * Only the spelling is decided here. What an empty or absent value means stays with the
 * caller, except for {@link pageDisplayName}, which is the one display-name policy.
 */

/** Anything with an id in either spelling: a page, a block, or a bare reference `{ id }`. */
type WithId = { id?: number; 'db/id'?: number } | null | undefined;

/**
 * The id of an entity or of a reference to one, in either spelling. A zero or missing `id`
 * falls through to `db/id`; LogSeq never issues id 0.
 */
export function entityId(entity: WithId): number | undefined {
  return entity?.id || entity?.['db/id'];
}

/** The id of the page a block sits on. Undefined when the block carries no page. */
export function blockPageId(block: { page?: PageLike }): number | undefined {
  return entityId(block.page);
}

/** The lowercased `:block/name` of a page, `''` when it has none. */
export function pageName(page: PageLike | null | undefined): string {
  return String(page?.name ?? '').toLowerCase();
}

/** The original-case name as the page carries it, in either spelling. Empty counts as missing. */
export function originalNameOf(page: PageLike | null | undefined): string | undefined {
  return page?.originalName || page?.['original-name'];
}

/**
 * The name to show for a page: its original-case name, else its `:block/name`, else `''`.
 * An empty original name counts as missing, so a page never shows as blank while it has a name.
 */
export function pageDisplayName(page: PageLike | null | undefined): string {
  return originalNameOf(page) || page?.name || '';
}

/**
 * The page's journal flag as LogSeq set it, in either spelling. Undefined when it says
 * nothing. Callers decide how strict to be: `=== true`, or any truthy value.
 */
export function journalFlag(page: PageLike | null | undefined): boolean | undefined {
  return page?.['journal?'] ?? page?.journal;
}

/** The `YYYYMMDD` journal day of a page, in either spelling. Undefined for a page that has none. */
export function journalDayOf(page: PageLike | null | undefined): number | undefined {
  return page?.journalDay ?? page?.['journal-day'];
}
