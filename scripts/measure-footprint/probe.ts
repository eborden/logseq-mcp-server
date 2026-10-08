// Runs one MCP server process over stdio, the way a client does, and reads off what #126 needs:
// the time from spawn to the `initialize` response, and the process's resident memory before and
// after one tool call. Raw newline-delimited JSON-RPC rather than the SDK client, so the client's
// own start-up and bookkeeping stay out of the timing.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { parsePsRssBytes } from './stats.js';

const execFileAsync = promisify(execFile);

export interface ServerProcess {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface ProbeResult {
  /** Spawn to the first `initialize` response, in milliseconds */
  coldStartMs: number;
  /** Resident memory once the handshake is done and the process has settled, in bytes */
  idleRssBytes: number;
  /** Resident memory after one tool call, in bytes */
  afterCallRssBytes: number;
}

export interface ProbeOptions {
  server: ServerProcess;
  /** The one tool call made after the handshake */
  call: { name: string; arguments: Record<string, unknown> };
  /** Runs just before the tool call, to give the stub its answers */
  beforeCall: () => void;
  /** Milliseconds to let the process settle before each memory reading */
  settleMs?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The resident set of a process in bytes. macOS and Linux only: Windows has no `ps`. */
export async function residentBytes(pid: number): Promise<number> {
  if (process.platform === 'win32') throw new Error('measuring resident memory needs ps; run this on macOS or Linux');
  const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)]);
  return parsePsRssBytes(stdout);
}

/** How long a process gets to exit after each signal before the next, stronger one */
const STOP_WAIT_MS = 2000;

const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

/** SIGTERM, then SIGKILL after a bounded wait, so a server that ignores SIGTERM can't hang the script or outlive it. */
async function stopProcess(child: ChildProcess): Promise<void> {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (hasExited(child)) return;
    child.kill(signal);
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, STOP_WAIT_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export async function probeServer({ server, call, beforeCall, settleMs = 500, timeoutMs = 15000 }: ProbeOptions): Promise<ProbeResult> {
  const waiting = new Map<number, { resolve: (message: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  // Set when stdout carries something that is not JSON-RPC; every pending and later request then fails with it
  let fatal: Error | undefined;
  let buffer = '';
  let stderr = '';
  const started = performance.now();
  const child = spawn(server.command, server.args, { cwd: server.cwd, env: server.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let exited: string | undefined;
  child.once('exit', (code, signal) => {
    exited = `exited early (code ${code}, signal ${signal})`;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Only the length: the line is the server's, and it is not printed (BR-0001)
        fatal = new Error(`the server wrote a line to stdout that is not JSON (${line.length} characters)\n${stderr.trim()}`);
        for (const pending of waiting.values()) pending.reject(fatal);
        return;
      }
      const pending = typeof message.id === 'number' ? waiting.get(message.id) : undefined;
      if (pending) pending.resolve(message);
    }
  });

  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const request = (id: number, method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (fatal) return reject(fatal);
      const timer = setTimeout(
        () => reject(new Error(`no response to ${method} in ${timeoutMs} ms\n${stderr.trim()}`)),
        timeoutMs
      );
      waiting.set(id, {
        resolve: message => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`no response to ${method}; the server ${exited}\n${stderr.trim()}`));
      });
      send({ id, method, params });
    });

  try {
    const init = await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'logseq-footprint-probe', version: '1.0.0' }
    });
    const coldStartMs = performance.now() - started;
    if (init.error || !init.result) throw new Error(`initialize failed: ${JSON.stringify(init.error ?? init)}`);
    send({ method: 'notifications/initialized' });

    await sleep(settleMs);
    const idleRssBytes = await residentBytes(child.pid!);

    beforeCall();
    const response = await request(2, 'tools/call', call);
    const result = response.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
    if (response.error || !result || result.isError || !result.content?.[0]?.text) {
      throw new Error(`the tool call did not return a result: ${JSON.stringify(response.error ?? { isError: result?.isError })}\n${stderr.trim()}`);
    }
    await sleep(settleMs);
    const afterCallRssBytes = await residentBytes(child.pid!);
    return { coldStartMs, idleRssBytes, afterCallRssBytes };
  } finally {
    child.stdin.end();
    await stopProcess(child);
  }
}
