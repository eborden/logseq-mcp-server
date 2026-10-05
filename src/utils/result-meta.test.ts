import { describe, it, expect } from 'vitest';
import { buildResultMeta, truncationWarning } from './result-meta.js';

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
