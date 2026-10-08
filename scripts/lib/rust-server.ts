import { randomBytes } from 'crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { LogseqClient } from './logseq-api.js';
import { requireRustBinary, rustBinaryPath } from './rust-binary.js';

export { requireRustBinary, rustBinaryPath } from './rust-binary.js';

/**
 * How the integration suites and the measure scripts reach the server under test (#352, #356): the Rust binary
 * over MCP stdio, the only server since the TypeScript one was retired. A caller reaches a tool in one of two ways:
 *
 *  - `connectMcp(client)` for the suites that talk MCP (`tools/call` through an SDK `Client`);
 *  - `rustSession(client)`, one shared server per client, behind the functions in
 *    tests/integration/helpers/tools.ts, which call a tool as a function and parse its result.
 *
 * The Rust server never talks to LogSeq directly here. It is configured with the address of a
 * small HTTP forwarder in this process, and the forwarder makes each call through the test's own
 * `LogseqClient.callAPI`. So the fixture check and the token stay with the caller's client
 * (`connectFixture`), and a caller that counts or wraps `client.callAPI` sees the server's calls exactly.
 */

export interface ConnectOptions {
  /** Next-step tips (#44): on unless `false` */
  tips?: boolean;
  /** The instant the tools read as "now" (Rust: `LOGSEQ_MCP_NOW`, honoured by a debug build only) */
  now?: Date;
}

interface ForwarderSession {
  mcp: Client;
  /** The client's own `close`, which `connectMcp` replaces with one that also calls `stopRust` */
  closeMcp: () => Promise<void>;
  http: HttpServer;
  dir: string;
}

/**
 * Forwards the Rust server's LogSeq calls through `client.callAPI`, which keeps every wrapper on it.
 *
 * `client.callAPI` carries the instance's real token, so the forwarder is as sensitive as the
 * instance: LogSeq's API answers CORS `*` and can run commands (#118). It answers 401 unless the
 * request is `POST /api` with the bearer token generated for this run, which the Rust config holds.
 */
async function startForwarder(client: LogseqClient, token: string): Promise<HttpServer> {
  const http = createHttpServer((request, response) => {
    const path = (request.url ?? '').split('?')[0];
    if (request.method !== 'POST' || path !== '/api' || request.headers.authorization !== `Bearer ${token}`) {
      request.resume();
      response.writeHead(401, { 'Content-Length': 0 });
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      void (async () => {
        let body: unknown;
        try {
          const { method, args } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method: string; args?: unknown[] };
          body = (await client.callAPI(method, args ?? [])) ?? null;
        } catch (error) {
          // The way LogSeq reports a failed call: HTTP 200 with an `error` key. The test client
          // put its own prefix on the message, and the Rust client adds it again.
          const message = error instanceof Error ? error.message : String(error);
          body = { error: message.replace(/^LogSeq API error: /, '') };
        }
        const text = JSON.stringify(body);
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        response.end(text);
      })();
    });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  http.unref();
  return http;
}

/** The environment a server process runs in: its own home, so there is no `~/.logseq-mcp/config.json` to fall back on (BR-0001). */
function serverEnv(configPath: string, home: string, options: ConnectOptions): Record<string, string> {
  // Like the parity harness (scripts/parity/harness.ts)
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.LOGSEQ_MCP_TIPS;
  delete env.LOGSEQ_MCP_NOW;
  env.LOGSEQ_MCP_CONFIG = configPath;
  env.LOGSEQ_MCP_TIPS = options.tips === false ? 'off' : 'on';
  if (options.now) env.LOGSEQ_MCP_NOW = String(options.now.getTime());
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = join(home, '.config');
  if (process.platform === 'darwin') env.CFFIXED_USER_HOME = home;
  return env;
}

async function startServerProcess(config: { apiUrl: string; authToken: string }, options: ConnectOptions): Promise<{ mcp: Client; dir: string }> {
  requireRustBinary();
  const dir = await mkdtemp(join(tmpdir(), 'logseq-mcp-rust-'));
  const home = join(dir, 'home');
  await mkdir(home, { recursive: true });
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const transport = new StdioClientTransport({ command: rustBinaryPath(), args: [], env: serverEnv(configPath, home, options), stderr: 'ignore' });
  const mcp = new Client({ name: 'logseq-integration-tests', version: '1.0.0' }, { capabilities: {} });
  await mcp.connect(transport);
  return { mcp, dir };
}

async function startRust(client: LogseqClient, options: ConnectOptions): Promise<ForwarderSession> {
  // Random for this run, so nothing that merely finds the port can use the forwarder
  const token = randomBytes(32).toString('hex');
  const http = await startForwarder(client, token);
  const { port } = http.address() as AddressInfo;
  // The token is the forwarder's: the real one stays in the test's client
  const { mcp, dir } = await startServerProcess({ apiUrl: `http://127.0.0.1:${port}`, authToken: token }, options);
  return { mcp, closeMcp: mcp.close.bind(mcp), http, dir };
}

/**
 * The server, talking to LogSeq itself with the config it is given and no forwarder: for a test of how the server
 * meets LogSeq's own answers, such as a rejected token. `close()` also removes the server's temp directory.
 */
export async function connectMcpToApi(config: { apiUrl: string; authToken: string }, options: ConnectOptions = {}): Promise<Client> {
  const { mcp, dir } = await startServerProcess(config, options);
  const close = mcp.close.bind(mcp);
  mcp.close = async () => {
    await close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  };
  return mcp;
}

async function stopRust(session: ForwarderSession): Promise<void> {
  await session.closeMcp().catch(() => undefined);
  await new Promise<void>(resolve => session.http.close(() => resolve()));
  await rm(session.dir, { recursive: true, force: true });
}

/**
 * An MCP client connected to the server under test, for a suite that sends `tools/call` itself.
 * `close()` also stops the Rust process and its forwarder.
 */
export async function connectMcp(client: LogseqClient, options: ConnectOptions = {}): Promise<Client> {
  const session = await startRust(client, options);
  session.mcp.close = () => stopRust(session);
  return session.mcp;
}

// One Rust server per (client, tips, instant) for the function-level callers in ./tools.ts, started on
// first use and stopped when the file's tests are done (`closeSessions`, registered by ./tools.ts)
const sessions = new Map<LogseqClient, Map<string, Promise<ForwarderSession>>>();

export async function rustSession(client: LogseqClient, options: ConnectOptions = {}): Promise<Client> {
  let byKey = sessions.get(client);
  if (!byKey) sessions.set(client, (byKey = new Map()));
  const key = JSON.stringify([options.tips !== false, options.now?.getTime() ?? null]);
  let session = byKey.get(key);
  if (!session) byKey.set(key, (session = startRust(client, options)));
  return (await session).mcp;
}

export async function closeSessions(): Promise<void> {
  const all = [...sessions.values()].flatMap(byKey => [...byKey.values()]);
  sessions.clear();
  await Promise.all(all.map(async pending => stopRust(await pending).catch(() => undefined)));
}
