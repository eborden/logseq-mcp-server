// Start-up, memory and size of the Rust server (#126, #122; the Node comparison was dropped with the TypeScript
// server, #356).
//
//   cd rust && cargo build --release --locked      # once; the script does not build the binary
//   npx tsx scripts/measure-footprint.ts [--runs 7] [--rust-binary <path>] [--settle-ms 500]
//
// It prints aggregates only (median, then min and max over the runs):
//   - cold start: process spawn to the first `initialize` response
//   - resident memory: idle after the handshake, and after one logseq_get_page_outline call
//   - size: the release binary
//
// The server talks to a stub LogSeq (scripts/lib/stub-logseq.ts) on a random local port with a fresh token, through
// a temp LOGSEQ_MCP_CONFIG and an empty temp home, answering a parity case's made-up Project Atlas page. It never
// contacts port 12315 and never reads ~/.logseq-mcp/config.json (BR-0001). Memory is read with `ps`, so macOS or
// Linux only.
//
// The first run is a warm-up and is reported apart, so first-launch costs (on macOS, the OS's check of a binary it
// has not seen; page-cache effects) stay out of the medians.
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadParityCase, REPO_ROOT } from './lib/parity-cases.js';
import { sandboxedEnv } from './lib/sandboxed-env.js';
import { startStubLogseq, type StubLogseq } from './lib/stub-logseq.js';
import { probeServer, type ProbeResult, type ServerProcess } from './measure-footprint/probe.js';
import { formatMb, formatMs, formatSummary, summarize } from './measure-footprint/stats.js';

const USAGE = 'usage: npx tsx scripts/measure-footprint.ts [--runs <n>] [--rust-binary <path>] [--settle-ms <ms>]';

interface Options {
  runs: number;
  rustBinary: string;
  settleMs: number;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    runs: 7,
    rustBinary: join(REPO_ROOT, 'rust', 'target', 'release', process.platform === 'win32' ? 'logseq-mcp-server.exe' : 'logseq-mcp-server'),
    settleMs: 500
  };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${argv[i]} needs a value\n${USAGE}`);
    if (argv[i] === '--runs') options.runs = Number(value);
    else if (argv[i] === '--rust-binary') options.rustBinary = resolve(value);
    else if (argv[i] === '--settle-ms') options.settleMs = Number(value);
    else throw new Error(`unknown argument ${argv[i]}\n${USAGE}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error(`--runs must be a whole number of at least 1\n${USAGE}`);
  if (!Number.isFinite(options.settleMs) || options.settleMs < 0) throw new Error(`--settle-ms must be a number of at least 0\n${USAGE}`);
  return options;
}

interface Series {
  first: ProbeResult;
  runs: ProbeResult[];
}

function report(label: string, series: Series): void {
  const pick = (f: (r: ProbeResult) => number) => summarize(series.runs.map(f));
  console.log(`${label} (${series.runs.length} runs after the warm-up)`);
  console.log(`  cold start       ${formatSummary(pick(r => r.coldStartMs), formatMs)}   warm-up run: ${formatMs(series.first.coldStartMs)}`);
  console.log(`  memory, idle     ${formatSummary(pick(r => r.idleRssBytes), formatMb)}`);
  console.log(`  memory, 1 call   ${formatSummary(pick(r => r.afterCallRssBytes), formatMb)}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (process.platform === 'win32') throw new Error('this script reads memory with ps; run it on macOS or Linux');
  await stat(options.rustBinary).catch(() => {
    throw new Error(`no Rust binary at ${options.rustBinary}; build it with: cd rust && cargo build --release --locked`);
  });

  const work = await mkdtemp(join(tmpdir(), 'logseq-footprint-'));
  let stub: StubLogseq | undefined;
  try {
    const live = await startStubLogseq();
    stub = live;

    const configPath = join(work, 'config.json');
    const home = join(work, 'home');
    await mkdir(home);
    await writeFile(configPath, JSON.stringify({ apiUrl: live.apiUrl, authToken: live.authToken }));
    const env = sandboxedEnv(configPath, home);

    const server: ServerProcess = { command: options.rustBinary, args: [], env, cwd: work };
    const outline = loadParityCase('exact name, blocks out of order with children');
    // `stub.load` clears the stub's failure log, so look at it before every load and after every
    // probe: a call the stub could not answer in any run, at start-up or during the tool call, fails the script.
    const checkStub = (what: string) => {
      const failures = live.failures();
      if (failures.length > 0) throw new Error(`the stub LogSeq saw ${failures.length} call(s) it had no answer for ${what}`);
    };
    const measure = async () => {
      const result = await probeServer({
        server,
        call: { name: outline.tool, arguments: outline.arguments },
        beforeCall: () => {
          checkStub('during start-up');
          live.load(outline.steps.flat());
        },
        settleMs: options.settleMs
      });
      checkStub('during the tool call');
      return result;
    };

    const results: ProbeResult[] = [];
    for (let run = 0; run <= options.runs; run++) results.push(await measure());

    console.log(`\nnode ${process.version} (harness), ${process.platform}-${process.arch}, ${options.runs} runs, ${options.settleMs} ms settle before each memory reading\n`);
    report('Rust server', { first: results[0], runs: results.slice(1) });

    console.log('\nsize on disk (apparent bytes)');
    console.log(`  Rust:  binary ${formatMb((await stat(options.rustBinary)).size)}`);
  } finally {
    await stub?.close();
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
