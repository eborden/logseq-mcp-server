import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * The checker behind tests/guards/skill-tools.test.ts (#486), kept out of the test file so another guard can reuse it
 * (#503 checks the live docs the same way, through `docViolations`) without importing a test file, which would run that file's describe blocks.
 * No vitest import and no path to the skills: `skillViolations` takes files already read, and the guard that calls it
 * owns the constants (the tool reference, the minimum examples, the allowances).
 */

export type Schema = {
  type?: string | string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: Schema;
  anyOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  /** Any other keyword: schemaMismatch reports the ones it cannot check. */
  [keyword: string]: unknown;
};
export type RecordedTool = { name: string; inputSchema?: Schema };
export type SkillFile = { path: string; text: string };

// An optional host prefix (`mcp__logseq__`, `mcp__plugin_logseq_logseq__`) and then the bare tool name. The prefix is
// matched lazily up to the first `__logseq_`, so it is never read as part of the name.
const TOOL_TOKEN = /(?:mcp__[A-Za-z0-9_-]+?__)?(logseq_[a-z0-9_]+)/g;
const HEADING = /^#{1,6}\s+(.*)$/;
// A section heading is exactly the tool name, in backticks or not, with or without a host prefix.
const SECTION_HEADING = /^`?(?:mcp__[A-Za-z0-9_-]+?__)?(logseq_[a-z0-9_]+)`?$/;
// An opening fence is three or more backticks or tildes; it closes on the same character, at least as long, and bare.
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
type Fence = { char: string; length: number };
const closes = (line: string, open: Fence): boolean => {
  const m = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  return m !== null && m[1][0] === open.char && m[1].length >= open.length;
};
const EXAMPLE_INFO = /^json\s+tool=(\S+)\s*$/;

const tokensOf = (line: string): string[] => [...line.matchAll(TOOL_TOKEN)].map(m => m[1]);

// Keywords schemaMismatch checks, and the ones that say nothing about a value. Any other keyword is reported, so a
// constraint added to a recorded schema later cannot pass unchecked.
const CHECKED_KEYWORDS = ['type', 'enum', 'anyOf', 'minimum', 'maximum', 'minLength', 'maxLength', 'items', 'minItems', 'maxItems'];
const IGNORED_KEYWORDS = ['description', 'default', 'title', 'format', '$schema'];

/** Why `value` doesn't match `schema`, or null. Supports what the recorded schemas use; anything else is reported. */
export function schemaMismatch(value: unknown, schema: Schema): string | null {
  const unknown = Object.keys(schema).filter(k => !CHECKED_KEYWORDS.includes(k) && !IGNORED_KEYWORDS.includes(k));
  if (unknown.length > 0) return `the schema uses ${unknown.map(k => `"${k}"`).join(', ')}, which this guard cannot check`;
  if (schema.anyOf) {
    const reasons = schema.anyOf.map(s => schemaMismatch(value, s));
    return reasons.some(r => r === null) ? null : `matches none of the allowed types (${reasons.join('; ')})`;
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length === 0) return 'the schema has no type, which this guard cannot check';
  const typeOk = types.some(t => {
    switch (t) {
      case 'string':
        return typeof value === 'string';
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'number':
        return typeof value === 'number';
      case 'boolean':
        return typeof value === 'boolean';
      case 'null':
        return value === null;
      case 'array':
        return Array.isArray(value);
      default:
        return false;
    }
  });
  if (!types.every(t => ['string', 'integer', 'number', 'boolean', 'null', 'array'].includes(t))) {
    return `the schema type ${JSON.stringify(schema.type)} is not a primitive or an array, which this guard cannot check`;
  }
  if (!typeOk) return `expected ${types.join(' or ')}, got ${value === null ? 'null' : typeof value}`;
  if (schema.enum && !schema.enum.includes(value)) {
    return `${JSON.stringify(value)} is not one of ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${value} is below the minimum of ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${value} is above the maximum of ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    // An array is checked by its length and by each item against `items`; without `items` it is not checked at all
    if (!schema.items) return 'the array schema has no items, which this guard cannot check';
    if (schema.minItems !== undefined && value.length < schema.minItems) return `the array has ${value.length} items, below the minItems of ${schema.minItems}`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `the array has ${value.length} items, above the maxItems of ${schema.maxItems}`;
    for (const [index, item] of value.entries()) {
      const reason = schemaMismatch(item, schema.items);
      if (reason !== null) return `item ${index}: ${reason}`;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `the string has ${value.length} characters, below the minLength of ${schema.minLength}`;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `the string has ${value.length} characters, above the maxLength of ${schema.maxLength}`;
    }
  }
  return null;
}

/** Violations for one `json tool=<name>` example. `line` is the line of the opening fence. */
function exampleViolations(file: string, line: number, body: string[], tool: RecordedTool): string[] {
  const where = (key?: string): string => {
    // The line where `key` is a key: at the start of a line (after an optional opening brace), so an earlier value that
    // equals it is not blamed. A one-line body has no such line, so it falls back to a `"key":` anywhere.
    const quoted = JSON.stringify(key ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const atLineStart = new RegExp(`^\\s*\\{?\\s*${quoted}\\s*:`);
    const anywhere = new RegExp(`${quoted}\\s*:`);
    const found = (re: RegExp): number => body.findIndex(l => re.test(l));
    const offset = key === undefined ? -1 : found(atLineStart) !== -1 ? found(atLineStart) : found(anywhere);
    return `${file}:${offset === -1 ? line : line + 1 + offset}`;
  };
  let args: unknown;
  try {
    args = JSON.parse(body.join('\n'));
  } catch (e) {
    return [`${where()}: the ${tool.name} example is not valid JSON (${(e as Error).message})`];
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return [`${where()}: the ${tool.name} example must be a JSON object of arguments`];
  }
  const schema = tool.inputSchema ?? {};
  const properties = schema.properties ?? {};
  const out: string[] = [];
  for (const key of schema.required ?? []) {
    if (!(key in args)) out.push(`${where()}: the ${tool.name} example is missing the required argument "${key}"`);
  }
  for (const [key, value] of Object.entries(args)) {
    if (!(key in properties)) {
      out.push(`${where(key)}: the ${tool.name} example has an argument "${key}" that is not in its inputSchema`);
      continue;
    }
    const why = schemaMismatch(value, properties[key]);
    if (why) out.push(`${where(key)}: the ${tool.name} argument "${key}" is wrong: ${why}`);
  }
  return out;
}

export type CheckOptions = {
  /** The files whose headings count as the tool reference. Several, so a split by type needs no checker change. */
  referencePaths: readonly string[];
  minExamples: number;
  missingSectionAllowances: readonly string[];
};

/** What the live-docs guard (#503) adds to the shared scan. The skills guard passes neither. */
export type DocOptions = {
  /** Tokens that match `logseq_[a-z0-9_]+` and are not tools (a wheel name, a glob), each with the reason. */
  nonToolTokens: Readonly<Record<string, string>>;
  /**
   * The keyword of the history comment, `<!-- <keyword> logseq_old_name -->`. The comment names the tool names it
   * excuses on its own line (a "was `x` before v2" note) and nothing else, so a typo next to it is still caught.
   */
  historyMarker: string;
  /**
   * Every bare tool name (no `logseq_` prefix) a doc may once have used, as the first-version tools: `get_page`, not
   * `logseq_get_page`. A token that equals one of them (a whole word, and not part of a path) must be a tool in the recorded
   * list with the prefix added, or sit on a line whose history comment names it (#510). The list never shrinks, since a
   * rename removes the old name from the recorded list and that is when a stale mention has to be caught.
   */
  formerToolNames: readonly string[];
  /**
   * Text that holds a former tool name and is not about the tool (a Rust function of the same name), each with the
   * reason. The name inside the text is skipped, other text on the line is still checked. An entry no doc uses, or one
   * with no former tool name in it, is an error.
   */
  bareContexts: Readonly<Record<string, string>>;
  /**
   * The tool directory paths of the docs (#520). Off when absent (the skills guard passes none). A path that starts
   * `rust/src/tools/` (or `src/tools/`) must name what exists under the tools directory, and so must every `name/`
   * entry in the file-map row of rust/README.md. A rename of a tool's directory then fails on the doc that still says
   * the old one, unless that line carries the history comment naming the old directory.
   */
  toolPaths?: ToolPathOptions;
};

export type ToolPathOptions = {
  /** What `rel`, a path relative to rust/src/tools (`get_page/outline`, `get_page/mod.rs`), is on disk, or null. */
  kindOf: (rel: string) => 'dir' | 'file' | null;
  /** The file-map row: the doc it is in and the text its line starts with. Its `name/` entries are directory names. */
  fileMap: { path: string; rowStart: string };
};

const markerPattern = (keyword: string): RegExp =>
  new RegExp(`<!--\\s*${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}((?:\\s+[A-Za-z0-9_]+)*)\\s*-->`);

// `rust/src/tools/<path>` or, inside rust/README.md, `src/tools/<path>`. The path runs to the first character a path does
// not hold, so a placeholder (`<name>`) or a backtick ends it, and a sentence's closing dot is cut off after the match.
const TOOLS_PATH = /(?<![A-Za-z0-9_./-])(?:rust\/)?src\/tools\/([A-Za-z0-9_./-]*)/g;
// A code span that is only a directory name with its slash, `get_page/` or `get_page/outline/`: an entry of the file map.
const DIR_ENTRY = /`([a-z0-9_]+(?:\/[a-z0-9_]+)*)\/`/g;

type MissingPath = { name: string; message: string };

/** The tool paths on one line (outside its history comment) that do not exist, each with the name a comment excuses. */
function missingToolPaths(file: string, line: number, text: string, options: ToolPathOptions, inFileMap: boolean): MissingPath[] {
  const found = new Map<string, MissingPath>();
  const check = (written: string, rest: string, trailingSlash: boolean): void => {
    const parts = rest.split('/').filter(part => part !== '');
    for (let i = 0; i < parts.length; i++) {
      // `.` and `..` are not names; stop rather than guess where the path goes.
      if (/^\.+$/.test(parts[i])) return;
      const rel = parts.slice(0, i + 1).join('/');
      const last = i === parts.length - 1;
      const wantsFile = last && !trailingSlash && /\.[A-Za-z0-9]+$/.test(parts[i]);
      const kind = options.kindOf(rel);
      // A name with an extension is a file. A name that ends the path with no slash and no extension may be either.
      const ok = wantsFile ? kind === 'file' : last && !trailingSlash ? kind !== null : kind === 'dir';
      if (ok) continue;
      const what = wantsFile ? 'file' : 'directory';
      // One report per missing path per line: the first way the line wrote it.
      if (!found.has(rel)) found.set(rel, {
        name: parts[i].replace(/\.[A-Za-z0-9]+$/, ''),
        message: `${file}:${line}: "${written}" names the ${what} rust/src/tools/${rel}${what === 'directory' ? '/' : ''}, which does not exist`,
      });
      return;
    }
  };
  for (const m of text.matchAll(TOOLS_PATH)) {
    const rest = m[1].replace(/[.,:;]+$/, '');
    check(`${m[0].slice(0, m[0].length - m[1].length)}${rest}`, rest, rest.endsWith('/'));
  }
  if (inFileMap) {
    for (const m of text.matchAll(DIR_ENTRY)) check(m[0].slice(1, -1), m[1], true);
  }
  return [...found.values()];
}

type Scan = {
  out: string[];
  examples: Map<string, number>;
  sections: Set<string>;
  usedNonTool: Set<string>;
  usedContexts: Set<string>;
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A former tool name is a whole word, not inside a longer identifier. One that touches a `/` is read by `inPath` below.
// `flags` is 'g' to walk every match; a test() on a global regex keeps lastIndex between calls, so a one-shot check passes ''.
const bareNamePattern = (names: readonly string[], flags: string): RegExp | null =>
  names.length === 0 ? null : new RegExp(`(?<![A-Za-z0-9_])(${[...names].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?![A-Za-z0-9_])`, flags);

/**
 * Whether the name at `index` in `text` is part of a path or a directory name (`src/tools/get_page/`, `get_page/`),
 * which the rename of a tool does not have to touch. A name that touches no `/` is never a path. One that does is a
 * path unless the run around it is only former tool names (`get_page/get_block`, a pair written with a slash), which
 * is prose and is checked.
 */
function inPath(text: string, index: number, length: number, former: ReadonlySet<string>): boolean {
  if (text[index - 1] !== '/' && text[index + length] !== '/') return false;
  const stop = /[\s`'",;()|[\]{}]/;
  let from = index;
  while (from > 0 && !stop.test(text[from - 1])) from--;
  let to = index + length;
  while (to < text.length && !stop.test(text[to])) to++;
  const segments = text.slice(from, to).replace(/[.:!?]+$/, '').split('/').filter(part => part !== '');
  return !(segments.length >= 2 && segments.every(part => former.has(part)));
}

/** Every file's token, info-string and example violations, plus what the skill-only rules count (sections, examples). */
function scan(files: SkillFile[], known: Map<string, RecordedTool>, referencePaths: readonly string[], doc?: DocOptions): Scan {
  const out: string[] = [];
  const examples = new Map<string, number>();
  const sections = new Set<string>();
  const usedNonTool = new Set<string>();
  const usedContexts = new Set<string>();
  const bareName = doc ? bareNamePattern(doc.formerToolNames, 'g') : null;
  const former = new Set(doc?.formerToolNames ?? []);
  // A name is a tool when it is recorded as written (`logseq_x`) or, bare, with the prefix added.
  const isTool = (name: string): boolean => known.has(name) || known.has(`logseq_${name}`);

  for (const { path, text } of files) {
    // A file saved with CRLF endings would leave a `\r` on every line, which defeats the fence and heading patterns.
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    // Unknown names on one line. A non-tool token is skipped (and counted as used). A history comment names the unknown
    // tool names it excuses; only those are skipped. A comment with no name, a name that is a real tool and a name that
    // is not on the line (outside the comment) are errors, so a stale marker cannot linger.
    const checkTokens = (line: string, lineNo: number): void => {
      const marker = doc ? markerPattern(doc.historyMarker).exec(line) : null;
      const named = marker ? marker[1].split(/\s+/).filter(n => n !== '') : [];
      const bad: string[] = [];
      const body = marker ? line.replace(marker[0], '') : line;
      for (const token of tokensOf(body)) {
        if (known.has(token)) continue;
        if (doc && token in doc.nonToolTokens) usedNonTool.add(token);
        else bad.push(token);
      }
      if (doc && bareName) {
        // Blank out the prefixed tokens (their bare tail is checked above) and the reviewed contexts, then read the rest.
        let rest = body.replace(TOOL_TOKEN, m => ' '.repeat(m.length));
        for (const context of Object.keys(doc.bareContexts)) {
          if (rest.includes(context)) {
            usedContexts.add(context);
            rest = rest.split(context).join(' '.repeat(context.length));
          }
        }
        for (const m of rest.matchAll(bareName)) {
          // One report per name per line: a bare name is often listed twice in a row of a table or a sentence.
          if (!isTool(m[1]) && !bad.includes(m[1]) && !inPath(rest, m.index, m[1].length, former)) bad.push(m[1]);
        }
      }
      // Tool paths that name a directory or file that is not there (#520). A history comment excuses the directory name.
      const fileMap = doc?.toolPaths?.fileMap;
      const missing =
        doc?.toolPaths && fileMap
          ? missingToolPaths(path, lineNo, body, doc.toolPaths, path === fileMap.path && line.startsWith(fileMap.rowStart))
          : [];
      if (doc && marker) {
        const comment = `<!-- ${doc.historyMarker} logseq_old_name -->`;
        if (named.length === 0) out.push(`${path}:${lineNo}: the history comment must name the tool names it excuses, as ${comment}`);
        for (const name of named) {
          if (isTool(name)) out.push(`${path}:${lineNo}: "${name}" is a tool in tool-list.json, so remove it from the history comment`);
          else if (!bad.includes(name) && !missing.some(m => m.name === name)) {
            // A bare name outside the former list is never read bare, so the line cannot name it. Say that, not "not on the line".
            out.push(
              !name.startsWith('logseq_') && !doc.formerToolNames.includes(name)
                ? `${path}:${lineNo}: "${name}" is not in FORMER_TOOL_NAMES, so the guard never reads it bare; name it with the logseq_ prefix or add it to the list`
                : `${path}:${lineNo}: "${name}" is not named on this line, so remove it from the history comment`,
            );
          }
        }
      }
      for (const token of bad) {
        if (named.includes(token)) continue;
        // A bare name is read as the tool with the prefix added, so the message says which tool is missing.
        const how = token.startsWith('logseq_') ? '' : `, as logseq_${token} (it is written without the prefix)`;
        out.push(`${path}:${lineNo}: "${token}" is not a tool in tool-list.json${how}`);
      }
      for (const m of missing) if (!named.includes(m.name)) out.push(m.message);
    };
    let open: Fence | null = null;
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = lines[i];

      checkTokens(line, lineNo);

      if (referencePaths.includes(path) && open === null) {
        const heading = HEADING.exec(line);
        if (heading) {
          const section = SECTION_HEADING.exec(heading[1].trim());
          if (section) sections.add(section[1]);
        }
      }

      if (open !== null) {
        if (closes(line, open)) open = null;
        continue;
      }
      const fence = FENCE.exec(line);
      if (!fence) continue;
      open = { char: fence[1][0], length: fence[1].length };
      const info = fence[2].trim();
      // Any fence that says `tool=` or `tools=` (any case, any language), or starts with json and names a tool, is an attempt at an example: it has to be
      // written exactly, or it would be skipped without a word.
      if (!/tools?=/i.test(info) && !(/^json/i.test(info) && tokensOf(info).length > 0)) continue;
      const example = EXAMPLE_INFO.exec(info);
      if (!example) {
        out.push(`${path}:${lineNo}: the info string "${info}" must be exactly "json tool=logseq_<name>"`);
        continue;
      }
      // Find the closing fence of this block.
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !closes(lines[j], open)) body.push(lines[j++]);
      if (j >= lines.length) {
        out.push(`${path}:${lineNo}: the ${example[1]} example has no closing fence`);
        continue;
      }
      const [token] = tokensOf(example[1]);
      const tool = token && known.get(token);
      if (!tool) {
        // A well-formed but unknown name was reported by the token rule when the info string line was scanned.
        if (!token) out.push(`${path}:${lineNo}: tool=${example[1]} is not a logseq_ tool name`);
      } else {
        examples.set(tool.name, (examples.get(tool.name) ?? 0) + 1);
        out.push(...exampleViolations(path, lineNo, body, tool));
      }
      // Skip the body and the closing fence: they are not scanned for fences again, but they are scanned for tokens.
      for (let k = i + 1; k <= j; k++) checkTokens(lines[k], k + 1);
      i = j;
      open = null;
    }
  }
  return { out, examples, sections, usedNonTool, usedContexts };
}

/** Every violation of the four rules over `files`, each as `file:line: message`. Empty when the skills are clean. */
export function skillViolations(files: SkillFile[], tools: RecordedTool[], options: CheckOptions): string[] {
  const known = new Map(tools.map(t => [t.name, t]));
  const { out, examples, sections } = scan(files, known, options.referencePaths);

  for (const tool of tools) {
    if (!sections.has(tool.name) && !options.missingSectionAllowances.includes(tool.name)) {
      out.push(`${options.referencePaths.join(', ')}: no section heading for ${tool.name}`);
    }
    if (sections.has(tool.name) && options.missingSectionAllowances.includes(tool.name)) {
      out.push(`${options.referencePaths.join(', ')}: ${tool.name} now has a heading, so delete it from MISSING_SECTION_ALLOWANCES`);
    }
    const count = examples.get(tool.name) ?? 0;
    if (count < options.minExamples) {
      out.push(`${tool.name} has ${count} "json tool=${tool.name}" examples, the minimum is ${options.minExamples}`);
    }
  }
  for (const name of options.missingSectionAllowances) {
    if (!known.has(name)) out.push(`MISSING_SECTION_ALLOWANCES names "${name}", which is not a tool in tool-list.json`);
  }
  return out;
}

/**
 * The live-docs rules (#503): the token rule and the example rule of the skills guard, over docs that have no tool
 * reference (no section or minimum-example rule). A `nonToolTokens` entry that no file uses, or that names a real tool,
 * is an error, so the list cannot outlive the text it excuses.
 */
export function docViolations(files: SkillFile[], tools: RecordedTool[], options: DocOptions): string[] {
  const known = new Map(tools.map(t => [t.name, t]));
  const { out, usedNonTool, usedContexts } = scan(files, known, [], options);
  for (const token of Object.keys(options.nonToolTokens)) {
    if (known.has(token)) out.push(`NON_TOOL_TOKENS names "${token}", which is a tool in tool-list.json, so delete it`);
    else if (!usedNonTool.has(token)) out.push(`NON_TOOL_TOKENS names "${token}", which no live doc uses, so delete it`);
  }
  const fileMap = options.toolPaths?.fileMap;
  if (fileMap) {
    // The file-map check must not switch itself off: the row has to be there, once, and list at least one directory.
    const doc = files.find(f => f.path === fileMap.path);
    const rows = (doc?.text ?? '').replace(/\r\n?/g, '\n').split('\n').filter(l => l.startsWith(fileMap.rowStart));
    if (rows.length !== 1) out.push(`${fileMap.path}: expected one file-map row starting ${fileMap.rowStart}, found ${rows.length}`);
    else if ([...rows[0].matchAll(DIR_ENTRY)].length === 0) out.push(`${fileMap.path}: the file-map row lists no \`name/\` directory, so the check has nothing to read`);
  }
  const holdsName = bareNamePattern(options.formerToolNames, '');
  for (const context of Object.keys(options.bareContexts)) {
    if (!holdsName || !holdsName.test(context)) out.push(`BARE_CONTEXTS names "${context}", which holds no former tool name, so delete it`);
    else if (!usedContexts.has(context)) out.push(`BARE_CONTEXTS names "${context}", which no live doc uses, so delete it`);
  }
  return out;
}

export function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

