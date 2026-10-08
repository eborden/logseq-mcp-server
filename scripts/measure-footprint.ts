// Start-up, memory and install size of the Rust server against the Node one (#126, #122).
//
//   cd rust && cargo build --release --locked      # once; the script does not build the binary
//   npx tsx scripts/measure-footprint.ts [--runs 7] [--rust-binary <path>] [--settle-ms 500]
//
// For each server it prints aggregates only (median, then min and max over the runs):
//   - cold start: process spawn to the first `initialize` response
//   - resident memory: idle after the handshake, and after one logseq_get_page_outline call
//   - size: the Rust release binary, against Node's own binary plus the built `dist/` and its
//     production `node_modules` (staged in a temp dir with `npm ci --omit=dev`, nothing in the
//     repo is touched)
//
// Both servers talk to the parity harness's stub LogSeq (scripts/parity/stub-logseq.ts) on a
// random local port with a fresh token, through a temp LOGSEQ_MCP_CONFIG and an empty temp home,
// answering the harness's made-up Project Atlas page. It never contacts port 12315 and never
// reads ~/.logseq-mcp/config.json (BR-0001). Memory is read with `ps`, so macOS or Linux only.
//
// The first run of each server is a warm-up and is reported apart: it pays for cold file caches
// and, on macOS, the first-launch check of a binary the OS has not seen. The runs alternate between
// the servers so a drift in machine load hits both.
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { getPageOutlineCases } from './parity/cases/get-page-outline.js';
import { sandboxedEnv } from './parity/harness.js';
import { REPO_ROOT } from './parity/ts-server.js';
import { startStubLogseq, type StubLogseq } from './parity/stub-logseq.js';
import { probeServer, type ProbeResult, type ServerProcess } from './measure-footprint/probe.js';
import { formatMb, formatMs, formatSummary, summarize } from './measure-footprint/stats.js';

const execFileAsync = promisify(execFile);

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

/** Sum of the sizes of every file under a folder (apparent size, symlinks not followed). */
async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await treeBytes(path);
    else if (entry.isFile()) total += (await lstat(path)).size;
  }
  return total;
}

/**
 * The Node server as a package would install it: the repo's `package.json` and lockfile, the
 * production dependencies only, and `dist/` built by the repo's own tsc.
 */
async function stageNodeServer(dir: string): Promise<{ dist: number; modules: number }> {
  await cp(join(REPO_ROOT, 'package.json'), join(dir, 'package.json'));
  await cp(join(REPO_ROOT, 'package-lock.json'), join(dir, 'package-lock.json'));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await execFileAsync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, maxBuffer: 1 << 24 });
  await execFileAsync(process.execPath, [join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(REPO_ROOT, 'tsconfig.json'), '--outDir', join(dir, 'dist')], {
    cwd: REPO_ROOT,
    maxBuffer: 1 << 24
  });
  return { dist: await treeBytes(join(dir, 'dist')), modules: await treeBytes(join(dir, 'node_modules')) };
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
    console.log('staging the Node server (npm ci --omit=dev, tsc) ...');
    const nodeDir = join(work, 'node-server');
    await mkdir(nodeDir);
    const nodeSize = await stageNodeServer(nodeDir);

    const configPath = join(work, 'config.json');
    const home = join(work, 'home');
    await mkdir(home);
    await writeFile(configPath, JSON.stringify({ apiUrl: live.apiUrl, authToken: live.authToken }));
    const env = sandboxedEnv(configPath, home);

    const servers: Record<'rust' | 'node', ServerProcess> = {
      rust: { command: options.rustBinary, args: [], env, cwd: work },
      node: { command: process.execPath, args: [join(nodeDir, 'dist', 'index.js')], env, cwd: work }
    };
    const outline = getPageOutlineCases[0];
    // `stub.load` clears the stub's failure log, so look at it before every load and after every
    // probe: a call the stub could not answer in any run, at start-up or during the tool call, fails the script.
    const checkStub = (what: string) => {
      const failures = live.failures();
      if (failures.length > 0) throw new Error(`the stub LogSeq saw ${failures.length} call(s) it had no answer for ${what}`);
    };
    const measure = async (server: ServerProcess) => {
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

    const results: Record<'rust' | 'node', ProbeResult[]> = { rust: [], node: [] };
    for (let run = 0; run <= options.runs; run++) {
      for (const which of ['rust', 'node'] as const) results[which].push(await measure(servers[which]));
    }

    console.log(`\nnode ${process.version}, ${process.platform}-${process.arch}, ${options.runs} runs per server, ${options.settleMs} ms settle before each memory reading\n`);
    report('Rust release binary', { first: results.rust[0], runs: results.rust.slice(1) });
    console.log('');
    report('Node server (node dist/index.js)', { first: results.node[0], runs: results.node.slice(1) });

    const rustBinary = (await stat(options.rustBinary)).size;
    const nodeBinary = (await stat(process.execPath)).size;
    console.log('\nsize on disk (apparent bytes)');
    console.log(`  Rust:  binary ${formatMb(rustBinary)}`);
    console.log(
      `  Node:  node ${formatMb(nodeBinary)} + dist ${formatMb(nodeSize.dist)} + production node_modules ${formatMb(nodeSize.modules)} = ${formatMb(nodeBinary + nodeSize.dist + nodeSize.modules)}`
    );
  } finally {
    await stub?.close();
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
