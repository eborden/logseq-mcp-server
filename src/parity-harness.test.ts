import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getPageOutlineCases } from '../scripts/parity/cases/get-page-outline.js';
import {
  compareCalls,
  compareResult,
  perturbCases,
  readSnapshotEntry,
  runParity,
  TOOL_LIST_SNAPSHOT_KEY,
  type ParityCase,
  type ToolResult
} from '../scripts/parity/harness.js';
import { callKey, DATASCRIPT_QUERY, LOGSEQ_PORT, startStubLogseq, type CannedCall } from '../scripts/parity/stub-logseq.js';
import { REPO_ROOT, SNAPSHOT_FILE, typescriptServer, viteNodeCommand } from '../scripts/parity/ts-server.js';

/**
 * The differential parity harness (#124, ADR-0025 Decision 2). The end-to-end tests start the
 * TypeScript server over stdio, as the harness would start the Rust one, so they take a few
 * seconds each.
 */

const EXPECTED_FILE = join(REPO_ROOT, 'scripts', 'parity', 'expected', 'get-page-outline.json');
const loadExpected = async () => JSON.parse(await readFile(EXPECTED_FILE, 'utf8')) as Record<string, ToolResult>;

const q = (text: string, ...inputs: string[]): CannedCall => ({ method: DATASCRIPT_QUERY, args: [text, ...inputs], response: [] });

describe('compareCalls', () => {
  const a = q('[:find ?a]', '"alice"');
  const b = q('[:find ?b]', '"bob"');
  const c = { method: 'logseq.Editor.getAllPages', args: [], response: [] };

  it('accepts sequential calls in order, and concurrent ones in any order', () => {
    expect(compareCalls([[a], [b, c]], [a, c, b])).toEqual([]);
  });

  it('rejects sequential calls out of order', () => {
    expect(compareCalls([[a], [b]], [b, a])).toHaveLength(2);
  });

  it('rejects a changed input, a missing call and an extra one', () => {
    expect(compareCalls([[a]], [q('[:find ?a]', '"Alice"')])).toHaveLength(1);
    expect(compareCalls([[a], [b]], [a])).toHaveLength(1);
    expect(compareCalls([[a]], [a, b])).toEqual([expect.stringContaining('1 call(s) after the last step')]);
  });

  it('ignores how a query is laid out, not what it says', () => {
    expect(compareCalls([[q('[:find ?a :where [?a :block/name]]')]], [q('[:find ?a\n   :where\n   [?a :block/name]]')])).toEqual([]);
    expect(compareCalls([[q('[:find ?a]')]], [q('[:find ?b]')])).toHaveLength(1);
  });
});

describe('compareResult', () => {
  const result: ToolResult = { content: [{ type: 'text', text: '{"page":"Alice"}' }] };

  it('compares text byte for byte', () => {
    expect(compareResult(result, structuredClone(result))).toEqual([]);
    // Same JSON value, different bytes: still a difference (ADR-0009)
    expect(compareResult(result, { content: [{ type: 'text', text: '{"page": "Alice"}' }] })).toEqual([
      expect.stringContaining('differs at character 8')
    ]);
  });

  it('tells an absent isError from isError: false, and compares the number of content blocks', () => {
    expect(compareResult(result, { ...result, isError: false })).toEqual(['the result has unexpected key(s) isError']);
    expect(compareResult({ ...result, isError: false }, { ...result, isError: true })).toHaveLength(1);
    expect(compareResult(result, { content: [...result.content!, { type: 'text', text: '{}' }] })).toHaveLength(1);
  });

  it('fails on any key the TypeScript server did not send', () => {
    expect(compareResult(result, { ...result, structuredContent: { page: 'Alice' } })).toEqual([
      'the result has unexpected key(s) structuredContent'
    ]);
    expect(compareResult(result, { ...result, _meta: {} })).toHaveLength(1);
    expect(compareResult(result, { content: [{ ...result.content![0], annotations: { priority: 1 } }] })).toEqual([
      'content[0] has unexpected key(s) annotations'
    ]);
    expect(compareResult({ ...result, _meta: { a: 1 } }, { ...result, _meta: { a: 2 } })).toEqual([
      '_meta: expected {"a":1}, got {"a":2}'
    ]);
  });
});

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

  it('keys a query by its text without layout, and other methods by their args', () => {
    expect(callKey({ method: DATASCRIPT_QUERY, args: ['[:find\n   ?a]', '"x"'] })).toBe(`${DATASCRIPT_QUERY} [:find ?a]`);
    expect(callKey({ method: 'logseq.Editor.getPage', args: ['alice'] })).toBe('logseq.Editor.getPage ["alice"]');
  });
});

describe('the parity cases', () => {
  it('have an expected result each, recorded from the TypeScript server', async () => {
    const expected = await loadExpected();
    expect(Object.keys(expected).sort()).toEqual(getPageOutlineCases.map(c => c.name).sort());
  });

  it('read the tools/list snapshot that src/tool-list.test.ts writes', async () => {
    const entry = readSnapshotEntry(await readFile(SNAPSHOT_FILE, 'utf8'), TOOL_LIST_SNAPSHOT_KEY);
    expect(entry).toContain('"name": "logseq_get_page_outline"');
  });
});

describe('the server environment', () => {
  it('gives the server a sandboxed home, so a server that ignores LOGSEQ_MCP_CONFIG finds no fallback config', async () => {
    const report = await runParity({
      server: viteNodeCommand('env-report-server.ts'),
      cases: [{ name: 'env', tool: 'report_env', arguments: {}, steps: [] }],
      snapshotFile: SNAPSHOT_FILE
    });
    const text = report.results.env?.content?.[0]?.text;
    expect(typeof text, report.failures.join('\n')).toBe('string');
    const env = JSON.parse(text as string) as Record<string, string | null>;

    const dir = dirname(env.LOGSEQ_MCP_CONFIG!);
    expect(dir).toContain('logseq-parity-');
    expect(env.HOME).toBe(join(dir, 'home'));
    expect(env.HOME).not.toBe(homedir());
    expect(env.USERPROFILE).toBe(env.HOME);
    expect(env.XDG_CONFIG_HOME).toBe(join(env.HOME!, '.config'));
    expect(env.CFFIXED_USER_HOME).toBe(process.platform === 'darwin' ? env.HOME : null);
  }, 60000);
});

describe('runParity against the TypeScript server', () => {
  it('passes the TypeScript server against its own recorded results', async () => {
    const report = await runParity({
      server: typescriptServer(),
      cases: getPageOutlineCases,
      expected: await loadExpected(),
      snapshotFile: SNAPSHOT_FILE
    });
    expect(report.failures, report.stderr).toEqual([]);
  }, 60000);

  it('fails loud on a perturbed answer, a missing or reordered call, and a changed tools/list', async () => {
    const expected = await loadExpected();
    const withCalls = getPageOutlineCases.filter(c => c.steps.length > 0);
    const exact = getPageOutlineCases[0];
    const leaf = getPageOutlineCases.find(c => c.steps.length === 3)!;

    const broken: ParityCase[] = [
      ...perturbCases(withCalls),
      // The outline query's answer taken away: the stub has nothing to say to it
      { ...exact, name: 'missing answer', steps: [exact.steps[0], []] },
      // The leaf lookup listed after the outline query, as if they ran the other way round
      { ...leaf, name: 'reordered', steps: [leaf.steps[0], leaf.steps[2], leaf.steps[1]] }
    ];
    const brokenExpected = {
      ...expected,
      'missing answer': expected[exact.name],
      reordered: expected[leaf.name]
    };

    // A snapshot in which the outline tool has another name
    const dir = await mkdtemp(join(tmpdir(), 'parity-test-'));
    const snapshotFile = join(dir, 'tool-list.test.ts.snap');
    const snapshot = await readFile(SNAPSHOT_FILE, 'utf8');
    const changed = snapshot.replace('"name": "logseq_get_page_outline"', '"name": "logseq_get_page_outline_v2"');
    expect(changed).not.toBe(snapshot);
    await writeFile(snapshotFile, changed);

    try {
      const report = await runParity({
        server: typescriptServer(),
        cases: broken,
        expected: brokenExpected,
        snapshotFile
      });
      const failuresOf = (name: string) => report.failures.filter(f => f.startsWith(`[logseq_get_page_outline: ${name}]`));

      expect(report.failures).toContainEqual(expect.stringMatching(/^tools\/list differs from the snapshot/));
      for (const c of withCalls) expect(failuresOf(c.name), c.name).not.toEqual([]);
      expect(failuresOf('missing answer')).toContainEqual(expect.stringContaining('stub: no canned response'));
      expect(failuresOf('reordered')).toContainEqual(expect.stringContaining('LogSeq calls, step 2 of 3'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);
});
