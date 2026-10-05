import { describe, it, expect } from 'vitest';
import { DatalogQueryBuilder } from './queries.js';

describe('DatalogQueryBuilder.connectedPages', () => {
  it('binds the whole frontier straight to ?source with groundIds', () => {
    const { query, inputs } = DatalogQueryBuilder.connectedPages([10, 20, 30]);

    expect(query).toContain('[(ground [10 20 30]) [?source ...]]');
    expect(query).not.toContain(':db/id');
    expect(inputs).toEqual([]);
  });

  it('covers both directions in a single query', () => {
    const { query } = DatalogQueryBuilder.connectedPages([1]);

    expect(query).toContain('or-join');
    expect(query).toContain('[?block :block/page ?source]');
    expect(query).toContain('[?block :block/refs ?connected]');
    expect(query).toContain('[?block :block/refs ?source]');
    expect(query).toContain('[?block :block/page ?connected]');
    expect(query).toContain('[(ground "outbound") ?rel-type]');
    expect(query).toContain('[(ground "inbound") ?rel-type]');
  });

  it('counts blocks per direction and returns scalars instead of pulled entities', () => {
    const { query } = DatalogQueryBuilder.connectedPages([1]);

    expect(query).toContain('(count ?block)');
    expect(query).not.toContain('(pull');
    expect(query).toContain('?journal');
  });

  it('keeps only pages and excludes self-loops', () => {
    const { query } = DatalogQueryBuilder.connectedPages([1]);

    expect(query).toContain('[?connected :block/name ?name]');
    expect(query).toContain('[(not= ?source ?connected)]');
  });

  it('does not use :in or embed any strings', () => {
    const { query } = DatalogQueryBuilder.connectedPages([1]);

    expect(query).not.toContain(':in');
  });

  it.each([
    ['NaN', [NaN]],
    ['Infinity', [Infinity]],
    ['a fraction', [1.5]],
    ['an injection attempt', ['1]) ] [(ground' as unknown as number]]
  ])('rejects %s as a frontier id', (_label, ids) => {
    expect(() => DatalogQueryBuilder.connectedPages(ids)).toThrow(/Invalid entity id/);
  });

  it('rejects an empty frontier', () => {
    expect(() => DatalogQueryBuilder.connectedPages([])).toThrow(/at least one/);
  });
});
