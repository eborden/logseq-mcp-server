import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

// The MCP stdio transport uses stdout as its protocol channel, so any write to
// it corrupts the stream (ADR-0004 stderr-only-logging, #82). Log with
// console.error or console.warn instead.

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_DIR = join(SRC_DIR, '..');

// Every console method that writes to stdout, plus process.stdout. console.error,
// console.warn and console.trace go to stderr and stay allowed. `?.` is matched too.
// Not caught (the scan is textual): console['log'], destructuring or aliasing
// (const { log } = console), and fs.writeSync(1, ...).
const FORBIDDEN =
  /\b(?:console\s*(?:\?\.|\.)\s*(?:log|info|debug|table|dir|dirxml|group|groupCollapsed|count|countReset|time|timeEnd|timeLog)|process\s*(?:\?\.|\.)\s*stdout)\b/;

/**
 * Blank out comments and the contents of string literals, keeping every
 * newline so line numbers stay correct. Docs and messages that merely mention
 * console.log are therefore ignored.
 *
 * A small state machine, not a parser: a quote character inside a regex
 * literal can confuse it. Template literals are blanked as plain text,
 * `${...}` expressions included. If a block comment, template literal or
 * string is still open at its end (a newline for ' and "), it throws with the
 * line where it started, so a confused scan fails loudly instead of silently
 * blanking the rest of a file.
 */
export function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  const blank = (ch: string) => (ch === '\n' ? '\n' : ' ');
  const lineAt = (pos: number) => source.slice(0, pos).split('\n').length;
  const unterminated = (what: string, pos: number): never => {
    throw new Error(
      `Unterminated ${what} starting at line ${lineAt(pos)}; the stdout scan cannot tell where code resumes. ` +
        'Simplify that construct (a quote inside a regex literal is the usual cause).'
    );
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (ch === '/' && next === '*') {
      const start = i;
      out += '  ';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += blank(source[i]);
        i++;
      }
      if (i >= n) unterminated('block comment', start);
      out += '  ';
      i += 2;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const start = i;
      out += quote;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\n' && quote !== '`') break;
        if (source[i] === '\\' && i + 1 < n) {
          out += ' ' + blank(source[i + 1]);
          i += 2;
        } else {
          out += blank(source[i]);
          i++;
        }
      }
      if (i >= n || source[i] !== quote) {
        unterminated(quote === '`' ? 'template literal' : 'string', start);
      }
      out += quote;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Return "line N: <source line>" for each forbidden stdout write in `source`. */
export function findStdoutWrites(source: string): string[] {
  const originalLines = source.split('\n');
  return stripCommentsAndStrings(source)
    .split('\n')
    .flatMap((line, idx) =>
      FORBIDDEN.test(line) ? [`line ${idx + 1}: ${originalLines[idx].trim()}`] : []
    );
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('no stdout writes in src (#82)', () => {
  it('finds non-test source files to scan', () => {
    const files = listSourceFiles(SRC_DIR).map((f) => relative(REPO_DIR, f));
    expect(files).toContain('src/index.ts');
    expect(files).toContain('src/client.ts');
    expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);
  });

  it('uses no console.log, console.info, console.debug or process.stdout in non-test source', () => {
    const violations = listSourceFiles(SRC_DIR).flatMap((file) => {
      const name = relative(REPO_DIR, file);
      let hits: string[];
      try {
        hits = findStdoutWrites(readFileSync(file, 'utf-8'));
      } catch (error) {
        throw new Error(`${name}: ${(error as Error).message}`);
      }
      return hits.map((hit) => `${name}: ${hit}`);
    });
    expect(
      violations,
      'stdout is the MCP protocol channel; use console.error (ADR-0004). Found:\n' + violations.join('\n')
    ).toEqual([]);
  });
});

describe('stdout scanner self-test', () => {
  it.each([
    ['console.log', "console.log('hi');"],
    ['console.info', 'console.info(x);'],
    ['console.debug', 'console.debug(x);'],
    ['process.stdout', 'process.stdout.write("x");'],
    ['spaced access', 'console . log(x);'],
    ['code after a block comment', '/* note */ console.log(x);'],
    ['console.table', 'console.table(rows);'],
    ['console.dir', 'console.dir(x);'],
    ['console.group', 'console.group("g");'],
    ['console.groupCollapsed', 'console.groupCollapsed("g");'],
    ['console.count', 'console.count();'],
    ['console.time', 'console.time("t");'],
    ['console.timeEnd', 'console.timeEnd("t");'],
    ['console.timeLog', 'console.timeLog("t");'],
    ['optional chaining', 'console?.log(x);'],
    ['optional chaining on process', 'process?.stdout.write("x");'],
    ['code after a URL string', 'const u = "http://a.b"; console.log(u);'],
  ])('flags %s', (_name, sample) => {
    expect(findStdoutWrites(sample)).toHaveLength(1);
  });

  it('reports the line number of each hit', () => {
    const sample = ['const a = 1;', '', 'console.log(a);', 'process.stdout.write("b");'].join('\n');
    expect(findStdoutWrites(sample).map((h) => h.split(':')[0])).toEqual(['line 3', 'line 4']);
  });

  it('flags a hit on the line after a multi-line block comment', () => {
    const sample = '/*\n * docs\n */\nconsole.log(1);';
    expect(findStdoutWrites(sample)).toEqual(['line 4: console.log(1);']);
  });

  it.each([
    ['console.error', 'console.error("x");'],
    ['console.warn', 'console.warn("x");'],
    ['console.trace (stderr)', 'console.trace("x");'],
    ['a line comment', '// never call console.log here'],
    ['a trailing comment', 'const a = 1; // not process.stdout'],
    ['a block comment', '/* console.log(x)\n process.stdout */'],
    ['a JSDoc line', '/**\n * Use console.log sparingly\n */'],
    ['a string literal', 'const m = "Never write to stdout (console.log)";'],
    ['a template literal', 'const m = `no ${"x"} process.stdout`;'],
    ['an escaped quote in a string', "const m = 'it\\'s console.log';"],
    ['a longer identifier', 'myconsole.logger(x); const stdoutLike = process.stdoutX;'],
  ])('ignores %s', (_name, sample) => {
    expect(findStdoutWrites(sample)).toEqual([]);
  });
});

describe('scanner fails loudly when it loses track (#82)', () => {
  it.each([
    ['an unterminated block comment', 'const a = 1;\n/* never closed\nconsole.log(1);', 'block comment starting at line 2'],
    ['an unterminated template literal', 'const a = `open\nconsole.log(1);', 'template literal starting at line 1'],
    ['an unterminated string', "const a = 1;\nconst r = /'/;\nconsole.log(1);", 'string starting at line 2'],
  ])('throws on %s', (_name, sample, message) => {
    expect(() => findStdoutWrites(sample)).toThrow(message);
  });
});
