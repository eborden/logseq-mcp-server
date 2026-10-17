// `npm run start-server` must stay in the foreground until it gets a signal (#626). It once printed "listening" and
// then exited 0, taking the server with it, because nothing kept Node's event loop alive. This test runs the real
// script as a child process: it must still be running after a delay, accept a TCP connection, and exit 0 on SIGTERM.
//
// It needs the Temporal CLI. When the SDK cannot download it, the test is skipped with a loud reason (and only for
// that failure); any other startup failure fails the test.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { freePort } from './support.ts';

const START_SERVER = fileURLToPath(new URL('../src/start-server.ts', import.meta.url));
const STARTUP_TIMEOUT_MS = 90_000;
const STAYS_UP_MS = 3_000;
const DOWNLOAD_FAILURE = /ephemeral server download/i;

let dir: string;
let child: ChildProcess | undefined;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orchestrator-start-server-'));
});

after(async () => {
  child?.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
});

type Startup = { kind: 'listening' } | { kind: 'exited'; code: number | null; stderr: string } | { kind: 'timeout' };

function waitForStartup(proc: ChildProcess, port: number, stderrSoFar: () => string): Promise<Startup> {
  return new Promise((resolve) => {
    const settle = (result: Startup): void => {
      clearTimeout(timeout);
      clearInterval(poll);
      resolve(result);
    };
    const timeout = setTimeout(() => settle({ kind: 'timeout' }), STARTUP_TIMEOUT_MS);
    const poll = setInterval(() => {
      if (stderrSoFar().includes(`listening on 127.0.0.1:${port}`)) {
        settle({ kind: 'listening' });
      }
    }, 100);
    // A process that said "listening" and then exited counts as listening, so the assertions below name the real bug.
    proc.once('exit', (code) =>
      settle(
        stderrSoFar().includes(`listening on 127.0.0.1:${port}`)
          ? { kind: 'listening' }
          : { kind: 'exited', code, stderr: stderrSoFar() },
      ),
    );
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

test('start-server stays up, accepts connections, and exits 0 on SIGTERM', { timeout: 150_000 }, async (t) => {
  const port = await freePort();
  let stderr = '';
  child = spawn(process.execPath, ['--import', 'tsx', START_SERVER], {
    env: {
      ...process.env,
      TEMPORAL_PORT: String(port),
      TEMPORAL_DB_FILE: join(dir, 'db', 'dev.sqlite'),
    },
    stdio: ['ignore', 'inherit', 'pipe'],
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const startup = await waitForStartup(child, port, () => stderr);
  if (startup.kind === 'exited' && DOWNLOAD_FAILURE.test(startup.stderr)) {
    const reason = 'SKIPPED: the SDK could not download the Temporal CLI here, so start-server was NOT tested';
    console.error(`${reason}\n${startup.stderr.trim()}`);
    t.skip(reason);
    return;
  }
  assert.equal(startup.kind, 'listening', `start-server did not reach "listening": ${JSON.stringify(startup)}`);

  // The bug: the process printed "listening" and then exited 0 at once.
  await sleep(STAYS_UP_MS);
  assert.equal(child.exitCode, null, `start-server exited (code ${child.exitCode}) after it said it was listening`);
  assert.equal(await canConnect(port), true, `nothing accepts a connection on 127.0.0.1:${port}`);

  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 0, `expected a clean exit on SIGTERM, got code ${code} signal ${signal}`);
});
