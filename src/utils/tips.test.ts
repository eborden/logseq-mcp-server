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

  it.each([
    ['context page kebab-case name', { context: { page: { 'original-name': 'Alice' } } }],
    ['context page lowercase name', { context: { page: { name: 'Alice' } } }],
    ['page originalName', { page: { originalName: 'Alice' } }],
    ['page lowercase name', { page: { name: 'Alice' } }],
  ])('reads the name from a %s', (_label, entity) => {
    expect(pageNameOf(entity)).toBe('Alice');
  });

  it('is undefined when only a bare page id is known', () => {
    expect(pageNameOf({ page: { id: 7 } })).toBeUndefined();
    expect(pageNameOf(null)).toBeUndefined();
  });

  it('is undefined for an entity with no page, context or name at all', () => {
    expect(pageNameOf({})).toBeUndefined();
    expect(pageNameOf({ context: {} })).toBeUndefined();
  });

  it.each([
    ['an empty string', ''],
    ['a blank string', '   '],
    ['a number', 5],
    ['null', null],
  ])('skips %s and falls through to the next source', (_label, bad) => {
    expect(pageNameOf({ pageName: bad, page: { name: 'Alice' } })).toBe('Alice');
    expect(pageNameOf({ pageName: bad })).toBeUndefined();
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

    it('says "No match" when the meta has no totals', () => {
      expect(buildTips('logseq_search_blocks', { query: 'x' }, [], { totals: undefined })[0]).toContain('No match');
      expect(buildTips('logseq_search_blocks', { query: 'x' }, [], null)[0]).toContain('No match');
    });

    it('says "No match" when totals.matches is not a number', () => {
      const meta = { totals: { matches: '5' as unknown as number } };
      expect(buildTips('logseq_search_blocks', { query: 'x' }, [], meta)[0]).toContain('No match');
    });

    it('offers list_pages for the first word even when the query starts with spaces', () => {
      const tips = buildTips('logseq_search_blocks', { query: '  project atlas' }, []);
      expect(argsOf(tips, 'logseq_list_pages')).toEqual({ name_contains: 'project' });
    });

    it('offers no list_pages call on a miss when there is no query', () => {
      for (const args of [{}, { query: '' }, { query: '   ' }]) {
        const tips = buildTips('logseq_search_blocks', args, []);
        expect(tips).toHaveLength(1);
        expect(tips[0]).toContain('No match');
        expect(tips[0]).not.toContain('logseq_list_pages');
        expect(tips[0].endsWith('.')).toBe(true);
      }
    });

    describe('what the suggested topic is called', () => {
      it('says "page" for a page and "topic" for a tag or ref', () => {
        const onPage = buildTips('logseq_search_blocks', { query: 'x' }, [{ pageName: 'Alice' }]);
        expect(onPage[0]).toContain('page most results are on');
        expect(onPage[0]).not.toContain('topic most');

        const byTag = buildTips('logseq_search_blocks', { query: 'x' }, [{ pageName: 'Oct 5th, 2026', tags: ['atlas'] }]);
        expect(byTag[0]).toContain('topic most results mention');
        expect(byTag[0]).not.toContain('page most');
      });
    });

    describe('picking the topic', () => {
      const J = 'Oct 5th, 2026';

      it.each([
        ['isJournal', { isJournal: true }],
        ['journalDate', { journalDate: 20261005 }],
        ['journal?', { 'journal?': true }],
        ['journal', { journal: true }],
        ['journalDay', { journalDay: 20261005 }],
        ['journal-day', { 'journal-day': 20261005 }],
      ])('treats a page flagged only by %s as a journal', (_flag, flag) => {
        // The journal page leads (2 hits to 1), so only recognising it as a journal picks the topic page
        const journal = { originalName: J, ...flag };
        const topic = { originalName: 'Project Atlas' };
        const result = [{ context: { page: journal } }, { context: { page: journal } }, { context: { page: topic } }];
        const tips = buildTips('logseq_search_blocks', { query: 'x' }, result);
        expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: 'Project Atlas' });
      });

      it('reads the journal flag from page when the block has no context page', () => {
        const journal = { originalName: J, isJournal: true };
        const result = [{ page: journal }, { page: journal }, { page: { originalName: 'Project Atlas' } }];
        const tips = buildTips('logseq_search_blocks', { query: 'x' }, result);
        expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: 'Project Atlas' });
      });

      it('does not take the kind of a page from a nameless page entity', () => {
        // The name comes from pageName, so the page object says nothing about journals: tags still win
        const result = [{ pageName: 'Alice', page: { id: 1 }, tags: ['atlas'] }];
        const tips = buildTips('logseq_search_blocks', { query: 'x' }, result);
        expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: 'atlas' });
      });

      it('counts tags from context.tags, tags and pageRefs together', () => {
        const result = [
          { pageName: J, context: { tags: ['atlas'] } },
          { pageName: J, pageRefs: ['atlas'] },
          { pageName: J, tags: ['Alice'] },
        ];
        const tips = buildTips('logseq_search_blocks', { query: 'x' }, result);
        expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: 'atlas' });
      });

      it('skips blank and non-string tags, even when they come first', () => {
        // Junk first: if it were counted, it would tie atlas at one mention and win as first seen
        const result = [{ pageName: J, tags: ['  ', 5, null, 'atlas'] }];
        const tips = buildTips('logseq_search_blocks', { query: 'x' }, result);
        expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: 'atlas' });
      });

      it('ignores tags that are not a list', () => {
        const result = [{ pageName: 'Alice', tags: 'atlas', pageRefs: 'atlas', context: { tags: 'atlas' } }];
        const tips = buildTips('logseq_search_blocks', { query: 'x' }, result);
        expect(tips[0]).toContain('page most results are on');
        expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: 'Alice' });
      });

      it('survives results that are not objects', () => {
        const result = [null, 'text', 7, { pageName: 'Alice' }];
        const tips = buildTips('logseq_search_blocks', { query: 'x' }, result);
        expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: 'Alice' });
      });

      it('leaves a block with no page name out of the vote', () => {
        // The nameless block comes first: counted, its undefined name would tie Alice and win
        const result = [{ page: { id: 1 } }, { pageName: 'Alice' }];
        const tips = buildTips('logseq_search_blocks', { query: 'x' }, result);
        expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: 'Alice' });
      });

      it('prefers a page of unknown kind over a journal that has more hits', () => {
        const journal = { originalName: J, isJournal: true };
        const result = [{ context: { page: journal } }, { context: { page: journal } }, { pageName: 'Alice' }];
        const tips = buildTips('logseq_search_blocks', { query: 'x' }, result);
        expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: 'Alice' });
      });

      it('picks the most common journal when every page is one', () => {
        const other = { originalName: 'Oct 4th, 2026', isJournal: true };
        const journal = { originalName: J, isJournal: true };
        const result = [{ context: { page: other } }, { context: { page: journal } }, { context: { page: journal } }];
        const tips = buildTips('logseq_search_blocks', { query: 'x' }, result);
        expect(argsOf(tips, 'logseq_build_context')).toEqual({ topic_name: J });
        expect(tips[0]).toContain('page most results are on');
      });
    });
  });

  describe('logseq_get_page_outline', () => {
    const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

    it('suggests reading the first block that has children, with its children', () => {
      const result = {
        blocks: [
          { uuid: U(1), snippet: 'leaf', childCount: 0 },
          { uuid: U(2), snippet: 'parent', childCount: 3 },
        ],
      };
      const tips = buildTips('logseq_get_page_outline', { page_name: 'Alice' }, result);
      expect(argsOf(tips, 'logseq_get_block')).toEqual({ block_uuid: U(2), include_children: true });
    });

    it('falls back to the first block when none has children', () => {
      const result = { blocks: [{ uuid: U(1), snippet: 'a', childCount: 0 }, { uuid: U(2), snippet: 'b', childCount: 0 }] };
      const tips = buildTips('logseq_get_page_outline', { page_name: 'Alice' }, result);
      expect(argsOf(tips, 'logseq_get_block')).toEqual({ block_uuid: U(1), include_children: true });
    });

    it('skips blocks that are not objects when looking for children', () => {
      const result = { blocks: [null, 'text', { uuid: U(2), snippet: 'parent', childCount: 2 }] };
      const tips = buildTips('logseq_get_page_outline', { page_name: 'Alice' }, result);
      expect(argsOf(tips, 'logseq_get_block')).toEqual({ block_uuid: U(2), include_children: true });
    });

    it('has no tip for a missing outline or one without usable blocks', () => {
      expect(buildTips('logseq_get_page_outline', { page_name: 'Alice' }, null)).toEqual([]);
      expect(buildTips('logseq_get_page_outline', { page_name: 'Alice' }, { blocks: 'none' })).toEqual([]);
      expect(buildTips('logseq_get_page_outline', { page_name: 'Alice' }, { blocks: [null] })).toEqual([]);
    });

    it('has no tip for an empty outline', () => {
      expect(buildTips('logseq_get_page_outline', { page_name: 'Alice' }, { blocks: [] })).toEqual([]);
      expect(buildTips('logseq_get_page_outline', { page_name: 'Alice' }, {})).toEqual([]);
    });
  });

  describe('logseq_get_page', () => {
    it('suggests the page blocks and the backlinks', () => {
      const tips = buildTips('logseq_get_page', { page_name: 'alice' }, { originalName: 'Alice' });
      expect(argsOf(tips, 'logseq_get_page')).toEqual({ page_name: 'Alice', include_children: true });
      expect(argsOf(tips, 'logseq_get_backlinks')).toEqual({ page_name: 'Alice' });
    });

    it('falls back to the requested name when the result carries none', () => {
      for (const result of [null, {}, { originalName: '  ' }]) {
        const tips = buildTips('logseq_get_page', { page_name: 'alice' }, result);
        expect(argsOf(tips, 'logseq_get_backlinks')).toEqual({ page_name: 'alice' });
      }
    });

    it('has no tip when neither the result nor the arguments name a page', () => {
      expect(buildTips('logseq_get_page', {}, {})).toEqual([]);
      expect(buildTips('logseq_get_page', {}, null)).toEqual([]);
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

  it('logseq_query_by_property has no tip for a result that is not a list, or names no page', () => {
    expect(buildTips('logseq_query_by_property', {}, null)).toEqual([]);
    expect(buildTips('logseq_query_by_property', {}, { page: { originalName: 'Alice' } })).toEqual([]);
    expect(buildTips('logseq_query_by_property', {}, [{ page: { id: 1 } }])).toEqual([]);
  });

  it('logseq_query_by_property says "topic" for a tag and "page" for a page', () => {
    const byTag = buildTips('logseq_query_by_property', {}, [{ pageName: 'Alice', tags: ['atlas'] }]);
    expect(byTag[0]).toContain('topic most matches mention');
    expect(byTag[0]).not.toContain('page most');

    const onPage = buildTips('logseq_query_by_property', {}, [{ page: { originalName: 'Alice' } }]);
    expect(onPage[0]).toContain('page most matches are on');
    expect(onPage[0]).not.toContain('topic most');
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
    expect(buildTips('logseq_query_by_date_range', {}, {})).toEqual([]);
    expect(buildTips('logseq_query_by_date_range', {}, null)).toEqual([]);
    expect(buildTips('logseq_query_by_date_range', {}, { summary: { topConcepts: [{ count: 1 }] } })).toEqual([]);
  });

  it('logseq_list_pages suggests the first match only for a filtered listing', () => {
    expect(argsOf(buildTips('logseq_list_pages', { name_contains: 'al' }, { pages: [{ name: 'Alice' }], total: 1 }), 'logseq_get_page'))
      .toEqual({ page_name: 'Alice', include_children: true });
    expect(buildTips('logseq_list_pages', {}, { pages: [{ name: 'Alice' }], total: 1 })).toEqual([]);
    expect(buildTips('logseq_list_pages', { name_contains: 'zz' }, { pages: [], total: 0 })).toEqual([]);
    expect(buildTips('logseq_list_pages', { name_contains: 'zz' }, {})).toEqual([]);
    expect(buildTips('logseq_list_pages', { name_contains: 'zz' }, null)).toEqual([]);
    expect(buildTips('logseq_list_pages', { name_contains: '  ' }, { pages: [{ name: 'Alice' }] })).toEqual([]);
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
