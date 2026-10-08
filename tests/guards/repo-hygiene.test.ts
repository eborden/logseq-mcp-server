import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Mechanical check for the no-graph-data-in-repo rule (#95, CLAUDE.md Privacy).
// Raw output from the integration tests and from scripts/probe-* and
// scripts/measure-* is read from the maintainer's personal graph and can hold
// real page names. Those scripts only print to stdout, so a dump exists only
// when someone redirects it to a file (`... > measure-api-calls.txt`). This test
// fails when such a file is tracked, and when .gitignore stops ignoring one.
// It needs git and a checkout with .git (CI's actions/checkout has both).

const here = dirname(fileURLToPath(import.meta.url));

function git(args: string[], input?: string, cwd = repoRoot()): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    // `git check-ignore` exits 1 when no path is ignored; that is an answer, not a failure.
    const e = error as { status?: number; stdout?: string };
    if (args.includes('check-ignore') && e.status === 1) return e.stdout ?? '';
    throw new Error(
      `git ${args.join(' ')} failed. The repo hygiene test needs git and a checkout with .git: ${String(error)}`,
    );
  }
}

let root: string | undefined;
/** Repo root, so every path below is relative to it (git resolves paths against cwd). */
function repoRoot(): string {
  root ??= git(['rev-parse', '--show-toplevel'], undefined, here).trim();
  return root;
}

const lines = (text: string) => text.split('\n').filter(line => line.length > 0);

/**
 * A kind of raw-output file, matched on the lowercased basename, with sample paths .gitignore must
 * ignore. Case: the tracked-file check is case-insensitive (`Debug.LOG` fails it), but .gitignore is
 * case-sensitive on Linux and only lists the lowercase patterns, so it won't hide an upper-case dump
 * from `git add`. The tracked-file check is the stricter side and catches that case in CI. Samples
 * are lowercase for that reason.
 */
interface RawOutputRule {
  name: string;
  matches: (lowerBasename: string) => boolean;
  samples: string[];
}

// Extensions a redirected or saved dump of a probe/measure script is likely to have.
const DUMP_EXTENSIONS = ['txt', 'json', 'md', 'csv', 'tsv'];

const RAW_OUTPUT_RULES: RawOutputRule[] = [
  {
    name: '*.log',
    matches: b => b.endsWith('.log'),
    samples: ['vitest.log', 'scripts/run.log', 'tests/integration/debug.log'],
  },
  {
    name: 'output.txt, *-output.txt',
    matches: b => b === 'output.txt' || b.endsWith('-output.txt'),
    samples: ['output.txt', 'scripts/output.txt', 'test-output.txt', 'scripts/probe-output.txt', 'tests/integration/run-output.txt'],
  },
  {
    name: 'integration-test-output*',
    matches: b => b.startsWith('integration-test-output'),
    samples: ['integration-test-output.txt', 'integration-test-output.json', 'tests/integration-test-output-2.md'],
  },
  {
    name: '*.out',
    matches: b => b.endsWith('.out'),
    samples: ['probe.out', 'scripts/measure.out'],
  },
  {
    // Redirected or saved dumps of scripts/probe-*.ts and scripts/measure-*.ts, named after the script.
    name: `probe-*, measure-* (.${DUMP_EXTENSIONS.join(', .')})`,
    matches: b => new RegExp(`^(probe|measure)-.*\\.(${DUMP_EXTENSIONS.join('|')})$`).test(b),
    samples: [
      'probe-constraints.txt',
      'measure-api-calls.txt',
      'scripts/measure-output-size.txt',
      ...DUMP_EXTENSIONS.map(ext => `probe-results.${ext}`),
      ...DUMP_EXTENSIONS.map(ext => `scripts/measure-results.${ext}`),
    ],
  },
];

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Paths that look like raw test, probe or measure output, with the rule each one breaks. */
function findRawOutputFiles(paths: string[]): { path: string; rule: string }[] {
  return paths.flatMap(path => {
    const name = basename(path).toLowerCase();
    const rule = RAW_OUTPUT_RULES.find(r => r.matches(name));
    return rule ? [{ path, rule: rule.name }] : [];
  });
}

/**
 * The subset of `paths` that the repo's .gitignore files ignore, whether or not they exist or are
 * tracked. `core.excludesFile=/dev/null` turns off the developer's global ignore file (including the
 * default ~/.config/git/ignore), so a pattern dropped from .gitignore fails locally as it does in CI.
 * A clone's own .git/info/exclude still applies; CI's fresh checkout has none.
 */
function ignoredByGitignore(paths: string[]): Set<string> {
  return new Set(
    lines(git(['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '--stdin'], paths.join('\n') + '\n')),
  );
}

describe('findRawOutputFiles (synthetic paths)', () => {
  it('flags logs, *-output.txt, integration dumps, .out files and probe/measure dumps', () => {
    const flagged = findRawOutputFiles([
      'debug.log',
      'tests/integration/run-output.txt',
      'integration-test-output.txt',
      'scripts/measure.out',
      'measure-api-calls.txt',
      'probe-constraints.txt',
    ]);
    expect(flagged.map(f => f.path)).toEqual([
      'debug.log',
      'tests/integration/run-output.txt',
      'integration-test-output.txt',
      'scripts/measure.out',
      'measure-api-calls.txt',
      'probe-constraints.txt',
    ]);
    expect(flagged[0].rule).toBe('*.log');
  });

  it('matches names case-insensitively, including a bare output.txt and json/md probe dumps', () => {
    const paths = ['Debug.LOG', 'OUTPUT.txt', 'Integration-Test-Output.txt', 'Probe-Results.JSON', 'scripts/measure-run.md'];
    expect(findRawOutputFiles(paths).map(f => f.path)).toEqual(paths);
  });

  it('leaves source, docs and fixtures alone', () => {
    expect(
      findRawOutputFiles([
        'scripts/probe-constraints.ts',
        'scripts/measure-api-calls.ts',
        'scripts/measure-output-size.ts',
        'src/utils/result-meta.ts',
        'docs/output-format.md',
        'tests/fixtures/my-page/pages.txt',
        'logs/README.md',
        'LICENSE',
      ]),
    ).toEqual([]);
  });

  it('every rule matches its own samples', () => {
    for (const rule of RAW_OUTPUT_RULES) {
      expect(rule.samples.filter(s => !rule.matches(basename(s).toLowerCase())), rule.name).toEqual([]);
    }
  });
});

describe('repo hygiene: no raw graph output tracked (#95)', () => {
  it('no tracked file looks like raw test, probe or measure output', () => {
    const tracked = lines(git(['ls-files']));
    expect(tracked.length, 'git ls-files listed no files').toBeGreaterThan(0);
    // A hit here is probably real graph data. Remove it with `git rm --cached <path>`
    // and keep it out of commits, PRs and issues (CLAUDE.md, Privacy).
    expect(findRawOutputFiles(tracked)).toEqual([]);
  });

  it('.gitignore ignores every raw-output pattern', () => {
    const samples = RAW_OUTPUT_RULES.flatMap(r => r.samples);
    const ignored = ignoredByGitignore(samples);
    expect(samples.filter(s => !ignored.has(s))).toEqual([]);
  });

  it('.gitignore ignores a redirected dump of every probe and measure script', () => {
    const scripts = lines(git(['ls-files', 'scripts'])).filter(p =>
      /^scripts\/(probe|measure)-[^/]+\.ts$/.test(p),
    );
    // The three scripts named in CLAUDE.md's Privacy section; a rename should update this test.
    expect(scripts).toEqual(
      expect.arrayContaining([
        'scripts/probe-constraints.ts',
        'scripts/measure-api-calls.ts',
        'scripts/measure-output-size.ts',
      ]),
    );
    const dumps = scripts.flatMap(script => {
      const base = basename(script).replace(/\.ts$/, '');
      return [`${base}.txt`, `${base}-output.txt`, `${base}.log`, `${base}.out`, `scripts/${base}.txt`];
    });
    expect(findRawOutputFiles(dumps).map(f => f.path)).toEqual(dumps);
    const ignored = ignoredByGitignore(dumps);
    expect(dumps.filter(d => !ignored.has(d))).toEqual([]);
  });

  it('.gitignore does not ignore the scripts or this test', () => {
    // Guard against an over-broad pattern (e.g. `probe-*`) ignoring the scripts themselves.
    const ignored = ignoredByGitignore(['scripts/probe-constraints.ts', 'scripts/measure-api-calls.ts', 'src/repo-hygiene.test.ts']);
    expect([...ignored]).toEqual([]);
  });
});
