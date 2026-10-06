/**
 * The per-file mutation-score ratchet (ADR-0026, #205).
 *
 * Reads Stryker's JSON report and `mutation-baseline.json` and fails when a file's tests got
 * weaker: a score below its baseline, more ignored mutants than the baseline records, a
 * `Stryker disable` with no reason, a file with no entry, an entry with no report row, or (on a
 * PR) a lowered score or an edit to the mutated scope without the `mutation-baseline-change` label.
 *
 * Runs on Node 24 as plain TypeScript (type stripping, like scripts/mutation-ci.ts), so it imports
 * `node:` modules only, uses `import type` for types and has no enums. `npx tsx` runs it too.
 * Unit tests: src/mutation-ratchet.test.ts.
 *
 *   node scripts/mutation-ratchet.ts [check] [--report reports/mutation/mutation.json]
 *        [--baseline mutation-baseline.json] [--plan reports/mutation/plan.json]
 *        [--base <git rev>] [--labels a,b] [--no-rerun]
 *   node scripts/mutation-ratchet.ts --update --report <run1.json> --report <run2.json> [--init]
 *   node scripts/mutation-ratchet.ts --update --weekly --report <weekly full run's report>
 *
 * `check` prints Markdown (and appends it to $GITHUB_STEP_SUMMARY) and exits 1 on any failure.
 * `--update` only raises scores (see `updateBaseline`).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** A new file must reach this score before its entry can be added (ADR-0026, "New files"). */
export const NEW_FILE_FLOOR = 80;

export const BASELINE_LABEL = 'mutation-baseline-change';

// ---------------------------------------------------------------------------
// Report and baseline

export interface ReportMutant {
  status: string;
  static?: boolean;
  statusReason?: string;
  mutatorName?: string;
  location?: { start?: { line?: number } };
}

export interface Report {
  files: Record<string, { mutants: ReportMutant[] }>;
  framework?: { version?: string };
}

export interface BaselineEntry {
  score: number;
  ignores: number;
}

export interface Baseline {
  stryker: string;
  files: Record<string, BaselineEntry>;
}

export interface FileStats {
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  /** Killed, timed out, survived and no coverage: the mutants a score is made of. */
  scored: number;
  /** Total score floored to one decimal, or null when the file has no scored mutant. */
  score: number | null;
  /** Mutants silenced by a `Stryker disable` comment: Ignored with `static` not true. */
  ignores: number;
  /** Source lines of disables that have no written reason (empty `statusReason`). */
  bareDisableLines: Array<number | null>;
}

/** Timeouts count as killed, no-coverage as survived, ignored mutants are out of both (ADR-0026). */
export function fileStats(mutants: ReportMutant[]): FileStats {
  const count = (status: string) => mutants.filter(m => m.status === status).length;
  const killed = count('Killed');
  const timeout = count('Timeout');
  const survived = count('Survived');
  const noCoverage = count('NoCoverage');
  const scored = killed + timeout + survived + noCoverage;
  const disabled = mutants.filter(m => m.status === 'Ignored' && m.static !== true);
  return {
    killed,
    timeout,
    survived,
    noCoverage,
    scored,
    score: scored === 0 ? null : scoreOf(killed + timeout, scored),
    ignores: disabled.length,
    bareDisableLines: disabled.filter(m => (m.statusReason ?? '').trim() === '').map(m => m.location?.start?.line ?? null),
  };
}

/** `good / scored` as a percentage, floored to one decimal. Integer maths, so 285 of 285 is exactly 100. */
export function scoreOf(good: number, scored: number): number {
  return Math.floor((good * 1000) / scored) / 10;
}

export function reportStats(report: Report): Map<string, FileStats> {
  return new Map(Object.entries(report.files).map(([file, row]) => [file, fileStats(row.mutants)]));
}

/** Parses `mutation-baseline.json`. Throws a plain message naming what is wrong, never the file's text. */
export function parseBaseline(text: string): Baseline {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('mutation-baseline.json is not valid JSON');
  }
  const bad = (what: string): never => {
    throw new Error(`mutation-baseline.json: ${what}`);
  };
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return bad('expected an object');
  const { stryker, files } = doc as { stryker?: unknown; files?: unknown };
  if (typeof stryker !== 'string' || stryker === '') bad('"stryker" must be the Stryker version the scores were measured with');
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return bad('"files" must be an object');
  const out: Record<string, BaselineEntry> = {};
  for (const [file, entry] of Object.entries(files)) {
    const e = entry as { score?: unknown; ignores?: unknown } | null;
    const valid =
      typeof e === 'object' &&
      e !== null &&
      typeof e.score === 'number' &&
      e.score >= 0 &&
      e.score <= 100 &&
      Number.isInteger(e.ignores) &&
      (e.ignores as number) >= 0;
    if (!valid) bad(`the entry for ${file} needs a "score" from 0 to 100 and a whole-number "ignores"`);
    out[file] = { score: (e as BaselineEntry).score, ignores: (e as BaselineEntry).ignores };
  }
  return { stryker: stryker as string, files: out };
}

/** Sorted keys, one file per line, so two PRs that raise different files merge without a conflict. */
export function formatBaseline(baseline: Baseline): string {
  const lines = Object.keys(baseline.files)
    .sort()
    .map(file => `    ${JSON.stringify(file)}: { "score": ${baseline.files[file].score.toFixed(1)}, "ignores": ${baseline.files[file].ignores} }`);
  return `{\n  "stryker": ${JSON.stringify(baseline.stryker)},\n  "files": {\n${lines.join(',\n')}\n  }\n}\n`;
}

// ---------------------------------------------------------------------------
// check

export type FailureKind =
  | 'below-baseline'
  | 'ignores-up'
  | 'bare-disable'
  | 'new-file'
  | 'no-report-row'
  | 'file-deleted'
  | 'baseline-lowered'
  | 'scope-changed';

export interface Failure {
  kind: FailureKind;
  file: string | null;
  message: string;
}

export interface Rerun {
  file: string;
  /** Score of the run that was below the baseline. */
  first: number | null;
  /** Score of the single re-run from a fresh sandbox, or null when it couldn't run. */
  second: number | null;
  baseline: number;
  /** True when the re-run cleared the file. */
  cleared: boolean;
}

export interface CheckInput {
  report: Report;
  baseline: Baseline;
  /**
   * The files this run was meant to mutate. null is the whole scope (an incremental or weekly run):
   * then every baseline entry must have a report row. A cache-miss run mutates a few files only.
   */
  expected: string[] | null;
  /** True when a path exists in the checkout. */
  exists: (path: string) => boolean;
  /** Re-runs one file once from a fresh sandbox. Omit to skip the re-run. Returns the new stats, or null on failure. */
  rerun?: (file: string) => FileStats | null;
}

export interface CheckResult {
  failures: Failure[];
  /** A file scored above its baseline: the baseline can be raised (not a failure). */
  raisable: Array<{ file: string; score: number; baseline: number }>;
  reruns: Rerun[];
  /** How many files had a score checked against an entry. */
  checked: number;
}

const fmt = (n: number | null) => (n === null ? 'n/a' : `${n.toFixed(1)}%`);

export function check(input: CheckInput): CheckResult {
  const { report, baseline, expected, exists } = input;
  const failures: Failure[] = [];
  const raisable: CheckResult['raisable'] = [];
  const reruns: Rerun[] = [];
  const stats = reportStats(report);
  let checked = 0;

  for (const [file, s] of [...stats].sort(([a], [b]) => a.localeCompare(b))) {
    if (s.bareDisableLines.length > 0) {
      const lines = s.bareDisableLines.map(l => (l === null ? '?' : String(l))).join(', ');
      failures.push({
        kind: 'bare-disable',
        file,
        message: `${file} has ${s.bareDisableLines.length} mutant(s) silenced by a Stryker disable with no reason (line ${lines}). Write the reason after a colon: \`// Stryker disable next-line <mutator>: <why>\`.`,
      });
    }
    const entry = baseline.files[file];
    if (entry === undefined) {
      if (s.scored === 0) continue; // no mutant to score, so nothing to ratchet
      const line = `"${file}": { "score": ${(s.score as number).toFixed(1)}, "ignores": ${s.ignores} }`;
      failures.push({
        kind: 'new-file',
        file,
        message:
          (s.score as number) >= NEW_FILE_FLOOR
            ? `${file} has no entry in mutation-baseline.json. Add \`${line}\` in the same PR.`
            : `${file} has no entry in mutation-baseline.json and scores ${fmt(s.score)}, under the ${NEW_FILE_FLOOR}% a new file needs. Add tests until it reaches ${NEW_FILE_FLOOR}%, then add its entry (\`${line}\`) in the same PR.`,
      });
      continue;
    }
    if (s.score !== null) {
      checked += 1;
      if (s.score < entry.score) {
        const second = input.rerun ? input.rerun(file) : undefined;
        if (second !== undefined) {
          const cleared = second !== null && second.score !== null && second.score >= entry.score;
          reruns.push({ file, first: s.score, second: second?.score ?? null, baseline: entry.score, cleared });
          if (!cleared) {
            failures.push({
              kind: 'below-baseline',
              file,
              message: `${file} scores ${fmt(s.score)}, below its baseline ${fmt(entry.score)}${second?.score == null ? ' (the re-run did not produce a score)' : `, and ${fmt(second.score)} again on a re-run from a fresh sandbox`}. Add or strengthen tests for the survivors in the report.`,
            });
          }
        } else {
          failures.push({
            kind: 'below-baseline',
            file,
            message: `${file} scores ${fmt(s.score)}, below its baseline ${fmt(entry.score)}. Add or strengthen tests for the survivors in the report.`,
          });
        }
      } else if (Math.floor(s.score) > entry.score) {
        // A whole point more: what `--update` would raise it to (it rounds down to a whole point).
        raisable.push({ file, score: s.score, baseline: entry.score });
      }
    }
    if (s.ignores > entry.ignores) {
      failures.push({
        kind: 'ignores-up',
        file,
        message: `${file} has ${s.ignores} ignored mutant(s) from Stryker disable comments, above the baseline's ${entry.ignores}. If the ignores are right, raise "ignores" in mutation-baseline.json in the same PR so the growth shows in the diff.`,
      });
    }
  }

  for (const file of Object.keys(baseline.files).sort()) {
    if (!exists(file)) {
      failures.push({
        kind: 'file-deleted',
        file,
        message: `${file} is in mutation-baseline.json but no longer exists. Remove its entry in the same PR (a rename moves the entry to the new path).`,
      });
    } else if (!stats.has(file) && (expected === null || expected.includes(file))) {
      failures.push({
        kind: 'no-report-row',
        file,
        message: `${file} is in mutation-baseline.json but the report has no row for it. It may have been taken out of the \`mutate\` globs in stryker.config.json, which needs the ${BASELINE_LABEL} label and the maintainer's OK.`,
      });
    }
  }

  return { failures, raisable, reruns, checked };
}

// ---------------------------------------------------------------------------
// The base branch's copy (lowering is a decision)

/** The parts of a commit that fix what is measured. Any can be null when the commit has no such file. */
export interface MeasuredScope {
  baseline: Baseline | null;
  /** `mutate` globs of stryker.config.json, in order. */
  mutate: string[] | null;
  /** The `exclude` list of vitest.mutation.config.ts. */
  exclude: string[] | null;
}

export interface CompareInput {
  base: MeasuredScope;
  head: MeasuredScope;
  exists: (path: string) => boolean;
  /** True when the PR has the `mutation-baseline-change` label. */
  labeled: boolean;
}

export interface CompareResult {
  failures: Failure[];
  /** What changed, for the summary, whether or not the label excused it. */
  changes: string[];
}

const sameList = (a: string[] | null, b: string[] | null, ordered: boolean) => {
  if (a === null || b === null) return a === b;
  const norm = (l: string[]) => (ordered ? l : [...l].sort());
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
};

/**
 * A lowered `score`, a removed entry (for a file that still exists), an edit to the `mutate` globs
 * or an edit to the exclusion list, against the base branch, fails unless the PR has the label.
 * An `ignores` increase is allowed: the baseline diff shows it.
 */
export function compareToBase(input: CompareInput): CompareResult {
  const { base, head, exists, labeled } = input;
  const changes: Array<{ kind: FailureKind; file: string | null; text: string }> = [];

  for (const [file, before] of Object.entries(base.baseline?.files ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const after = head.baseline?.files[file];
    if (after === undefined) {
      if (exists(file)) {
        changes.push({ kind: 'baseline-lowered', file, text: `${file}: the baseline entry was removed (it was ${before.score.toFixed(1)}%) but the file still exists` });
      }
    } else if (after.score < before.score) {
      changes.push({ kind: 'baseline-lowered', file, text: `${file}: baseline score lowered from ${before.score.toFixed(1)}% to ${after.score.toFixed(1)}%` });
    }
  }
  if (!sameList(base.mutate, head.mutate, true)) {
    changes.push({ kind: 'scope-changed', file: null, text: 'the `mutate` globs in stryker.config.json changed' });
  }
  if (!sameList(base.exclude, head.exclude, false)) {
    changes.push({ kind: 'scope-changed', file: null, text: 'the exclusion list in vitest.mutation.config.ts changed' });
  }

  const failures: Failure[] = labeled
    ? []
    : changes.map(c => ({
        kind: c.kind,
        file: c.file,
        message: `${c.text}. This lowers what the ratchet measures, so the PR needs the \`${BASELINE_LABEL}\` label, a written reason, and the maintainer's OK (ADR-0026).`,
      }));
  return { failures, changes: changes.map(c => c.text) };
}

/**
 * The string literals of the first `<key>: [ ... ]` array in a TypeScript or JSON source, comments
 * skipped. Enough for the `exclude` list of vitest.mutation.config.ts, whose entries are plain strings.
 */
export function extractStringList(source: string, key: string): string[] | null {
  const start = source.search(new RegExp(`\\b${key}["']?\\s*:\\s*\\[`));
  if (start < 0) return null;
  const out: string[] = [];
  let i = source.indexOf('[', start) + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === ']') return out;
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\') j += 1;
        text += source[j];
        j += 1;
      }
      out.push(text);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// --update

export interface UpdateInput {
  baseline: Baseline | null;
  /** The runs to read: the lower of two (or more), or one weekly full run. */
  reports: Report[];
  /** True for the first baseline, which may record files below the new-file floor. */
  init?: boolean;
}

export interface UpdateResult {
  baseline: Baseline;
  /** One line per file whose entry changed or that was left out, for the console. */
  notes: string[];
}

/**
 * Raises scores only. For each file the score is the lowest across the runs, rounded down to a
 * whole point, minus the file's observed spread across the runs counted in mutants (as points of
 * that file), floored to one decimal. It never lowers an entry, never touches an entry's `ignores`
 * upward, and adds a file with no entry only when it reaches the new-file floor (`init` waives the
 * floor, for the first baseline).
 */
export function updateBaseline(input: UpdateInput): UpdateResult {
  const { reports } = input;
  if (reports.length === 0) throw new Error('--update needs at least one report');
  const base: Baseline = input.baseline
    ? { stryker: input.baseline.stryker, files: { ...input.baseline.files } }
    : { stryker: reports[0].framework?.version ?? 'unknown', files: {} };
  const init = input.init === true;
  const runs = reports.map(reportStats);
  const notes: string[] = [];

  const files = [...runs[0].keys()].filter(f => runs.every(r => r.has(f))).sort();
  for (const file of files) {
    const per = runs.map(r => r.get(file) as FileStats);
    if (per.some(s => s.score === null)) continue;
    const lowest = per.reduce((a, b) => ((a.score as number) <= (b.score as number) ? a : b));
    const goods = per.map(s => s.killed + s.timeout);
    const spread = Math.max(...goods) - Math.min(...goods);
    // Whole points, minus the spread as points of this file, in tenths of a point.
    const tenths = Math.max(0, Math.floor((Math.floor(lowest.score as number) * lowest.scored * 10 - spread * 1000) / lowest.scored));
    const candidate = tenths / 10;
    const ignores = Math.min(...per.map(s => s.ignores));
    const existing = base.files[file];
    if (existing === undefined) {
      if (candidate >= NEW_FILE_FLOOR || init) {
        base.files[file] = { score: candidate, ignores };
        notes.push(`${file}: added at ${candidate.toFixed(1)}% (lowest run ${fmt(lowest.score)}, spread ${spread} mutant(s))`);
      } else {
        notes.push(`${file}: no entry added, ${candidate.toFixed(1)}% is under the ${NEW_FILE_FLOOR}% floor for a new file`);
      }
      continue;
    }
    if (candidate > existing.score) {
      notes.push(`${file}: raised from ${existing.score.toFixed(1)}% to ${candidate.toFixed(1)}% (lowest run ${fmt(lowest.score)}, spread ${spread} mutant(s))`);
      base.files[file] = { score: candidate, ignores: existing.ignores };
    }
    if (ignores < base.files[file].ignores) {
      notes.push(`${file}: ignores lowered from ${base.files[file].ignores} to ${ignores}`);
      base.files[file] = { ...base.files[file], ignores };
    } else if (ignores > base.files[file].ignores) {
      notes.push(`${file}: has ${ignores} ignores against the baseline's ${base.files[file].ignores}. Not changed here: raise it by hand with the reason in the PR`);
    }
  }
  return { baseline: base, notes };
}

// ---------------------------------------------------------------------------
// Markdown

export function renderCheck(
  result: CheckResult,
  compare: CompareResult | null,
  opts: { expected: string[] | null; labeled: boolean },
): string {
  const failures = [...result.failures, ...(compare?.failures ?? [])];
  const out: string[] = ['## Mutation ratchet', ''];
  if (failures.length === 0) {
    out.push(
      opts.expected !== null && opts.expected.length === 0
        ? '**Nothing was mutated, so no score was checked. This is not a pass.**'
        : `Pass. ${result.checked} file(s) checked against \`mutation-baseline.json\`${opts.expected === null ? ' (the whole scope)' : ` (${opts.expected.length} file(s) mutated, not the whole scope)`}.`,
      '',
    );
  } else {
    out.push(`**Fail: ${failures.length} problem(s).**`, '', ...failures.map(f => `- ${f.message}`), '');
  }
  if (compare && compare.changes.length > 0 && opts.labeled) {
    out.push(`The PR has the \`${BASELINE_LABEL}\` label, so these are allowed by the check. They still need the maintainer's OK:`, '', ...compare.changes.map(c => `- ${c}`), '');
  }
  if (result.reruns.length > 0) {
    const changed = result.reruns.filter(r => r.cleared).length;
    out.push(
      `Re-runs from a fresh sandbox: ${result.reruns.length}, which changed the result for ${changed}.`,
      '',
      '| File | First run | Re-run | Baseline |',
      '|---|---:|---:|---:|',
      ...result.reruns.map(r => `| \`${r.file}\` | ${fmt(r.first)} | ${fmt(r.second)} | ${fmt(r.baseline)} |`),
      '',
    );
  }
  if (result.raisable.length > 0) {
    out.push(
      'The baseline can be raised (not a failure). Run `npx tsx scripts/mutation-ratchet.ts --update` on the weekly full run\'s report, or on the lower of two runs:',
      '',
      ...result.raisable.map(r => `- \`${r.file}\`: ${fmt(r.score)}, baseline ${fmt(r.baseline)}`),
      '',
    );
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI

function flagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === `--${name}` && i + 1 < args.length) out.push(args[i + 1]);
  });
  return out;
}
const flag = (args: string[], name: string) => flagValues(args, name)[0];
const has = (args: string[], name: string) => args.includes(`--${name}`);

const git = (...args: string[]): string =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

function gitShow(rev: string, path: string): string | null {
  try {
    return git('show', `${rev}:${path}`);
  } catch {
    return null;
  }
}

function measuredScope(read: (path: string) => string | null): MeasuredScope {
  const baselineText = read('mutation-baseline.json');
  const strykerText = read('stryker.config.json');
  const vitestText = read('vitest.mutation.config.ts');
  return {
    baseline: baselineText === null ? null : parseBaseline(baselineText),
    mutate: strykerText === null ? null : (JSON.parse(strykerText) as { mutate?: string[] }).mutate ?? null,
    exclude: vitestText === null ? null : extractStringList(vitestText, 'exclude'),
  };
}

/** Re-runs one file from a fresh sandbox: no incremental file, its own report. */
function rerunFile(file: string): FileStats | null {
  const config = JSON.parse(readFileSync('stryker.config.json', 'utf8')) as Record<string, unknown>;
  const reportPath = 'reports/mutation/rerun.json';
  mkdirSync('reports/mutation', { recursive: true });
  const rerunConfig = 'reports/mutation/rerun.stryker.config.json';
  writeFileSync(
    rerunConfig,
    JSON.stringify({
      ...config,
      incremental: false,
      incrementalFile: 'reports/mutation/rerun-incremental.json',
      mutate: [file],
      reporters: ['json'],
      jsonReporter: { fileName: reportPath },
    }),
  );
  try {
    execFileSync('npx', ['stryker', 'run', rerunConfig], { stdio: ['ignore', 'inherit', 'inherit'] });
    const row = (JSON.parse(readFileSync(reportPath, 'utf8')) as Report).files[file];
    return row ? fileStats(row.mutants) : null;
  } catch {
    return null;
  }
}

function runCheck(args: string[]): number {
  const reportPath = flag(args, 'report') ?? 'reports/mutation/mutation.json';
  const baselinePath = flag(args, 'baseline') ?? 'mutation-baseline.json';
  const planPath = flag(args, 'plan') ?? 'reports/mutation/plan.json';
  const labels = (flag(args, 'labels') ?? process.env.PR_LABELS ?? '').split(',').map(l => l.trim());
  const labeled = labels.includes(BASELINE_LABEL);
  const baseRev = flag(args, 'base');

  const baseline = parseBaseline(readFileSync(baselinePath, 'utf8'));
  const plan: { mode?: string; mutate?: string[] } | null = existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf8')) : null;
  const expected = plan?.mode === 'targeted' ? (plan.mutate ?? []) : plan?.mode === 'empty' ? [] : null;

  let result: CheckResult = { failures: [], raisable: [], reruns: [], checked: 0 };
  if (expected !== null && expected.length === 0) {
    // Nothing was mutated (a cache-miss run with no source file to check). Say so; the base comparison still runs.
  } else if (!existsSync(reportPath)) {
    result.failures.push({ kind: 'no-report-row', file: null, message: `No Stryker report at ${reportPath}, so no score was checked.` });
  } else {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
    result = check({ report, baseline, expected, exists: existsSync, rerun: has(args, 'no-rerun') ? undefined : rerunFile });
  }

  let compare: CompareResult | null = null;
  if (baseRev) {
    const mergeBase = git('merge-base', 'HEAD', baseRev).trim();
    compare = compareToBase({
      base: measuredScope(p => gitShow(mergeBase, p)),
      head: measuredScope(p => (existsSync(p) ? readFileSync(p, 'utf8') : null)),
      exists: existsSync,
      labeled,
    });
  }

  const markdown = renderCheck(result, compare, { expected, labeled });
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  return result.failures.length + (compare?.failures.length ?? 0) > 0 ? 1 : 0;
}

function runUpdate(args: string[]): number {
  const reportPaths = flagValues(args, 'report');
  const baselinePath = flag(args, 'baseline') ?? 'mutation-baseline.json';
  if (reportPaths.length === 0) throw new Error('--update needs --report <file>, twice, or once with --weekly');
  if (reportPaths.length === 1 && !has(args, 'weekly')) {
    throw new Error(
      '--update reads the weekly full run\'s report (--weekly --report <file>) or the lower of two runs (--report a --report b), never a single local run, which can be a lucky one',
    );
  }
  const baseline = existsSync(baselinePath) ? parseBaseline(readFileSync(baselinePath, 'utf8')) : null;
  const init = has(args, 'init');
  if (init && baseline !== null && Object.keys(baseline.files).length > 0) throw new Error('--init is for the first baseline only');
  const { baseline: updated, notes } = updateBaseline({
    baseline,
    reports: reportPaths.map(p => JSON.parse(readFileSync(p, 'utf8')) as Report),
    init,
  });
  writeFileSync(baselinePath, formatBaseline(updated));
  console.log(notes.length === 0 ? 'Nothing to raise.' : notes.join('\n'));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2).filter(a => a !== 'check');
  try {
    process.exit(has(args, 'update') ? runUpdate(args) : runCheck(args));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
