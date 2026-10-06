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

  it('names exactly the tools whose schema has resolve_refs', async () => {
    const mcpClient = await connect();
    try {
      const supporting = (await mcpClient.listTools()).tools
        .filter(t => 'resolve_refs' in ((t.inputSchema as any).properties ?? {}))
        .map(t => t.name.replace(/^logseq_/, ''))
        .sort();
      const listed = SERVER_INSTRUCTIONS.match(/resolve_refs \(([^)]+)\)/)?.[1].split(/,\s*/).sort();
      expect(listed).toEqual(supporting);
    } finally {
      await mcpClient.close();
    }
  });

  it('puts the page outline before get_block as the way into a long page (#43)', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/logseq_get_page_outline, then logseq_get_block/);
  });

  it('only names tools that exist', () => {
    const named = SERVER_INSTRUCTIONS.match(/logseq_[a-z_]+/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) {
      expect(Object.keys(TOOL_DESCRIPTIONS), name).toContain(name);
    }
  });

  it('makes the warning the cut signal, not hasMore (BR-0006, #61)', () => {
    // A cut at a hard maximum has hasMore: false; the model must not read that as complete
    expect(SERVER_INSTRUCTIONS).toMatch(/A warning means the result was cut/);
    expect(SERVER_INSTRUCTIONS).toMatch(/hasMore: true means a parameter can fetch more/);
    expect(SERVER_INSTRUCTIONS).toMatch(/with hasMore: false the warning says why not/);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/hasMore: true means the result was cut/);
  });

  it('stays short: it is paid for in every session', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(1300);
  });
});
