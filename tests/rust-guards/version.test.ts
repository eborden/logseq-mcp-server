import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { connectMcpToApi } from '../../scripts/lib/rust-server.js';

const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf-8'));

// The Rust server reports its Cargo package version (src/server.rs), and this keeps it equal to
// package.json, the plugin manifest and the marketplace entry, so one number names the server, the tooling package
// and the plugin (the launcher fetches the binary for the plugin's own version, ADR-0035).
describe('server version (#46, #356)', () => {
  const pkg = readJson('../../package.json');

  it('reports the package.json version in the initialize response', async () => {
    // initialize makes no call to LogSeq, so the address is never used
    const mcp = await connectMcpToApi({ apiUrl: 'http://127.0.0.1:9', authToken: 'test-token-123' });
    try {
      expect(mcp.getServerVersion()).toMatchObject({ name: 'logseq-mcp-server', version: pkg.version });
    } finally {
      await mcp.close();
    }
  }, 30000);

  it('keeps the Cargo package on the same version', () => {
    const cargo = readFileSync(new URL('../../Cargo.toml', import.meta.url), 'utf-8');
    expect(cargo.match(/^\[package\][^[]*?^version = "([^"]+)"/ms)?.[1]).toBe(pkg.version);
  });

  it('is a semver string', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('keeps the Claude Code plugin manifest on the same version', () => {
    expect(readJson('../../.claude-plugin/plugin.json').version).toBe(pkg.version);
  });

  it('keeps the marketplace entry on the same version', () => {
    expect(readJson('../../.claude-plugin/marketplace.json').plugins[0].version).toBe(pkg.version);
  });
});
