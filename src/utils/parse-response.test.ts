import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod/v4';
import { LogseqClient } from '../client.js';
import { LogSeqResponseError, LogSeqTimeoutError, isInfrastructureError } from '../errors.js';
import { responses } from '../response-schemas.js';
import { callParsed, parseResponse, queryParsed } from './parse-response.js';

const block = { id: 5, uuid: '00000000-0000-4000-8000-000000000005', content: 'a block' };

describe('parseResponse', () => {
  it('returns the response itself: same object, same key order, nothing rebuilt', () => {
    const answer = { name: 'alice', id: 1, originalName: 'Alice', extra: { deep: [1, 2] } };

    const parsed = parseResponse(responses.editorPage, answer, 'm');

    expect(parsed).toBe(answer);
    expect(Object.keys(parsed!)).toEqual(['name', 'id', 'originalName', 'extra']);
  });

  it('returns a list as the very array it was given, with every row in its place', () => {
    const rows = [[block], [block]];

    expect(parseResponse(responses.blockRows, rows, 'm')).toBe(rows);
  });

  it('throws LogSeqResponseError for a response that does not match, and never returns it', () => {
    expect(() => parseResponse(z.object({ id: z.number() }), { id: 'x' }, 'logseq.Editor.getBlock')).toThrow(LogSeqResponseError);
  });

  it('is not an infrastructure error: the connection worked, the answer is the problem', () => {
    const error = new LogSeqResponseError('m', 'id', 'expected number');

    expect(isInfrastructureError(error)).toBe(false);
    expect(error.name).toBe('LogSeqResponseError');
  });
});

describe('callParsed and queryParsed', () => {
  it('pass the call to the client exactly as given, with no arguments when none are given', async () => {
    const callAPI = vi.fn(async () => null);
    const client = { callAPI } as unknown as LogseqClient;

    await callParsed(client, responses.editorPages, 'logseq.Editor.getAllPages');
    await callParsed(client, responses.editorPage, 'logseq.Editor.getPage', ['alice']);

    expect(callAPI).toHaveBeenNthCalledWith(1, 'logseq.Editor.getAllPages');
    expect(callAPI).toHaveBeenNthCalledWith(2, 'logseq.Editor.getPage', ['alice']);
  });

  it('send the Datalog inputs raw, for the client to encode', async () => {
    const executeDatalogQuery = vi.fn(async () => []);
    const client = { executeDatalogQuery } as unknown as LogseqClient;

    await queryParsed(client, responses.blockRows, '[:find ...]', 'my page', 3);

    expect(executeDatalogQuery).toHaveBeenCalledWith('[:find ...]', 'my page', 3);
  });

  it('name logseq.DB.datascriptQuery for a query that does not parse', async () => {
    const client = { executeDatalogQuery: vi.fn(async () => [[{ id: 1 }]]) } as unknown as LogseqClient;

    const error = await queryParsed(client, responses.blockRows, '[:find ...]').catch(e => e);

    expect(error).toBeInstanceOf(LogSeqResponseError);
    expect(error.method).toBe('logseq.DB.datascriptQuery');
    expect(error.path).toBe('[0][0].uuid');
  });

  it('let a connection error through untouched', async () => {
    const timeout = new LogSeqTimeoutError('http://x', 1000);
    const client = { callAPI: vi.fn(async () => { throw timeout; }) } as unknown as LogseqClient;

    await expect(callParsed(client, responses.editorPage, 'logseq.Editor.getPage', ['a'])).rejects.toBe(timeout);
  });
});
