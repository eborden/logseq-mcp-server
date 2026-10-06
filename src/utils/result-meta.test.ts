import { describe, it, expect } from 'vitest';
import { buildResultMeta, CappedTruncation, cappedTruncationWarning, metaContent, truncationWarning } from './result-meta.js';

describe('buildResultMeta', () => {
  it('has no more results when there are no warnings', () => {
    expect(buildResultMeta([])).toEqual({ hasMore: false, warnings: [] });
  });

  it('includes totals when given', () => {
    expect(buildResultMeta([], { blocks: 3 }).totals).toEqual({ blocks: 3 });
  });

  it('reports hasMore only for a warning that says how to continue', () => {
    const w = truncationWarning('blocks', 5, 9, 'limit');
    expect(buildResultMeta([w]).hasMore).toBe(true);
    expect(buildResultMeta([{ code: 'note', message: 'fyi' }]).hasMore).toBe(false);
  });
});

describe('truncationWarning', () => {
  it('names the parameter and a suggested value', () => {
    expect(truncationWarning('blocks', 5, 9, 'limit')).toEqual({
      code: 'results_truncated',
      message: 'Showing 5 of 9 blocks.',
      howToFetchAll: 'Set limit to 9 (or higher) to get all 9.'
    });
  });
});

describe('cappedTruncationWarning (#61)', () => {
  const narrower = 'Narrow the query to see them.';
  const cut = (shown: number, total: number, extra: Partial<CappedTruncation> = {}) =>
    cappedTruncationWarning({ what: 'blocks', shown, total, param: 'limit', max: 500, narrower, ...extra });

  it('is the plain truncation warning when the total fits under the maximum', () => {
    expect(cut(5, 9)).toEqual(truncationWarning('blocks', 5, 9, 'limit'));
    expect(cut(5, 500)).toEqual(truncationWarning('blocks', 5, 500, 'limit'));
  });

  it('suggests the maximum, never a value past it, when the total is above it', () => {
    const w = cut(100, 2000);
    expect(w).toEqual({
      code: 'results_truncated',
      message: 'Showing 100 of 2000 blocks.',
      howToFetchAll: 'Set limit to 500 (the maximum) to get 500 of 2000. Narrow the query to see them.'
    });
    expect(buildResultMeta([w]).hasMore).toBe(true);
  });

  it('has no howToFetchAll and hasMore false once the maximum is reached', () => {
    const w = cut(500, 2000);
    expect(w).toEqual({
      code: 'results_truncated',
      message:
        "Showing 500 of 2000 blocks: limit is capped at its maximum of 500, so the rest can't be fetched in one call. " +
        'Narrow the query to see them.'
    });
    expect(buildResultMeta([w]).hasMore).toBe(false);
  });

  it('names the requested value when it was above the maximum', () => {
    const w = cut(500, 2000, { requested: 1000 });
    expect(w.message).toContain('limit is capped at its maximum of 500 (1000 was asked for)');
    expect(w.howToFetchAll).toBeUndefined();
  });

  it('does not name the requested value when it was the maximum', () => {
    expect(cut(500, 2000, { requested: 500 }).message).not.toContain('asked for');
  });

  it('keeps a custom code', () => {
    expect(cut(500, 2000, { code: 'blocks_truncated' }).code).toBe('blocks_truncated');
  });

  it('keeps hasMore true at the maximum for a paged tool (next)', () => {
    const w = cut(500, 2000, { requested: 1000, next: 'Set offset to 500 for the next page.' });
    expect(w).toEqual({
      code: 'results_truncated',
      message: 'Showing 500 of 2000 blocks: limit is capped at its maximum of 500 (1000 was asked for).',
      howToFetchAll: 'Set offset to 500 for the next page.'
    });
    expect(buildResultMeta([w]).hasMore).toBe(true);
  });

  it('appends next below the maximum, after the plain truncation advice', () => {
    expect(cut(5, 9, { next: 'Set offset to 5 for the next page.' })).toEqual({
      code: 'results_truncated',
      message: 'Showing 5 of 9 blocks.',
      howToFetchAll: 'Set limit to 9 (or higher) to get all 9. Set offset to 5 for the next page.'
    });
  });

  it('puts next in place of narrower when the total is above the maximum', () => {
    const w = cut(100, 2000, { next: 'Set offset to 100 for the next page.' });
    expect(w).toEqual({
      code: 'results_truncated',
      message: 'Showing 100 of 2000 blocks.',
      howToFetchAll: 'Set limit to 500 (the maximum) to get 500 of 2000. Set offset to 100 for the next page.'
    });
    expect(w.howToFetchAll).not.toContain(narrower);
  });

  it('is unchanged without next in every branch (unpaged callers)', () => {
    expect(cut(5, 9).howToFetchAll).toBe('Set limit to 9 (or higher) to get all 9.');
    expect(cut(100, 2000).howToFetchAll).toBe(
      'Set limit to 500 (the maximum) to get 500 of 2000. Narrow the query to see them.'
    );
    expect(cut(500, 2000).howToFetchAll).toBeUndefined();
  });
});

describe('metaContent', () => {
  it('is empty without meta', () => {
    expect(metaContent(null)).toEqual([]);
  });

  it('wraps meta in a second text block', () => {
    const meta = buildResultMeta([], { matches: 2 });
    const blocks = metaContent(meta);
    expect(blocks).toHaveLength(1);
    expect(JSON.parse(blocks[0].text)).toEqual({ meta });
  });
});
