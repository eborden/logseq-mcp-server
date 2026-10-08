import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { LogseqClient, LogSeqAuthError, LogSeqNotRunningError, LogSeqTimeoutError, isInfrastructureError } from '../../scripts/lib/logseq-api.js';
import {
  FIXTURE_SENTINEL_PAGE,
  FIXTURE_VERSION,
  FixtureGraphError,
  requireFixtureGraph,
} from '../integration/helpers/fixture-graph.js';

// Unit tests for the fixture graph (#87): the guard against a mocked client, and the committed
// files it depends on. Every integration suite runs it through connectFixture (#90).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const graphDir = join(repoRoot, 'tests/fixtures/graph');

function clientReturning(rows: unknown): { client: LogseqClient; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue(rows);
  return { client: { executeDatalogQuery: query } as unknown as LogseqClient, query };
}

const sentinel = (properties: unknown) => [[{ id: 7, name: FIXTURE_SENTINEL_PAGE, properties }]];

describe('requireFixtureGraph', () => {
  it('passes against the fixture and makes one Datalog query for the sentinel page', async () => {
    const { client, query } = clientReturning(sentinel({ 'fixture-version': FIXTURE_VERSION }));
    await expect(requireFixtureGraph(client)).resolves.toBe(FIXTURE_VERSION);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain(':block/name ?page-name');
    expect(query.mock.calls[0].slice(1)).toEqual([FIXTURE_SENTINEL_PAGE]);
  });

  it('accepts the version as text, as a one-element set, or under the camelCase key', async () => {
    for (const properties of [
      { 'fixture-version': `${FIXTURE_VERSION}` },
      { 'fixture-version': [FIXTURE_VERSION] },
      { 'fixture-version': [`${FIXTURE_VERSION}`] },
      { fixtureVersion: FIXTURE_VERSION },
    ]) {
      await expect(requireFixtureGraph(clientReturning(sentinel(properties)).client)).resolves.toBe(FIXTURE_VERSION);
    }
  });

  it('fails loud, pointing to setup.md, when another graph is open', async () => {
    for (const rows of [[], null]) {
      const run = requireFixtureGraph(clientReturning(rows).client);
      await expect(run).rejects.toBeInstanceOf(FixtureGraphError);
      await expect(run).rejects.toThrow(/not serving the fixture graph.*tests\/integration\/setup\.md/s);
    }
  });

  it('fails when the sentinel page has no usable fixture-version', async () => {
    for (const properties of [
      undefined,
      {},
      { 'fixture-version': 'one' },
      { 'fixture-version': 1.5 },
      { 'fixture-version': [] },
      { 'fixture-version': [1, 2] },
    ]) {
      const run = requireFixtureGraph(clientReturning(sentinel(properties)).client);
      await expect(run).rejects.toThrow(FixtureGraphError);
      await expect(run).rejects.toThrow(/no integer fixture-version.*setup\.md/s);
    }
  });

  it('fails when the open fixture is a different version', async () => {
    const run = requireFixtureGraph(clientReturning(sentinel({ 'fixture-version': FIXTURE_VERSION + 1 })).client);
    await expect(run).rejects.toThrow(FixtureGraphError);
    await expect(run).rejects.toThrow(`expect version ${FIXTURE_VERSION}`);
  });

  it('lets connection, timeout and auth errors through unchanged', async () => {
    const apiUrl = 'http://127.0.0.1:12315';
    const errors = [new LogSeqNotRunningError(apiUrl), new LogSeqTimeoutError(apiUrl, 30000), new LogSeqAuthError(apiUrl)];
    for (const error of errors) {
      expect(isInfrastructureError(error), error.name).toBe(true);
      const client = { executeDatalogQuery: vi.fn().mockRejectedValue(error) } as unknown as LogseqClient;
      await expect(requireFixtureGraph(client), error.name).rejects.toBe(error);
    }
  });
});

describe('fixture graph files (tests/fixtures/graph)', () => {
  it('has the file-graph layout LogSeq opens', () => {
    for (const path of ['pages', 'journals', 'logseq/config.edn']) {
      expect(existsSync(join(graphDir, path)), path).toBe(true);
    }
  });

  it('the sentinel page carries the fixture-version the guard expects', () => {
    const text = readFileSync(join(graphDir, `pages/${FIXTURE_SENTINEL_PAGE}.md`), 'utf-8');
    // Page properties sit on the first lines of the file, before any block.
    expect(text.split('\n')[0]).toBe(`fixture-version:: ${FIXTURE_VERSION}`);
  });

  it('keeps the README out of the graph folder, where LogSeq would index it as a page (#139)', () => {
    expect(existsSync(join(graphDir, '..', 'README.md'))).toBe(true);
    // LogSeq 0.10.15 applies :hidden on only one load path, so config.edn is no defence.
    const config = readFileSync(join(graphDir, 'logseq/config.edn'), 'utf-8');
    const withoutComments = config.split('\n').filter(line => !line.trimStart().startsWith(';')).join('\n');
    expect(withoutComments).not.toMatch(/:hidden\b/);
    // Only the graph itself may sit here. Everything else LogSeq finds becomes a page.
    // Dotfiles (.DS_Store, a .git from git auto-commit) are not pages; LogSeq skips them.
    const visible = (name: string) => !name.startsWith('.');
    expect(readdirSync(graphDir).filter(visible).sort()).toEqual(['journals', 'logseq', 'pages']);
    for (const dir of ['pages', 'journals']) {
      const strays = readdirSync(join(graphDir, dir)).filter(name => visible(name) && !name.endsWith('.md'));
      expect(strays, dir).toEqual([]);
    }
  });
});

describe('.gitignore and the fixture graph', () => {
  /** The paths git ignores, ignoring the developer's global excludes file (as in repo-hygiene.test.ts). */
  function ignored(paths: string[]): string[] {
    try {
      return execFileSync(
        'git',
        ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '--stdin'],
        { cwd: repoRoot, encoding: 'utf-8', input: paths.join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'] },
      )
        .split('\n')
        .filter(Boolean);
    } catch (error) {
      // check-ignore exits 1 when nothing is ignored.
      const e = error as { status?: number; stdout?: string };
      if (e.status === 1) return [];
      throw error;
    }
  }

  it('ignores the files LogSeq writes when it opens the folder', () => {
    const generated = [
      'tests/fixtures/graph/logseq/custom.css',
      'tests/fixtures/graph/logseq/bak/pages/x/2026_01_01T00_00_00.000Z.Desktop.md',
      'tests/fixtures/graph/logseq/.recycle/pages_x.md',
      'tests/fixtures/graph/logseq/version-files/base/pages/x.md',
      'tests/fixtures/graph/pages/contents.md',
      'tests/fixtures/graph/journals/2026_01_01.md',
      'tests/fixtures/graph/journals/2031_12_31.md',
    ];
    const hit = new Set(ignored(generated));
    expect(generated.filter(p => !hit.has(p))).toEqual([]);
  });

  it('keeps the hand-written fixture files', () => {
    const kept = [
      'tests/fixtures/graph/logseq/config.edn',
      'tests/fixtures/README.md',
      `tests/fixtures/graph/pages/${FIXTURE_SENTINEL_PAGE}.md`,
      'tests/fixtures/graph/pages/project atlas___notes.md',
      'tests/fixtures/graph/journals/2025_01_01.md',
      'tests/fixtures/graph/journals/2024_12_31.md',
    ];
    expect(ignored(kept)).toEqual([]);
  });
});
