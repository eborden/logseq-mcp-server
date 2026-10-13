import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { docViolations, type DocOptions, type RecordedTool } from './skill-tools-check.js';

/**
 * The live docs name only real tools, and their JSON examples validate against the tool's inputSchema (#503, part of #500).
 *
 * The skills guard (tests/guards/skill-tools.test.ts, #486) keeps the skills in step with the recorded tool list,
 * rust/tests/data/parity/tool-list.json. The same drift happens in the docs that name tools, so each rename of the v2
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
 * tool (rust/README.md and CLAUDE.md name `logseq_get_page_outline` in sentences about it today), update the name to
 * the new one. Add the comment only when the sentence says "was" and the old name is the point.
 *
 * Bare names (#510). Most of the docs name tools without the prefix: the tool tables in README.md, its `Use: name(...)`
 * lines, the status table and prose of CLAUDE.md, the prose of rust/README.md. A rename (#489 to #495) leaves each of
 * those stale, so a bare token that equals a first-version tool name (FORMER_TOOL_NAMES, whole word) must be a tool in
 * the recorded list with the prefix added, or sit on a line whose history comment names it
 * (`<!-- guard:history get_old_name -->`, the bare name). A rename PR updates the bare names in step, or the guard fails
 * on the old one. A line that holds both forms, such as "was `get_old_name` (`logseq_old_name`)", needs both names in
 * the comment, since each is its own unknown token. Bare names of tools that were never in FORMER_TOOL_NAMES are not
 * checked, and a marker that names one says so: a tool that is added and later renamed needs its old name appended to
 * the list by the PR that renames it (the list never shrinks).
 *
 * Paths are skipped. A name touching a `/` is part of a path unless the run around it is only former tool names, so
 * `src/tools/get_page/mod.rs` and the directory names `get_page/` are skipped, and a pair written `get_page/get_block`
 * is checked. That has a cost: two kinds of mention are NOT checked, so they go stale without a failure when a rename
 * PR renames a tool's directory. One is the directory list in the rust/README.md file map (the row for
 * `src/tools/<tool>/`, 14 names written `name/`). The other is the `rust/src/tools/<name>/...` paths in CLAUDE.md (10
 * names). The rename PR updates both by hand.
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
const TOOL_LIST_FILE = new URL('rust/tests/data/parity/tool-list.json', ROOT);

/** The live docs that name tools, relative to the repo root. A new live doc is one more line here. */
const LIVE_DOCS: readonly string[] = ['README.md', 'rust/README.md', 'CLAUDE.md', 'docs/architecture-foundations.md'];

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

/**
 * Every tool name of the first version, without the prefix (the 16 tools of `logseq_*` at v1.x). The list is the
 * guard's memory of what the docs may once have said: once a rename removes a name from the recorded list, a doc that
 * still says it is stale. It never shrinks. Append the old name of a tool when a later rename removes it.
 */
const FORMER_TOOL_NAMES: readonly string[] = [
  'build_context',
  'check_links',
  'get_backlinks',
  'get_block',
  'get_concept_evolution',
  'get_concept_network',
  'get_context_for_query',
  'get_current_context',
  'get_graph_info',
  'get_page',
  'get_page_outline',
  'list_pages',
  'query_by_date_range',
  'query_by_property',
  'search_blocks',
  'search_by_relationship',
];

/** Text that holds a former tool name and is not about the tool. The reason sits on each entry. */
const BARE_CONTEXTS: Readonly<Record<string, string>> = {};

const read = (path: string) => ({ path, text: readFileSync(fileURLToPath(new URL(path, ROOT)), 'utf-8') });

describe('the live docs name only real tools (#503)', () => {
  const tools = JSON.parse(readFileSync(TOOL_LIST_FILE, 'utf-8')) as RecordedTool[];
  const options: DocOptions = {
    nonToolTokens: NON_TOOL_TOKENS,
    historyMarker: HISTORY_MARKER,
    formerToolNames: FORMER_TOOL_NAMES,
    bareContexts: BARE_CONTEXTS,
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

  it('keeps FORMER_TOOL_NAMES bare, sorted and without repeats, and the 16 first-version tools are in it', () => {
    expect(FORMER_TOOL_NAMES).toHaveLength(16);
    expect(new Set(FORMER_TOOL_NAMES).size).toBe(FORMER_TOOL_NAMES.length);
    expect([...FORMER_TOOL_NAMES].sort()).toEqual(FORMER_TOOL_NAMES);
    for (const name of FORMER_TOOL_NAMES) expect(name, name).toMatch(/^[a-z0-9]+(?:_[a-z0-9]+)*$/);
  });

  it('names only recorded tools and validates every json tool= example', () => {
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
    expect(run('See `rust/src/tools/get_widget/mod.rs` and get_widget/.\n')).toEqual([]);
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
