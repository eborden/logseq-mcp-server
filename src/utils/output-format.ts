/**
 * Output format of a tool result (#43). `json` is the default and stays what it
 * always was; `markdown` is the shared renderer's plain text (see `markdown.ts`).
 * The `format` argument is parsed by the tools' zod schemas (`src/tool-args.ts`, #60).
 */
export type OutputFormat = 'markdown' | 'json';

export const OUTPUT_FORMATS: readonly OutputFormat[] = ['json', 'markdown'];
