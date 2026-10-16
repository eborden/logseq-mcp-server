import { afterAll, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  docViolations,
  exactKindOf,
  type DiskReads,
  FIRST_VERSION_TOOL_NAMES,
  FORMER_TOOL_NAMES,
  REMOVED_BEFORE_V1_TOOL_NAMES,
  type DocOptions,
  type RecordedTool,
  type ToolPathOptions,
} from './skill-tools-check.js';

/**
 * The live docs name only real tools, and their JSON examples validate against the tool's inputSchema (#503, part of #500).
 *
 * The skills guard (tests/guards/skill-tools.test.ts, #486) keeps the skills in step with the recorded tool list,
 * tests/data/parity/tool-list.json. The same drift happens in the docs that name tools, so each rename of the v2
 * plan (#489 to #495) would leave them stale with nothing to catch it. Over every file in LIVE_DOCS, through the checker
 * the skills guard uses (tests/guards/skill-tools-check.ts, no copy of its helpers):
 *   1. every `logseq_[a-z0-9_]+` token names a recorded tool. Host-prefixed forms (`mcp__<server>__logseq_x`) count as
 *      `logseq_x`. A token that matches but is no tool goes in NON_TOOL_TOKENS with its reason, and the entry fails
 *      once no doc uses it;
 *   2. every fenced block (``` or ~~~) whose info string is `json tool=logseq_<name>` parses as a JSON object and
 *      validates against that tool's inputSchema, by the rules of #486 (a fence that says `tool=` any other way is an
 *      error, not a skip).
 * A failure names the file, the line and the bad token or argument.
 *
 * History marker. A passage that names a tool on purpose because the tool is gone says "was", as in "was
 * `logseq_x` before v2". Such a line carries the HTML comment `<!-- guard:history logseq_x -->` (anywhere on the line,
 * invisible when rendered). The comment names the unknown tool names it excuses, and the guard skips exactly those on
 * that line: any other unknown name on the line, such as a typo of a live tool, is still an error. A comment with no
 * name, a name that is a real tool, and a name that is not on the line outside the comment are errors too, so a
 * marker does not outlive the note it excuses. Because of that last rule the comment cannot be quoted literally in a
 * live doc; this header is the only place it is documented. Rename authors: when the sentence is about the current
 * tool (CLAUDE.md names `logseq_get_page_outline` in sentences about it today), update the name to
 * the new one. Add the comment only when the sentence says "was" and the old name is the point.
 *
 * Bare names (#510). Most of the docs name tools without the prefix: the tool tables in README.md, its `Use: name(...)`
 * lines, the status table and prose of CLAUDE.md, the prose of docs/architecture.md. A rename (#489 to #495) leaves each of
 * those stale, so a bare token that equals a first-version tool name (FORMER_TOOL_NAMES, whole word) must be a tool in
 * the recorded list with the prefix added, or sit on a line whose history comment names it
 * (`<!-- guard:history get_old_name -->`, the bare name). A rename PR updates the bare names in step, or the guard fails
 * on the old one. A line that holds both forms, such as "was `get_old_name` (`logseq_old_name`)", needs both names in
 * the comment, since each is its own unknown token. Bare names of tools that were never in FORMER_TOOL_NAMES are not
 * checked, and a marker that names one says so: a tool that is added and later renamed needs its old name appended to
 * the list by the PR that renames it (the list never shrinks).
 *
 * Paths are skipped by the name rules. A name touching a `/` is part of a path unless the run around it is only former
 * tool names, so `src/tools/get_page/mod.rs` and the directory names `get_page/` are skipped, and a pair written
 * `get_page/get_block` is checked. The path rule below reads them instead.
 *
 * Tool paths (#520, part of #500). A rename PR that renames a tool's directory used to leave the docs stale with no
 * failure, since the name rules skip paths. Two things are now read, through the same checker (`toolPaths` of
 * DocOptions):
 *   3. every `src/tools/<path>` must name what exists under
 *      src/tools: each directory of the path, and the file when the path ends in one (`mod.rs`). A `<name>`
 *      placeholder ends the path, so `src/tools/<tool>/mod.rs` is not read past `<`. A nested directory such as
 *      `get_page/outline/` is checked as one;
 *   4. every `name/` entry (a code span that is only a directory) in the file-map row of docs/architecture.md, the row that
 *      starts `| \`src/tools/<tool>/\``, must be a directory under src/tools. The row has to exist once and hold
 *      at least one entry, so the check cannot switch itself off by a rewording.
 * The failure names the doc, the line and the missing directory. A path to a directory that is gone on purpose (a
 * "was" note, such as a mode that lived in a directory before the merge) takes the history comment of the lines
 * above: `<!-- guard:history search_by_relationship -->` excuses the missing directory `search_by_relationship`, and
 * only it. The rules for the comment are the same (a name that is not on the line is an error). The directory name
 * must be in FORMER_TOOL_NAMES for the comment to be read as bare, so a rename PR appends the old name there, as it
 * does for the tool name. A file has no name a comment can hold, so a stale file path is fixed, not excused. The
 * paths are checked in LIVE_DOCS only: an ADR keeps the path it was written with.
 *
 * A bare name that is no tool reference, such as the Rust function of the same name, goes in BARE_CONTEXTS as the text
 * around it with its reason. Measured on the live docs before this check: 135 bare uses, 24 in paths (the 14 and the
 * 10 above), 1 that is no tool reference (the Rust function in CLAUDE.md), the rest tool references.
 *
 * What a green run does NOT mean: that the docs are right about a tool. It means each name is real. The guard does not
 * read a tool's description in a table row, prose counts such as "16 tools", API call counts, or a name that was
 * never a first-version tool.
 *
 * Not checked, on purpose: CHANGELOG.md, docs/adr/ and docs/business-rules/ are history (ADRs are immutable once
 * accepted), so they are not in the list. Prose claims such as a tool count ("16 tools") or an API call count are a
 * separate drift this guard doesn't read.
 *
 * docs/architecture-foundations.md is in the list: it names `logseq_search_blocks` as its example and is not history.
 */

const ROOT = new URL('../../', import.meta.url);
const TOOL_LIST_FILE = new URL('tests/data/parity/tool-list.json', ROOT);

/** The live docs that name tools, relative to the repo root. A new live doc is one more line here. */
const LIVE_DOCS: readonly string[] = [
  'README.md',
  'CLAUDE.md',
  'docs/architecture-foundations.md',
  'docs/tools.md',
  'docs/configuration.md',
  'docs/plugin.md',
  'docs/development.md',
  'docs/releasing.md',
  'docs/architecture.md',
  'docs/testing.md',
  'docs/logseq-behaviour.md',
  'docs/tool-behaviour.md',
];

/** The keyword of the comment that excuses the unknown tool names it lists. Documented in the header above. */
const HISTORY_MARKER = 'guard:history';

/** Tokens that match `logseq_[a-z0-9_]+` and are not tools. The reason sits on each entry. */
const NON_TOOL_TOKENS: Readonly<Record<string, string>> = {
  // The wheel's file name, `logseq_mcp_server-<version>-py3-none-<platform>.whl` (README, release steps).
  logseq_mcp_server: 'the PyPI wheel file name, not a tool',
  // The glob `mcp__plugin_logseq_logseq__logseq_*` (README). The `*` leaves no tool name after the host prefix, so the
  // pattern cannot read it as prefix plus name. It falls back to a match that starts inside `plugin_logseq_...` and
  // ends at the `*`, which is why the key looks odd. A different host-prefix glob in another doc (for example
  // `mcp__logseq__logseq_*`, which yields `logseq__logseq_`) needs its own odd-looking entry here. Entries apply to
  // every doc in LIVE_DOCS, not per file.
  logseq_logseq__logseq_: 'the README glob `mcp__plugin_logseq_logseq__logseq_*`, read as one token because it ends in `*`; names no tool',
};

// FORMER_TOOL_NAMES, the guard's memory of what the docs may once have said, lives in skill-tools-check.ts (it is
// shared with the skills guard): the 16 first-version tools plus the two ADR-0008 removed earlier. It never shrinks.

/** Text that holds a former tool name and is not about the tool. The reason sits on each entry. */
const BARE_CONTEXTS: Readonly<Record<string, string>> = {};

const TOOLS_DIR = new URL('src/tools/', ROOT);

/** What `rel` (relative to src/tools) is on disk, as the path rule reads it. Case-exact on every platform (#539). */
const kindOf: ToolPathOptions['kindOf'] = exactKindOf(fileURLToPath(TOOLS_DIR));

/** The file map of docs/architecture.md: the row that lists the tool directories, found by the start of its line. */
const FILE_MAP = { path: 'docs/architecture.md', rowStart: '| `src/tools/<tool>/` |' };

const read = (path: string) => ({ path, text: readFileSync(fileURLToPath(new URL(path, ROOT)), 'utf-8') });

describe('the live docs name only real tools (#503)', () => {
  const tools = JSON.parse(readFileSync(TOOL_LIST_FILE, 'utf-8')) as RecordedTool[];
  const options: DocOptions = {
    nonToolTokens: NON_TOOL_TOKENS,
    historyMarker: HISTORY_MARKER,
    formerToolNames: FORMER_TOOL_NAMES,
    bareContexts: BARE_CONTEXTS,
    toolPaths: { kindOf, fileMap: FILE_MAP },
  };

  it('finds the live docs and the recorded tools', () => {
    for (const path of LIVE_DOCS) expect(read(path).text.length, path).toBeGreaterThan(0);
    expect(tools.length).toBeGreaterThan(0);
  });

  it('has something to check: the docs name at least one recorded tool, and every allowlisted token is in a doc', () => {
    const text = LIVE_DOCS.map(read).map(f => f.text).join('\n');
    expect(tools.some(t => text.includes(t.name))).toBe(true);
    for (const token of Object.keys(NON_TOOL_TOKENS)) expect(text, token).toContain(token);
    for (const context of Object.keys(BARE_CONTEXTS)) expect(text, context).toContain(context);
  });

  it('keeps FORMER_TOOL_NAMES bare, sorted and without repeats, and the 16 first-version tools and the 2 removed earlier are in it', () => {
    expect(FIRST_VERSION_TOOL_NAMES).toHaveLength(16);
    expect(REMOVED_BEFORE_V1_TOOL_NAMES).toEqual(['get_entity_timeline', 'get_related_pages']);
    expect(FORMER_TOOL_NAMES).toHaveLength(18);
    expect(new Set(FORMER_TOOL_NAMES).size).toBe(FORMER_TOOL_NAMES.length);
    expect([...FORMER_TOOL_NAMES].sort()).toEqual(FORMER_TOOL_NAMES);
    for (const name of FORMER_TOOL_NAMES) expect(name, name).toMatch(/^[a-z0-9]+(?:_[a-z0-9]+)*$/);
  });

  it('has tool directories to check: the path rule can tell a directory, a file and a miss', () => {
    expect(kindOf('explore_network'), 'a tool directory is found').toBe('dir');
    expect(kindOf('mod.rs')).toBe('file');
    expect(kindOf('no_such_tool')).toBeNull();
    expect(kindOf('get_page/outline'), 'a nested directory is found').toBe('dir');
  });

  it('finds the real tool directories by their exact case only', () => {
    expect(kindOf('Explore_Network'), 'the same name in another case is a miss').toBeNull();
    expect(kindOf('get_page/Outline')).toBeNull();
    expect(kindOf('MOD.RS')).toBeNull();
  });

  it('names only recorded tools, real tool paths and validates every json tool= example', () => {
    expect(docViolations(LIVE_DOCS.map(read), tools, options), 'a live doc breaks the tool contract').toEqual([]);
  });
});

// Each rule must be able to fail, or the guard above proves nothing. These run the same checker over made-up docs.
describe('the live-docs guard can fail (#503 self-test)', () => {
  const tools: RecordedTool[] = [
    {
      name: 'logseq_get_thing',
      inputSchema: {
        type: 'object',
        required: ['thing_name'],
        properties: { thing_name: { type: 'string' }, depth: { type: 'integer', minimum: 1 } },
      },
    },
  ];
  const options: DocOptions = { nonToolTokens: {}, historyMarker: HISTORY_MARKER, formerToolNames: [], bareContexts: {} };
  const withWheel = { nonToolTokens: { logseq_wheel: 'a made-up non-tool' } };
  const run = (text: string, opts: Partial<DocOptions> = {}) =>
    docViolations([{ path: 'doc.md', text }], tools, { ...options, ...opts });
  const example = (json: string): string => '```json tool=logseq_get_thing\n' + json + '\n```\n';

  it('passes a clean doc, including a host-prefixed name and a non-tool token', () => {
    const text = 'Use `mcp__logseq__logseq_get_thing` and see `logseq_wheel`.\n\n' + example('{"thing_name": "Alice", "depth": 2}');
    expect(run(text, withWheel)).toEqual([]);
    // Without the entry the same token is an unknown tool name.
    expect(run('See `logseq_wheel`.\n')).toEqual(['doc.md:1: "logseq_wheel" is not a tool in tool-list.json']);
  });

  it('flags an unknown tool name with its file and line', () => {
    expect(run('Intro.\nCall `logseq_get_widget` here.\n')).toEqual(['doc.md:2: "logseq_get_widget" is not a tool in tool-list.json']);
  });

  const mark = (...names: string[]): string => `<!-- ${HISTORY_MARKER} ${names.join(' ')} -->`;

  it('flags an unmarked history mention, and lets a marker that names it excuse it', () => {
    const note = 'It was `logseq_get_widget` before v2.';
    expect(run(note + '\n')).toEqual(['doc.md:1: "logseq_get_widget" is not a tool in tool-list.json']);
    expect(run(`${note} ${mark('logseq_get_widget')}\n`)).toEqual([]);
    expect(run(`${mark('logseq_get_widget')} ${note}\n`)).toEqual([]);
  });

  it('excuses only the names the marker lists, so a typo on the same line is still caught', () => {
    const text = `Typo \`logseq_get_pgae\`, was \`logseq_old\`. ${mark('logseq_old')}\n`;
    expect(run(text)).toEqual(['doc.md:1: "logseq_get_pgae" is not a tool in tool-list.json']);
    expect(run(`Was \`logseq_a\` and \`logseq_b\`. ${mark('logseq_a', 'logseq_b')}\n`)).toEqual([]);
  });

  it('keeps the marker to its own line', () => {
    const text = `It was \`logseq_get_widget\` before v2. ${mark('logseq_get_widget')}\nNow it is \`logseq_get_gadget\`.\n`;
    expect(run(text)).toEqual(['doc.md:2: "logseq_get_gadget" is not a tool in tool-list.json']);
  });

  it('fails a stale marker: no name, a real tool, or a name that is not on the line', () => {
    expect(run(`Was \`logseq_old\`. <!-- ${HISTORY_MARKER} -->\n`)).toEqual([
      'doc.md:1: the history comment must name the tool names it excuses, as <!-- guard:history logseq_old_name -->',
      'doc.md:1: "logseq_old" is not a tool in tool-list.json',
    ]);
    expect(run(`Now \`logseq_get_thing\`. ${mark('logseq_get_thing')}\n`)).toEqual([
      'doc.md:1: "logseq_get_thing" is a tool in tool-list.json, so remove it from the history comment',
    ]);
    // The name appears only inside the comment, so nothing on the line needs excusing.
    expect(run(`Nothing to excuse. ${mark('logseq_old')}\n`)).toEqual([
      'doc.md:1: "logseq_old" is not named on this line, so remove it from the history comment',
    ]);
  });

  it('does not let the marker excuse a bad example under it', () => {
    const text = `A note on logseq_get_widget. ${mark('logseq_get_widget')}\n` + example('{"depth": 0}');
    expect(run(text)).toEqual([
      'doc.md:2: the logseq_get_thing example is missing the required argument "thing_name"',
      'doc.md:3: the logseq_get_thing argument "depth" is wrong: 0 is below the minimum of 1',
    ]);
  });

  it('flags a JSON example with a missing required argument, on the right line', () => {
    expect(run('Text\n' + example('{"depth": 2}'))).toEqual([
      'doc.md:2: the logseq_get_thing example is missing the required argument "thing_name"',
    ]);
  });

  it('flags an example argument that is not in the inputSchema', () => {
    expect(run(example('{\n  "thing_name": "a",\n  "topic": "x"\n}'))).toEqual([
      'doc.md:4: the logseq_get_thing example has an argument "topic" that is not in its inputSchema',
    ]);
  });

  it('does not require any section heading or example for a tool', () => {
    expect(run('Nothing about tools here.\n')).toEqual([]);
  });

  it('reads a file with CRLF line endings like one with LF', () => {
    const crlf = example('{"thing_name": "a", "topic": "x"}').replace(/\n/g, '\r\n');
    expect(run(crlf)).toEqual(['doc.md:2: the logseq_get_thing example has an argument "topic" that is not in its inputSchema']);
  });

  it('fails a NON_TOOL_TOKENS entry that no doc uses, or that names a real tool', () => {
    expect(run('No wheel here.\n', withWheel)).toEqual(['NON_TOOL_TOKENS names "logseq_wheel", which no live doc uses, so delete it']);
    expect(run('`logseq_get_thing`\n', { nonToolTokens: { logseq_get_thing: 'wrong' } })).toEqual([
      'NON_TOOL_TOKENS names "logseq_get_thing", which is a tool in tool-list.json, so delete it',
    ]);
  });
});

// The bare-name rule (#510), over made-up docs. `get_thing` is a current tool (as `logseq_get_thing`); `get_widget` was
// a tool before a rename, so a bare `get_widget` is stale.
describe('the bare-name rule can fail (#510 self-test)', () => {
  const tools: RecordedTool[] = [{ name: 'logseq_get_thing', inputSchema: { type: 'object', properties: {} } }];
  const former = ['get_thing', 'get_widget', 'get_widget_outline'];
  const options: DocOptions = { nonToolTokens: {}, historyMarker: HISTORY_MARKER, formerToolNames: former, bareContexts: {} };
  const run = (text: string, opts: Partial<DocOptions> = {}) =>
    docViolations([{ path: 'doc.md', text }], tools, { ...options, ...opts });
  const mark = (...names: string[]): string => `<!-- ${HISTORY_MARKER} ${names.join(' ')} -->`;
  const stale = (line: number, name: string): string =>
    `doc.md:${line}: "${name}" is not a tool in tool-list.json, as logseq_${name} (it is written without the prefix)`;

  it('passes a bare name that is a current tool, in a table, a Use line and prose', () => {
    const text = '| `get_thing` | Gets a thing |\nUse: get_thing("a")\nSee `get_thing` and logseq_get_thing.\n';
    expect(run(text)).toEqual([]);
  });

  it('flags a bare name of a tool the recorded list no longer has, with its line', () => {
    expect(run('Intro.\n| `get_widget` | Gets a widget |\n')).toEqual([stale(2, 'get_widget')]);
    expect(run('Use: get_widget("a")\n')).toEqual([stale(1, 'get_widget')]);
  });

  it('reads a whole word: a longer name is its own token, a prefixed name is checked by the prefixed rule', () => {
    expect(run('`get_widget_outline` and `get_widget`.\n')).toEqual([stale(1, 'get_widget_outline'), stale(1, 'get_widget')]);
    expect(run('`logseq_get_widget`.\n')).toEqual(['doc.md:1: "logseq_get_widget" is not a tool in tool-list.json']);
    expect(run('`get_widgets` and `my_get_widget` and `get_widget2`.\n')).toEqual([]);
  });

  it('reports a name once per line, however often the line says it', () => {
    expect(run('`get_widget` then `get_widget` again.\n')).toEqual([stale(1, 'get_widget')]);
  });

  it('keeps the report of a repeated prefixed name as it was: once per occurrence', () => {
    const line = 'doc.md:1: "logseq_get_widget" is not a tool in tool-list.json';
    expect(run('`logseq_get_widget` and `logseq_get_widget`.\n')).toEqual([line, line]);
  });

  it('skips a name inside a path', () => {
    expect(run('See `src/tools/get_widget/mod.rs` and get_widget/.\n')).toEqual([]);
  });

  it('skips a directory name, and checks a pair of names written with a slash', () => {
    expect(run('Dirs: `get_widget/` and `get_widget_outline/` (#1).\n')).toEqual([]);
    expect(run('`get_widget/get_thing`\n')).toEqual([stale(1, 'get_widget')]);
    expect(run('Use get_thing/get_widget, or get_widget/get_widget_outline.\n')).toEqual([stale(1, 'get_widget'), stale(1, 'get_widget_outline')]);
    // Anything else in the run makes it a path.
    expect(run('`tools/get_widget/get_thing` and `get_widget/mod.rs`\n')).toEqual([]);
  });

  it('ignores a name that is not a former tool name', () => {
    expect(run('`get_gadget` and `query_things`.\n')).toEqual([]);
  });

  it('lets a history comment that names the bare name excuse it, and only that name', () => {
    const note = 'It was `get_widget` before v2.';
    expect(run(`${note} ${mark('get_widget')}\n`)).toEqual([]);
    expect(run(`${note} \`get_widget_outline\` too. ${mark('get_widget')}\n`)).toEqual([stale(1, 'get_widget_outline')]);
    expect(run(`${note} ${mark('get_widget')}\nStill \`get_widget\` here.\n`)).toEqual([stale(2, 'get_widget')]);
  });

  it('needs both names on a line that holds the bare and the prefixed form', () => {
    const text = (names: string[]) => `Was \`get_widget\` (\`logseq_get_widget\`). ${mark(...names)}\n`;
    expect(run(text(['get_widget', 'logseq_get_widget']))).toEqual([]);
    expect(run(text(['get_widget']))).toEqual(['doc.md:1: "logseq_get_widget" is not a tool in tool-list.json']);
    expect(run(text(['logseq_get_widget']))).toEqual([stale(1, 'get_widget')]);
  });

  it('says so when a comment names a bare name that FORMER_TOOL_NAMES lacks', () => {
    expect(run(`Was \`get_gadget\`. ${mark('get_gadget')}\n`)).toEqual([
      'doc.md:1: "get_gadget" is not in FORMER_TOOL_NAMES, so the guard never reads it bare; name it with the logseq_ prefix or add it to the list',
    ]);
  });

  it('fails a history comment on a bare name that is a tool, or that is not on the line', () => {
    expect(run(`Now \`get_thing\`. ${mark('get_thing')}\n`)).toEqual([
      'doc.md:1: "get_thing" is a tool in tool-list.json, so remove it from the history comment',
    ]);
    expect(run(`Nothing to excuse. ${mark('get_widget')}\n`)).toEqual([
      'doc.md:1: "get_widget" is not named on this line, so remove it from the history comment',
    ]);
  });

  it('skips a reviewed context and still checks the rest of the line', () => {
    const bareContexts = { '`get_widget` (`mod.rs`)': 'the Rust function, not the tool' };
    expect(run('The `get_widget` (`mod.rs`) function.\n', { bareContexts })).toEqual([]);
    expect(run('The `get_widget` (`mod.rs`) function, not `get_widget`.\n', { bareContexts })).toEqual([stale(1, 'get_widget')]);
    // The same name outside the context is still stale.
    expect(run('The `get_widget` (`mod.rs`) function.\nAnd `get_widget`.\n', { bareContexts })).toEqual([stale(2, 'get_widget')]);
  });

  it('fails a BARE_CONTEXTS entry that no doc uses, or that holds no former tool name', () => {
    expect(run('Nothing.\n', { bareContexts: { '`get_widget` (`mod.rs`)': 'r' } })).toEqual([
      'BARE_CONTEXTS names "`get_widget` (`mod.rs`)", which no live doc uses, so delete it',
    ]);
    expect(run('The `other` (`mod.rs`).\n', { bareContexts: { '`other` (`mod.rs`)': 'r' } })).toEqual([
      'BARE_CONTEXTS names "`other` (`mod.rs`)", which holds no former tool name, so delete it',
    ]);
  });

  it('judges every BARE_CONTEXTS entry on its own, whatever the order of the entries', () => {
    const first = 'A `get_widget` (`mod.rs`) long long long text here';
    const second = '`get_thing` (`x`)';
    const text = `${first}\n${second}\n`;
    expect(run(text, { bareContexts: { [first]: 'r', [second]: 'r' } })).toEqual([]);
    expect(run(text, { bareContexts: { [second]: 'r', [first]: 'r' } })).toEqual([]);
  });

  it('checks nothing bare when no former names are given (the skills guard path)', () => {
    expect(run('`get_widget`\n', { formerToolNames: [] })).toEqual([]);
  });
});

// The tool-path rule (#520), over made-up docs and a made-up tools directory. `get_page` holds an `outline` directory
// and `mod.rs`; `get_widget` was a tool directory before a rename, so every path to it is stale.
describe('the tool-path rule can fail (#520 self-test)', () => {
  const tree: Record<string, 'dir' | 'file'> = {
    'mod.rs': 'file',
    get_page: 'dir',
    'get_page/mod.rs': 'file',
    'get_page/outline': 'dir',
    'get_page/outline/queries.rs': 'file',
    get_thing: 'dir',
  };
  const fileMap = { path: 'map.md', rowStart: '| `src/tools/<tool>/` |' };
  const toolPaths: ToolPathOptions = { kindOf: rel => tree[rel] ?? null, fileMap };
  const options: DocOptions = {
    nonToolTokens: {},
    historyMarker: HISTORY_MARKER,
    formerToolNames: ['get_page', 'get_widget'],
    bareContexts: {},
    toolPaths,
  };
  const row = (body: string): string => `| \`src/tools/<tool>/\` | One directory per tool. Today: ${body} |\n`;
  const run = (text: string, path = 'doc.md', opts: Partial<DocOptions> = {}) =>
    docViolations([{ path, text }, ...(path === 'map.md' ? [] : [{ path: 'map.md', text: row('`get_page/`') }])], [], {
      ...options,
      ...opts,
    });
  const mark = (...names: string[]): string => `<!-- ${HISTORY_MARKER} ${names.join(' ')} -->`;

  it('passes real paths: a directory, a nested directory, a file, a placeholder and the tools directory itself', () => {
    const text = [
      'See `src/tools/get_page/` and `src/tools/get_page/outline/queries.rs`.',
      'The registry is `src/tools/mod.rs`, and each tool is `src/tools/<name>/mod.rs`.',
      'Everything is under `src/tools/`, or in `src/tools/get_thing`.',
      'Ends a sentence at src/tools/get_page/mod.rs.',
    ].join('\n');
    expect(run(text)).toEqual([]);
  });

  it('flags a path to a missing directory with the doc, the line and the directory', () => {
    expect(run('Intro.\nSee `src/tools/get_widget/mod.rs` here.\n')).toEqual([
      'doc.md:2: "src/tools/get_widget/mod.rs" names the directory src/tools/get_widget/, which does not exist',
    ]);
    expect(run('In `src/tools/get_widget/`.\n')).toEqual([
      'doc.md:1: "src/tools/get_widget/" names the directory src/tools/get_widget/, which does not exist',
    ]);
  });

  it('flags a missing nested directory and a missing file in a real directory', () => {
    expect(run('`src/tools/get_page/inline/queries.rs`\n')).toEqual([
      'doc.md:1: "src/tools/get_page/inline/queries.rs" names the directory src/tools/get_page/inline/, which does not exist',
    ]);
    expect(run('`src/tools/get_page/wire.rs`\n')).toEqual([
      'doc.md:1: "src/tools/get_page/wire.rs" names the file src/tools/get_page/wire.rs, which does not exist',
    ]);
  });

  it('reports a path once per line, and each line on its own', () => {
    const text = '`src/tools/get_widget/` and `src/tools/get_widget/mod.rs`.\nAgain `src/tools/get_widget/`.\n';
    expect(run(text)).toEqual([
      'doc.md:1: "src/tools/get_widget/" names the directory src/tools/get_widget/, which does not exist',
      'doc.md:2: "src/tools/get_widget/" names the directory src/tools/get_widget/, which does not exist',
    ]);
  });

  it('lets a history comment that names the missing directory excuse it, and only that directory', () => {
    const note = 'It was `src/tools/get_widget/` before v2.';
    expect(run(`${note} ${mark('get_widget')}\n`)).toEqual([]);
    expect(run(`${note} See also \`src/tools/get_gadget/\`. ${mark('get_widget')}\n`)).toEqual([
      'doc.md:1: "src/tools/get_gadget/" names the directory src/tools/get_gadget/, which does not exist',
    ]);
    expect(run(`${note} ${mark('get_widget')}\nNow \`src/tools/get_widget/\`.\n`)).toEqual([
      'doc.md:2: "src/tools/get_widget/" names the directory src/tools/get_widget/, which does not exist',
    ]);
  });

  it('never excuses a stale file path, whatever name the comment holds', () => {
    const file = 'src/tools/get_page/wire.rs';
    const missingFile = `doc.md:1: "${file}" names the file ${file}, which does not exist`;
    expect(run(`See \`${file}\`. ${mark('wire')}\n`)).toEqual([
      'doc.md:1: "wire" is not in FORMER_TOOL_NAMES, so the guard never reads it bare; name it with the logseq_ prefix or add it to the list',
      missingFile,
    ]);
    // A stem that is in the list is still no excuse for a file: the file is reported and the comment is stale.
    expect(run(`See \`${file}\`. ${mark('get_widget')}\n`)).toEqual([
      'doc.md:1: "get_widget" is not named on this line, so remove it from the history comment',
      missingFile,
    ]);
  });

  it('excuses a missing directory only when its name is in FORMER_TOOL_NAMES', () => {
    // get_widget is in the list (the excuse works, above); get_gadget is not, so the directory is still reported.
    expect(run(`It was \`src/tools/get_gadget/\`. ${mark('get_gadget')}\n`)).toEqual([
      'doc.md:1: "get_gadget" is not in FORMER_TOOL_NAMES, so the guard never reads it bare; name it with the logseq_ prefix or add it to the list',
      'doc.md:1: "src/tools/get_gadget/" names the directory src/tools/get_gadget/, which does not exist',
    ]);
    // Adding the name to the list is what makes the excuse work.
    expect(run(`It was \`src/tools/get_gadget/\`. ${mark('get_gadget')}\n`, 'doc.md', { formerToolNames: ['get_gadget'] })).toEqual([]);
  });

  it('fails a history comment that names a directory the line does not use', () => {
    expect(run(`See \`src/tools/get_page/\`. ${mark('get_widget')}\n`)).toEqual([
      'doc.md:1: "get_widget" is not named on this line, so remove it from the history comment',
    ]);
  });

  it('reads the file-map row entries as directories, the nested ones too', () => {
    expect(run(row('`get_page/`, `get_page/outline/` and `get_thing/`'), 'map.md')).toEqual([]);
    expect(run(row('`get_page/`, `get_widget/` and `get_page/inline/`'), 'map.md')).toEqual([
      'map.md:1: "get_widget/" names the directory src/tools/get_widget/, which does not exist',
      'map.md:1: "get_page/inline/" names the directory src/tools/get_page/inline/, which does not exist',
    ]);
  });

  it('excuses a file-map entry by the history comment, and reads entries only in that row', () => {
    expect(run(row('`get_page/` and `get_widget/` ' + mark('get_widget')), 'map.md')).toEqual([]);
    // The same entry in prose, or in another doc's table, is not a path.
    expect(run('Dirs: `get_widget/`.\n')).toEqual([]);
    expect(run('| `src/tools/<tool>/` | `get_widget/` |\n')).toEqual([]);
  });

  it('fails when the file-map row is missing, repeated or empty, so the check cannot switch itself off', () => {
    expect(run('Nothing.\n', 'doc.md', { toolPaths: { ...toolPaths, fileMap: { path: 'map.md', rowStart: '| `src/other/` |' } } })).toEqual([
      'map.md: expected one file-map row starting | `src/other/` |, found 0',
    ]);
    expect(run(row('`get_page/`') + row('`get_page/`'), 'map.md')).toEqual([
      'map.md: expected one file-map row starting | `src/tools/<tool>/` |, found 2',
    ]);
    expect(run(row('nothing'), 'map.md')).toEqual(['map.md: the file-map row lists no `name/` directory, so the check has nothing to read']);
  });

  it('checks no path when the option is absent (the skills guard path)', () => {
    expect(run('`src/tools/get_widget/`\n', 'doc.md', { toolPaths: undefined })).toEqual([]);
  });
});

// The tool-path rule reads the disk case-exactly (#539): a doc that writes `Get_Page/` finds the directory on a
// case-insensitive disk (macOS) with a plain stat, and fails on Linux CI. A made-up tree on disk proves the exact match.
describe('the tool-path rule is case-exact on disk (#539 self-test)', () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-tools-case-'));
  mkdirSync(join(root, 'get_page', 'outline'), { recursive: true });
  writeFileSync(join(root, 'mod.rs'), '');
  writeFileSync(join(root, 'get_page', 'mod.rs'), '');
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const onDisk = exactKindOf(root);

  it('finds a directory, a nested directory and a file when the case is exact', () => {
    expect(onDisk('get_page')).toBe('dir');
    expect(onDisk('get_page/outline')).toBe('dir');
    expect(onDisk('get_page/mod.rs')).toBe('file');
    expect(onDisk('mod.rs')).toBe('file');
  });

  it('misses a name in the wrong case at any segment', () => {
    expect(onDisk('Get_Page')).toBeNull();
    expect(onDisk('GET_PAGE/outline')).toBeNull();
    expect(onDisk('get_page/Outline')).toBeNull();
    expect(onDisk('get_page/Mod.rs')).toBeNull();
    expect(onDisk('Mod.rs')).toBeNull();
  });

  it('misses a name that is absent, and a path through a file', () => {
    expect(onDisk('get_thing')).toBeNull();
    expect(onDisk('mod.rs/outline')).toBeNull();
  });

  it('fails a doc that names a wrong-case directory, with the doc, the line and the directory', () => {
    const options: DocOptions = {
      nonToolTokens: {},
      historyMarker: HISTORY_MARKER,
      formerToolNames: [],
      bareContexts: {},
      toolPaths: { kindOf: onDisk, fileMap: { path: 'map.md', rowStart: '| `src/tools/<tool>/` |' } },
    };
    const map = { path: 'map.md', text: '| `src/tools/<tool>/` | Today: `get_page/` |\n' };
    const doc = { path: 'doc.md', text: 'ok\nSee `src/tools/Get_Page/` here.\n' };
    expect(docViolations([doc, map], [], options)).toEqual([
      'doc.md:2: "src/tools/Get_Page/" names the directory src/tools/Get_Page/, which does not exist',
    ]);
  });

  // The disk above is the real one, so these tests can only fail where the disk ignores case. A fake disk that does
  // (its statSync finds a path whatever the case, as macOS does) makes them fail on every platform if the exact match goes.
  describe('on a disk whose stat ignores case (a fake, so it holds on Linux CI too)', () => {
    const tree: Record<string, 'dir' | 'file'> = { '/t/get_page': 'dir', '/t/get_page/outline': 'dir', '/t/get_page/mod.rs': 'file', '/t/mod.rs': 'file', '/t': 'dir' };
    const fake: DiskReads = {
      readdirSync: dir => {
        if (tree[dir] !== 'dir') throw new Error(`ENOTDIR: ${dir}`);
        return Object.keys(tree).filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')).map(p => p.slice(dir.length + 1));
      },
      statSync: path => {
        const key = Object.keys(tree).find(p => p.toLowerCase() === path.toLowerCase());
        if (!key) throw new Error(`ENOENT: ${path}`);
        return { isDirectory: () => tree[key] === 'dir', isFile: () => tree[key] === 'file' };
      },
    };
    const kind = exactKindOf('/t', fake);

    it('finds the exact case', () => {
      expect(kind('get_page')).toBe('dir');
      expect(kind('get_page/outline')).toBe('dir');
      expect(kind('get_page/mod.rs')).toBe('file');
    });

    it('misses a wrong case at any segment, though the fake stat would find it', () => {
      expect(fake.statSync('/t/Get_Page').isDirectory(), 'the fake disk ignores case').toBe(true);
      for (const rel of ['Get_Page', 'GET_PAGE/outline', 'get_page/Outline', 'get_page/Mod.rs', 'Mod.rs']) expect(kind(rel), rel).toBeNull();
    });

    it('misses a path through a file', () => {
      expect(kind('mod.rs/outline')).toBeNull();
    });
  });
});
