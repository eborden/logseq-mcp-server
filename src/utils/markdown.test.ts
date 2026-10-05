import { describe, it, expect } from 'vitest';
import {
  renderBlock,
  renderFooter,
  renderOutline,
  renderPage,
  renderProperties,
  withFooter,
  TRUNCATED_BLOCK_MARKER,
} from './markdown.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

describe('renderOutline', () => {
  it('indents nested blocks with one tab per level', () => {
    const blocks = [
      { content: 'top', children: [{ content: 'child', children: [{ content: 'grandchild' }] }] },
      { content: 'sibling' },
    ];
    expect(renderOutline(blocks).lines.join('\n')).toBe('- top\n\t- child\n\t\t- grandchild\n- sibling');
  });

  it('indents the continuation lines of a multi-line block under its bullet', () => {
    const { lines } = renderOutline([{ content: 'one\ntwo', children: [{ content: 'a\nb' }] }]);
    expect(lines.join('\n')).toBe('- one\n  two\n\t- a\n\t  b');
  });

  it('keeps ((uuid)) refs exactly as written', () => {
    const { lines } = renderOutline([{ content: `see ((${UUID_A})) for more` }]);
    expect(lines).toEqual([`- see ((${UUID_A})) for more`]);
  });

  it('shows resolvedContent beside the content, never in place of it', () => {
    const block = { content: `see ((${UUID_A}))`, resolvedContent: 'see the cited text\nover two lines' };
    expect(renderOutline([block]).lines.join('\n')).toBe(
      `- see ((${UUID_A}))\n  [resolved] see the cited text\n    over two lines`
    );
  });

  it('adds no resolved line when resolvedContent equals content', () => {
    expect(renderOutline([{ content: 'plain', resolvedContent: 'plain' }]).lines).toEqual(['- plain']);
  });

  it('skips unfetched children, which are ["uuid", "<id>"] tuples', () => {
    const { lines } = renderOutline([{ content: 'parent', children: [['uuid', '123']] }]);
    expect(lines).toEqual(['- parent']);
  });

  it('renders an empty block as a bare bullet', () => {
    expect(renderOutline([{ content: '' }]).lines).toEqual(['- ']);
  });

  it('skips pre-blocks only when asked to', () => {
    const blocks = [{ content: 'alias:: x', 'pre-block?': true }, { content: 'real' }];
    expect(renderOutline(blocks).lines).toEqual(['- alias:: x', '- real']);
    expect(renderOutline(blocks, { skipPreBlocks: true }).lines).toEqual(['- real']);
  });

  describe('compact', () => {
    it('shows a snippet and the uuid instead of the body', () => {
      const long = `${'word '.repeat(40)}\nsecond line`;
      const { lines } = renderOutline([{ uuid: UUID_A, content: long, children: [{ uuid: UUID_B, content: 'kid' }] }], {
        compact: true,
      });
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^- word word .*\.\.\. \(\(11111111-1111-4111-8111-111111111111\)\)$/);
      expect(lines[0]).not.toContain('second line');
      expect(lines[1]).toBe(`\t- kid ((${UUID_B}))`);
    });

    it('leaves out resolved text', () => {
      const { lines } = renderOutline([{ uuid: UUID_A, content: 'x', resolvedContent: 'y' }], { compact: true });
      expect(lines).toEqual([`- x ((${UUID_A}))`]);
    });
  });

  describe('maxChars', () => {
    it('stops at the cap and reports the cut', () => {
      const blocks = Array.from({ length: 10 }, (_, i) => ({ content: `block ${i} ${'x'.repeat(20)}` }));
      const outline = renderOutline(blocks, { maxChars: 100 });
      expect(outline.cut).toBe(true);
      expect(outline.lines.length).toBeGreaterThan(0);
      expect(outline.lines.length).toBeLessThan(10);
    });

    it('keeps the start of a first block that alone exceeds the cap, with a marker', () => {
      const outline = renderOutline([{ content: `START ${'y'.repeat(500)}` }], { maxChars: 100 });
      expect(outline.cut).toBe(true);
      expect(outline.lines).toHaveLength(1);
      expect(outline.lines[0]).toContain('- START yyy');
      expect(outline.lines[0].endsWith(TRUNCATED_BLOCK_MARKER)).toBe(true);
      expect(outline.lines[0].length).toBeLessThanOrEqual(100);
    });

    it('is not cut under the cap', () => {
      expect(renderOutline([{ content: 'small' }], { maxChars: 100 }).cut).toBe(false);
    });
  });
});

describe('renderProperties', () => {
  it('writes key:: value lines, joining lists and skipping empty values', () => {
    expect(
      renderProperties({ type: 'project', tags: ['a', 'b'], empty: '', none: null, count: 3, flag: false })
    ).toEqual(['type:: project', 'tags:: a, b', 'count:: 3', 'flag:: false']);
  });

  it('returns nothing for a missing or non-object value', () => {
    expect(renderProperties(undefined)).toEqual([]);
    expect(renderProperties('x')).toEqual([]);
    expect(renderProperties({})).toEqual([]);
  });
});

describe('renderPage', () => {
  const alice = { originalName: 'Alice', name: 'alice' };

  it('puts the title first, then properties, then the blocks', () => {
    const page = { ...alice, properties: { type: 'person' }, children: [{ content: 'first' }] };
    expect(renderPage(page, { blocksFetched: true })).toBe('# Alice\n\ntype:: person\n\n- first\n');
  });

  it('omits the properties section when there are none', () => {
    expect(renderPage({ ...alice, properties: {}, children: [{ content: 'first' }] }, { blocksFetched: true })).toBe(
      '# Alice\n\n- first\n'
    );
  });

  it('leaves out the pre-block that repeats the page properties', () => {
    const page = {
      ...alice,
      properties: { type: 'person' },
      children: [{ content: 'type:: person', 'pre-block?': true }, { content: 'real' }],
    };
    expect(renderPage(page, { blocksFetched: true })).toBe('# Alice\n\ntype:: person\n\n- real\n');
  });

  it('keeps a pre-block when no properties were rendered', () => {
    const page = { ...alice, children: [{ content: 'alias:: x', 'pre-block?': true }] };
    expect(renderPage(page, { blocksFetched: true })).toContain('- alias:: x');
  });

  it('says so when a fetched page has no blocks', () => {
    expect(renderPage(alice, { blocksFetched: true })).toBe('# Alice\n\n(this page has no blocks)\n');
  });

  it('renders title and properties only when blocks were not fetched', () => {
    expect(renderPage({ ...alice, properties: { type: 'person' } }, { blocksFetched: false })).toBe(
      '# Alice\n\ntype:: person\n'
    );
    expect(renderPage(alice, { blocksFetched: false })).toBe('# Alice\n');
  });

  it('notes the page a name resolved to', () => {
    const page = { ...alice, resolvedFrom: { name: 'Al', matchedBy: 'alias', resolvedTo: 'Alice' } };
    expect(renderPage(page, { blocksFetched: false })).toBe('# Alice\n\n(resolved from "Al", matched by alias)\n');
  });

  it('reads Datalog-style names and falls back to the given title', () => {
    expect(renderPage({ 'original-name': 'Bob' }, { blocksFetched: false })).toBe('# Bob\n');
    expect(renderPage({}, { blocksFetched: false, fallbackTitle: 'x y' })).toBe('# x y\n');
  });

  it('appends the cut notice when the outline is cut', () => {
    const page = { ...alice, children: Array.from({ length: 50 }, (_, i) => ({ content: `${i} ${'x'.repeat(30)}` })) };
    const text = renderPage(page, { blocksFetched: true, maxChars: 200, cutNotice: '[Cut here.]' });
    expect(text.endsWith('\n\n[Cut here.]\n')).toBe(true);
  });

  it('renders compact blocks as snippets with uuids', () => {
    const page = { ...alice, children: [{ uuid: UUID_A, content: 'a long body\nmore' }] };
    expect(renderPage(page, { blocksFetched: true, compact: true })).toBe(`# Alice\n\n- a long body ((${UUID_A}))\n`);
  });
});

describe('renderBlock', () => {
  it('titles the block by uuid and renders its children', () => {
    const block = { uuid: UUID_A, content: 'parent', children: [{ content: 'kid' }] };
    expect(renderBlock(block)).toBe(`# Block ((${UUID_A}))\n\n- parent\n\t- kid\n`);
  });

  it('works without a uuid', () => {
    expect(renderBlock({ content: 'x' })).toBe('# Block\n\n- x\n');
  });
});

describe('renderFooter', () => {
  it('is empty when there is nothing to say', () => {
    expect(renderFooter(undefined)).toBe('');
    expect(renderFooter({ warnings: [], hasMore: false, tips: [] })).toBe('');
  });

  it('lists warnings with their code and how to fetch the rest', () => {
    const footer = renderFooter({
      warnings: [{ code: 'blocks_truncated', message: 'Showing 5 of 9 blocks.', howToFetchAll: 'Set max_blocks to 9.' }],
      hasMore: true,
    });
    expect(footer).toBe(
      '---\nWarnings:\n- blocks_truncated: Showing 5 of 9 blocks. Set max_blocks to 9.\nhasMore: true'
    );
  });

  it('lists tips, and omits hasMore when false', () => {
    expect(renderFooter({ hasMore: false, tips: ['logseq_get_backlinks {"page_name":"Alice"}'] })).toBe(
      '---\nTips:\n- logseq_get_backlinks {"page_name":"Alice"}'
    );
  });

  it('puts warnings, hasMore and tips in that order', () => {
    const footer = renderFooter({ warnings: [{ message: 'w' }], hasMore: true, tips: ['t'] });
    expect(footer.split('\n')).toEqual(['---', 'Warnings:', '- w', 'hasMore: true', 'Tips:', '- t']);
  });
});

describe('withFooter', () => {
  it('returns the body untouched when there is no footer', () => {
    expect(withFooter('# A\n', { warnings: [] })).toBe('# A\n');
  });

  it('separates the footer from the body by a blank line', () => {
    expect(withFooter('# A\n', { tips: ['t'] })).toBe('# A\n\n---\nTips:\n- t\n');
  });
});
