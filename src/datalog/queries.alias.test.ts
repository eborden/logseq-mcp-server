import { describe, it, expect } from 'vitest';
import { ALIAS_MAX_HOPS, DatalogQueryBuilder } from './queries.js';

describe('DatalogQueryBuilder alias sets (#69)', () => {
  describe('aliasSets', () => {
    it('binds the ids with groundIds and follows :block/alias in both directions', () => {
      const { query, inputs } = DatalogQueryBuilder.aliasSets([12, 34]);

      expect(inputs).toEqual([]);
      expect(query).toContain('[(ground [12 34]) [?start ...]]');
      expect(query).toContain('[?start :block/alias ?m]');
      expect(query).toContain('[?m :block/alias ?start]');
    });

    it(`closes over ${ALIAS_MAX_HOPS} hops: a second link through a middle page`, () => {
      const { query } = DatalogQueryBuilder.aliasSets([1]);

      expect(ALIAS_MAX_HOPS).toBe(2);
      expect(query).toContain('[?start :block/alias ?alias-mid]');
      expect(query).toContain('[?alias-mid :block/alias ?m]');
    });

    it('rejects ids that are not integers and an empty list', () => {
      expect(() => DatalogQueryBuilder.aliasSets([1.5])).toThrow(/Invalid entity id/);
      expect(() => DatalogQueryBuilder.aliasSets(['1 2]' as unknown as number])).toThrow(/Invalid entity id/);
      expect(() => DatalogQueryBuilder.aliasSets([])).toThrow(/at least one/);
    });
  });

  describe('linkedReferencesOfPages', () => {
    it('matches path-refs against any page of the group and skips blocks on those pages', () => {
      const { query, inputs } = DatalogQueryBuilder.linkedReferencesOfPages([3, 4]);

      expect(inputs).toEqual([]);
      expect(query).toContain('[(ground [3 4]) [?p ...]]');
      expect(query).toContain('[?block :block/path-refs ?p]');
      expect(query).toContain('(not [(ground [3 4]) [?source ...]])');
    });

    it('rejects an empty list and ids that are not integers', () => {
      expect(() => DatalogQueryBuilder.linkedReferencesOfPages([])).toThrow(/at least one/);
      expect(() => DatalogQueryBuilder.linkedReferencesOfPages([NaN])).toThrow(/Invalid entity id/);
    });
  });

  describe('getBlocksReferencingPages', () => {
    it('matches refs against every id of the group with a plain ground binding', () => {
      const { query, inputs } = DatalogQueryBuilder.getBlocksReferencingPages([3, 4]);

      expect(inputs).toEqual([]);
      expect(query).toContain('[(ground [3 4]) [?ref ...]]');
      expect(query).toContain('[?block :block/refs ?ref]');
      expect(query).not.toContain('or-join'); // one branch only
    });

    it('adds the blocks of the listed pages as a second branch of one or-join', () => {
      const { query } = DatalogQueryBuilder.getBlocksReferencingPages([3, 4], [4]);

      expect(query).toContain('(or-join [?block]');
      expect(query).toContain('[(ground [4]) [?own ...]]');
      expect(query).toContain('[?block :block/page ?own]');
    });

    it('rejects an empty list and ids that are not integers', () => {
      expect(() => DatalogQueryBuilder.getBlocksReferencingPages([])).toThrow(/at least one/);
      expect(() => DatalogQueryBuilder.getBlocksReferencingPages([1], [Infinity])).toThrow(/Invalid entity id/);
    });
  });

  describe('getBlocksOnPages', () => {
    it('binds the page ids straight to ?page and takes the blocks on them', () => {
      const { query, inputs } = DatalogQueryBuilder.getBlocksOnPages([5, 6]);

      expect(inputs).toEqual([]);
      expect(query).toContain('[(ground [5 6]) [?page ...]]');
      expect(query).toContain('[?block :block/page ?page]');
      expect(() => DatalogQueryBuilder.getBlocksOnPages([])).toThrow(/at least one/);
    });
  });

  describe('aliasSetByName', () => {
    it('passes the lowercased name as an input and keeps it out of the query text', () => {
      const { query, inputs } = DatalogQueryBuilder.aliasSetByName('Jordan "JR" Rivera');

      expect(inputs).toEqual(['jordan "jr" rivera']);
      expect(query).not.toContain('jordan');
      expect(query).toContain(':in $ ?page-name');
      expect(query).toContain('[?s :block/name ?page-name]');
    });
  });
});
