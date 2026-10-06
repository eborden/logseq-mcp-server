import { BlockEntity } from '../types.js';

const camelize = (key: string): string =>
  key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Convert the top-level kebab-case keys of a Datalog pull result to the
 * camelCase keys the `logseq.Editor.*` API returns (`journal-day` becomes
 * `journalDay`, `path-refs` becomes `pathRefs`). Keys without a dash, such as
 * `journal?`, are left alone. Nested values (e.g. `properties`) are untouched.
 * @param entity - A pulled page or block
 * @returns A shallow copy with camelCase keys
 */
export function camelizeKeys<T = any>(entity: Record<string, any>): T {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(entity)) {
    out[camelize(key)] = value;
  }
  return out as T;
}

/**
 * Camelize a pulled block the way the Editor API does: its top-level keys, plus
 * the property names inside `properties`, `propertiesTextValues` and
 * `propertiesOrder` (Datalog has `logseq.order-list-type`, the Editor API
 * `logseq.orderListType`).
 */
export function camelizeBlock(block: Record<string, any>): BlockEntity {
  const out = camelizeKeys<Record<string, any>>(block);
  for (const key of ['properties', 'propertiesTextValues']) {
    const value = out[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = camelizeKeys(value);
    }
  }
  if (Array.isArray(out.propertiesOrder)) {
    out.propertiesOrder = out.propertiesOrder.map((k: unknown) =>
      typeof k === 'string' ? camelize(k) : k
    );
  }
  return out as BlockEntity;
}

/**
 * Order siblings by following the `:block/left` chain.
 *
 * The first sibling's `left` is the parent (or the page), which is not itself
 * a sibling, so it is the head of the chain; each following sibling's `left`
 * is the previous one. Blocks the chain can't reach (a corrupt graph) are
 * appended in id order so nothing is dropped.
 */
export function orderSiblings<T extends BlockEntity>(siblings: T[]): T[] {
  if (siblings.length < 2) return siblings;

  const ids = new Set(siblings.map(s => s.id));
  const byLeft = new Map<number, T>();
  const heads: T[] = [];
  for (const sibling of siblings) {
    const leftId = sibling.left?.id;
    if (leftId === undefined || !ids.has(leftId)) {
      heads.push(sibling);
    } else if (!byLeft.has(leftId)) {
      byLeft.set(leftId, sibling);
    }
  }

  const ordered: T[] = [];
  const seen = new Set<number>();
  for (const head of heads.sort((a, b) => a.id - b.id)) {
    let current: T | undefined = head;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      ordered.push(current);
      current = byLeft.get(current.id);
    }
  }
  for (const sibling of [...siblings].sort((a, b) => a.id - b.id)) {
    if (!seen.has(sibling.id)) ordered.push(sibling);
  }
  return ordered;
}

/**
 * A block in a rebuilt tree: `children` (empty for a leaf) and the 1-based `level`
 * are always set, unlike on a `BlockEntity`, where both are optional because a
 * flat pull has neither. Assignable to `BlockEntity`.
 */
export type BlockNode = BlockEntity & {
  level: number;
  children: BlockNode[];
};

/** A block that has its `children` array but is not yet placed in a tree, so has no `level`. */
type UnplacedNode = BlockEntity & { children: BlockNode[] };

/**
 * Rebuild `getPageBlocksTree`-shaped trees from flat Datalog blocks.
 *
 * Mirrors the Editor API output: camelCase keys, a `children` array on every
 * block (empty for leaves), and a 1-based `level`. Siblings are ordered by the
 * `:block/left` chain. A block whose parent is not in `blocks` and is not a
 * page in `pageIds` is treated as a root so it is not lost.
 *
 * @param blocks - Flat blocks from one or more pages (pulled with `[*]`)
 * @param pageIds - Entity ids of the pages the blocks belong to
 * @returns Map of page id to that page's top-level blocks, in order
 */
export function buildBlockTrees(
  blocks: Array<Record<string, unknown>>,
  pageIds: Iterable<number>
): Map<number, BlockNode[]> {
  const nodes: UnplacedNode[] = blocks.map(b => ({ ...camelizeBlock(b), children: [] }));
  const nodeIds = new Set(nodes.map(n => n.id));

  const childrenOf = new Map<number, UnplacedNode[]>();
  const rootsOf = new Map<number, UnplacedNode[]>();
  for (const id of pageIds) rootsOf.set(id, []);

  for (const node of nodes) {
    const parentId = node.parent?.id;
    if (parentId !== undefined && nodeIds.has(parentId) && parentId !== node.id) {
      const list = childrenOf.get(parentId) ?? [];
      list.push(node);
      childrenOf.set(parentId, list);
    } else {
      const pageId = node.page?.id ?? parentId;
      if (pageId === undefined) continue;
      const list = rootsOf.get(pageId) ?? [];
      list.push(node);
      rootsOf.set(pageId, list);
    }
  }

  // Assigns in place, so `level` is added after `children` and the key order of
  // the output stays what it was before the types were tightened.
  const attach = (siblings: UnplacedNode[], level: number): BlockNode[] =>
    orderSiblings(siblings).map(node =>
      Object.assign(node, { level, children: attach(childrenOf.get(node.id) ?? [], level + 1) })
    );

  const trees = new Map<number, BlockNode[]>();
  for (const [pageId, roots] of rootsOf) {
    trees.set(pageId, attach(roots, 1));
  }
  return trees;
}
