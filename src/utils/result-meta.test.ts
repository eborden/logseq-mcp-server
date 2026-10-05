import { describe, it, expect } from 'vitest';
import { buildResultMeta, metaContent, truncationWarning } from './result-meta.js';

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
