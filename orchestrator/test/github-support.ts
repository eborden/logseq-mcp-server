// Helpers for the GitHub activity tests: a fake `gh` selected through the config's `ghPath`, builders for the raw
// shapes GitHub answers with (all made up: Alice, Bob, issue 123, "project atlas"), and a recording sleep so a
// rate-limit wait never takes real time.

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RATE_LIMIT } from '../src/gh-config.ts';
import type { GhConfig } from '../src/gh-config.ts';
import type { GhDeps } from '../src/gh.ts';

const FAKE_GH = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url));

export const REPO = 'eborden/logseq-mcp-server';
export const NOW_MS = 1_800_000_000_000;

export interface Call {
  readonly argv: readonly string[];
  readonly stdin: string | undefined;
}

export interface Fault {
  /** Applies to a call whose joined argv contains this text. */
  readonly match: string;
  readonly times: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exit?: number;
  readonly delayMs?: number;
  /** Calls to let through before the fault starts to apply, so it can hit a later call (the read after a write). */
  readonly skip?: number;
  readonly addPulls?: readonly unknown[];
}

export interface FakeState {
  board: { number: number; status?: string; repository?: string; type?: string; pendingStatus?: string; pendingReads?: number }[];
  issues: Record<string, unknown>;
  comments: Record<string, unknown[]>;
  blockedBy: Record<string, unknown[]>;
  pulls: unknown[];
  refs: { ref: string }[];
  reviews: Record<string, unknown[]>;
  gate: Record<string, unknown>;
  rateLimit: unknown;
  /** The Status a newly added board item gets (the board's default). Backlog when unset. */
  addStatus?: string;
  /** A new item shows no Status for this many board reads, then its default (the board's own workflow is slow). */
  addStatusAfterReads?: number;
  faults: Fault[];
}

export function emptyState(): FakeState {
  return { board: [], issues: {}, comments: {}, blockedBy: {}, pulls: [], refs: [], reviews: {}, gate: {}, rateLimit: { resources: {} }, faults: [] };
}

export interface Fake {
  readonly config: GhConfig;
  readonly statePath: string;
  calls(): Promise<Call[]>;
  /** The calls whose joined argv contains `text`. */
  callsMatching(text: string): Promise<Call[]>;
  state(): Promise<FakeState>;
}

/** Writes the state and a wrapper script into `dir/<name>` and returns a config that runs the fake. */
export async function createFake(dir: string, name: string, state: FakeState, overrides: Partial<GhConfig> = {}): Promise<Fake> {
  const home = join(dir, name);
  await mkdir(home, { recursive: true });
  const statePath = join(home, 'state.json');
  await writeFile(statePath, JSON.stringify(state));
  const wrapper = join(home, 'gh');
  await writeFile(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_GH}' '${statePath}' "$@"\n`);
  await chmod(wrapper, 0o755);
  const config: GhConfig = {
    ghPath: wrapper,
    repo: REPO,
    projectOwner: 'eborden',
    projectNumber: 1,
    timeoutMs: 20_000,
    maxOutputBytes: 1024 * 1024,
    rateLimit: DEFAULT_RATE_LIMIT,
    ...overrides,
  };
  const calls = async (): Promise<Call[]> => {
    let text: string;
    try {
      text = await readFile(`${statePath}.calls.jsonl`, 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter((line) => line !== '')
      .map((line): Call => {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== 'object' || parsed === null || !('argv' in parsed) || !Array.isArray(parsed.argv)) {
          throw new Error('a recorded call has no argv');
        }
        const argv: unknown[] = parsed.argv;
        const stdin = 'stdin' in parsed && typeof parsed.stdin === 'string' ? parsed.stdin : undefined;
        return { argv: argv.map(String), stdin };
      });
  };
  return {
    config,
    statePath,
    calls,
    callsMatching: async (text) => (await calls()).filter((call) => call.argv.join(' ').includes(text)),
    state: async (): Promise<FakeState> => {
      // The fake wrote this file itself; the tests only read fields they set up.
      const parsed: unknown = JSON.parse(await readFile(statePath, 'utf8'));
      return parsed as FakeState;
    },
  };
}

export interface RecordedSleep extends GhDeps {
  readonly waits: number[];
}

/** A sleep that records the wait and returns at once, and a clock fixed at NOW_MS. */
export function recordedSleep(): RecordedSleep {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    now: () => NOW_MS,
  };
}

// ---- raw GitHub shapes ----------------------------------------------------------------------------------------

export function rawIssue(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    title: 'Add the project atlas importer',
    state: 'open',
    body: 'Scope: build the importer.',
    user: { login: 'alice' },
    author_association: 'OWNER',
    labels: [{ name: 'task' }],
    ...overrides,
  };
}

export function rawComment(id: number, association: string | undefined, body: string, login = 'alice'): Record<string, unknown> {
  return {
    id,
    body,
    user: { login },
    created_at: '2026-01-01T00:00:00Z',
    ...(association === undefined ? {} : { author_association: association }),
  };
}

export function rawOpenPr(number: number, headRef: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    author_association: 'OWNER',
    head: { ref: headRef },
    base: { ref: 'feature/atlas' },
    body: '',
    ...overrides,
  };
}

export function rawBlocker(number: number, state: 'open' | 'closed'): Record<string, unknown> {
  return { number, state };
}

export function rawGate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headRefOid: 'a'.repeat(40),
    reviews: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    ...overrides,
  };
}

export function rawGateReview(oid: string | null, body: string, association = 'OWNER', state = 'COMMENTED'): Record<string, unknown> {
  return { state, body, authorAssociation: association, commit: oid === null ? null : { oid } };
}

/** An `-i` style HTTP answer, as `gh api -i` prints it. */
export function httpAnswer(status: number, body: unknown, headers: Record<string, string> = {}): string {
  const head = Object.entries({ 'Content-Type': 'application/json', ...headers })
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');
  return `HTTP/2.0 ${status} Status\r\n${head}\r\n\r\n${typeof body === 'string' ? body : JSON.stringify(body)}`;
}
