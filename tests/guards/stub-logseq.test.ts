import { describe, it, expect } from 'vitest';
import { request as httpRequest } from 'node:http';
import { callKey, DATASCRIPT_QUERY, LOGSEQ_PORT, startStubLogseq, type CannedCall } from '../../scripts/lib/stub-logseq.js';

/**
 * The stub LogSeq the Node tooling runs the server against (the measure scripts and the guard tests that start the
 * binary, scripts/lib/stub-logseq.ts). The parity test has its own stub, in Rust, with the same tests
 * (rust/tests/parity_harness.rs). It has to answer by method and query text, check its token, fail loud on a call it
 * has no answer for and wait for calls that arrive late (#340), or a number or a result taken from it means nothing.
 */

const q = (text: string, ...inputs: string[]): CannedCall => ({ method: DATASCRIPT_QUERY, args: [text, ...inputs], response: [] });

describe('the stub LogSeq', () => {
  it('answers by method and query text, checks the token, and fails loud on an unknown call', async () => {
    const stub = await startStubLogseq();
    try {
      expect(new URL(stub.apiUrl).port).not.toBe(String(LOGSEQ_PORT));
      stub.load([{ ...q('[:find ?a]', '"alice"'), response: [[1]] }]);
      const post = (body: unknown, token = stub.authToken) =>
        fetch(`${stub.apiUrl}/api`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

      const known = await post({ method: DATASCRIPT_QUERY, args: ['[:find\n ?a]', '"alice"'] });
      expect(await known.json()).toEqual([[1]]);
      expect((await post({ method: DATASCRIPT_QUERY, args: ['[:find ?a]'] }, 'wrong')).status).toBe(401);
      const unknown = await post({ method: DATASCRIPT_QUERY, args: ['[:find ?z]'] });
      expect(await unknown.json()).toHaveProperty('error');

      expect(stub.calls()).toHaveLength(2);
      expect(stub.failures()).toEqual([
        'request with a wrong or missing auth token',
        expect.stringContaining('no canned response for logseq.DB.datascriptQuery [:find ?z]')
      ]);
    } finally {
      await stub.close();
    }
  });

  const post = (stub: { apiUrl: string; authToken: string }, method: string) =>
    fetch(`${stub.apiUrl}/api`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${stub.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, args: [] })
    });
  const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const EDITOR = ['getCurrentPage', 'getCurrentBlock', 'getSelectedBlocks'].map(name => `logseq.Editor.${name}`);

  it('settles once every call of a step has arrived, though the first answer came back long before (#340)', async () => {
    const stub = await startStubLogseq();
    try {
      stub.load(EDITOR.map(method => ({ method, args: [], response: null })));
      // The first call is answered at once, as a tool that fails on the first answer would return; the others arrive late, last one first
      await post(stub, EDITOR[0]);
      const late = [post(stub, EDITOR[2]), wait(40).then(() => post(stub, EDITOR[1]))];
      let settled = false;
      const settling = stub.settle(3).then(() => {
        settled = true;
      });
      await wait(15);
      expect(settled, 'the third call has not come yet').toBe(false);
      await settling;
      expect([...stub.calls().map(call => call.method)].sort()).toEqual([...EDITOR].sort());
      expect(stub.failures()).toEqual([]);
      await Promise.all(late);
    } finally {
      await stub.close();
    }
  });

  it('does not settle while a request is still being read, even when the listed calls have all come (#340)', async () => {
    const stub = await startStubLogseq();
    try {
      stub.load([{ method: EDITOR[0], args: [], response: null }]);
      await post(stub, EDITOR[0]);
      // An extra call whose body is written slowly: the count is already reached, one request is mid-body
      const body = JSON.stringify({ method: EDITOR[1], args: [] });
      const request = httpRequest(`${stub.apiUrl}/api`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${stub.authToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      });
      request.on('response', response => response.resume());
      request.write(body.slice(0, 5));
      await wait(20);
      let settled = false;
      const settling = stub.settle(1).then(() => {
        settled = true;
      });
      await wait(60);
      expect(settled, 'one request is still being read').toBe(false);
      request.end(body.slice(5));
      await settling;
      expect(stub.calls().map(call => call.method)).toEqual([EDITOR[0], EDITOR[1]]);
    } finally {
      await stub.close();
    }
  });

  it('gives up after a quiet period when calls never come, so a server that makes too few shows as a failed comparison', async () => {
    const stub = await startStubLogseq();
    try {
      stub.load([]);
      const started = Date.now();
      await stub.settle(2, { quietMs: 30, maxMs: 5000 });
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(30);
      expect(waited).toBeLessThan(1000);
      expect(stub.calls()).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it('waits no longer than maxMs for a server that keeps calling, and not at all for 0', async () => {
    const stub = await startStubLogseq();
    try {
      stub.load([]);
      let calling = true;
      const keepCalling = (async () => {
        while (calling) {
          await post(stub, 'logseq.Editor.getCurrentPage');
          await wait(10);
        }
      })();
      const started = Date.now();
      await stub.settle(1000, { quietMs: 100, maxMs: 300 });
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(300);
      expect(waited).toBeLessThan(1500);
      const startedAgain = Date.now();
      await stub.settle(1000, { quietMs: 100, maxMs: 0 });
      expect(Date.now() - startedAgain).toBeLessThan(100);
      calling = false;
      await keepCalling;
    } finally {
      await stub.close();
    }
  });

  it('keys a query by its text without layout, and other methods by their args', () => {
    expect(callKey({ method: DATASCRIPT_QUERY, args: ['[:find\n   ?a]', '"x"'] })).toBe(`${DATASCRIPT_QUERY} [:find ?a]`);
    expect(callKey({ method: 'logseq.Editor.getPage', args: ['alice'] })).toBe('logseq.Editor.getPage ["alice"]');
  });
});
