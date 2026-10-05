import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';
import { access } from 'fs/promises';
import { loadConfig } from '../../src/config.js';
import { LogseqClient } from '../../src/client.js';
import { LogSeqAuthError } from '../../src/errors.js';
import { LogseqMCPConfig } from '../../src/types.js';

/**
 * Integration test for rejected tokens (issue #8)
 *
 * Verifies that a real LogSeq answering HTTP 401 surfaces as LogSeqAuthError.
 * The URL comes from the real config; the token is deliberately bogus, so the
 * real token is never used or printed.
 *
 * Requires LogSeq running with the HTTP API enabled.
 * See tests/integration/setup.md. Read-only: nothing is written to the graph.
 */

describe('Rejected auth token Integration Tests', () => {
  let config: LogseqMCPConfig;

  beforeAll(async () => {
    const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');

    try {
      await access(configPath);
    } catch {
      throw new Error(
        'Config file not found at ~/.logseq-mcp/config.json. ' +
        'Integration tests require LogSeq configuration. ' +
        'See tests/integration/setup.md for setup instructions.'
      );
    }

    config = await loadConfig(configPath);
  });

  it('throws LogSeqAuthError when the token is wrong', async () => {
    const bogusToken = 'not-the-real-token';
    const client = new LogseqClient({ ...config, authToken: bogusToken });

    const error = await client.callAPI('logseq.App.getCurrentGraph').catch(e => e);

    expect(error).toBeInstanceOf(LogSeqAuthError);
    expect(error.message).toContain('authToken');
    expect(error.message).not.toContain(bogusToken);
    expect(error.message).not.toContain(config.authToken);
  });
});
