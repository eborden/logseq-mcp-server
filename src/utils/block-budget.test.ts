import { describe, it, expect } from 'vitest';
import { countBlocks, takeBlocks } from './block-budget.js';
import { BlockEntity } from '../types.js';

/** Made-up trees: a block's `content` is its label. */
const b = (content: string, children?: BlockEntity[]) =>
  ({ id: 1, content, ...(children ? { children } : {}) }) as unknown as BlockEntity;

const tree = () => [
  b('a', [b('a1', [b('a1x')]), b('a2')]),
  b('b'),
  b('c', [b('c1')])
];

const labels = (blocks: BlockEntity[]): string[] =>
  blocks.flatMap(block => [block.content, ...labels(block.children ?? [])]);

describe('countBlocks', () => {
  it('counts nested blocks too', () => {
    expect(countBlocks(tree())).toBe(7);
    expect(countBlocks([])).toBe(0);
  });
});

describe('takeBlocks', () => {
  it('keeps the first blocks in document order and marks a block that lost children', () => {
    const budget = { room: 3, partial: false };
    const kept = takeBlocks(tree(), budget);

    expect(labels(kept)).toEqual(['a', 'a1', 'a1x']);
    expect(budget).toEqual({ room: 0, partial: true });
    expect(kept[0].childrenTruncated).toBe(true);
    // a1 kept all of its children, so it is not marked
    expect(kept[0].children![0].childrenTruncated).toBeUndefined();
  });

  it('leaves a block whole, unmarked, when its children all fit', () => {
    const budget = { room: 4, partial: false };
    const kept = takeBlocks(tree(), budget);

    expect(labels(kept)).toEqual(['a', 'a1', 'a1x', 'a2']);
    expect(budget.partial).toBe(false);
    expect(JSON.stringify(kept)).not.toContain('childrenTruncated');
  });

  it('keeps a block with no children of its own when the budget runs out after it, unmarked', () => {
    const kept = takeBlocks([b('a'), b('b')], { room: 1, partial: false });

    expect(kept).toEqual([b('a')]);
  });

  it('continues in document order when called again with the same budget', () => {
    const budget = { room: 6, partial: false };
    const first = takeBlocks([b('a', [b('a1')]), b('b')], budget);
    const second = takeBlocks([b('c', [b('c1'), b('c2'), b('c3')])], budget);

    expect(labels(first)).toEqual(['a', 'a1', 'b']);
    expect(labels(second)).toEqual(['c', 'c1', 'c2']);
    expect(second[0].childrenTruncated).toBe(true);
  });

  it('keeps nothing from a spent budget', () => {
    expect(takeBlocks(tree(), { room: 0, partial: false })).toEqual([]);
  });
});
