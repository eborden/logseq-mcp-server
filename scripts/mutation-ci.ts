/**
 * The decisions and the report table of the CI mutation jobs (ADR-0026, #204).
 *
 * `plan` decides what the PR `mutation` job runs, `summary` turns Stryker's JSON report
 * into the per-file table for the job summary. Informational: neither fails a build, and
 * there is no baseline or ratchet here (#205).
 *
 * Runs on Node 24 as plain TypeScript (type stripping), so it imports `node:` modules only,
 * uses `import type` for types and has no enums. Unit tests: src/mutation-ci.test.ts.
 *
 *   node scripts/mutation-ci.ts plan --cache hit|miss --since <sha> [--out reports/mutation/plan.json]
 *   node scripts/mutation-ci.ts summary [--plan reports/mutation/plan.json] [--report reports/mutation/mutation.json]
 *
 * `plan` prints `mode=` and `mutate=` lines for $GITHUB_OUTPUT. Markdown goes to stdout from `summary`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Scope

/** The files Stryker mutates, read from the `mutate` globs of stryker.config.json. */
export interface MutateScope {
  /** Exact paths the config leaves out (`!src/types.ts`). */
  excluded: ReadonlySet<string>;
}

export function scopeFromConfig(config: { mutate: string[] }): MutateScope {
  const excluded = config.mutate.filter(g => g.startsWith('!') && !g.includes('*')).map(g => g.slice(1));
  return { excluded: new Set(excluded) };
}

/** True for a source file Stryker mutates: src/**\/*.ts, not a test, not one of the left-out files. */
export function inMutateScope(path: string, scope: MutateScope): boolean {
  return path.startsWith('src/') && path.endsWith('.ts') && !path.endsWith('.test.ts') && !scope.excluded.has(path);
}

const isUnitTest = (path: string) => path.startsWith('src/') && path.endsWith('.test.ts');

/** Inputs a result depends on that incremental mode can't see (ADR-0026, "Incremental mode has a blind spot"). */
const BLIND_SPOT_FILES = new Set([
  'package-lock.json',
  'vitest.config.ts',
  'vitest.mutation.config.ts',
  'stryker.config.json',
  'tsconfig.json',
]);

/**
 * A changed file that incremental mode can't see: the left-out sources and any other src/ file that
 * is not a test or mutated, `.snap` files, everything under tests/ that the unit suite can read
 * (helpers and fixtures, not the integration tests) and the config files above.
 */
export function isBlindSpot(path: string, scope: MutateScope): boolean {
  if (BLIND_SPOT_FILES.has(path) || path.endsWith('.snap')) return true;
  if (path.startsWith('tests/')) return !path.startsWith('tests/integration/');
  return path.startsWith('src/') && !isUnitTest(path) && !inMutateScope(path, scope);
}

// ---------------------------------------------------------------------------
// Plan

const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

/** The mutated source files a test file imports directly (`./x.js` and `../y/z.js` resolve to .ts). */
export function importedSources(
  testPath: string,
  testSource: string,
  scope: MutateScope,
  exists: (path: string) => boolean,
): string[] {
  const found = new Set<string>();
  for (const [, spec] of testSource.matchAll(IMPORT_SPEC)) {
    const target = posix.normalize(posix.join(posix.dirname(testPath), spec));
    const candidates = [
      target.replace(/\.js$/, '.ts'),
      `${target}.ts`,
      posix.join(target, 'index.ts'),
    ];
    const hit = candidates.find(c => inMutateScope(c, scope) && exists(c));
    if (hit) found.add(hit);
  }
  return [...found].sort();
}

/** Keys of `mutation-baseline.json` (#205) whose entry differs. The file's shape is #205's: read `files` when it has one. */
export function changedBaselineFiles(before: unknown, after: unknown): string[] {
  const entries = (doc: unknown): Record<string, unknown> => {
    if (typeof doc !== 'object' || doc === null) return {};
    const files = (doc as { files?: unknown }).files;
    const map = typeof files === 'object' && files !== null ? files : doc;
    return Object.fromEntries(Object.entries(map as Record<string, unknown>).filter(([k]) => k.startsWith('src/')));
  };
  const a = entries(before);
  const b = entries(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .sort();
}

export interface PlanInput {
  /** True when a restored incremental file matches a commit that is in this checkout's history. */
  cacheUsable: boolean;
  /** Paths changed since the commit the cache (or the PR base) is from, deleted ones included. */
  changed: string[];
  /** Paths among `changed` that no longer exist at HEAD. */
  deleted: string[];
  scope: MutateScope;
  /** Source text of a changed test file, at HEAD or (for a deleted one) at the old commit. */
  readTest: (path: string) => string | null;
  /** True when a path exists at HEAD. */
  exists: (path: string) => boolean;
  /** Source files whose `mutation-baseline.json` entry changed (empty until #205 adds the file). */
  baselineChanged: string[];
}

export type PlanMode = 'incremental' | 'targeted' | 'empty';

export interface Plan {
  mode: PlanMode;
  /** For `targeted`: the files passed to --mutate. Empty otherwise. */
  mutate: string[];
  /** Why the cache-miss path was taken, or [] for `incremental`. */
  reasons: string[];
  changedSources: string[];
  fromBaseline: string[];
  fromTests: string[];
}

/**
 * Whole scope, incrementally, when a usable cache exists and nothing it can't see changed.
 * Otherwise the cache-miss path: only the files a PR touches, never a cold full run (ADR-0026).
 */
export function plan(input: PlanInput): Plan {
  const { scope, changed } = input;
  const blind = changed.filter(p => isBlindSpot(p, scope));
  const reasons: string[] = [];
  if (!input.cacheUsable) reasons.push('no usable incremental cache');
  if (blind.length > 0) reasons.push(`changed inputs that incremental mode can't see: ${blind.join(', ')}`);

  if (reasons.length === 0) return { mode: 'incremental', mutate: [], reasons, changedSources: [], fromBaseline: [], fromTests: [] };

  const alive = (p: string) => !input.deleted.includes(p) && input.exists(p);
  const changedSources = changed.filter(p => inMutateScope(p, scope) && alive(p)).sort();
  const fromBaseline = input.baselineChanged.filter(p => inMutateScope(p, scope) && alive(p)).sort();
  const fromTests = changed
    .filter(isUnitTest)
    .flatMap(p => {
      const source = input.readTest(p);
      return source === null ? [] : importedSources(p, source, scope, input.exists);
    })
    .sort();
  const mutate = [...new Set([...changedSources, ...fromBaseline, ...fromTests])].sort();
  return {
    mode: mutate.length === 0 ? 'empty' : 'targeted',
    mutate,
    reasons,
    changedSources,
    fromBaseline: [...new Set(fromBaseline)],
    fromTests: [...new Set(fromTests)],
  };
}

// ---------------------------------------------------------------------------
// Report

interface ReportMutant {
  status: string;
  static?: boolean;
}

export interface Report {
  files: Record<string, { mutants: ReportMutant[] }>;
}

export interface FileScore {
  file: string;
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  /** Mutants silenced by a `Stryker disable` comment: status Ignored and not static. */
  ignores: number;
  /** Total score as Stryker defines it, or null when the file has no scored mutant. Floored to one decimal. */
  score: number | null;
}

export function fileScores(report: Report): FileScore[] {
  return Object.entries(report.files)
    .map(([file, { mutants }]): FileScore => {
      const count = (status: string) => mutants.filter(m => m.status === status).length;
      const killed = count('Killed');
      const timeout = count('Timeout');
      const survived = count('Survived');
      const noCoverage = count('NoCoverage');
      const ignores = mutants.filter(m => m.status === 'Ignored' && m.static !== true).length;
      const scored = killed + timeout + survived + noCoverage;
      const score = scored === 0 ? null : Math.floor(((killed + timeout) / scored) * 1000) / 10;
      return { file, killed, timeout, survived, noCoverage, ignores, score };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

export function renderSummary(plan: Plan | null, scores: FileScore[] | null): string {
  const out: string[] = ['## Mutation testing (informational)', ''];
  if (plan) {
    if (plan.mode === 'incremental') {
      out.push('Mode: incremental run of the whole mutated scope, reusing the cached results from `main`.', '');
    } else {
      out.push(`Mode: cache-miss path. ${plan.reasons.join('; ')}.`, '');
      if (plan.mode === 'empty') {
        out.push(
          '**No source file to mutate: no changed source file, none changed in the baseline, and no mutated file imported by a changed test.** Nothing was checked, and this is not a pass.',
          '',
        );
      } else {
        out.push(
          `Mutated ${plan.mutate.length} file(s): ${plan.changedSources.length} changed, ${plan.fromBaseline.length} from baseline changes, ${plan.fromTests.length} imported by changed tests.`,
          '',
          ...plan.mutate.map(f => `- \`${f}\``),
          '',
        );
      }
    }
  }
  if (scores && scores.length > 0) {
    out.push('| File | Score | Killed | Timeout | Survived | No coverage | Ignores |', '|---|---:|---:|---:|---:|---:|---:|');
    for (const s of scores) {
      const score = s.score === null ? 'n/a' : `${s.score.toFixed(1)}%`;
      out.push(`| \`${s.file}\` | ${score} | ${s.killed} | ${s.timeout} | ${s.survived} | ${s.noCoverage} | ${s.ignores} |`);
    }
    const sum = (k: 'killed' | 'timeout' | 'survived' | 'noCoverage' | 'ignores') => scores.reduce((n, s) => n + s[k], 0);
    const scored = sum('killed') + sum('timeout') + sum('survived') + sum('noCoverage');
    const total = scored === 0 ? 'n/a' : `${(Math.floor(((sum('killed') + sum('timeout')) / scored) * 1000) / 10).toFixed(1)}%`;
    out.push(`| **All files** | ${total} | ${sum('killed')} | ${sum('timeout')} | ${sum('survived')} | ${sum('noCoverage')} | ${sum('ignores')} |`, '');
    out.push('Score is killed and timed-out mutants over killed, timed-out, survived and no-coverage ones. Ignores counts `Stryker disable` mutants, not static ones.', '');
  } else if (!plan || plan.mode !== 'empty') {
    out.push('No report was produced.', '');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function runPlan(args: string[]): void {
  const cache = flag(args, 'cache');
  const since = flag(args, 'since') ?? '';
  const out = flag(args, 'out') ?? 'reports/mutation/plan.json';
  if (cache !== 'hit' && cache !== 'miss') throw new Error('plan needs --cache hit|miss');
  const scope = scopeFromConfig(JSON.parse(readFileSync('stryker.config.json', 'utf8')));
  const known = since !== '' && (() => { try { git('cat-file', '-e', `${since}^{commit}`); return true; } catch { return false; } })();
  const changed = known ? git('diff', '--name-only', since, 'HEAD').split('\n').filter(Boolean) : [];
  const deleted = changed.filter(p => !existsSync(p));
  const readTest = (p: string): string | null => {
    if (existsSync(p)) return readFileSync(p, 'utf8');
    try { return git('show', `${since}:${p}`); } catch { return null; }
  };
  let baselineChanged: string[] = [];
  if (known && changed.includes('mutation-baseline.json')) {
    const parse = (text: string | null) => { try { return text === null ? null : JSON.parse(text); } catch { return null; } };
    let before: string | null = null;
    try { before = git('show', `${since}:mutation-baseline.json`); } catch { /* the file is new */ }
    baselineChanged = changedBaselineFiles(parse(before), parse(existsSync('mutation-baseline.json') ? readFileSync('mutation-baseline.json', 'utf8') : null));
  }
  const result = plan({
    cacheUsable: cache === 'hit' && known,
    changed,
    deleted,
    scope,
    readTest,
    exists: existsSync,
    baselineChanged,
  });
  mkdirSync(posix.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`mode=${result.mode}`);
  console.log(`mutate=${result.mutate.join(',')}`);
}

function runSummary(args: string[]): void {
  const planPath = flag(args, 'plan') ?? 'reports/mutation/plan.json';
  const reportPath = flag(args, 'report') ?? 'reports/mutation/mutation.json';
  const loaded: Plan | null = existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf8')) : null;
  const scores = existsSync(reportPath) ? fileScores(JSON.parse(readFileSync(reportPath, 'utf8'))) : null;
  console.log(renderSummary(loaded, scores));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'plan') runPlan(rest);
  else if (command === 'summary') runSummary(rest);
  else {
    console.error('Usage: node scripts/mutation-ci.ts plan|summary [options]');
    process.exit(2);
  }
}
