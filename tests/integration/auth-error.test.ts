import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../src/client.js';
import { LogSeqAuthError } from '../../src/errors.js';
import { LogseqMCPConfig } from '../../src/types.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Integration test for rejected tokens (issue #8)
 *
 * Verifies that a real LogSeq answering HTTP 401 surfaces as LogSeqAuthError.
 * The URL comes from the fixture instance's config; the token is deliberately
 * bogus, so the real token is never used or printed.
 *
 * Runs against the fixture graph (tests/integration/setup.md). Read-only.
 */

describe('Rejected auth token Integration Tests', () => {
  let config: LogseqMCPConfig;

  beforeAll(async () => {
    ({ config } = await connectFixture());
  });

  it('throws LogSeqAuthError when the token is wrong', async () => {
    const bogusToken = 'not-the-real-token';
    const client = new LogseqClient({ ...config, authToken: bogusToken });

    const error = (await client.callAPI('logseq.App.getCurrentGraph').catch(e => e)) as Error;

    expect(error).toBeInstanceOf(LogSeqAuthError);
    expect(error.message).toContain('authToken');
    expect(error.message).not.toContain(bogusToken);
    expect(error.message).not.toContain(config.authToken);
  });
});
