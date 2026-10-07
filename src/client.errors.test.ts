import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LogseqClient } from './client.js';
import { LogSeqAuthError, LogSeqNotRunningError, LogSeqTimeoutError } from './errors.js';

/**
 * How `LogseqClient.callAPI` sorts failures and reads answers (#206). Every test mocks `fetch`,
 * so nothing here touches a network, and each test builds its own client and answers.
 */

const TOKEN = 'secret-token-not-real-0001';
const API_URL = 'http://localhost:54321';

const realFetch = global.fetch;

function makeClient(overrides: { timeoutMs?: number } = {}): LogseqClient {
  return new LogseqClient({ apiUrl: API_URL, authToken: TOKEN, ...overrides });
}

function answerWith(body: unknown): void {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body }) as any;
}

function failWith(reason: unknown): void {
  global.fetch = vi.fn().mockRejectedValue(reason) as any;
}

/** A Node-style network error: a message and, optionally, a string `code` */
function networkError(message: string, code?: string): Error {
  const error = new Error(message);
  if (code !== undefined) (error as Error & { code?: string }).code = code;
  return error;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('LogseqClient.callAPI failures and answers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  describe('what counts as "LogSeq is not running"', () => {
    // Each source is tried alone: the message is chosen to match none of the others, so only
    // the one condition under test can produce LogSeqNotRunningError.
    it.each(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'])(
      'treats the code %s alone as not running',
      async code => {
        failWith(networkError('socket trouble', code));

        const error = await caught(makeClient().callAPI('logseq.App.getVersion'));

        expect(error).toBeInstanceOf(LogSeqNotRunningError);
        expect((error as Error).message).toContain(API_URL);
        expect((error as Error).message).toContain('socket trouble');
      }
    );

    it('treats the message "fetch failed" alone (no code) as not running', async () => {
      failWith(networkError('fetch failed'));

      await expect(makeClient().callAPI('logseq.App.getVersion')).rejects.toBeInstanceOf(LogSeqNotRunningError);
    });

    it('treats a message that mentions ECONNREFUSED alone (no code) as not running', async () => {
      failWith(networkError('connect ECONNREFUSED 127.0.0.1:54321'));

      await expect(makeClient().callAPI('logseq.App.getVersion')).rejects.toBeInstanceOf(LogSeqNotRunningError);
    });

    it('re-throws an unrelated error as the same object, not as a LogSeq error', async () => {
      const error = networkError('certificate has expired', 'CERT_HAS_EXPIRED');
      failWith(error);

      const thrown = await caught(makeClient().callAPI('logseq.App.getVersion'));

      expect(thrown).toBe(error);
      expect(thrown).not.toBeInstanceOf(LogSeqNotRunningError);
      expect(thrown).not.toBeInstanceOf(LogSeqTimeoutError);
    });

    it('re-throws an error with no code and an unrelated message untouched', async () => {
      const error = new Error('something else broke');
      failWith(error);

      await expect(makeClient().callAPI('logseq.App.getVersion')).rejects.toBe(error);
    });

    it('re-throws a rejection that is not an Error as it came, even when it looks like a refused connection', async () => {
      // Not an Error, so none of the checks apply: reading `.message.includes` on it would throw
      // a TypeError, and `code` alone must not turn it into LogSeqNotRunningError
      const lookalike = { code: 'ECONNREFUSED', name: 'TimeoutError' };
      failWith(lookalike);

      await expect(makeClient().callAPI('logseq.App.getVersion')).rejects.toBe(lookalike);
    });

    it('re-throws a string rejection as it came', async () => {
      failWith('boom');

      await expect(makeClient().callAPI('logseq.App.getVersion')).rejects.toBe('boom');
    });

    it('re-throws a malformed JSON body as a SyntaxError, not as not running', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('Unexpected token < in JSON'); }
      }) as any;

      const error = await caught(makeClient().callAPI('logseq.App.getVersion'));

      expect(error).toBeInstanceOf(SyntaxError);
      expect(error).not.toBeInstanceOf(LogSeqNotRunningError);
    });
  });

  describe('what counts as a timeout', () => {
    it('reports a TimeoutError name alone as a timeout, even with a refused-connection code', async () => {
      const error = networkError('fetch failed', 'ECONNREFUSED');
      error.name = 'TimeoutError';
      failWith(error);

      const thrown = await caught(makeClient({ timeoutMs: 777 }).callAPI('logseq.App.getVersion'));

      expect(thrown).toBeInstanceOf(LogSeqTimeoutError);
      expect(thrown).not.toBeInstanceOf(LogSeqNotRunningError);
      expect((thrown as Error).message).toContain('777ms');
    });

    it('reports an AbortError name alone as a timeout, even with "fetch failed" as its message', async () => {
      const error = networkError('fetch failed');
      error.name = 'AbortError';
      failWith(error);

      await expect(makeClient().callAPI('logseq.App.getVersion')).rejects.toBeInstanceOf(LogSeqTimeoutError);
    });
  });

  describe('what counts as an API error answer', () => {
    it('turns a 200 answer of {"error": "MethodNotExist: ..."} into an error', async () => {
      answerWith({ error: 'MethodNotExist: logseq.Editor.noSuchMethod' });

      await expect(makeClient().callAPI('logseq.Editor.noSuchMethod')).rejects.toThrow(
        'LogSeq API error: MethodNotExist: logseq.Editor.noSuchMethod'
      );
    });

    it('does not take an array of rows for an error', async () => {
      answerWith([[{ id: 1 }]]);

      expect(await makeClient().callAPI('logseq.DB.datascriptQuery')).toEqual([[{ id: 1 }]]);
    });

    it('returns an object without an error key as it is', async () => {
      answerWith({ id: 7, name: 'my page' });

      expect(await makeClient().callAPI('logseq.Editor.getPage')).toEqual({ id: 7, name: 'my page' });
    });

    // LogSeq answers getVersion with a string, and null, 0 or false are valid answers too.
    // `'error' in x` throws a TypeError for a primitive, so each must be kept away from it.
    it.each([
      ['a string', '0.10.15'],
      ['a number', 42],
      ['null', null],
      ['zero', 0],
      ['false', false],
      ['true', true],
      ['an empty string', '']
    ])('returns %s as it is', async (_label, value) => {
      answerWith(value);

      expect(await makeClient().callAPI('logseq.App.getVersion')).toBe(value);
    });

    it('does not mistake a string that contains the word error for an error answer', async () => {
      answerWith('error');

      expect(await makeClient().callAPI('logseq.App.getVersion')).toBe('error');
    });
  });

  describe('the auth token', () => {
    it('is sent only in the Authorization header, not in the URL or the body', async () => {
      answerWith({});
      const client = makeClient();

      await client.callAPI('logseq.App.getVersion', ['x']);

      const [url, init] = (global.fetch as any).mock.calls[0];
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(url).not.toContain(TOKEN);
      expect(init.body).not.toContain(TOKEN);
    });

    const failures: Array<[string, () => void, (client: LogseqClient) => Promise<unknown>]> = [
      ['a rejected token (401)', () => {
        global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' }) as any;
      }, c => c.callAPI('logseq.App.getVersion')],
      ['another HTTP failure (500)', () => {
        global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' }) as any;
      }, c => c.callAPI('logseq.App.getVersion')],
      ['a timeout', () => failWith(new DOMException('timed out', 'TimeoutError')), c => c.callAPI('logseq.App.getVersion')],
      ['a refused connection', () => failWith(networkError('fetch failed', 'ECONNREFUSED')), c => c.callAPI('logseq.App.getVersion')],
      ['an API error answer', () => answerWith({ error: 'MethodNotExist: x' }), c => c.callAPI('x')],
      ['a failed Datalog query', () => answerWith({ error: 'Unknown function' }), c => c.executeDatalogQuery('[:find ?x]', 'a')]
    ];

    it.each(failures)('is not in the message or stack of %s', async (_label, arrange, run) => {
      arrange();

      const error = (await caught(run(makeClient()))) as Error;

      expect(error.message).not.toContain(TOKEN);
      expect(String(error.stack)).not.toContain(TOKEN);
    });

    it('is not in the message of the 401 error, which names the URL instead', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' }) as any;

      const error = await caught(makeClient().callAPI('logseq.App.getVersion'));

      expect(error).toBeInstanceOf(LogSeqAuthError);
      expect((error as Error).message).toContain(API_URL);
      expect((error as Error).message).not.toContain(TOKEN);
    });
  });

  describe('executeDatalogQuery', () => {
    it('sends every input as the JSON text of its value, after the query, in one args list', async () => {
      answerWith([]);

      await makeClient().executeDatalogQuery('[:find ?p :in $ ?a ?b ?c]', 'x y', ['n1', 'n2'], null);

      const [, init] = (global.fetch as any).mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({
        method: 'logseq.DB.datascriptQuery',
        args: ['[:find ?p :in $ ?a ?b ?c]', '"x y"', '["n1","n2"]', 'null']
      });
    });

    it('does not encode the query itself', async () => {
      answerWith([]);
      const query = '[:find ?p :where [?p :block/name "q"]]';

      await makeClient().executeDatalogQuery(query);

      const [, init] = (global.fetch as any).mock.calls[0];
      expect(JSON.parse(init.body).args[0]).toBe(query);
    });

    it('rejects with the API error when LogSeq answers a bad query with an error body', async () => {
      answerWith({ error: 'Unknown function clojure.string/lower-case' });

      await expect(makeClient().executeDatalogQuery('[:find ?x]')).rejects.toThrow(
        'LogSeq API error: Unknown function clojure.string/lower-case'
      );
    });
  });
});
