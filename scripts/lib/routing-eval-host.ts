// How scripts/routing-eval.ts sets up its sessions (#487): the options and their bounds, the `claude` arguments and
// environment that keep the model to this server's tools, and the temp files. Kept apart from the runner so
// tests/guards/routing-eval.test.ts can pin the bounds and the isolation without a model or an instance.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { MCP_TOOL_PREFIX, type Surface } from './routing-eval.js';

/** The model of every session unless `--model` says otherwise: a pinned id, so v1 and v2 runs compare on one model (ADR-0024). */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

/** The most each option accepts. A run is questions x runs sessions, so these bound its calls (foundations 4.6). */
export const LIMITS = {
  runs: 20,
  concurrency: 4,
  timeoutMs: 900_000,
  maxCalls: 30,
  maxBudgetUsd: 2,
  maxTotalUsd: 25,
} as const;

export interface Options {
  runs: number;
  model: string;
  only: string[];
  out: string | undefined;
  questions: string | undefined;
  concurrency: number;
  timeoutMs: number;
  maxCalls: number;
  /** Per session, passed to `claude` */
  maxBudgetUsd: number;
  /** The whole run: no new session starts once the finished ones have cost this much */
  maxTotalUsd: number;
  surface: Surface | undefined;
  binary: string | undefined;
  /** A directory holding a SKILL.md whose body is added to the session's system prompt (#497) */
  skill: string | undefined;
  dryRun: boolean;
  rescore: string | undefined;
  help: boolean;
}

export const USAGE = `Usage: npx tsx scripts/routing-eval.ts [options]
  --runs <n>             sessions per question (default 3, at most ${LIMITS.runs})
  --model <id>           the model of every session (default ${DEFAULT_MODEL}, pinned so runs compare)
  --only <list>          comma-separated question ids or types (get, find, explore, check)
  --out <file>           save each session's calls and arguments as JSON, for --rescore. Local only: a path in the repo must be gitignored
  --questions <file>     another question file (default tests/fixtures/routing-eval/questions.json)
  --concurrency <n>      sessions at a time (default 2, at most ${LIMITS.concurrency})
  --timeout-ms <ms>      per session (default 120000)
  --max-calls <n>        stop a session after n logseq calls (default 6, at most ${LIMITS.maxCalls})
  --max-budget-usd <x>   per session, passed to claude (default 0.15, at most ${LIMITS.maxBudgetUsd})
  --max-total-usd <x>    the whole run: no new session starts once the finished ones cost this much, and the run exits 1 (default 3, at most ${LIMITS.maxTotalUsd})
  --surface v1|v2        which acceptable-tool list to score against (default: read from the server's tool list)
  --binary <path>        the server binary (default: LOGSEQ_MCP_RUST_BIN, else rust/target/debug/logseq-mcp-server)
  --skill <dir>          add the body of <dir>/SKILL.md to every session's system prompt, to measure a skill against the run without it (#497)
  --rescore <file>       print the aggregates of an earlier --out file against the current questions; calls no model
  --dry-run              check the question file and print the plan; start nothing`;

function whole(flag: string, value: string | undefined, max: number): number {
  const parsed = Number(value);
  if (value === undefined || value.trim() === '' || !Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${flag} must be a whole number from 1 to ${max} (got ${JSON.stringify(value)})`);
  }
  return parsed;
}

function dollars(flag: string, value: string | undefined, max: number): number {
  const parsed = Number(value);
  if (value === undefined || value.trim() === '' || !Number.isFinite(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${flag} must be a number above 0 and at most ${max} (got ${JSON.stringify(value)})`);
  }
  return parsed;
}

export function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    runs: 3,
    model: DEFAULT_MODEL,
    only: [],
    out: undefined,
    questions: undefined,
    concurrency: 2,
    timeoutMs: 120_000,
    maxCalls: 6,
    maxBudgetUsd: 0.15,
    maxTotalUsd: 3,
    surface: undefined,
    binary: undefined,
    skill: undefined,
    dryRun: false,
    rescore: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value\n${USAGE}`);
      return next;
    };
    switch (flag) {
      case '--runs':
        options.runs = whole(flag, value(), LIMITS.runs);
        break;
      case '--model':
        options.model = value();
        break;
      case '--only':
        options.only = value().split(',').map(part => part.trim()).filter(Boolean);
        break;
      case '--out':
        options.out = value();
        break;
      case '--questions':
        options.questions = value();
        break;
      case '--concurrency':
        options.concurrency = whole(flag, value(), LIMITS.concurrency);
        break;
      case '--timeout-ms':
        options.timeoutMs = whole(flag, value(), LIMITS.timeoutMs);
        break;
      case '--max-calls':
        options.maxCalls = whole(flag, value(), LIMITS.maxCalls);
        break;
      case '--max-budget-usd':
        options.maxBudgetUsd = dollars(flag, value(), LIMITS.maxBudgetUsd);
        break;
      case '--max-total-usd':
        options.maxTotalUsd = dollars(flag, value(), LIMITS.maxTotalUsd);
        break;
      case '--surface': {
        const surface = value();
        if (surface !== 'v1' && surface !== 'v2') throw new Error('--surface must be v1 or v2');
        options.surface = surface;
        break;
      }
      case '--binary':
        options.binary = value();
        break;
      case '--skill':
        options.skill = value();
        break;
      case '--rescore':
        options.rescore = value();
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option ${flag}\n${USAGE}`);
    }
  }
  return options;
}

/**
 * The arguments of one headless session. They are what makes the claim "the model sees only this server": no
 * built-in tool, no other MCP server, no skill, no user, project or local settings, no saved session, and a
 * permission mode that denies anything outside the one allowed server.
 */
export function claudeArgs(options: Pick<Options, 'model' | 'maxBudgetUsd'>, mcpConfigPath: string, skillText?: string): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', options.model,
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--tools', '',
    '--disable-slash-commands',
    '--setting-sources', '',
    '--no-session-persistence',
    '--allowedTools', MCP_TOOL_PREFIX.replace(/__$/, ''),
    '--permission-mode', 'dontAsk',
    '--max-budget-usd', String(options.maxBudgetUsd),
  ];
  // The skill is not run as a skill (the host has no built-in tool and no slash command): its body is what the model
  // would read once the skill loaded, so it goes in as system prompt text
  if (skillText !== undefined) args.push('--append-system-prompt', skillText);
  return args;
}

/**
 * The body of `<dir>/SKILL.md` without its front matter, which is what a host shows the model once the skill has loaded.
 * @throws Error when the file is missing or has no body
 */
export async function loadSkillText(dir: string): Promise<string> {
  const path = join(dir, 'SKILL.md');
  const raw = await readFile(path, 'utf8').catch(() => {
    throw new Error(`--skill ${dir} has no readable SKILL.md`);
  });
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  if (body === '') throw new Error(`${path} has no body after its front matter`);
  return body;
}

/** The model host's environment: the caller's, without the server settings, and with CLAUDE.md files and auto-memory off. */
export function hostEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  delete env.LOGSEQ_MCP_CONFIG;
  delete env.LOGSEQ_MCP_TIPS;
  delete env.LOGSEQ_MCP_NOW;
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return env;
}

export interface Harness {
  dir: string;
  mcpConfigPath: string;
  serverConfigPath: string;
  /** The host runs here: an empty directory, so no project file reaches the model */
  cwd: string;
}

/**
 * The temp files of a run. The server gets a config of its own, which holds the fixture instance's token (random per
 * `start`), in a 0600 file the caller deletes, and a home directory of its own, so it has no `~/.logseq-mcp/config.json`
 * to fall back on (BR-0001).
 */
export async function prepareHarness(
  config: { apiUrl: string; authToken: string },
  binary: string,
  parent: string = tmpdir(),
  platform: NodeJS.Platform = process.platform
): Promise<Harness> {
  const dir = await mkdtemp(join(parent, 'logseq-routing-eval-'));
  const home = join(dir, 'server-home');
  const cwd = join(dir, 'cwd');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const serverConfigPath = join(dir, 'server-config.json');
  await writeFile(serverConfigPath, JSON.stringify({ apiUrl: config.apiUrl, authToken: config.authToken }), { mode: 0o600 });
  const serverEnv: Record<string, string> = {
    LOGSEQ_MCP_CONFIG: serverConfigPath,
    LOGSEQ_MCP_TIPS: 'on',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
  };
  if (platform === 'darwin') serverEnv.CFFIXED_USER_HOME = home;
  const mcpConfigPath = join(dir, 'mcp.json');
  await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { logseq: { command: binary, args: [], env: serverEnv } } }), { mode: 0o600 });
  return { dir, mcpConfigPath, serverConfigPath, cwd };
}

/**
 * `--out` holds the arguments the model sent, so a path inside the checkout must be one git ignores: a stray
 * `--out routing.json` would otherwise be one `git add` from a commit (BR-0001).
 * @throws Error naming the path and the way out
 */
export function assertOutPathSafe(path: string, repoRoot: string, isIgnored: (absolute: string) => boolean): void {
  const absolute = resolve(path);
  const inside = relative(repoRoot, absolute);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return;
  if (!isIgnored(absolute)) {
    throw new Error(
      `--out ${path} is inside the repo and git does not ignore it. The file holds what the model sent: write it under ` +
        '.logseq-instance/ or name it routing-eval-*.json (both are gitignored), or outside the checkout.'
    );
  }
}
