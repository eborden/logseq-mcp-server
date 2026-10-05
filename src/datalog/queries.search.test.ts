import { describe, it, expect } from 'vitest';
import { DatalogQueryBuilder } from './queries.js';

describe('DatalogQueryBuilder.searchBlocks', () => {
  it('filters block content with re-pattern and re-find on an :in pattern', () => {
    const { query } = DatalogQueryBuilder.searchBlocks('alice');
    expect(query).toContain(':in $ ?pattern');
    expect(query).toContain('[?b :block/content ?c]');
    expect(query).toContain('[(re-pattern ?pattern) ?re]');
    expect(query).toContain('[(re-find ?re ?c)]');
  });

  it('pulls page info inline', () => {
    const { query } = DatalogQueryBuilder.searchBlocks('alice');
    expect(query).toContain('{:block/page [:db/id :block/name :block/original-name]}');
  });

  it('never embeds the search text in the query string', () => {
    const { query } = DatalogQueryBuilder.searchBlocks('project atlas');
    expect(query).not.toContain('atlas');
  });

  it('prefixes (?i) for case-insensitive matching and keeps the text as given', () => {
    expect(DatalogQueryBuilder.searchBlocks('Project Atlas').inputs).toEqual(['(?i)Project Atlas']);
  });

  it('escapes regex metacharacters in the input', () => {
    expect(DatalogQueryBuilder.searchBlocks('c++').inputs).toEqual(['(?i)c\\+\\+']);
    expect(DatalogQueryBuilder.searchBlocks('a.b').inputs).toEqual(['(?i)a\\.b']);
    expect(DatalogQueryBuilder.searchBlocks('(x)[y]').inputs).toEqual(['(?i)\\(x\\)\\[y\\]']);
    expect(DatalogQueryBuilder.searchBlocks('$^|?*').inputs).toEqual(['(?i)\\$\\^\\|\\?\\*']);
  });

  it('leaves EDN string escaping to the client (backslash is only regex-escaped here)', () => {
    expect(DatalogQueryBuilder.searchBlocks('a\\b').inputs).toEqual(['(?i)a\\\\b']);
    expect(DatalogQueryBuilder.searchBlocks('say "hi"').inputs).toEqual(['(?i)say "hi"']);
  });
});

describe('DatalogQueryBuilder.getPagesByIds', () => {
  it('grounds the ids and restricts to pages', () => {
    const { query, inputs } = DatalogQueryBuilder.getPagesByIds([3, 5, 8]);
    expect(query).toContain('[(ground [3 5 8]) [?p ...]]');
    expect(query).toContain('[?p :block/name]');
    expect(query).toContain('(pull ?p [*])');
    expect(inputs).toEqual([]);
  });

  it('rejects non-integer ids', () => {
    expect(() => DatalogQueryBuilder.getPagesByIds([1, 1.5])).toThrow(/Invalid entity id/);
    expect(() => DatalogQueryBuilder.getPagesByIds([NaN])).toThrow(/Invalid entity id/);
  });
});
