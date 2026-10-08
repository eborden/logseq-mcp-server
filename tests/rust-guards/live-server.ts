// The Rust server as a client sees it, for the guards that read its own `tools/list` and its answers to bad arguments
// (#356): the binary over MCP stdio against the parity harness's stub LogSeq, which answers nothing it was not given and
// records every call. Nothing here contacts a LogSeq or reads ~/.logseq-mcp/config.json (BR-0001).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sandboxedEnv } from '../../scripts/parity/harness.js';
import { startStubLogseq, type StubLogseq } from '../../scripts/parity/stub-logseq.js';
import { requireRustBinary, rustBinaryPath } from '../../scripts/lib/rust-binary.js';

export interface LiveServer {
  client: Client;
  /** The stub LogSeq the server talks to; `stub.load([])` clears its log */
  stub: StubLogseq;
  close(): Promise<void>;
}

/** Starts the Rust debug build (`cd rust && cargo build`), or `LOGSEQ_MCP_RUST_BIN`, against an empty stub LogSeq. */
export async function startLiveServer(): Promise<LiveServer> {
  requireRustBinary();
  const stub = await startStubLogseq();
  stub.load([]);
  const dir = await mkdtemp(join(tmpdir(), 'logseq-live-guard-'));
  const home = join(dir, 'home');
  await mkdir(home);
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ apiUrl: stub.apiUrl, authToken: stub.authToken }));
  const transport = new StdioClientTransport({ command: rustBinaryPath(), args: [], env: sandboxedEnv(configPath, home), stderr: 'ignore' });
  const client = new Client({ name: 'logseq-live-guards', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (error) {
    await stub.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    client,
    stub,
    close: async () => {
      await client.close().catch(() => undefined);
      await stub.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
