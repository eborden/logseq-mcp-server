import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CONFIG_PATH_ENV,
  ConfigFileNotFoundError,
  ConfigValidationError,
  defaultConfigPath,
  loadConfig,
  resolveConfigPath,
} from './config.js';

// LOGSEQ_MCP_CONFIG (#118): which config file the server and the integration tests load.
// The env and home are passed in, so the developer's own environment never leaks in.

const HOME = '/home/alice';

describe('resolveConfigPath', () => {
  it('defaults to ~/.logseq-mcp/config.json', () => {
    expect(resolveConfigPath({}, HOME)).toBe('/home/alice/.logseq-mcp/config.json');
    expect(defaultConfigPath(HOME)).toBe('/home/alice/.logseq-mcp/config.json');
  });

  it('uses LOGSEQ_MCP_CONFIG when it holds an absolute path', () => {
    expect(CONFIG_PATH_ENV).toBe('LOGSEQ_MCP_CONFIG');
    const env = { LOGSEQ_MCP_CONFIG: '/work/tree/.logseq-instance/config.json' };
    expect(resolveConfigPath(env, HOME)).toBe('/work/tree/.logseq-instance/config.json');
  });

  it('trims surrounding spaces', () => {
    expect(resolveConfigPath({ LOGSEQ_MCP_CONFIG: '  /tmp/config.json \n' }, HOME)).toBe('/tmp/config.json');
  });

  it.each(['', '   '])('ignores an empty or blank variable (%j)', value => {
    expect(resolveConfigPath({ LOGSEQ_MCP_CONFIG: value }, HOME)).toBe('/home/alice/.logseq-mcp/config.json');
  });

  it.each(['config.json', './.logseq-instance/config.json', '~/.logseq-mcp/config.json'])(
    'rejects a relative path (%j) with a ConfigValidationError naming the variable',
    value => {
      let caught: unknown;
      try {
        resolveConfigPath({ LOGSEQ_MCP_CONFIG: value }, HOME);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigValidationError);
      expect((caught as ConfigValidationError).field).toBe('LOGSEQ_MCP_CONFIG');
      expect((caught as Error).message).toBe(
        `Configuration validation failed: LOGSEQ_MCP_CONFIG must be an absolute path (got "${value}")`
      );
    }
  );
});

describe('loading the file LOGSEQ_MCP_CONFIG names', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `logseq-mcp-config-path-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads that file instead of the default', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ apiUrl: 'http://127.0.0.1:12345', authToken: 'fake-instance-token' }));

    const config = await loadConfig(resolveConfigPath({ LOGSEQ_MCP_CONFIG: path }, HOME));

    expect(config).toEqual({ apiUrl: 'http://127.0.0.1:12345', authToken: 'fake-instance-token' });
  });

  it('reports a missing override file by its own path', async () => {
    const path = join(dir, 'missing.json');

    await expect(loadConfig(resolveConfigPath({ LOGSEQ_MCP_CONFIG: path }, HOME))).rejects.toEqual(
      new ConfigFileNotFoundError(path)
    );
  });

  it('leaves loadConfig with an explicit path alone', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ authToken: 'fake-explicit-token' }));
    const before = process.env.LOGSEQ_MCP_CONFIG;
    process.env.LOGSEQ_MCP_CONFIG = join(dir, 'other.json');
    try {
      await expect(loadConfig(path)).resolves.toMatchObject({ authToken: 'fake-explicit-token' });
    } finally {
      if (before === undefined) delete process.env.LOGSEQ_MCP_CONFIG;
      else process.env.LOGSEQ_MCP_CONFIG = before;
    }
  });
});
