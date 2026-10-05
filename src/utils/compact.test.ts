import { describe, it, expect } from 'vitest';
import { compactBlock, compactPage, compactQueryContext, compactTopicContext } from './compact.js';
import { SNIPPET_MAX_CHARS } from './snippet.js';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('compactBlock', () => {
  it('keeps the uuid and the first line, capped', () => {
    const block = { id: 5, uuid: U(1), content: `${'x'.repeat(200)}\nsecond`, page: { id: 1 }, refs: [{ id: 9 }] };
    const compact = compactBlock(block);
    expect(Object.keys(compact)).toEqual(['uuid', 'snippet']);
    expect(compact.uuid).toBe(U(1));
    expect(compact.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
  });
});

describe('compactPage', () => {
  it('keeps the id and the names, in either spelling', () => {
    expect(compactPage({ id: 1, name: 'a b', 'original-name': 'A B', uuid: 'x', properties: { k: 'v' } })).toEqual({
      id: 1,
      name: 'a b',
      originalName: 'A B',
    });
    expect(compactPage({ 'db/id': 2, name: 'c', originalName: 'C' })).toEqual({ id: 2, name: 'c', originalName: 'C' });
  });
});

describe('compactTopicContext', () => {
  const context: any = {
    topic: 'Atlas',
    resolvedFrom: { name: 'Atlas', matchedBy: 'alias', resolvedTo: 'Project Atlas' },
    mainPage: { id: 1, name: 'project atlas', 'original-name': 'Project Atlas', properties: { type: 'project' }, uuid: 'u' },
    directBlocks: [{ id: 2, uuid: U(2), content: 'body one\nmore', resolvedContent: 'resolved' }],
    relatedPages: [{ page: { id: 3, name: 'alice', 'original-name': 'Alice', uuid: 'u3' }, relationshipType: 'inbound' }],
    references: [{ block: { id: 4, uuid: U(4), content: 'ref body\nsecond ref line' }, sourcePage: { id: 3, name: 'alice', 'original-name': 'Alice' } }],
    temporalContext: { isJournal: false },
    summary: { totalBlocks: 1, totalRelatedPages: 1, totalReferences: 1, pageProperties: { type: 'project' } },
    hasMore: true,
    warnings: [{ code: 'blocks_truncated', message: 'm', howToFetchAll: 'h' }],
    totals: { blocks: 9, relatedPages: 1, references: 1 },
  };

  it('replaces bodies with snippets and pages with their names', () => {
    const compact = compactTopicContext(context);
    expect(compact.mainPage).toEqual({ id: 1, name: 'project atlas', originalName: 'Project Atlas' });
    expect(compact.directBlocks).toEqual([{ uuid: U(2), snippet: 'body one' }]);
    expect(compact.relatedPages).toEqual([
      { page: { id: 3, name: 'alice', originalName: 'Alice' }, relationshipType: 'inbound' },
    ]);
    expect(compact.references).toEqual([
      { block: { uuid: U(4), snippet: 'ref body' }, sourcePage: { id: 3, name: 'alice', originalName: 'Alice' } },
    ]);
  });

  it('keeps everything outside the blocks, so truncation is still reported', () => {
    const compact = compactTopicContext(context);
    expect(compact.topic).toBe('Atlas');
    expect(compact.resolvedFrom).toEqual(context.resolvedFrom);
    expect(compact.summary).toEqual(context.summary);
    expect(compact.hasMore).toBe(true);
    expect(compact.warnings).toEqual(context.warnings);
    expect(compact.totals).toEqual(context.totals);
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify(context);
    compactTopicContext(context);
    expect(JSON.stringify(context)).toBe(before);
  });

  it('has no block body anywhere in its JSON', () => {
    const json = JSON.stringify(compactTopicContext(context));
    for (const body of ['more', 'second ref line', '"resolvedContent"', '"content"']) {
      expect(json, body).not.toContain(body);
    }
  });
});

describe('compactQueryContext', () => {
  const topic: any = {
    topic: 'Atlas',
    mainPage: { id: 1, name: 'atlas', 'original-name': 'Atlas' },
    directBlocks: [{ id: 2, uuid: U(2), content: 'first\nsecond' }],
    relatedPages: [],
    references: [],
    summary: { totalBlocks: 1, totalRelatedPages: 0, totalReferences: 0, pageProperties: {} },
  };
  const query: any = {
    query: 'what about [[Atlas]]?',
    extractedTopics: ['Atlas'],
    contexts: [topic],
    warnings: [{ code: 'topics_truncated', message: 'm', howToFetchAll: 'h' }],
    hasMore: true,
    summary: { totalTopics: 1, totalBlocks: 1, totalPages: 1 },
  };

  it('compacts every topic and keeps the query-level fields', () => {
    const compact = compactQueryContext(query);
    expect(compact.contexts[0].directBlocks).toEqual([{ uuid: U(2), snippet: 'first' }]);
    expect(compact.contexts[0].mainPage).toEqual({ id: 1, name: 'atlas', originalName: 'Atlas' });
    expect(compact.query).toBe(query.query);
    expect(compact.extractedTopics).toEqual(['Atlas']);
    expect(compact.warnings).toEqual(query.warnings);
    expect(compact.hasMore).toBe(true);
    expect(compact.summary).toEqual(query.summary);
    expect('searchResults' in JSON.parse(JSON.stringify(compact))).toBe(false);
  });

  it('reduces keyword search hits to snippets', () => {
    const compact = compactQueryContext({
      ...query,
      contexts: [],
      searchResults: [{ id: 9, uuid: U(9), content: 'a hit\nmore', page: { id: 1 } }],
    });
    expect(compact.searchResults).toEqual([{ uuid: U(9), snippet: 'a hit' }]);
  });
});
