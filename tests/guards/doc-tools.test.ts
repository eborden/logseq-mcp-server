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
 * History marker. A passage that names a tool on purpose because the tool is gone (a "was `logseq_x` before v2" note)
 * ends its line with the HTML comment `<!-- guard:history -->`. The comment is invisible in rendered Markdown. It
 * excuses every unknown tool name on its own line and nothing else: known names are still checked, and a JSON example
 * under it is still validated. A marker on a line that names no unknown tool is an error, so a marker does not outlive
 * the note it excuses (the rename that makes the name real again removes it).
 *
 * Not checked, on purpose: CHANGELOG.md, docs/adr/ and docs/business-rules/ are history (ADRs are immutable once
 * accepted), so they are not in the list. Prose claims such as a tool count ("16 tools") or an API call count are a
 * separate drift this guard doesn't read. A bare tool name without the `logseq_` prefix (the status table in CLAUDE.md
 * writes `get_page`) matches no pattern, so it is not caught either.
 */

const ROOT = new URL('../../', import.meta.url);
const TOOL_LIST_FILE = new URL('rust/tests/data/parity/tool-list.json', ROOT);

/** The live docs that name tools, relative to the repo root. A new live doc is one more line here. */
const LIVE_DOCS: readonly string[] = ['README.md', 'rust/README.md', 'CLAUDE.md'];

/** The comment that excuses the unknown tool names on its line. Documented in the header above. */
const HISTORY_MARKER = '<!-- guard:history -->';

/** Tokens that match `logseq_[a-z0-9_]+` and are not tools. The reason sits on each entry. */
const NON_TOOL_TOKENS: Readonly<Record<string, string>> = {
  // The wheel's file name, `logseq_mcp_server-<version>-py3-none-<platform>.whl` (README, release steps).
  logseq_mcp_server: 'the PyPI wheel file name, not a tool',
  // The glob `mcp__plugin_logseq_logseq__logseq_*` (README). The `*` leaves no tool name after the host prefix, so the
  // pattern reads the host prefix and the bare `logseq_` together.
  logseq_logseq__logseq_: 'a host-prefix glob that ends in `*`, so it names no tool',
};

const read = (path: string) => ({ path, text: readFileSync(fileURLToPath(new URL(path, ROOT)), 'utf-8') });

describe('the live docs name only real tools (#503)', () => {
  const tools = JSON.parse(readFileSync(TOOL_LIST_FILE, 'utf-8')) as RecordedTool[];
  const options: DocOptions = { nonToolTokens: NON_TOOL_TOKENS, historyMarker: HISTORY_MARKER };

  it('finds the live docs and the recorded tools', () => {
    for (const path of LIVE_DOCS) expect(read(path).text.length, path).toBeGreaterThan(0);
    expect(tools.length).toBeGreaterThan(0);
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
  const options: DocOptions = { nonToolTokens: {}, historyMarker: HISTORY_MARKER };
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

  it('flags an unmarked history mention, and lets the marker excuse it', () => {
    const note = 'It was `logseq_get_widget` before v2.';
    expect(run(note + '\n')).toEqual(['doc.md:1: "logseq_get_widget" is not a tool in tool-list.json']);
    expect(run(`${note} ${HISTORY_MARKER}\n`)).toEqual([]);
  });

  it('keeps the marker to its own line', () => {
    const text = `It was \`logseq_get_widget\` before v2. ${HISTORY_MARKER}\nNow it is \`logseq_get_gadget\`.\n`;
    expect(run(text)).toEqual(['doc.md:2: "logseq_get_gadget" is not a tool in tool-list.json']);
  });

  it('fails a marker on a line that names no unknown tool, so a stale marker cannot stay', () => {
    expect(run(`Now it is \`logseq_get_thing\`. ${HISTORY_MARKER}\n`)).toEqual([
      `doc.md:1: "${HISTORY_MARKER}" is on a line that names no unknown tool, so remove it`,
    ]);
    expect(run(`Nothing to excuse. ${HISTORY_MARKER}\n`)).toHaveLength(1);
  });

  it('does not let the marker excuse a bad example under it', () => {
    const text = `A note on logseq_get_widget. ${HISTORY_MARKER}\n` + example('{"depth": 0}');
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
