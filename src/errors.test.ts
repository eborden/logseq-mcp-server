import { describe, it, expect } from 'vitest';
import {
  AmbiguousPageError,
  BlockNotFoundError,
  InvalidParameterError,
  LogSeqAuthError,
  LogSeqNotRunningError,
  LogSeqResponseError,
  LogSeqTimeoutError,
  PageNotFoundError,
  PropertyNotFoundError,
  isInfrastructureError,
} from './errors.js';
import type { PageCandidate } from './types.js';

const candidate = (originalName: string, reason: string): PageCandidate => ({
  name: originalName.toLowerCase(),
  originalName,
  matchedBy: 'alias',
  reason,
});

const API_URL = 'http://localhost:12315';

describe('every error class', () => {
  const cases: Array<[string, () => Error]> = [
    ['PageNotFoundError', () => new PageNotFoundError('my page')],
    ['AmbiguousPageError', () => new AmbiguousPageError('my page', [candidate('Alice', 'alias of Bob')])],
    ['BlockNotFoundError', () => new BlockNotFoundError('uuid-1')],
    ['PropertyNotFoundError', () => new PropertyNotFoundError('status', 'done')],
    ['InvalidParameterError', () => new InvalidParameterError('depth', 9, 'a number')],
    ['LogSeqNotRunningError', () => new LogSeqNotRunningError(API_URL)],
    ['LogSeqTimeoutError', () => new LogSeqTimeoutError(API_URL, 500)],
    ['LogSeqAuthError', () => new LogSeqAuthError(API_URL)],
    ['LogSeqResponseError', () => new LogSeqResponseError('logseq.Editor.getPage', '[0].id', 'expected number')],
  ];

  it.each(cases)('%s is an Error whose name is its class name, and whose message is not empty', (name, make) => {
    const error = make();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.constructor.name).toBe(name);
    expect(error.message.length).toBeGreaterThan(0);
    expect(String(error).startsWith(`${name}: `)).toBe(true);
  });
});

describe('PageNotFoundError', () => {
  it('keeps the name it was given and an empty suggestion list by default', () => {
    const error = new PageNotFoundError('project atlas');

    expect(error.pageName).toBe('project atlas');
    expect(error.suggestions).toEqual([]);
  });

  it('quotes the name as a JSON string, so a quote in it is escaped', () => {
    const error = new PageNotFoundError('say "hi"');

    expect(error.pageName).toBe('say "hi"');
    expect(error.message.startsWith('No page "say \\"hi\\"".')).toBe(true);
  });

  it('says nothing about closest names when there are none', () => {
    const error = new PageNotFoundError('project atlas', []);

    expect(error.message).not.toContain('Closest');
    expect(error.message.startsWith('No page "project atlas". Try ')).toBe(true);
  });

  it('lists the closest names in order, each separated by a comma, before the next steps', () => {
    const error = new PageNotFoundError('project atlas', ['Project Atlas 2', 'Atlas']);

    expect(error.suggestions).toEqual(['Project Atlas 2', 'Atlas']);
    expect(error.message.startsWith('No page "project atlas". Closest: Project Atlas 2, Atlas. Try ')).toBe(true);
  });

  it('lists one suggestion with no separator', () => {
    const error = new PageNotFoundError('project atlas', ['Atlas']);

    expect(error.message).toContain('Closest: Atlas. Try');
  });

  it('points at the two tools that find a page, and says how each helps', () => {
    const { message } = new PageNotFoundError('project atlas');

    expect(message).toMatch(/logseq_search_blocks to find it by content/);
    expect(message).toMatch(/logseq_list_pages \(name_contains\) to browse names\.$/);
  });
});

describe('AmbiguousPageError', () => {
  const pages = [candidate('Alice', 'alias of Bob'), candidate('Alice Smith', 'namespace leaf')];

  it('keeps its inputs, and a total that defaults to the number of candidates', () => {
    const error = new AmbiguousPageError('al', pages);

    expect(error.pageName).toBe('al');
    expect(error.candidates).toEqual(pages);
    expect(error.totalCandidates).toBe(2);
  });

  it('lists every candidate by quoted original name and reason, in order, then asks for an exact name', () => {
    const error = new AmbiguousPageError('al', pages);

    expect(error.message).toBe(
      '"al" matches 2 pages: "Alice" (alias of Bob); "Alice Smith" (namespace leaf). ' +
      'Repeat the call with the exact name of one of them.'
    );
  });

  it('quotes an original name that holds a quote', () => {
    const error = new AmbiguousPageError('x', [candidate('The "big" one', 'alias')]);

    expect(error.message).toContain('"The \\"big\\" one" (alias)');
  });

  it('does not call a list that is complete truncated: no note, no "more", even at the boundary', () => {
    const error = new AmbiguousPageError('al', pages, 2);

    expect(error.truncationNote).toBeUndefined();
    expect(error.message).not.toContain(' more');
    expect(error.message).not.toContain('Showing');
    expect(error.message).toContain('matches 2 pages');
  });

  it('keeps the note unset when the total is below the list, which cannot be cut', () => {
    const error = new AmbiguousPageError('al', pages, 1);

    expect(error.truncationNote).toBeUndefined();
    expect(error.message).not.toContain('Showing');
    expect(error.message).not.toContain(' more');
  });

  it('says so when the list was cut: the count shown, the total, how many more, and how to narrow down', () => {
    const error = new AmbiguousPageError('al', pages, 5);

    expect(error.totalCandidates).toBe(5);
    expect(error.truncationNote).toBe(
      "Showing 2 of 5, the most this lists; the rest can't be fetched in one call. " +
      'To narrow it down, call logseq_list_pages with name_contains set to part of the page name you mean, ' +
      'or use its full namespaced name.'
    );
    expect(error.message).toBe(
      '"al" matches 5 pages: "Alice" (alias of Bob); "Alice Smith" (namespace leaf) and 3 more. ' +
      `${error.truncationNote} ` +
      'Repeat the call with the exact name of one of them.'
    );
  });

  it('counts one hidden page as one more', () => {
    const error = new AmbiguousPageError('al', pages, 3);

    expect(error.message).toContain('(namespace leaf) and 1 more. Showing 2 of 3,');
  });

  it('puts the cut note inside the message, before the closing instruction', () => {
    const error = new AmbiguousPageError('al', pages, 9);
    const note = error.message.indexOf('Showing 2 of 9');
    const repeat = error.message.indexOf('Repeat the call');

    expect(note).toBeGreaterThan(0);
    expect(repeat).toBeGreaterThan(note);
  });
});

describe('BlockNotFoundError', () => {
  it('quotes the uuid and tells where uuids come from', () => {
    const error = new BlockNotFoundError('00000000-0000-4000-8000-000000000001');

    expect(error.message).toBe(
      'Block not found: "00000000-0000-4000-8000-000000000001"\n\n' +
      'Tip: Block UUIDs come from search results or page queries. Verify the UUID is correct.'
    );
  });
});

describe('PropertyNotFoundError', () => {
  it('quotes the key and the value, then tips that properties are case-sensitive', () => {
    const error = new PropertyNotFoundError('status', 'done');

    expect(error.message).toBe(
      'No blocks found with property "status" = "done"\n\n' +
      'Tip: Check property spelling and value. Properties are case-sensitive.'
    );
  });
});

describe('InvalidParameterError', () => {
  it('names the parameter, the value it got and what was expected, with no example line when none is given', () => {
    const error = new InvalidParameterError('depth', 9, 'a number from 1 to 3');

    expect(error.message).toBe("Invalid parameter 'depth': 9\n\nExpected: a number from 1 to 3");
    expect(error.message).not.toContain('Example');
  });

  it('adds the example on its own line after what was expected', () => {
    const error = new InvalidParameterError('start', '2025-13-01', 'a date', '2025-01-31');

    expect(error.message).toBe("Invalid parameter 'start': 2025-13-01\n\nExpected: a date\nExample: 2025-01-31");
  });

  it('leaves out an empty example, like no example at all', () => {
    const error = new InvalidParameterError('a', 1, 'x', '');

    expect(error.message).toBe("Invalid parameter 'a': 1\n\nExpected: x");
  });
});

describe('LogSeqNotRunningError', () => {
  it('names the URL and gives the three steps to fix, in order', () => {
    const { message } = new LogSeqNotRunningError(API_URL);

    expect(message).toBe(
      `Cannot connect to LogSeq at ${API_URL}\n\n` +
      'Steps to fix:\n' +
      '1. Start LogSeq desktop application\n' +
      '2. Enable HTTP API server: Settings → Advanced → Enable HTTP API server\n' +
      "3. Verify API URL in ~/.logseq-mcp/config.json matches LogSeq's HTTP server port"
    );
  });

  it('shows the underlying error between the URL and the steps when there is one', () => {
    const { message } = new LogSeqNotRunningError(API_URL, new Error('connect ECONNREFUSED'));

    expect(message.startsWith(`Cannot connect to LogSeq at ${API_URL}\n\nError: connect ECONNREFUSED\n\nSteps to fix:\n1. `)).toBe(true);
  });

  it('has no "Error:" line without an underlying error', () => {
    expect(new LogSeqNotRunningError(API_URL).message).not.toContain('Error:');
  });
});

describe('LogSeqTimeoutError', () => {
  it('names the URL and the timeout in milliseconds, then the three steps to fix', () => {
    const { message } = new LogSeqTimeoutError(API_URL, 1234);

    expect(message).toBe(
      `LogSeq at ${API_URL} did not respond within 1234ms\n\n` +
      'Steps to fix:\n' +
      '1. Check that LogSeq is not busy (indexing, a stuck window or a very large graph)\n' +
      '2. Retry the request\n' +
      '3. To allow slower calls, raise "timeoutMs" in ~/.logseq-mcp/config.json (default 30000, per API call)'
    );
  });
});

describe('LogSeqAuthError', () => {
  it('names the URL and the HTTP status, then the three steps to fix', () => {
    const { message } = new LogSeqAuthError(API_URL);

    expect(message).toBe(
      `LogSeq at ${API_URL} rejected the auth token (HTTP 401)\n\n` +
      'Steps to fix:\n' +
      "1. The token is invalid or has been changed. Regenerate it in LogSeq's API settings\n" +
      '2. Update "authToken" in ~/.logseq-mcp/config.json\n' +
      '3. See tests/integration/setup.md for details'
    );
  });
});

describe('LogSeqResponseError', () => {
  // Built inside each test: an error made while the file is collected is covered by no test, and a mutant it
  // reaches is then run against the whole suite instead of the tests that look at it.
  const make = () => new LogSeqResponseError('logseq.Editor.getPage', '[0].id', 'Expected number, received string');

  it('exposes the method, the path and the problem as fields', () => {
    const error = make();

    expect(error.method).toBe('logseq.Editor.getPage');
    expect(error.path).toBe('[0].id');
    expect(error.problem).toBe('Expected number, received string');
  });

  it('puts method, path and problem in one line, then steps that name the version and the report', () => {
    const error = make();

    expect(error.message.split('\n')[0]).toBe(
      "LogSeq answered logseq.Editor.getPage in a shape this server can't read: [0].id: Expected number, received string"
    );
    expect(error.message).toMatch(/\n\nSteps to fix:\n1\. Check which LogSeq version is running\. This server is tested against LogSeq 0\.10\.x/);
    expect(error.message).toMatch(/\n2\. If the version is right, report this on the project's GitHub issues with the method name and the path above \(leave out page names and block text\)$/);
  });

  it('names the top-level path as (response)', () => {
    const top = new LogSeqResponseError('logseq.DB.datascriptQuery', '(response)', 'Expected array');

    expect(top.message).toContain('logseq.DB.datascriptQuery in a shape this server can\'t read: (response): Expected array\n');
  });
});

describe('isInfrastructureError', () => {
  it.each([
    ['LogSeqNotRunningError', new LogSeqNotRunningError(API_URL)],
    ['LogSeqTimeoutError', new LogSeqTimeoutError(API_URL, 10)],
    ['LogSeqAuthError', new LogSeqAuthError(API_URL)],
  ])('is true for %s', (_name, error) => {
    expect(isInfrastructureError(error)).toBe(true);
  });

  it.each([
    ['LogSeqResponseError', new LogSeqResponseError('m', 'p', 'q')],
    ['PageNotFoundError', new PageNotFoundError('x')],
    ['AmbiguousPageError', new AmbiguousPageError('x', [])],
    ['BlockNotFoundError', new BlockNotFoundError('x')],
    ['PropertyNotFoundError', new PropertyNotFoundError('k', 'v')],
    ['InvalidParameterError', new InvalidParameterError('p', 1, 'x')],
    ['a plain Error', new Error('boom')],
    ['a TypeError', new TypeError('boom')],
  ])('is false for %s', (_name, error) => {
    expect(isInfrastructureError(error)).toBe(false);
  });

  it('is false for anything that is not an Error instance, even one that looks like it', () => {
    expect(isInfrastructureError(undefined)).toBe(false);
    expect(isInfrastructureError(null)).toBe(false);
    expect(isInfrastructureError('LogSeqAuthError')).toBe(false);
    expect(isInfrastructureError({ name: 'LogSeqTimeoutError', message: 'x' })).toBe(false);
  });
});
