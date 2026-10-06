/**
 * Per-worktree LogSeq instances (#118): the logic behind `scripts/logseq-instance.ts`.
 *
 * An instance is a second LogSeq app process with its own Chromium profile, its own home
 * directory, its own API port and its own random API token, serving one graph. Every worktree gets its
 * own, under `<worktree>/.logseq-instance/` (gitignored), so agents in separate worktrees can run
 * the integration tests against their own copy of the fixture graph at the same time, next to
 * the LogSeq the maintainer uses.
 *
 * The instance opens a copy of the graph, `.logseq-instance/graph/`, made fresh on every start
 * (#151). LogSeq writes to the graph it opens (it rewrites `logseq/config.edn`, adds
 * `logseq/bak/`, today's journal and `pages/contents.md`), and the copy keeps all of that out of
 * the committed `tests/fixtures/graph`.
 *
 * Everything that touches the file system, processes or the network goes through
 * `InstanceDeps`, so the unit tests (`src/logseq-instance.test.ts`) run on fakes.
 *
 * Safety rules this module keeps:
 * - It only writes and deletes inside `<worktree>/.logseq-instance/`. The source graph is only
 *   read: checked for the sentinel, listed and copied.
 * - It launches LogSeq only with `--user-data-dir` pointing at the profile it created there.
 * - It stops only the pid it recorded, and only while that pid's command line still names this
 *   instance's profile. Never `quit app "Logseq"`, `pkill` or `killall`.
 */
import { join, sep } from 'path';
import { createHash } from 'crypto';
import { z } from 'zod/v4';
import type { LogseqMCPConfig } from '../../src/types.js';
import { LogSeqAuthError } from '../../src/errors.js';
import { levelDbFiles, localStorageEntries, logseqGraphId, logseqSeedItems } from './local-storage.js';

/** Ports an instance may use. The maintainer's LogSeq keeps the default, 12315. */
export const PORT_FIRST = 12320;
export const PORT_LAST = 12399;

/**
 * Bytes of randomness in each instance's API token. A new token is generated on every `start`
 * and written only to gitignored files, never committed (ADR-0003). It must be secret even
 * though the graph is made up: LogSeq's API answers CORS `*` and can run git commands, write
 * files and open links, so a web page in a browser could scan the port range and drive any
 * instance whose token it knows.
 */
export const TOKEN_BYTES = 32;

/** A fresh API token: TOKEN_BYTES random bytes, base64url (letters, digits, `-` and `_`). */
export function newInstanceToken(randomBytes: (size: number) => Uint8Array): string {
  const bytes = randomBytes(TOKEN_BYTES);
  if (bytes.length !== TOKEN_BYTES) throw new InstanceError('the random source returned too few bytes');
  return Buffer.from(bytes).toString('base64url');
}

/** Files that hold the token are readable by their owner only. */
export const PRIVATE_FILE_MODE = 0o600;

/** The macOS app bundle launched unless `LOGSEQ_APP` names another. */
export const DEFAULT_APP_BUNDLE = '/Applications/Logseq.app';

/** How long `start` waits for the API and the graph, and how often it asks. */
export const READY_TIMEOUT_MS = 90_000;
export const READY_POLL_MS = 500;

/** How long `stop` waits after SIGTERM before SIGKILL, and after SIGKILL before giving up. */
export const STOP_GRACE_MS = 10_000;
export const KILL_GRACE_MS = 5_000;

/** Most graph files `start` lists to check the index; the fixture has a few dozen. */
export const MAX_GRAPH_FILES = 5_000;

/**
 * Paths under the source graph, relative to it, that `start` leaves out of the copy: LogSeq's
 * backups from an earlier time the folder was opened as a graph. Each entry also covers
 * everything below it.
 */
export const GRAPH_COPY_EXCLUDES = ['logseq/bak'] as const;

/** Whether `relPath` (relative to the source graph, `/`-separated) stays out of the copy. */
export function excludedFromCopy(relPath: string): boolean {
  return GRAPH_COPY_EXCLUDES.some(excluded => relPath === excluded || relPath.startsWith(`${excluded}/`));
}

/** Raised for every expected failure, with a message that says what to do. */
export class InstanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstanceError';
  }
}

/**
 * Another LogSeq answers on the port we chose: it bound the port between our free-port check and
 * our launch (two worktrees whose ports collide, starting at once). `start` retries once.
 */
export class PortTakenError extends InstanceError {
  constructor(readonly port: number, why: string) {
    super(`port ${port} ${why}, so another LogSeq holds it. Run stop, then start again.`);
    this.name = 'PortTakenError';
  }
}

/** Launches `start` makes before giving up when another LogSeq takes the port each time. */
export const START_ATTEMPTS = 2;

/** Where an instance keeps its files, all under `<worktree>/.logseq-instance/`. */
export interface InstancePaths {
  dir: string;
  /** Chromium profile, passed as `--user-data-dir`. Holds configs.edn and localStorage. */
  profile: string;
  /** HOME for the instance, so LogSeq's `~/.logseq` (global config, plugins, graph cache) is its own. */
  home: string;
  /** The copy of the source graph that LogSeq opens, replaced on every start (#151). */
  graph: string;
  /** What `start` recorded about the running instance. */
  record: string;
  /** A config file for the MCP server and the tests: point `LOGSEQ_MCP_CONFIG` at it. */
  config: string;
  /** The app's stdout and stderr. */
  log: string;
}

export function instancePaths(worktree: string): InstancePaths {
  const dir = join(worktree, '.logseq-instance');
  return {
    dir,
    profile: join(dir, 'profile'),
    home: join(dir, 'home'),
    graph: join(dir, 'graph'),
    record: join(dir, 'instance.json'),
    config: join(dir, 'config.json'),
    log: join(dir, 'logseq.log'),
  };
}

/** This worktree's preferred port: a hash of its path into PORT_FIRST..PORT_LAST. */
export function derivePort(worktree: string): number {
  const digest = createHash('sha256').update(worktree).digest();
  return PORT_FIRST + (digest.readUInt32BE(0) % (PORT_LAST - PORT_FIRST + 1));
}

/** Ports to try in order: the derived one, then the rest of the range, wrapping around. */
export function candidatePorts(worktree: string): number[] {
  const size = PORT_LAST - PORT_FIRST + 1;
  const start = derivePort(worktree) - PORT_FIRST;
  return Array.from({ length: size }, (_, i) => PORT_FIRST + ((start + i) % size));
}

/** configs.edn from the committed template, with the port and token filled in. */
export function renderConfigsEdn(template: string, port: number, token: string): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InstanceError(`not a port: ${port}`);
  }
  // The token goes inside an EDN string; refuse anything that would need escaping.
  if (!/^[A-Za-z0-9._-]+$/.test(token)) throw new InstanceError('the instance token must be plain ASCII');
  for (const placeholder of ['{{port}}', '{{token}}']) {
    if (!template.includes(placeholder)) {
      throw new InstanceError(`configs.edn template is missing ${placeholder}`);
    }
  }
  const rendered = template.replaceAll('{{port}}', String(port)).replaceAll('{{token}}', token);
  const leftover = rendered.match(/\{\{[^}]*\}\}/);
  if (leftover) throw new InstanceError(`configs.edn template has an unknown placeholder ${leftover[0]}`);
  return rendered;
}

/** The MCP config file for an instance on `port`. */
export function instanceConfig(port: number, token: string): LogseqMCPConfig {
  return { apiUrl: `http://127.0.0.1:${port}`, authToken: token };
}

/**
 * The file name LogSeq gives a graph's cache in `~/.logseq/graphs` (`electron.handler`,
 * `sanitize-graph-name`). LogSeq lists graphs from these files at startup, and without one it
 * switches the window to the demo graph whatever `current-repo` says. An empty file is enough:
 * LogSeq treats it as an invalid cache, starts from an empty database and parses the files.
 */
export function graphCacheFileName(graphDir: string): string {
  return `${logseqGraphId(graphDir).replaceAll('/', '++').replaceAll(':', '+3A+')}.transit`;
}

const instanceRecordSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(PORT_FIRST).max(PORT_LAST),
  apiUrl: z.string(),
  /** The graph LogSeq has open: the copy in `.logseq-instance/graph`. */
  graphDir: z.string(),
  /**
   * The folder the copy was made from. Optional so that `stop` and `status` still read a record
   * written before the copy existed (#151), when `graphDir` was the source itself.
   */
  sourceGraphDir: z.string().optional(),
  profileDir: z.string(),
  configPath: z.string(),
  logPath: z.string(),
  startedAt: z.string(),
});

/** What `start` writes to `instance.json`. */
export type InstanceRecord = z.output<typeof instanceRecordSchema>;

/** Parse `instance.json`. Throws InstanceError naming the file when it is not a record. */
export function parseInstanceRecord(text: string, path: string): InstanceRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new InstanceError(`${path} is not valid JSON. Delete it if no instance is running.`);
  }
  const result = instanceRecordSchema.safeParse(raw);
  if (!result.success) {
    const field = String(result.error.issues[0]?.path[0] ?? 'record');
    throw new InstanceError(`${path} is not an instance record (bad ${field}). Delete it if no instance is running.`);
  }
  return result.data;
}

/**
 * Whether a process's command line is this instance's LogSeq: it passes our profile as
 * `--user-data-dir`. Guards `stop` against a pid the system has since given to another process.
 */
export function isInstanceProcess(commandLine: string | undefined, profileDir: string): boolean {
  if (!commandLine) return false;
  const flag = `--user-data-dir=${profileDir}`;
  const at = commandLine.indexOf(flag);
  if (at < 0) return false;
  const next = commandLine[at + flag.length];
  return next === undefined || next === ' ' || next === '\n';
}

/** How to launch the app. */
export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

/**
 * The parent's environment variables the app gets, by name: what a GUI app launched from the
 * Dock would have, and nothing else. An allow-list keeps the isolation true by construction:
 * NODE_OPTIONS, ELECTRON_* (ELECTRON_RUN_AS_NODE would start the app as plain Node), XDG_* and
 * LOGSEQ_MCP_CONFIG never reach the instance. `LC_*` is passed by prefix.
 */
export const PASSED_ENV = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', '__CF_USER_TEXT_ENCODING'] as const;

/**
 * Launch the app's executable directly rather than through `open -n -a Logseq`, so the pid we
 * get is the app's own (which `stop` needs) and the environment reaches it.
 *
 * HOME and CFFIXED_USER_HOME both point at the instance's home: LogSeq finds `~/.logseq` through
 * Node's `os.homedir()` (which reads HOME) and through Electron's `app.getPath("home")` (which
 * on macOS ignores HOME and honours CFFIXED_USER_HOME). With only HOME set, the instance shared
 * the maintainer's global config, preferences and plugins. Everything else comes from
 * PASSED_ENV.
 */
export function launchSpec(appBundle: string, paths: InstancePaths, env: Record<string, string | undefined>): LaunchSpec {
  const passed = Object.entries(env).filter(
    ([name, value]) => value !== undefined && ((PASSED_ENV as readonly string[]).includes(name) || name.startsWith('LC_')),
  );
  return {
    command: join(appBundle, 'Contents', 'MacOS', 'Logseq'),
    args: [`--user-data-dir=${paths.profile}`],
    env: { ...Object.fromEntries(passed), HOME: paths.home, CFFIXED_USER_HOME: paths.home },
  };
}

/** Graph files (relative paths, as LogSeq's `:file/path` stores them) not yet in the index. */
export function missingFiles(expected: readonly string[], indexed: readonly string[]): string[] {
  const have = new Set(indexed);
  return expected.filter(path => !have.has(path));
}

/** A connection to an instance's API, as `start` and `status` need it. */
export interface InstanceProbe {
  /** `logseq.App.getCurrentGraph`'s `path`, or undefined when no graph is open. */
  currentGraphPath(): Promise<string | undefined>;
  /** `requireFixtureGraph`: the fixture version, or a FixtureGraphError. */
  requireFixture(): Promise<number>;
  /** Every `:file/path` in the graph's database. */
  indexedFiles(): Promise<string[]>;
}

/** Side effects, injected so the tests can fake them. */
export interface InstanceDeps {
  platform: string;
  env: Record<string, string | undefined>;
  readFile(path: string): Promise<string | undefined>;
  /** `mode` applies when the file is created; callers remove a file first to be sure of it. */
  writeFile(path: string, data: string | Uint8Array, mode?: number): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Recursive, and fine when the path is missing. */
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Canonical absolute path, or undefined when it does not exist or is not a directory. */
  realDir(path: string): Promise<string | undefined>;
  /** Names of the entries in a directory, or [] when it is missing. */
  listDir(path: string): Promise<string[]>;
  /**
   * Copy the directory `from` to `to` (which does not exist yet), recursively, leaving out every
   * entry whose path relative to `from` is `excludedFromCopy`. Symbolic links are copied as the
   * files they point at, so nothing in the copy leads back into `from`.
   */
  copyDir(from: string, to: string): Promise<void>;
  isPortFree(port: number): Promise<boolean>;
  /** Start the process detached, its output written to `logPath` (replacing the last run's). Returns its pid. */
  spawnDetached(spec: LaunchSpec, logPath: string): Promise<number>;
  isAlive(pid: number): boolean;
  commandLine(pid: number): string | undefined;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  connect(config: LogseqMCPConfig): InstanceProbe;
  /** Cryptographically secure random bytes (`crypto.randomBytes`). */
  randomBytes(size: number): Uint8Array;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log(line: string): void;
}

export interface StartOptions {
  worktree: string;
  graphDir: string;
  template: string;
  sentinelFile: string;
  readyTimeoutMs?: number;
}

/** Read the record, or undefined when there is none. */
export async function readRecord(paths: InstancePaths, deps: InstanceDeps): Promise<InstanceRecord | undefined> {
  const text = await deps.readFile(paths.record);
  return text === undefined ? undefined : parseInstanceRecord(text, paths.record);
}

/** The recorded pid, when it is alive and still this instance's LogSeq. */
function liveInstancePid(record: InstanceRecord, deps: InstanceDeps): number | undefined {
  return deps.isAlive(record.pid) && isInstanceProcess(deps.commandLine(record.pid), record.profileDir)
    ? record.pid
    : undefined;
}

function assertInside(dir: string, path: string): void {
  if (!path.startsWith(dir + sep)) throw new InstanceError(`refusing to touch ${path}: it is outside ${dir}`);
}

/** Whether `path` is `dir` or below it. */
function within(dir: string, path: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

/**
 * Replace the copy with a fresh one of `sourceGraphDir`, and return the copy's canonical path
 * (what LogSeq reports as the open graph). The previous copy, with whatever LogSeq wrote to it,
 * is deleted first.
 */
async function copyGraph(paths: InstancePaths, sourceGraphDir: string, deps: InstanceDeps): Promise<string> {
  assertInside(paths.dir, paths.graph);
  await deps.remove(paths.graph);
  await deps.copyDir(sourceGraphDir, paths.graph);
  const copy = await deps.realDir(paths.graph);
  if (!copy) throw new InstanceError(`copying ${sourceGraphDir} to ${paths.graph} left no directory there`);
  return copy;
}

async function choosePort(worktree: string, lost: ReadonlySet<number>, deps: InstanceDeps): Promise<number> {
  for (const port of candidatePorts(worktree)) {
    if (!lost.has(port) && (await deps.isPortFree(port))) return port;
  }
  throw new InstanceError(`no free port in ${PORT_FIRST}-${PORT_LAST}. Stop an instance you no longer need.`);
}

/** Relative paths of the Markdown files LogSeq will index from `pages/` and `journals/`. */
async function graphFiles(graphDir: string, deps: InstanceDeps): Promise<string[]> {
  const files: string[] = [];
  for (const dir of ['pages', 'journals']) {
    for (const name of await deps.listDir(join(graphDir, dir))) {
      if (name.endsWith('.md') && !name.startsWith('.')) files.push(`${dir}/${name}`);
    }
  }
  if (files.length > MAX_GRAPH_FILES) {
    throw new InstanceError(`${graphDir} has ${files.length} pages and journals; an instance is for the small fixture graph`);
  }
  return files;
}

/** Write a fresh profile: configs.edn, seeded localStorage, the graph cache stub and config.json. */
async function writeProfile(
  paths: InstancePaths,
  graphDir: string,
  port: number,
  token: string,
  template: string,
  deps: InstanceDeps,
) {
  for (const path of [paths.profile, paths.home, paths.config]) {
    assertInside(paths.dir, path);
    await deps.remove(path);
  }
  await deps.mkdir(paths.profile);
  await deps.writeFile(join(paths.profile, 'configs.edn'), renderConfigsEdn(template, port, token), PRIVATE_FILE_MODE);

  const leveldb = join(paths.profile, 'Local Storage', 'leveldb');
  await deps.mkdir(leveldb);
  for (const [name, data] of levelDbFiles(localStorageEntries(logseqSeedItems(graphDir), deps.now()))) {
    await deps.writeFile(join(leveldb, name), data);
  }

  const graphs = join(paths.home, '.logseq', 'graphs');
  await deps.mkdir(graphs);
  await deps.writeFile(join(graphs, graphCacheFileName(graphDir)), '');

  await deps.writeFile(paths.config, `${JSON.stringify(instanceConfig(port, token), null, 2)}\n`, PRIVATE_FILE_MODE);
}

/**
 * Wait until the instance serves `graphDir`, the fixture guard passes and every graph file is
 * indexed. Connection errors and an unfinished index are retried until the deadline; a rejected
 * token or another graph on the port means the port is not ours, so those fail at once.
 */
async function waitUntilReady(
  record: InstanceRecord,
  token: string,
  expectedFiles: readonly string[],
  timeoutMs: number,
  deps: InstanceDeps,
): Promise<number> {
  const probe = deps.connect({ ...instanceConfig(record.port, token), timeoutMs: 5_000 });
  const deadline = deps.now().getTime() + timeoutMs;
  let last = 'the API did not answer';
  while (deps.now().getTime() < deadline) {
    if (!deps.isAlive(record.pid)) {
      throw new InstanceError(`LogSeq (pid ${record.pid}) exited while starting. See ${record.logPath}.`);
    }
    try {
      const graph = await probe.currentGraphPath();
      if (graph !== undefined && graph !== record.graphDir) {
        throw new PortTakenError(record.port, `is serving another graph (${graph})`);
      }
      if (graph === undefined) {
        last = 'LogSeq has no graph open yet';
      } else {
        const version = await probe.requireFixture();
        const missing = missingFiles(expectedFiles, await probe.indexedFiles());
        if (missing.length === 0) return version;
        last = `LogSeq has not indexed ${missing.length} of ${expectedFiles.length} graph files yet`;
      }
    } catch (error) {
      if (error instanceof InstanceError) throw error;
      if (error instanceof LogSeqAuthError) {
        throw new PortTakenError(record.port, 'rejected the instance token');
      }
      last = error instanceof Error ? `${error.name}: ${error.message.split('\n')[0]}` : String(error);
    }
    await deps.sleep(READY_POLL_MS);
  }
  throw new InstanceError(`the instance was not ready after ${Math.round(timeoutMs / 1000)}s: ${last}. See ${record.logPath}.`);
}

/**
 * Start this worktree's instance on `graphDir` and wait until it serves the fixture graph.
 * On any failure after the launch, the instance is stopped again. When another LogSeq turns out
 * to hold the chosen port, it tries once more on the next free one (START_ATTEMPTS).
 */
export async function startInstance(options: StartOptions, deps: InstanceDeps): Promise<InstanceRecord & { fixtureVersion: number }> {
  if (deps.platform !== 'darwin') {
    throw new InstanceError(`logseq-instance supports macOS only (this is ${deps.platform}).`);
  }
  const paths = instancePaths(options.worktree);

  const existing = await readRecord(paths, deps);
  if (existing && existing.profileDir === paths.profile && liveInstancePid(existing, deps) !== undefined) {
    throw new InstanceError(`an instance is already running (pid ${existing.pid}, port ${existing.port}). Run stop first.`);
  }

  const sourceGraphDir = await deps.realDir(options.graphDir);
  if (!sourceGraphDir) throw new InstanceError(`graph directory not found: ${options.graphDir}`);
  // The copy goes in paths.dir and replaces what is there: a source in it would be deleted, and
  // a source holding it would be copied into itself.
  if (within(paths.dir, sourceGraphDir) || within(sourceGraphDir, paths.dir)) {
    throw new InstanceError(
      `refusing to open ${sourceGraphDir}: start copies the graph into ${paths.graph}, so the graph folder must not be in ${paths.dir} or hold it.`,
    );
  }
  if (!(await deps.exists(join(sourceGraphDir, options.sentinelFile)))) {
    throw new InstanceError(
      `${sourceGraphDir} has no ${options.sentinelFile}, so it is not the fixture graph. An instance only opens the fixture (tests/fixtures/graph).`,
    );
  }
  const expectedFiles = await graphFiles(sourceGraphDir, deps);

  const appBundle = deps.env.LOGSEQ_APP?.trim() || DEFAULT_APP_BUNDLE;
  const spec = launchSpec(appBundle, paths, deps.env);
  if (!(await deps.exists(spec.command))) {
    throw new InstanceError(`LogSeq not found at ${spec.command}. Set LOGSEQ_APP to the app bundle (e.g. ~/Applications/Logseq.app).`);
  }

  const lost = new Set<number>();
  for (let attempt = 1; ; attempt++) {
    try {
      return await launch(options, paths, sourceGraphDir, expectedFiles, spec, lost, deps);
    } catch (error) {
      if (!(error instanceof PortTakenError) || attempt >= START_ATTEMPTS) throw error;
      lost.add(error.port);
      deps.log(`Another LogSeq took port ${error.port}; trying the next free port.`);
    }
  }
}

/**
 * One launch on the next free port, on a fresh copy of the graph. On any failure after the
 * spawn, the instance is stopped again.
 */
async function launch(
  options: StartOptions,
  paths: InstancePaths,
  sourceGraphDir: string,
  expectedFiles: readonly string[],
  spec: LaunchSpec,
  lost: ReadonlySet<number>,
  deps: InstanceDeps,
): Promise<InstanceRecord & { fixtureVersion: number }> {
  const port = await choosePort(options.worktree, lost, deps);
  const token = newInstanceToken(deps.randomBytes);
  await deps.mkdir(paths.dir);
  await deps.remove(paths.record);
  const graphDir = await copyGraph(paths, sourceGraphDir, deps);
  await writeProfile(paths, graphDir, port, token, options.template, deps);

  const pid = await deps.spawnDetached(spec, paths.log);
  const record: InstanceRecord = {
    pid,
    port,
    apiUrl: instanceConfig(port, token).apiUrl,
    graphDir,
    sourceGraphDir,
    profileDir: paths.profile,
    configPath: paths.config,
    logPath: paths.log,
    startedAt: deps.now().toISOString(),
  };
  // Recorded before waiting, so stop can find the process if the wait fails or is interrupted.
  await deps.writeFile(paths.record, `${JSON.stringify(record, null, 2)}\n`);
  deps.log(`Started LogSeq (pid ${pid}) on port ${port}; waiting for the fixture graph...`);

  try {
    const fixtureVersion = await waitUntilReady(record, token, expectedFiles, options.readyTimeoutMs ?? READY_TIMEOUT_MS, deps);
    return { ...record, fixtureVersion };
  } catch (error) {
    try {
      await stopInstance(options.worktree, deps);
    } catch (stopError) {
      // Not a PortTakenError, so start does not retry: a second launch would orphan this one.
      const why = error instanceof Error ? error.message : String(error);
      throw new InstanceError(
        `start failed (${why}), and LogSeq pid ${pid} on profile ${paths.profile} could not be stopped ` +
          `(${stopError instanceof Error ? stopError.message : String(stopError)}). It may still be running; ` +
          'stop it before starting again.',
      );
    }
    throw error;
  }
}

export type StopResult =
  | { state: 'stopped'; pid: number }
  | { state: 'none' }
  | { state: 'stale'; pid: number };

/** Wait for `pid` to exit, polling until `ms` have passed. */
async function exited(pid: number, ms: number, deps: InstanceDeps): Promise<boolean> {
  const deadline = deps.now().getTime() + ms;
  while (deps.isAlive(pid)) {
    if (deps.now().getTime() >= deadline) return false;
    await deps.sleep(200);
  }
  return true;
}

/**
 * Remove the record and config.json once no instance runs. Left behind, config.json would point
 * LOGSEQ_MCP_CONFIG at a port that another worktree's instance may take next. The graph copy,
 * profile, home and log stay, so what LogSeq wrote can be inspected; the next start replaces them.
 */
async function forget(paths: InstancePaths, deps: InstanceDeps): Promise<void> {
  await deps.remove(paths.record);
  await deps.remove(paths.config);
}

/**
 * Stop the recorded instance: SIGTERM, then SIGKILL if it is still running after STOP_GRACE_MS.
 * Only the recorded pid is signalled, and only while its command line names this worktree's
 * profile; otherwise the record is stale (the process is gone) or refused.
 */
export async function stopInstance(worktree: string, deps: InstanceDeps): Promise<StopResult> {
  const paths = instancePaths(worktree);
  const record = await readRecord(paths, deps);
  if (!record) {
    await forget(paths, deps);
    return { state: 'none' };
  }
  if (record.profileDir !== paths.profile) {
    throw new InstanceError(`${paths.record} names another profile (${record.profileDir}); not stopping pid ${record.pid}.`);
  }
  if (!deps.isAlive(record.pid)) {
    await forget(paths, deps);
    return { state: 'stale', pid: record.pid };
  }
  if (!isInstanceProcess(deps.commandLine(record.pid), record.profileDir)) {
    throw new InstanceError(
      `pid ${record.pid} is running but is not this worktree's LogSeq (its command line does not pass ` +
        `--user-data-dir=${record.profileDir}), so it was not stopped. If the instance is gone, delete ${paths.record}.`,
    );
  }

  deps.kill(record.pid, 'SIGTERM');
  if (!(await exited(record.pid, STOP_GRACE_MS, deps))) {
    deps.kill(record.pid, 'SIGKILL');
    if (!(await exited(record.pid, KILL_GRACE_MS, deps))) {
      throw new InstanceError(`pid ${record.pid} is still running after SIGKILL.`);
    }
  }
  await forget(paths, deps);
  return { state: 'stopped', pid: record.pid };
}

export type StatusResult =
  | { state: 'none' }
  | { state: 'stale'; record: InstanceRecord }
  | { state: 'running'; record: InstanceRecord; api: string };

/** The token `start` wrote to config.json, or undefined when the file is missing or malformed. */
async function readInstanceToken(paths: InstancePaths, deps: InstanceDeps): Promise<string | undefined> {
  const text = await deps.readFile(paths.config);
  if (text === undefined) return undefined;
  try {
    const parsed = z.object({ authToken: z.string().min(1) }).safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.authToken : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the recorded instance is running, and what its API says. Read-only. */
export async function instanceStatus(worktree: string, deps: InstanceDeps): Promise<StatusResult> {
  const paths = instancePaths(worktree);
  const record = await readRecord(paths, deps);
  if (!record) return { state: 'none' };
  if (record.profileDir !== paths.profile || liveInstancePid(record, deps) === undefined) {
    return { state: 'stale', record };
  }
  const token = await readInstanceToken(paths, deps);
  if (token === undefined) {
    return { state: 'running', record, api: `no token: ${paths.config} is missing or unreadable; run stop, then start` };
  }
  const probe = deps.connect({ ...instanceConfig(record.port, token), timeoutMs: 5_000 });
  let api: string;
  try {
    api = `serving the fixture graph, version ${await probe.requireFixture()}`;
  } catch (error) {
    api = error instanceof Error ? `${error.name}: ${error.message.split('\n')[0]}` : String(error);
  }
  return { state: 'running', record, api };
}
