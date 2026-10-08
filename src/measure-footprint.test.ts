import { describe, it, expect } from 'vitest';
import { formatMb, formatMs, formatSummary, parsePsRssBytes, summarize } from '../scripts/measure-footprint/stats.js';
import { probeServer } from '../scripts/measure-footprint/probe.js';

/** The start-up and footprint measurement (#126): the arithmetic, and the probe against a stand-in server. */
describe('summarize', () => {
  it('takes the middle value of an odd count, whatever the order', () => {
    expect(summarize([30, 10, 20])).toEqual({ n: 3, median: 20, min: 10, max: 30 });
  });

  it('averages the middle two of an even count', () => {
    expect(summarize([4, 1, 3, 2])).toEqual({ n: 4, median: 2.5, min: 1, max: 4 });
  });

  it('does not reorder the caller list', () => {
    const values = [3, 1, 2];
    summarize(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it('refuses an empty list rather than report NaN', () => {
    expect(() => summarize([])).toThrow('cannot summarize no values');
  });
});

describe('formatting', () => {
  it('reads ps output as kilobytes', () => {
    expect(parsePsRssBytes('  2048\n')).toBe(2048 * 1024);
  });

  it('rejects ps output that is not a size', () => {
    expect(() => parsePsRssBytes('')).toThrow('could not read a resident size');
    expect(() => parsePsRssBytes('abc')).toThrow('could not read a resident size');
    expect(() => parsePsRssBytes('0')).toThrow('could not read a resident size');
  });

  it('prints binary megabytes and milliseconds to one decimal', () => {
    expect(formatMb(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatMs(12.34)).toBe('12.3 ms');
    expect(formatSummary({ n: 3, median: 20, min: 10, max: 30 }, formatMs)).toBe('20.0 ms (10.0 ms - 30.0 ms)');
  });
});

// A stand-in MCP server: answers `initialize` and `tools/call` with one line each, as the real ones do.
const FAKE_SERVER = `
const rl = require('node:readline').createInterface({ input: process.stdin });
if (process.env.FAKE_IGNORE_SIGTERM) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
rl.on('line', line => {
  const m = JSON.parse(line);
  if (process.env.FAKE_SILENT) return;
  if (process.env.FAKE_JUNK) return console.log('this is not json-rpc');
  if (m.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18' } }));
  if (m.method === 'tools/call' && process.env.FAKE_RPC_ERROR) console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'bad arguments' } }));
  else if (m.method === 'tools/call') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: process.env.FAKE_FAIL ? { isError: true, content: [] } : { content: [{ type: 'text', text: 'ok' }] } }));
});
`;

const fake = (env: Record<string, string> = {}) => ({
  command: process.execPath,
  args: ['-e', FAKE_SERVER],
  env: { ...process.env, ...env } as Record<string, string>
});

const call = { name: 'any_tool', arguments: {} };

describe('probeServer', () => {
  it('times the handshake and reads memory before and after the call', async () => {
    let calls = 0;
    const result = await probeServer({ server: fake(), call, beforeCall: () => void calls++, settleMs: 20 });
    expect(calls).toBe(1);
    expect(result.coldStartMs).toBeGreaterThan(0);
    expect(result.idleRssBytes).toBeGreaterThan(1024 * 1024);
    expect(result.afterCallRssBytes).toBeGreaterThan(1024 * 1024);
  });

  it('fails when the tool call comes back as an error, so a broken server is not measured', async () => {
    await expect(probeServer({ server: fake({ FAKE_FAIL: '1' }), call, beforeCall: () => {}, settleMs: 20 })).rejects.toThrow(
      'the tool call did not return a result'
    );
  });

  it('fails with the exit reason when the server dies before answering', async () => {
    const server = { command: process.execPath, args: ['-e', 'process.exit(3)'], env: process.env as Record<string, string> };
    await expect(probeServer({ server, call, beforeCall: () => {}, settleMs: 20, timeoutMs: 2000 })).rejects.toThrow(
      /no response to initialize.*exited early \(code 3/
    );
  });

  it('fails when the tool call comes back as a JSON-RPC error', async () => {
    await expect(probeServer({ server: fake({ FAKE_RPC_ERROR: '1' }), call, beforeCall: () => {}, settleMs: 20 })).rejects.toThrow(
      /the tool call did not return a result.*bad arguments/s
    );
  });

  it('times out when the server never answers initialize', async () => {
    await expect(probeServer({ server: fake({ FAKE_SILENT: '1' }), call, beforeCall: () => {}, settleMs: 20, timeoutMs: 300 })).rejects.toThrow(
      'no response to initialize in 300 ms'
    );
  });

  it('fails at once on a stdout line that is not JSON, without printing the line', async () => {
    const error = await probeServer({ server: fake({ FAKE_JUNK: '1' }), call, beforeCall: () => {}, settleMs: 20, timeoutMs: 5000 }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('not JSON');
    expect((error as Error).message).not.toContain('this is not json-rpc');
  });

  it('kills a server that ignores SIGTERM instead of waiting for it', async () => {
    const result = await probeServer({ server: fake({ FAKE_IGNORE_SIGTERM: '1' }), call, beforeCall: () => {}, settleMs: 20 });
    expect(result.coldStartMs).toBeGreaterThan(0);
  }, 15000);
});
