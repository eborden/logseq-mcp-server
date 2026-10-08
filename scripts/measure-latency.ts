// Per-tool latency and LogSeq call counts of the Rust server (#353; the comparison with the Node server was
// dropped with the TypeScript server, #356).
//
//   cd rust && cargo build --release --locked       # the Rust server; the script does not build it
//   npx tsx scripts/measure-latency.ts [--iterations 30] [--warmup 3] [--rust-binary <path>]
//
// The server runs over MCP stdio against the parity harness's stub LogSeq (scripts/parity/stub-logseq.ts)
// on a random local port with a fresh token, through a temp LOGSEQ_MCP_CONFIG and an empty temp home. It
// never contacts port 12315 and never reads ~/.logseq-mcp/config.json (BR-0001). Every page, block and
// name is made up, and the output is aggregates only.
//
// For each of the 16 tools it calls one representative parity case (the happy path), then a few larger
// made-up cases for the tools that do the most work. Per case and server: `--warmup` untimed calls, then
// `--iterations` timed ones.
//
// What the numbers are: the stub answers instantly from memory, so a latency is the server's own work
// (parse the request, build queries, parse and shape LogSeq's answers, serialize) plus the stdio and
// loopback HTTP hops. It is not the latency of a real LogSeq, whose queries take milliseconds to seconds.
// The clock stops when the response line has arrived, before the client parses it.
//
// Each timed call is followed, outside the timing, by a read of the stub's call log: the LogSeq calls the
// server actually made. The first result of every parity case is checked against the recorded one, and
// every call of every case against the case's steps, so a number is never for a call that failed.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CASE_GROUPS, expectedFileOf } from './parity/case-groups.js';
import { compareCalls, compareResult, sandboxedEnv, toToolResult, type ParityCase, type ToolResult } from './parity/harness.js';
import { pulledPage, uuid, ATLAS } from './parity/ref-fixtures.js';
import { REPO_ROOT } from './parity/server-command.js';
import { LOGSEQ_PORT, startStubLogseq, type CannedCall, type StubLogseq } from './parity/stub-logseq.js';
import { formatMs2, summarizeLatency } from './measure-latency/stats.js';

const USAGE = 'usage: npx tsx scripts/measure-latency.ts [--iterations <n>] [--warmup <n>] [--rust-binary <path>]';

interface Options {
  iterations: number;
  warmup: number;
  rustBinary: string;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    iterations: 30,
    warmup: 3,
    rustBinary: join(REPO_ROOT, 'rust', 'target', 'release', process.platform === 'win32' ? 'logseq-mcp-server.exe' : 'logseq-mcp-server')
  };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${argv[i]} needs a value\n${USAGE}`);
    if (argv[i] === '--iterations') options.iterations = Number(value);
    else if (argv[i] === '--warmup') options.warmup = Number(value);
    else if (argv[i] === '--rust-binary') options.rustBinary = resolve(value);
    else throw new Error(`unknown argument ${argv[i]}\n${USAGE}`);
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1) throw new Error(`--iterations must be a whole number of at least 1\n${USAGE}`);
  if (!Number.isInteger(options.warmup) || options.warmup < 0) throw new Error(`--warmup must be a whole number of at least 0\n${USAGE}`);
  return options;
}

// ---- the cases

/** The parity case with this name, and the recorded result for it. */
async function parityCase(name: string): Promise<{ case: ParityCase; expected: ToolResult }> {
  for (const group of CASE_GROUPS) {
    const found = group.cases.find(c => c.name === name);
    if (!found) continue;
    const expected = JSON.parse(await readFile(expectedFileOf(group), 'utf8')) as Record<string, ToolResult>;
    if (!expected[name]) throw new Error(`no recorded result for parity case ${JSON.stringify(name)}`);
    return { case: found, expected: expected[name] };
  }
  throw new Error(`no parity case named ${JSON.stringify(name)}; scripts/measure-latency.ts picks cases by name`);
}

/** One happy-path parity case per tool: the name of the case, which is also its label in the report. */
const REPRESENTATIVE: Array<{ tool: string; name: string }> = [
  { tool: 'logseq_build_context', name: 'build_context: exact name, blocks in page order, linking pages and blocks as sent' },
  { tool: 'logseq_check_links', name: 'links refs: names, an alias and a padded term in one query' },
  { tool: 'logseq_get_backlinks', name: 'backlinks: exact name, ranked, entities as sent' },
  { tool: 'logseq_get_block', name: 'get_block: block with children' },
  { tool: 'logseq_get_concept_evolution', name: 'evolution: exact name, the page and its mentions, undated last' },
  { tool: 'logseq_get_concept_network', name: 'network: exact name, two levels, both directions, journals as leaves' },
  { tool: 'logseq_get_context_for_query', name: 'context_for_query: a link and a tag' },
  { tool: 'logseq_get_current_context', name: 'current context: a page is open and nothing else' },
  { tool: 'logseq_get_graph_info', name: 'graph info' },
  { tool: 'logseq_get_page', name: 'get_page: exact name with its blocks' },
  { tool: 'logseq_get_page_outline', name: 'exact name, blocks out of order with children' },
  { tool: 'logseq_list_pages', name: 'every page, aliases nested' },
  { tool: 'logseq_query_by_date_range', name: 'date range: slim by default: days oldest first, trees by the left chain, the top concepts of the period' },
  { tool: 'logseq_query_by_property', name: 'property: slim matches, sorted by page then block' },
  { tool: 'logseq_search_blocks', name: 'slim hits, newest first' },
  { tool: 'logseq_search_by_relationship', name: 'relationship: references, exact names' }
];

/** A case to measure: what to call, what the stub answers, and how to tell the answer is right. */
interface Measured {
  label: string;
  tool: string;
  arguments: Record<string, unknown>;
  steps: CannedCall[][];
  /** The recorded result, for a parity case; a larger case has none, and its calls are checked */
  expected?: ToolResult;
}

const withResponse = (call: CannedCall, response: unknown): CannedCall => ({ ...call, response });

/** A journal page as the range query's `pull [*]` answers it. */
function journalRow(n: number) {
  const day = `Jan ${n}, 2025`;
  return [{ ...pulledPage({ id: 300 + n, name: day.toLowerCase(), originalName: day, file: true, journalDay: 20250100 + n }), 'created-at': 1735689600000 + n }];
}

/** A block as the blocks query pulls it, in LogSeq's kebab-case keys. */
const blockRow = (id: number, page: number, parent: number, left: number, content: string, refs: unknown[]) => [
  { id, uuid: uuid(id), content, page: { id: page }, parent: { id: parent }, left: { id: left }, format: 'markdown', 'pre-block?': false, 'path-refs': [{ id: page }], properties: {}, refs }
];

/** About 350 blocks over 7 journal days: 50 a day, every fifth nested under the one before it, each naming two of 12 pages. */
async function largeDateRange(): Promise<Measured> {
  const base = (await parityCase('date range: slim by default: days oldest first, trees by the left chain, the top concepts of the period')).case;
  const pages = [1, 2, 3, 4, 5, 6, 7].map(journalRow);
  const concepts = Array.from({ length: 12 }, (_, i) => ({ id: 500 + i, name: `concept ${i + 1}`, originalName: `Concept ${i + 1}` }));
  const asRef = (c: (typeof concepts)[number]) => ({ id: c.id, name: c.name, 'original-name': c.originalName, 'journal?': false });
  const blocks: unknown[] = [];
  let id = 10000;
  for (let day = 1; day <= 7; day++) {
    const page = 300 + day;
    let left = page;
    let previousTop = page;
    for (let k = 0; k < 50; k++, id++) {
      const nested = k % 5 !== 0;
      const a = concepts[(day + k) % 12];
      const b = concepts[(day * 3 + k * 7) % 12];
      const content = `Made-up note ${k} on day ${day} about [[${a.originalName}]] and [[${b.originalName}]] with some more words to make a line`;
      blocks.push(blockRow(id, page, nested ? previousTop : page, nested ? previousTop : left, content, [asRef(a), asRef(b)]));
      if (!nested) {
        left = id;
        previousTop = id;
      }
    }
  }
  const BOUNDS = [JSON.stringify(20250101), JSON.stringify(20250107)];
  const [pagesCall, blocksCall] = [base.steps[0][0], base.steps[1][0]];
  return {
    label: 'query_by_date_range, 7 days, 350 blocks',
    tool: base.tool,
    arguments: { start_date: 20250101, end_date: 20250107 },
    // The range's bounds are inputs of both queries, and are checked: the base case's are for its 3 days
    steps: [[{ ...withResponse(pagesCall, pages), args: [pagesCall.args[0], ...BOUNDS] }], [{ ...withResponse(blocksCall, blocks), args: [blocksCall.args[0], ...BOUNDS] }]]
  };
}

const connectedQuery = (ids: number[]) =>
  '[:find ?source ?connected ?name ?original-name ?journal ?rel-type (count ?block) :where ' +
  `[(ground [${ids.join(' ')}]) [?source ...]] [?source :block/name] ` +
  '(or-join [?source ?connected ?block ?rel-type] ' +
  ';; Outbound: blocks on the source page that reference other pages ' +
  '(and [?block :block/page ?source] [?block :block/refs ?connected] [(ground "outbound") ?rel-type]) ' +
  ';; Inbound: blocks on other pages that reference the source ' +
  '(and [?block :block/refs ?source] [?block :block/page ?connected] [(ground "inbound") ?rel-type])) ' +
  '[?connected :block/name ?name] [(not= ?source ?connected)] ' +
  '[(get-else $ ?connected :block/original-name "") ?original-name] ' +
  '[(get-else $ ?connected :block/journal? false) ?journal]]';

/** Depth 2 over 30 neighbours and about 150 pages beyond them (a few hundred rows), with the caps raised so nothing is cut. */
async function largeNetwork(): Promise<Measured> {
  const base = (await parityCase('network: exact name, two levels, both directions, journals as leaves')).case;
  const [resolveStep, depthOne] = [base.steps[0], base.steps[1]];
  const pad = (n: number) => String(n).padStart(3, '0');
  const neighbours = Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, name: `neighbour ${pad(i + 1)}`, originalName: `Neighbour ${pad(i + 1)}` }));
  const outer = Array.from({ length: 150 }, (_, i) => ({ id: 200 + i, name: `outer ${pad(i + 1)}`, originalName: `Outer ${pad(i + 1)}` }));
  const row = (source: number, page: { id: number; name: string; originalName: string }, rel: string, count: number) => [source, page.id, page.name, page.originalName, false, rel, count];
  // Every neighbour is linked the same way and as often, so the order the server expands them in is by name (and id), which this list matches
  const rootRows = neighbours.map(n => row(ATLAS.id, n, 'outbound', 2));
  const secondRows = neighbours.flatMap((n, i) =>
    Array.from({ length: 10 }, (_, k) => row(n.id, outer[(i * 5 + k * 3) % 150], k % 2 === 0 ? 'outbound' : 'inbound', 1 + (k % 3)))
  );
  return {
    label: 'get_concept_network depth 2, 30 + 150 pages, ~300 rows',
    tool: base.tool,
    arguments: { ...base.arguments, max_depth: 2, max_nodes: 500, max_fanout: 100 },
    steps: [resolveStep, [withResponse(depthOne[0], rootRows)], [{ method: depthOne[0].method, args: [connectedQuery(neighbours.map(n => n.id))], response: secondRows }]]
  };
}

async function buildCases(): Promise<Measured[]> {
  const measured: Measured[] = [];
  for (const { tool, name } of REPRESENTATIVE) {
    const { case: found, expected } = await parityCase(name);
    if (found.tool !== tool) throw new Error(`parity case ${JSON.stringify(name)} calls ${found.tool}, not ${tool}`);
    measured.push({ label: tool.replace(/^logseq_/, ''), tool, arguments: found.arguments, steps: found.steps, expected });
  }
  measured.push(await largeDateRange(), await largeNetwork());
  return measured;
}

// ---- a server over stdio, called one request at a time

interface Server {
  name: 'rust';
  child: ChildProcess;
  stderr: string;
  /** Send a request and resolve with the time to the response line (ms) and the parsed response. */
  call(method: string, params: Record<string, unknown>): Promise<{ ms: number; response: Record<string, unknown> }>;
  notify(method: string): void;
  stop(): Promise<void>;
}

function startServer(name: 'rust', command: string, args: string[], env: Record<string, string>, cwd: string): Server {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const server: Server = { name, child, stderr: '', call: undefined as never, notify: undefined as never, stop: undefined as never };
  const waiting = new Map<number, (line: string, at: number) => void>();
  const failers = new Set<(error: Error) => void>();
  let buffer = '';
  let nextId = 1;
  // Set once the server has exited or failed to start: a call made after that rejects at once instead of waiting out its timeout
  let exited: Error | undefined;
  const die = (error: Error) => {
    exited ??= error;
    for (const fail of [...failers]) fail(exited);
  };
  child.once('exit', () => die(new Error(`${name} exited\n${server.stderr.trim()}`)));
  // A failed spawn (a binary that is not executable) or a write to a server that has just died is an event, and unhandled it would kill this process before `finally` cleans up
  child.once('error', error => die(new Error(`${name} failed: ${error.message}\n${server.stderr.trim()}`)));
  child.stdin!.on('error', () => {});
  child.stderr!.on('data', (chunk: Buffer) => {
    server.stderr += chunk.toString('utf8');
  });
  child.stdout!.on('data', (chunk: Buffer) => {
    const at = performance.now();
    buffer += chunk.toString('utf8');
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      // `at` was taken when the chunk arrived, before this parse, so the parse is not in the timing
      const id = (JSON.parse(line) as { id?: unknown }).id;
      const resolveLine = typeof id === 'number' ? waiting.get(id) : undefined;
      if (resolveLine) resolveLine(line, at);
    }
  });
  const write = (message: Record<string, unknown>) => child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  server.call = (method, params) =>
    new Promise((resolveCall, reject) => {
      if (exited) return reject(exited);
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${name}: no response to ${method} in 20 s\n${server.stderr.trim()}`)), 20000);
      const started = performance.now();
      waiting.set(id, (line, at) => {
        clearTimeout(timer);
        waiting.delete(id);
        failers.delete(fail);
        resolveCall({ ms: at - started, response: JSON.parse(line) as Record<string, unknown> });
      });
      const fail = (error: Error) => {
        clearTimeout(timer);
        failers.delete(fail);
        reject(error);
      };
      failers.add(fail);
      write({ id, method, params });
    });
  server.notify = method => write({ method });
  server.stop = async () => {
    if (exited) return;
    child.stdin!.end();
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      await new Promise<void>(done => {
        const timer = setTimeout(done, 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          done();
        });
      });
    }
  };
  return server;
}

// ---- measuring

interface Outcome {
  ms: number[];
  /** Calls the server made to the stub, per timed call */
  calls: number[];
  /** First result, as the client received it */
  first: ToolResult;
  /** Bytes of the first result's text */
  bytes: number;
}

const textOf = (result: ToolResult): string => (result.content ?? []).map(block => String(block.text ?? '')).join('');

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (process.platform === 'win32') throw new Error('this script is for macOS or Linux');
  await stat(options.rustBinary).catch(() => {
    throw new Error(`no Rust binary at ${options.rustBinary}; build it with: cd rust && cargo build --release --locked`);
  });

  const cases = await buildCases();
  const work = await mkdtemp(join(tmpdir(), 'logseq-latency-'));
  let stub: StubLogseq | undefined;
  const servers: Server[] = [];
  try {
    const live = await startStubLogseq();
    stub = live;
    if (new URL(live.apiUrl).port === String(LOGSEQ_PORT)) throw new Error('the stub is on LogSeq\'s own port');
    const configPath = join(work, 'config.json');
    const home = join(work, 'home');
    await mkdir(home);
    await writeFile(configPath, JSON.stringify({ apiUrl: live.apiUrl, authToken: live.authToken }));
    const env = sandboxedEnv(configPath, home);
    servers.push(startServer('rust', options.rustBinary, [], env, work));
    for (const server of servers) {
      const init = await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'logseq-latency-probe', version: '1.0.0' } });
      if (init.response.error || !init.response.result) throw new Error(`${server.name}: initialize failed`);
      server.notify('notifications/initialized');
    }

    const rows: Array<{ measured: Measured; rust: Outcome; expectedCalls: number; problems: string[] }> = [];
    for (const measured of cases) {
      const expectedCalls = measured.steps.flat().length;
      const outcomes = { rust: { ms: [], calls: [] } as unknown as Outcome };
      const problems: string[] = [];
      const callProblems = new Set<string>();
      const once = async (server: Server, timed: boolean): Promise<void> => {
        live.load(measured.steps.flat());
        const { ms, response } = await server.call('tools/call', { name: measured.tool, arguments: measured.arguments });
        // Outside the timing: wait for the calls the server made at once to reach the stub, then read the log
        await live.settle(expectedCalls, { quietMs: 50, maxMs: 1000 });
        const made = live.calls().length;
        // Every call, the large cases included, against the case's steps: the method and inputs of each call, in order
        // (the calls within a step as a set). A server that skips a step or sends other inputs times a different workload.
        for (const mismatch of compareCalls(measured.steps, live.calls())) callProblems.add(`${server.name}: ${mismatch.slice(0, 300)}`);
        const failures = live.failures();
        const result = response.result as ToolResult | undefined;
        if (failures.length > 0) throw new Error(`${server.name}: ${measured.label}: the stub saw ${failures.length} call(s) it had no answer for\n${failures.join('\n')}`);
        if (response.error || !result || result.isError) throw new Error(`${server.name}: ${measured.label} did not return a result: ${JSON.stringify(response.error ?? result?.content ?? response).slice(0, 400)}`);
        const outcome = outcomes[server.name];
        if (outcome.first === undefined) {
          outcome.first = toToolResult(result);
          outcome.bytes = Buffer.byteLength(textOf(outcome.first));
        }
        if (timed) {
          outcome.ms.push(ms);
          outcome.calls.push(made);
        }
      };
      for (let i = 0; i < options.warmup; i++) for (const server of servers) await once(server, false);
      for (let i = 0; i < options.iterations; i++) {
        for (const server of servers) await once(server, true);
      }
      problems.push(...callProblems);
      for (const name of ['rust'] as const) {
        const outcome = outcomes[name];
        if (outcome.calls[0] !== expectedCalls) problems.push(`${name} made ${outcome.calls[0]} LogSeq call(s), the case lists ${expectedCalls}`);
        if (new Set(outcome.calls).size !== 1) problems.push(`${name} made a varying number of calls: ${[...new Set(outcome.calls)].join(', ')}`);
        if (measured.expected) problems.push(...compareResult(measured.expected, outcome.first).slice(0, 2).map(p => `${name} result differs from the recorded one: ${p.slice(0, 120)}`));
      }
      rows.push({ measured, rust: outcomes.rust, expectedCalls, problems });
    }

    report(options, rows);
    const problems = rows.flatMap(row => row.problems.map(p => `${row.measured.label}: ${p}`));
    if (problems.length > 0) {
      console.log(`\nPROBLEMS (${problems.length})`);
      for (const problem of problems) console.log(`- ${problem}`);
      process.exitCode = 1;
    }
  } finally {
    // Each step on its own, so a failing stop can't skip the others or leave the temp dir behind
    for (const server of servers) await server.stop().catch(() => {});
    await stub?.close().catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
}

function report(options: Options, rows: Array<{ measured: Measured; rust: Outcome; expectedCalls: number }>): void {
  console.log(`node ${process.version} (harness), ${process.platform}-${process.arch}, ${options.warmup} warm-up + ${options.iterations} timed calls per case\n`);
  console.log('| case | median ms | p90 ms | result bytes | LogSeq calls | listed |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const { measured, rust, expectedCalls } of rows) {
    const r = summarizeLatency(rust.ms);
    const callsOf = (o: Outcome) => (new Set(o.calls).size === 1 ? String(o.calls[0]) : `${Math.min(...o.calls)}-${Math.max(...o.calls)}`);
    console.log(`| ${measured.label} | ${formatMs2(r.median)} | ${formatMs2(r.p90)} | ${rust.bytes} | ${callsOf(rust)} | ${expectedCalls} |`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
