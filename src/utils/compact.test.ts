import { describe, it, expect } from 'vitest';
import { compactBlock, compactPage, compactTopicContext } from './compact.js';
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
