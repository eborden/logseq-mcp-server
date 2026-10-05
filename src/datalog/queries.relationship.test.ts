import { describe, it, expect } from 'vitest';
import { DatalogQueryBuilder } from './queries.js';

describe('DatalogQueryBuilder relationship queries', () => {
  describe('blocksOnPageReferencing', () => {
    it('lowercases both names and returns them as :in inputs', () => {
      const { query, inputs } = DatalogQueryBuilder.blocksOnPageReferencing('Project Atlas', 'ALICE');

      expect(inputs).toEqual(['project atlas', 'alice']);
      expect(query).toContain(':in $ ?page-name ?ref-name');
    });

    it('matches on :block/refs rather than block content', () => {
      const { query } = DatalogQueryBuilder.blocksOnPageReferencing('a', 'b');

      expect(query).toContain('[?block :block/refs ?ref]');
      expect(query).toContain('[?ref :block/name ?ref-name]');
      expect(query).not.toContain(':block/content');
      expect(query).not.toContain('includes?');
    });

    it('does not embed the names in the query text', () => {
      const { query } = DatalogQueryBuilder.blocksOnPageReferencing('My "Page"', 'Other');

      expect(query).not.toContain('my "page"');
      expect(query).not.toContain('other');
    });
  });

  describe('blocksReferencingInPagesLinking', () => {
    it('lowercases both topics in order [topicA, topicB]', () => {
      const { query, inputs } = DatalogQueryBuilder.blocksReferencingInPagesLinking('Bob', 'Project ATLAS');

      expect(inputs).toEqual(['bob', 'project atlas']);
      expect(query).toContain(':in $ ?a-name ?b-name');
    });

    it('joins linking blocks and topicA blocks on the same page via :block/refs', () => {
      const { query } = DatalogQueryBuilder.blocksReferencingInPagesLinking('a', 'b');

      expect(query).toContain('[?linker :block/refs ?b]');
      expect(query).toContain('[?linker :block/page ?page]');
      expect(query).toContain('[?block :block/page ?page]');
      expect(query).toContain('[?block :block/refs ?a]');
      expect(query).not.toContain(':block/content');
    });
  });

  describe('neighborPages', () => {
    it('grounds the frontier ids and searches both link directions', () => {
      const { query, inputs } = DatalogQueryBuilder.neighborPages([1, 22, 333]);

      expect(inputs).toEqual([]);
      expect(query).toContain('[(ground [1 22 333]) [?p ...]]');
      expect(query).toContain('[?block :block/page ?p]');
      expect(query).toContain('[?block :block/refs ?neighbor]');
      expect(query).toContain('[?block :block/refs ?p]');
      expect(query).toContain('[?block :block/page ?neighbor]');
    });

    it('rejects ids that are not integers', () => {
      expect(() => DatalogQueryBuilder.neighborPages([1, NaN])).toThrow(/Invalid entity id/);
      expect(() => DatalogQueryBuilder.neighborPages([1.5])).toThrow(/Invalid entity id/);
    });
  });
});
