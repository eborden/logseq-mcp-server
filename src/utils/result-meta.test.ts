import { describe, it, expect } from 'vitest';
import {
  buildResultMeta,
  CappedTruncation,
  blocksInlineMax,
  cappedTruncationWarning,
  INLINE_ITEMS,
  LARGE_RESULT_NOTE,
  largeResultNote,
  metaContent,
  truncationWarning
} from './result-meta.js';

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

describe('largeResultNote (#196)', () => {
  it('is empty at or below inlineMax and when the caller makes no claim', () => {
    expect(largeResultNote(200, 200)).toBe('');
    expect(largeResultNote(5000)).toBe('');
  });

  it('is the note, after a space, past inlineMax', () => {
    expect(largeResultNote(201, 200)).toBe(` ${LARGE_RESULT_NOTE}`);
  });

  it('says the host may save the result, and names no size', () => {
    expect(LARGE_RESULT_NOTE).toContain('may be saved to a file by the host');
    expect(LARGE_RESULT_NOTE).not.toMatch(/[0-9]/);
  });
});

describe('blocksInlineMax and INLINE_ITEMS (#196)', () => {
  it('is 200 for slim blocks and lower where a hit comes back larger', () => {
    expect(blocksInlineMax()).toBe(INLINE_ITEMS.blocks);
    expect(blocksInlineMax({ context: false, slim: true })).toBe(200);
    expect(blocksInlineMax({ context: true })).toBe(120);
    expect(blocksInlineMax({ slim: false })).toBe(125);
    expect(blocksInlineMax({ context: true, slim: false })).toBe(65);
  });

  it('pins the other estimates', () => {
    expect(INLINE_ITEMS).toEqual({ blocks: 200, references: 150, relatedPages: 500, networkNodes: 200, pages: 800 });
  });
});

describe('truncationWarning inlineMax (#196)', () => {
  it('adds the note only when the total is past inlineMax', () => {
    expect(truncationWarning('blocks', 5, 150, 'limit', 'blocks_truncated', 200).howToFetchAll).toBe(
      'Set limit to 150 (or higher) to get all 150.'
    );
    expect(truncationWarning('blocks', 5, 300, 'limit', 'blocks_truncated', 200).howToFetchAll).toBe(
      `Set limit to 300 (or higher) to get all 300. ${LARGE_RESULT_NOTE}`
    );
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

  const paging = (next: string) => ({ param: 'offset', next });

  it('keeps hasMore true at the maximum for a paged tool, and says the rest can be paged', () => {
    const w = cut(500, 2000, { requested: 1000, paging: paging('Set offset to 500 for the next page.') });
    expect(w).toEqual({
      code: 'results_truncated',
      message:
        'Showing 500 of 2000 blocks: limit is capped at its maximum of 500 (1000 was asked for). ' +
        'Page through the rest with offset.',
      howToFetchAll: 'Set offset to 500 for the next page.'
    });
    expect(buildResultMeta([w]).hasMore).toBe(true);
  });

  it('leads with paging below the maximum, then offers the raise as the alternative', () => {
    expect(cut(5, 9, { paging: paging('Set offset to 5 for the next page.') })).toEqual({
      code: 'results_truncated',
      message: 'Showing 5 of 9 blocks. Page through the rest with offset.',
      howToFetchAll: 'Set offset to 5 for the next page. Or set limit to 9 (or higher) to get all 9 in one call.'
    });
  });

  it('leads with paging in place of narrower when the total is above the maximum', () => {
    const w = cut(100, 2000, { paging: paging('Set offset to 100 for the next page.') });
    expect(w).toEqual({
      code: 'results_truncated',
      message: 'Showing 100 of 2000 blocks. Page through the rest with offset.',
      howToFetchAll:
        'Set offset to 100 for the next page. Or set limit to 500 (the maximum) to get 500 of 2000 in one call.'
    });
    expect(w.howToFetchAll).not.toContain(narrower);
    expect(buildResultMeta([w]).hasMore).toBe(true);
  });

  it('adds the large-result note to a raise past inlineMax, and only to that', () => {
    expect(cut(5, 9, { inlineMax: 200 }).howToFetchAll).toBe('Set limit to 9 (or higher) to get all 9.');
    expect(cut(5, 300, { inlineMax: 200 }).howToFetchAll).toBe(
      `Set limit to 300 (or higher) to get all 300. ${LARGE_RESULT_NOTE}`
    );
    expect(cut(100, 2000, { inlineMax: 200 }).howToFetchAll).toBe(
      `Set limit to 500 (the maximum) to get 500 of 2000. ${LARGE_RESULT_NOTE} ${narrower}`
    );
    // a raise at or below inlineMax, and a cut at the maximum, carry no note
    expect(cut(5, 200, { inlineMax: 200 }).howToFetchAll).toBe('Set limit to 200 (or higher) to get all 200.');
    expect(cut(500, 2000, { inlineMax: 200 }).message).not.toContain('saved to a file');
  });

  it('adds the note to the raise after the paging call, never in place of it', () => {
    const w = cut(100, 2000, { inlineMax: 200, paging: paging('Set offset to 100 for the next page.') });
    expect(w.howToFetchAll).toBe(
      `Set offset to 100 for the next page. Or set limit to 500 (the maximum) to get 500 of 2000 in one call. ${LARGE_RESULT_NOTE}`
    );
    expect(cut(500, 2000, { inlineMax: 200, paging: paging('Set offset to 500 for the next page.') }).howToFetchAll).toBe(
      'Set offset to 500 for the next page.'
    );
  });

  it('is unchanged without paging or inlineMax in every branch (unpaged callers)', () => {
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
