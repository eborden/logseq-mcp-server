import { BlockEntity } from '../types.js';

/**
 * Cutting block trees to a count of blocks, nested ones included (#162, #183). A cap in
 * these units bounds the result however deep the trees run. Shared by `query_by_date_range`
 * (`max_blocks`) and `search_by_relationship` (`limit`, for `connected-within`).
 */

/** Number of blocks in these trees, nested ones included. */
export function countBlocks(blocks: BlockEntity[]): number {
  return blocks.reduce((sum, block) => sum + 1 + countBlocks(block.children ?? []), 0);
}

/** What is left to keep, and whether a kept block lost a child (so it needs `childrenTruncated`). */
export interface Budget {
  room: number;
  partial: boolean;
}

/**
 * The first `budget.room` blocks of these trees in document order: a block, then its
 * children, then its next sibling. What is kept is a valid tree. A kept block whose
 * children don't all fit keeps the first ones that do and gains `childrenTruncated: true`,
 * so it isn't mistaken for a leaf (slim output drops an empty `children`).
 *
 * Spends `budget`, so calling it again with the same budget on the next trees continues
 * in document order: the cut falls where one call over both trees would put it.
 */
export function takeBlocks(blocks: BlockEntity[], budget: Budget): BlockEntity[] {
  const kept: BlockEntity[] = [];
  for (const block of blocks) {
    if (budget.room === 0) break;
    budget.room -= 1;
    const children = block.children ?? [];
    if (children.length === 0) {
      kept.push(block);
      continue;
    }
    const keptChildren = takeBlocks(children, budget);
    const lostChildren = keptChildren.length < children.length;
    if (lostChildren) budget.partial = true;
    kept.push({ ...block, children: keptChildren, ...(lostChildren ? { childrenTruncated: true } : {}) });
  }
  return kept;
}
