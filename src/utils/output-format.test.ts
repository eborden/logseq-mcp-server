import { describe, it, expect } from 'vitest';
import { parseCompact, parseFormat } from './output-format.js';
import { InvalidParameterError } from '../errors.js';

describe('parseFormat', () => {
  it('defaults to json', () => {
    expect(parseFormat(undefined)).toBe('json');
    expect(parseFormat(null)).toBe('json');
  });

  it('accepts json and markdown', () => {
    expect(parseFormat('json')).toBe('json');
    expect(parseFormat('markdown')).toBe('markdown');
  });

  it('rejects anything else instead of falling back', () => {
    for (const bad of ['Markdown', 'md', '', 1, true, {}]) {
      expect(() => parseFormat(bad), String(bad)).toThrow(InvalidParameterError);
    }
  });
});

describe('parseCompact', () => {
  it('defaults to false', () => {
    expect(parseCompact(undefined)).toBe(false);
    expect(parseCompact(null)).toBe(false);
  });

  it('accepts booleans', () => {
    expect(parseCompact(true)).toBe(true);
    expect(parseCompact(false)).toBe(false);
  });

  it('rejects other types', () => {
    for (const bad of ['true', 1, 0, {}]) {
      expect(() => parseCompact(bad), String(bad)).toThrow(InvalidParameterError);
    }
  });
});
