import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

// Every LogSeq response a tool reads is checked against a schema first (#202, foundations 4.2):
// tools call `callParsed` / `queryParsed` (src/utils/parse-response.ts), never the client's
// `callAPI` / `executeDatalogQuery` directly, which hand back whatever LogSeq sent.

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

/** The client itself, and the helpers that wrap it. */
const ALLOWED = new Set(['client.ts', join('utils', 'parse-response.ts')]);

const DIRECT_CALL = /\.\s*(?:callAPI|executeDatalogQuery)\s*(?:<[^>]*>)?\s*\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Lines that call the client, not counting comments. */
function directCalls(source: string): number[] {
  const hits: number[] = [];
  source.split('\n').forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
    if (DIRECT_CALL.test(code.replace(/\/\/.*$/, ''))) hits.push(i + 1);
  });
  return hits;
}

describe('LogSeq responses are read through the schemas (#202)', () => {
  it('no tool or utility calls client.callAPI or client.executeDatalogQuery directly', () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter(path => !ALLOWED.has(relative(SRC_DIR, path)))
      .flatMap(path => directCalls(readFileSync(path, 'utf8')).map(line => `${relative(SRC_DIR, path)}:${line}`));

    expect(offenders, 'read the response with callParsed / queryParsed and a schema from src/response-schemas.ts').toEqual([]);
  });

  it('notices a direct call, with or without a type argument', () => {
    expect(directCalls("const x = await client.callAPI<PageEntity | null>('m', []);")).toEqual([1]);
    expect(directCalls('rows = await this.client.executeDatalogQuery(query, ...inputs);')).toEqual([1]);
    expect(directCalls(' * `client.callAPI(method)` is what this wraps\n// client.callAPI(x)')).toEqual([]);
  });
});
