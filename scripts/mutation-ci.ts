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
  /**
   * Mutants per file, from the restored incremental file (see `mutantCountsFromIncremental`). Called only
   * on the cache-miss path, which is the only one that uses it. Absent means no counts at all.
   */
  mutantCounts?: () => Record<string, number>;
}

export type PlanMode = 'incremental' | 'targeted' | 'empty';

/**
 * The most mutants a cache-miss PR run may be estimated to test (ADR-0028). A PR never starts a cold full
 * run and the job has 10 minutes (ADR-0026), so the whole targeted set (changed sources, files the changed
 * tests import, changed baseline entries) is filled in that order until the next file would pass this.
 * Whatever doesn't fit is left to the weekly full run (#223, #239).
 *
 * Measured on the CI runner (#231), from five cold full runs of 44 files and 6,342 to 6,345 mutants, about
 * 6.1k of them tested (`mutation-weekly.yml`, Oct 2026). Stryker took 19.1 to 29.6 minutes, dry run
 * included: 0.19 to 0.29 seconds per tested mutant. Runners vary by 50% for the same commit, so the
 * slowest run (0.29 s) sets the bound. The job's own overhead is 0.3 min (checkout, npm ci, plan, upload,
 * ratchet: 11 to 20 s) and the targeted run's own dry run 0.5 min (0.3 to 0.5 measured): 0.8 min together.
 *
 * The budget keeps the 3.0 min of spare time that ADR-0027's cap of 3 files left in its worst case, for
 * any mix of files, not only for baseline entries:
 *   (10 min timeout - 0.8 min overhead - 3.0 min spare) x 60 s / 0.29 s per mutant = 372 / 0.29 = 1,283,
 *   rounded down to 1,280, which is also the three largest files together (510 + 420 + 350)
 *   1,280 mutants x 0.29 s = 6.2 min, + 0.8 min = 7.0 min, 3.0 min spare
 * The spare is not room to spend. The counts are estimates (they come from main's file, and the PR may have
 * grown a file) and time per mutant differs by file. At the average file (6,342 / 44 = about 144 mutants)
 * the budget covers about 9 files, where the cap of 3 covered 3 whatever their size and left the changed
 * sources and test imports uncapped.
 *
 * Re-measure after the mutated scope or the runner changes much.
 */
export const MUTANT_BUDGET = 1280;

/**
 * The size assumed for a file the restored incremental file has no count for (no cache, or a file added
 * since): 510 mutants, the largest file measured in #231. A new file is as likely to be big as any, and
 * assuming small could pass the timeout. So the budget holds two unknown files (1,020 mutants), not a third
 * (1,530 over 1,280). With no cache at all every file is unknown, and a PR gets two of them.
 */
export const FALLBACK_MUTANTS = 510;

/**
 * The incremental file's per-file mutant counts: the length of `files[path].mutants`, Ignored ones included
 * (a count over the ~6.1k tested of ~6.3k, so about 4% high, the safe side). Stryker writes that file in the
 * mutation-testing report format. A file that doesn't parse or has another shape gives no counts, and every
 * file then takes FALLBACK_MUTANTS: this is a size estimate, not a result, so the fallback is the answer.
 */
export function mutantCountsFromIncremental(doc: unknown): Record<string, number> {
  const files = typeof doc === 'object' && doc !== null ? (doc as { files?: unknown }).files : null;
  if (typeof files !== 'object' || files === null) return {};
  const counts: Record<string, number> = {};
  for (const [path, entry] of Object.entries(files)) {
    const mutants = typeof entry === 'object' && entry !== null ? (entry as { mutants?: unknown }).mutants : null;
    if (Array.isArray(mutants)) counts[path] = mutants.length;
  }
  return counts;
}

/** The three groups of the cache-miss set, highest priority first. */
export interface Groups<T> {
  /** Source files the PR changed. */
  changedSources: T;
  /** Source files the changed tests import. */
  fromTests: T;
  /** Source files whose `mutation-baseline.json` entry changed. */
  fromBaseline: T;
}

export interface Plan {
  mode: PlanMode;
  /** For `targeted`: the files passed to --mutate. Empty otherwise. */
  mutate: string[];
  /** Why the cache-miss path was taken, or [] for `incremental`. */
  reasons: string[];
  /** The mutated files by group. A file sits in the highest group that names it, so the three add up to `mutate`. */
  changedSources: string[];
  fromBaseline: string[];
  fromTests: string[];
  /** How many source files had a changed baseline entry, before the budget. */
  baselineChanged: number;
  /**
   * Files due for mutation that did not fit MUTANT_BUDGET, in priority order. The weekly full run checks
   * them. Empty when everything fit, and on the incremental path.
   */
  leftToWeekly: string[];
  /** The same files by group. */
  leftToWeeklyByGroup: Groups<string[]>;
  /** The estimated mutants of `mutate`, never over MUTANT_BUDGET. */
  estimatedMutants: number;
  /** The files, among those due for mutation, that had no count and were sized at FALLBACK_MUTANTS. */
  estimatedByFallback: string[];
}

const emptyGroups = (): Groups<string[]> => ({ changedSources: [], fromTests: [], fromBaseline: [] });

/** A plan that mutates nothing, and says why. */
export function noPlan(mode: PlanMode, reasons: string[]): Plan {
  return {
    mode,
    mutate: [],
    reasons,
    changedSources: [],
    fromBaseline: [],
    fromTests: [],
    baselineChanged: 0,
    leftToWeekly: [],
    leftToWeeklyByGroup: emptyGroups(),
    estimatedMutants: 0,
    estimatedByFallback: [],
  };
}

/**
 * Whole scope, incrementally, when a usable cache exists and nothing it can't see changed.
 * Otherwise the cache-miss path: only the files a PR touches, never a cold full run (ADR-0026). The files
 * are taken in priority order (changed sources, files the changed tests import, changed baseline entries;
 * sorted by path within a group, each file once, in its highest group) while their estimated mutants fit
 * MUTANT_BUDGET. The first file that doesn't fit ends the set, so what is mutated is a prefix of that
 * order, and every file after it is named in `leftToWeekly` for the weekly full run (ADR-0028).
 */
export function plan(input: PlanInput): Plan {
  const { scope, changed } = input;
  const blind = changed.filter(p => isBlindSpot(p, scope));
  const reasons: string[] = [];
  if (!input.cacheUsable) reasons.push(input.cacheNote ?? 'no usable incremental cache');
  if (blind.length > 0) reasons.push(`changed inputs that incremental mode can't see: ${blind.join(', ')}`);

  if (reasons.length === 0) return noPlan('incremental', reasons);

  const alive = (p: string) => !input.deleted.includes(p) && input.exists(p);
  const changedSources = changed.filter(p => inMutateScope(p, scope) && alive(p)).sort();
  const baselineEntries = [...new Set(input.baselineChanged.filter(p => inMutateScope(p, scope) && alive(p)))].sort();
  const testImports = [
    ...new Set(
      changed.filter(isUnitTest).flatMap(p => {
        const source = input.readTest(p);
        return source === null ? [] : importedSources(p, source, scope, input.exists);
      }),
    ),
  ].sort();

  // One list in priority order, each file once, in the highest group that names it.
  const seen = new Set<string>();
  const ordered: { file: string; group: keyof Groups<unknown> }[] = [];
  const queue = (files: string[], group: keyof Groups<unknown>) => {
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      ordered.push({ file, group });
    }
  };
  queue(changedSources, 'changedSources');
  queue(testImports, 'fromTests');
  queue(baselineEntries, 'fromBaseline');

  const counts = ordered.length > 0 ? (input.mutantCounts?.() ?? {}) : {};
  const estimatedByFallback = ordered.filter(({ file }) => counts[file] === undefined).map(({ file }) => file);
  const estimate = (file: string) => counts[file] ?? FALLBACK_MUTANTS;

  const taken = emptyGroups();
  const left = emptyGroups();
  let used = 0;
  let full = false;
  for (const { file, group } of ordered) {
    if (!full && used + estimate(file) <= MUTANT_BUDGET) {
      used += estimate(file);
      taken[group].push(file);
    } else {
      full = true;
      left[group].push(file);
    }
  }
  const mutate = [...taken.changedSources, ...taken.fromTests, ...taken.fromBaseline].sort();
  return {
    mode: mutate.length === 0 ? 'empty' : 'targeted',
    mutate,
    reasons,
    changedSources: taken.changedSources,
    fromTests: taken.fromTests,
    fromBaseline: taken.fromBaseline,
    baselineChanged: baselineEntries.length,
    leftToWeekly: [...left.changedSources, ...left.fromTests, ...left.fromBaseline],
    leftToWeeklyByGroup: left,
    estimatedMutants: used,
    estimatedByFallback,
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
            ? '**No source file was mutated: the first file due for mutation is over the mutant budget (below).**'
            : '**No source file to mutate: no changed source file, none changed in the baseline, and no mutated file imported by a changed test.**',
          'Nothing was checked, and this is not a pass.',
          '',
        );
      } else {
        out.push(
          `Mutated ${plan.mutate.length} file(s), an estimated ${plan.estimatedMutants} of ${MUTANT_BUDGET} mutants: ${plan.changedSources.length} changed, ${plan.fromBaseline.length} from baseline changes, ${plan.fromTests.length} imported by changed tests.`,
          '',
          ...plan.mutate.map(f => `- \`${f}\``),
          '',
        );
      }
      if (plan.estimatedByFallback.length > 0) {
        out.push(
          `${plan.estimatedByFallback.length} file(s) had no mutant count in the cached results (new, or no cache) and were each sized at ${FALLBACK_MUTANTS} mutants: ${plan.estimatedByFallback.map(f => `\`${f}\``).join(', ')}.`,
          '',
        );
      }
      if (plan.leftToWeekly.length > 0) {
        const groups: [string, string[]][] = [
          ['Changed sources', plan.leftToWeeklyByGroup.changedSources],
          ['Imported by changed tests', plan.leftToWeeklyByGroup.fromTests],
          ['Changed baseline entries', plan.leftToWeeklyByGroup.fromBaseline],
        ];
        out.push(
          `**The mutants these ${plan.leftToWeekly.length} file(s) would add pass the budget of ${MUTANT_BUDGET} (estimated ${plan.estimatedMutants} used), so this run did not mutate them.** The job has 10 minutes, so it takes the changed sources first, then the files the changed tests import, then the changed baseline entries, and stops at the first that doesn't fit. A change that wide (a re-baseline after a Stryker upgrade, or the first baseline) is checked by the weekly full run (\`mutation-weekly.yml\`), not by this job. Run it by hand on this PR's head commit (Actions tab, "Run workflow", put the commit SHA in "ref") before merging. These files are unchecked until then:`,
          '',
        );
        for (const [name, files] of groups) {
          if (files.length === 0) continue;
          out.push(`${name} (${files.length}):`, '', ...files.map(f => `- \`${f}\``), '');
        }
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
  opts: { cache: 'hit' | 'miss'; since: string; fallbackSince: string; config: { mutate: string[]; incrementalFile?: string } },
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
    return noPlan('empty', [base.note ?? 'no commit to diff against was found']);
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
  // Read here, before the job drops the restored file on the cache-miss path. Its results are not reused
  // then, but its per-file mutant counts size the run (ADR-0028). No file, or one that doesn't parse, gives
  // no counts, and the plan sizes every file at FALLBACK_MUTANTS.
  const incrementalFile = opts.config.incrementalFile;
  const mutantCounts = (): Record<string, number> => {
    if (incrementalFile === undefined || !io.exists(incrementalFile)) return {};
    try {
      return mutantCountsFromIncremental(JSON.parse(io.read(incrementalFile)));
    } catch {
      return {};
    }
  };
  return plan({ cacheUsable: base.cacheUsable, cacheNote: base.note, changed, deleted, scope, readTest, exists: io.exists, baselineChanged, mutantCounts });
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
