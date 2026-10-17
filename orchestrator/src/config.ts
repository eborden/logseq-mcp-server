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

// The choices of `claude --permission-mode` in CLI 2.1.302 (`claude --help`). A value outside this set makes every
// session exit non-zero, so the set is closed here and re-checked against the CLI help when the CLI is upgraded.
export type PermissionMode = 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';

/** Who answers a permission prompt in `claude -p`: `host` is the CLI's own default (nobody, here), `none` denies at once. */
export type PermissionPrompts = 'host' | 'none';

export interface ClaudeConfig {
  /** The `claude` executable: a bare name looked up on PATH, or an absolute path. Tests point it at a fake. */
  readonly claudeBin: string;
  /** Passed as `--permission-mode`. Absent means no flag at all, so the CLI's own default applies. */
  readonly permissionMode: PermissionMode | undefined;
  /** Passed as `--permission-prompts`. Absent means no flag at all. */
  readonly permissionPrompts: PermissionPrompts | undefined;
  /** Passed as one `--allowedTools=<comma list>` argument. Empty means no flag at all. */
  readonly allowedTools: readonly string[];
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
const PERMISSION_MODES: readonly PermissionMode[] = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
/** `bypassPermissions` lets an unattended session do anything the OS user can. It needs this second variable too. */
export const BYPASS_OPT_IN_VARIABLE = 'ORCHESTRATOR_ALLOW_BYPASS_PERMISSIONS';
export const BYPASS_OPT_IN_VALUE = 'yes-skip-all-permission-checks';

/**
 * The permission configuration of an unattended implementer session (#629). Without a person to answer, a prompt in
 * `claude -p` can stall until the 30 minute session timeout, so the default is `acceptEdits` (file edits go through),
 * `--permission-prompts none` (anything else that would prompt is denied at once, never waited on) and an explicit
 * allowed-tools list. Not `bypassPermissions`. README, "Permission modes", has the reasoning and what is unverified.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'acceptEdits';
export const DEFAULT_PERMISSION_PROMPTS: PermissionPrompts = 'none';
export const DEFAULT_ALLOWED_TOOLS: readonly string[] = [
  // Reading and editing the worktree.
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  // Version control, by verb. A push goes only to a `claude/` branch: the implementer never writes to another ref.
  'Bash(git status)',
  'Bash(git status *)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git show *)',
  'Bash(git add *)',
  'Bash(git commit *)',
  'Bash(git fetch *)',
  'Bash(git rebase *)',
  'Bash(git rev-parse *)',
  'Bash(git push -u origin claude/*)',
  'Bash(git push origin claude/*)',
  'Bash(git push --force-with-lease origin claude/*)',
  // The repo's own test and check commands (CLAUDE.md "Verification before merge").
  'Bash(cargo *)',
  'Bash(npm *)',
  'Bash(npx *)',
  'Bash(node *)',
  'Bash(shellcheck *)',
  // The issue and its PR, read, and the issue's status comment. No `gh api`, no `gh pr create`, no merge.
  'Bash(gh issue view *)',
  'Bash(gh issue comment *)',
  'Bash(gh pr view *)',
  'Bash(ls *)',
];

const PERMISSION_PROMPTS: readonly PermissionPrompts[] = ['host', 'none'];
// One tool rule: a tool name, optionally with a parenthesised pattern. No comma inside, because the list is joined with commas.
const TOOL_RULE = /^[A-Za-z][A-Za-z0-9_]{0,63}(\([^,\0\r\n()]{1,200}\))?$/;
const MAX_ALLOWED_TOOLS = 100;

function parseAllowedTools(raw: string | undefined): readonly string[] {
  if (raw === undefined) {
    return DEFAULT_ALLOWED_TOOLS;
  }
  const rules = raw.split(',').map((rule) => rule.trim());
  if (rules.length > MAX_ALLOWED_TOOLS || rules.some((rule) => !TOOL_RULE.test(rule))) {
    throw new ConfigError(
      `CLAUDE_ALLOWED_TOOLS must be a comma-separated list of at most ${MAX_ALLOWED_TOOLS} tool rules such as "Edit" or "Bash(git status *)"`,
    );
  }
  return rules;
}

export function loadClaudeConfig(env: Env): ClaudeConfig {
  const claudeBin = blankAsAbsent(env['CLAUDE_BIN']) ?? 'claude';
  if (!CLAUDE_BIN.test(claudeBin)) {
    throw new ConfigError('CLAUDE_BIN must be a command name or an absolute path');
  }
  const rawMode = blankAsAbsent(env['CLAUDE_PERMISSION_MODE']);
  const permissionMode = rawMode === undefined ? DEFAULT_PERMISSION_MODE : PERMISSION_MODES.find((mode) => mode === rawMode);
  if (permissionMode === undefined) {
    throw new ConfigError(`CLAUDE_PERMISSION_MODE must be one of ${PERMISSION_MODES.join(', ')}`);
  }
  if (permissionMode === 'bypassPermissions' && blankAsAbsent(env[BYPASS_OPT_IN_VARIABLE]) !== BYPASS_OPT_IN_VALUE) {
    throw new ConfigError(
      `CLAUDE_PERMISSION_MODE=bypassPermissions skips every permission check; it also needs ${BYPASS_OPT_IN_VARIABLE}=${BYPASS_OPT_IN_VALUE}`,
    );
  }
  const rawPrompts = blankAsAbsent(env['CLAUDE_PERMISSION_PROMPTS']);
  const permissionPrompts = rawPrompts === undefined ? DEFAULT_PERMISSION_PROMPTS : PERMISSION_PROMPTS.find((target) => target === rawPrompts);
  if (permissionPrompts === undefined) {
    throw new ConfigError(`CLAUDE_PERMISSION_PROMPTS must be one of ${PERMISSION_PROMPTS.join(', ')}`);
  }
  return { claudeBin, permissionMode, permissionPrompts, allowedTools: parseAllowedTools(blankAsAbsent(env['CLAUDE_ALLOWED_TOOLS'])) };
}

export function loadServerConfig(env: Env): ServerConfig {
  const rawPort = blankAsAbsent(env['TEMPORAL_PORT']);
  return {
    port: rawPort === undefined ? DEFAULT_PORT : parsePort('TEMPORAL_PORT', rawPort),
    dbFilename: blankAsAbsent(env['TEMPORAL_DB_FILE']) ?? DEFAULT_DB_FILENAME,
    cliPath: blankAsAbsent(env['TEMPORAL_CLI_PATH']),
  };
}
