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

/**
 * The two client methods, reached any way a file can reach them: `client.callAPI(...)`, a call whose
 * `(` or `.` sits on a later line (`client\n  .callAPI<\n    T\n  >(...)`), `.bind`, `client['callAPI']`
 * and `const { callAPI } = client`. The scan is over the whole file text, comments blanked, because a
 * formatter wraps a long generic across lines.
 */
const CLIENT_METHOD = '(?:callAPI|executeDatalogQuery)';
const BYPASS = [
  new RegExp(`\\.\\s*${CLIENT_METHOD}\\b`), // client.callAPI, client\n.callAPI, client.callAPI.bind, client?.callAPI
  new RegExp(`\\[\\s*['"\`]${CLIENT_METHOD}['"\`]\\s*\\]`), // client['callAPI']
  new RegExp(`\\{[^{}]*\\b${CLIENT_METHOD}\\b[^{}]*\\}\\s*=`), // const { callAPI } = client
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** `source` with block and line comments blanked (newlines kept, so line numbers stay right). */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (_match, before: string) => before);
}

/** The lines where the source reaches the client's methods directly. */
function directCalls(source: string): number[] {
  const code = withoutComments(source);
  const lines = new Set<number>();
  for (const pattern of BYPASS) {
    for (const match of code.matchAll(new RegExp(pattern.source, 'g'))) {
      const at = match.index! + match[0].search(/\S/);
      lines.add(code.slice(0, at).split('\n').length);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

describe('LogSeq responses are read through the schemas (#202)', () => {
  it('no tool or utility reaches client.callAPI or client.executeDatalogQuery directly', () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter(path => !ALLOWED.has(relative(SRC_DIR, path)))
      .flatMap(path => directCalls(readFileSync(path, 'utf8')).map(line => `${relative(SRC_DIR, path)}:${line}`));

    expect(offenders, 'read the response with callParsed / queryParsed and a schema from src/response-schemas.ts').toEqual([]);
  });

  it('notices a direct call, with or without a type argument', () => {
    expect(directCalls("const x = await client.callAPI<PageEntity | null>('m', []);")).toEqual([1]);
    expect(directCalls('rows = await this.client.executeDatalogQuery(query, ...inputs);')).toEqual([1]);
  });

  it('notices a call wrapped across lines, the way a formatter wraps a long generic', () => {
    expect(directCalls('const x = await client.callAPI<\n  Array<[PageEntity, BlockEntity[]]> | null\n>(\n  method\n);')).toEqual([1]);
    expect(directCalls('const x = await client\n  .executeDatalogQuery<\n    Row[]\n  >(query);')).toEqual([2]);
    expect(directCalls('const x = await client?.\n  callAPI(method);')).toEqual([1]);
  });

  it('notices a reference that is not a call: bind, an index, a destructuring', () => {
    expect(directCalls('const call = client.callAPI.bind(client);')).toEqual([1]);
    expect(directCalls("await client['callAPI'](method);")).toEqual([1]);
    expect(directCalls('const {\n  callAPI,\n  other\n} = client;')).toEqual([1]);
  });

  it('ignores a mention in a comment, and says which line a hit is on', () => {
    expect(directCalls('/**\n * `client.callAPI(method)` is what this wraps\n */\n// client.callAPI(x)\n/* client\n .callAPI() */')).toEqual([]);
    expect(directCalls('const a = 1;\n\nawait client.callAPI(m);')).toEqual([3]);
  });
});
