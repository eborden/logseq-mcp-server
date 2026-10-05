import { InvalidParameterError } from '../errors.js';

/**
 * Output format of a tool result (#43). `json` is the default and stays what it
 * always was; `markdown` is the shared renderer's plain text (see `markdown.ts`).
 */
export type OutputFormat = 'markdown' | 'json';

export const OUTPUT_FORMATS: readonly OutputFormat[] = ['json', 'markdown'];

/**
 * The `format` argument as an {@link OutputFormat}: absent means `json`, anything
 * but `"json"` or `"markdown"` is an error rather than a silent fallback.
 */
export function parseFormat(value: unknown): OutputFormat {
  if (value === undefined || value === null) return 'json';
  if (value === 'json' || value === 'markdown') return value;
  throw new InvalidParameterError('format', JSON.stringify(value), 'either "json" (default) or "markdown"', 'format: "markdown"');
}

/** The `compact` argument as a boolean: absent means false, a non-boolean is an error. */
export function parseCompact(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  throw new InvalidParameterError('compact', JSON.stringify(value), 'true or false', 'compact: true');
}
