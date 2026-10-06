/**
 * Start, stop or check this worktree's own LogSeq instance (#118).
 *
 * Usage:
 *   npx tsx scripts/logseq-instance.ts start [graph-dir]   # default: tests/fixtures/graph
 *   npx tsx scripts/logseq-instance.ts status
 *   npx tsx scripts/logseq-instance.ts stop
 *
 * `start` launches a second LogSeq app on a fresh profile in `.logseq-instance/` (gitignored),
 * on a port derived from this worktree's path (12320-12399) with a fixed test token, opens the
 * fixture graph and waits until `requireFixtureGraph` passes and every page is indexed. Then
 * point the tests at it:
 *
 *   LOGSEQ_MCP_CONFIG=$PWD/.logseq-instance/config.json npm run test:integration
 *
 * It never touches the LogSeq profile or app you use day to day, nor ~/.logseq-mcp/config.json.
 * macOS only. See "Per-worktree instance" in tests/integration/setup.md, and
 * scripts/logseq-instance/instance.ts for how it works.
 */
import { spawn, execFileSync } from 'child_process';
import { createServer } from 'net';
import { mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { LogseqClient } from '../src/client.js';
import { FIXTURE_SENTINEL_PAGE, requireFixtureGraph } from '../tests/integration/helpers/fixture-graph.js';
import {
  InstanceDeps,
  InstanceError,
  InstanceProbe,
  instanceStatus,
  startInstance,
  stopInstance,
} from './logseq-instance/instance.js';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, 'logseq-instance', 'configs.edn.template');

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

/** A row of `[:find ?path ...]`, parsed rather than assumed. */
function paths(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(row => (Array.isArray(row) && typeof row[0] === 'string' ? [row[0]] : []));
}

function probe(client: LogseqClient): InstanceProbe {
  return {
    async currentGraphPath() {
      const graph: unknown = await client.callAPI('logseq.App.getCurrentGraph');
      const path = graph && typeof graph === 'object' ? (graph as { path?: unknown }).path : undefined;
      return typeof path === 'string' ? path : undefined;
    },
    requireFixture: () => requireFixtureGraph(client),
    async indexedFiles() {
      return paths(await client.executeDatalogQuery('[:find ?path :where [?f :file/path ?path]]'));
    },
  };
}

const deps: InstanceDeps = {
  platform: process.platform,
  env: process.env,
  async readFile(path) {
    try {
      return await readFile(path, 'utf-8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  },
  writeFile: (path, data) => writeFile(path, data),
  mkdir: async path => {
    await mkdir(path, { recursive: true });
  },
  remove: path => rm(path, { recursive: true, force: true }),
  async exists(path) {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  async realDir(path) {
    try {
      const real = await realpath(path);
      return (await stat(real)).isDirectory() ? real : undefined;
    } catch {
      return undefined;
    }
  },
  async listDir(path) {
    try {
      return await readdir(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  },
  isPortFree: port =>
    new Promise(resolvePort => {
      const server = createServer();
      server.once('error', () => resolvePort(false));
      server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolvePort(true)));
    }),
  async spawnDetached(spec, logPath) {
    const log = await open(logPath, 'w');
    try {
      const child = spawn(spec.command, spec.args, {
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        env: spec.env as NodeJS.ProcessEnv,
      });
      const pid = await new Promise<number>((resolvePid, reject) => {
        child.once('error', reject);
        child.once('spawn', () => (child.pid ? resolvePid(child.pid) : reject(new Error('no pid'))));
      });
      child.unref();
      return pid;
    } finally {
      await log.close();
    }
  },
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: the pid exists but belongs to someone else. The command-line check then refuses it.
      return errorCode(error) === 'EPERM';
    }
  },
  commandLine(pid) {
    try {
      return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' }).trim() || undefined;
    } catch {
      return undefined; // ps exits 1 when there is no such process
    }
  },
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  connect: config => probe(new LogseqClient(config)),
  sleep: ms => new Promise(done => setTimeout(done, ms)),
  now: () => new Date(),
  log: line => console.log(line),
};

async function worktreeRoot(): Promise<string> {
  return realpath(resolve(here, '..'));
}

async function main(argv: string[]): Promise<number> {
  const [command, graphArg, ...rest] = argv;
  const worktree = await worktreeRoot();

  if (command === 'start' && rest.length === 0) {
    const graphDir = resolve(graphArg ?? join(worktree, 'tests', 'fixtures', 'graph'));
    const started = await startInstance(
      {
        worktree,
        graphDir,
        template: await readFile(TEMPLATE, 'utf-8'),
        sentinelFile: join('pages', `${FIXTURE_SENTINEL_PAGE}.md`),
      },
      deps,
    );
    console.log(`Ready: pid ${started.pid}, ${started.apiUrl}, fixture version ${started.fixtureVersion}.`);
    console.log('Run the integration tests against it with:');
    console.log(`  LOGSEQ_MCP_CONFIG=${started.configPath} npm run test:integration`);
    console.log('Stop it with: npx tsx scripts/logseq-instance.ts stop');
    return 0;
  }

  if (command === 'stop' && graphArg === undefined) {
    const result = await stopInstance(worktree, deps);
    if (result.state === 'stopped') console.log(`Stopped LogSeq (pid ${result.pid}).`);
    if (result.state === 'stale') console.log(`pid ${result.pid} had already exited; removed the stale record.`);
    if (result.state === 'none') console.log('No instance recorded for this worktree.');
    return 0;
  }

  if (command === 'status' && graphArg === undefined) {
    const status = await instanceStatus(worktree, deps);
    if (status.state === 'none') {
      console.log('No instance recorded for this worktree.');
      return 1;
    }
    if (status.state === 'stale') {
      console.log(`Not running: pid ${status.record.pid} has exited. Run start, or stop to clear the record.`);
      return 1;
    }
    const { record } = status;
    console.log(`Running: pid ${record.pid}, ${record.apiUrl}, started ${record.startedAt}.`);
    console.log(`API: ${status.api}.`);
    console.log(`Config: LOGSEQ_MCP_CONFIG=${record.configPath}`);
    return 0;
  }

  console.error('Usage: npx tsx scripts/logseq-instance.ts start [graph-dir] | status | stop');
  return 2;
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  error => {
    console.error(error instanceof InstanceError ? `logseq-instance: ${error.message}` : error);
    process.exit(1);
  },
);
