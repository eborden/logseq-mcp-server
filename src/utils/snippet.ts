/** Longest first-line snippet, in characters, ellipsis included (#43). */
export const SNIPPET_MAX_CHARS = 80;

/**
 * The first non-blank line of a block's content, trimmed, cut to `max` characters
 * with a trailing `...`. Used where the model should see what a block is about
 * without paying for its body: the page outline and `compact` output.
 * Returns '' for empty or non-string content.
 */
export function firstLineSnippet(content: unknown, max: number = SNIPPET_MAX_CHARS): string {
  // Stryker disable next-line StringLiteral
  if (typeof content !== 'string') return '';
  const line = content.split('\n').map(l => l.trim()).find(l => l !== '') ?? '';
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}
