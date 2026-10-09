import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { requireRustBinary, rustBinaryPath } from '../../scripts/lib/rust-binary.js';
import { sandboxedEnv } from '../../scripts/lib/sandboxed-env.js';

// ADR-0035, #419: the plugin's launcher starting the real server. The Rust binary this job just built is dressed as a
// release (named for this platform's target, listed in SHA256SUMS next to a LICENSE and a notices file), the real
// scripts/logseq-mcp-server.sh fetches it through a file:// base into an empty cache, checks it, and `exec`s it, and an
// MCP client talks to it over stdio. That exercises the plugin command line, the download through curl, the checksum
// check, the cache and the exec together (the maintainer's pre-publish check, ADR-0035 step 12.4, does the same with
// the real draft). Nothing here contacts GitHub or a LogSeq (BR-0001).

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The release target the launcher picks on this machine. */
function hostTarget(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'aarch64-apple-darwin';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'x86_64-apple-darwin';
  if (process.platform === 'linux' && process.arch === 'x64') return 'x86_64-unknown-linux-musl';
  throw new Error(`the launcher has no release target for ${process.platform} ${process.arch}`);
}

describe('the launcher starting the server (ADR-0035)', () => {
  let dir: string;
  let client: Client;
  let cached: string;
  let serverPid: number | null;

  beforeAll(async () => {
    requireRustBinary();
    dir = mkdtempSync(join(tmpdir(), 'launcher-live-'));
    const release = join(dir, 'release');
    const cache = join(dir, 'cache');
    const home = join(dir, 'home');
    for (const d of [release, cache, home]) mkdirSync(d);

    const asset = `logseq-mcp-server-${pkg.version}-${hostTarget()}`;
    copyFileSync(rustBinaryPath(), join(release, asset));
    writeFileSync(join(release, 'LICENSE'), 'MIT License\n');
    writeFileSync(join(release, 'THIRD-PARTY-NOTICES.txt'), 'notices\n');
    const sums = [asset, 'LICENSE', 'THIRD-PARTY-NOTICES.txt'].map(file => `${sha256(join(release, file))}  ${file}`);
    writeFileSync(join(release, 'SHA256SUMS'), `${sums.join('\n')}\n`);
    cached = join(cache, 'logseq-mcp-server', pkg.version, asset);

    // A stub LogSeq is not needed: initialize and tools/list make no call. The config points nowhere reachable.
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ apiUrl: 'http://127.0.0.1:9', authToken: 'test-token-123' }));
    const env = {
      ...sandboxedEnv(configPath, home),
      XDG_CACHE_HOME: cache,
      LOGSEQ_MCP_RELEASE_BASE_URL: `file://${release}`,
    };
    // the command the plugin manifest declares, with the plugin root being this checkout
    const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf-8'));
    const { command, args } = plugin.mcpServers.logseq as { command: string; args: string[] };
    const transport = new StdioClientTransport({
      command,
      args: args.map(arg => arg.replace('${CLAUDE_PLUGIN_ROOT}', ROOT)),
      env,
      stderr: 'pipe',
    });
    client = new Client({ name: 'launcher-live-guard', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    serverPid = transport.pid;
  }, 60000);

  afterAll(async () => {
    await client?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('answers initialize with the version the checkout names', () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'logseq-mcp-server', version: pkg.version });
  });

  it('answers tools/list with the 16 tools', async () => {
    expect((await client.listTools()).tools).toHaveLength(16);
  });

  // The launcher must be replaced by the server (`exec`), not wait beside it: ADR-0035's footprint (about 2 MB resident)
  // depends on it, and a launcher that ran the server as a child would pass every other test here.
  it('is the server itself: the process the client started runs the cached binary and has no child', () => {
    expect(serverPid).not.toBeNull();
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(serverPid)], { encoding: 'utf-8' }).trim();
    // the whole command line is the cached path: not `sh .../logseq-mcp-server.sh`, and no arguments
    expect(command).toBe(cached);
    const table = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf-8' });
    const children = table
      .split('\n')
      .map(line => line.trim().split(/\s+/))
      .filter(([, ppid]) => ppid === String(serverPid));
    expect(children).toEqual([]);
  });

  it('left the checked binary in the cache, executable', () => {
    expect(statSync(cached).mode & 0o111).not.toBe(0);
  });
});
