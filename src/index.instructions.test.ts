import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { TOOL_DESCRIPTIONS } from './tool-descriptions.js';

describe('server instructions (#44)', () => {
  async function connect() {
    const server = createServer(new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
    return mcpClient;
  }

  it('sends instructions in the initialize response', async () => {
    const mcpClient = await connect();
    try {
      expect(mcpClient.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    } finally {
      await mcpClient.close();
    }
  });

  it('says the server is read-only and explains how to read results', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/read-only/i);
    for (const term of ['((uuid))', 'resolvedRefs', 'hasMore', 'warnings', 'uuid']) {
      expect(SERVER_INSTRUCTIONS, term).toContain(term);
    }
  });

  it('only names tools that exist', () => {
    const named = SERVER_INSTRUCTIONS.match(/logseq_[a-z_]+/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) {
      expect(Object.keys(TOOL_DESCRIPTIONS), name).toContain(name);
    }
  });

  it('stays short: it is paid for in every session', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(1300);
  });
});
