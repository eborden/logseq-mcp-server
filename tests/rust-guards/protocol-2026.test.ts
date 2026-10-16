import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { sandboxedEnv } from '../../scripts/lib/sandboxed-env.js';
import { startStubLogseq, type CannedCall, type StubLogseq } from '../../scripts/lib/stub-logseq.js';
import { requireRustBinary, rustBinaryPath } from '../../scripts/lib/rust-binary.js';

/**
 * The binary driven as an MCP 2026-07-28 client (#590): stateless, no `initialize`, the protocol version and client
 * info in every request's `_meta` (SEP-2575). Raw JSON-RPC lines, because the SDK client here can't speak that version.
 * A 2025-11-25 client with the handshake is held to its own wire shape beside it. Everything runs against the stub
 * LogSeq (BR-0001), and the binary writes nothing but MCP frames to stdout (ADR-0004): a non-JSON line fails the read.
 */

interface Reply {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

const META_2026 = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'guard-2026', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** The calls a miss makes (the resolver, then the closest names), as in the `page resource: no such page` parity case. */
const MISSING_PAGE_CALLS: CannedCall[] = [
  { method: 'logseq.Editor.getPage', args: ['Projct Atlas'], response: null },
  {
    method: 'logseq.DB.datascriptQuery',
    args: [
      '[:find (pull ?page [*]) ?via :in $ ?n :where (or-join [?n ?page ?via] (and [?page :block/name ?n] [(ground "name") ?via]) (and [?stub :block/name ?n] [?page :block/alias ?stub] [(ground "alias") ?via]))]',
      '"projct atlas"',
    ],
    response: [],
  },
  {
    method: 'logseq.DB.datascriptQuery',
    args: [
      '[:find (pull ?page [*]) :in $ ?suffix :where [?page :block/name ?n] [?page :block/namespace] [(clojure.string/ends-with? ?n ?suffix)]]',
      '"/projct atlas"',
    ],
    response: [],
  },
  { method: 'logseq.Editor.getAllPages', args: [], response: [{ originalName: 'Project Atlas' }, { originalName: 'Alice' }] },
];

const GRAPH_CALLS: CannedCall[] = [
  { method: 'logseq.App.getCurrentGraph', args: [], response: { name: 'my graph', path: '/graphs/my-graph', url: 'logseq_local_/graphs/my-graph' } },
];

/** At least one line, and each a JSON-RPC object (a bare `42` or `"x"` parses as JSON but is no frame). */
function expectOnlyFrames(lines: string[]): void {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(JSON.parse(line), line).toMatchObject({ jsonrpc: '2.0' });
}

class RawClient {
  private nextId = 1;
  private waiting = new Map<number, (reply: Reply) => void>();
  private lines: string[] = [];

  constructor(private child: ChildProcessByStdio<Writable, Readable, null>) {
    createInterface({ input: child.stdout }).on('line', line => {
      this.lines.push(line);
      let reply: Reply;
      try {
        reply = JSON.parse(line) as Reply;
      } catch {
        return; // reported by `stdoutIsOnlyFrames`
      }
      this.waiting.get(reply.id)?.(reply);
    });
  }

  /** Every line the server wrote to stdout so far */
  stdout(): string[] {
    return [...this.lines];
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  request(method: string, params: Record<string, unknown>): Promise<Reply> {
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${method} in 15s`)), 15000);
      this.waiting.set(id, reply => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** A 2026-07-28 request: the version and client info travel in `_meta`, with no handshake before it. */
  request2026(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
    return this.request(method, { ...params, _meta: META_2026 });
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

describe('the server as a 2026-07-28 and a 2025-11-25 MCP client (#590)', () => {
  let stub: StubLogseq;
  let dir: string;
  let configPath: string;
  let home: string;
  const open: RawClient[] = [];

  function start(): RawClient {
    const child = spawn(rustBinaryPath(), [], { env: sandboxedEnv(configPath, home), stdio: ['pipe', 'pipe', 'ignore'] });
    const client = new RawClient(child);
    open.push(client);
    return client;
  }

  beforeAll(async () => {
    requireRustBinary();
    stub = await startStubLogseq();
    dir = await mkdtemp(join(tmpdir(), 'logseq-protocol-guard-'));
    home = join(dir, 'home');
    await mkdir(home);
    configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ apiUrl: stub.apiUrl, authToken: stub.authToken }));
  }, 30000);

  beforeEach(() => {
    stub.load([...GRAPH_CALLS, ...MISSING_PAGE_CALLS]);
  });

  afterAll(async () => {
    for (const client of open) client.close();
    await stub?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  describe('2026-07-28, stateless, no handshake', () => {
    let client: RawClient;
    beforeAll(() => {
      client = start();
    });

    it('server/discover (SEP-2575) answers the supported versions, capabilities and server info', async () => {
      const reply = await client.request2026('server/discover');
      expect(reply.error).toBeUndefined();
      const result = reply.result!;
      expect(result.supportedVersions).toEqual(expect.arrayContaining(['2025-11-25', '2026-07-28']));
      expect(result.capabilities).toMatchObject({ tools: expect.any(Object), prompts: expect.any(Object), resources: expect.any(Object) });
      // Server info moved into the result's `_meta` in this version (there is no `serverInfo` key on the result)
      expect((result._meta as Record<string, unknown>)['io.modelcontextprotocol/serverInfo']).toMatchObject({
        name: expect.any(String),
        version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      });
      expect(result.resultType).toBe('complete');
    });

    it('tools/list works with no handshake and carries resultType "complete"', async () => {
      const reply = await client.request2026('tools/list');
      expect(reply.error).toBeUndefined();
      expect(reply.result!.resultType).toBe('complete');
      expect((reply.result!.tools as unknown[]).length).toBeGreaterThan(0);
    });

    it('tools/call against the stub carries resultType "complete" and the tool result', async () => {
      const reply = await client.request2026('tools/call', { name: 'logseq_get_graph', arguments: {} });
      expect(reply.error).toBeUndefined();
      expect(reply.result!.resultType).toBe('complete');
      expect(reply.result!.isError).not.toBe(true);
      const text = (reply.result!.content as { text: string }[])[0].text;
      expect(JSON.parse(text)).toMatchObject({ name: 'my graph' });
      expect(stub.calls().map(call => call.method)).toEqual(['logseq.App.getCurrentGraph']);
    });

    it('prompts/get carries resultType "complete"', async () => {
      const reply = await client.request2026('prompts/get', { name: 'continue_on', arguments: { topic: 'project atlas' } });
      expect(reply.error).toBeUndefined();
      expect(reply.result!.resultType).toBe('complete');
      expect((reply.result!.messages as unknown[]).length).toBeGreaterThan(0);
    });

    it('resources/read of a missing page is -32602 (SEP-2164), not -32002, and keeps the uri in data', async () => {
      const reply = await client.request2026('resources/read', { uri: 'logseq://page/Projct%20Atlas' });
      expect(reply.result).toBeUndefined();
      expect(reply.error).toMatchObject({ code: -32602, data: { uri: 'logseq://page/Projct%20Atlas' } });
      expect(reply.error!.message).toContain('No page "Projct Atlas"');
    });

    it('resources/read of an unknown resource is -32602 too', async () => {
      const reply = await client.request2026('resources/read', { uri: 'logseq://nope' });
      // The message and uri tell this apart from a malformed request, which is also -32602
      expect(reply.error).toMatchObject({ code: -32602, data: { uri: 'logseq://nope' } });
      expect(reply.error!.message).toContain('Unknown resource');
    });

    it('stdout holds only MCP frames (ADR-0004)', () => {
      expectOnlyFrames(client.stdout());
    });
  });

  describe('2025-11-25, with the initialize handshake', () => {
    let client: RawClient;
    let init: Reply;
    beforeAll(async () => {
      client = start();
      init = await client.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'guard-2025', version: '1.0.0' },
      });
      client.notify('notifications/initialized');
    });

    it('initialize negotiates 2025-11-25 and answers server info and capabilities', () => {
      expect(init.error).toBeUndefined();
      expect(init.result).toMatchObject({
        protocolVersion: '2025-11-25',
        serverInfo: { name: expect.any(String) },
        capabilities: { tools: expect.any(Object), prompts: expect.any(Object), resources: expect.any(Object) },
      });
    });

    it('results keep the historical shape: no resultType', async () => {
      const list = await client.request('tools/list', {});
      const call = await client.request('tools/call', { name: 'logseq_get_graph', arguments: {} });
      const prompt = await client.request('prompts/get', { name: 'continue_on', arguments: { topic: 'project atlas' } });
      for (const reply of [list, call, prompt]) {
        expect(reply.error).toBeUndefined();
        expect(reply.result).not.toHaveProperty('resultType');
      }
      expect(JSON.parse((call.result!.content as { text: string }[])[0].text)).toMatchObject({ name: 'my graph' });
    });

    it('resources/read of a missing page is still -32002 (resource not found)', async () => {
      const reply = await client.request('resources/read', { uri: 'logseq://page/Projct%20Atlas' });
      expect(reply.error).toMatchObject({ code: -32002, data: { uri: 'logseq://page/Projct%20Atlas' } });
    });

    it('stdout holds only MCP frames (ADR-0004)', () => {
      expectOnlyFrames(client.stdout());
    });
  });
});
