import { describe, it, expect } from 'vitest';
import { renderNetwork, renderQueryContext, renderTopicContext } from './markdown-context.js';
import type { QueryContext, TopicQueryContext } from '../tools/get-context-for-query.js';
import type { ConceptNetworkResult } from '../tools/get-concept-network.js';

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

  it('prints the pre-block text as the properties, not a rewrite of the properties map (#80)', () => {
    const preBlock = 'related-to:: [[Alice]], [[Bob]]\nproject-status:: active';
    const blocks = [
      { id: 11, uuid: U(11), content: preBlock, 'pre-block?': true, parent: { id: 1 }, left: { id: 1 }, page: { id: 1 } },
      { id: 12, uuid: U(12), content: 'real', parent: { id: 1 }, left: { id: 11 }, page: { id: 1 } },
    ];
    const page = { ...mainPage, properties: { 'related-to': ['Alice', 'Bob'], 'project-status': 'active' } };
    const text = renderTopicContext(context({ mainPage: page as any, directBlocks: blocks as any }));
    expect(text).toContain(`# Project Atlas\n\n${preBlock}\n\n## Blocks`);
    expect(text).not.toContain('- related-to::');
  });

  it('writes the properties map with refs and kebab-case keys when the pre-block was not fetched', () => {
    const page = { ...mainPage, properties: { 'related-to': ['Alice', 'Bob'], rating: 3 } };
    expect(renderTopicContext(context({ mainPage: page as any }))).toContain('related-to:: [[Alice]], [[Bob]]\nrating:: 3');
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

describe('renderQueryContext', () => {
  const query = (overrides: Partial<QueryContext> = {}): QueryContext => ({
    query: 'what about [[Project Atlas]]?',
    extractedTopics: ['Project Atlas'],
    contexts: [context() as TopicQueryContext],
    warnings: [],
    hasMore: false,
    summary: { totalTopics: 1, totalBlocks: 3, totalPages: 1 },
    ...overrides,
  });

  it('renders the query, its topics, and each topic one heading level down', () => {
    const text = renderQueryContext(query());
    expect(text.startsWith('# Context for: what about [[Project Atlas]]?\n\nTopics: [[Project Atlas]]\n\n## Project Atlas\n')).toBe(true);
    expect(text).toContain('### Blocks (3)');
    expect(text).toContain('- top one\n  second line\n\t- child');
  });

  it('renders every topic', () => {
    const second = context({ topic: 'Other', mainPage: { id: 5, 'original-name': 'Other' } as any, directBlocks: [] });
    const text = renderQueryContext(query({ extractedTopics: ['Project Atlas', 'Other'], contexts: [context(), second] }));
    expect(text).toContain('## Project Atlas');
    expect(text).toContain('## Other\n\n(this page has no blocks)');
  });

  it('renders keyword search results when the query named no topic', () => {
    const text = renderQueryContext(
      query({
        extractedTopics: [],
        contexts: [],
        searchResults: [{ id: 1, uuid: U(1), content: 'a hit\nmore lines', page: { id: 1 } } as any],
      })
    );
    expect(text).toBe(`# Context for: what about [[Project Atlas]]?\n\n## Search results (1)\n\n- a hit ((${U(1)}))\n  more lines\n`);
  });

  it('gives every search hit its ((uuid)) and its page, so it can be followed up (#80)', () => {
    const hits = [
      { id: 1, uuid: U(1), content: 'first hit\nmore lines', context: { page: { id: 7, 'original-name': 'Alice' } } },
      { id: 2, uuid: U(2), content: 'second hit', page: { id: 8, originalName: 'Project Atlas' } },
      { id: 3, uuid: U(3), content: 'no page name', page: { id: 9 } },
    ];
    const text = renderQueryContext(query({ extractedTopics: [], contexts: [], searchResults: hits as any }));
    expect(text).toContain(`- first hit ((${U(1)})) (in [[Alice]])\n  more lines`);
    expect(text).toContain(`- second hit ((${U(2)})) (in [[Project Atlas]])`);
    expect(text).toContain(`- no page name ((${U(3)}))\n`);
    // compact hits carry the same handle
    const compact = renderQueryContext(query({ extractedTopics: [], contexts: [], searchResults: hits as any }), { compact: true });
    expect(compact).toContain(`- first hit ((${U(1)})) (in [[Alice]])\n`);
    expect(compact).not.toContain('more lines');
  });

  it('says when a keyword search found nothing, and when there was nothing to run', () => {
    expect(renderQueryContext(query({ extractedTopics: [], contexts: [], searchResults: [] }))).toContain('(no matches)');
    expect(renderQueryContext(query({ extractedTopics: [], contexts: [] }))).toContain('(no results)');
  });

  it('compact shows snippets and uuids for topics and search hits', () => {
    const topics = renderQueryContext(query(), { compact: true });
    expect(topics).toContain(`- top one ((${U(11)}))`);
    expect(topics).not.toContain('second line');
    const hits = renderQueryContext(
      query({ extractedTopics: [], contexts: [], searchResults: [{ id: 1, uuid: U(1), content: 'a hit\nmore lines' } as any] }),
      { compact: true }
    );
    expect(hits).toContain(`- a hit ((${U(1)}))`);
    expect(hits).not.toContain('more lines');
  });
});

describe('renderNetwork', () => {
  const network = (overrides: Partial<ConceptNetworkResult> = {}): ConceptNetworkResult => ({
    concept: 'atlas',
    nodes: [
      { id: 1, name: 'Project Atlas', depth: 0 },
      { id: 2, name: 'Alice', depth: 1 },
      { id: 3, name: 'Bob', depth: 1 },
      { id: 4, name: 'Carol', depth: 2 },
    ],
    edges: [
      { from: 1, to: 2, type: 'reference', count: 3, outbound: 3, inbound: 0 },
      { from: 1, to: 3, type: 'backlink', count: 2, outbound: 0, inbound: 2 },
      { from: 2, to: 4, type: 'reference', count: 3, outbound: 2, inbound: 1 },
    ],
    truncated: false,
    hasMore: false,
    warnings: [],
    ...overrides,
  });

  it('groups pages by depth, then lists the links with their direction and count', () => {
    expect(renderNetwork(network())).toBe(
      [
        '# Concept network: [[Project Atlas]]',
        '',
        '## Depth 1 (2)',
        '',
        '[[Alice]], [[Bob]]',
        '',
        '## Depth 2 (1)',
        '',
        '[[Carol]]',
        '',
        '## Links (3)',
        '',
        '- [[Project Atlas]] -> [[Alice]] (3)',
        '- [[Project Atlas]] <- [[Bob]] (2)',
        '- [[Alice]] <-> [[Carol]] (2/1)',
        '',
      ].join('\n')
    );
  });

  it('says so for a root with no linked pages', () => {
    const text = renderNetwork(network({ nodes: [{ id: 1, name: 'Project Atlas', depth: 0 }], edges: [] }));
    expect(text).toBe('# Concept network: [[Project Atlas]]\n\n(no linked pages)\n');
  });

  it('notes the page a name resolved to', () => {
    const text = renderNetwork(network({ resolvedFrom: { name: 'Atlas', matchedBy: 'alias', resolvedTo: 'Project Atlas' } }));
    expect(text).toContain('(resolved from "Atlas", matched by alias)');
  });

  it('skips an edge whose page is not in the network', () => {
    const text = renderNetwork(network({ edges: [{ from: 1, to: 99, type: 'reference', count: 1, outbound: 1, inbound: 0 }] }));
    expect(text).not.toContain('## Links');
  });
});
