import { describe, it, expect, beforeAll } from 'vitest';
import { access } from 'fs/promises';
import { loadConfig, resolveConfigPath } from '../../src/config.js';
import { LogseqClient } from '../../src/client.js';
import { getCurrentContext } from '../../src/tools/get-current-context.js';

/**
 * Read-only: calls getCurrentPage / getCurrentBlock / getSelectedBlocks and never
 * changes LogSeq or its UI state. What is open is up to whoever is at the keyboard,
 * so these tests check the result's shape only, never specific content, and print nothing.
 */
describe('getCurrentContext - Integration', () => {
  let client: LogseqClient;

  beforeAll(async () => {
    const configPath = resolveConfigPath();

    try {
      await access(configPath);
    } catch {
      throw new Error(
        'Config file not found at ~/.logseq-mcp/config.json. ' +
        'See tests/integration/setup.md for setup instructions.'
      );
    }

    client = new LogseqClient(await loadConfig(configPath));
  });

  it('succeeds and returns a well-formed result for whatever is open', async () => {
    const result = await getCurrentContext(client);

    expect(result).toHaveProperty('page');
    if (result.page === null) {
      // Nothing open is a normal result with an explanation, not an error
      expect(typeof result.message).toBe('string');
      expect(result.message!.length).toBeGreaterThan(0);
    } else {
      expect(typeof result.page.name).toBe('string');
      expect(typeof result.page.originalName).toBe('string');
      expect(result.message).toBeUndefined();
    }

    if (result.focusedBlock) {
      expect(typeof result.focusedBlock.uuid).toBe('string');
      expect(typeof result.focusedBlock.content).toBe('string');
      expect(typeof result.focusedBlock.pageName).toBe('string');
    }

    if (result.selectedBlocks) {
      expect(result.selectedBlocks.length).toBeGreaterThan(0);
      for (const block of result.selectedBlocks) {
        expect(typeof block.uuid).toBe('string');
        expect(typeof block.pageName).toBe('string');
      }
    }
  });

  it('makes at most 4 API calls', async () => {
    const methods: string[] = [];
    const original = client.callAPI.bind(client);
    const counting = Object.create(client) as LogseqClient;
    counting.callAPI = (async (method: string, args: any[] = []) => {
      methods.push(method);
      return original(method, args);
    }) as typeof client.callAPI;

    await getCurrentContext(counting);

    expect(methods.length).toBeLessThanOrEqual(4);
    expect(methods).not.toContain('logseq.Editor.getAllPages');
  });
});
