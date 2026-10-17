// A thin wrapper over the `gh` CLI (parent plan #625, #628). No new HTTP client: every call is one `gh` process,
// started with an argv array (never a shell string), under a timeout and an output cap, and its answer is parsed
// at the boundary (foundations 4.2). A malformed answer fails with an error that names the command and the path
// of the first mismatch, never a partial result and never a value.
//
// Rate limits (CLAUDE.md "GitHub rate limits", the `github-rate-limits` skill). `gh api` calls run with `-i`, so a
// failure still carries the status line and headers on stdout:
// - A primary limit (`x-ratelimit-remaining: 0`, or a message that says the limit is exceeded) waits until the
//   reset time. Without a reset header the `rate_limit` endpoint (which does not count) names it.
// - A secondary limit (a message that says so, or 403/429 with `Retry-After`) waits `Retry-After` seconds, or at
//   least a minute, doubling on each repeat. Nothing here retries in a tight loop.
// - A wait longer than `maxWaitMs`, or more waits than `maxWaits`, fails the call with a clear message instead of
//   sleeping. The caller (the workflow's retry policy) decides what happens next.
// One GhCli is one attempt of one activity: its waits are counted over all its calls (see `waits`).
// Only a rate-limited call is retried here, and only after its wait. A rate-limited request was rejected, so
// repeating it cannot apply it twice. Any other failure propagates, and the activity's own retry policy and
// idempotent re-check handle it.

import { spawn } from 'node:child_process';
import type { GhConfig } from './gh-config.ts';

export type GhErrorKind =
  | 'spawn'
  | 'timeout'
  | 'output_too_large'
  | 'exit'
  | 'malformed'
  | 'graphql'
  | 'rate_limit_wait_too_long'
  | 'rate_limit_exhausted';

export class GhError extends Error {
  readonly kind: GhErrorKind;
  /** The HTTP status when the failure carried one. */
  readonly httpStatus: number | undefined;

  constructor(message: string, kind: GhErrorKind, httpStatus?: number) {
    super(message);
    this.name = 'GhError';
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

export interface GhDeps {
  /** Waits out a rate limit. The activities pass one that heartbeats and stops when the activity is cancelled. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export const defaultGhDeps: GhDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

// ---- parsing helpers ------------------------------------------------------------------------------------------

export interface HttpResponse {
  readonly status: number;
  /** Header names are lowercase. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Splits the output of `gh api -i`: a status line, headers, a blank line, then the body. */
export function splitHttpResponse(stdout: string): HttpResponse | undefined {
  const statusLine = /^HTTP\/[\d.]+\s+(\d{3})[^\r\n]*\r?\n/.exec(stdout);
  if (statusLine === null) {
    return undefined;
  }
  const rest = stdout.slice(statusLine[0].length);
  const blank = /^\r?\n|\r?\n\r?\n/.exec(rest);
  const headerText = blank === null ? rest : rest.slice(0, blank.index);
  const body = blank === null ? '' : rest.slice(blank.index + blank[0].length);
  const headers: Record<string, string> = {};
  for (const line of headerText.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  return { status: Number(statusLine[1]), headers, body };
}

export type RateLimitSignal =
  | { readonly kind: 'secondary'; readonly retryAfterMs: number | undefined }
  | { readonly kind: 'primary'; readonly resetAtMs: number | undefined };

function parseSeconds(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d{1,12}$/.test(raw)) {
    return undefined;
  }
  return Number(raw) * 1000;
}

/** Tells a primary limit from a secondary one, or neither, from a failed `gh` call's stdout and stderr. */
export function classifyRateLimit(stdout: string, stderr: string): RateLimitSignal | undefined {
  const http = splitHttpResponse(stdout);
  const fromStderr = /\(HTTP (\d{3})\)/.exec(stderr);
  const status = http?.status ?? (fromStderr === null ? undefined : Number(fromStderr[1]));
  const headers = http?.headers ?? {};
  const text = `${stderr}\n${http?.body ?? stdout}`.toLowerCase();
  const limited = status === 403 || status === 429;

  if (text.includes('secondary rate limit') || text.includes('abuse detection')) {
    return { kind: 'secondary', retryAfterMs: parseSeconds(headers['retry-after']) };
  }
  if (limited && headers['retry-after'] !== undefined) {
    return { kind: 'secondary', retryAfterMs: parseSeconds(headers['retry-after']) };
  }
  const resetSeconds = parseSeconds(headers['x-ratelimit-reset']);
  if (
    (limited && headers['x-ratelimit-remaining'] === '0') ||
    text.includes('rate limit exceeded') ||
    text.includes('rate limit already exceeded') ||
    text.includes('rate_limited')
  ) {
    return { kind: 'primary', resetAtMs: resetSeconds };
  }
  return undefined;
}

/** A GraphQL error entry GitHub marks as `NOT_FOUND` (a missing issue or PR). Only its `type` is read, never its message. */
function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'type' in error && error.type === 'NOT_FOUND';
}

/** The `errors` of a GraphQL answer body, when it has some. */
function graphqlErrors(body: unknown): unknown[] | undefined {
  if (typeof body === 'object' && body !== null && 'errors' in body && Array.isArray(body.errors) && body.errors.length > 0) {
    const errors: unknown[] = body.errors;
    return errors;
  }
  return undefined;
}

/**
 * Whether `gh api graphql` stdout is an answer whose only errors are NOT_FOUND, with a `data` object. The real API
 * answers a missing issue or PR as `{"data":{"repository":{"pullRequest":null}},"errors":[{"type":"NOT_FOUND",...}]}`
 * and `gh` exits 1 on it, so the call is a failure by exit code and a plain "not there" by content.
 */
function isNotFoundOnlyAnswer(stdout: string): boolean {
  const response = splitHttpResponse(stdout);
  if (response === undefined) {
    return false;
  }
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    return false;
  }
  const errors = graphqlErrors(body);
  return errors !== undefined && errors.every(isNotFoundError) && typeof body === 'object' && body !== null && 'data' in body && typeof body.data === 'object' && body.data !== null;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new GhError(`${what}: the answer is not JSON`, 'malformed');
  }
}

function describe(args: readonly string[]): string {
  // Only the subcommand words: later arguments can hold a query or a body.
  return `gh ${args.filter((arg) => /^[a-z][a-z-]*$/.test(arg)).slice(0, 2).join(' ')}`;
}

// ---- the wrapper ----------------------------------------------------------------------------------------------

interface RawResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ApiOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH';
  /** Sent as JSON on stdin (`--input -`). */
  readonly body?: unknown;
}

export class GhCli {
  readonly config: GhConfig;
  private readonly deps: GhDeps;
  /**
   * Rate-limit waits made so far. They count over the whole life of this instance, not per call, so one instance
   * (the activities make one per attempt) never waits more than `maxWaits` times in all, and the doubling carries on.
   */
  private waits = 0;

  constructor(config: GhConfig, deps: GhDeps = defaultGhDeps) {
    this.config = config;
    this.deps = deps;
  }

  /** `gh api -i <route>`. Returns the parsed JSON body, or `null` for an empty one. */
  async api(route: string, options: ApiOptions = {}): Promise<unknown> {
    const method = options.method ?? 'GET';
    const args = ['api', '-i', '-X', method, ...(options.body === undefined ? [] : ['--input', '-']), route];
    const stdout = await this.exec(args, options.body === undefined ? undefined : JSON.stringify(options.body));
    const response = splitHttpResponse(stdout);
    if (response === undefined) {
      throw new GhError(`gh api: no HTTP status line in the answer`, 'malformed');
    }
    if (response.status >= 400) {
      throw new GhError(`gh api: HTTP ${response.status}`, 'exit', response.status);
    }
    return response.body.trim() === '' ? null : parseJson(response.body, 'gh api');
  }

  /**
   * A GraphQL query through `gh api graphql`. Returns the `data` object. A string variable goes in with `-f`, a number with `-F`.
   * An answer whose only errors are NOT_FOUND is returned as its `data` (the missing item is `null` in it), not
   * thrown: a missing issue or PR is an answer, and retrying it cannot change it. Any other error is a `graphql` error.
   */
  async graphql(query: string, variables: Readonly<Record<string, string | number>>): Promise<unknown> {
    const args = ['api', '-i', 'graphql', '-f', `query=${query}`];
    for (const [name, value] of Object.entries(variables)) {
      args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${String(value)}`);
    }
    const stdout = await this.exec(args, undefined, isNotFoundOnlyAnswer);
    const response = splitHttpResponse(stdout);
    if (response === undefined) {
      throw new GhError('gh api graphql: no HTTP status line in the answer', 'malformed');
    }
    const body = parseJson(response.body, 'gh api graphql');
    if (typeof body !== 'object' || body === null) {
      throw new GhError('gh api graphql: the answer is not an object', 'malformed');
    }
    const errors = graphqlErrors(body);
    if (errors !== undefined && !errors.every(isNotFoundError)) {
      throw new GhError('gh api graphql: GitHub answered with errors', 'graphql');
    }
    if (!('data' in body) || typeof body.data !== 'object' || body.data === null) {
      throw new GhError('gh api graphql: the answer has no data object', 'malformed');
    }
    return body.data;
  }

  /** `gh project ...` (the documented board commands). Returns stdout. */
  async project(args: readonly string[]): Promise<string> {
    return await this.exec(['project', ...args], undefined);
  }

  /** Parses `gh project ... --format json` output. */
  async projectJson(args: readonly string[]): Promise<unknown> {
    return parseJson(await this.project(args), 'gh project');
  }

  /** `acceptFailure` names a non-zero exit whose stdout is still an answer to use (see `graphql`). */
  private async exec(args: readonly string[], input: string | undefined, acceptFailure?: (stdout: string) => boolean): Promise<string> {
    const policy = this.config.rateLimit;
    for (;;) {
      const raw = await this.spawnOnce(args, input);
      if (raw.exitCode === 0 || (acceptFailure?.(raw.stdout) ?? false)) {
        return raw.stdout;
      }
      const signal = classifyRateLimit(raw.stdout, raw.stderr);
      if (signal === undefined) {
        const status =
          splitHttpResponse(raw.stdout)?.status ?? Number(/\(HTTP (\d{3})\)/.exec(raw.stderr)?.[1] ?? Number.NaN);
        throw new GhError(
          // No stderr text: it holds GitHub's `message`, which can echo what the call sent.
          `${describe(args)} failed (exit ${raw.exitCode ?? 'signal'}${Number.isNaN(status) ? '' : `, HTTP ${status}`})`,
          'exit',
          Number.isNaN(status) ? undefined : status,
        );
      }
      if (this.waits >= policy.maxWaits) {
        throw new GhError(
          `${describe(args)} is still rate limited after ${this.waits} waits; stopping instead of polling`,
          'rate_limit_exhausted',
        );
      }
      const waitMs = await this.waitFor(signal, this.waits);
      if (waitMs > policy.maxWaitMs) {
        throw new GhError(
          `${describe(args)} hit a ${signal.kind} GitHub rate limit that needs a wait of about ${Math.ceil(waitMs / 60_000)} minutes, ` +
            `more than the ${Math.floor(policy.maxWaitMs / 60_000)} minute limit; not waiting`,
          'rate_limit_wait_too_long',
        );
      }
      this.waits += 1;
      await this.deps.sleep(waitMs);
    }
  }

  private async waitFor(signal: RateLimitSignal, previousWaits: number): Promise<number> {
    const policy = this.config.rateLimit;
    const doubling = policy.secondaryMinWaitMs * 2 ** previousWaits;
    if (signal.kind === 'secondary') {
      return Math.max(signal.retryAfterMs ?? doubling, 1000);
    }
    const resetAtMs = signal.resetAtMs ?? (await this.lookUpPrimaryReset());
    // The reset moment plus a second of margin. Without any reset time, treat it like a secondary limit with no header.
    return resetAtMs === undefined ? doubling : Math.max(resetAtMs - this.deps.now() + 1000, 1000);
  }

  /** The `rate_limit` endpoint does not count against any limit. The latest reset among empty buckets is the safe wait. */
  private async lookUpPrimaryReset(): Promise<number | undefined> {
    const raw = await this.spawnOnce(['api', '-i', 'rate_limit'], undefined);
    if (raw.exitCode !== 0) {
      return undefined;
    }
    const body = splitHttpResponse(raw.stdout)?.body;
    if (body === undefined) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || !('resources' in parsed)) {
      return undefined;
    }
    const resources = parsed.resources;
    if (typeof resources !== 'object' || resources === null) {
      return undefined;
    }
    let latest: number | undefined;
    for (const bucket of Object.values(resources)) {
      if (
        typeof bucket === 'object' &&
        bucket !== null &&
        'remaining' in bucket &&
        'reset' in bucket &&
        bucket.remaining === 0 &&
        typeof bucket.reset === 'number'
      ) {
        latest = Math.max(latest ?? 0, bucket.reset * 1000);
      }
    }
    return latest;
  }

  private spawnOnce(args: readonly string[], input: string | undefined): Promise<RawResult> {
    return new Promise<RawResult>((resolve, reject) => {
      const { ghPath, timeoutMs, maxOutputBytes } = this.config;
      // An argv array, never a shell string: nothing in `args` is interpreted by a shell.
      const child = spawn(ghPath, [...args], { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let failure: GhError | undefined;

      const fail = (error: GhError): void => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => {
        fail(new GhError(`${describe(args)} timed out after ${timeoutMs} ms`, 'timeout'));
      }, timeoutMs);
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) {
          fail(new GhError(`${describe(args)} produced more than ${maxOutputBytes} bytes of output`, 'output_too_large'));
          return;
        }
        into.push(chunk);
      };
      // The pipes exist (stdio asks for them); the optional chain only satisfies the type.
      child.stdout?.on('data', collect(out));
      child.stderr?.on('data', collect(err));
      if (input !== undefined && child.stdin !== null) {
        // A child that exits before reading its input closes the pipe; the exit code reports the failure.
        child.stdin.on('error', () => undefined);
        child.stdin.end(input);
      }
      child.on('error', (error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new GhError(`could not start ${ghPath}: ${error.message}`, 'spawn'));
        }
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        if (settled) {
          return;
        }
        settled = true;
        if (failure !== undefined) {
          reject(failure);
          return;
        }
        resolve({ exitCode, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
      });
    });
  }
}
