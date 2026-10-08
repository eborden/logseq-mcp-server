/**
 * Server selection for the measure scripts (#353): the TypeScript server, in process, or the
 * Rust binary over MCP stdio.
 *
 *   --server ts        the default: scripts/measure-api-calls.ts calls each tool function directly
 *   --server ts-mcp    the TypeScript server through an in-memory MCP client (the MCP layer in the timing)
 *   --server rust      the Rust binary through MCP stdio, as Claude Code runs it
 *   --rust-binary <p>  the binary for `--server rust` (default rust/target/release/logseq-mcp-server)
 *
 * The Rust binary talks to LogSeq itself, so its calls are counted by a small forwarding proxy
 * on the loopback interface: the binary gets a temporary config that holds the same token and
 * the proxy's address, and the proxy counts each `POST /api` by its `method` and passes it on.
 * The proxy never logs a body or a header. The temporary config is deleted on close.
 *
 * Nothing here prints a value from the graph or the token (BR-0001).
 */
import { createServer as createHttpServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { rmSync } from 'fs';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { LogseqMCPConfig } from '../src/types.js';

export type ServerKind = 'ts' | 'ts-mcp' | 'rust';

export interface ServerChoice {
  kind: ServerKind;
  /** Absolute path of the Rust binary (only read for `rust`) */
  rustBinary: string;
  /** The arguments left once the server flags are removed */
  rest: string[];
}

const DEFAULT_BINARY = 'rust/target/release/logseq-mcp-server';

/** Parses `--server` and `--rust-binary`; everything else (a page name) is left in `rest`. */
export function parseServerFlags(argv: string[]): ServerChoice {
  let kind: ServerKind = 'ts';
  let binary = DEFAULT_BINARY;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--server') {
      const value = argv[++i];
      if (value !== 'ts' && value !== 'ts-mcp' && value !== 'rust') throw new Error('--server takes ts, ts-mcp or rust');
      kind = value;
    } else if (arg === '--rust-binary') {
      const value = argv[++i];
      if (!value) throw new Error('--rust-binary takes a path');
      binary = value;
    } else {
      rest.push(arg);
    }
  }
  return { kind, rustBinary: isAbsolute(binary) ? binary : resolve(binary), rest };
}

export interface CountingProxy {
  /** Calls forwarded since the last reset, by LogSeq method */
  calls: Map<string, number>;
  url: string;
  reset(): void;
  total(): number;
  close(): Promise<void>;
}

/** Forwards every request to `target` and counts the `method` of each JSON body. */
export async function startCountingProxy(target: string): Promise<CountingProxy> {
  const calls = new Map<string, number>();
  const upstream = target.replace(/\/+$/, '');
  const server: HttpServer = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      try {
        const method = (JSON.parse(body.toString('utf8')) as { method?: unknown }).method;
        if (typeof method === 'string') calls.set(method, (calls.get(method) ?? 0) + 1);
      } catch {
        // not JSON: forwarded as it is, and not counted
      }
      const headers: Record<string, string> = {};
      for (const name of ['authorization', 'content-type']) {
        const value = req.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      fetch(upstream + (req.url ?? '/'), { method: req.method, headers, body: req.method === 'GET' ? undefined : body })
        .then(async answer => {
          const payload = Buffer.from(await answer.arrayBuffer());
          res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
          res.end(payload);
        })
        .catch(() => {
          res.writeHead(502);
          res.end();
        });
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    calls,
    url: `http://127.0.0.1:${port}`,
    reset: () => calls.clear(),
    total: () => [...calls.values()].reduce((a, b) => a + b, 0),
    close: () =>
      new Promise<void>(done => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

export interface RustServer {
  mcp: Client;
  /** Counts LogSeq calls the binary makes, when started with `count: true` */
  proxy: CountingProxy | undefined;
  close(): Promise<void>;
}

/**
 * Starts the Rust binary over MCP stdio with `config` (the same one the TypeScript client uses).
 * With `count`, LogSeq calls go through a counting proxy. The binary gets a home of its own, so
 * it has no config file to fall back on.
 */
export async function startRustServer(binary: string, config: LogseqMCPConfig, count: boolean): Promise<RustServer> {
  const proxy = count ? await startCountingProxy(config.apiUrl ?? 'http://127.0.0.1:12315') : undefined;
  const dir = await mkdtemp(join(tmpdir(), 'logseq-mcp-measure-'));
  const home = join(dir, 'home');
  await mkdir(home, { recursive: true });
  const configPath = join(dir, 'config.json');
  // The temp config holds the token, so it must not outlive the run, whatever ends it: a normal
  // exit, a thrown error that reaches process.exit, or Ctrl-C and SIGTERM (which skip `finally`).
  const removeDir = (): void => rmSync(dir, { recursive: true, force: true });
  const onSignal = (signal: NodeJS.Signals): void => {
    removeDir();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('exit', removeDir);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const unhook = (): void => {
    process.off('exit', removeDir);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
  await writeFile(configPath, JSON.stringify({ ...config, apiUrl: proxy?.url ?? config.apiUrl }), { mode: 0o600 });

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.LOGSEQ_MCP_NOW;
  // The TypeScript paths run with tips on; the config's `tips` or a caller's LOGSEQ_MCP_TIPS must not change that
  env.LOGSEQ_MCP_TIPS = '1';
  env.LOGSEQ_MCP_CONFIG = configPath;
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = join(home, '.config');
  if (process.platform === 'darwin') env.CFFIXED_USER_HOME = home;

  const mcp = new Client({ name: 'measure', version: '1.0.0' }, { capabilities: {} });
  try {
    await mcp.connect(new StdioClientTransport({ command: binary, args: [], env, stderr: 'ignore' }));
  } catch (error) {
    await proxy?.close();
    removeDir();
    unhook();
    throw error;
  }
  return {
    mcp,
    proxy,
    close: async () => {
      await mcp.close();
      await proxy?.close();
      removeDir();
      unhook();
    },
  };
}
