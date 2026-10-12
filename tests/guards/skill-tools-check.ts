import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * The checker behind tests/guards/skill-tools.test.ts (#486), kept out of the test file so another guard can reuse it
 * (#503 checks the live docs the same way) without importing a test file, which would run that file's describe blocks.
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
const CHECKED_KEYWORDS = ['type', 'enum', 'anyOf', 'minimum', 'maximum', 'minLength', 'maxLength'];
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
      default:
        return false;
    }
  });
  if (!types.every(t => ['string', 'integer', 'number', 'boolean', 'null'].includes(t))) {
    return `the schema type ${JSON.stringify(schema.type)} is not a primitive, which this guard cannot check`;
  }
  if (!typeOk) return `expected ${types.join(' or ')}, got ${value === null ? 'null' : typeof value}`;
  if (schema.enum && !schema.enum.includes(value)) {
    return `${JSON.stringify(value)} is not one of ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${value} is below the minimum of ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${value} is above the maximum of ${schema.maximum}`;
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

/** Every violation of the four rules over `files`, each as `file:line: message`. Empty when the skills are clean. */
export function skillViolations(files: SkillFile[], tools: RecordedTool[], options: CheckOptions): string[] {
  const known = new Map(tools.map(t => [t.name, t]));
  const out: string[] = [];
  const examples = new Map<string, number>();
  const sections = new Set<string>();

  for (const { path, text } of files) {
    const lines = text.split('\n');
    let open: Fence | null = null;
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = lines[i];

      for (const token of tokensOf(line)) {
        if (!known.has(token)) {
          out.push(`${path}:${lineNo}: "${token}" is not a tool in tool-list.json`);
        }
      }

      if (options.referencePaths.includes(path) && open === null) {
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
      for (let k = i + 1; k <= j; k++) {
        for (const t of tokensOf(lines[k])) {
          if (!known.has(t)) out.push(`${path}:${k + 1}: "${t}" is not a tool in tool-list.json`);
        }
      }
      i = j;
      open = null;
    }
  }

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

export function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

