import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, resolveTipsEnabled } from './config.js';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('loadConfig', () => {
  let testDir: string;
  let configPath: string;

  beforeEach(async () => {
    // Create a temporary directory for tests
    testDir = join(tmpdir(), `logseq-mcp-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    configPath = join(testDir, 'config.json');
  });

  afterEach(async () => {
    // Clean up temporary directory
    await rm(testDir, { recursive: true, force: true });
  });

  it('should load valid config from file', async () => {
    const config = {
      apiUrl: 'http://localhost:12315',
      authToken: 'test-token-123'
    };

    await writeFile(configPath, JSON.stringify(config));

    const result = await loadConfig(configPath);

    expect(result).toEqual(config);
    expect(result.apiUrl).toBe('http://localhost:12315');
    expect(result.authToken).toBe('test-token-123');
  });

  it('should throw error when config file does not exist', async () => {
    const nonExistentPath = join(testDir, 'nonexistent.json');

    await expect(loadConfig(nonExistentPath)).rejects.toThrow();
  });

  it('should throw error when authToken is missing', async () => {
    const invalidConfig = {
      apiUrl: 'http://localhost:12315'
      // authToken is missing
    };

    await writeFile(configPath, JSON.stringify(invalidConfig));

    await expect(loadConfig(configPath)).rejects.toThrow(/authToken/);
  });

  it('should use default apiUrl when not provided', async () => {
    const configWithoutApiUrl = {
      authToken: 'test-token-123'
      // apiUrl is missing, should default to 'http://127.0.0.1:12315'
    };

    await writeFile(configPath, JSON.stringify(configWithoutApiUrl));

    const result = await loadConfig(configPath);

    expect(result.apiUrl).toBe('http://127.0.0.1:12315');
    expect(result.authToken).toBe('test-token-123');
  });

  it('should allow apiUrl to be overridden when provided', async () => {
    const configWithCustomApiUrl = {
      apiUrl: 'http://custom-host:9999',
      authToken: 'test-token-123'
    };

    await writeFile(configPath, JSON.stringify(configWithCustomApiUrl));

    const result = await loadConfig(configPath);

    expect(result.apiUrl).toBe('http://custom-host:9999');
    expect(result.authToken).toBe('test-token-123');
  });

  it('should throw error when config is not valid JSON', async () => {
    await writeFile(configPath, 'not valid json {{{');

    await expect(loadConfig(configPath)).rejects.toThrow();
  });

  describe('timeoutMs', () => {
    const base = { authToken: 'test-token-123' };

    it('should leave timeoutMs undefined when omitted', async () => {
      await writeFile(configPath, JSON.stringify(base));

      const result = await loadConfig(configPath);

      expect(result.timeoutMs).toBeUndefined();
    });

    it('should accept a positive timeoutMs', async () => {
      await writeFile(configPath, JSON.stringify({ ...base, timeoutMs: 5000 }));

      const result = await loadConfig(configPath);

      expect(result.timeoutMs).toBe(5000);
    });

    it.each([
      ['zero', '0'],
      ['negative', '-1'],
      ['a string', '"5000"'],
      ['null (what JSON.stringify makes of NaN)', 'null'],
      ['infinite (1e999 parses to Infinity)', '1e999'],
      ['a boolean', 'true']
    ])('should reject timeoutMs that is %s', async (_label, rawValue) => {
      await writeFile(configPath, `{"authToken": "test-token-123", "timeoutMs": ${rawValue}}`);

      await expect(loadConfig(configPath)).rejects.toThrow(/timeoutMs must be a positive finite number/);
    });
  });

  describe('tips', () => {
    const base = { authToken: 'test-token-123' };

    it('leaves tips undefined when omitted, and accepts a boolean', async () => {
      await writeFile(configPath, JSON.stringify(base));
      expect((await loadConfig(configPath)).tips).toBeUndefined();

      await writeFile(configPath, JSON.stringify({ ...base, tips: false }));
      expect((await loadConfig(configPath)).tips).toBe(false);
    });

    it('rejects a tips value that is not a boolean', async () => {
      await writeFile(configPath, JSON.stringify({ ...base, tips: 'off' }));
      await expect(loadConfig(configPath)).rejects.toThrow(/tips must be a boolean/);
    });
  });
});

describe('resolveTipsEnabled', () => {
  it('is on by default', () => {
    expect(resolveTipsEnabled({}, {})).toBe(true);
  });

  it('turns off with tips: false in the config', () => {
    expect(resolveTipsEnabled({ tips: false }, {})).toBe(false);
    expect(resolveTipsEnabled({ tips: true }, {})).toBe(true);
  });

  it.each(['0', 'false', 'OFF', ' no '])('turns off with LOGSEQ_MCP_TIPS=%s', value => {
    expect(resolveTipsEnabled({}, { LOGSEQ_MCP_TIPS: value })).toBe(false);
  });

  it.each(['1', 'true', 'on', 'yes', ' TRUE '])('turns on with LOGSEQ_MCP_TIPS=%s', value => {
    expect(resolveTipsEnabled({ tips: false }, { LOGSEQ_MCP_TIPS: value })).toBe(true);
  });

  it.each(['disabled', 'none', 'n', 'offf', 'false;'])('rejects LOGSEQ_MCP_TIPS=%s instead of leaving tips on', value => {
    expect(() => resolveTipsEnabled({}, { LOGSEQ_MCP_TIPS: value })).toThrow(
      /Configuration validation failed: LOGSEQ_MCP_TIPS must be one of/
    );
  });

  it('lets the environment override the config file in both directions', () => {
    expect(resolveTipsEnabled({ tips: false }, { LOGSEQ_MCP_TIPS: '1' })).toBe(true);
    expect(resolveTipsEnabled({ tips: true }, { LOGSEQ_MCP_TIPS: 'off' })).toBe(false);
  });

  it('ignores an empty variable', () => {
    expect(resolveTipsEnabled({ tips: false }, { LOGSEQ_MCP_TIPS: '' })).toBe(false);
  });
});
