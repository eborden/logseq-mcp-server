import { describe, it, expect } from 'vitest';
import { DatalogQueryBuilder } from './queries.js';

const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';

describe('DatalogQueryBuilder.groundUuids', () => {
  it('binds #uuid literals, lowercased', () => {
    expect(DatalogQueryBuilder.groundUuids([U1, U2.toUpperCase()], '?u')).toBe(
      `[(ground [#uuid "${U1}" #uuid "${U2}"]) [?u ...]]`
    );
  });

  it.each([
    ['a short string', 'abc'],
    ['an injected quote', `${U1}" #uuid "x`],
    ['trailing text', `${U1} extra`],
    ['a closing bracket', `${U1}])`],
    ['a newline', `${U1}\n`],
    ['non-hex digits', '0000000g-0000-4000-8000-000000000001'],
    ['empty', ''],
    ['a non-string', 42 as any]
  ])('rejects %s', (_label, bad) => {
    expect(() => DatalogQueryBuilder.groundUuids([bad as string])).toThrow(/Invalid block uuid/);
  });
});

describe('DatalogQueryBuilder.refTargets', () => {
  it('fetches block uuids with one clause and no inputs', () => {
    const { query, inputs } = DatalogQueryBuilder.refTargets({ blockUuids: [U1, U2] });
    expect(inputs).toEqual([]);
    expect(query).toContain(`#uuid "${U1}" #uuid "${U2}"`);
    expect(query).toContain('[?e :block/uuid ?u]');
    expect(query).not.toContain(':in');
    expect(query).not.toContain(':block/name ?n');
  });

  it('adds the descendants branch for embedded blocks', () => {
    const { query } = DatalogQueryBuilder.refTargets({ blockUuids: [U1], descendantUuids: [U1] });
    expect(query).toContain('[?r :block/uuid ?ru]');
    expect(query).toContain('[?e :block/parent ?r]');
    expect((query.match(/\(or-join/g) ?? []).length).toBe(2);
  });

  it('binds lowercased page names through :in, never into the query text', () => {
    const { query, inputs } = DatalogQueryBuilder.refTargets({ pageNames: ['My "Page"', 'Other'] });
    expect(inputs).toEqual([['my "page"', 'other']]);
    expect(query).toContain(':in $ [?n ...]');
    expect(query).toContain('(or-join [?e ?n]');
    expect(query).not.toContain('my "page"');
  });

  it('rejects a malformed uuid before building any text', () => {
    expect(() => DatalogQueryBuilder.refTargets({ blockUuids: ['nope'] })).toThrow(/Invalid block uuid/);
    expect(() => DatalogQueryBuilder.refTargets({ descendantUuids: ['nope'] })).toThrow(/Invalid block uuid/);
  });

  it('needs something to fetch', () => {
    expect(() => DatalogQueryBuilder.refTargets({})).toThrow(/at least one/);
  });
});
