// A small client for LogSeq's HTTP API, for the repo's own tooling: the integration tests' fixture check and
// setup queries, the probe, the measure scripts and the per-worktree instance (#356). It is not the server: the
// Rust server (rust/) has its own client, and nothing here is shipped. It keeps what the tooling needs and no more:
// bearer token, a timeout per call, the three connection errors, and the EDN encoding of Datalog inputs.
//
// The config is parsed with plain checks: `{ apiUrl, authToken, timeoutMs? }`. No error message here includes the
// token (ADR-0003).
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface LogseqMCPConfig {
  apiUrl: string;
  authToken: string;
  /** Per-request timeout in milliseconds. Defaults to 30000 when omitted. */
  timeoutMs?: number;
  /** Next-step tips in results. The tooling reads the file as the server does, and ignores this. */
  tips?: boolean;
}

/** Default per-call timeout when `timeoutMs` is not set in the config */
export const DEFAULT_TIMEOUT_MS = 30000;

const DEFAULT_API_URL = 'http://127.0.0.1:12315';

/** Environment variable naming another config file, e.g. a per-worktree test instance's. */
export const CONFIG_PATH_ENV = 'LOGSEQ_MCP_CONFIG';

/** LogSeq is not reachable: it is not running, or its HTTP API server is off or on another port. */
export class LogSeqNotRunningError extends Error {
  constructor(apiUrl: string, originalError?: Error) {
    const errorDetails = originalError ? `\n\nError: ${originalError.message}` : '';
    super(
      `Cannot connect to LogSeq at ${apiUrl}${errorDetails}\n\n` +
        `Steps to fix:\n` +
        `1. Start LogSeq desktop application (or this worktree's instance: npx tsx scripts/logseq-instance.ts start)\n` +
        `2. Enable HTTP API server: Settings → Advanced → Enable HTTP API server\n` +
        `3. Verify the API URL in the config file matches LogSeq's HTTP server port`
    );
    this.name = 'LogSeqNotRunningError';
  }
}

/** A LogSeq API call did not complete within the timeout: LogSeq is reachable but not answering. */
export class LogSeqTimeoutError extends Error {
  constructor(apiUrl: string, timeoutMs: number) {
    super(
      `LogSeq at ${apiUrl} did not respond within ${timeoutMs}ms\n\n` +
        `Steps to fix:\n` +
        `1. Check that LogSeq is not busy (indexing, a stuck window or a very large graph)\n` +
        `2. Retry the request\n` +
        `3. To allow slower calls, raise "timeoutMs" in the config file (default 30000, per API call)`
    );
    this.name = 'LogSeqTimeoutError';
  }
}

/** LogSeq rejected the auth token (HTTP 401). The message never includes the token. */
export class LogSeqAuthError extends Error {
  constructor(apiUrl: string) {
    super(
      `LogSeq at ${apiUrl} rejected the auth token (HTTP 401)\n\n` +
        `Steps to fix:\n` +
        `1. The token is invalid or has been changed. Regenerate it in LogSeq's API settings\n` +
        `2. Update "authToken" in the config file\n` +
        `3. See tests/integration/setup.md for details`
    );
    this.name = 'LogSeqAuthError';
  }
}

/** True for failures of the connection to LogSeq itself (not running, timeout, rejected token). */
export function isInfrastructureError(error: unknown): boolean {
  return error instanceof LogSeqNotRunningError || error instanceof LogSeqTimeoutError || error instanceof LogSeqAuthError;
}

/** The config file failed to load. No message includes a value from the file, since any of them could be the token. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** `~/.logseq-mcp/config.json`, the config file unless `LOGSEQ_MCP_CONFIG` names another. */
export function defaultConfigPath(home: string = homedir()): string {
  return join(home, '.logseq-mcp', 'config.json');
}

/**
 * The config file to load, as the server resolves it: `LOGSEQ_MCP_CONFIG` (an absolute path) over the default.
 * The scripts that read the real graph on purpose (the measure scripts) use this; the integration tests and the
 * probe never do (tests/integration/helpers/instance-config.ts).
 */
export function resolveConfigPath(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  const raw = env[CONFIG_PATH_ENV];
  const path = raw?.trim();
  if (path === undefined || path === '') return defaultConfigPath(home);
  if (!isAbsolute(path)) throw new ConfigError(`${CONFIG_PATH_ENV} must be an absolute path (got "${raw}")`);
  return path;
}

/**
 * Load and check a config file.
 * @throws ConfigError if the file is missing, is not JSON or a field is missing or wrong (never quoting the file)
 */
export async function loadConfig(configPath: string): Promise<LogseqMCPConfig> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new ConfigError(`Configuration file not found: ${configPath}`);
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError('Invalid JSON in config file (the parser\'s message is not shown, as it may quote the authToken)');
  }
  const object = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (!object.authToken) throw new ConfigError('Configuration validation failed: authToken is required');
  if (typeof object.authToken !== 'string') throw new ConfigError('Configuration validation failed: authToken must be a string');
  const apiUrl = object.apiUrl || DEFAULT_API_URL;
  if (typeof apiUrl !== 'string') throw new ConfigError('Configuration validation failed: apiUrl must be a string');
  const config: LogseqMCPConfig = { apiUrl, authToken: object.authToken };
  if (object.timeoutMs !== undefined) {
    if (typeof object.timeoutMs !== 'number' || !Number.isFinite(object.timeoutMs) || object.timeoutMs <= 0) {
      throw new ConfigError('Configuration validation failed: timeoutMs must be a positive finite number');
    }
    config.timeoutMs = object.timeoutMs;
  }
  if (object.tips !== undefined) {
    if (typeof object.tips !== 'boolean') throw new ConfigError('Configuration validation failed: tips must be a boolean');
    config.tips = object.tips;
  }
  return config;
}

/** HTTP client for LogSeq's API: authentication, the timeout and the connection errors. */
export class LogseqClient {
  private config: LogseqMCPConfig;

  constructor(config: LogseqMCPConfig) {
    this.config = config;
  }

  /**
   * Call a LogSeq API method (e.g. `logseq.Editor.getBlock`).
   * @typeParam T - What the caller expects the response to be: a claim, not a check
   * @throws LogSeqAuthError for HTTP 401, LogSeqTimeoutError past `timeoutMs`, LogSeqNotRunningError when the
   *   connection fails, and Error for any other failure or an `{error}` answer
   */
  async callAPI<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    const url = `${this.config.apiUrl}/api`;
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, args }),
        // A fresh signal per call: the timeout bounds each request, not a whole run
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (response.status === 401) throw new LogSeqAuthError(this.config.apiUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      // LogSeq returns data directly, not wrapped; an unknown method is HTTP 200 with an `error` key
      const responseData: unknown = await response.json();
      if (responseData && typeof responseData === 'object' && 'error' in responseData) {
        throw new Error(`LogSeq API error: ${responseData.error}`);
      }
      return responseData as T;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
          throw new LogSeqTimeoutError(this.config.apiUrl, timeoutMs);
        }
        const errorCode = (error as { code?: unknown }).code;
        if (
          errorCode === 'ECONNREFUSED' ||
          errorCode === 'ETIMEDOUT' ||
          errorCode === 'ENOTFOUND' ||
          error.message.includes('fetch failed') ||
          error.message.includes('ECONNREFUSED')
        ) {
          throw new LogSeqNotRunningError(this.config.apiUrl, error);
        }
      }
      throw error;
    }
  }

  /**
   * Execute a Datalog query via `logseq.DB.datascriptQuery`. LogSeq reads every input after the query string as
   * EDN, so a bare string would be read as a symbol and match nothing: each input is sent as `JSON.stringify(value)`,
   * a valid EDN literal (CLAUDE.md, constraint 1).
   */
  async executeDatalogQuery<T = unknown>(query: string, ...inputs: unknown[]): Promise<T> {
    return this.callAPI<T>('logseq.DB.datascriptQuery', [query, ...inputs.map(value => JSON.stringify(value))]);
  }
}
