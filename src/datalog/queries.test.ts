import { describe, it, expect } from 'vitest';
import { DatalogQueryBuilder } from './queries.js';

describe('DatalogQueryBuilder', () => {
  describe('conceptNetwork', () => {
    it('should generate basic concept network query with parameter', () => {
      const query = DatalogQueryBuilder.conceptNetwork('Machine Learning', 2);

      expect(query).toContain(':find');
      expect(query).toContain(':where');
      expect(query).toContain(':in $ ?root-name-lower'); // Uses lowercased parameter
    });

    it('should generate depth=0 query that returns only root', () => {
      const query = DatalogQueryBuilder.conceptNetwork('Testing', 0);

      expect(query).toContain(':find (pull ?p [*])');
      expect(query).toContain(':in $ ?root-name-lower'); // Uses lowercased parameter
      expect(query).not.toContain('?connected'); // No connections at depth 0
    });

    it('should generate depth>0 query with connections', () => {
      const query = DatalogQueryBuilder.conceptNetwork('Testing', 1);

      expect(query).toContain('?connected'); // Has connections
      expect(query).toContain('or-join'); // Uses or-join for optional connections
    });
  });

  describe('getConnectedPages', () => {
    it('should generate query for single page ID', () => {
      const query = DatalogQueryBuilder.getConnectedPages([123]);

      expect(query).toContain(':find');
      expect(query).toContain(':where');
      expect(query).toContain('123'); // Contains the ID
    });

    it('should generate query for multiple page IDs', () => {
      const query = DatalogQueryBuilder.getConnectedPages([123, 456, 789]);

      expect(query).toContain('123');
      expect(query).toContain('456');
      expect(query).toContain('789');
    });

    it('should find outbound and inbound connections', () => {
      const query = DatalogQueryBuilder.getConnectedPages([100]);

      expect(query).toContain('?connected'); // Finds connected pages
      expect(query).toContain('?rel-type'); // Returns relationship type
    });
  });

  describe('buildContext', () => {
    it('should generate context building query with parameter', () => {
      const query = DatalogQueryBuilder.buildContext('TypeScript', {
        maxBlocks: 50,
        maxRelatedPages: 10,
        maxReferences: 20
      });

      expect(query).toContain(':find');
      expect(query).toContain(':where');
      expect(query).toContain(':in $ ?page-name-lower'); // Uses lowercased parameter
    });

    it('should handle default limits', () => {
      const query = DatalogQueryBuilder.buildContext('React', {});

      expect(query).toContain(':find');
      expect(query).toContain(':in $ ?page-name-lower'); // Uses lowercased parameter
      expect(query).toBeTruthy();
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
