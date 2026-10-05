import { describe, it, expect } from 'vitest';
import { DatalogQueryBuilder } from './queries.js';
import { InvalidParameterError } from '../errors.js';

describe('DatalogQueryBuilder.normalizePropertyKey', () => {
  it('leaves a stored key alone', () => {
    expect(DatalogQueryBuilder.normalizePropertyKey('status')).toBe('status');
    expect(DatalogQueryBuilder.normalizePropertyKey('created-at')).toBe('created-at');
  });

  it('turns the Editor API camelCase spelling into the stored dashed key', () => {
    expect(DatalogQueryBuilder.normalizePropertyKey('createdAt')).toBe('created-at');
    expect(DatalogQueryBuilder.normalizePropertyKey('projectStartDate')).toBe('project-start-date');
  });

  it('lowercases and turns underscores into dashes, as LogSeq does when it stores keys', () => {
    expect(DatalogQueryBuilder.normalizePropertyKey('Status')).toBe('status');
    expect(DatalogQueryBuilder.normalizePropertyKey('Created_At')).toBe('created-at');
  });

  it.each([
    ['empty', ''],
    ['a space', 'my property'],
    ['a colon', ':status'],
    ['a double quote', 'a"b'],
    ['a bracket', 'a]b'],
    ['a newline', 'a\nb'],
    ['a dot', 'logseq.order'],
    ['a leading dash', '-status'],
    ['a slash', 'ns/status']
  ])('rejects a name with %s', (_label, name) => {
    expect(() => DatalogQueryBuilder.normalizePropertyKey(name)).toThrow(InvalidParameterError);
  });

  it('rejects a non-string name', () => {
    expect(() => DatalogQueryBuilder.normalizePropertyKey(undefined as any)).toThrow(InvalidParameterError);
    expect(() => DatalogQueryBuilder.normalizePropertyKey(42 as any)).toThrow(InvalidParameterError);
  });
});

describe('DatalogQueryBuilder.blocksByProperty', () => {
  it('passes the normalized key and the value as :in inputs', () => {
    const { query, inputs } = DatalogQueryBuilder.blocksByProperty('Status', 'active');

    expect(query).toContain(':in $ ?key ?value');
    expect(inputs).toEqual(['status', 'active']);
  });

  it('keeps the name and value out of the query text', () => {
    const { query } = DatalogQueryBuilder.blocksByProperty('projectName', 'project atlas');

    expect(query).not.toContain('project');
    expect(query).not.toContain('atlas');
  });

  it('does not alter the value, whatever it contains', () => {
    for (const value of ['Active', 'foo "bar', 'a\\b', 'x"]] [?p :block/name', 'a,b', '']) {
      const { query, inputs } = DatalogQueryBuilder.blocksByProperty('status', value);
      expect(inputs[1]).toBe(value);
      expect(query).not.toContain(value === '' ? '\u0000' : value);
    }
  });

  it('stringifies a non-string value like the old String(value) comparison', () => {
    const { inputs } = DatalogQueryBuilder.blocksByProperty('count', 42 as any);
    expect(inputs).toEqual(['count', '42']);
  });

  it('turns the string key into a keyword inside the query', () => {
    const { query } = DatalogQueryBuilder.blocksByProperty('status', 'active');

    expect(query).toContain('[(keyword ?key) ?kw]');
    expect(query).toContain('[(get ?props ?kw) ?v]');
  });

  it('matches scalars by (str ?v) and set elements by contains?', () => {
    const { query } = DatalogQueryBuilder.blocksByProperty('status', 'active');

    expect(query).toContain('[(str ?v) ?s]');
    expect(query).toContain('[(= ?s ?value)]');
    expect(query).toContain('[(contains? ?v ?value)]');
  });

  it('returns blocks only, not the page entities that duplicate their first block properties', () => {
    const { query } = DatalogQueryBuilder.blocksByProperty('status', 'active');

    expect(query).toContain('[?b :block/page]');
  });

  it('pulls the page name inline so no second lookup is needed', () => {
    const { query } = DatalogQueryBuilder.blocksByProperty('status', 'active');

    expect(query).toContain('(pull ?b [* {:block/page [:db/id :block/name :block/original-name]}])');
  });

  it('does not use functions LogSeq lacks', () => {
    const { query } = DatalogQueryBuilder.blocksByProperty('status', 'active');

    expect(query).not.toMatch(/string\?|coll\?|clojure\.string\/(join|lower-case)|\(seq /);
  });

  it('throws on an invalid property name', () => {
    expect(() => DatalogQueryBuilder.blocksByProperty('bad name', 'x')).toThrow(InvalidParameterError);
  });
});
