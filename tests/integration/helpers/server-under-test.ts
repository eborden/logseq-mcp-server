import { appendFileSync } from 'fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LogseqClient } from '../../../src/client.js';
import { createServer } from '../../../src/index.js';
import { isRust, requireRustBinary, rustBinaryPath, USAGE_ENV } from './server-kind.js';

export { isRust, requireRustBinary, rustBinaryPath, serverKind } from './server-kind.js';

/**
 * Which server the integration suites exercise (#352): the TypeScript one in this process
 * (the default) or the Rust binary over MCP stdio (`LOGSEQ_MCP_SERVER=rust`). The assertions
 * are the same for both. A suite reaches a tool in one of two ways:
 *
 *  - `connectMcp(client)` for the suites that talk MCP (`tools/call` through an SDK `Client`);
 *  - the functions in `./tools.ts` for the suites that call a tool's function, which in Rust
 *    mode call the tool through MCP and parse the result the way the server's handler wrote it.
 *
 * A suite that tests TypeScript internals (the resolver, the query builder, the client) still
 * runs TypeScript code in both modes; `LOGSEQ_MCP_SERVER_USAGE` names a file that records which
 * tests reached the Rust server, so a run can say how many did.
 *
 * The Rust server never talks to LogSeq directly here. It is configured with the address of a
 * small HTTP forwarder in this process, and the forwarder makes each call through the test's own
 * `LogseqClient.callAPI`. So the fixture check and the token stay with the TypeScript client
 * (`connectFixture`), and a test that counts or wraps `client.callAPI` sees the Rust server's
 * calls exactly as it sees the TypeScript server's.
 */

export interface ConnectOptions {
  /** Next-step tips (#44): on unless `false`, as `createServer` has it */
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

/** Forwards the Rust server's LogSeq calls through `client.callAPI`, which keeps every wrapper on it. */
async function startForwarder(client: LogseqClient): Promise<HttpServer> {
  const http = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      void (async () => {
        let body: unknown;
        try {
          const { method, args } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method: string; args?: unknown[] };
          body = (await client.callAPI(method, args ?? [])) ?? null;
        } catch (error) {
          // The way LogSeq reports a failed call: HTTP 200 with an `error` key. The TypeScript client
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

async function startRust(client: LogseqClient, options: ConnectOptions): Promise<ForwarderSession> {
  requireRustBinary();
  const http = await startForwarder(client);
  const { port } = http.address() as AddressInfo;
  const dir = await mkdtemp(join(tmpdir(), 'logseq-mcp-rust-'));
  const home = join(dir, 'home');
  await mkdir(home, { recursive: true });
  const configPath = join(dir, 'config.json');
  // The token is the forwarder's: the real one stays in the TypeScript client
  await writeFile(configPath, JSON.stringify({ apiUrl: `http://127.0.0.1:${port}`, authToken: 'forwarder' }), { mode: 0o600 });

  // Like the parity harness (scripts/parity/harness.ts): a home of its own, so there is no
  // ~/.logseq-mcp/config.json to fall back on (BR-0001)
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

  const transport = new StdioClientTransport({ command: rustBinaryPath(), args: [], env, stderr: 'ignore' });
  const mcp = new Client({ name: 'logseq-integration-tests', version: '1.0.0' }, { capabilities: {} });
  await mcp.connect(transport);
  return { mcp, closeMcp: mcp.close.bind(mcp), http, dir };
}

async function stopRust(session: ForwarderSession): Promise<void> {
  await session.closeMcp().catch(() => undefined);
  await new Promise<void>(resolve => session.http.close(() => resolve()));
  await rm(session.dir, { recursive: true, force: true });
}

/** Note which test is about to reach the Rust server, for a count of tests that did. */
export function recordUsage(): void {
  const file = process.env[USAGE_ENV]?.trim();
  if (!file) return;
  const { testPath, currentTestName } = expect.getState();
  appendFileSync(file, `${testPath ?? ''}\t${currentTestName ?? ''}\n`);
}

/**
 * An MCP client connected to the server under test, for a suite that sends `tools/call` itself.
 * `close()` also stops the Rust process and its forwarder.
 */
export async function connectMcp(client: LogseqClient, options: ConnectOptions = {}): Promise<Client> {
  if (!isRust()) {
    const server = createServer(client, { tips: options.tips });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'logseq-integration-tests', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    return mcp;
  }
  const session = await startRust(client, options);
  const callTool = session.mcp.callTool.bind(session.mcp) as Client['callTool'];
  session.mcp.callTool = ((...args: Parameters<Client['callTool']>) => {
    recordUsage();
    return callTool(...args);
  }) as Client['callTool'];
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
  recordUsage();
  return (await session).mcp;
}

export async function closeSessions(): Promise<void> {
  const all = [...sessions.values()].flatMap(byKey => [...byKey.values()]);
  sessions.clear();
  await Promise.all(all.map(async pending => stopRust(await pending).catch(() => undefined)));
}
