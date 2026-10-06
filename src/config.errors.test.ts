import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadConfig,
  resolveTipsEnabled,
  ConfigError,
  ConfigFileNotFoundError,
  ConfigInvalidJsonError,
  ConfigValidationError,
} from './config.js';

// Typed config errors (#63). src/config.test.ts covers the behaviour; this file
// pins the error classes, the exact messages and which problem wins when a file
// has several.

const TOKEN = 'fake-token-do-not-leak-7f3a';

describe('loadConfig typed errors', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `logseq-mcp-config-errors-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    path = join(dir, 'config.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The error loadConfig throws for a file holding `text`. */
  async function errorFor(text: string): Promise<unknown> {
    await writeFile(path, text);
    return loadConfig(path).then(
      () => expect.unreachable('loadConfig should have thrown'),
      (error: unknown) => error
    );
  }

  async function validationErrorFor(config: unknown): Promise<ConfigValidationError> {
    const error = await errorFor(JSON.stringify(config));
    expect(error).toBeInstanceOf(ConfigValidationError);
    return error as ConfigValidationError;
  }

  it('throws ConfigFileNotFoundError with the path and the old message', async () => {
    const missing = join(dir, 'nonexistent.json');
    const error = await loadConfig(missing).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigFileNotFoundError);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toBeInstanceOf(Error);
    expect((error as ConfigFileNotFoundError).name).toBe('ConfigFileNotFoundError');
    expect((error as ConfigFileNotFoundError).configPath).toBe(missing);
    expect((error as Error).message).toBe(`Configuration file not found: ${missing}`);
  });

  it('re-throws other read errors as they are, not as a ConfigError', async () => {
    const error = await loadConfig(dir).catch((e: unknown) => e); // a directory

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConfigError);
    expect((error as NodeJS.ErrnoException).code).toBe('EISDIR');
  });

  it('throws ConfigInvalidJsonError, keeping a parser message that quotes nothing word for word', async () => {
    const text = '{"authToken": "x",}';
    let parserMessage = '';
    try {
      JSON.parse(text);
    } catch (e) {
      parserMessage = (e as Error).message;
    }
    expect(parserMessage).not.toContain('"');

    const error = await errorFor(text);

    expect(error).toBeInstanceOf(ConfigInvalidJsonError);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).name).toBe('ConfigInvalidJsonError');
    expect((error as Error).message).toBe(`Invalid JSON in config file: ${parserMessage}`);
  });

  it.each([
    ['an unquoted token', `{"authToken": ${TOKEN}}`],
    ['an unquoted token after other fields', `{"apiUrl": "http://localhost:12315", "authToken": ${TOKEN}, "tips": true}`],
    ['single-quoted JSON', `{'authToken': '${TOKEN}'}`],
    ['a short file', TOKEN],
  ])('never quotes the file in an invalid-JSON message (%s)', async (_label, text) => {
    const error = await errorFor(text);

    expect(error).toBeInstanceOf(ConfigInvalidJsonError);
    const message = (error as Error).message;
    expect(message.startsWith('Invalid JSON in config file: ')).toBe(true);
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(TOKEN.slice(0, 8));
    expect(message).not.toContain('"');
  });

  it.each([
    ['missing', { apiUrl: 'http://localhost:12315' }],
    ['empty', { authToken: '' }],
    ['null', { authToken: null }],
    ['zero', { authToken: 0 }],
    ['false', { authToken: false }],
  ])('reports authToken %s as required', async (_label, config) => {
    const error = await validationErrorFor(config);

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.name).toBe('ConfigValidationError');
    expect(error.field).toBe('authToken');
    expect(error.message).toBe('Configuration validation failed: authToken is required');
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a number', '42'],
    ['a string', '"hello"'],
  ])('reports a file holding %s as authToken required', async (_label, text) => {
    const error = await errorFor(text);

    expect(error).toBeInstanceOf(ConfigValidationError);
    expect((error as ConfigValidationError).field).toBe('authToken');
    expect((error as Error).message).toBe('Configuration validation failed: authToken is required');
  });

  it.each([
    ['apiUrl', { authToken: TOKEN, apiUrl: 12315 }, 'Configuration validation failed: apiUrl must be a string'],
    ['authToken', { authToken: 12345678 }, 'Configuration validation failed: authToken must be a string'],
    ['authToken', { authToken: [TOKEN] }, 'Configuration validation failed: authToken must be a string'],
    ['timeoutMs', { authToken: TOKEN, timeoutMs: '5000' }, 'Configuration validation failed: timeoutMs must be a positive finite number'],
    ['timeoutMs', { authToken: TOKEN, timeoutMs: -1 }, 'Configuration validation failed: timeoutMs must be a positive finite number'],
    ['tips', { authToken: TOKEN, tips: 'false' }, 'Configuration validation failed: tips must be a boolean'],
    ['tips', { authToken: TOKEN, tips: null }, 'Configuration validation failed: tips must be a boolean'],
  ])('names %s and keeps the old message', async (field, config, message) => {
    const error = await validationErrorFor(config);

    expect(error.field).toBe(field);
    expect(error.message).toBe(message);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain('12345678');
  });

  // The order the hand-written checks ran in: authToken present, apiUrl,
  // authToken's type, timeoutMs, tips.
  it.each([
    ['authToken required over apiUrl', { apiUrl: 5, timeoutMs: 0, tips: 'x' }, 'authToken', 'is required'],
    ['apiUrl over authToken type', { apiUrl: 5, authToken: 5, timeoutMs: 0 }, 'apiUrl', 'must be a string'],
    ['authToken type over timeoutMs', { authToken: 5, timeoutMs: 0, tips: 'x' }, 'authToken', 'must be a string'],
    ['timeoutMs over tips', { authToken: TOKEN, timeoutMs: 0, tips: 'x' }, 'timeoutMs', 'must be a positive finite number'],
  ])('reports %s when a file has several problems', async (_label, config, field, problem) => {
    const error = await validationErrorFor(config);

    expect(error.field).toBe(field);
    expect(error.message).toBe(`Configuration validation failed: ${field} ${problem}`);
  });

  it.each([
    ['empty', ''],
    ['null', null],
    ['false', false],
    ['zero', 0],
  ])('uses the default apiUrl when apiUrl is %s, as before', async (_label, apiUrl) => {
    await writeFile(path, JSON.stringify({ authToken: TOKEN, apiUrl }));

    expect(await loadConfig(path)).toEqual({ apiUrl: 'http://127.0.0.1:12315', authToken: TOKEN });
  });

  it('accepts a fractional timeoutMs, as before', async () => {
    await writeFile(path, JSON.stringify({ authToken: TOKEN, timeoutMs: 0.5 }));

    expect((await loadConfig(path)).timeoutMs).toBe(0.5);
  });
});

describe('resolveTipsEnabled typed errors', () => {
  it('throws ConfigValidationError naming LOGSEQ_MCP_TIPS, with the old message', () => {
    let error: unknown;
    try {
      resolveTipsEnabled({}, { LOGSEQ_MCP_TIPS: 'disabled' });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigValidationError).field).toBe('LOGSEQ_MCP_TIPS');
    expect((error as Error).message).toBe(
      'Configuration validation failed: LOGSEQ_MCP_TIPS must be one of 1, true, on, yes, 0, false, off, no (got "disabled")'
    );
  });
});
