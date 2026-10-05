import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';
import { SERVER_VERSION } from './version.js';

const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf-8'));

describe('server version (#46)', () => {
  const pkg = readJson('../package.json');

  it('reports the package.json version in the initialize response', async () => {
    const server = createServer(new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
    try {
      expect(mcpClient.getServerVersion()).toMatchObject({
        name: 'logseq-mcp-server',
        version: pkg.version,
      });
    } finally {
      await mcpClient.close();
    }
  });

  it('SERVER_VERSION is a semver string equal to package.json', () => {
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('keeps the Claude Code plugin manifest on the same version', () => {
    expect(readJson('../.claude-plugin/plugin.json').version).toBe(pkg.version);
  });
});
