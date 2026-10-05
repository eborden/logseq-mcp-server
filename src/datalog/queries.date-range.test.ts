import { describe, it, expect } from 'vitest';
import { DatalogQueryBuilder } from './queries.js';

describe('DatalogQueryBuilder journal range queries', () => {
  const builders = [
    ['getJournalPagesInRange', DatalogQueryBuilder.getJournalPagesInRange],
    ['getJournalBlocksInRange', DatalogQueryBuilder.getJournalBlocksInRange]
  ] as const;

  describe.each(builders)('%s', (_name, build) => {
    it('bounds :block/journal-day with the start and end inputs', () => {
      const { query, inputs } = build(20250101, 20250131);

      expect(query).toContain(':in $ ?start ?end');
      expect(query).toContain('[?page :block/name]');
      expect(query).toContain('[?page :block/journal-day ?day]');
      expect(query).toContain('[(>= ?day ?start)]');
      expect(query).toContain('[(<= ?day ?end)]');
      expect(inputs).toEqual([20250101, 20250131]);
    });

    it('does not embed the bounds in the query text', () => {
      const { query } = build(20250101, 20250131);

      expect(query).not.toContain('20250101');
      expect(query).not.toContain('20250131');
    });

    it.each([NaN, Infinity, 20250101.5, '20250101' as any, null as any])(
      'rejects a non-integer bound (%s)',
      (bad) => {
        expect(() => build(bad, 20250131)).toThrow(/Invalid journal start date/);
        expect(() => build(20250101, bad)).toThrow(/Invalid journal end date/);
      }
    );
  });

  it('getJournalPagesInRange pulls pages', () => {
    expect(DatalogQueryBuilder.getJournalPagesInRange(20250101, 20250102).query)
      .toContain('(pull ?page [*])');
  });

  it('getJournalBlocksInRange pulls blocks on those pages', () => {
    const { query } = DatalogQueryBuilder.getJournalBlocksInRange(20250101, 20250102);

    expect(query).toContain('(pull ?block [*');
    expect(query).toContain('[?block :block/page ?page]');
  });
});

describe('DatalogQueryBuilder.getJournalBlocksInRange refs', () => {
  it('pulls the referenced pages (id, names, journal markers) in the same query', () => {
    const { query } = DatalogQueryBuilder.getJournalBlocksInRange(20250101, 20250102);

    expect(query).toContain('{:block/refs [:db/id :block/name :block/original-name :block/journal? :block/journal-day]}');
  });
});

describe('DatalogQueryBuilder.getJournalPagesUpTo', () => {
  it('bounds :block/journal-day above with an :in input and requires a page name', () => {
    const { query, inputs } = DatalogQueryBuilder.getJournalPagesUpTo(20250131);

    expect(query).toContain(':in $ ?latest');
    expect(query).toContain('[?page :block/name]');
    expect(query).toContain('[?page :block/journal-day ?day]');
    expect(query).toContain('[(<= ?day ?latest)]');
    expect(inputs).toEqual([20250131]);
  });

  it('pulls only identifying attributes, not the whole page', () => {
    const { query } = DatalogQueryBuilder.getJournalPagesUpTo(20250131);

    expect(query).toContain(':block/journal-day :block/journal?');
    expect(query).not.toContain('[*]');
  });

  it('does not embed the bound in the query text', () => {
    expect(DatalogQueryBuilder.getJournalPagesUpTo(20250131).query).not.toContain('20250131');
  });

  it.each([NaN, Infinity, 20250101.5, '20250101' as any, null as any])(
    'rejects a non-integer bound (%s)',
    (bad) => {
      expect(() => DatalogQueryBuilder.getJournalPagesUpTo(bad)).toThrow(/Invalid journal latest date/);
    }
  );
});
