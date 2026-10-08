import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getPageOutlineCases } from '../scripts/parity/cases/get-page-outline.js';
import {
  compareCalls,
  compareResult,
  perturbCases,
  readSnapshotEntry,
  runParity,
  serializeLikeVitest,
  TOOL_LIST_SNAPSHOT_KEY,
  type ParityCase,
  type ToolResult
} from '../scripts/parity/harness.js';
import { callKey, DATASCRIPT_QUERY, LOGSEQ_PORT, startStubLogseq, type CannedCall } from '../scripts/parity/stub-logseq.js';
import { compareToolLists, normalizeSchema, type ProjectedTool } from '../scripts/parity/tool-list-compare.js';
import { REPO_ROOT, SNAPSHOT_FILE, typescriptServer, viteNodeCommand } from '../scripts/parity/ts-server.js';

/**
 * The differential parity harness (#124, ADR-0025 Decision 2). The end-to-end tests start the
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

  it('keys a query by its text without layout, and other methods by their args', () => {
    expect(callKey({ method: DATASCRIPT_QUERY, args: ['[:find\n   ?a]', '"x"'] })).toBe(`${DATASCRIPT_QUERY} [:find ?a]`);
    expect(callKey({ method: 'logseq.Editor.getPage', args: ['alice'] })).toBe('logseq.Editor.getPage ["alice"]');
  });
});

describe('the parity cases', () => {
  it('have an expected result each, recorded from the TypeScript server', async () => {
    const expected = await loadExpected();
    expect(Object.keys(expected).sort()).toEqual(getPageOutlineCases.map(c => c.name).sort());
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
      ['type', withSchema(tools, 'logseq_build_context', s => { s.properties.max_blocks.type = 'integer'; }),
        'logseq_build_context.inputSchema.properties.max_blocks.type: expected "number", got "integer"'],
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
      properties: { a: { type: 'array', items: leaf(1), prefixItems: [leaf(2)], contains: leaf(3) } },
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
    for (let n = 1; n <= 16; n++) {
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
});

describe('runParity against the TypeScript server', () => {
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
