// A stand-in for LogSeq's HTTP API (#124). It replays canned responses keyed by method and
// query text, records every call it gets, and fails loud on any call it has no answer for.
// It listens on 127.0.0.1 with a port the OS picks, never LogSeq's 12315, and checks a token
// made fresh for each run, so a server pointed at it can't reach a real graph by mistake.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/** LogSeq's own port. The stub refuses to run on it (BR-0001). */
export const LOGSEQ_PORT = 12315;

export const DATASCRIPT_QUERY = 'logseq.DB.datascriptQuery';

/** One call as the server sent it: the method and its args, as LogSeq's `/api` takes them. */
export interface LogseqCall {
  method: string;
  args: unknown[];
}

/** A canned answer: the call it answers and the response body LogSeq would send. */
export interface CannedCall extends LogseqCall {
  response: unknown;
}

/**
 * Collapse whitespace runs to one space. A query's indentation is how the TypeScript source
 * happens to lay it out, not part of what LogSeq is asked, so it is not part of the contract.
 */
export const normalizeQuery = (query: string): string => query.replace(/\s+/g, ' ').trim();

/**
 * What a call is looked up by: the method, plus the query text for a Datalog query or the
 * args for any other method. The inputs of a query are not in the key; the harness compares
 * them separately, so a wrong input shows as a diff rather than as a missing answer.
 */
export function callKey(call: LogseqCall): string {
  if (call.method === DATASCRIPT_QUERY && typeof call.args[0] === 'string') {
    return `${call.method} ${normalizeQuery(call.args[0])}`;
  }
  return `${call.method} ${JSON.stringify(call.args)}`;
}

export interface StubLogseq {
  /** `http://127.0.0.1:<port>`, for the server's config `apiUrl` */
  apiUrl: string;
  authToken: string;
  /** Replace the canned answers and clear the call log and failures. */
  load(calls: readonly CannedCall[]): void;
  /** Every call since the last `load`, in the order the requests arrived. */
  calls(): LogseqCall[];
  /**
   * Wait until at least `expected` calls have arrived since the last `load` and none is still being
   * read or answered, or `timeoutMs` has passed (a server that makes fewer calls than the case lists
   * is a failure the comparison reports). A tool that makes calls at once and fails on the first
   * answer returns before the others reach the stub; reading the log then misses them, and they
   * land in the next case's log (#340). Never fails: it only waits.
   */
  settle(expected: number, timeoutMs?: number): Promise<void>;
  /** Calls the stub could not answer, wrong tokens and malformed requests since the last `load`. */
  failures(): string[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Start a stub on a random local port. */
export async function startStubLogseq(): Promise<StubLogseq> {
  const authToken = randomBytes(16).toString('hex');
  // Answers left for each key, used up in order, so one query asked twice can get two answers
  let pending = new Map<string, unknown[]>();
  let log: LogseqCall[] = [];
  let failures: string[] = [];
  // Requests received and not yet answered, and who is waiting for the log to fill (`settle`)
  let inFlight = 0;
  let watchers: Array<() => void> = [];
  const notify = (): void => {
    for (const watcher of watchers) watcher();
  };

  const server: Server = createServer((req, res) => {
    inFlight++;
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/api') {
        failures.push(`unexpected request ${req.method} ${req.url}`);
        return send(res, 404, { error: 'parity stub: only POST /api exists' });
      }
      if (req.headers.authorization !== `Bearer ${authToken}`) {
        failures.push('request with a wrong or missing auth token');
        return send(res, 401, { error: 'parity stub: bad token' });
      }
      let call: LogseqCall;
      try {
        const body = JSON.parse(await readBody(req)) as { method?: unknown; args?: unknown };
        if (typeof body.method !== 'string' || !Array.isArray(body.args)) throw new Error('no method or args');
        call = { method: body.method, args: body.args };
      } catch (error) {
        failures.push(`malformed request body (${(error as Error).message})`);
        return send(res, 400, { error: 'parity stub: malformed body' });
      }
      log.push(call);
      const answers = pending.get(callKey(call));
      if (!answers || answers.length === 0) {
        failures.push(`no canned response for ${callKey(call)} (inputs ${JSON.stringify(call.args.slice(1))})`);
        // LogSeq answers an unknown method with HTTP 200 and an error body; the stub does the same
        return send(res, 200, { error: 'parity stub: no canned response for this call' });
      }
      send(res, 200, answers.shift());
    })()
      .catch(error => {
        failures.push(`stub error: ${(error as Error).message}`);
        if (!res.headersSent) send(res, 500, { error: 'parity stub: internal error' });
      })
      .finally(() => {
        inFlight--;
        notify();
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  if (port === LOGSEQ_PORT) {
    await new Promise(resolve => server.close(resolve));
    throw new Error(`parity stub got port ${LOGSEQ_PORT}, LogSeq's own; refusing to run there`);
  }

  return {
    apiUrl: `http://127.0.0.1:${port}`,
    authToken,
    load(calls) {
      pending = new Map();
      for (const call of calls) {
        const key = callKey(call);
        pending.set(key, [...(pending.get(key) ?? []), call.response]);
      }
      log = [];
      failures = [];
    },
    calls: () => [...log],
    settle(expected, timeoutMs = 2000) {
      const done = (): boolean => log.length >= expected && inFlight === 0;
      if (done()) return Promise.resolve();
      return new Promise(resolve => {
        const finish = (): void => {
          clearTimeout(timer);
          watchers = watchers.filter(w => w !== check);
          resolve();
        };
        const check = (): void => {
          if (done()) finish();
        };
        const timer = setTimeout(finish, timeoutMs);
        watchers.push(check);
      });
    },
    failures: () => [...failures],
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close(error => (error ? reject(error) : resolve()));
      })
  };
}
