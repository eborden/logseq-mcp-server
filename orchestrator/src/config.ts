// Configuration, read from the environment once at startup and parsed into typed values (foundations 4.2).
// Nothing else in the orchestrator reads process.env. A bad value fails fast with a message that names the
// variable and never echoes a secret (there are none in v1).

export interface Config {
  /** host:port of the Temporal frontend. */
  readonly address: string;
  readonly namespace: string;
  readonly taskQueue: string;
}

export interface ServerConfig {
  readonly port: number;
  /** SQLite file the dev server persists to. Its directory is gitignored. */
  readonly dbFilename: string;
  /** Path to an installed `temporal` CLI. When absent the SDK downloads and caches one. */
  readonly cliPath: string | undefined;
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface ClaudeConfig {
  /** The `claude` executable: a bare name looked up on PATH, or an absolute path. Tests point it at a fake. */
  readonly claudeBin: string;
  /** Passed as `--permission-mode`. Absent leaves the CLI's own default. */
  readonly permissionMode: PermissionMode | undefined;
}

export type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_PORT = 7233;
export const DEFAULT_TASK_QUEUE = 'orchestrator';
export const DEFAULT_DB_FILENAME = '.temporal/dev.sqlite';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const HOST_PORT = /^[A-Za-z0-9.-]+:(\d{1,5})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

function parsePort(name: string, raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${name} must be a whole number from 1 to 65535`);
  }
  return port;
}

function blankAsAbsent(raw: string | undefined): string | undefined {
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

export function loadConfig(env: Env): Config {
  const address = blankAsAbsent(env['TEMPORAL_ADDRESS']) ?? `127.0.0.1:${DEFAULT_PORT}`;
  const match = HOST_PORT.exec(address);
  if (match === null) {
    throw new ConfigError('TEMPORAL_ADDRESS must look like host:port');
  }
  parsePort('TEMPORAL_ADDRESS port', match[1] ?? '');

  const namespace = blankAsAbsent(env['TEMPORAL_NAMESPACE']) ?? 'default';
  if (!NAME.test(namespace)) {
    throw new ConfigError('TEMPORAL_NAMESPACE must be 1 to 100 letters, digits, dots, dashes or underscores');
  }

  const taskQueue = blankAsAbsent(env['TASK_QUEUE']) ?? DEFAULT_TASK_QUEUE;
  if (!NAME.test(taskQueue)) {
    throw new ConfigError('TASK_QUEUE must be 1 to 100 letters, digits, dots, dashes or underscores');
  }

  return { address, namespace, taskQueue };
}

const CLAUDE_BIN = /^(\/[^\0]{1,1023}|[A-Za-z0-9._-]{1,100})$/;
const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export function loadClaudeConfig(env: Env): ClaudeConfig {
  const claudeBin = blankAsAbsent(env['CLAUDE_BIN']) ?? 'claude';
  if (!CLAUDE_BIN.test(claudeBin)) {
    throw new ConfigError('CLAUDE_BIN must be a command name or an absolute path');
  }
  const rawMode = blankAsAbsent(env['CLAUDE_PERMISSION_MODE']);
  const permissionMode = rawMode === undefined ? undefined : PERMISSION_MODES.find((mode) => mode === rawMode);
  if (rawMode !== undefined && permissionMode === undefined) {
    throw new ConfigError(`CLAUDE_PERMISSION_MODE must be one of ${PERMISSION_MODES.join(', ')}`);
  }
  return { claudeBin, permissionMode };
}

export function loadServerConfig(env: Env): ServerConfig {
  const rawPort = blankAsAbsent(env['TEMPORAL_PORT']);
  return {
    port: rawPort === undefined ? DEFAULT_PORT : parsePort('TEMPORAL_PORT', rawPort),
    dbFilename: blankAsAbsent(env['TEMPORAL_DB_FILE']) ?? DEFAULT_DB_FILENAME,
    cliPath: blankAsAbsent(env['TEMPORAL_CLI_PATH']),
  };
}
