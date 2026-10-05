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

    expect(query).toContain('(pull ?block [*])');
    expect(query).toContain('[?block :block/page ?page]');
  });
});
