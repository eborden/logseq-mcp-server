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
