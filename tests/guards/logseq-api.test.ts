import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ConfigError,
  DEFAULT_TIMEOUT_MS,
  LogseqClient,
  LogSeqAuthError,
  LogSeqNotRunningError,
  LogSeqTimeoutError,
  loadConfig,
  resolveConfigPath,
} from '../../scripts/lib/logseq-api.js';

/**
 * scripts/lib/logseq-api.ts is the small client the repo's tooling uses (the fixture check, the probe, the measure
 * scripts, the per-worktree instance). The server's own client is rust/src/client.rs, which has its own tests.
 */

const TOKEN = 'secret-token-for-tests';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A local LogSeq that records each request body and answers with `respond`. */
async function listen(
  respond: (body: { method: string; args: unknown[] }, auth: string | undefined) => { status?: number; body?: unknown } | 'hang'
): Promise<{ apiUrl: string; requests: Array<{ method: string; args: unknown[] }> }> {
  const requests: Array<{ method: string; args: unknown[] }> = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const answer = respond(body, request.headers.authorization);
      if (answer === 'hang') return;
      response.writeHead(answer.status ?? 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(answer.body ?? null));
    });
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return { apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

describe('LogseqClient', () => {
  it('sends each Datalog input as an EDN literal: a JSON string, with quotes, backslashes and newlines escaped (ADR-0013)', async () => {
    const { apiUrl, requests } = await listen(() => ({ body: [] }));
    const client = new LogseqClient({ apiUrl, authToken: TOKEN });

    await client.executeDatalogQuery('[:find ?p :in $ ?a ?b ?c :where [?p :block/name ?a]]', 'my page', 'a "quoted" \\ name\nline', ['x', 'y']);

    expect(requests).toEqual([
      {
        method: 'logseq.DB.datascriptQuery',
        args: ['[:find ?p :in $ ?a ?b ?c :where [?p :block/name ?a]]', '"my page"', '"a \\"quoted\\" \\\\ name\\nline"', '["x","y"]'],
      },
    ]);
  });

  it('sends the bearer token and returns the answer as it is', async () => {
    const seen: Array<string | undefined> = [];
    const { apiUrl } = await listen((_body, auth) => (seen.push(auth), { body: { name: 'graph' } }));
    const client = new LogseqClient({ apiUrl, authToken: TOKEN });

    expect(await client.callAPI('logseq.App.getCurrentGraph')).toEqual({ name: 'graph' });
    expect(seen).toEqual([`Bearer ${TOKEN}`]);
  });

  it('turns an HTTP 401 into LogSeqAuthError, whose message never includes the token (ADR-0003)', async () => {
    const { apiUrl } = await listen(() => ({ status: 401 }));
    const error = (await new LogseqClient({ apiUrl, authToken: TOKEN }).callAPI('x').catch(e => e)) as Error;

    expect(error).toBeInstanceOf(LogSeqAuthError);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('authToken');
  });

  it('turns an {error} answer, which LogSeq sends with HTTP 200, into an error', async () => {
    const { apiUrl } = await listen(() => ({ body: { error: 'MethodNotExist: nope' } }));

    await expect(new LogseqClient({ apiUrl, authToken: TOKEN }).callAPI('nope')).rejects.toThrow('LogSeq API error: MethodNotExist: nope');
  });

  it('aborts a call after timeoutMs and says so, and the default is 30 seconds', async () => {
    const { apiUrl } = await listen(() => 'hang');
    const error = (await new LogseqClient({ apiUrl, authToken: TOKEN, timeoutMs: 50 }).callAPI('x').catch(e => e)) as Error;

    expect(error).toBeInstanceOf(LogSeqTimeoutError);
    expect(error.message).toContain('50ms');
    expect(DEFAULT_TIMEOUT_MS).toBe(30000);
  });

  it('reports a refused connection as LogSeqNotRunningError', async () => {
    const { apiUrl } = await listen(() => ({ body: null }));
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;

    await expect(new LogseqClient({ apiUrl, authToken: TOKEN }).callAPI('x')).rejects.toBeInstanceOf(LogSeqNotRunningError);
  });
});

describe('loadConfig and resolveConfigPath', () => {
  const write = async (text: string): Promise<{ path: string; dir: string }> => {
    const dir = await mkdtemp(join(tmpdir(), 'logseq-api-test-'));
    const path = join(dir, 'config.json');
    await writeFile(path, text);
    return { path, dir };
  };

  it('reads apiUrl, authToken and the optional fields, and defaults the API URL', async () => {
    const { path, dir } = await write(JSON.stringify({ authToken: TOKEN, timeoutMs: 5000, tips: false, extra: 1 }));
    try {
      expect(await loadConfig(path)).toEqual({ apiUrl: 'http://127.0.0.1:12315', authToken: TOKEN, timeoutMs: 5000, tips: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a missing file, bad JSON and a wrong field without ever quoting the file', async () => {
    const { path, dir } = await write(`{ "authToken": "${TOKEN}", oops }`);
    try {
      const bad = await loadConfig(path).catch(e => e);
      expect(bad).toBeInstanceOf(ConfigError);
      expect(bad.message).not.toContain(TOKEN);
      await writeFile(path, JSON.stringify({ apiUrl: 'http://x' }));
      await expect(loadConfig(path)).rejects.toThrow('authToken is required');
      await writeFile(path, JSON.stringify({ authToken: TOKEN, timeoutMs: '5000' }));
      const wrong = await loadConfig(path).catch(e => e);
      expect(wrong.message).toContain('timeoutMs must be a positive finite number');
      expect(wrong.message).not.toContain(TOKEN);
      await expect(loadConfig(join(dir, 'missing.json'))).rejects.toThrow('Configuration file not found');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves LOGSEQ_MCP_CONFIG over the default path, and wants it absolute', () => {
    expect(resolveConfigPath({ LOGSEQ_MCP_CONFIG: '/tmp/a.json' }, '/home/alice')).toBe('/tmp/a.json');
    expect(resolveConfigPath({ LOGSEQ_MCP_CONFIG: '  ' }, '/home/alice')).toBe('/home/alice/.logseq-mcp/config.json');
    expect(resolveConfigPath({}, '/home/alice')).toBe('/home/alice/.logseq-mcp/config.json');
    expect(() => resolveConfigPath({ LOGSEQ_MCP_CONFIG: 'config.json' }, '/home/alice')).toThrow(ConfigError);
  });
});
