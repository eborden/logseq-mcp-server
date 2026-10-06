import { describe, it, expect } from 'vitest';
import { DatalogQueryBuilder } from './queries.js';

describe('DatalogQueryBuilder.linkTargets (#146)', () => {
  it('matches every name and its aliases in one query, the lowercased names as one collection input', () => {
    const { query, inputs } = DatalogQueryBuilder.linkTargets(['Alice', 'Project Atlas']);

    expect(query).toContain(':in $ [?n ...]');
    expect(query).toContain('[?page :block/name ?n] [(ground "name") ?via]');
    expect(query).toContain('[?stub :block/name ?n] [?page :block/alias ?stub] [(ground "alias") ?via]');
    // The name comes back with each row, and the file tells a stub from a written page
    expect(query).toContain('?via ?n');
    expect(query).toContain(':block/file');
    // Links resolve by name or alias only: no journal-date or namespace-leaf route
    expect(query).not.toContain('journal-day');
    expect(query).not.toContain('ends-with?');
    expect(inputs).toEqual([['alice', 'project atlas']]);
  });

  it.each([
    ['a double quote', 'foo "bar'],
    ['a backslash', 'a\\b'],
    ['a closing bracket', 'x"]] [?p :block/name'],
  ])('keeps %s out of the query text', (_label, name) => {
    const { query, inputs } = DatalogQueryBuilder.linkTargets([name]);
    expect(inputs).toEqual([[name.toLowerCase()]]);
    expect(query).not.toContain(name.toLowerCase());
  });

  it('refuses an empty list rather than build a query that matches nothing', () => {
    expect(() => DatalogQueryBuilder.linkTargets([])).toThrow(/at least one page name/);
  });
});
