// A minimal block-YAML reader for the workflow guards. No YAML parser is a dependency, and adding one for a few small
// files isn't worth it, so this reads the workflows with what they use: `key: value` maps nested by indentation, block
// lists (`- item`), inline lists (`[a, b]`), quoted scalars, comments and block scalars (`run: |`, kept as their
// dedented text). An empty flow map (`{}`) reads as an empty map. Anything else it can't read throws, including flow
// maps, anchors, aliases, tags and merge keys, so a workflow rewritten in a form it doesn't know fails the test loudly
// instead of passing it by accident.
//
// This is a copy of the reader in adr-workflow-guards.test.ts (which has its own tests of it), kept apart so that
// file stays untouched while #419 removes its publish.yml guards. Once that lands, that file can import this one.

export interface YamlNode {
  /** The scalar after `key:` or `- `, unquoted, or a block scalar's dedented text. Empty when the value is a nested block. */
  value: string;
  /** Child keys in order. Duplicates throw. */
  map: Map<string, YamlNode>;
  /** Block list items (`- x`) directly under this node. */
  items: YamlNode[];
  line: number;
}

const newNode = (value: string, line: number): YamlNode => ({ value, map: new Map(), items: [], line });

function unquote(raw: string): string {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

/** Drop a trailing ` # comment` that isn't inside quotes. */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

/**
 * A plain or quoted scalar from `key: value` or `- value`. `{}` reads as an empty
 * map (returned as ''). A value starting with `{`, `&`, `*` or `!` throws.
 */
function scalarValue(raw: string, lineNo: number): string {
  const s = raw.trim();
  if (s === '{}') return '';
  if (/^[{&*!]/.test(s)) {
    throw new Error(`Can't read line ${lineNo}: flow maps, anchors, aliases and tags aren't supported ("${s}")`);
  }
  return unquote(s);
}

/** Split `key: value` (or `key:`). Returns null when the text is not a mapping entry. */
function splitKey(text: string): { key: string; value: string } | null {
  const m = /^("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(text);
  return m ? { key: unquote(m[1]), value: m[2] ?? '' } : null;
}

export function parseWorkflowYaml(source: string): YamlNode {
  const root = newNode('', 0);
  // Each open block: the node it fills, the indent of its entries (-1 until the first one sets
  // it) and the indent of the line that opened it. An entry must sit deeper than that line,
  // except a block list under a key, which YAML allows at the key's own indent.
  type Block = { node: YamlNode; indent: number; opener: number; listAtOpener?: boolean };
  const stack: Block[] = [{ node: root, indent: 0, opener: -1 }];
  const closes = (block: Block, indent: number, isItem: boolean) =>
    block.indent === -1
      ? indent < block.opener || (indent === block.opener && !(isItem && block.listAtOpener))
      : indent < block.indent || (indent === block.opener && !isItem); // a list at its key's indent ends at the next key
  const lines = source.split('\n');
  // An open `|` or `>` scalar: the indent of its key and the node that receives its lines.
  let blockScalar: { indent: number; node: YamlNode; lines: string[] } | null = null;
  const closeBlockScalar = () => {
    if (!blockScalar) return;
    const body = blockScalar.lines;
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
    const pad = Math.min(...body.filter(l => l.trim() !== '').map(l => l.length - l.trimStart().length));
    blockScalar.node.value = body.map(l => l.slice(Number.isFinite(pad) ? pad : 0)).join('\n');
    blockScalar = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const indent = raw.length - raw.trimStart().length;
    if (blockScalar) {
      if (raw.trim() === '' || indent > blockScalar.indent) {
        blockScalar.lines.push(raw); // text of a `|` or `>` scalar
        continue;
      }
      closeBlockScalar();
    }
    if (raw.trim() === '') continue;
    if (raw.slice(0, indent).includes('\t')) throw new Error(`Tab indentation on line ${lineNo}`);
    if (raw.trimStart().startsWith('#')) continue;

    const isItem = /^-(?:\s|$)/.test(raw.trimStart());
    while (stack.length > 1 && closes(stack[stack.length - 1], indent, isItem)) stack.pop();
    let top = stack[stack.length - 1];
    if (top.indent === -1) top.indent = indent;
    if (indent !== top.indent) throw new Error(`Unexpected indentation on line ${lineNo}: ${raw.trim()}`);

    let text = stripComment(raw.trimStart());
    let entryIndent = indent;
    let owner = top.node;

    if (text === '-' || text.startsWith('- ')) {
      if (owner.map.size > 0) throw new Error(`Can't read line ${lineNo}: a list item among map keys`);
      const item = newNode('', lineNo);
      owner.items.push(item);
      const rest = text.slice(1).trimStart();
      if (rest === '') {
        stack.push({ node: item, indent: -1, opener: indent });
        continue;
      }
      const kv = splitKey(rest);
      if (!kv) {
        item.value = scalarValue(rest, lineNo);
        continue;
      }
      // `- key: value` opens a map whose further keys sit at the indent of `key`.
      entryIndent = indent + (text.length - rest.length);
      stack.push({ node: item, indent: entryIndent, opener: indent });
      owner = item;
      text = rest;
    }

    const kv = splitKey(text);
    if (!kv) throw new Error(`Can't read line ${lineNo}: ${raw.trim()}`);
    if (owner.items.length > 0) throw new Error(`Can't read line ${lineNo}: a map key among list items`);
    if (owner.map.has(kv.key)) throw new Error(`Duplicate key "${kv.key}" on line ${lineNo}`);
    const child = newNode('', lineNo);
    owner.map.set(kv.key, child);
    const value = /^[|>][+-]?\d*$/.test(kv.value) ? kv.value : scalarValue(kv.value, lineNo);
    if (value === '') {
      stack.push({ node: child, indent: -1, opener: entryIndent, listAtOpener: true });
    } else if (/^[|>][+-]?\d*$/.test(value)) {
      blockScalar = { indent: entryIndent, node: child, lines: [] };
    } else {
      child.value = value;
    }
  }
  closeBlockScalar();
  return root;
}

export function at(node: YamlNode, ...path: string[]): YamlNode {
  let current = node;
  for (const [i, key] of path.entries()) {
    const next = current.map.get(key);
    if (!next) throw new Error(`Workflow has no "${path.slice(0, i + 1).join('.')}"`);
    current = next;
  }
  return current;
}

/** A list written either inline (`[22, 24]`) or as block items. */
export function listOf(node: YamlNode): string[] {
  if (node.items.length > 0) return node.items.map(item => item.value);
  const inline = /^\[(.*)\]$/.exec(node.value);
  if (!inline) throw new Error(`Expected a list on line ${node.line}, got "${node.value}"`);
  return inline[1].split(',').map(unquote).filter(v => v !== '');
}

/**
 * The trigger keys of a workflow. `on` may be a map, an inline list or a single
 * event name. YAML 1.1 reads a bare `on` key as `true`, so that spelling counts too.
 */
export function triggers(workflow: YamlNode): string[] {
  const keys = ['on', 'true'].filter(k => workflow.map.has(k));
  if (keys.length !== 1) throw new Error(`Expected exactly one "on" key, found ${keys.length}`);
  const on = workflow.map.get(keys[0])!;
  if (on.map.size > 0) return [...on.map.keys()];
  if (on.value.startsWith('[')) return listOf(on);
  return on.value === '' ? [] : [on.value];
}

/** A job's `if:` condition with any `${{ }}` wrapper removed. */
export function jobCondition(job: YamlNode): string | undefined {
  const raw = job.map.get('if')?.value;
  if (raw === undefined) return undefined;
  const wrapped = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(raw);
  return (wrapped ? wrapped[1] : raw).trim();
}
