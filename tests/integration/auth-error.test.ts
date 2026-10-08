import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { LogseqMCPConfig } from '../../scripts/lib/logseq-api.js';
import { connectFixture } from './helpers/fixture-client.js';
import { connectMcpToApi } from './helpers/server-under-test.js';

/**
 * Integration test for rejected tokens (issue #8, ADR-0003)
 *
 * Verifies that a real LogSeq answering HTTP 401 reaches the caller as an error that names the auth token
 * setting and never shows a token. The server talks to the fixture instance itself here (no forwarder), with
 * a deliberately bogus token, so the real token is never used or printed.
 *
 * Runs against the fixture graph (tests/integration/setup.md). Read-only.
 */

describe('Rejected auth token Integration Tests', () => {
  let config: LogseqMCPConfig;
  let mcp: Client;
  const bogusToken = 'not-the-real-token';

  beforeAll(async () => {
    ({ config } = await connectFixture());
    mcp = await connectMcpToApi({ apiUrl: config.apiUrl, authToken: bogusToken }, { tips: false });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it('reports the rejected token as an error that never shows a token', async () => {
    const result = (await mcp.callTool({ name: 'logseq_get_graph_info', arguments: {} })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    const text = result.content[0].text;

    expect(result.isError).toBe(true);
    expect(text).toContain('rejected the auth token (HTTP 401)');
    expect(text).toContain('authToken');
    expect(text).not.toContain(bogusToken);
    expect(text).not.toContain(config.authToken);
  });
});
