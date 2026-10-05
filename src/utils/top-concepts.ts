import { BlockEntity } from '../types.js';

/** One entry of `summary.topConcepts`. */
export interface TopConcept {
  /** Original-case page name */
  name: string;
  /** Number of returned blocks (nested ones included) that reference the page */
  count: number;
  /** Number of distinct journal days those blocks are on, so `days <= count` */
  days: number;
}

/** A referenced page, as pulled with each journal block (`:block/refs`). */
export interface ConceptRef {
  id: number;
  /** Original-case name */
  name: string;
}

/** Default for `top_concepts_limit`. */
export const DEFAULT_TOP_CONCEPTS_LIMIT = 10;

/**
 * Pages LogSeq itself creates, which would otherwise top every ranking: the task
 * markers (a `TODO` block references the page `todo`) and the flashcard tag.
 * Compared against the lowercase `:block/name`. Journal pages are excluded
 * separately, by their journal markers, not by name.
 */
export const BUILT_IN_CONCEPTS: ReadonlySet<string> = new Set([
  'todo',
  'doing',
  'done',
  'now',
  'later',
  'waiting',
  'canceled',
  'cancelled',
  'in-progress',
  'card',
]);

/**
 * The concept refs of one flat Datalog block (pulled with nested `:block/refs`).
 * Dropped: refs without a name (block refs), journal pages, and
 * {@link BUILT_IN_CONCEPTS}. Each page appears once.
 */
export function extractConceptRefs(block: Record<string, any>): ConceptRef[] {
  const refs: unknown = block.refs;
  if (!Array.isArray(refs)) return [];

  const seen = new Set<number>();
  const out: ConceptRef[] = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') continue;
    const id = ref.id ?? ref['db/id'];
    const lowerName: unknown = ref.name;
    if (typeof id !== 'number' || typeof lowerName !== 'string' || lowerName === '') continue;
    if (ref['journal?'] === true || ref['journal-day'] != null) continue;
    if (BUILT_IN_CONCEPTS.has(lowerName)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const original: unknown = ref['original-name'];
    out.push({ id, name: typeof original === 'string' && original !== '' ? original : lowerName });
  }
  return out;
}

/** Order: count desc, then days desc, then name (case-insensitive, then exact). */
function compareConcepts(a: TopConcept, b: TopConcept): number {
  if (b.count !== a.count) return b.count - a.count;
  if (b.days !== a.days) return b.days - a.days;
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Roll up the concepts referenced by the returned blocks.
 *
 * Counts every block in the trees, children included: `count` is the number of
 * blocks referencing a page, `days` the number of distinct entries (journal days)
 * they sit on. Tags, `[[links]]` and aliases all end up as `:block/refs` of the
 * same page, so they merge on page id with no parsing of content.
 *
 * @param entries - Returned journal days, each with its block trees
 * @param refsByBlock - {@link extractConceptRefs} output keyed by block id
 * @param limit - Keep this many, best first (0 or less keeps none)
 */
export function rollUpTopConcepts(
  entries: Array<{ date: number; blocks: BlockEntity[] }>,
  refsByBlock: ReadonlyMap<number, ConceptRef[]>,
  limit: number
): TopConcept[] {
  if (limit <= 0) return [];

  const tally = new Map<number, { name: string; count: number; days: Set<number> }>();
  const visit = (blocks: BlockEntity[], date: number): void => {
    for (const block of blocks) {
      for (const ref of refsByBlock.get(block.id) ?? []) {
        const slot = tally.get(ref.id) ?? { name: ref.name, count: 0, days: new Set<number>() };
        slot.count += 1;
        slot.days.add(date);
        tally.set(ref.id, slot);
      }
      visit(block.children ?? [], date);
    }
  };
  for (const entry of entries) visit(entry.blocks, entry.date);

  return [...tally.values()]
    .map(({ name, count, days }) => ({ name, count, days: days.size }))
    .sort(compareConcepts)
    .slice(0, limit);
}
