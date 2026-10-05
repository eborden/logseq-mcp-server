import { describe, it, expect } from 'vitest';
import { escapeRegex } from './escape-regex.js';

describe('escapeRegex', () => {
  it('escapes quantifier characters (c++)', () => {
    expect(escapeRegex('c++')).toBe('c\\+\\+');
  });

  it('escapes the dot (a.b)', () => {
    expect(escapeRegex('a.b')).toBe('a\\.b');
  });

  it('escapes parentheses ((x))', () => {
    expect(escapeRegex('(x)')).toBe('\\(x\\)');
  });

  it('escapes square brackets ([y])', () => {
    expect(escapeRegex('[y]')).toBe('\\[y\\]');
  });

  it('escapes backslashes', () => {
    expect(escapeRegex('a\\b')).toBe('a\\\\b');
  });

  it('escapes $ ^ | ? * together', () => {
    expect(escapeRegex('$^|?*')).toBe('\\$\\^\\|\\?\\*');
  });

  it('escapes braces', () => {
    expect(escapeRegex('a{2}')).toBe('a\\{2\\}');
  });

  it('leaves plain text, spaces and unicode untouched', () => {
    expect(escapeRegex('project atlas')).toBe('project atlas');
    expect(escapeRegex('café 日本')).toBe('café 日本');
    expect(escapeRegex('')).toBe('');
  });

  it('produces a pattern that matches the original text literally', () => {
    const samples = ['c++', 'a.b', '(x)', '[y]', 'a\\b', '$^|?*', 'a{2}', '1+1=2?'];
    for (const text of samples) {
      const re = new RegExp(`^${escapeRegex(text)}$`);
      expect(re.test(text)).toBe(true);
    }
    expect(new RegExp(escapeRegex('a.b')).test('axb')).toBe(false);
  });
});
