import { describe, it, expect } from 'vitest';
import { DatalogQueryBuilder } from './queries.js';

describe('DatalogQueryBuilder', () => {
  // Names that would break a query if they were embedded in its text
  const hostileNames: Array<[string, string]> = [
    ['a double quote', 'foo "bar'],
    ['a backslash', 'a\\b'],
    ['a newline', 'line1\nline2'],
    ['a closing bracket', 'x"]] [?p :block/name']
  ];

  describe('conceptNetwork', () => {
    it('passes the lowercased name as an input and keeps it out of the query text', () => {
      const { query, inputs } = DatalogQueryBuilder.conceptNetwork('Machine Learning', 2);

      expect(query).toContain(':find');
      expect(query).toContain(':in $ ?root-name');
      expect(query).not.toContain('Machine');
      expect(query).not.toContain('machine');
      expect(inputs).toEqual(['machine learning']);
    });

    it('should generate depth=0 query that returns only root', () => {
      const { query, inputs } = DatalogQueryBuilder.conceptNetwork('Testing', 0);

      expect(query).toContain(':find (pull ?p [*])');
      expect(query).toContain('[?p :block/name ?root-name]');
      expect(query).not.toContain('?connected'); // No connections at depth 0
      expect(inputs).toEqual(['testing']);
    });

    it('should generate depth>0 query with connections', () => {
      const { query, inputs } = DatalogQueryBuilder.conceptNetwork('Testing', 1);

      expect(query).toContain('?connected'); // Has connections
      expect(query).toContain('or-join'); // Uses or-join for optional connections
      expect(inputs).toEqual(['testing']);
    });

    it.each(hostileNames)('keeps %s out of the query text', (_label, name) => {
      for (const depth of [0, 1]) {
        const { query, inputs } = DatalogQueryBuilder.conceptNetwork(name, depth);
        expect(inputs).toEqual([name.toLowerCase()]);
        expect(query).not.toContain(name.toLowerCase());
      }
    });
  });

  describe('getPage', () => {
    it('passes the lowercased name as an input', () => {
      const { query, inputs } = DatalogQueryBuilder.getPage('Alice');

      expect(query).toContain(':in $ ?page-name');
      expect(query).toContain('[?page :block/name ?page-name]');
      expect(inputs).toEqual(['alice']);
    });

    it.each(hostileNames)('keeps %s out of the query text', (_label, name) => {
      const { query, inputs } = DatalogQueryBuilder.getPage(name);
      expect(inputs).toEqual([name.toLowerCase()]);
      expect(query).not.toContain(name.toLowerCase());
    });
  });

  describe('getPageBlocks', () => {
    it('passes the lowercased name as an input', () => {
      const { query, inputs } = DatalogQueryBuilder.getPageBlocks('Alice');

      expect(query).toContain(':in $ ?page-name');
      expect(query).toContain('[?block :block/page ?page]');
      expect(inputs).toEqual(['alice']);
    });

    it.each(hostileNames)('keeps %s out of the query text', (_label, name) => {
      const { query, inputs } = DatalogQueryBuilder.getPageBlocks(name);
      expect(inputs).toEqual([name.toLowerCase()]);
      expect(query).not.toContain(name.toLowerCase());
    });
  });

  describe('getBlocksReferencingPage', () => {
    it('passes the lowercased name as an input and pulls the nested page', () => {
      const { query, inputs } = DatalogQueryBuilder.getBlocksReferencingPage('Alice');

      expect(query).toContain(':in $ ?page-name');
      expect(query).toContain('[?block :block/refs ?page]');
      expect(query).toContain('{:block/page [*]}');
      expect(inputs).toEqual(['alice']);
    });

    it.each(hostileNames)('keeps %s out of the query text', (_label, name) => {
      const { query, inputs } = DatalogQueryBuilder.getBlocksReferencingPage(name);
      expect(inputs).toEqual([name.toLowerCase()]);
      expect(query).not.toContain(name.toLowerCase());
    });
  });

  describe('groundIds', () => {
    it('builds a ground clause for integer ids', () => {
      expect(DatalogQueryBuilder.groundIds([1, 22, 333])).toBe('[(ground [1 22 333]) [?id ...]]');
    });

    it('accepts a custom variable', () => {
      expect(DatalogQueryBuilder.groundIds([7], '?source-id')).toBe('[(ground [7]) [?source-id ...]]');
    });

    it('handles an empty list', () => {
      expect(DatalogQueryBuilder.groundIds([])).toBe('[(ground []) [?id ...]]');
    });

    it.each([
      ['a fraction', 1.5],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['a numeric string', '12' as unknown as number],
      ['an injection attempt', '1]) (foo' as unknown as number],
      ['null', null as unknown as number],
      ['undefined', undefined as unknown as number]
    ])('throws on %s', (_label, bad) => {
      expect(() => DatalogQueryBuilder.groundIds([1, bad])).toThrow(/Invalid entity id/);
    });
  });

  describe('buildContext', () => {
    it('should generate context building query with the lowercased name as an input', () => {
      const { query, inputs } = DatalogQueryBuilder.buildContext('TypeScript', {
        maxBlocks: 50,
        maxRelatedPages: 10,
        maxReferences: 20
      });

      expect(query).toContain(':find');
      expect(query).toContain(':where');
      expect(inputs).toEqual(['typescript']);
    });

    it('should handle default limits', () => {
      const { query, inputs } = DatalogQueryBuilder.buildContext('React', {});

      expect(query).toContain(':find');
      expect(inputs).toEqual(['react']);
    });
  });

  describe('searchByRelationship', () => {
    it('should generate relationship query for references type', () => {
      const query = DatalogQueryBuilder.searchByRelationship('React', 'Testing', 'references');

      expect(query).toContain(':find');
      expect(query).toContain(':where');
      expect(query).toContain('?topic-a');
      expect(query).toContain('?topic-b');
    });

    it('should handle different relationship types', () => {
      const query1 = DatalogQueryBuilder.searchByRelationship('A', 'B', 'references');
      const query2 = DatalogQueryBuilder.searchByRelationship('A', 'B', 'referenced-by');

      expect(query1).toBeTruthy();
      expect(query2).toBeTruthy();
      expect(query1).not.toEqual(query2);
    });
  });
});
