import { describe, it, expect } from 'vitest';
import { buildBlockTrees, camelizeKeys } from './block-tree.js';

const b = (id: number, pageId: number, parentId: number, leftId: number, content = `b${id}`) => ({
  id,
  content,
  page: { id: pageId },
  parent: { id: parentId },
  left: { id: leftId }
});

describe('camelizeKeys', () => {
  it('converts dashed top-level keys and leaves others alone', () => {
    const out = camelizeKeys({ 'journal-day': 1, 'original-name': 'x', 'journal?': true, name: 'n', properties: { 'a-b': 1 } });
    expect(out).toEqual({ journalDay: 1, originalName: 'x', 'journal?': true, name: 'n', properties: { 'a-b': 1 } });
  });
});

describe('buildBlockTrees', () => {
  it('returns an empty list for pages without blocks', () => {
    const trees = buildBlockTrees([], [1, 2]);
    expect(trees.get(1)).toEqual([]);
    expect(trees.get(2)).toEqual([]);
  });

  it('nests children, assigns levels and orders by the left chain', () => {
    const trees = buildBlockTrees(
      [b(3, 1, 1, 2), b(2, 1, 1, 1), b(5, 1, 2, 4), b(4, 1, 2, 2), b(6, 1, 4, 4)],
      [1]
    );

    const roots = trees.get(1)!;
    expect(roots.map(r => r.id)).toEqual([2, 3]);
    expect(roots[0].children.map(c => c.id)).toEqual([4, 5]);
    expect(roots[0].children[0].children.map(c => c.id)).toEqual([6]);
    expect(roots[1].children).toEqual([]);
    expect([roots[0].level, roots[0].children[0].level, roots[0].children[0].children[0].level]).toEqual([1, 2, 3]);
  });

  it('keeps pages separate', () => {
    const trees = buildBlockTrees([b(2, 1, 1, 1), b(3, 10, 10, 10)], [1, 10]);
    expect(trees.get(1)!.map(r => r.id)).toEqual([2]);
    expect(trees.get(10)!.map(r => r.id)).toEqual([3]);
  });

  it('does not drop blocks with a broken left chain or a missing parent', () => {
    const trees = buildBlockTrees([b(2, 1, 1, 99), b(3, 1, 1, 98), b(4, 1, 77, 77)], [1]);
    expect(trees.get(1)!.map(r => r.id).sort()).toEqual([2, 3, 4]);
  });

  it('terminates on a left-chain cycle', () => {
    const trees = buildBlockTrees([b(2, 1, 1, 3), b(3, 1, 1, 2)], [1]);
    expect(trees.get(1)!.map(r => r.id).sort()).toEqual([2, 3]);
  });

  it('camelizes property names the way the Editor API does', () => {
    const trees = buildBlockTrees(
      [{
        ...b(2, 1, 1, 1),
        properties: { 'my-prop': 'a', plain: 'b' },
        'properties-text-values': { 'my-prop': 'a' },
        'properties-order': ['my-prop', 'plain']
      }],
      [1]
    );
    expect(trees.get(1)![0]).toMatchObject({
      properties: { myProp: 'a', plain: 'b' },
      propertiesTextValues: { myProp: 'a' },
      propertiesOrder: ['myProp', 'plain']
    });
  });

  it('camelizes block keys', () => {
    const trees = buildBlockTrees([{ ...b(2, 1, 1, 1), 'path-refs': [{ id: 1 }] }], [1]);
    expect(trees.get(1)![0]).toMatchObject({ pathRefs: [{ id: 1 }] });
  });
});
