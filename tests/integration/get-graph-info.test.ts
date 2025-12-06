import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';
import { access } from 'fs/promises';
import { loadConfig } from '../../src/config.js';
import { LogseqClient } from '../../src/client.js';
import { getGraphInfo } from '../../src/tools/get-graph-info.js';

describe('getGraphInfo - Integration', () => {
  let client: LogseqClient;

  beforeAll(async () => {
    const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');

    try {
      await access(configPath);
    } catch {
      throw new Error(
        'Config file not found at ~/.logseq-mcp/config.json. ' +
        'See tests/integration/setup.md for setup instructions.'
      );
    }

    const config = await loadConfig(configPath);
    client = new LogseqClient(config);
  });

  it('should retrieve current graph information', async () => {
    const result = await getGraphInfo(client);

    // Verify structure
    expect(result).toBeDefined();
    expect(result).toHaveProperty('path');
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('url');

    // Verify types
    expect(typeof result.path).toBe('string');
    expect(typeof result.name).toBe('string');
    expect(typeof result.url).toBe('string');

    // Verify path is absolute
    expect(result.path).toMatch(/^[\/~]/);

    // Verify non-empty
    expect(result.path.length).toBeGreaterThan(0,
      'Graph path should not be empty'
    );
    expect(result.name.length).toBeGreaterThan(0,
      'Graph name should not be empty'
    );
    expect(result.url.length).toBeGreaterThan(0,
      'Graph URL should not be empty'
    );

    console.log('Graph Info:', result);
  });

  it('should return consistent results on multiple calls', async () => {
    const result1 = await getGraphInfo(client);
    const result2 = await getGraphInfo(client);

    expect(result1).toEqual(result2);
  });
});
