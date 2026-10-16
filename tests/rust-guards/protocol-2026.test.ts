import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxedEnv } from '../../scripts/lib/sandboxed-env.js';
import { startStubLogseq, type StubLogseq } from '../../scripts/lib/stub-logseq.js';
import { requireRustBinary, rustBinaryPath } from '../../scripts/lib/rust-binary.js';

/**
 * #590: the server driven as a client of MCP spec 2026-07-28 (https://modelcontextprotocol.io/specification/2026-07-28/changelog)
 * and, beside it, as a 2025-11-25 client with the handshake. The 2026-07-28 spec is stateless: no `initialize`, the protocol
 * version, client info and capabilities travel in each request's `_meta`, `server/discover` is required (SEP-2575), every
 * result carries `resultType`, and a missing resource is -32602 (SEP-2164) where 2025-11-25 says -32002. The MCP SDK client here
 * can't be pinned to 2026-07-28, so these tests send raw JSON-RPC lines to the debug binary (stdio) against the stub LogSeq
 * (no graph data, BR-0001). `ttlMs` and `cacheScope` are not checked here.
 */

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'logseq-protocol-guard', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

interface Response {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** The binary on stdio, spoken to in raw JSON-RPC lines. */
class RawServer {
  private readonly pending = new Map<number, (response: Response) => void>();
  private nextId = 1;
  readonly stdout: string[] = [];
  private constructor(private readonly child: ChildProcessByStdio<Writable, Readable, null>) {
    createInterface({ input: child.stdout }).on('line', line => {
      this.stdout.push(line);
      let message: Response;
      try {
        message = JSON.parse(line) as Response;
      } catch {
        return; // reported by the stdout check, which parses every line
      }
      this.pending.get(message.id)?.(message);
    });
  }

  static start(configPath: string, home: string): RawServer {
    const child = spawn(rustBinaryPath(), [], { env: sandboxedEnv(configPath, home), stdio: ['pipe', 'pipe', 'ignore'] });
    return new RawServer(child);
  }

  request(method: string, params: Record<string, unknown>): Promise<Response> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 15000);
      this.pending.set(id, response => {
        clearTimeout(timer);
        resolve(response);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  /** A 2026-07-28 request: the version, client info and capabilities in `_meta`. */
  stateless(method: string, params: Record<string, unknown> = {}): Promise<Response> {
    return this.request(method, { ...params, _meta: META });
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

let stub: StubLogseq;
let dir: string;
let configPath: string;
let home: string;
const servers: RawServer[] = [];

beforeAll(async () => {
  requireRustBinary();
  stub = await startStubLogseq();
  dir = await mkdtemp(join(tmpdir(), 'logseq-protocol-guard-'));
  home = join(dir, 'home');
  await mkdir(home);
  configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ apiUrl: stub.apiUrl, authToken: stub.authToken }));
});

afterAll(async () => {
  servers.forEach(server => server.close());
  await stub.close();
  await rm(dir, { recursive: true, force: true });
});

const start = (): RawServer => {
  const server = RawServer.start(configPath, home);
  servers.push(server);
  return server;
};

/** The answers a read of a page that does not exist takes (the same steps as the page-resource parity case). */
function loadMissingPage(): void {
  stub.load([
    { method: 'logseq.Editor.getPage', args: ['Project Atlas'], response: null },
    {
      method: 'logseq.DB.datascriptQuery',
      args: [
        '[:find (pull ?page [*]) ?via :in $ ?n :where (or-join [?n ?page ?via] (and [?page :block/name ?n] [(ground "name") ?via]) (and [?stub :block/name ?n] [?page :block/alias ?stub] [(ground "alias") ?via]))]',
        '"project atlas"',
      ],
      response: [],
    },
    {
      method: 'logseq.DB.datascriptQuery',
      args: [
        '[:find (pull ?page [*]) :in $ ?suffix :where [?page :block/name ?n] [?page :block/namespace] [(clojure.string/ends-with? ?n ?suffix)]]',
        '"/project atlas"',
      ],
      response: [],
    },
    { method: 'logseq.Editor.getAllPages', args: [], response: [{ originalName: 'Alice' }] },
  ]);
}

describe('as a 2026-07-28 client (no handshake, #590)', () => {
  let server: RawServer;
  beforeAll(() => {
    server = start();
  });

  it('SEP-2575: server/discover answers the supported versions, capabilities and server info', async () => {
    const { result, error } = await server.stateless('server/discover');
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ resultType: 'complete' });
    expect(result?.supportedVersions).toEqual(expect.arrayContaining(['2025-11-25', '2026-07-28']));
    expect(result?.capabilities).toMatchObject({ tools: {}, prompts: {}, resources: {} });
    // the server info the handshake gave a client travels in `_meta` of the discover result
    const info = (result?._meta as Record<string, { name?: string; version?: unknown }> | undefined)?.['io.modelcontextprotocol/serverInfo'];
    expect(info?.name).toBe('logseq-mcp-server');
    expect(typeof info?.version).toBe('string');
  });

  it('tools/list: the result carries resultType "complete" and lists the tools', async () => {
    const { result, error } = await server.stateless('tools/list');
    expect(error).toBeUndefined();
    expect(result?.resultType).toBe('complete');
    expect((result?.tools as unknown[]).length).toBeGreaterThan(0);
  });

  it('tools/call: the result carries resultType "complete" and the stub LogSeq answer', async () => {
    stub.load([{ method: 'logseq.App.getCurrentGraph', args: [], response: { url: 'logseq_local_/tmp/example-graph', name: 'example-graph', path: '/tmp/example-graph' } }]);
    const { result, error } = await server.stateless('tools/call', { name: 'logseq_get_graph', arguments: {} });
    expect(error).toBeUndefined();
    expect(result?.resultType).toBe('complete');
    expect(result?.isError).not.toBe(true);
    expect(JSON.stringify(result?.content)).toContain('example-graph');
    expect(stub.calls().map(call => call.method)).toEqual(['logseq.App.getCurrentGraph']);
    expect(stub.failures()).toEqual([]);
  });

  it('prompts/get: the result carries resultType "complete" and a message', async () => {
    const { result, error } = await server.stateless('prompts/get', { name: 'weekly_summary', arguments: {} });
    expect(error).toBeUndefined();
    expect(result?.resultType).toBe('complete');
    expect((result?.messages as unknown[]).length).toBeGreaterThan(0);
  });

  it('SEP-2164: resources/read of a missing page is -32602, not -32002', async () => {
    loadMissingPage();
    const { result, error } = await server.stateless('resources/read', { uri: 'logseq://page/Project%20Atlas' });
    expect(result).toBeUndefined();
    expect(error?.code).toBe(-32602);
    expect(stub.failures()).toEqual([]);
  });

  it('writes nothing but JSON-RPC frames to stdout (ADR-0004)', () => {
    expect(server.stdout.length).toBeGreaterThan(0);
    for (const line of server.stdout) expect(() => JSON.parse(line)).not.toThrow();
  });
});

describe('as a 2025-11-25 client (with the handshake, #590)', () => {
  let server: RawServer;
  beforeAll(() => {
    server = start();
  });

  it('initialize negotiates 2025-11-25 and names the server', async () => {
    const { result, error } = await server.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'logseq-protocol-guard', version: '1.0.0' },
    });
    expect(error).toBeUndefined();
    expect(result?.protocolVersion).toBe('2025-11-25');
    expect(result?.serverInfo).toMatchObject({ name: 'logseq-mcp-server' });
    server.notify('notifications/initialized');
  });

  it('tools/list lists the tools', async () => {
    const { result, error } = await server.request('tools/list', {});
    expect(error).toBeUndefined();
    expect((result?.tools as unknown[]).length).toBeGreaterThan(0);
  });

  it('resources/read of a missing page is still -32002 (the code before SEP-2164)', async () => {
    loadMissingPage();
    const { result, error } = await server.request('resources/read', { uri: 'logseq://page/Project%20Atlas' });
    expect(result).toBeUndefined();
    expect(error?.code).toBe(-32002);
    expect(stub.failures()).toEqual([]);
  });
});
