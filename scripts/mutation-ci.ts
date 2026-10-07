/**
 * The decisions and the report table of the CI mutation jobs (ADR-0026, #204).
 *
 * `plan` decides what the PR `mutation` job runs, `summary` turns Stryker's JSON report
 * into the per-file table for the job summary. Neither fails a build: the gate is
 * scripts/mutation-ratchet.ts (#205).
 *
 * Runs on Node 24 as plain TypeScript (type stripping), so it imports `node:` modules only,
 * uses `import type` for types and has no enums. Unit tests: src/mutation-ci.test.ts.
 *
 *   node scripts/mutation-ci.ts plan --cache hit|miss [--since <cache's commit>] [--fallback-since <PR base>] [--out reports/mutation/plan.json]
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

/** Keys of `mutation-baseline.json` (#205) whose entry differs. Entries sit under `files`, beside the Stryker version. */
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
  /** Why the cache can't be used, when it can't. Defaults to "no usable incremental cache". */
  cacheNote?: string | null;
  /** Paths changed since the commit the cache (or the PR base) is from, deleted ones included. */
  changed: string[];
  /** Paths among `changed` that no longer exist at HEAD. */
  deleted: string[];
  scope: MutateScope;
  /** Source text of a changed test file, at HEAD or (for a deleted one) at the old commit. */
  readTest: (path: string) => string | null;
  /** True when a path exists at HEAD. */
  exists: (path: string) => boolean;
  /** Source files whose `mutation-baseline.json` entry changed. */
  baselineChanged: string[];
}

export type PlanMode = 'incremental' | 'targeted' | 'empty';

/**
 * The most baseline entries a PR may change before the cache-miss path stops mutating them (ADR-0026: a
 * PR never starts a cold full run, and the job has 10 minutes). Over this, the files are left to the
 * weekly full run (#223).
 *
 * Measured on the CI runner (#231), from five cold full runs of 44 files and about 6.1k mutants
 * (`mutation-weekly.yml`, Oct 2026). Stryker took 19.1, 19.5, 24.4, 28.4 and 29.6 minutes, dry run
 * included: 0.43 to 0.67 minutes per file on average, 0.19 to 0.29 seconds per mutant. Runners vary
 * by 50% for the same commit, so the slowest run sets the bound. The job's own overhead (checkout,
 * npm ci, plan, upload, ratchet) is 11 to 20 seconds.
 *
 * Files differ a lot in size, and the cap can't choose which ones changed. The four largest files
 * hold 510, 420, 350 and 350 mutants. At 0.29 s each, the cap's worst case is:
 *   3 files: 1,280 mutants, 6.2 min, + 0.3 min overhead = 6.5 min, about 3.5 min spare for the changed
 *            sources and test imports that are not capped
 *   4 files: 1,630 mutants, 7.9 min, + 0.3 min = 8.2 min, under 2 min spare
 *   5 files: 1,953 mutants, 9.5 min, + 0.3 min = 9.8 min, no room left
 * So 3. At the average file (0.67 min) 8 files would fit; the largest 8 (2,787 mutants, 13.5 min) do
 * not, and the old figure of 1 to 1.5 minutes per file was a laptop estimate. Re-measure after the
 * mutated scope or the runner changes much.
 */
export const MAX_BASELINE_FILES = 3;

export interface Plan {
  mode: PlanMode;
  /** For `targeted`: the files passed to --mutate. Empty otherwise. */
  mutate: string[];
  /** Why the cache-miss path was taken, or [] for `incremental`. */
  reasons: string[];
  changedSources: string[];
  /** Files mutated because their baseline entry changed. Empty when the cap (MAX_BASELINE_FILES) was hit. */
  fromBaseline: string[];
  fromTests: string[];
  /** How many source files had a changed baseline entry, before the cap. */
  baselineChanged: number;
  /**
   * Source files with a changed baseline entry that this run did not mutate, because more than
   * MAX_BASELINE_FILES entries changed. The weekly full run checks them. Empty when the cap did not bite.
   */
  leftToWeekly: string[];
}

/**
 * Whole scope, incrementally, when a usable cache exists and nothing it can't see changed.
 * Otherwise the cache-miss path: only the files a PR touches, never a cold full run (ADR-0026). When more
 * than MAX_BASELINE_FILES baseline entries changed, those files are not mutated (the changed sources and
 * the files the changed tests import still are) and are named in `leftToWeekly` for the weekly full run.
 */
export function plan(input: PlanInput): Plan {
  const { scope, changed } = input;
  const blind = changed.filter(p => isBlindSpot(p, scope));
  const reasons: string[] = [];
  if (!input.cacheUsable) reasons.push(input.cacheNote ?? 'no usable incremental cache');
  if (blind.length > 0) reasons.push(`changed inputs that incremental mode can't see: ${blind.join(', ')}`);

  if (reasons.length === 0) {
    return { mode: 'incremental', mutate: [], reasons, changedSources: [], fromBaseline: [], fromTests: [], baselineChanged: 0, leftToWeekly: [] };
  }

  const alive = (p: string) => !input.deleted.includes(p) && input.exists(p);
  const changedSources = changed.filter(p => inMutateScope(p, scope) && alive(p)).sort();
  const baselineEntries = [...new Set(input.baselineChanged.filter(p => inMutateScope(p, scope) && alive(p)))].sort();
  const capped = baselineEntries.length > MAX_BASELINE_FILES;
  const fromBaseline = capped ? [] : baselineEntries;
  const fromTests = changed
    .filter(isUnitTest)
    .flatMap(p => {
      const source = input.readTest(p);
      return source === null ? [] : importedSources(p, source, scope, input.exists);
    })
    .sort();
  const mutate = [...new Set([...changedSources, ...fromBaseline, ...fromTests])].sort();
  // A capped entry that a changed source or test brings in anyway is mutated, so it isn't left out.
  const leftToWeekly = capped ? baselineEntries.filter(p => !mutate.includes(p)) : [];
  return {
    mode: mutate.length === 0 ? 'empty' : 'targeted',
    mutate,
    reasons,
    changedSources,
    fromBaseline,
    fromTests: [...new Set(fromTests)],
    baselineChanged: baselineEntries.length,
    leftToWeekly,
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
  const out: string[] = ['## Mutation testing', ''];
  if (plan) {
    if (plan.mode === 'incremental') {
      out.push('Mode: incremental run of the whole mutated scope, reusing the cached results from `main`.', '');
    } else {
      out.push(`Mode: cache-miss path. ${plan.reasons.join('; ')}.`, '');
      if (plan.mode === 'empty') {
        out.push(
          plan.leftToWeekly.length > 0
            ? '**No source file to mutate: no changed source file, no mutated file imported by a changed test, and the changed baseline entries are over the cap (below).**'
            : '**No source file to mutate: no changed source file, none changed in the baseline, and no mutated file imported by a changed test.**',
          'Nothing was checked, and this is not a pass.',
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
      if (plan.leftToWeekly.length > 0) {
        out.push(
          `**${plan.baselineChanged} baseline entries changed, over the cap of ${MAX_BASELINE_FILES}, so this run did not mutate the ${plan.leftToWeekly.length} below.** A change that wide (a re-baseline after a Stryker upgrade, or the first baseline) is checked by the weekly full run (\`mutation-weekly.yml\`), not by this job. Run it by hand on this PR's head commit (Actions tab, "Run workflow", put the commit SHA in "ref") before merging. These files are unchecked until then:`,
          '',
          ...plan.leftToWeekly.map(f => `- \`${f}\``),
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

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** What `plan` diffs against, and whether the restored cache can be trusted. */
export interface BaseChoice {
  /** The commit to diff against, or null when no candidate is in this checkout. */
  since: string | null;
  cacheUsable: boolean;
  /** Why the cache isn't usable, for the summary. Null for the ordinary cases. */
  note: string | null;
}

/**
 * The commit the cache was saved from, when the cache hit and that commit is in this checkout. Otherwise
 * the cache can't be trusted (a run on a commit outside this history, a deleted branch), and the diff goes
 * against the fallback (the PR base), then `lastResort` (the first parent). A base that can't be found must
 * not read as "nothing changed", so with none the plan says so and mutates nothing.
 */
export function chooseBase(input: {
  cache: 'hit' | 'miss';
  since: string;
  fallbackSince: string;
  lastResort: string;
  isCommit: (rev: string) => boolean;
}): BaseChoice {
  if (input.cache === 'hit' && input.since !== '' && input.isCommit(input.since)) {
    return { since: input.since, cacheUsable: true, note: null };
  }
  const note = input.cache === 'hit' ? 'the cache was saved from a commit that is not in this checkout' : null;
  const fallback = [input.fallbackSince, input.lastResort].find(rev => rev !== '' && input.isCommit(rev));
  if (fallback === undefined) return { since: null, cacheUsable: false, note: 'no commit to diff against was found' };
  return { since: fallback, cacheUsable: false, note };
}

/** What `planFromRepo` needs from the repository and the working tree. Faked in tests. */
export interface PlanIo {
  /** Runs git and returns stdout; throws when git fails. */
  git(...args: string[]): string;
  exists(path: string): boolean;
  read(path: string): string;
}

export function planFromRepo(
  opts: { cache: 'hit' | 'miss'; since: string; fallbackSince: string; config: { mutate: string[] } },
  io: PlanIo,
): Plan {
  const scope = scopeFromConfig(opts.config);
  const isCommit = (rev: string) => {
    try {
      io.git('cat-file', '-e', `${rev}^{commit}`);
      return true;
    } catch {
      return false;
    }
  };
  const base = chooseBase({ cache: opts.cache, since: opts.since, fallbackSince: opts.fallbackSince, lastResort: 'HEAD~1', isCommit });
  const since = base.since;
  if (since === null) {
    return {
      mode: 'empty',
      mutate: [],
      reasons: [base.note ?? 'no commit to diff against was found'],
      changedSources: [],
      fromBaseline: [],
      fromTests: [],
      baselineChanged: 0,
      leftToWeekly: [],
    };
  }
  // --no-renames: a rename lists the old path too, so a moved blind-spot file is still seen.
  const changed = io.git('diff', '--name-only', '--no-renames', since, 'HEAD').split('\n').filter(Boolean);
  const deleted = changed.filter(p => !io.exists(p));
  const readTest = (p: string): string | null => {
    if (io.exists(p)) return io.read(p);
    try {
      return io.git('show', `${since}:${p}`);
    } catch {
      return null;
    }
  };
  let baselineChanged: string[] = [];
  if (changed.includes('mutation-baseline.json')) {
    const parse = (text: string | null): unknown => {
      try {
        return text === null ? null : JSON.parse(text);
      } catch {
        return null;
      }
    };
    // The entries this PR changed, so against the PR base. Against the cache's commit every entry that
    // main changed (or all of them, when the cache predates the baseline) would be mutated again, and a
    // cache-miss run would turn into a cold full run (#205).
    const baselineRef = opts.fallbackSince !== '' && isCommit(opts.fallbackSince) ? opts.fallbackSince : since;
    let before: string | null = null;
    try {
      before = io.git('show', `${baselineRef}:mutation-baseline.json`);
    } catch {
      /* the file is new */
    }
    baselineChanged = changedBaselineFiles(parse(before), parse(io.exists('mutation-baseline.json') ? io.read('mutation-baseline.json') : null));
  }
  return plan({ cacheUsable: base.cacheUsable, cacheNote: base.note, changed, deleted, scope, readTest, exists: io.exists, baselineChanged });
}

function runPlan(args: string[]): void {
  const cache = flag(args, 'cache');
  const out = flag(args, 'out') ?? 'reports/mutation/plan.json';
  if (cache !== 'hit' && cache !== 'miss') throw new Error('plan needs --cache hit|miss');
  const io: PlanIo = { git, exists: existsSync, read: p => readFileSync(p, 'utf8') };
  const result = planFromRepo(
    {
      cache,
      since: flag(args, 'since') ?? '',
      fallbackSince: flag(args, 'fallback-since') ?? '',
      config: JSON.parse(readFileSync('stryker.config.json', 'utf8')),
    },
    io,
  );
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
