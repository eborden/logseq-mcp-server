import { describe, it, expect } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getPageOutlineCases } from '../scripts/parity/cases/get-page-outline.js';
import { queryByDateRangeCases } from '../scripts/parity/cases/query-by-date-range.js';
import { pageResourceCases } from '../scripts/parity/cases/page-resource.js';
import { CASE_GROUPS, allCases, expectedFileOf } from '../scripts/parity/case-groups.js';
import {
  checkWrongLists,
  compareCalls,
  compareResult,
  compareResultBySuggestionRules,
  PARITY_NOW_MS,
  PARITY_TZ,
  perturbCases,
  readSnapshotEntry,
  runCase,
  runParity,
  serializeLikeVitest,
  toolsCalledBy,
  TOOL_LIST_SNAPSHOT_KEY,
  type ParityCase,
  type ToolResult
} from '../scripts/parity/harness.js';
import { suggestionsCases } from '../scripts/parity/cases/suggestions.js';
import {
  candidatesOf,
  checkList,
  checkReferenceList,
  checkReferenceLists,
  fold,
  GUIDANCE,
  matchesOf,
  missingRequiredCases,
  parseNotFound,
  REQUIRED_CASES,
  requiredKindsOf,
  splitList
} from '../scripts/parity/suggestion-rules.js';
import { parseCommandLine } from '../scripts/parity/command-line.js';
import { CLOCK_CASES, withoutClockCases } from '../scripts/parity/clock-cases.js';
import { callKey, DATASCRIPT_QUERY, LOGSEQ_PORT, startStubLogseq, type CannedCall } from '../scripts/parity/stub-logseq.js';
import { compareToolLists, normalizeSchema, type ProjectedTool } from '../scripts/parity/tool-list-compare.js';
import { REPO_ROOT, SNAPSHOT_FILE, typescriptServer, viteNodeCommand } from '../scripts/parity/ts-server.js';

/**
 * The differential parity harness (#124, ADR-0031 Decision 2). The end-to-end tests start the
 * TypeScript server over stdio, as the harness would start the Rust one, so they take a few
 * seconds each.
 */

const EXPECTED_FILE = join(REPO_ROOT, 'scripts', 'parity', 'expected', 'get-page-outline.json');
const loadExpected = async () => JSON.parse(await readFile(EXPECTED_FILE, 'utf8')) as Record<string, ToolResult>;
const TOOL_LIST_FILE = join(REPO_ROOT, 'scripts', 'parity', 'expected', 'tool-list.json');
const loadToolList = async () => JSON.parse(await readFile(TOOL_LIST_FILE, 'utf8')) as ProjectedTool[];

const q = (text: string, ...inputs: string[]): CannedCall => ({ method: DATASCRIPT_QUERY, args: [text, ...inputs], response: [] });

describe('compareCalls', () => {
  const a = q('[:find ?a]', '"alice"');
  const b = q('[:find ?b]', '"bob"');
  const c = { method: 'logseq.Editor.getAllPages', args: [], response: [] };

  it('accepts sequential calls in order, and concurrent ones in any order', () => {
    expect(compareCalls([[a], [b, c]], [a, c, b])).toEqual([]);
  });

  it('accepts the calls of a concurrent step in every arrival order, and a later step after any of them (#340)', () => {
    const d = { method: 'logseq.Editor.getSelectedBlocks', args: [], response: [] };
    const step = [a, c, d];
    const permutations = (items: CannedCall[]): CannedCall[][] =>
      items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]));
    expect(permutations(step)).toHaveLength(6);
    for (const arrival of permutations(step)) expect(compareCalls([step, [b]], [...arrival, b])).toEqual([]);
  });

  it('still wants every call of a concurrent step exactly once, with its inputs, whatever the arrival order', () => {
    const d = { method: 'logseq.Editor.getSelectedBlocks', args: [], response: [] };
    // One missing, one doubled in its place, one with another input: each fails in every order
    for (const got of [[d, a], [c, a, a], [d, c, q('[:find ?a]', '"Alice"')], [a, c, d, d]]) {
      expect(compareCalls([[a, c, d]], got)).not.toEqual([]);
      expect(compareCalls([[a, c, d]], [...got].reverse())).not.toEqual([]);
    }
  });

  it('rejects sequential calls out of order', () => {
    expect(compareCalls([[a], [b]], [b, a])).toHaveLength(2);
  });

  it('rejects a changed input, a missing call and an extra one', () => {
    expect(compareCalls([[a]], [q('[:find ?a]', '"Alice"')])).toHaveLength(1);
    expect(compareCalls([[a], [b]], [a])).toHaveLength(1);
    expect(compareCalls([[a]], [a, b])).toEqual([expect.stringContaining('1 call(s) after the last step')]);
  });

  it('ignores how a query is laid out, not what it says', () => {
    expect(compareCalls([[q('[:find ?a :where [?a :block/name]]')]], [q('[:find ?a\n   :where\n   [?a :block/name]]')])).toEqual([]);
    expect(compareCalls([[q('[:find ?a]')]], [q('[:find ?b]')])).toHaveLength(1);
  });
});

describe('compareResult', () => {
  const result: ToolResult = { content: [{ type: 'text', text: '{"page":"Alice"}' }] };

  it('compares text byte for byte', () => {
    expect(compareResult(result, structuredClone(result))).toEqual([]);
    // Same JSON value, different bytes: still a difference (ADR-0009)
    expect(compareResult(result, { content: [{ type: 'text', text: '{"page": "Alice"}' }] })).toEqual([
      expect.stringContaining('differs at character 8')
    ]);
  });

  it('tells an absent isError from isError: false, and compares the number of content blocks', () => {
    expect(compareResult(result, { ...result, isError: false })).toEqual(['the result has unexpected key(s) isError']);
    expect(compareResult({ ...result, isError: false }, { ...result, isError: true })).toHaveLength(1);
    expect(compareResult(result, { content: [...result.content!, { type: 'text', text: '{}' }] })).toHaveLength(1);
  });

  it('fails on any key the TypeScript server did not send', () => {
    expect(compareResult(result, { ...result, structuredContent: { page: 'Alice' } })).toEqual([
      'the result has unexpected key(s) structuredContent'
    ]);
    expect(compareResult(result, { ...result, _meta: {} })).toHaveLength(1);
    expect(compareResult(result, { content: [{ ...result.content![0], annotations: { priority: 1 } }] })).toEqual([
      'content[0] has unexpected key(s) annotations'
    ]);
    expect(compareResult({ ...result, _meta: { a: 1 } }, { ...result, _meta: { a: 2 } })).toEqual([
      '_meta: expected {"a":1}, got {"a":2}'
    ]);
  });
});

describe('compareResult on a resource', () => {
  const block = { uri: 'logseq://page/Alice', mimeType: 'text/markdown', text: '# Alice\n' };
  const read: ToolResult = { contents: [block] };

  it('compares the text of each contents block byte for byte, and its other fields', () => {
    expect(compareResult(read, structuredClone(read))).toEqual([]);
    expect(compareResult(read, { contents: [{ ...block, text: '# Alice \n' }] })).toEqual([
      expect.stringContaining('contents[0].text differs at character 7')
    ]);
    expect(compareResult(read, { contents: [{ ...block, mimeType: 'text/plain' }] })).toEqual([
      'contents[0].mimeType: expected "text/markdown", got "text/plain"'
    ]);
    expect(compareResult(read, { contents: [block, block] })).toHaveLength(1);
    expect(compareResult(read, { contents: [{ uri: block.uri, text: block.text }] })).toEqual([
      'contents[0] lacks key(s) mimeType'
    ]);
  });

  it('compares a JSON-RPC error recorded as a result', () => {
    const error: ToolResult = { error: { code: -32002, message: 'MCP error -32002: No page' } };
    expect(compareResult(error, structuredClone(error))).toEqual([]);
    expect(compareResult(error, { error: { code: -32602, message: 'MCP error -32002: No page' } })).toHaveLength(1);
    expect(compareResult(error, { error: { ...(error.error as object), data: { uri: 'x' } } })).toHaveLength(1);
  });
});

describe('runCase on a resource read that fails', () => {
  const read = (uri: string): ParityCase => ({ name: 'n', tool: 't', arguments: {}, readResource: uri, steps: [] });
  const failing = (error: unknown) => ({ readResource: async () => { throw error; } }) as unknown as Client;

  it('records the error a server sent as the result of the case', async () => {
    const result = await runCase(failing(new McpError(-32002, 'No page', { uri: 'x' })), read('logseq://page/x'), 1000);
    expect(result).toEqual({ error: { code: -32002, message: 'MCP error -32002: No page', data: { uri: 'x' } } });
  });

  it('does not record the client\'s own timeout or closed connection, which say nothing about the server\'s answer', async () => {
    for (const code of [ErrorCode.RequestTimeout, ErrorCode.ConnectionClosed]) {
      const error = new McpError(code, 'client side');
      await expect(runCase(failing(error), read('logseq://page/x'), 1000), String(code)).rejects.toBe(error);
    }
    const other = new Error('boom');
    await expect(runCase(failing(other), read('logseq://page/x'), 1000)).rejects.toBe(other);
  });
});

describe('compareResult on a prompt', () => {
  const message = (text: string) => ({ role: 'user', content: { type: 'text', text } });
  const got: ToolResult = { description: 'Weekly', messages: [message('Write a summary\nSteps:')] };

  it('compares the text of each message byte for byte, and everything else by value', () => {
    expect(compareResult(got, structuredClone(got))).toEqual([]);
    expect(compareResult(got, { ...got, messages: [message('Write a summary\nSteps: ')] })).toEqual([
      expect.stringContaining('messages[0] text differs at character 22')
    ]);
    expect(compareResult(got, { ...got, messages: [message('Write a summary\nSteps:'), message('more')] })).toEqual([
      'expected 1 message(s), got 2'
    ]);
    expect(compareResult(got, { ...got, messages: [{ role: 'assistant', content: message('Write a summary\nSteps:').content }] })).toEqual([
      expect.stringContaining('messages[0]: expected')
    ]);
    expect(compareResult(got, { ...got, description: 'Monthly' })).toEqual(['description: expected "Weekly", got "Monthly"']);
  });
});

describe('runCase on the prompt and resource requests', () => {
  const fake = (calls: string[]) =>
    ({
      listPrompts: async () => (calls.push('listPrompts'), { prompts: [] }),
      listResources: async () => (calls.push('listResources'), { resources: [] }),
      getPrompt: async (params: unknown) => {
        calls.push(`getPrompt ${JSON.stringify(params)}`);
        throw new McpError(-32602, 'Unknown prompt', undefined);
      }
    }) as unknown as Client;
  const base = { name: 'n', tool: 't', arguments: {}, steps: [] };

  it('makes the request the case names and records a server error as its result', async () => {
    const calls: string[] = [];
    const client = fake(calls);
    expect(await runCase(client, { ...base, listPrompts: true }, 1000)).toEqual({ prompts: [] });
    expect(await runCase(client, { ...base, listResources: true }, 1000)).toEqual({ resources: [] });
    expect(await runCase(client, { ...base, getPrompt: { name: 'x', arguments: { a: 'b' } } }, 1000)).toEqual({
      error: { code: -32602, message: 'MCP error -32602: Unknown prompt' }
    });
    expect(calls).toEqual(['listPrompts', 'listResources', 'getPrompt {"name":"x","arguments":{"a":"b"}}']);
  });
});

describe('the stub LogSeq', () => {
  it('answers by method and query text, checks the token, and fails loud on an unknown call', async () => {
    const stub = await startStubLogseq();
    try {
      expect(new URL(stub.apiUrl).port).not.toBe(String(LOGSEQ_PORT));
      stub.load([{ ...q('[:find ?a]', '"alice"'), response: [[1]] }]);
      const post = (body: unknown, token = stub.authToken) =>
        fetch(`${stub.apiUrl}/api`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

      const known = await post({ method: DATASCRIPT_QUERY, args: ['[:find\n ?a]', '"alice"'] });
      expect(await known.json()).toEqual([[1]]);
      expect((await post({ method: DATASCRIPT_QUERY, args: ['[:find ?a]'] }, 'wrong')).status).toBe(401);
      const unknown = await post({ method: DATASCRIPT_QUERY, args: ['[:find ?z]'] });
      expect(await unknown.json()).toHaveProperty('error');

      expect(stub.calls()).toHaveLength(2);
      expect(stub.failures()).toEqual([
        'request with a wrong or missing auth token',
        expect.stringContaining('no canned response for logseq.DB.datascriptQuery [:find ?z]')
      ]);
    } finally {
      await stub.close();
    }
  });

  const post = (stub: { apiUrl: string; authToken: string }, method: string) =>
    fetch(`${stub.apiUrl}/api`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${stub.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, args: [] })
    });
  const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const EDITOR = ['getCurrentPage', 'getCurrentBlock', 'getSelectedBlocks'].map(name => `logseq.Editor.${name}`);

  it('settles once every call of a step has arrived, though the first answer came back long before (#340)', async () => {
    const stub = await startStubLogseq();
    try {
      stub.load(EDITOR.map(method => ({ method, args: [], response: null })));
      // The first call is answered at once, as a tool that fails on the first answer would return; the others arrive late, last one first
      await post(stub, EDITOR[0]);
      const late = [post(stub, EDITOR[2]), wait(40).then(() => post(stub, EDITOR[1]))];
      let settled = false;
      const settling = stub.settle(3).then(() => {
        settled = true;
      });
      await wait(15);
      expect(settled, 'the third call has not come yet').toBe(false);
      await settling;
      expect([...stub.calls().map(call => call.method)].sort()).toEqual([...EDITOR].sort());
      expect(stub.failures()).toEqual([]);
      await Promise.all(late);
    } finally {
      await stub.close();
    }
  });

  it('does not settle while a request is still being read, even when the listed calls have all come (#340)', async () => {
    const stub = await startStubLogseq();
    try {
      stub.load([{ method: EDITOR[0], args: [], response: null }]);
      await post(stub, EDITOR[0]);
      // An extra call whose body is written slowly: the count is already reached, one request is mid-body
      const body = JSON.stringify({ method: EDITOR[1], args: [] });
      const request = httpRequest(`${stub.apiUrl}/api`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${stub.authToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      });
      request.on('response', response => response.resume());
      request.write(body.slice(0, 5));
      await wait(20);
      let settled = false;
      const settling = stub.settle(1).then(() => {
        settled = true;
      });
      await wait(60);
      expect(settled, 'one request is still being read').toBe(false);
      request.end(body.slice(5));
      await settling;
      expect(stub.calls().map(call => call.method)).toEqual([EDITOR[0], EDITOR[1]]);
    } finally {
      await stub.close();
    }
  });

  it('gives up after a quiet period when calls never come, so a server that makes too few shows as a failed comparison', async () => {
    const stub = await startStubLogseq();
    try {
      stub.load([]);
      const started = Date.now();
      await stub.settle(2, { quietMs: 30, maxMs: 5000 });
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(30);
      expect(waited).toBeLessThan(1000);
      expect(stub.calls()).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it('waits no longer than maxMs for a server that keeps calling, and not at all for 0', async () => {
    const stub = await startStubLogseq();
    try {
      stub.load([]);
      let calling = true;
      const keepCalling = (async () => {
        while (calling) {
          await post(stub, 'logseq.Editor.getCurrentPage');
          await wait(10);
        }
      })();
      const started = Date.now();
      await stub.settle(1000, { quietMs: 100, maxMs: 300 });
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(300);
      expect(waited).toBeLessThan(1500);
      const startedAgain = Date.now();
      await stub.settle(1000, { quietMs: 100, maxMs: 0 });
      expect(Date.now() - startedAgain).toBeLessThan(100);
      calling = false;
      await keepCalling;
    } finally {
      await stub.close();
    }
  });

  it('keys a query by its text without layout, and other methods by their args', () => {
    expect(callKey({ method: DATASCRIPT_QUERY, args: ['[:find\n   ?a]', '"x"'] })).toBe(`${DATASCRIPT_QUERY} [:find ?a]`);
    expect(callKey({ method: 'logseq.Editor.getPage', args: ['alice'] })).toBe('logseq.Editor.getPage ["alice"]');
  });
});

describe('the parity cases', () => {
  it('have an expected result each, recorded from the TypeScript server', async () => {
    for (const group of CASE_GROUPS) {
      const expected = JSON.parse(await readFile(expectedFileOf(group), 'utf8')) as Record<string, ToolResult>;
      expect(Object.keys(expected).sort(), group.name).toEqual(group.cases.map(c => c.name).sort());
    }
    expect(new Set(allCases().map(c => c.name)).size).toBe(allCases().length);
  });

  it('are all registered: every cases file and every expected file has a group', async () => {
    const stems = async (dir: string, extension: string) =>
      (await readdir(join(REPO_ROOT, 'scripts', 'parity', dir)))
        .filter(file => file.endsWith(extension))
        .map(file => file.slice(0, -extension.length))
        .sort();
    const groups = CASE_GROUPS.map(group => group.name).sort();
    expect(await stems('cases', '.ts'), 'a file in scripts/parity/cases is not in CASE_GROUPS').toEqual(groups);
    // tool-list.json is the recorded tools/list, not a group's results
    expect((await stems('expected', '.json')).filter(stem => stem !== 'tool-list'), 'a file in scripts/parity/expected is not in CASE_GROUPS').toEqual(groups);
  });

  it('read the tools/list snapshot that src/tool-list.test.ts writes', async () => {
    const entry = readSnapshotEntry(await readFile(SNAPSHOT_FILE, 'utf8'), TOOL_LIST_SNAPSHOT_KEY);
    expect(entry).toContain('"name": "logseq_get_page_outline"');
  });

  it('have a recorded tool list that is the snapshot, byte for byte', async () => {
    const entry = readSnapshotEntry(await readFile(SNAPSHOT_FILE, 'utf8'), TOOL_LIST_SNAPSHOT_KEY);
    expect(serializeLikeVitest(await loadToolList())).toBe(entry);
  });
});

type Schema = Record<string, any>;

/** Keys in reverse order, all the way down, so that only key order differs. */
const reversedKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(reversedKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversedKeys(x)]))
      : v;

/**
 * An input schema written the way schemars writes the same contract (#291): enums under `$defs`,
 * reached by `$ref` (an `allOf` wrapper when required, an `anyOf` with null when optional), other
 * optional fields typed `[T, "null"]`, `format` on numbers, `title` on everything, `$schema`, the
 * `required` list reversed and every object's keys reversed. The meaning is unchanged.
 */
function schemarsStyle(schema: Schema): Schema {
  const required = new Set<string>(schema.required ?? []);
  const defs: Schema = {};
  const properties = Object.fromEntries(
    Object.entries(schema.properties as Schema).map(([name, p]: [string, Schema]) => {
      const { description, ...rest } = p;
      if (p.enum) {
        const def = name.replace(/(^|_)(\w)/g, (_m, _u, c: string) => c.toUpperCase());
        defs[def] = { title: def, ...rest };
        const ref = { $ref: `#/$defs/${def}` };
        return [name, required.has(name) ? { description, allOf: [ref] } : { description, anyOf: [ref, { type: 'null' }] }];
      }
      const titled: Schema = { ...rest, title: name };
      if (p.type === 'number') titled.format = 'double';
      if (!required.has(name) && typeof p.type === 'string') titled.type = [p.type, 'null'];
      return [name, { ...titled, description }];
    })
  );
  return reversedKeys({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Args',
    ...schema,
    properties,
    ...(schema.required ? { required: [...schema.required].reverse() } : {}),
    $defs: defs
  }) as Schema;
}

/** The tool list with one tool's input schema edited. */
function withSchema(tools: ProjectedTool[], name: string, edit: (schema: Schema) => void): ProjectedTool[] {
  const copy = structuredClone(tools);
  edit(copy.find(t => t.name === name)!.inputSchema as Schema);
  return copy;
}

const quirky = (tools: ProjectedTool[]) => tools.map(t => ({ ...t, inputSchema: schemarsStyle(t.inputSchema as Schema) }));

describe('compareToolLists', () => {
  it('finds nothing to report in the TypeScript tool list against itself', async () => {
    const tools = await loadToolList();
    expect(tools).toHaveLength(16);
    expect(compareToolLists(tools, structuredClone(tools))).toEqual([]);
  });

  it('treats a list that differs only in serialization quirks as equal', async () => {
    const tools = await loadToolList();
    // The rewrite reached every quirk it is meant to show
    const text = JSON.stringify(quirky(tools));
    for (const quirk of ['"$ref"', '"$defs"', '"allOf"', '{"type":"null"}', '"null"]', '"format":"double"', '"title":"limit"', '"$schema"']) {
      expect(text).toContain(quirk);
    }
    expect(compareToolLists(tools, quirky(tools))).toEqual([]);
  });

  it('compares numbers by value', async () => {
    const tools = await loadToolList();
    const text = JSON.stringify(tools).replace(/"default":(\d+)/g, '"default":$1.0').replace(/"maxLength":50000/g, '"maxLength":5e4');
    expect(text).toContain('"default":50.0');
    expect(text).toContain('"maxLength":5e4');
    expect(compareToolLists(tools, JSON.parse(text))).toEqual([]);
  });

  it('fails loud, with the path and both values, on a changed bound, type, enum value, required field or description', async () => {
    const tools = await loadToolList();
    const cases: Array<[string, ProjectedTool[], string]> = [
      ['bound', withSchema(tools, 'logseq_check_links', s => { s.properties.after.maxLength = 50001; }),
        'logseq_check_links.inputSchema.properties.after.maxLength: expected 50000, got 50001'],
      ['type', withSchema(tools, 'logseq_build_context', s => { s.properties.max_blocks.type = 'number'; }),
        'logseq_build_context.inputSchema.properties.max_blocks.type: expected "integer", got "number"'],
      ['enum value', withSchema(tools, 'logseq_get_page', s => { s.properties.format.enum = ['json', 'md']; }),
        'logseq_get_page.inputSchema.properties.format.enum[1]: expected "markdown", got "md"'],
      ['required field', withSchema(tools, 'logseq_build_context', s => { s.required = []; }),
        'logseq_build_context.inputSchema.required: expected ["topic_name"], got []'],
      ['parameter description', withSchema(tools, 'logseq_build_context', s => { s.properties.max_blocks.description += '!'; }),
        'logseq_build_context.inputSchema.properties.max_blocks.description: expected'],
      ['tool description', tools.map(t => (t.name === 'logseq_get_block' ? { ...t, description: `${t.description} ` } : t)),
        'logseq_get_block.description: expected'],
      ['default', withSchema(tools, 'logseq_build_context', s => { s.properties.max_blocks.default = 51; }),
        'logseq_build_context.inputSchema.properties.max_blocks.default: expected 50, got 51'],
      ['additionalProperties', withSchema(tools, 'logseq_get_page', s => { s.additionalProperties = false; }),
        'logseq_get_page.inputSchema.additionalProperties: expected nothing, got false']
    ];
    for (const [what, changed, line] of cases) {
      const failures = compareToolLists(tools, changed);
      expect(failures, what).toHaveLength(1);
      expect(failures[0], what).toContain(line);
    }
    // Enum values are compared in order: the same values swapped is a difference
    const swapped = withSchema(tools, 'logseq_get_page', s => { s.properties.format.enum = ['markdown', 'json']; });
    expect(compareToolLists(tools, swapped)).toEqual([
      'logseq_get_page.inputSchema.properties.format.enum[0]: expected "json", got "markdown"',
      'logseq_get_page.inputSchema.properties.format.enum[1]: expected "markdown", got "json"'
    ]);
    // A change is still caught when the schema is in the quirky form
    const bound = quirky(withSchema(tools, 'logseq_check_links', s => { s.properties.after.maxLength = 1; }));
    expect(compareToolLists(tools, bound)).toEqual([expect.stringContaining('after.maxLength: expected 50000, got 1')]);
    const enumValue = quirky(withSchema(tools, 'logseq_search_by_relationship', s => { s.properties.relationship_type.enum[0] = 'refs'; }));
    expect(compareToolLists(tools, enumValue)).toEqual([expect.stringContaining('relationship_type.enum[0]: expected "references", got "refs"')]);
  });

  it('fails on a missing, renamed or retitled tool, and on changed annotations', async () => {
    const tools = await loadToolList();
    expect(compareToolLists(tools, tools.slice(1))).toEqual([`${tools[0].name}: missing`]);
    const renamed = tools.map(t => (t.name === 'logseq_get_page' ? { ...t, name: 'logseq_get_page_v2' } : t));
    expect(compareToolLists(tools, renamed)).toEqual(['logseq_get_page: missing', 'logseq_get_page_v2: not in the reference']);
    const retitled = tools.map(t => (t.name === 'logseq_get_page' ? { ...t, title: 'Page' } : t));
    expect(compareToolLists(tools, retitled)).toEqual(['logseq_get_page.title: expected "Get Page", got "Page"']);
    const annotated = tools.map(t => (t.name === 'logseq_get_page' ? { ...t, annotations: { ...(t.annotations as Schema), readOnlyHint: false } } : t));
    expect(compareToolLists(tools, annotated)).toEqual(['logseq_get_page.annotations.readOnlyHint: expected true, got false']);
  });

  it('keeps a property named format, and null on a required property', async () => {
    const tools = await loadToolList();
    const noFormat = withSchema(tools, 'logseq_get_page', s => { delete s.properties.format; });
    expect(compareToolLists(tools, noFormat)).toEqual([
      expect.stringMatching(/^logseq_get_page\.inputSchema\.properties\.format: expected \{.*"enum":\["json","markdown"\].*\}, got nothing$/)
    ]);
    // The five tools with a `format` parameter: its enum and description still count
    const withFormat = tools.filter(t => 'format' in ((t.inputSchema as Schema).properties ?? {})).map(t => t.name);
    expect(withFormat).toHaveLength(5);
    for (const name of withFormat) {
      const enumChanged = withSchema(tools, name, s => { s.properties.format.enum = ['json']; });
      expect(compareToolLists(tools, enumChanged), name).toEqual([`${name}.inputSchema.properties.format.enum: expected ["json","markdown"], got ["json"]`]);
      const described = quirky(withSchema(tools, name, s => { s.properties.format.description = 'other'; }));
      expect(compareToolLists(tools, described), name).toEqual([expect.stringMatching(new RegExp(`^${name}\\.inputSchema\\.properties\\.format\\.description: expected ".+", got "other"$`))]);
    }
    const nullable = withSchema(tools, 'logseq_build_context', s => { s.properties.topic_name.type = ['string', 'null']; });
    expect(compareToolLists(tools, nullable)).toEqual([
      'logseq_build_context.inputSchema.properties.topic_name.type: expected "string", got ["string","null"]'
    ]);
  });
});

describe('toolsCalledBy (a server with only some tools, #125)', () => {
  it('keeps the reference entries for the tools the cases call, and fails any other tool the server lists', async () => {
    const tools = await loadToolList();
    const reference = toolsCalledBy(tools, getPageOutlineCases);
    expect(reference.map(t => t.name)).toEqual(['logseq_get_page_outline']);
    // a server listing just that tool, as the reference has it, is the same
    expect(compareToolLists(reference, reference)).toEqual([]);
    // a second tool it shouldn't have is reported, and so is a change to the tool it has
    const extra = tools.find(t => t.name === 'logseq_get_page') as ProjectedTool;
    expect(compareToolLists(reference, [...reference, extra])).toEqual(['logseq_get_page: not in the reference']);
    expect(compareToolLists(reference, [{ ...reference[0], title: 'Outline' }])).toEqual([
      'logseq_get_page_outline.title: expected "Get Page Outline", got "Outline"'
    ]);
    // without the option every other tool is missing
    expect(compareToolLists(tools, reference)).toHaveLength(tools.length - 1);
  });
});

describe('normalizeSchema', () => {
  it('is pure: it leaves its argument alone', () => {
    const schema = { $schema: 'x', type: 'object', properties: { a: { $ref: '#/$defs/A' } }, required: ['b', 'a'], $defs: { A: { type: 'string' } } };
    const before = structuredClone(schema);
    expect(normalizeSchema(schema)).toEqual({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'b'] });
    expect(schema).toEqual(before);
  });

  it('keeps parameter names in the name maps, even when a name is a keyword', () => {
    const schema = {
      properties: { format: { type: 'string', format: 'x' }, title: { type: 'string' }, $schema: { type: 'number' }, $ref: { type: 'boolean' } },
      patternProperties: { '^title$': { type: 'string', title: 'T' } },
      dependentSchemas: { format: { required: ['b', 'a'] } }
    };
    expect(normalizeSchema(schema)).toEqual({
      properties: { format: { type: 'string' }, title: { type: 'string' }, $schema: { type: 'number' }, $ref: { type: 'boolean' } },
      patternProperties: { '^title$': { type: 'string' } },
      dependentSchemas: { format: { required: ['a', 'b'] } }
    });
  });

  it('normalizes quirks under every subschema position, and still sees a real difference there', () => {
    // One schema with a leaf at each position; `leaf` is the plain form, `quirkyLeaf` the same meaning
    const nest = (leaf: (n: number) => Schema): Schema => ({
      type: 'object',
      properties: {
        a: { type: 'array', items: leaf(1), prefixItems: [leaf(2)], contains: leaf(3), unevaluatedItems: leaf(17) },
        // Draft 2019-09 and earlier: a list of `items`, then `additionalItems`
        b: { type: 'array', items: [leaf(18)], additionalItems: leaf(19) }
      },
      unevaluatedProperties: leaf(20),
      additionalProperties: leaf(4),
      patternProperties: { '^x': leaf(5) },
      propertyNames: leaf(6),
      dependentSchemas: { a: leaf(7) },
      not: leaf(8),
      anyOf: [leaf(9), { type: 'null', description: 'kept: not an optional property' }],
      oneOf: [leaf(10), leaf(11)],
      allOf: [leaf(12), leaf(13)],
      if: leaf(14),
      then: leaf(15),
      else: leaf(16)
    });
    const leaf = (n: number): Schema => ({ type: 'string', maxLength: n, enum: ['p', 'q'] });
    const defs: Schema = {};
    const quirkyLeaf = (n: number): Schema => {
      defs[`L${n}`] = { title: `L${n}`, format: 'f', enum: ['p', 'q'], maxLength: n, type: 'string' };
      return { $ref: `#/definitions/L${n}` };
    };
    const plain = nest(leaf);
    const quirkyForm = { $schema: 's', ...nest(quirkyLeaf), definitions: defs };
    expect(normalizeSchema(quirkyForm)).toEqual(normalizeSchema(plain));
    expect(JSON.stringify(normalizeSchema(quirkyForm))).not.toMatch(/"\$ref"|"definitions"|"format"|"title"|"\$schema"/);

    const tool = (inputSchema: unknown): ProjectedTool => ({ name: 'x', inputSchema });
    for (let n = 1; n <= 20; n++) {
      const changed = structuredClone(quirkyForm);
      changed.definitions[`L${n}`].maxLength = 99;
      expect(compareToolLists([tool(plain)], [tool(changed)]), `position ${n}`).toEqual([expect.stringMatching(new RegExp(`maxLength: expected ${n}, got 99$`))]);
    }
  });

  it('keeps clashing keywords of a $ref and its siblings as an allOf, so they still differ', () => {
    const schema = { properties: { a: { $ref: '#/$defs/A', type: 'number' } }, $defs: { A: { type: 'string' } } };
    expect(normalizeSchema(schema)).toEqual({ properties: { a: { allOf: [{ type: 'string' }, { type: 'number' }] } } });
  });

  it('reports a recursive or dangling $ref as a failure instead of looping', () => {
    const tool = (inputSchema: unknown): ProjectedTool => ({ name: 'x', inputSchema });
    const recursive = { properties: { a: { $ref: '#/$defs/A' } }, $defs: { A: { properties: { b: { $ref: '#/$defs/A' } } } } };
    expect(compareToolLists([tool({})], [tool(recursive)])).toEqual([expect.stringContaining('is recursive')]);
    expect(compareToolLists([tool({})], [tool({ $ref: '#/$defs/Nope' })])).toEqual([expect.stringContaining('points at nothing')]);
    // An anchor is not a JSON pointer: it fails rather than resolving to the root
    const anchored = { properties: { a: { $ref: '#Foo' } }, $defs: { Foo: { $anchor: 'Foo', type: 'string' } } };
    expect(compareToolLists([tool({})], [tool(anchored)])).toEqual([expect.stringContaining('only local JSON pointers are supported')]);
  });

  it('drops null only from optional top-level arguments, not from nested objects', () => {
    const tool = (inputSchema: unknown): ProjectedTool => ({ name: 'x', inputSchema });
    const schema = (a: unknown, b: unknown) => ({
      type: 'object',
      properties: { a, opts: { type: 'object', properties: { b } } }
    });
    const plain = schema({ type: 'string' }, { type: 'string' });
    // Top level: the TypeScript server drops an explicit null, so these mean the same
    expect(compareToolLists([tool(plain)], [tool(schema({ type: ['string', 'null'] }, { type: 'string' }))])).toEqual([]);
    expect(compareToolLists([tool(plain)], [tool(schema({ anyOf: [{ type: 'string' }, { type: 'null' }] }, { type: 'string' }))])).toEqual([]);
    // Nested: zod rejects null there, so accepting it is a difference
    expect(compareToolLists([tool(plain)], [tool(schema({ type: 'string' }, { type: ['string', 'null'] }))])).toEqual([
      'x.inputSchema.properties.opts.properties.b.type: expected "string", got ["string","null"]'
    ]);
    expect(compareToolLists([tool(plain)], [tool(schema({ type: 'string' }, { anyOf: [{ type: 'string' }, { type: 'null' }] }))])).toHaveLength(2);
  });
});

describe('the server environment', () => {
  it('gives the server a sandboxed home, so a server that ignores LOGSEQ_MCP_CONFIG finds no fallback config', async () => {
    const report = await runParity({
      server: viteNodeCommand('env-report-server.ts'),
      cases: [{ name: 'env', tool: 'report_env', arguments: {}, steps: [] }],
      snapshotFile: SNAPSHOT_FILE
    });
    const text = report.results.env?.content?.[0]?.text;
    expect(typeof text, report.failures.join('\n')).toBe('string');
    const env = JSON.parse(text as string) as Record<string, string | null>;

    const dir = dirname(env.LOGSEQ_MCP_CONFIG!);
    expect(dir).toContain('logseq-parity-');
    expect(env.HOME).toBe(join(dir, 'home'));
    expect(env.HOME).not.toBe(homedir());
    expect(env.USERPROFILE).toBe(env.HOME);
    expect(env.XDG_CONFIG_HOME).toBe(join(env.HOME!, '.config'));
    expect(env.CFFIXED_USER_HOME).toBe(process.platform === 'darwin' ? env.HOME : null);
  }, 60000);

  it('fixes the clock and the time zone, so a result that depends on today is the same on every day (#311)', async () => {
    const report = await runParity({
      server: viteNodeCommand('env-report-server.ts'),
      cases: [{ name: 'env', tool: 'report_env', arguments: {}, steps: [] }],
      snapshotFile: SNAPSHOT_FILE
    });
    const env = JSON.parse(report.results.env?.content?.[0]?.text as string) as Record<string, string | null>;
    expect(env.LOGSEQ_MCP_NOW).toBe(String(PARITY_NOW_MS));
    expect(env.TZ).toBe(PARITY_TZ);
    // 03:30 UTC on the 12th is 23:30 on the 11th in New York (daylight saving began on the 9th)
    expect(new Date(PARITY_NOW_MS).toISOString()).toBe('2025-03-12T03:30:00.000Z');
    expect(new Date(PARITY_NOW_MS).toLocaleDateString('en-CA', { timeZone: PARITY_TZ })).toBe('2025-03-11');
  }, 60000);
});

describe('runParity on a server that returns before its other calls are sent (#340)', () => {
  const lateCase: ParityCase = {
    name: 'late calls',
    tool: 'late_calls',
    arguments: {},
    steps: [
      ['getCurrentPage', 'getCurrentBlock', 'getSelectedBlocks'].map(name => ({ method: `logseq.Editor.${name}`, args: [], response: null }))
    ]
  };
  // The fake lists only its own tool, so tools/list fails the snapshot; the cases' own failures are what this asks about
  const caseFailures = (failures: string[]) => failures.filter(f => f.startsWith('[late_calls: '));

  it('sees all three calls of each case, because it waits for them before it reads the log', async () => {
    const report = await runParity({
      server: viteNodeCommand('late-calls-server.ts'),
      cases: [lateCase, { ...lateCase, name: 'late calls again' }],
      snapshotFile: SNAPSHOT_FILE
    });
    expect(caseFailures(report.failures)).toEqual([]);
  }, 60000);

  it('would fail without the wait: the calls come after the result, and the next case would find them', async () => {
    const report = await runParity({
      server: viteNodeCommand('late-calls-server.ts'),
      cases: [lateCase, { ...lateCase, name: 'late calls again' }],
      snapshotFile: SNAPSHOT_FILE,
      settleMs: 0
    });
    expect(caseFailures(report.failures).join('\n')).toMatch(/\[late_calls: late calls\] LogSeq calls, step 1 of 1: expected the 3 calls/);
  }, 60000);
});

describe('the parity command line (--tested-tools-only, #125)', () => {
  it('reads the flag with the server command intact, in any mode', () => {
    expect(parseCommandLine(['--tested-tools-only', '--', 'x', 'a', '--b'])).toEqual({
      mode: 'check',
      server: { command: 'x', args: ['a', '--b'] },
      onlyTestedTools: true,
      isReference: false
    });
    expect(parseCommandLine(['--self-check', '--tested-tools-only', '--', 'x'])).toMatchObject({ mode: 'self-check', onlyTestedTools: true });
    expect(parseCommandLine(['--perturb', '--', 'x'])).toMatchObject({ mode: 'perturb', onlyTestedTools: false });
    // no flag and no command: the TypeScript server, compared on the whole tools/list
    expect(parseCommandLine([])).toMatchObject({ mode: 'check', onlyTestedTools: false, server: typescriptServer(), isReference: true });
    // any command after `--` is a candidate, held to the rules for the closest names
    expect(parseCommandLine(['--', 'x'])).toMatchObject({ isReference: false });
  });

  it('finds the server command without a `--`, which vite-node removes from the arguments', () => {
    expect(parseCommandLine(['--tested-tools-only', '/bin/server', '--b', 'c'])).toEqual({
      mode: 'check',
      server: { command: '/bin/server', args: ['--b', 'c'] },
      onlyTestedTools: true,
      isReference: false
    });
    expect(parseCommandLine(['--self-check', '/bin/server'])).toMatchObject({ mode: 'self-check', server: { command: '/bin/server' } });
    // only flags: the TypeScript server
    expect(parseCommandLine(['--self-check'])).toMatchObject({ mode: 'self-check', server: typescriptServer() });
    // a candidate still can't record, with or without the `--`
    expect(() => parseCommandLine(['--record', '/bin/server'])).toThrow(/a candidate can't record its own reference/);
  });

  it('refuses --record with the flag, since a reference must hold every tool, and a candidate can not record', () => {
    expect(() => parseCommandLine(['--record', '--tested-tools-only'])).toThrow(/--record needs the whole tools\/list, so it can't take --tested-tools-only/);
    expect(() => parseCommandLine(['--tested-tools-only', '--record'])).toThrow(/--record needs the whole tools\/list/);
    expect(() => parseCommandLine(['--record', '--', 'x'])).toThrow(/a candidate can't record its own reference/);
    expect(() => parseCommandLine(['--tested-tools-only', '--'])).toThrow(/no server command after --/);
    expect(() => parseCommandLine(['--nope'])).toThrow(/unknown flag --nope/);
  });
});

describe('the parity command line (--real-clock, #359)', () => {
  it('reads the flag with the server command intact, in any mode but record', () => {
    expect(parseCommandLine(['--real-clock', '--', 'x', 'a'])).toEqual({
      mode: 'check',
      server: { command: 'x', args: ['a'] },
      onlyTestedTools: false,
      realClock: true
    });
    expect(parseCommandLine(['--real-clock', '/bin/server'])).toMatchObject({ realClock: true, server: { command: '/bin/server' } });
    expect(parseCommandLine(['--self-check', '--real-clock', '--', 'x'])).toMatchObject({ mode: 'self-check', realClock: true });
    expect(parseCommandLine(['--', 'x'])).toMatchObject({ realClock: false });
    expect(() => parseCommandLine(['--record', '--real-clock'])).toThrow(/--record needs every case, so it can't take --real-clock/);
  });
});

describe('withoutClockCases (#359)', () => {
  const some = (name: string): ParityCase => ({ name, tool: 't', arguments: {}, steps: [] });

  it('leaves out the cases that read today and keeps the order of the rest', () => {
    const cases = [some('a'), some('b'), some('c')];
    expect(withoutClockCases(cases, ['b']).map(c => c.name)).toEqual(['a', 'c']);
    expect(withoutClockCases(cases, []).map(c => c.name)).toEqual(['a', 'b', 'c']);
  });

  it('refuses a listed name that no case has, so a rename cannot leave a stale one', () => {
    expect(() => withoutClockCases([some('a')], ['a', 'gone'])).toThrow(/names case\(s\) that don't exist: gone/);
  });

  it('names only real cases, and none twice', () => {
    expect(() => withoutClockCases(allCases())).not.toThrow();
    expect(new Set(CLOCK_CASES).size).toBe(CLOCK_CASES.length);
  });

  it('keeps every case that does not read the clock', () => {
    expect(withoutClockCases(allCases())).toHaveLength(allCases().length - CLOCK_CASES.length);
  });
});

describe('perturbCases', () => {
  const call = (response: unknown): CannedCall => ({ method: 'logseq.Editor.getAllPages', args: [], response });
  const two = (extra: Partial<ParityCase> = {}): ParityCase => ({
    name: 'two calls',
    tool: 'logseq_list_pages',
    arguments: {},
    steps: [[call([{ name: 'first' }])], [call([{ name: 'second' }])]],
    ...extra
  });
  const lastAnswer = (c: ParityCase) => c.steps.at(-1)!.at(-1)!.response;
  const firstAnswer = (c: ParityCase) => c.steps[0][0].response;

  it('suffixes the strings of the last call only, and leaves the case it was given alone', () => {
    const original = two();
    const [perturbed] = perturbCases([original]);
    expect(lastAnswer(perturbed)).toEqual([{ name: 'second (perturbed)' }]);
    expect(firstAnswer(perturbed)).toEqual([{ name: 'first' }]);
    expect(lastAnswer(original)).toEqual([{ name: 'second' }]);
  });

  it('turns an answer with no string into a LogSeq error, and leaves a case with no calls as it is', () => {
    const [noStrings, noCalls] = perturbCases([two({ steps: [[call([])]] }), two({ steps: [] })]);
    expect(lastAnswer(noStrings)).toEqual({ error: 'parity harness: perturbed answer' });
    expect(noCalls.steps).toEqual([]);
  });

  it('gives the last call the answer a case names in perturbed, whatever it is, and no other call', () => {
    for (const perturbed of [[], null, 0, '', false, { rows: 1 }]) {
      const [copy] = perturbCases([two({ perturbed })]);
      expect(lastAnswer(copy)).toEqual(perturbed);
      expect(firstAnswer(copy)).toEqual([{ name: 'first' }]);
    }
  });

  it('does not take a missing perturbed for an answer', () => {
    const [copy] = perturbCases([two({ perturbed: undefined })]);
    // the key is there, so it is the answer: undefined reaches JSON as a missing answer, not as a suffix
    expect(lastAnswer(copy)).toBeUndefined();
    const [plain] = perturbCases([two()]);
    expect('perturbed' in plain).toBe(false);
  });
});

describe('runParity against the TypeScript server', () => {
  it('with onlyTestedTools, fails on every tool the server lists beyond the ones the cases call', async () => {
    // The TypeScript server lists 16 tools and the case calls one: the other 15 are not in the reference
    const barren = getPageOutlineCases.find(c => c.steps.length === 0)!;
    const expected = await loadExpected();
    const report = await runParity({
      server: typescriptServer(),
      cases: [barren],
      expected: { [barren.name]: expected[barren.name] },
      expectedToolList: await loadToolList(),
      onlyTestedTools: true,
      snapshotFile: SNAPSHOT_FILE
    });
    const notInReference = report.failures.filter(f => f.endsWith(': not in the reference'));
    expect(notInReference).toHaveLength((await loadToolList()).length - 1);
    expect(report.failures).toHaveLength(notInReference.length);
  }, 60000);

  it('fails a case on its perturbed answer only when that answer changes what the server prints', async () => {
    const exact = getPageOutlineCases[0];
    const expected = await loadExpected();
    const committed = exact.steps.at(-1)!.at(-1)!.response;
    const run = async (perturbed: unknown) =>
      runParity({
        server: typescriptServer(),
        cases: perturbCases([{ ...exact, perturbed }]),
        expected: { [exact.name]: expected[exact.name] },
        expectedToolList: await loadToolList(),
        onlyTestedTools: true,
        snapshotFile: SNAPSHOT_FILE
      });
    const resultFailures = (report: Awaited<ReturnType<typeof run>>) =>
      report.failures.filter(f => f.startsWith(`[${exact.tool}: ${exact.name}]`));

    // the committed answer prints the committed result: the self-check would say NOT CAUGHT
    expect(resultFailures(await run(committed))).toEqual([]);
    // another answer prints another result: caught
    expect(resultFailures(await run([])).length).toBeGreaterThan(0);
  }, 60000);

  it('passes the TypeScript server against its own recorded results', async () => {
    const report = await runParity({
      server: typescriptServer(),
      cases: getPageOutlineCases,
      expected: await loadExpected(),
      expectedToolList: await loadToolList(),
      snapshotFile: SNAPSHOT_FILE
    });
    expect(report.failures, report.stderr).toEqual([]);
  }, 60000);

  it('passes the TypeScript server against its recorded date-range results, whatever day it is (#311)', async () => {
    // `last_n` and the presets read today's date: the harness fixes the clock and the zone for the server
    const expected = JSON.parse(await readFile(join(REPO_ROOT, 'scripts', 'parity', 'expected', 'query-by-date-range.json'), 'utf8')) as Record<string, ToolResult>;
    const report = await runParity({
      server: typescriptServer(),
      cases: queryByDateRangeCases,
      expected,
      expectedToolList: await loadToolList(),
      snapshotFile: SNAPSHOT_FILE
    });
    expect(report.failures, report.stderr).toEqual([]);
  }, 120000);

  it('fails loud on a perturbed answer, a missing or reordered call, and a changed tools/list', async () => {
    const expected = await loadExpected();
    // A reference in which one bound and one enum value differ from what the server lists
    const expectedToolList = withSchema(
      withSchema(await loadToolList(), 'logseq_check_links', s => { s.properties.before.maxLength = 40000; }),
      'logseq_get_block',
      s => { s.properties.format.enum = ['json', 'html']; }
    );
    const withCalls = getPageOutlineCases.filter(c => c.steps.length > 0);
    const exact = getPageOutlineCases[0];
    const leaf = getPageOutlineCases.find(c => c.steps.length === 3)!;

    const broken: ParityCase[] = [
      ...perturbCases(withCalls),
      // The outline query's answer taken away: the stub has nothing to say to it
      { ...exact, name: 'missing answer', steps: [exact.steps[0], []] },
      // The leaf lookup listed after the outline query, as if they ran the other way round
      { ...leaf, name: 'reordered', steps: [leaf.steps[0], leaf.steps[2], leaf.steps[1]] }
    ];
    const brokenExpected = {
      ...expected,
      'missing answer': expected[exact.name],
      reordered: expected[leaf.name]
    };

    // A snapshot in which the outline tool has another name
    const dir = await mkdtemp(join(tmpdir(), 'parity-test-'));
    const snapshotFile = join(dir, 'tool-list.test.ts.snap');
    const snapshot = await readFile(SNAPSHOT_FILE, 'utf8');
    const changed = snapshot.replace('"name": "logseq_get_page_outline"', '"name": "logseq_get_page_outline_v2"');
    expect(changed).not.toBe(snapshot);
    await writeFile(snapshotFile, changed);

    try {
      const report = await runParity({
        server: typescriptServer(),
        cases: broken,
        expected: brokenExpected,
        expectedToolList,
        snapshotFile
      });
      const failuresOf = (name: string) => report.failures.filter(f => f.startsWith(`[logseq_get_page_outline: ${name}]`));

      // The reference is held to the snapshot byte for byte, and the server to the reference by meaning
      expect(report.failures).toContainEqual(expect.stringMatching(/^the recorded tools\/list differs from the snapshot; re-record it/));
      expect(report.failures).toContainEqual(
        'tools/list differs in meaning, logseq_check_links.inputSchema.properties.before.maxLength: expected 40000, got 50000'
      );
      expect(report.failures).toContainEqual(
        'tools/list differs in meaning, logseq_get_block.inputSchema.properties.format.enum[1]: expected "html", got "markdown"'
      );
      for (const c of withCalls) expect(failuresOf(c.name), c.name).not.toEqual([]);
      expect(failuresOf('missing answer')).toContainEqual(expect.stringContaining('stub: no canned response'));
      expect(failuresOf('reordered')).toContainEqual(expect.stringContaining('LogSeq calls, step 2 of 3'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('runParity on resources against the TypeScript server', () => {
  const expectedPages = async () => JSON.parse(await readFile(expectedFileOf(CASE_GROUPS.find(g => g.name === 'page-resource')!), 'utf8')) as Record<string, ToolResult>;
  const named = (name: string) => pageResourceCases.find(c => c.name === `page resource: ${name}`)!;

  it('reads a page, lists the template and records a JSON-RPC error as the result of its case', async () => {
    const cases = [named('the template'), named('an exact name with its blocks'), named('no such page, with the closest names'), named('no name')];
    const expected = await expectedPages();
    const report = await runParity({
      server: typescriptServer(),
      cases,
      expected: Object.fromEntries(cases.map(c => [c.name, expected[c.name]])),
      expectedToolList: await loadToolList(),
      onlyTestedTools: true,
      snapshotFile: SNAPSHOT_FILE
    });
    // the reference lists the tools the cases call, and a resource case calls none: every tool is beyond it
    expect(report.failures.filter(f => !f.endsWith(': not in the reference')), report.stderr).toEqual([]);
    expect(Object.keys(report.results['page resource: the template'])).toEqual(['resourceTemplates']);
    expect(report.results['page resource: an exact name with its blocks'].contents).toEqual([
      expect.objectContaining({ uri: 'logseq://page/Project%20Atlas', mimeType: 'text/markdown' })
    ]);
    expect(report.results['page resource: no such page, with the closest names'].error).toEqual({
      code: -32002,
      message: expect.stringContaining('MCP error -32002: MCP error -32002: No page "Projct Atlas"')
    });
    expect(report.results['page resource: no name'].error).toEqual({ code: -32602, message: expect.stringContaining('No page name in logseq://page/') });
  }, 60000);

  it('fails a resource case on a perturbed answer that changes the page, and on a changed result', async () => {
    const exact = named('an exact name with its blocks');
    const expected = await expectedPages();
    const run = async (cases: ParityCase[]) =>
      runParity({
        server: typescriptServer(),
        cases,
        expected: { [exact.name]: expected[exact.name] },
        expectedToolList: await loadToolList(),
        onlyTestedTools: true,
        snapshotFile: SNAPSHOT_FILE
      });
    const ofCase = (report: Awaited<ReturnType<typeof run>>) => report.failures.filter(f => f.startsWith(`[${exact.tool}: ${exact.name}]`));

    expect(ofCase(await run([exact]))).toEqual([]);
    expect(ofCase(await run(perturbCases([exact]))).join('\n')).toContain('contents[0].text differs');
  }, 60000);
});


/**
 * The closest-name rules of ADR-0032 (#335). Every name is made up. A "result" is a tool result as the TypeScript
 * server prints it (`{"error": <message>}`, minified) or a JSON-RPC error of the page resource.
 */
describe('the closest-name rules (ADR-0032, #335)', () => {
  const message = (input: string, list?: string) => `No page ${JSON.stringify(input)}.${list === undefined ? '' : ` Closest: ${list}.`} ${GUIDANCE}`;
  const toolResult = (text: string): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ error: text }) }], isError: true });
  const resourceError = (text: string): ToolResult => ({ error: { code: -32002, message: `MCP error -32002: MCP error -32002: ${text}` } });
  const PAGES = ['Alice', 'Alice Notes', 'Alicia Cole', 'Bob', 'Project Atlas', 'Project Zed', 'Project Quill'];

  /** The rule failures of a server that printed `list` where the reference printed `reference`, for the input */
  const judge = (input: string, reference: string | undefined, list: string | undefined, candidates: string[] = PAGES) =>
    compareResultBySuggestionRules(toolResult(message(input, reference)), toolResult(message(input, list)), candidates);

  describe('the fold, the sets and the message', () => {
    it('folds by trimming, dropping accents and lowercasing', () => {
      expect(fold('  Café Ünï  ')).toBe('cafe uni');
      expect(matchesOf('cafe', ['CAFÉ', 'Café Notes', 'Coffee', 'Bob'])).toEqual({
        exact: ['CAFÉ'],
        prefix: ['Café Notes'],
        both: ['CAFÉ', 'Café Notes'],
        covering: ['CAFÉ', 'Café Notes']
      });
    });

    it('reads the input and the list out of the message, in a tool result and in a JSON-RPC error', () => {
      expect(parseNotFound(message('say "hi"', 'A, B'))).toEqual({ opening: 'No page "say \\"hi\\"". Closest: ', input: 'say "hi"', list: 'A, B' });
      expect(parseNotFound(message('x'))).toEqual({ opening: 'No page "x".', input: 'x' });
      expect(parseNotFound(`MCP error -32002: MCP error -32002: ${message('x', 'A')}`)).toMatchObject({ input: 'x', list: 'A' });
      expect(parseNotFound('No page name in logseq://page/. Use logseq://page/{name}.')).toBeUndefined();
    });

    it('splits a list around names that contain ", ", longest first, and says when it can be read two ways', () => {
      const names = ['Smith, Alice', 'Smith', 'Bob'];
      expect(splitList('Smith, Alice, Bob', names)).toEqual([['Smith, Alice', 'Bob']]);
      // "Smith" alone fits too, but "Alice" is not a candidate, so there is one reading
      expect(splitList('Smith, Alice', names)).toEqual([['Smith, Alice']]);
      // with "Alice" a candidate too there are two readings, the longest-first one first
      expect(splitList('Smith, Alice', [...names, 'Alice'])).toEqual([['Smith, Alice'], ['Smith', 'Alice']]);
      // a choice that leaves the rest unreadable is backed out of: "Smith, Alice" first dead-ends, "Smith" first works
      expect(splitList('Smith, Alice, Bob', ['Smith', 'Smith, Alice', 'Alice, Bob'])).toEqual([['Smith', 'Alice, Bob']]);
      expect(splitList('Bob, Bob', ['Bob'])).toEqual([]);
      expect(splitList('A, B, C, D', ['A', 'B', 'C', 'D'])).toEqual([]);
    });

    it('does not record a reference whose list can be read two ways', () => {
      expect(checkReferenceList(message('smi', 'Smith, Alice'), ['Smith', 'Alice', 'Smith, Alice']).join('\n')).toContain('in two ways');
    });
  });

  describe('a list that passes', () => {
    it('is the reference, and also a list that picks other names where the rules leave the choice open', () => {
      const typo = 'Project Atlas, Project Zed, Project Quill';
      expect(judge('Projct', typo, typo)).toEqual([]);
      expect(judge('Projct', typo, 'Project Quill, Project Zed, Project Atlas')).toEqual([]);
      expect(judge('alice', 'Alice, Alice Notes, Alicia Cole', 'Alice, Alice Notes, Alicia Cole')).toEqual([]);
    });

    it('is a message with no list where the reference has none', () => {
      expect(judge('zzz', undefined, undefined)).toEqual([]);
      expect(judge('2031-12-31', undefined, undefined)).toEqual([]);
    });

    it('is read decoded: a name with a quote or a backslash, and one that ends with a full stop or holds ". Try"', () => {
      const names = ['Say "hi" \\ bye', 'Bob', 'Notes v. Try it.', 'Notes v2.'];
      expect(judge('say "hi"', 'Say "hi" \\ bye', 'Say "hi" \\ bye', names)).toEqual([]);
      expect(judge('notes v', 'Notes v2., Notes v. Try it.', 'Notes v. Try it., Notes v2.', names)).toEqual([]);
      // the closing is matched at the end of the message, so the full stop of the last name stays in the list
      expect(parseNotFound(message('notes v', 'Notes v2., Notes v. Try it.'))?.list).toBe('Notes v2., Notes v. Try it.');
    });

    it('reads the page resource error the same way', () => {
      const reference = resourceError(message('Projct', 'Project Atlas, Project Zed, Project Quill'));
      const swapped = resourceError(message('Projct', 'Project Zed, Project Quill, Project Atlas'));
      expect(compareResultBySuggestionRules(reference, swapped, PAGES)).toEqual([]);
      const unrelated = resourceError(message('Projct', 'Bob'));
      expect(compareResultBySuggestionRules(reference, unrelated, PAGES).join('\n')).toContain('rule 5');
    });
  });

  describe('a regression each rule catches', () => {
    const typo = 'Project Atlas, Project Zed, Project Quill';

    it('rule 5: an unrelated name', () => {
      const failures = judge('Projct', typo, 'Project Atlas, Bob, Project Quill').join('\n');
      expect(failures).toContain('rule 5');
      expect(failures).toContain('"Bob" does not cover');
    });

    it('rule 6: too few names', () => {
      expect(judge('Projct', typo, 'Project Atlas, Project Zed').join('\n')).toContain('rule 6: 2 name(s) listed, 3 cover');
      // with fewer covering names than three, fewer is fine
      expect(judge('Projct', 'Project Atlas', 'Project Atlas', ['Project Atlas', 'Bob'])).toEqual([]);
    });

    it('rule 1: a wrong frame', () => {
      const reference = toolResult(message('Projct', typo));
      const wrongGuidance = toolResult('No page "Projct". Closest: Project Atlas. Try something else.');
      expect(compareResultBySuggestionRules(reference, wrongGuidance, PAGES).join('\n')).toContain('rule 1');
      const otherInput = toolResult(message('Projt', typo));
      expect(compareResultBySuggestionRules(reference, otherInput, PAGES).join('\n')).toContain('rule 1');
      // the rest of the result stays byte for byte: the envelope, `isError`
      expect(compareResultBySuggestionRules(reference, { ...reference, isError: false }, PAGES).join('\n')).toContain('isError');
    });

    it('rule 2: a missing list, and a list the reference does not have', () => {
      expect(judge('Projct', typo, undefined).join('\n')).toContain('rule 2: the reference lists closest names, this message lists none');
      expect(judge('zzz', undefined, 'Bob').join('\n')).toContain('rule 2: the reference lists no closest names, this message does');
    });

    it('rule 3: a name that is not a candidate, a repeated name, and four names', () => {
      expect(judge('Projct', typo, 'Project Atlas, Project Zed, Project Quil').join('\n')).toContain('rule 3');
      expect(judge('Projct', typo, 'project atlas, Project Zed, Project Quill').join('\n')).toContain('rule 3');
      expect(judge('Projct', typo, 'Project Atlas, Project Atlas, Project Zed').join('\n')).toContain('rule 3');
      expect(judge('Projct', typo, `${typo}, Alice`).join('\n')).toContain('rule 3');
    });

    it('rule 4: an exact or prefix hit not placed first', () => {
      const reference = 'Alice, Alice Notes, Alicia Cole';
      // a name that only covers the input ahead of the hits
      expect(judge('alice', reference, 'Alicia Cole, Alice, Alice Notes').join('\n')).toContain('rule 4: the first 2 name(s) must be exact or prefix matches');
      // the prefix hit ahead of the exact one
      expect(judge('alice', reference, 'Alice Notes, Alice, Alicia Cole').join('\n')).toContain('rule 4: the prefix match "Alice Notes" is listed before the exact match "Alice"');
      // a prefix hit left out of a list that has a place for it
      const pages = ['Project Atlas', 'Project Zed', 'Project Quill', 'Alicia Cole', 'Alice'];
      expect(judge('proj', 'Project Atlas, Project Zed, Project Quill', 'Project Atlas, Alicia Cole', pages).join('\n')).toContain('rule 4');
      // an input that folds to nothing has no exact or prefix hit to put first
      expect(checkList('Bob, Alice, Alice Notes', '   ', PAGES)).toEqual([]);
    });

    it('rule 4 judges the order among the names listed: which of several exact or prefix hits are listed is open', () => {
      const cafes = ['Café', 'Cafe', 'Café Notes', 'Café Bar'];
      // "Cafe" is an exact match that is not listed, and "Café" is one that is, first: nothing listed is out of order
      expect(checkList('Café, Café Notes, Café Bar', 'cafe', cafes)).toEqual([]);
      // a listed exact match after a prefix match
      expect(checkList('Café Notes, Café Bar, Café', 'cafe', cafes).join('\n')).toContain('rule 4: the prefix match "Café Notes" is listed before the exact match "Café"');
      expect(checkList('Café Notes, Café Bar, Cafe', 'cafe', ['Cafe', 'Café Notes', 'Café Bar', 'Café Cup']).join('\n')).toContain('rule 4');
      // no exact match listed at all, because the matcher left it out: only prefix matches, all in order
      expect(checkList('Café Notes, Café Bar, Café Cup', 'cafe', ['Cafe', 'Café Notes', 'Café Bar', 'Café Cup'])).toEqual([]);
    });
  });

  describe('the rest of a result', () => {
    it('stays byte for byte when the reference has no page-not-found message', () => {
      const ok: ToolResult = { content: [{ type: 'text', text: '{"name":"Alice"}' }] };
      expect(compareResultBySuggestionRules(ok, ok, PAGES)).toEqual([]);
      expect(compareResultBySuggestionRules(ok, { content: [{ type: 'text', text: '{"name":"alice"}' }] }, PAGES).join('\n')).toContain('content[0].text differs');
      // a page-not-found message where the reference printed something else is a plain difference
      expect(compareResultBySuggestionRules(ok, toolResult(message('x', 'Bob')), PAGES).join('\n')).toContain('content[0].text differs');
    });

    it('fails a result that has no message where the reference has one', () => {
      const failures = compareResultBySuggestionRules(toolResult(message('Projct', 'Project Atlas')), { content: [{ type: 'text', text: '{"name":"Alice"}' }] }, PAGES);
      expect(failures.join('\n')).toContain('content[0].text differs');
    });
  });

  describe('the recorded set', () => {
    const recorded = async () => {
      const results: Record<string, ToolResult> = {};
      for (const group of CASE_GROUPS) Object.assign(results, JSON.parse(await readFile(expectedFileOf(group), 'utf8')));
      return results;
    };

    it('holds every case the ADR requires, and the TypeScript results pass the rules they are the reference for', async () => {
      const results = await recorded();
      expect(missingRequiredCases(allCases(), results)).toEqual([]);
      expect(checkReferenceLists(allCases(), results)).toEqual([]);
    });

    it('fails when a required case is missing, naming it', async () => {
      const results = await recorded();
      const lacking = missingRequiredCases(allCases().filter(c => !c.name.startsWith('suggestions: ')), results).join('\n');
      for (const kind of ['an exact hit', 'a prefix hit', 'more than three exact or prefix matches', 'no suggestion: an input no candidate covers', 'a listed name that contains ", "']) {
        expect(lacking).toContain(kind);
      }
      // the typo, the ISO date and the page resource's error are recorded in other groups
      expect(lacking).not.toContain('a typo');
      expect(lacking).not.toContain('an ISO date');
      expect(lacking).not.toContain('page resource');
      expect(missingRequiredCases([], {})).toHaveLength(REQUIRED_CASES.length);
    });

    it('sorts a case by what it exercises', async () => {
      const results = await recorded();
      const kinds = (name: string) => requiredKindsOf(allCases().find(c => c.name === name)!, results[name]);
      expect(kinds('suggestions: an exact hit comes before the prefix hits')).toEqual(['an exact hit (E and P both non-empty)']);
      expect(kinds('suggestions: a prefix hit')).toEqual(['a prefix hit (E empty, P non-empty)']);
      expect(kinds('suggestions: more than three prefix hits')).toEqual(['a prefix hit (E empty, P non-empty)', 'more than three exact or prefix matches']);
      expect(kinds('suggestions: no page covers the input')).toEqual(['no suggestion: an input no candidate covers']);
      expect(kinds('suggestions: a name that contains a comma and a space')).toEqual([
        'a typo with no prefix match and at least one covering name',
        'a listed name that contains ", "'
      ]);
      expect(kinds('page resource: no such page, with the closest names')).toEqual([
        'a typo with no prefix match and at least one covering name',
        "the page resource's error"
      ]);
      expect(kinds('missing page with suggestions')).toEqual(['a typo with no prefix match and at least one covering name']);
      expect(kinds('missing journal date')).toEqual(['no suggestion: an ISO date']);
    });

    it('refuses to record a reference that breaks a rule', () => {
      const bad = { name: 'x', steps: [[{ method: 'logseq.Editor.getAllPages', args: [], response: PAGES.map(originalName => ({ originalName })) }]] };
      expect(checkReferenceLists([bad], { x: toolResult(message('Projct', 'Bob')) }).join('\n')).toContain('rule 5');
      expect(checkReferenceLists([bad], { x: toolResult(message('Projct', 'Project Atlas, Project Zed, Project Quill')) })).toEqual([]);
      expect(candidatesOf(bad.steps)).toEqual(PAGES);
    });

    it('is checked by the self-check, which fails when a kind of wrong list applies to no case', async () => {
      const report = checkWrongLists(allCases(), await recorded());
      expect(report.ok, report.lines.join('\n')).toBe(true);
      const barren = checkWrongLists([], {});
      expect(barren.ok).toBe(false);
      expect(barren.lines.join('\n')).toContain('no recorded case it applies to');
    });
  });

  describe('against the TypeScript server', () => {
    it('judges a perturbed run by the candidates as committed, so a list that reads the fixture is caught', async () => {
      const group = CASE_GROUPS.find(g => g.name === 'suggestions')!;
      const expected = JSON.parse(await readFile(expectedFileOf(group), 'utf8')) as Record<string, ToolResult>;
      const prefixHit = suggestionsCases.find(c => c.name.endsWith('a prefix hit'))!;
      const run = async (unperturbedCases?: ParityCase[]) =>
        runParity({
          server: typescriptServer(),
          cases: perturbCases([prefixHit]),
          unperturbedCases,
          expected: { [prefixHit.name]: expected[prefixHit.name] },
          expectedToolList: await loadToolList(),
          onlyTestedTools: true,
          bySuggestionRules: true,
          snapshotFile: SNAPSHOT_FILE
        });
      const ofCase = (report: Awaited<ReturnType<typeof run>>) => report.failures.filter(f => f.startsWith(`[${prefixHit.tool}: ${prefixHit.name}]`));
      // the perturbed names are candidates of the perturbed case, so by its own candidates the list passes
      expect(ofCase(await run())).toEqual([]);
      // by the committed candidates, "Project Zed (perturbed)" is not a page
      expect(ofCase(await run([prefixHit])).join('\n')).toContain('rule 3');
    }, 60000);

    it('passes its own run under the rules, since the rules accept the reference list', async () => {
      const group = CASE_GROUPS.find(g => g.name === 'suggestions')!;
      const report = await runParity({
        server: typescriptServer(),
        cases: suggestionsCases,
        expected: JSON.parse(await readFile(expectedFileOf(group), 'utf8')) as Record<string, ToolResult>,
        expectedToolList: await loadToolList(),
        onlyTestedTools: true,
        bySuggestionRules: true,
        snapshotFile: SNAPSHOT_FILE
      });
      expect(report.failures.filter(f => f.startsWith('[logseq_get_page: suggestions: '))).toEqual([]);
    }, 60000);
  });
});
