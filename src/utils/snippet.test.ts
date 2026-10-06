import { describe, it, expect } from 'vitest';
import { firstLineSnippet, SNIPPET_MAX_CHARS } from './snippet.js';

describe('firstLineSnippet', () => {
  it('returns the first line, trimmed', () => {
    expect(firstLineSnippet('  first line  \nsecond line')).toBe('first line');
  });

  it('skips leading blank lines', () => {
    expect(firstLineSnippet('\n\n  \nreal start\nmore')).toBe('real start');
  });

  it('returns a line of exactly the cap unchanged', () => {
    const line = 'x'.repeat(SNIPPET_MAX_CHARS);
    expect(firstLineSnippet(line)).toBe(line);
  });

  it('cuts a longer line to the cap, ellipsis included', () => {
    const snippet = firstLineSnippet('word '.repeat(40));
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    expect(snippet.endsWith('...')).toBe(true);
  });

  it('honours a custom cap', () => {
    expect(firstLineSnippet('abcdefghij', 6)).toBe('abc...');
  });

  it('returns an empty string for empty or non-string content', () => {
    expect(firstLineSnippet('')).toBe('');
    expect(firstLineSnippet('\n  \n')).toBe('');
    expect(firstLineSnippet(undefined)).toBe('');
    expect(firstLineSnippet(42)).toBe('');
  });
});

it('is a throwaway test', () => {
  expect(firstLineSnippet('a')).toBe('a');
});
