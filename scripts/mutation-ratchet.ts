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
 *        [--base <the commit the PR is based on, the one scripts/mutation-ci.ts plans against>] [--labels '["a","b"]'|a,b] [--no-rerun] [--max-reruns 3] [--rerun-budget-seconds 240]
 *   node scripts/mutation-ratchet.ts --update --report <run1.json> --report <run2.json> [--init]
 *   node scripts/mutation-ratchet.ts --update --weekly --report <weekly full run's report>
 *
 * `check` prints Markdown (and appends it to $GITHUB_STEP_SUMMARY) and exits 1 on any failure.
 * `--update` only raises scores (see `updateBaseline`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
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
  /** Source lines of disables that have no written reason (`isBareReason`). */
  bareDisableLines: Array<number | null>;
}

/**
 * What Stryker 10 puts in `statusReason` for `// Stryker disable next-line <mutator>` with no `: reason`.
 * The ADR expected an empty one, but a CI run (#205) showed Stryker fills in this text instead.
 */
export const STRYKER_DEFAULT_REASON = 'Ignored using a comment';

/** True for a disable that has no written reason: nothing, blank, or Stryker's own default text. */
export function isBareReason(reason: string | undefined): boolean {
  const text = (reason ?? '').trim();
  return text === '' || text === STRYKER_DEFAULT_REASON;
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
    bareDisableLines: disabled.filter(m => isBareReason(m.statusReason)).map(m => m.location?.start?.line ?? null),
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
  | 'new-entry-under-floor'
  | 'scope-changed'
  | 'changed-source-unchecked';

export interface Failure {
  kind: FailureKind;
  file: string | null;
  message: string;
}

export interface Rerun {
  file: string;
  /** Score of the run that was below the baseline. */
  first: number | null;
  /** Score of the single re-run from a fresh sandbox, or null when it couldn't run or wasn't run. */
  second: number | null;
  baseline: number;
  /** True when the re-run cleared the file. */
  cleared: boolean;
  /** Why the file was not re-run (the budget was spent), when it wasn't. It counts as still below. */
  skipped?: string;
}

/** What the re-runs may cost. They run inside the PR job's 10-minute budget, after Stryker's own step. */
export interface RerunBudget {
  /** At most this many files are re-run. */
  maxReruns: number;
  /** Total milliseconds for all re-runs. Each gets what is left, as its own timeout. */
  budgetMs: number;
  now?: () => number;
}

export const DEFAULT_RERUN_BUDGET: RerunBudget = { maxReruns: 3, budgetMs: 4 * 60 * 1000 };

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
  /**
   * Re-runs one file once from a fresh sandbox, giving up after `timeoutMs`. Omit to skip the re-run.
   * Returns the new stats, or null when it failed or ran out of time.
   */
  rerun?: (file: string, timeoutMs: number) => FileStats | null;
  rerunBudget?: RerunBudget;
  /**
   * Called once, before the first re-run starts, with every failure found so far (a file waiting for
   * its re-run is listed as below its baseline). A re-run that hangs then still leaves the cause in the log.
   */
  beforeRerun?: (failures: Failure[]) => void;
}

export interface CheckResult {
  failures: Failure[];
  /** A file scored above its baseline: the baseline can be raised (not a failure). */
  raisable: Array<{ file: string; score: number; baseline: number }>;
  reruns: Rerun[];
  /** How many files had a score checked against an entry. */
  checked: number;
}

const ADD_TESTS = 'Add or strengthen tests for the survivors in the report.';

const fmt = (n: number | null) => (n === null ? 'n/a' : `${n.toFixed(1)}%`);

export function check(input: CheckInput): CheckResult {
  const { report, baseline, expected, exists } = input;
  const failures: Failure[] = [];
  const raisable: CheckResult['raisable'] = [];
  const reruns: Rerun[] = [];
  const pending: Array<{ file: string; scored: number; first: number; baseline: number; message: string }> = [];
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
        const message = `${file} scores ${fmt(s.score)}, below its baseline ${fmt(entry.score)}`;
        if (input.rerun) pending.push({ file, scored: s.scored, first: s.score, baseline: entry.score, message });
        else failures.push({ kind: 'below-baseline', file, message: `${message}. ${ADD_TESTS}` });
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

  if (pending.length > 0 && input.rerun) {
    input.beforeRerun?.([
      ...failures,
      ...pending.map((p): Failure => ({ kind: 'below-baseline', file: p.file, message: `${p.message}. Re-running it once from a fresh sandbox before this fails.` })),
    ]);
    const budget = input.rerunBudget ?? DEFAULT_RERUN_BUDGET;
    const now = budget.now ?? Date.now;
    const started = now();
    // The smallest files first: they are cheapest, so more of them fit in the budget.
    pending.sort((a, b) => a.scored - b.scored || a.file.localeCompare(b.file));
    pending.forEach((p, i) => {
      const left = budget.budgetMs - (now() - started);
      const skipped = i >= budget.maxReruns ? `at most ${budget.maxReruns} files are re-run` : left <= 0 ? 'the re-run time budget is spent' : undefined;
      if (skipped !== undefined) {
        reruns.push({ file: p.file, first: p.first, second: null, baseline: p.baseline, cleared: false, skipped });
        failures.push({
          kind: 'below-baseline',
          file: p.file,
          message: `${p.message}, and was not re-run (${skipped}), so it counts as below. Re-run the job, or ${ADD_TESTS.charAt(0).toLowerCase()}${ADD_TESTS.slice(1)}`,
        });
        return;
      }
      const second = input.rerun?.(p.file, left) ?? null;
      const cleared = second !== null && second.score !== null && second.score >= p.baseline;
      reruns.push({ file: p.file, first: p.first, second: second?.score ?? null, baseline: p.baseline, cleared });
      if (!cleared) {
        failures.push({
          kind: 'below-baseline',
          file: p.file,
          message: `${p.message}${second?.score == null ? ', and the re-run did not produce a score (it failed or ran out of time)' : `, and ${fmt(second.score)} again on a re-run from a fresh sandbox`}. ${ADD_TESTS}`,
        });
      }
    });
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
 * A lowered `score`, a removed entry (for a file that still exists), a new entry under the new-file
 * floor, an edit to the `mutate` globs or an edit to the exclusion list, against the base branch,
 * fails unless the PR has the label.
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
  // A new entry is held to the new-file floor here too, or an author could add a weak file by writing
  // its real score in the baseline (ADR-0026, "New files"). Moved or renamed code that lands under the
  // floor can use the label. Nothing is flagged when the base has no baseline (the PR that adds it).
  if (base.baseline !== null) {
    for (const [file, after] of Object.entries(head.baseline?.files ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (base.baseline.files[file] === undefined && after.score < NEW_FILE_FLOOR) {
        changes.push({
          kind: 'new-entry-under-floor',
          file,
          text: `${file} is a new baseline entry at ${after.score.toFixed(1)}%, under the ${NEW_FILE_FLOOR}% floor for a new file`,
        });
      }
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
// Changed sources left to the weekly run (ADR-0028, #239)

/** The fields of a `mutation-weekly.yml` run, as the Actions API lists it, that the gate reads. */
export interface WeeklyRun {
  /** The commit the workflow file ran from: the branch tip it was started on, not the `ref` input. */
  head_sha: string;
  /** The run's title. `run-name` in mutation-weekly.yml puts the `ref` input in it, so it holds the SHA checked out. */
  display_title?: string | null;
  conclusion: string | null;
}

/**
 * True when a successful `mutation-weekly.yml` run covers the commit. A run started from a branch with
 * an empty `ref` checks out its own `head_sha`. A run started with a SHA in `ref` has the branch it was
 * started from as `head_sha`, so that SHA is matched in the title (`run-name` in the workflow). The weekly
 * run fails when a file is below its baseline, so `success` means every file passed.
 */
export function weeklyRunCovers(runs: readonly WeeklyRun[], sha: string): boolean {
  return runs.some(r => r.conclusion === 'success' && (r.head_sha === sha || (r.display_title ?? '').includes(sha)));
}

/**
 * The failure for changed source files the plan left out because they passed the mutant budget, or null.
 * A changed source that no mutation run checked on its own PR would pass unchecked, so this fails the
 * ratchet unless a successful weekly run exists for the PR's head commit. After someone runs it, re-running
 * the job turns it green. Files imported by changed tests and baseline entries are not gated (they stay
 * the `::warning`). It makes no call when no changed source was left out, and none outside a PR (no
 * `headSha`: a push to main has nothing to wait for). A lookup that fails is a failure too, since an
 * unchecked file must not pass for want of an answer. `listRuns` is the one network call, passed in.
 */
export async function changedSourceGate(opts: {
  changedSources: readonly string[];
  headSha: string | undefined;
  listRuns: () => Promise<readonly WeeklyRun[]>;
}): Promise<Failure | null> {
  const { changedSources, headSha } = opts;
  if (changedSources.length === 0 || headSha === undefined || headSha === '') return null;
  const files = changedSources.map(f => `\`${f}\``).join(', ');
  const lead = `${changedSources.length} changed source file(s) were not mutated on this PR, since they pass the mutant budget: ${files}.`;
  const fix = (sha: string) => `Run mutation-weekly.yml on ${sha} (Actions tab, "Run workflow", the full SHA in "ref"), then re-run this job.`;
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    return { kind: 'changed-source-unchecked', file: null, message: `${lead} The PR's head commit is not a full SHA, so a weekly run for it can't be looked up. ${fix("this PR's head commit")}` };
  }
  let runs: readonly WeeklyRun[];
  try {
    runs = await opts.listRuns();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { kind: 'changed-source-unchecked', file: null, message: `${lead} Looking up the mutation-weekly.yml runs failed (${why}), so this can't be told from a missing run. ${fix(headSha)}` };
  }
  if (weeklyRunCovers(runs, headSha)) return null;
  return { kind: 'changed-source-unchecked', file: null, message: `${lead} No successful mutation-weekly.yml run exists for ${headSha}. ${fix(headSha)}` };
}

/**
 * The successful runs of `mutation-weekly.yml`, newest first, from the Actions API (one page of 100, which
 * holds many weeks of runs). Needs `actions: read` on GITHUB_TOKEN. The token is only sent as a header and
 * is never in a message.
 */
export async function listWeeklyRuns(env: Record<string, string | undefined>): Promise<WeeklyRun[]> {
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are needed');
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  const response = await fetch(`${api}/repos/${repo}/actions/workflows/mutation-weekly.yml/runs?status=success&per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`the GitHub API answered ${response.status}; the job needs \`actions: read\``);
  const body = (await response.json()) as { workflow_runs?: unknown };
  return Array.isArray(body.workflow_runs) ? (body.workflow_runs as WeeklyRun[]) : [];
}

// ---------------------------------------------------------------------------
// Markdown

/** How many files the plan left out, per group (the `leftToWeeklyByGroup` of scripts/mutation-ci.ts). */
export interface LeftGroups {
  changedSources: readonly string[];
  fromTests: readonly string[];
  fromBaseline: readonly string[];
}

/**
 * What to say when the plan left files to the weekly full run because they passed the mutant budget
 * (#223, #239): a GitHub `::warning` annotation (shown on the PR's checks page, so a green check doesn't
 * hide it) and a Markdown line for the ratchet's own section of the summary. Null when nothing was left
 * out. It never fails the job: `changedSourceGate` does that for the changed sources, and a test import or a
 * baseline entry left out is only this warning, so a re-baseline goes green. `groups` names how many of the
 * files are changed sources, files imported by changed tests and baseline entries. `headSha` is the PR's
 * head commit, shown only when it is a full SHA.
 */
export function leftToWeeklyNotice(
  leftToWeekly: readonly string[],
  headSha?: string,
  groups?: LeftGroups,
): { annotation: string; line: string } | null {
  if (leftToWeekly.length === 0) return null;
  const n = leftToWeekly.length;
  const commit = headSha !== undefined && /^[0-9a-f]{40}$/.test(headSha) ? headSha : "this PR's head commit";
  // [count, singular, plural]: the label follows the count ("1 changed source", "2 changed sources").
  const named: [number, string, string][] = groups
    ? [
        [groups.changedSources.length, 'changed source', 'changed sources'],
        [groups.fromTests.length, 'imported by changed tests', 'imported by changed tests'],
        [groups.fromBaseline.length, 'baseline entry', 'baseline entries'],
      ]
    : [];
  const parts = named.filter(([count]) => count !== 0).map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return {
    annotation: `::warning title=Mutation testing::${n} file(s)${detail} over the mutant budget left to mutation-weekly.yml; run it on ${commit} before merging`,
    line: `**${n} file(s)${detail} were not mutated on this PR, over the mutant budget, and are unchecked until the weekly full run covers them.** Run \`mutation-weekly.yml\` on ${commit} before merging (Actions tab, "Run workflow", the full SHA in "ref"). The job summary lists the files by group.`,
  };
}

export function renderCheck(
  result: CheckResult,
  compare: CompareResult | null,
  opts: { expected: string[] | null; labeled: boolean; leftToWeekly?: readonly string[]; leftGroups?: LeftGroups; headSha?: string },
): string {
  const failures = [...result.failures, ...(compare?.failures ?? [])];
  const out: string[] = ['## Mutation ratchet', ''];
  const notice = leftToWeeklyNotice(opts.leftToWeekly ?? [], opts.headSha, opts.leftGroups);
  if (notice) out.push(notice.line, '');
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
    const skipped = result.reruns.filter(r => r.skipped !== undefined).length;
    out.push(
      `Re-runs from a fresh sandbox: ${result.reruns.length - skipped}, which changed the result for ${changed}.${skipped > 0 ? ` ${skipped} file(s) were not re-run because the re-run budget was spent, and count as below their baseline.` : ''}`,
      '',
      '| File | First run | Re-run | Baseline |',
      '|---|---:|---:|---:|',
      ...result.reruns.map(r => `| \`${r.file}\` | ${fmt(r.first)} | ${r.skipped !== undefined ? `not run (${r.skipped})` : fmt(r.second)} | ${fmt(r.baseline)} |`),
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
// Arguments

/**
 * The PR's label names. A JSON array (what the workflow passes, so a label name containing a comma
 * can't pass for two) or, for a hand run, a comma list. Names are compared whole, never as substrings.
 */
export function parseLabels(value: string | undefined): string[] {
  const text = (value ?? '').trim();
  if (text === '') return [];
  if (text.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('the PR labels are not a valid JSON array');
    }
    if (!Array.isArray(parsed)) throw new Error('the PR labels are not a valid JSON array');
    return parsed.filter((l): l is string => typeof l === 'string');
  }
  return text.split(',').map(l => l.trim());
}

export const hasBaselineLabel = (labels: string[]) => labels.includes(BASELINE_LABEL);

export interface UpdateArgs {
  reportPaths: string[];
  /** The one report is the weekly full run's. The script can't check it, so it is the author's word. */
  weekly: boolean;
  init: boolean;
  /** The baseline on disk, or null when there is none. */
  baseline: Baseline | null;
}

export interface UpdateArgsIo {
  resolvePath: (path: string) => string;
  read: (path: string) => string;
}

/**
 * The rules that keep `--update` from reading a single run: a lone report needs `--weekly`, the
 * same report twice is one run (by path or by content, which would give a spread of 0), and `--init`
 * is for the first baseline only. Throws a message naming the rule.
 */
export function checkUpdateArgs(args: UpdateArgs, io: UpdateArgsIo): void {
  const { reportPaths, weekly, init, baseline } = args;
  if (reportPaths.length === 0) throw new Error('--update needs --report <file>, twice, or once with --weekly');
  const resolved = reportPaths.map(io.resolvePath);
  if (new Set(resolved).size !== resolved.length) {
    throw new Error('--update was given the same report twice, which is one run, not the lower of two');
  }
  const hashes = reportPaths.map(p => createHash('sha256').update(io.read(p)).digest('hex'));
  if (new Set(hashes).size !== hashes.length) {
    throw new Error('--update was given two reports with the same content, which is one run copied, not the lower of two');
  }
  if (weekly && reportPaths.length !== 1) throw new Error('--weekly names the one report of the weekly full run; give it a single --report');
  if (reportPaths.length === 1 && !weekly) {
    throw new Error(
      "--update reads the weekly full run's report (--weekly --report <file>) or the lower of two runs (--report a --report b), never a single local run, which can be a lucky one",
    );
  }
  if (init && baseline !== null && Object.keys(baseline.files).length > 0) throw new Error('--init is for the first baseline only');
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

/** What `runInProcessGroup` needs from the OS. Faked in tests. */
export interface ProcessGroupIo {
  /** `spawnSync`, narrowed to what the helper reads from the result. */
  spawnSync(
    command: string,
    args: string[],
    options: { stdio: ['ignore', 'inherit', 'inherit']; detached: true; timeout: number; killSignal: 'SIGKILL' },
  ): { pid?: number; status: number | null; error?: Error };
  /** `process.kill`. A negative pid signals the whole process group. */
  kill(pid: number, signal: 'SIGKILL'): void;
}

const realProcessGroupIo: ProcessGroupIo = { spawnSync, kill: (pid, signal) => process.kill(pid, signal) };

/**
 * Runs a command to completion and returns true when it exited 0 inside `timeoutMs`.
 *
 * The child is spawned `detached`, so it leads its own process group, and when it times out or fails the
 * whole group is killed (`kill(-pid)`), not just the child. `spawnSync`'s own timeout signals only the
 * child, and `npx` is a thin parent of the Stryker process and its vitest workers: killing `npx` alone
 * left them running until the job ended (#223, from the #217 review). A successful run is not swept.
 */
export function runInProcessGroup(command: string, args: string[], timeoutMs: number, io: ProcessGroupIo = realProcessGroupIo): boolean {
  const result = io.spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], detached: true, timeout: timeoutMs, killSignal: 'SIGKILL' });
  const ok = result.error === undefined && result.status === 0;
  if (!ok && result.pid !== undefined) {
    try {
      io.kill(-result.pid, 'SIGKILL');
    } catch {
      // The group is already gone (ESRCH): nothing left to kill.
    }
  }
  return ok;
}

/** Re-runs one file from a fresh sandbox: no incremental file, its own report. */
function rerunFile(file: string, timeoutMs: number): FileStats | null {
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
    if (!runInProcessGroup('npx', ['stryker', 'run', rerunConfig], Math.max(1000, timeoutMs))) return null;
    const row = (JSON.parse(readFileSync(reportPath, 'utf8')) as Report).files[file];
    return row ? fileStats(row.mutants) : null;
  } catch {
    return null;
  }
}

async function runCheck(args: string[]): Promise<number> {
  const reportPath = flag(args, 'report') ?? 'reports/mutation/mutation.json';
  const baselinePath = flag(args, 'baseline') ?? 'mutation-baseline.json';
  const planPath = flag(args, 'plan') ?? 'reports/mutation/plan.json';
  const labeled = hasBaselineLabel(parseLabels(flag(args, 'labels') ?? process.env.PR_LABELS));
  const baseRev = flag(args, 'base');
  const budget: RerunBudget = {
    maxReruns: Number(flag(args, 'max-reruns') ?? DEFAULT_RERUN_BUDGET.maxReruns),
    budgetMs: Number(flag(args, 'rerun-budget-seconds') ?? DEFAULT_RERUN_BUDGET.budgetMs / 1000) * 1000,
  };
  if (!Number.isFinite(budget.maxReruns) || !Number.isFinite(budget.budgetMs)) throw new Error('--max-reruns and --rerun-budget-seconds take numbers');

  const baseline = parseBaseline(readFileSync(baselinePath, 'utf8'));
  const plan: { mode?: string; mutate?: string[]; leftToWeekly?: string[]; leftToWeeklyByGroup?: LeftGroups } | null = existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf8')) : null;
  const expected = plan?.mode === 'targeted' ? (plan.mutate ?? []) : plan?.mode === 'empty' ? [] : null;
  const leftToWeekly = plan?.leftToWeekly ?? [];
  const leftGroups = plan?.leftToWeeklyByGroup;
  const headSha = process.env.PR_HEAD_SHA;
  // A changed source the budget left out fails unless a weekly run covers the head commit (ADR-0028).
  const gateFailure = await changedSourceGate({
    changedSources: leftGroups?.changedSources ?? [],
    headSha,
    listRuns: () => listWeeklyRuns(process.env),
  });

  // The base comparison is cheap, so it runs first and its failures are in the log before any re-run starts.
  let compare: CompareResult | null = null;
  if (baseRev) {
    // The commit as given, not its merge-base with HEAD: scripts/mutation-ci.ts reads the PR base's baseline
    // at the same commit (ci.yml passes one BASE_SHA to both), and a moved base would make the two differ (#223).
    const baseCommit = git('rev-parse', '--verify', `${baseRev}^{commit}`).trim();
    compare = compareToBase({
      base: measuredScope(p => gitShow(baseCommit, p)),
      head: measuredScope(p => (existsSync(p) ? readFileSync(p, 'utf8') : null)),
      exists: existsSync,
      labeled,
    });
  }

  let result: CheckResult = { failures: [], raisable: [], reruns: [], checked: 0 };
  if (expected !== null && expected.length === 0) {
    // Nothing was mutated (a cache-miss run with no source file to check). Say so; the base comparison still ran.
  } else if (!existsSync(reportPath)) {
    result.failures.push({ kind: 'no-report-row', file: null, message: `No Stryker report at ${reportPath}, so no score was checked.` });
  } else {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
    result = check({
      report,
      baseline,
      expected,
      exists: existsSync,
      rerun: has(args, 'no-rerun') ? undefined : rerunFile,
      rerunBudget: budget,
      beforeRerun: failures => {
        console.log(renderCheck({ failures, raisable: [], reruns: [], checked: 0 }, compare, { expected, labeled, leftToWeekly, leftGroups, headSha }));
        console.log(`Re-running the files below their baseline (at most ${budget.maxReruns}, ${Math.round(budget.budgetMs / 1000)} s in all)...`);
      },
    });
  }

  if (gateFailure) result.failures.push(gateFailure);
  const markdown = renderCheck(result, compare, { expected, labeled, leftToWeekly, leftGroups, headSha });
  console.log(markdown);
  // An annotation on the PR's checks page, since a green check hides the summary. It doesn't fail the job.
  const notice = leftToWeeklyNotice(leftToWeekly, headSha, leftGroups);
  if (notice) console.log(notice.annotation);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  return result.failures.length + (compare?.failures.length ?? 0) > 0 ? 1 : 0;
}

function runUpdate(args: string[]): number {
  const reportPaths = flagValues(args, 'report');
  const baselinePath = flag(args, 'baseline') ?? 'mutation-baseline.json';
  const baseline = existsSync(baselinePath) ? parseBaseline(readFileSync(baselinePath, 'utf8')) : null;
  const init = has(args, 'init');
  checkUpdateArgs({ reportPaths, weekly: has(args, 'weekly'), init, baseline }, { resolvePath: p => resolve(p), read: p => readFileSync(p, 'utf8') });
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
  (async () => (has(args, 'update') ? runUpdate(args) : await runCheck(args)))().then(
    code => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    },
  );
}
