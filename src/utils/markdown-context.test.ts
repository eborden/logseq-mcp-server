import { describe, it, expect } from 'vitest';
import { renderTopicContext } from './markdown-context.js';
import type { TopicQueryContext } from '../tools/get-context-for-query.js';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const mainPage = { id: 1, name: 'project atlas', 'original-name': 'Project Atlas', properties: { type: 'project' } };

/** Flat Datalog-style blocks, as build_context returns them: parent/left give the tree. */
const flatBlocks = [
  { id: 12, uuid: U(12), content: 'child', parent: { id: 11 }, left: { id: 11 }, page: { id: 1 } },
  { id: 11, uuid: U(11), content: 'top one\nsecond line', parent: { id: 1 }, left: { id: 1 }, page: { id: 1 } },
  { id: 13, uuid: U(13), content: `top two ((${U(99)}))`, parent: { id: 1 }, left: { id: 11 }, page: { id: 1 } },
];

function context(overrides: Partial<TopicQueryContext> & { totals?: any } = {}): TopicQueryContext & { totals?: any } {
  return {
    topic: 'Project Atlas',
    mainPage: mainPage as any,
    directBlocks: flatBlocks as any,
    relatedPages: [],
    references: [],
    summary: { totalBlocks: 3, totalRelatedPages: 0, totalReferences: 0, pageProperties: { type: 'project' } },
    ...overrides,
  };
}

describe('renderTopicContext', () => {
  it('renders title, properties, then blocks rebuilt into their page order and nesting', () => {
    expect(renderTopicContext(context())).toBe(
      [
        '# Project Atlas',
        '',
        'type:: project',
        '',
        '## Blocks (3)',
        '',
        '- top one',
        '  second line',
        '\t- child',
        `- top two ((${U(99)}))`,
        '',
      ].join('\n')
    );
  });

  it('shows resolvedContent under its block', () => {
    const blocks = [{ ...flatBlocks[2], resolvedContent: 'top two the cited text' }];
    const text = renderTopicContext(context({ directBlocks: blocks as any }));
    expect(text).toContain(`- top two ((${U(99)}))\n  [resolved] top two the cited text`);
  });

  it('says so for a page with no blocks', () => {
    const text = renderTopicContext(context({ directBlocks: [] }));
    expect(text).toContain('(this page has no blocks)');
    expect(text).not.toContain('## Blocks');
  });

  it('keeps a block whose parent was cut by max_blocks, as a top-level bullet', () => {
    const orphan = { id: 12, uuid: U(12), content: 'orphan', parent: { id: 777 }, left: { id: 777 }, page: { id: 1 } };
    expect(renderTopicContext(context({ directBlocks: [orphan] as any }))).toContain('- orphan');
  });

  it('keeps blocks that carry no page or parent', () => {
    const bare = [{ id: 21, content: 'a' }, { id: 22, content: 'b' }];
    const text = renderTopicContext(context({ directBlocks: bare as any }));
    expect(text).toContain('- a');
    expect(text).toContain('- b');
  });

  it('lists related pages as links, and says when more exist', () => {
    const text = renderTopicContext(
      context({
        relatedPages: [
          { page: { id: 2, 'original-name': 'Alice' } as any, relationshipType: 'inbound' },
          { page: { id: 3, name: 'bob' } as any, relationshipType: 'outbound' },
        ],
        totals: { blocks: 3, relatedPages: 7, references: 0 },
      })
    );
    expect(text).toContain('## Related pages (2 of 7)\n\n[[Alice]], [[bob]] (outbound)');
  });

  it('groups references by source page, one bullet per block', () => {
    const alice = { id: 2, 'original-name': 'Alice' } as any;
    const bob = { id: 3, 'original-name': 'Bob' } as any;
    const text = renderTopicContext(
      context({
        references: [
          { block: { uuid: U(21), content: 'from alice 1', children: [{ content: 'not shown' }] } as any, sourcePage: alice },
          { block: { uuid: U(22), content: 'from bob' } as any, sourcePage: bob },
          { block: { uuid: U(23), content: 'from alice 2' } as any, sourcePage: alice },
        ],
        totals: { blocks: 3, relatedPages: 2, references: 3 },
      })
    );
    expect(text).toContain(
      ['## References (3)', '', '### [[Alice]]', '', '- from alice 1', '- from alice 2', '', '### [[Bob]]', '', '- from bob'].join('\n')
    );
    expect(text).not.toContain('not shown');
  });

  it('notes a journal date and the page a name resolved to', () => {
    const text = renderTopicContext(
      context({
        temporalContext: { isJournal: true, date: 20250101 },
        resolvedFrom: { name: 'Atlas', matchedBy: 'alias', resolvedTo: 'Project Atlas' },
      })
    );
    expect(text).toContain('(resolved from "Atlas", matched by alias)');
    expect(text).toContain('Journal: 20250101');
  });

  it('repeats no pre-block when the properties were rendered', () => {
    const blocks = [{ id: 11, uuid: U(11), content: 'type:: project', 'pre-block?': true, parent: { id: 1 }, left: { id: 1 }, page: { id: 1 } }];
    expect(renderTopicContext(context({ directBlocks: blocks as any }))).not.toContain('- type:: project');
  });

  it('goes one heading level down when nested', () => {
    const text = renderTopicContext(context(), { headingLevel: 2 });
    expect(text.startsWith('## Project Atlas\n')).toBe(true);
    expect(text).toContain('### Blocks (3)');
  });

  describe('compact', () => {
    it('shows snippets and uuids, no bodies', () => {
      const text = renderTopicContext(context(), { compact: true });
      expect(text).toContain(`- top one ((${U(11)}))\n\t- child ((${U(12)}))`);
      expect(text).not.toContain('second line');
    });

    it('applies to references too', () => {
      const text = renderTopicContext(
        context({
          references: [{ block: { uuid: U(21), content: 'long ref\nsecond' } as any, sourcePage: { id: 2, 'original-name': 'Alice' } as any }],
        }),
        { compact: true }
      );
      expect(text).toContain(`### [[Alice]]\n\n- long ref ((${U(21)}))`);
    });
  });
});
