// The differential parity harness (#124, ADR-0031 (second-implementation-matches-tool-list-by-meaning)
// Decision 2). It runs a server command over
// stdio, points it at the stub LogSeq through a temporary LOGSEQ_MCP_CONFIG, and checks three
// things against what the TypeScript server does:
//   1. `tools/list`, by meaning (#292, tool-list-compare.ts) against the one recorded from the
//      TypeScript server, which must itself match the ADR-0016 snapshot in
//      src/__snapshots__/tool-list.test.ts.snap byte for byte;
//   2. each case's tool result, byte for byte as the TypeScript server serialized it (ADR-0009);
//   3. the LogSeq calls and their inputs: the steps of a case in order, the calls within a step
//      (ones the TypeScript code makes concurrently) as a set.
// Any LogSeq call the stub has no answer for is a failure too.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { format } from '@vitest/pretty-format';
import { compareToolLists, type ProjectedTool } from './tool-list-compare.js';
import { toolListForSnapshot } from './tool-list-projection.js';
import { DATASCRIPT_QUERY, normalizeQuery, startStubLogseq, type CannedCall, type LogseqCall } from './stub-logseq.js';

/** One tool call and the LogSeq traffic it should cause. Fixtures are synthetic only (BR-0001). */
export interface ParityCase {
  /** Unique; the key of the case's result in the expected file */
  name: string;
  tool: string;
  arguments: Record<string, unknown>;
  /**
   * The calls the server should make, with the stub's answers. Steps run in order; the calls in
   * one step are the ones the TypeScript code makes concurrently, and are compared as a set.
   */
  steps: CannedCall[][];
}

/**
 * A tool result as the client received it, minus the JSON-RPC framing: every key the server sent
 * (`content`, `isError`, `structuredContent`, `_meta`, ...) and every field of every content block.
 * An absent `isError` and `isError: false` are different results.
 */
export type ToolResult = { content?: Array<Record<string, unknown>> } & Record<string, unknown>;

/**
 * The command that starts the server under test. It must speak MCP over stdio and read its config
 * from the file `LOGSEQ_MCP_CONFIG` names, which points it at the stub. Its home directory is a
 * fresh temp dir (see {@link sandboxedEnv}), so a server that ignores the variable finds no config
 * to fall back on and can't reach a real LogSeq (BR-0001).
 */
export interface ServerCommand {
  command: string;
  args: string[];
  cwd?: string;
}

export interface ParityOptions {
  server: ServerCommand;
  cases: ParityCase[];
  /** Expected result per case name, as recorded from the TypeScript server. Omit to record. */
  expected?: Record<string, ToolResult>;
  /**
   * The tools/list recorded from the TypeScript server, in the snapshot's shape. The server's list
   * is compared with it by meaning. Omit to record: the list must then match the snapshot exactly.
   */
  expectedToolList?: ProjectedTool[];
  /** The vitest snapshot file holding the tools/list snapshot */
  snapshotFile: string;
  /** Milliseconds to wait for each MCP request */
  timeoutMs?: number;
}

export interface ParityReport {
  failures: string[];
  /** What the server returned for each case, to record as the expected file */
  results: Record<string, ToolResult>;
  /** The server's tools/list in the snapshot's shape, to record as the expected tool list */
  toolList?: ProjectedTool[];
  /** The server's stderr, to explain a failure (everything the stub serves is synthetic) */
  stderr: string;
}

/** Key of the tools/list snapshot in the snapshot file (src/tool-list.test.ts). */
export const TOOL_LIST_SNAPSHOT_KEY = 'tools/list guardrails > matches the tool list snapshot 1';

/**
 * Serialize a value as vitest writes it into a `.snap` file: pretty-format with vitest's snapshot
 * options (no `Object`/`Array` prefixes, strings unescaped), a multi-line value wrapped in newlines.
 */
export function serializeLikeVitest(value: unknown): string {
  const text = format(value, {
    indent: 2,
    escapeRegex: true,
    printFunctionName: false,
    printBasicPrototype: false,
    escapeString: false
  }).replace(/\r\n|\r/g, '\n');
  return text.includes('\n') ? `\n${text}\n` : text;
}

/** One entry of a vitest snapshot file, which is JavaScript: read the way vitest reads it. */
export function readSnapshotEntry(fileText: string, key: string): string {
  const data: Record<string, string> = Object.create(null);
  // A .snap file is only `exports[key] = \`...\`;` statements
  new Function('exports', fileText)(data);
  const entry = data[key];
  if (entry === undefined) throw new Error(`snapshot ${JSON.stringify(key)} not found`);
  return entry;
}

/** The first line where two texts differ. */
export function firstDifference(expected: string, actual: string): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}:\n  expected: ${JSON.stringify(a[i] ?? '<end>')}\n  actual:   ${JSON.stringify(b[i] ?? '<end>')}`;
    }
  }
  return 'texts are equal';
}

/** A call in comparable form: the query text with its whitespace collapsed, the inputs as sent. */
const canonical = (call: LogseqCall): string =>
  JSON.stringify([
    call.method,
    call.method === DATASCRIPT_QUERY && typeof call.args[0] === 'string'
      ? [normalizeQuery(call.args[0]), ...call.args.slice(1)]
      : call.args
  ]);

/**
 * Compare the calls a server made with a case's steps: each step's calls must be the next ones
 * made, in any order within the step, and nothing may follow the last step.
 */
export function compareCalls(steps: readonly CannedCall[][], actual: readonly LogseqCall[]): string[] {
  const failures: string[] = [];
  let at = 0;
  steps.forEach((step, s) => {
    const want = step.map(canonical).sort();
    const got = actual.slice(at, at + step.length).map(canonical).sort();
    at += step.length;
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      failures.push(
        `step ${s + 1} of ${steps.length}: expected ${step.length === 1 ? 'the call' : `the ${step.length} calls (any order)`}\n` +
          want.map(c => `    ${c}`).join('\n') +
          '\n  got\n' +
          (got.length ? got.map(c => `    ${c}`).join('\n') : '    nothing')
      );
    }
  });
  if (actual.length > at) {
    failures.push(`${actual.length - at} call(s) after the last step:\n` + actual.slice(at).map(c => `    ${canonical(c)}`).join('\n'));
  }
  return failures;
}

/** A tool result as plain JSON data, every key kept. */
export function toToolResult(result: Record<string, unknown>): ToolResult {
  return JSON.parse(JSON.stringify(result)) as ToolResult;
}

function firstCharDifference(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** JSON with object keys sorted, to compare values whose key order doesn't matter. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v
  );
}

/** Keys one object has and the other lacks, as failure lines. */
function keyDifferences(where: string, expected: object, actual: object): string[] {
  const want = new Set(Object.keys(expected));
  const got = new Set(Object.keys(actual));
  const missing = [...want].filter(k => !got.has(k)).sort();
  const unexpected = [...got].filter(k => !want.has(k)).sort();
  return [
    ...(missing.length ? [`${where} lacks key(s) ${missing.join(', ')}`] : []),
    ...(unexpected.length ? [`${where} has unexpected key(s) ${unexpected.join(', ')}`] : [])
  ];
}

/**
 * Compare a result with the expected one: the same top-level keys, the same content blocks with
 * the same fields, each `text` byte for byte (ADR-0009), and every other value equal.
 */
export function compareResult(expected: ToolResult, actual: ToolResult): string[] {
  const failures = keyDifferences('the result', expected, actual);
  for (const key of Object.keys(expected)) {
    if (key === 'content' || !(key in actual)) continue;
    if (stable(expected[key]) !== stable(actual[key])) {
      failures.push(`${key}: expected ${stable(expected[key])}, got ${stable(actual[key])}`);
    }
  }
  if (!('content' in expected && 'content' in actual)) return failures;
  const wantBlocks = expected.content ?? [];
  const gotBlocks = actual.content ?? [];
  if (wantBlocks.length !== gotBlocks.length) {
    failures.push(`expected ${wantBlocks.length} content block(s), got ${gotBlocks.length}`);
  }
  for (let i = 0; i < Math.min(wantBlocks.length, gotBlocks.length); i++) {
    const want = wantBlocks[i];
    const got = gotBlocks[i];
    failures.push(...keyDifferences(`content[${i}]`, want, got));
    for (const key of Object.keys(want)) {
      if (!(key in got)) continue;
      if (key === 'text' && typeof want.text === 'string' && typeof got.text === 'string') {
        if (want.text !== got.text) {
          const at = firstCharDifference(want.text, got.text);
          const around = (t: string) => JSON.stringify(t.slice(Math.max(0, at - 40), at + 40));
          failures.push(`content[${i}].text differs at character ${at}:\n  expected: ${around(want.text)}\n  actual:   ${around(got.text)}`);
        }
      } else if (stable(want[key]) !== stable(got[key])) {
        failures.push(`content[${i}].${key}: expected ${stable(want[key])}, got ${stable(got[key])}`);
      }
    }
  }
  return failures;
}

/**
 * The caller's environment, with the config pointed at the stub, tips left at their default, and
 * every home and config directory a server could look in for a fallback config (`~/.logseq-mcp/`)
 * moved to `home`, an empty temp dir.
 */
export function sandboxedEnv(configPath: string, home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.LOGSEQ_MCP_TIPS;
  env.LOGSEQ_MCP_CONFIG = configPath;
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = join(home, '.config');
  // macOS looks the home folder up by user, not $HOME, unless this is set (see scripts/logseq-instance)
  if (process.platform === 'darwin') env.CFFIXED_USER_HOME = home;
  return env;
}

/**
 * Run every case against one server process and report what differs. With no `expected` the
 * results are only collected (record mode); the calls and tools/list are still checked, the list
 * against the snapshot byte for byte when there is no `expectedToolList`.
 */
export async function runParity(options: ParityOptions): Promise<ParityReport> {
  const { server, cases, expected, expectedToolList, snapshotFile, timeoutMs = 30000 } = options;
  const failures: string[] = [];
  const results: Record<string, ToolResult> = {};
  let toolList: ProjectedTool[] | undefined;
  let stderr = '';

  const names = new Set<string>();
  for (const c of cases) {
    if (names.has(c.name)) throw new Error(`duplicate parity case name ${JSON.stringify(c.name)}`);
    names.add(c.name);
  }

  const stub = await startStubLogseq();
  const dir = await mkdtemp(join(tmpdir(), 'logseq-parity-'));
  const configPath = join(dir, 'config.json');
  const home = join(dir, 'home');
  await mkdir(home);
  await writeFile(configPath, JSON.stringify({ apiUrl: stub.apiUrl, authToken: stub.authToken }));

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    env: sandboxedEnv(configPath, home),
    stderr: 'pipe'
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const client = new Client({ name: 'logseq-parity-harness', version: '1.0.0' }, { capabilities: {} });

  try {
    stub.load([]);
    await client.connect(transport, { timeout: timeoutMs });

    const tools = (await client.listTools(undefined, { timeout: timeoutMs })).tools;
    // As plain JSON, the way it is recorded
    toolList = JSON.parse(JSON.stringify(toolListForSnapshot(tools))) as ProjectedTool[];
    const snapshot = readSnapshotEntry(await readFile(snapshotFile, 'utf8'), TOOL_LIST_SNAPSHOT_KEY);
    if (expectedToolList) {
      // The reference must be the list the snapshot guards; the server needs only to mean the same
      const recorded = serializeLikeVitest(expectedToolList);
      if (recorded !== snapshot) {
        failures.push(`the recorded tools/list differs from the snapshot; re-record it, ${firstDifference(snapshot, recorded)}`);
      }
      for (const f of compareToolLists(expectedToolList, toolList)) failures.push(`tools/list differs in meaning, ${f}`);
    } else {
      const listed = serializeLikeVitest(toolListForSnapshot(tools));
      if (listed !== snapshot) failures.push(`tools/list differs from the snapshot, ${firstDifference(snapshot, listed)}`);
    }
    for (const f of stub.failures()) failures.push(`startup: stub: ${f}`);
    if (stub.calls().length > 0) failures.push(`startup and tools/list made ${stub.calls().length} LogSeq call(s); expected none`);

    for (const c of cases) {
      stub.load(c.steps.flat());
      const prefix = `[${c.tool}: ${c.name}]`;
      let result: ToolResult;
      try {
        result = toToolResult(await client.callTool({ name: c.tool, arguments: c.arguments }, undefined, { timeout: timeoutMs }));
      } catch (error) {
        failures.push(`${prefix} the call failed: ${(error as Error).message}`);
        continue;
      }
      results[c.name] = result;
      for (const f of stub.failures()) failures.push(`${prefix} stub: ${f}`);
      for (const f of compareCalls(c.steps, stub.calls())) failures.push(`${prefix} LogSeq calls, ${f}`);
      if (expected) {
        const want = expected[c.name];
        if (!want) failures.push(`${prefix} no expected result recorded; run with --record`);
        else for (const f of compareResult(want, result)) failures.push(`${prefix} result ${f}`);
      }
    }
    if (expected) {
      for (const name of Object.keys(expected)) {
        if (!names.has(name)) failures.push(`the expected file has a result for ${JSON.stringify(name)}, which is not a case`);
      }
    }
  } catch (error) {
    failures.push(`harness: ${(error as Error).message}`);
  } finally {
    await client.close().catch(() => {});
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  }
  return { failures, results, toolList, stderr };
}

/**
 * A copy of the cases with one answer changed: every string in the response of each case's last
 * call gets a suffix, and an answer with no string at all (`[]`, `null`) becomes a LogSeq error.
 * For the acceptance check that a changed fixture fails loud. A case with no calls is unchanged.
 */
export function perturbCases(cases: readonly ParityCase[]): ParityCase[] {
  return cases.map(c => {
    const copy = structuredClone(c);
    const last = copy.steps.at(-1)?.at(-1);
    if (last) last.response = perturbValue(last.response);
    return copy;
  });
}

function perturbValue(value: unknown): unknown {
  let changed = false;
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
    if (typeof v === 'string') {
      changed = true;
      return `${v} (perturbed)`;
    }
    return v;
  };
  const out = visit(value);
  return changed ? out : { error: 'parity harness: perturbed answer' };
}
