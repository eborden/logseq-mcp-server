import { describe, it, expect } from 'vitest';
import { buildTips, MAX_TIPS, pageNameOf, suggestCall } from './tips.js';

/** The JSON arguments of the first suggested call to `tool` found in `tips`. */
function argsOf(tips: string[], tool: string): Record<string, unknown> {
  const tip = tips.find(t => t.includes(`${tool} {`));
  expect(tip, `a tip suggesting ${tool}`).toBeDefined();
  const start = tip!.indexOf(`${tool} {`) + tool.length + 1;
  // The call ends at the last closing brace, before the sentence's final period
  const end = tip!.lastIndexOf('}') + 1;
  return JSON.parse(tip!.slice(start, end));
}

describe('suggestCall', () => {
  it('is the tool name followed by JSON arguments', () => {
    expect(suggestCall('logseq_get_page', { page_name: 'Alice' })).toBe('logseq_get_page {"page_name":"Alice"}');
  });
});

describe('pageNameOf', () => {
  it.each([
    ['slim block', { pageName: 'Alice' }],
    ['search context', { page: { id: 1 }, context: { page: { originalName: 'Alice' } } }],
    ['property result', { page: { id: 1, name: 'alice', originalName: 'Alice' } }],
    ['kebab-case page', { page: { 'original-name': 'Alice' } }],
  ])('reads the name from a %s', (_label, entity) => {
    expect(pageNameOf(entity)).toBe('Alice');
  });

  it('is undefined when only a bare page id is known', () => {
    expect(pageNameOf({ page: { id: 7 } })).toBeUndefined();
    expect(pageNameOf(null)).toBeUndefined();
  });
});

describe('buildTips', () => {
  describe('logseq_search_blocks', () => {
    it('suggests build_context on the page most results are on', () => {
      const result = [{ pageName: 'Bob' }, { pageName: 'Alice' }, { pageName: 'Alice' }];
      const tips = buildTips('logseq_search_blocks', { query: 'x' }, result);
      expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: 'Alice' });
    });

    describe('prefers non-journal pages', () => {
      const journal = { originalName: 'Oct 5th, 2026', isJournal: true, journalDate: 20261005 };
      const topic = { originalName: 'Project Atlas' };

      it('picks the topic page over a journal page that leads (include_context)', () => {
        const result = [
          { context: { page: journal } },
          { context: { page: journal } },
          { context: { page: topic } },
        ];
        const tips = buildTips('logseq_search_blocks', { query: 'x' }, result);
        expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: 'Project Atlas' });
      });

      it('recognises raw page entities flagged with journal?', () => {
        const result = [
          { page: { originalName: 'Oct 5th, 2026', 'journal?': true } },
          { page: { originalName: 'Project Atlas', 'journal?': false } },
        ];
        const tips = buildTips('logseq_search_blocks', { query: 'x' }, result);
        expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: 'Project Atlas' });
      });

      it('ranks tags and page refs when slim hits carry no journal flag', () => {
        const result = [
          { pageName: 'Oct 5th, 2026', tags: ['atlas'], pageRefs: ['Alice'] },
          { pageName: 'Oct 5th, 2026', pageRefs: ['Alice'] },
          { pageName: 'Oct 4th, 2026', tags: ['atlas'], pageRefs: ['Alice'] },
        ];
        const tips = buildTips('logseq_search_blocks', { query: 'x' }, result);
        expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: 'Alice' });
      });

      it('uses the most common page when there is no flag and no tags or refs', () => {
        const result = [{ pageName: 'Bob' }, { pageName: 'Alice' }, { pageName: 'Alice' }];
        const tips = buildTips('logseq_search_blocks', { query: 'x' }, result);
        expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: 'Alice' });
      });

      it('falls back to a journal page only when it is all there is', () => {
        const tips = buildTips('logseq_search_blocks', { query: 'x' }, [{ context: { page: journal } }]);
        expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: 'Oct 5th, 2026' });
      });

      it('applies to query_by_property too', () => {
        const result = [{ page: { ...journal } }, { page: { ...journal } }, { page: { ...topic } }];
        expect(argsOf(buildTips('logseq_query_by_property', {}, result), 'logseq_build_context')).toEqual({
          topic_name: 'Project Atlas',
        });
      });
    });

    it('breaks a tie by first appearance', () => {
      const tips = buildTips('logseq_search_blocks', { query: 'x' }, [{ pageName: 'Bob' }, { pageName: 'Alice' }]);
      expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: 'Bob' });
    });

    it('asks for slim_results when results carry only page ids', () => {
      const tips = buildTips('logseq_search_blocks', { query: 'x' }, [{ page: { id: 1 } }]);
      expect(tips).toHaveLength(1);
      expect(tips[0]).toContain('slim_results: true');
    });

    it('says search is literal on a miss and offers list_pages for the first word', () => {
      const tips = buildTips('logseq_search_blocks', { query: 'project atlas' }, []);
      expect(tips[0]).toContain('literal');
      expect(argsOf(tips, 'logseq_list_pages')).toEqual({ name_contains: 'project' });
    });

    it('gives no miss tip when limit: 0 returns [] although blocks matched', () => {
      const meta = { hasMore: true, warnings: [], totals: { matches: 5 } };
      expect(buildTips('logseq_search_blocks', { query: 'x', limit: 0 }, [], meta)).toEqual([]);
    });

    it('still says "No match" when the meta confirms zero matches', () => {
      const meta = { hasMore: false, warnings: [], totals: { matches: 0 } };
      expect(buildTips('logseq_search_blocks', { query: 'x' }, [], meta)[0]).toContain('No match');
    });

    it('gives no tip for a null result', () => {
      expect(buildTips('logseq_search_blocks', { query: 'x' }, null)).toEqual([]);
    });
  });

  describe('logseq_get_page', () => {
    it('suggests the page blocks and the backlinks', () => {
      const tips = buildTips('logseq_get_page', { page_name: 'alice' }, { originalName: 'Alice' });
      expect(argsOf(tips, 'logseq_get_page')).toEqual({ page_name: 'Alice', include_children: true });
      expect(argsOf(tips, 'logseq_get_backlinks')).toEqual({ page_name: 'Alice' });
    });

    it('skips the blocks tip when children were already requested', () => {
      const tips = buildTips('logseq_get_page', { page_name: 'Alice', include_children: true }, { originalName: 'Alice' });
      expect(tips).toHaveLength(1);
      expect(argsOf(tips, 'logseq_get_backlinks')).toEqual({ page_name: 'Alice' });
    });
  });

  it('logseq_get_backlinks suggests build_context only when there are backlinks', () => {
    expect(argsOf(buildTips('logseq_get_backlinks', { page_name: 'Alice' }, [[{}, []]]), 'logseq_build_context')).toEqual({
      topic_name: 'Alice',
    });
    expect(buildTips('logseq_get_backlinks', { page_name: 'Alice' }, [])).toEqual([]);
    expect(buildTips('logseq_get_backlinks', { page_name: 'Alice' }, null)).toEqual([]);
  });

  it('logseq_query_by_property suggests build_context on the most common page', () => {
    const result = [{ page: { originalName: 'Alice' } }, { page: { originalName: 'Alice' } }];
    expect(argsOf(buildTips('logseq_query_by_property', {}, result), 'logseq_build_context')).toEqual({
      topic_name: 'Alice',
    });
    expect(buildTips('logseq_query_by_property', {}, [])).toEqual([]);
  });

  it('logseq_query_by_date_range suggests build_context on the top concept, if any', () => {
    const result = { summary: { topConcepts: [{ name: 'Project Atlas', count: 3, days: 2 }] } };
    expect(argsOf(buildTips('logseq_query_by_date_range', {}, result), 'logseq_build_context')).toEqual({
      topic_name: 'Project Atlas',
    });
    expect(buildTips('logseq_query_by_date_range', {}, { summary: {} })).toEqual([]);
    expect(buildTips('logseq_query_by_date_range', {}, { summary: { topConcepts: [] } })).toEqual([]);
  });

  it('logseq_list_pages suggests the first match only for a filtered listing', () => {
    expect(argsOf(buildTips('logseq_list_pages', { name_contains: 'al' }, { pages: ['Alice'], total: 1 }), 'logseq_get_page'))
      .toEqual({ page_name: 'Alice', include_children: true });
    expect(buildTips('logseq_list_pages', {}, { pages: ['Alice'], total: 1 })).toEqual([]);
    expect(buildTips('logseq_list_pages', { name_contains: 'zz' }, { pages: [], total: 0 })).toEqual([]);
  });

  it('gives no tips for tools without a clear next step', () => {
    for (const tool of ['logseq_get_block', 'logseq_build_context', 'logseq_get_graph_info', 'logseq_get_concept_network']) {
      expect(buildTips(tool, { page_name: 'Alice' }, { anything: true }), tool).toEqual([]);
    }
  });

  it('never returns more than MAX_TIPS', () => {
    const tips = buildTips('logseq_get_page', { page_name: 'Alice' }, { originalName: 'Alice' });
    expect(tips.length).toBeLessThanOrEqual(MAX_TIPS);
  });

  describe('names with quotes, backslashes and newlines', () => {
    const nasty = ['say "hi"', 'back\\slash', 'two\nlines', `it's "both" \\"`, 'Alice]] {"x":1}'];

    it.each(nasty)('keeps the suggested arguments valid JSON for %j', name => {
      const searchTips = buildTips('logseq_search_blocks', { query: 'x' }, [{ pageName: name }]);
      expect(argsOf(searchTips, 'logseq_build_context')).toEqual({ topic_name: name });

      const pageTips = buildTips('logseq_get_page', { page_name: name }, { originalName: name });
      expect(argsOf(pageTips, 'logseq_get_backlinks')).toEqual({ page_name: name });
      expect(argsOf(pageTips, 'logseq_get_page')).toEqual({ page_name: name, include_children: true });
    });
  });
});
