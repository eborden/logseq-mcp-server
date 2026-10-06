import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { LogSeqAuthError, LogSeqNotRunningError } from './errors.js';
import { FixtureGraphError } from '../tests/integration/helpers/fixture-graph.js';
import {
  DEFAULT_APP_BUNDLE,
  InstanceDeps,
  InstanceError,
  InstanceProbe,
  LaunchSpec,
  PORT_FIRST,
  PRIVATE_FILE_MODE,
  TOKEN_BYTES,
  PORT_LAST,
  READY_TIMEOUT_MS,
  candidatePorts,
  derivePort,
  graphCacheFileName,
  instancePaths,
  instanceStatus,
  isInstanceProcess,
  missingFiles,
  newInstanceToken,
  parseInstanceRecord,
  renderConfigsEdn,
  startInstance,
  stopInstance,
} from '../scripts/logseq-instance/instance.js';

// scripts/logseq-instance.ts (#118), on a fake file system, process table, clock and API.

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(join(here, '..', 'scripts', 'logseq-instance', 'configs.edn.template'), 'utf-8');

const WORKTREE = '/work/tree';
const GRAPH = '/work/tree/tests/fixtures/graph';
const SENTINEL = 'pages/logseq-mcp-fixture-sentinel.md';
const PATHS = instancePaths(WORKTREE);
const APP = `${DEFAULT_APP_BUNDLE}/Contents/MacOS/Logseq`;
const TOKEN = 'made-up_Token-123';

type Step = () => Promise<void>;

/** A fake machine: files, processes, ports, a clock and a LogSeq API that answers from a script. */
class World {
  files = new Map<string, string | Uint8Array>();
  dirs = new Set<string>();
  processes = new Map<number, { commandLine: string; ignoresTerm?: boolean }>();
  busyPorts = new Set<number>();
  clock = Date.parse('2025-01-01T00:00:00Z');
  nextPid = 4242;
  spawned: LaunchSpec[] = [];
  signals: Array<[number, string]> = [];
  logs: string[] = [];
  /** What each readiness poll sees, in order; the last one repeats. */
  readiness: Step[] = [async () => {}];
  graphPath: string | undefined = GRAPH;
  indexed = [SENTINEL];
  fixtureVersion = 1;
  polls = 0;
  modes = new Map<string, number | undefined>();
  randomSeed = 1;
  connected: string[] = [];

  constructor() {
    this.dirs.add(GRAPH);
    this.files.set(join(GRAPH, SENTINEL), 'fixture-version:: 1\n');
    this.files.set(APP, '');
  }

  probe(): InstanceProbe {
    return {
      currentGraphPath: async () => {
        await this.readiness[Math.min(this.polls++, this.readiness.length - 1)]();
        return this.graphPath;
      },
      requireFixture: async () => this.fixtureVersion,
      indexedFiles: async () => this.indexed,
    };
  }

  deps(overrides: Partial<InstanceDeps> = {}): InstanceDeps {
    return {
      platform: 'darwin',
      env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
      readFile: async path => {
        const data = this.files.get(path);
        return data === undefined ? undefined : String(data);
      },
      writeFile: async (path, data, mode) => {
        this.files.set(path, data);
        this.modes.set(path, mode);
      },
      mkdir: async path => {
        this.dirs.add(path);
      },
      remove: async path => {
        for (const key of [...this.files.keys()]) if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
        for (const dir of [...this.dirs]) if (dir === path || dir.startsWith(`${path}/`)) this.dirs.delete(dir);
      },
      exists: async path => this.files.has(path) || this.dirs.has(path),
      realDir: async path => (this.dirs.has(path) ? path : undefined),
      listDir: async path =>
        [...this.files.keys()].filter(key => dirname(key) === path).map(key => key.slice(path.length + 1)),
      isPortFree: async port => !this.busyPorts.has(port),
      spawnDetached: async spec => {
        this.spawned.push(spec);
        const pid = this.nextPid++;
        this.processes.set(pid, { commandLine: `${spec.command} ${spec.args.join(' ')}` });
        return pid;
      },
      isAlive: pid => this.processes.has(pid),
      commandLine: pid => this.processes.get(pid)?.commandLine,
      kill: (pid, signal) => {
        this.signals.push([pid, signal]);
        const process = this.processes.get(pid);
        if (process && (signal === 'SIGKILL' || !process.ignoresTerm)) this.processes.delete(pid);
      },
      connect: config => {
        this.connected.push(config.authToken);
        return this.probe();
      },
      randomBytes: size => Buffer.alloc(size, this.randomSeed++),
      sleep: async ms => {
        this.clock += ms;
      },
      now: () => new Date(this.clock),
      log: line => {
        this.logs.push(line);
      },
      ...overrides,
    };
  }

  text(path: string): string {
    const data = this.files.get(path);
    if (data === undefined) throw new Error(`no file ${path}`);
    return typeof data === 'string' ? data : Buffer.from(data).toString('latin1');
  }
}

const start = (world: World, deps = world.deps()) =>
  startInstance({ worktree: WORKTREE, graphDir: GRAPH, template: TEMPLATE, sentinelFile: SENTINEL }, deps);

/** A record for a running instance, as start writes it. */
function runningInstance(world: World, commandLine = `${APP} --user-data-dir=${PATHS.profile}`): number {
  const pid = 777;
  world.processes.set(pid, { commandLine });
  world.files.set(
    PATHS.record,
    JSON.stringify({
      pid,
      port: 12345,
      apiUrl: 'http://127.0.0.1:12345',
      graphDir: GRAPH,
      profileDir: PATHS.profile,
      configPath: PATHS.config,
      logPath: PATHS.log,
      startedAt: '2025-01-01T00:00:00.000Z',
    }),
  );
  world.files.set(PATHS.config, JSON.stringify({ apiUrl: 'http://127.0.0.1:12345', authToken: TOKEN }));
  return pid;
}

describe('derivePort and candidatePorts', () => {
  it('derives a stable port in 12320-12399 from the worktree path', () => {
    const port = derivePort(WORKTREE);
    expect(port).toBe(derivePort(WORKTREE));
    expect(port).toBeGreaterThanOrEqual(PORT_FIRST);
    expect(port).toBeLessThanOrEqual(PORT_LAST);
    expect([PORT_FIRST, PORT_LAST]).toEqual([12320, 12399]);
  });

  it('gives different worktrees different ports', () => {
    const ports = new Set(['/w/a', '/w/b', '/w/c', '/w/d'].map(derivePort));
    expect(ports.size).toBeGreaterThan(1);
  });

  it('tries the derived port first, then every other port in the range once, wrapping', () => {
    const ports = candidatePorts(WORKTREE);
    expect(ports[0]).toBe(derivePort(WORKTREE));
    expect(ports).toHaveLength(80);
    expect(new Set(ports).size).toBe(80);
    expect(ports.every(p => p >= PORT_FIRST && p <= PORT_LAST)).toBe(true);
    const at = ports.indexOf(PORT_LAST);
    if (at < ports.length - 1) expect(ports[at + 1]).toBe(PORT_FIRST);
  });

  it('never offers the default LogSeq port', () => {
    expect(candidatePorts(WORKTREE)).not.toContain(12315);
  });
});

describe('renderConfigsEdn', () => {
  it('fills the committed template: autostart on, localhost, the port and the token', () => {
    const edn = renderConfigsEdn(TEMPLATE, 12345, TOKEN);
    expect(edn).toContain(':server/autostart true');
    expect(edn).toContain(':server/host "127.0.0.1"');
    expect(edn).toContain(':server/port 12345');
    expect(edn).toContain(`:value "${TOKEN}"`);
    expect(edn).toContain(':auto-update false');
    expect(edn).toContain(':git/disable-auto-commit? true');
    expect(edn).not.toMatch(/\{\{/);
  });

  it('rejects a bad port, a token that would need escaping and a broken template', () => {
    expect(() => renderConfigsEdn(TEMPLATE, 0, TOKEN)).toThrow(InstanceError);
    expect(() => renderConfigsEdn(TEMPLATE, 1.5, TOKEN)).toThrow(InstanceError);
    expect(() => renderConfigsEdn(TEMPLATE, 12345, 'a"b')).toThrow(InstanceError);
    expect(() => renderConfigsEdn('{:server/port {{port}}}', 12345, TOKEN)).toThrow(/missing \{\{token\}\}/);
    expect(() => renderConfigsEdn('{{port}} {{token}} {{host}}', 12345, TOKEN)).toThrow(/unknown placeholder \{\{host\}\}/);
  });

  it('commits no token: the template only has the {{token}} placeholder (ADR-0003)', () => {
    const values = [...TEMPLATE.matchAll(/:value\s+"([^"]*)"/g)].map(m => m[1]);
    expect(values).toEqual(['{{token}}']);
    expect(TEMPLATE).toMatch(/:server\/tokens \[\{:name "[^"]+" :value "\{\{token\}\}"\}\]/);
  });
});

describe('newInstanceToken', () => {
  it('encodes TOKEN_BYTES random bytes as base64url', () => {
    expect(TOKEN_BYTES).toBe(32);
    expect(newInstanceToken(size => Buffer.alloc(size, 0xfb))).toBe(Buffer.alloc(32, 0xfb).toString('base64url'));
    expect(newInstanceToken(size => Buffer.alloc(size, 0xfb))).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refuses a random source that returns too few bytes', () => {
    expect(() => newInstanceToken(() => Buffer.alloc(8))).toThrow(InstanceError);
  });
});

describe('small helpers', () => {
  it('names the graph cache file the way LogSeq does', () => {
    expect(graphCacheFileName('/work/tree/g')).toBe('logseq_local_++work++tree++g.transit');
    expect(graphCacheFileName('C:/g')).toBe('logseq_local_C+3A+++g.transit');
  });

  it('matches only a process passing exactly this profile as --user-data-dir', () => {
    expect(isInstanceProcess(`${APP} --user-data-dir=/p/profile`, '/p/profile')).toBe(true);
    expect(isInstanceProcess(`${APP} --user-data-dir=/p/profile --flag`, '/p/profile')).toBe(true);
    expect(isInstanceProcess(`${APP} --user-data-dir=/p/profile2`, '/p/profile')).toBe(false);
    expect(isInstanceProcess(APP, '/p/profile')).toBe(false);
    expect(isInstanceProcess(undefined, '/p/profile')).toBe(false);
  });

  it('lists graph files the index does not have yet', () => {
    expect(missingFiles(['pages/a.md', 'journals/b.md'], ['pages/a.md', 'logseq/config.edn'])).toEqual(['journals/b.md']);
  });

  it('parses instance.json and names the file when it is not a record', () => {
    expect(() => parseInstanceRecord('{', '/x/instance.json')).toThrow(/\/x\/instance.json is not valid JSON/);
    expect(() => parseInstanceRecord('{"pid": -1}', '/x/instance.json')).toThrow(/bad pid/);
  });
});

describe('startInstance', () => {
  let world: World;

  beforeEach(() => {
    world = new World();
  });

  it('writes a fresh profile, launches LogSeq on it and records the pid', async () => {
    const port = derivePort(WORKTREE);
    const started = await start(world);

    expect(started).toMatchObject({ pid: 4242, port, apiUrl: `http://127.0.0.1:${port}`, graphDir: GRAPH, fixtureVersion: 1 });
    expect(world.text(join(PATHS.profile, 'configs.edn'))).toContain(`:server/port ${port}`);
    const config = JSON.parse(world.text(PATHS.config));
    expect(config).toEqual({ apiUrl: `http://127.0.0.1:${port}`, authToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(world.text(join(PATHS.profile, 'configs.edn'))).toContain(`:value "${config.authToken}"`);
    expect(world.modes.get(PATHS.config)).toBe(PRIVATE_FILE_MODE);
    expect(world.modes.get(join(PATHS.profile, 'configs.edn'))).toBe(PRIVATE_FILE_MODE);
    expect(world.connected.every(token => token === config.authToken)).toBe(true);
    expect(world.text(PATHS.record)).not.toContain(config.authToken);
    expect(parseInstanceRecord(world.text(PATHS.record), PATHS.record)).toMatchObject({ pid: 4242, port, profileDir: PATHS.profile });

    const leveldb = join(PATHS.profile, 'Local Storage', 'leveldb');
    expect(world.text(join(leveldb, 'CURRENT'))).toBe('MANIFEST-000001\n');
    expect(world.text(join(leveldb, '000002.log'))).toContain(`"logseq_local_${GRAPH}"`);
    expect(world.files.get(join(PATHS.home, '.logseq', 'graphs', graphCacheFileName(GRAPH)))).toBe('');
  });

  it('generates a new token on every start', async () => {
    await start(world);
    const first = JSON.parse(world.text(PATHS.config)).authToken;
    await stopInstance(WORKTREE, world.deps());
    await start(world);
    const second = JSON.parse(world.text(PATHS.config)).authToken;

    expect(second).not.toBe(first);
    expect(world.text(join(PATHS.profile, 'configs.edn'))).toContain(`:value "${second}"`);
    expect(world.text(join(PATHS.profile, 'configs.edn'))).not.toContain(first);
  });

  it('launches the app binary with only the instance profile and home', async () => {
    await start(world);

    expect(world.spawned).toHaveLength(1);
    const [spec] = world.spawned;
    expect(spec.command).toBe(APP);
    expect(spec.args).toEqual([`--user-data-dir=${PATHS.profile}`]);
    expect(spec.env).toMatchObject({ HOME: PATHS.home, CFFIXED_USER_HOME: PATHS.home, PATH: '/usr/bin' });
    expect(spec.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  it('honours LOGSEQ_APP', async () => {
    world.files.set('/Apps/Logseq.app/Contents/MacOS/Logseq', '');
    await start(world, world.deps({ env: { LOGSEQ_APP: '/Apps/Logseq.app' } }));
    expect(world.spawned[0].command).toBe('/Apps/Logseq.app/Contents/MacOS/Logseq');
  });

  it('falls back to the next free port when the derived one is taken', async () => {
    const [derived, next] = candidatePorts(WORKTREE);
    world.busyPorts.add(derived);

    const started = await start(world);

    expect(started.port).toBe(next);
    expect(world.text(join(PATHS.profile, 'configs.edn'))).toContain(`:server/port ${next}`);
  });

  it('fails when every port in the range is taken', async () => {
    candidatePorts(WORKTREE).forEach(port => world.busyPorts.add(port));
    await expect(start(world)).rejects.toThrow(/no free port in 12320-12399/);
    expect(world.spawned).toHaveLength(0);
  });

  it('replaces the previous profile', async () => {
    world.files.set(join(PATHS.profile, 'Local Storage', 'leveldb', '000099.ldb'), 'old');
    world.files.set(join(PATHS.home, '.logseq', 'graphs', 'old.transit'), 'old');

    await start(world);

    expect(world.files.has(join(PATHS.profile, 'Local Storage', 'leveldb', '000099.ldb'))).toBe(false);
    expect(world.files.has(join(PATHS.home, '.logseq', 'graphs', 'old.transit'))).toBe(false);
  });

  it('waits through a refused connection, an unfinished index and a missing sentinel', async () => {
    let fixtureCalls = 0;
    world.readiness = [
      async () => {
        throw new LogSeqNotRunningError('http://127.0.0.1:1');
      },
      async () => {
        world.graphPath = undefined;
      },
      async () => {
        world.graphPath = GRAPH;
      },
    ];
    world.indexed = [];
    const deps = world.deps({
      connect: () => ({
        ...world.probe(),
        requireFixture: async () => {
          if (++fixtureCalls === 1) throw new FixtureGraphError('no sentinel yet.');
          world.indexed = [SENTINEL];
          return 1;
        },
      }),
    });

    await expect(start(world, deps)).resolves.toMatchObject({ fixtureVersion: 1 });
    expect(world.polls).toBeGreaterThanOrEqual(4);
    expect(world.signals).toEqual([]);
  });

  it('stops the instance and fails when another graph answers on the port', async () => {
    world.graphPath = '/someone/else';

    await expect(start(world)).rejects.toThrow(/serving another graph/);

    expect(world.signals).toEqual([[4242, 'SIGTERM']]);
    expect(world.files.has(PATHS.record)).toBe(false);
  });

  it('stops the instance and fails when the port rejects the token', async () => {
    world.readiness = [
      async () => {
        throw new LogSeqAuthError('http://127.0.0.1:1');
      },
    ];

    await expect(start(world)).rejects.toThrow(/rejected the instance token/);
    expect(world.signals).toEqual([[4242, 'SIGTERM']]);
  });

  it('gives up after the timeout, says why and stops the instance', async () => {
    world.indexed = [];

    await expect(start(world)).rejects.toThrow(
      new RegExp(`not ready after ${READY_TIMEOUT_MS / 1000}s: LogSeq has not indexed 1 of 1 graph files yet`),
    );
    expect(world.signals).toEqual([[4242, 'SIGTERM']]);
  });

  it('fails at once, pointing at the log, when LogSeq exits while starting', async () => {
    world.readiness = [
      async () => {
        throw new LogSeqNotRunningError('http://127.0.0.1:1');
      },
    ];
    const deps = world.deps({ isAlive: () => false });

    await expect(start(world, deps)).rejects.toThrow(`See ${PATHS.log}`);
    expect(world.signals).toEqual([]);
  });

  it('refuses a folder without the fixture sentinel, before launching anything', async () => {
    world.files.delete(join(GRAPH, SENTINEL));

    await expect(start(world)).rejects.toThrow(/not the fixture graph/);
    expect(world.spawned).toHaveLength(0);
    expect(world.files.has(PATHS.config)).toBe(false);
  });

  it('refuses a missing graph folder', async () => {
    world.dirs.delete(GRAPH);
    await expect(start(world)).rejects.toThrow(`graph directory not found: ${GRAPH}`);
  });

  it('refuses to start a second instance in the same worktree', async () => {
    const pid = runningInstance(world);
    await expect(start(world)).rejects.toThrow(`already running (pid ${pid}, port 12345)`);
    expect(world.spawned).toHaveLength(0);
  });

  it('replaces a record whose process has exited', async () => {
    const pid = runningInstance(world);
    world.processes.delete(pid);

    await expect(start(world)).resolves.toMatchObject({ pid: 4242 });
  });

  it('runs on macOS only', async () => {
    await expect(start(world, world.deps({ platform: 'linux' }))).rejects.toThrow(/macOS only/);
  });

  it('says where to point LOGSEQ_APP when LogSeq is not installed', async () => {
    world.files.delete(APP);
    await expect(start(world)).rejects.toThrow(/Set LOGSEQ_APP/);
  });
});

describe('stopInstance', () => {
  let world: World;

  beforeEach(() => {
    world = new World();
  });

  it('sends SIGTERM to the recorded pid only, then removes the record', async () => {
    const pid = runningInstance(world);
    world.processes.set(9001, { commandLine: APP }); // someone else's LogSeq

    await expect(stopInstance(WORKTREE, world.deps())).resolves.toEqual({ state: 'stopped', pid });

    expect(world.signals).toEqual([[pid, 'SIGTERM']]);
    expect(world.processes.has(9001)).toBe(true);
    expect(world.files.has(PATHS.record)).toBe(false);
  });

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const pid = runningInstance(world);
    world.processes.get(pid)!.ignoresTerm = true;

    await expect(stopInstance(WORKTREE, world.deps())).resolves.toEqual({ state: 'stopped', pid });
    expect(world.signals).toEqual([[pid, 'SIGTERM'], [pid, 'SIGKILL']]);
  });

  it('refuses a recorded pid that now belongs to another process', async () => {
    const pid = runningInstance(world, '/usr/bin/some-other-program');

    await expect(stopInstance(WORKTREE, world.deps())).rejects.toThrow(`pid ${pid} is running but is not this worktree's LogSeq`);
    expect(world.signals).toEqual([]);
    expect(world.files.has(PATHS.record)).toBe(true);
  });

  it('refuses a LogSeq running on another profile', async () => {
    runningInstance(world, `${APP} --user-data-dir=/elsewhere/profile`);
    await expect(stopInstance(WORKTREE, world.deps())).rejects.toThrow(InstanceError);
    expect(world.signals).toEqual([]);
  });

  it('refuses a record that names another worktree profile', async () => {
    runningInstance(world);
    const record = JSON.parse(world.text(PATHS.record));
    world.files.set(PATHS.record, JSON.stringify({ ...record, profileDir: '/other/.logseq-instance/profile' }));

    await expect(stopInstance(WORKTREE, world.deps())).rejects.toThrow(/names another profile/);
    expect(world.signals).toEqual([]);
  });

  it('clears a stale record without signalling anything', async () => {
    const pid = runningInstance(world);
    world.processes.delete(pid);

    await expect(stopInstance(WORKTREE, world.deps())).resolves.toEqual({ state: 'stale', pid });
    expect(world.signals).toEqual([]);
    expect(world.files.has(PATHS.record)).toBe(false);
  });

  it('does nothing when no instance is recorded', async () => {
    await expect(stopInstance(WORKTREE, world.deps())).resolves.toEqual({ state: 'none' });
    expect(world.signals).toEqual([]);
  });
});

describe('instanceStatus', () => {
  it('reports none, stale and running, and what the API says', async () => {
    const world = new World();
    await expect(instanceStatus(WORKTREE, world.deps())).resolves.toEqual({ state: 'none' });

    const pid = runningInstance(world);
    await expect(instanceStatus(WORKTREE, world.deps())).resolves.toMatchObject({
      state: 'running',
      record: { pid },
      api: 'serving the fixture graph, version 1',
    });
    expect(world.connected).toEqual([TOKEN]);

    const failing = world.deps({
      connect: () => ({ ...world.probe(), requireFixture: async () => Promise.reject(new FixtureGraphError('other graph.')) }),
    });
    await expect(instanceStatus(WORKTREE, failing)).resolves.toMatchObject({ api: expect.stringMatching(/^FixtureGraphError: other graph/) });

    world.files.delete(PATHS.config);
    await expect(instanceStatus(WORKTREE, world.deps())).resolves.toMatchObject({ api: expect.stringMatching(/^no token/) });

    world.processes.delete(pid);
    await expect(instanceStatus(WORKTREE, world.deps())).resolves.toMatchObject({ state: 'stale' });
    expect(world.signals).toEqual([]);
  });
});
