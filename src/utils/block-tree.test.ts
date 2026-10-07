import { describe, it, expect } from 'vitest';
import { buildBlockTrees, camelizeBlock, camelizeKeys, orderSiblings } from './block-tree.js';

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

describe('camelizeBlock', () => {
  // The result is typed as a BlockEntity, which does not name every key a pull can carry
  const camelized = (block: object): Record<string, unknown> => ({ ...camelizeBlock(block) });

  it('leaves a properties value alone unless it is a plain map', () => {
    for (const odd of ['role:: designer', 7, true, null, ['my-prop']]) {
      const out = camelized({ id: 2, properties: odd, 'properties-text-values': odd });

      expect(out.properties, JSON.stringify(odd)).toEqual(odd);
      expect(out.propertiesTextValues, JSON.stringify(odd)).toEqual(odd);
    }
  });

  it('camelizes the keys of both property maps, and only those two', () => {
    const out = camelized({
      id: 2,
      properties: { 'my-prop': 'a' },
      'properties-text-values': { 'my-text': 'b' },
      'other-map': { 'my-key': 'c' }
    });

    expect(out.properties).toEqual({ myProp: 'a' });
    expect(out.propertiesTextValues).toEqual({ myText: 'b' });
    expect(out.otherMap).toEqual({ 'my-key': 'c' });
  });

  it('camelizes the names in properties-order and leaves an entry that is not text', () => {
    const out = camelized({ id: 2, 'properties-order': ['my-prop', 7, null, 'plain'] });

    expect(out.propertiesOrder).toEqual(['myProp', 7, null, 'plain']);
  });

  it('leaves properties-order alone when it is not a list', () => {
    expect(camelized({ id: 2, 'properties-order': 'my-prop' }).propertiesOrder).toBe('my-prop');
    expect(camelized({ id: 2 })).not.toHaveProperty('propertiesOrder');
  });
});

describe('orderSiblings', () => {
  it('follows the left chain from the first sibling, whatever order the input is in', () => {
    // 2's left is 1, the parent, which is not a sibling. 5 is left of 3, and 3 is left of 4
    const siblings = [{ id: 4, left: { id: 3 } }, { id: 2, left: { id: 1 } }, { id: 3, left: { id: 5 } }, { id: 5, left: { id: 2 } }];

    expect(orderSiblings(siblings).map(s => s.id)).toEqual([2, 5, 3, 4]);
  });

  it('takes a sibling with no left as the head of the chain', () => {
    // the head has the higher id, so only the head rule puts it first
    const siblings = [{ id: 4, left: { id: 9 } }, { id: 9 }];

    expect(orderSiblings(siblings).map(s => s.id)).toEqual([9, 4]);
  });

  it('outputs a row that comes twice once, with its chain, rather than twice', () => {
    const siblings = [{ id: 2 }, { id: 2 }, { id: 3, left: { id: 2 } }];

    expect(orderSiblings(siblings).map(s => s.id)).toEqual([2, 3]);
  });

  it('takes a sibling whose left is outside the list as a head, even when its id is not the lowest', () => {
    const siblings = [{ id: 2, left: { id: 5 } }, { id: 5, left: { id: 99 } }];

    expect(orderSiblings(siblings).map(s => s.id)).toEqual([5, 2]);
  });

  it('orders several heads by id, each followed by its own chain', () => {
    const siblings = [
      { id: 9, left: { id: 90 } },
      { id: 4, left: { id: 40 } },
      { id: 6, left: { id: 60 } },
      { id: 7, left: { id: 9 } },
      { id: 2, left: { id: 6 } }
    ];

    expect(orderSiblings(siblings).map(s => s.id)).toEqual([4, 6, 2, 9, 7]);
  });

  it('follows the first of two siblings that name the same left and appends the other', () => {
    const siblings = [{ id: 4, left: { id: 2 } }, { id: 3, left: { id: 2 } }, { id: 2 }];

    expect(orderSiblings(siblings).map(s => s.id)).toEqual([2, 4, 3]);
  });

  it('appends blocks the chain cannot reach in id order, after the chain', () => {
    // 9 and 8 point at each other, so neither is a head
    const siblings = [{ id: 9, left: { id: 8 } }, { id: 1 }, { id: 8, left: { id: 9 } }];

    expect(orderSiblings(siblings).map(s => s.id)).toEqual([1, 8, 9]);
  });

  it('puts a cycle of three in id order, since it has no head', () => {
    const siblings = [{ id: 7, left: { id: 5 } }, { id: 3, left: { id: 7 } }, { id: 5, left: { id: 3 } }];

    expect(orderSiblings(siblings).map(s => s.id)).toEqual([3, 5, 7]);
  });

  it('does not reorder or change the list it was given', () => {
    const siblings = [{ id: 9, left: { id: 8 } }, { id: 1 }, { id: 8, left: { id: 9 } }];

    const ordered = orderSiblings(siblings);

    expect(ordered).not.toBe(siblings);
    expect(siblings.map(s => s.id)).toEqual([9, 1, 8]);
  });

  it('returns the same siblings, with the same objects', () => {
    const first = { id: 2 };
    const second = { id: 3, left: { id: 2 } };

    const ordered = orderSiblings([second, first]);

    expect(ordered[0]).toBe(first);
    expect(ordered[1]).toBe(second);
  });

  it('returns an empty list, and a single sibling, as they are', () => {
    expect(orderSiblings([])).toEqual([]);
    expect(orderSiblings([{ id: 3, left: { id: 50 } }])).toEqual([{ id: 3, left: { id: 50 } }]);
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

  it('adds level after children, so the serialized key order is stable', () => {
    const trees = buildBlockTrees([b(2, 1, 1, 1)], [1]);
    const keys = Object.keys(trees.get(1)![0]);
    expect(keys.indexOf('level')).toBeGreaterThan(keys.indexOf('children'));
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

  it('keeps a block that names itself as its parent as a root of its page', () => {
    const trees = buildBlockTrees([b(2, 1, 2, 1)], [1]);

    expect(trees.get(1)!.map(r => r.id)).toEqual([2]);
    expect(trees.get(1)![0].children).toEqual([]);
  });

  it('puts a block with no parent at the root of its page', () => {
    const { parent: _parent, ...noParent } = b(2, 1, 1, 1);

    const trees = buildBlockTrees([noParent], [1]);

    expect(trees.get(1)!.map(r => r.id)).toEqual([2]);
  });

  it('falls back to the parent as the page when a block has no page, and keeps it a root', () => {
    const { page: _page, ...noPage } = b(2, 1, 1, 1);

    const trees = buildBlockTrees([noPage], [1]);

    expect(trees.get(1)!.map(r => r.id)).toEqual([2]);
  });

  it('drops a block that has neither a page nor a parent, adding no page for it', () => {
    const { page: _page, parent: _parent, ...orphan } = b(2, 1, 1, 1);

    const trees = buildBlockTrees([orphan, b(3, 1, 1, 1)], [1]);

    expect([...trees.keys()]).toEqual([1]);
    expect(trees.get(1)!.map(r => r.id)).toEqual([3]);
  });

  it('adds a page that is not in pageIds when a block names it, holding just that block', () => {
    const trees = buildBlockTrees([b(2, 7, 7, 7), b(3, 1, 1, 1)], [1]);

    expect([...trees.keys()].sort()).toEqual([1, 7]);
    expect(trees.get(7)!.map(r => r.id)).toEqual([2]);
    expect(trees.get(1)!.map(r => r.id)).toEqual([3]);
  });

  it('orders roots and children by the left chain when the chain is not in id order', () => {
    const trees = buildBlockTrees(
      [b(2, 1, 1, 9), b(9, 1, 1, 1), b(8, 1, 9, 9), b(3, 1, 9, 8)],
      [1]
    );

    const roots = trees.get(1)!;
    expect(roots.map(r => r.id)).toEqual([9, 2]);
    expect(roots[0].children.map(c => c.id)).toEqual([8, 3]);
  });
});
