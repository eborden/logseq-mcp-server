import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';
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
});
