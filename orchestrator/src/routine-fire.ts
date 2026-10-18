// The client of the routine fire endpoint (#672, spike #670): `POST /v1/claude_code/routines/{id}/fire` with a bearer
// token per routine and the brief in the per-run `text`. It is a thin `fetch` with a timeout and nothing else.
//
// Secrets: the token, the text and the response body never leave this file. An error carries a fixed kind, the HTTP
// status and a parsed `Retry-After`, and its message is a fixed sentence. Nothing here logs. The response is parsed at
// the boundary: only the session id and url are read, and only when they have the documented shape.
//
// The call is not idempotent (each success creates a session), so this client never retries. The activity decides.

export interface FireReceipt {
  readonly sessionId: string;
  readonly url: string;
}

export interface FireClient {
  fire(routineId: string, text: string): Promise<FireReceipt>;
}

/**
 * `bad_request` is 400 or 404 and `auth` is 401 or 403 (both permanent: a person fixes them), `rate_limited` is 429,
 * `server` is 5xx. `network` (no answer, a timeout) and `malformed` (a 200 that is not the documented shape) leave it
 * unknown whether a session was created.
 */
export type FireErrorKind = 'bad_request' | 'auth' | 'rate_limited' | 'server' | 'network' | 'malformed';

export class FireError extends Error {
  readonly kind: FireErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(kind: FireErrorKind, status?: number, retryAfterMs?: number) {
    super(`the routine fire call failed (${kind}${status === undefined ? '' : `, HTTP ${status}`})`);
    this.name = 'FireError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export const FIRE_BASE_URL = 'https://api.anthropic.com';
// Every fire call needs this header, and a call without it gets a 400. The docs promise dated versions, so a new
// version is a one-line change here.
export const FIRE_BETA_HEADER = 'experimental-cc-routine-2026-04-01';
export const FIRE_TIMEOUT_MS = 30_000;
const ROUTINE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SESSION_ID = /^session_[A-Za-z0-9]{1,100}$/;
const SESSION_URL = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{1,100}$/;
const MAX_RETRY_AFTER_S = 86_400;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface RoutineFireOptions {
  /** The bearer token of each routine, by routine id. Never read back out. */
  readonly tokens: ReadonlyMap<string, string>;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
}

function retryAfterMs(raw: string | null): number | undefined {
  if (raw === null || !/^\d{1,9}$/.test(raw.trim())) {
    return undefined;
  }
  const seconds = Number(raw.trim());
  return seconds <= MAX_RETRY_AFTER_S ? seconds * 1000 : MAX_RETRY_AFTER_S * 1000;
}

export function createRoutineFireClient(options: RoutineFireOptions): FireClient {
  const timeoutMs = options.timeoutMs ?? FIRE_TIMEOUT_MS;
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const tokens = options.tokens;

  async function fire(routineId: string, text: string): Promise<FireReceipt> {
    const token = tokens.get(routineId);
    if (!ROUTINE_ID.test(routineId) || token === undefined) {
      // No call is made for an id this client has no token for.
      throw new FireError('auth');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await doFetch(`${FIRE_BASE_URL}/v1/claude_code/routines/${routineId}/fire`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': FIRE_BETA_HEADER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
    } catch {
      // The error of a failed fetch can quote the URL or the cause; a fixed kind is all that leaves.
      throw new FireError('network');
    } finally {
      clearTimeout(timer);
    }
    const status = response.status;
    if (status === 429) {
      throw new FireError('rate_limited', status, retryAfterMs(response.headers.get('retry-after')));
    }
    if (status === 400 || status === 404) {
      throw new FireError('bad_request', status);
    }
    if (status === 401 || status === 403) {
      throw new FireError('auth', status);
    }
    if (status >= 500) {
      throw new FireError('server', status);
    }
    if (status !== 200) {
      // Any other answer (a redirect, a 4xx the docs do not list) is not a success and not known to be a refusal.
      throw new FireError('malformed', status);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new FireError('malformed', status);
    }
    const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? new Map(Object.entries(body)) : new Map<string, unknown>();
    const sessionId = record.get('claude_code_session_id');
    const url = record.get('claude_code_session_url');
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || typeof url !== 'string' || !SESSION_URL.test(url)) {
      throw new FireError('malformed', status);
    }
    return { sessionId, url };
  }

  return { fire };
}
