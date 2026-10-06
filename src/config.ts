import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { isAbsolute, join } from 'path';
// zod 4's API, shipped inside the zod 3.25 package, as in src/utils/parse-args.ts.
import { z } from 'zod/v4';
import { LogseqMCPConfig } from './types.js';

/**
 * The config file failed to load. Each subclass is one way it fails, so callers
 * and tests can tell them apart by class instead of by message text. No message
 * ever includes the authToken (ADR-0003).
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** The config file does not exist. */
export class ConfigFileNotFoundError extends ConfigError {
  constructor(readonly configPath: string) {
    super(`Configuration file not found: ${configPath}`);
    this.name = 'ConfigFileNotFoundError';
  }
}

/** The config file is not valid JSON. */
export class ConfigInvalidJsonError extends ConfigError {
  constructor(detail: string) {
    super(`Invalid JSON in config file: ${detail}`);
    this.name = 'ConfigInvalidJsonError';
  }
}

/**
 * A config field (or `LOGSEQ_MCP_TIPS`) has a missing or wrong value. `field`
 * names it; the message says what it must be and never shows a config-file
 * value, since any of them could be the token. The `LOGSEQ_MCP_TIPS` message
 * echoes the variable's value (`(got "disabled")`), which holds no secret; don't
 * copy that for a field that could.
 */
export class ConfigValidationError extends ConfigError {
  constructor(readonly field: string, problem: string) {
    super(`Configuration validation failed: ${field} ${problem}`);
    this.name = 'ConfigValidationError';
  }
}

const DEFAULT_API_URL = 'http://127.0.0.1:12315';

/**
 * What each field must be, as the `<field> <problem>` tail of the
 * ConfigValidationError message. Every issue a field's schema raises carries
 * one of these, so the parse result maps straight to the error.
 */
const PROBLEMS = {
  authTokenRequired: 'is required',
  notAString: 'must be a string',
  timeoutMs: 'must be a positive finite number',
  tips: 'must be a boolean',
} as const;

/**
 * The config file's schema, in two stages so the first issue zod reports is the
 * error the hand-written checks reported before (#63):
 *
 * 1. The file holds an object with a truthy `authToken`. Anything else (no
 *    `authToken`, `""`, `null`, a top-level array or number) is "authToken is
 *    required". This outranks every other problem.
 * 2. Each field in turn: `apiUrl` (falsy means the default), then `authToken`'s
 *    type, then `timeoutMs`, then `tips`. zod reports object issues in shape
 *    order, and `loadConfig` reports the first.
 *
 * Unknown keys are dropped (zod's default strip), so the result holds only these
 * four keys and the optional two only when set (ADR-0005's guard test pins that).
 * Nothing is coerced: `"5000"` is not a timeout and `"false"` is not a boolean.
 */
const configSchema = z
  .custom<Record<string, unknown>>(
    value =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Boolean((value as Record<string, unknown>).authToken),
    { error: PROBLEMS.authTokenRequired, path: ['authToken'] }
  )
  .pipe(
    z.object({
      apiUrl: z
        .unknown()
        .transform(value => value || DEFAULT_API_URL)
        .pipe(z.string({ error: PROBLEMS.notAString })),
      authToken: z.string({ error: PROBLEMS.notAString }),
      // z.number() rejects Infinity (what 1e999 parses to) and NaN.
      timeoutMs: z.number({ error: PROBLEMS.timeoutMs }).positive({ error: PROBLEMS.timeoutMs }).optional(),
      tips: z.boolean({ error: PROBLEMS.tips }).optional(),
    })
  );

// Fails tsc if the schema's output and LogseqMCPConfig drift apart in either
// direction. Mutual assignability alone misses an optional key added to one side
// (`newFlag?: string` on the interface, or `.optional()` in the schema), and zod
// would then strip that field on load without a word. So the key sets must match too.
type ParsedConfig = z.output<typeof configSchema>;
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : never) : never;
const _schemaMatchesType: [ParsedConfig, LogseqMCPConfig] extends [LogseqMCPConfig, ParsedConfig]
  ? SameKeys<ParsedConfig, LogseqMCPConfig>
  : never = true;
void _schemaMatchesType;

/**
 * Load and validate configuration from a JSON file
 * @param configPath - Path to the configuration file
 * @returns Validated configuration object
 * @throws ConfigFileNotFoundError if the file doesn't exist, ConfigInvalidJsonError
 *   if it isn't JSON, ConfigValidationError if a field is missing or wrong. Other
 *   read errors (permissions, a directory) are re-thrown as they are.
 */
export async function loadConfig(configPath: string): Promise<LogseqMCPConfig> {
  let configData: string;
  try {
    configData = await readFile(configPath, 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new ConfigFileNotFoundError(configPath);
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(configData);
  } catch (parseError) {
    throw new ConfigInvalidJsonError(jsonErrorDetail(parseError));
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ConfigValidationError(String(issue.path[0] ?? 'authToken'), issue.message);
  }
  return result.data;
}

/**
 * The parser's reason, for the ConfigInvalidJsonError message. V8 quotes a
 * stretch of the file in some messages (`Unexpected token 'a', ..."thToken":
 * abc123"... is not valid JSON`), and that stretch can be the authToken. A
 * message with a double quote in it is quoting the file, so it is replaced
 * with one that names the usual causes instead (those messages carry no
 * position to point at); the rest (`Unterminated string in JSON at position 18
 * (line 1 column 19)`) are kept word for word.
 */
export const REDACTED_JSON_DETAIL =
  "the file is not valid JSON (an unquoted value, a trailing comma or a byte-order mark?); the parser's message is not shown, as it may quote the authToken";

function jsonErrorDetail(parseError: unknown): string {
  if (!(parseError instanceof Error)) return 'Unknown error';
  if (parseError.message.includes('"')) return REDACTED_JSON_DETAIL;
  return parseError.message;
}

/** Environment variable naming another config file (#118), e.g. a per-worktree test instance's. */
export const CONFIG_PATH_ENV = 'LOGSEQ_MCP_CONFIG';

/** `~/.logseq-mcp/config.json`, the config file unless `LOGSEQ_MCP_CONFIG` names another. */
export function defaultConfigPath(home: string = homedir()): string {
  return join(home, '.logseq-mcp', 'config.json');
}

/**
 * The config file to load. `LOGSEQ_MCP_CONFIG` overrides the default path, as `LOGSEQ_MCP_TIPS`
 * overrides the file's `tips`; `scripts/logseq-instance.ts` prints the value that points at its
 * instance. It must be an absolute path: the MCP server's working directory is whatever the
 * client chose, so a relative one would not name the same file everywhere. An empty or blank
 * variable is ignored. The ConfigValidationError message echoes the value, a path with no secret.
 */
export function resolveConfigPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): string {
  const raw = env[CONFIG_PATH_ENV];
  const path = raw?.trim();
  if (path === undefined || path === '') return defaultConfigPath(home);
  if (!isAbsolute(path)) {
    throw new ConfigValidationError(CONFIG_PATH_ENV, `must be an absolute path (got "${raw}")`);
  }
  return path;
}

const TIPS_OFF_VALUES = ['0', 'false', 'off', 'no'];
const TIPS_ON_VALUES = ['1', 'true', 'on', 'yes'];

/**
 * Whether next-step tips (#44) are on. They are on by default; `"tips": false` in
 * the config file turns them off. `LOGSEQ_MCP_TIPS` overrides the file: `off`,
 * `false`, `0` or `no` turn tips off, `on`, `true`, `1` or `yes` turn them on
 * (case-insensitive, surrounding spaces ignored). An empty variable is ignored.
 * Any other value throws ConfigValidationError, so a typo such as `disabled`
 * can't leave tips on silently.
 */
export function resolveTipsEnabled(
  config: Pick<LogseqMCPConfig, 'tips'>,
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env.LOGSEQ_MCP_TIPS;
  const flag = raw?.trim().toLowerCase();
  if (flag !== undefined && flag !== '') {
    if (TIPS_OFF_VALUES.includes(flag)) return false;
    if (TIPS_ON_VALUES.includes(flag)) return true;
    throw new ConfigValidationError(
      'LOGSEQ_MCP_TIPS',
      `must be one of ${[...TIPS_ON_VALUES, ...TIPS_OFF_VALUES].join(', ')} (got "${raw}")`
    );
  }
  return config.tips !== false;
}
