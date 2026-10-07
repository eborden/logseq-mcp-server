import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASELINE_LABEL,
  DEFAULT_RERUN_BUDGET,
  NEW_FILE_FLOOR,
  STRYKER_DEFAULT_REASON,
  check,
  checkUpdateArgs,
  compareToBase,
  hasBaselineLabel,
  parseLabels,
  extractStringList,
  fileStats,
  formatBaseline,
  isBareReason,
  leftToWeeklyNotice,
  parseBaseline,
  renderCheck,
  runInProcessGroup,
  scoreOf,
  updateBaseline,
  type Baseline,
  type CheckResult,
  type FileStats,
  type MeasuredScope,
  type ProcessGroupIo,
  type Report,
  type ReportMutant,
} from '../scripts/mutation-ratchet.js';

// The ratchet of ADR-0026 (#205). Every report and baseline below is made up: file names are
// invented, and the mutants are counts of statuses only.

type Spec = { killed?: number; timeout?: number; survived?: number; noCoverage?: number; staticIgnored?: number; disabled?: Array<string | undefined> };

function mutants(spec: Spec): ReportMutant[] {
  const out: ReportMutant[] = [];
  const add = (n: number | undefined, status: string) => {
    for (let i = 0; i < (n ?? 0); i += 1) out.push({ status });
  };
  add(spec.killed, 'Killed');
  add(spec.timeout, 'Timeout');
  add(spec.survived, 'Survived');
  add(spec.noCoverage, 'NoCoverage');
  for (let i = 0; i < (spec.staticIgnored ?? 0); i += 1) {
    out.push({ status: 'Ignored', static: true, statusReason: 'Static mutant (and "ignoreStatic" was enabled)' });
  }
  (spec.disabled ?? []).forEach((reason, i) => {
    out.push({ status: 'Ignored', static: false, statusReason: reason, location: { start: { line: 10 + i } } });
  });
  return out;
}

const report = (files: Record<string, Spec>, version = '10.0.0'): Report => ({
  framework: { version },
  files: Object.fromEntries(Object.entries(files).map(([f, s]) => [f, { mutants: mutants(s) }])),
});

const baseline = (files: Record<string, [number, number]>): Baseline => ({
  stryker: '10.0.0',
  files: Object.fromEntries(Object.entries(files).map(([f, [score, ignores]]) => [f, { score, ignores }])),
});

const present = () => true;

describe('file score', () => {
  it('counts timeouts as killed, no-coverage as survived, and leaves ignored mutants out of both', () => {
    const s = fileStats(mutants({ killed: 6, timeout: 2, survived: 1, noCoverage: 1, staticIgnored: 5, disabled: ['equivalent'] }));
    expect(s).toMatchObject({ killed: 6, timeout: 2, survived: 1, noCoverage: 1, scored: 10, score: 80, ignores: 1 });
  });

  it('floors to one decimal and gives 100 for a clean file', () => {
    expect(scoreOf(2, 3)).toBe(66.6);
    expect(scoreOf(285, 285)).toBe(100);
    expect(fileStats(mutants({ killed: 2, survived: 1 })).score).toBe(66.6);
  });

  it('has no score for a file with nothing to score', () => {
    expect(fileStats(mutants({ staticIgnored: 3 })).score).toBeNull();
  });

  it('does not count static-ignored mutants as ignores', () => {
    const s = fileStats(mutants({ killed: 4, staticIgnored: 7 }));
    expect(s.ignores).toBe(0);
    expect(s.bareDisableLines).toEqual([]);
  });

  it('counts a disable comment as an ignore, and one with no reason as bare', () => {
    const s = fileStats(mutants({ killed: 4, disabled: ['equivalent mutant', undefined, '  '] }));
    expect(s.ignores).toBe(3);
    expect(s.bareDisableLines).toEqual([11, 12]);
  });

  it("treats the text Stryker 10 fills in for a disable with no reason as bare", () => {
    // Seen in a CI report: `// Stryker disable next-line StringLiteral` gets this statusReason, not an empty one.
    const s = fileStats(mutants({ killed: 4, disabled: [STRYKER_DEFAULT_REASON, 'a real reason', `  ${STRYKER_DEFAULT_REASON} `] }));
    expect(s.ignores).toBe(3);
    expect(s.bareDisableLines).toEqual([10, 12]);
    expect(isBareReason('Ignored using a comment, because it is equivalent')).toBe(false);
  });
});

describe('check', () => {
  const base = baseline({ 'src/a.ts': [90, 0], 'src/b.ts': [80, 1] });

  it('passes a file at its baseline and a file above it, and notices the one that can be raised', () => {
    const result = check({
      report: report({ 'src/a.ts': { killed: 90, survived: 10 }, 'src/b.ts': { killed: 9, survived: 1, disabled: ['unreachable'] } }),
      baseline: base,
      expected: null,
      exists: present,
    });
    expect(result.failures).toEqual([]);
    expect(result.raisable).toEqual([{ file: 'src/b.ts', score: 90, baseline: 80 }]);
    expect(result.checked).toBe(2);
  });

  it('notices a baseline that can be raised only by a whole point, which is what --update rounds to', () => {
    const result = check({
      report: report({ 'src/a.ts': { killed: 905, survived: 95 }, 'src/b.ts': { killed: 4, survived: 1, disabled: ['x'] } }),
      baseline: baseline({ 'src/a.ts': [90, 0], 'src/b.ts': [80, 1] }),
      expected: null,
      exists: present,
    });
    expect(result.raisable).toEqual([]);
    const higher = check({
      report: report({ 'src/a.ts': { killed: 911, survived: 89 }, 'src/b.ts': { killed: 4, survived: 1, disabled: ['x'] } }),
      baseline: baseline({ 'src/a.ts': [90, 0], 'src/b.ts': [80, 1] }),
      expected: null,
      exists: present,
    });
    expect(higher.raisable).toEqual([{ file: 'src/a.ts', score: 91.1, baseline: 90 }]);
  });

  it('fails a file below its baseline', () => {
    const result = check({
      report: report({ 'src/a.ts': { killed: 89, survived: 11 }, 'src/b.ts': { killed: 4, survived: 1, disabled: ['x'] } }),
      baseline: base,
      expected: null,
      exists: present,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ kind: 'below-baseline', file: 'src/a.ts' });
    expect(result.failures[0].message).toContain('89.0%');
    expect(result.failures[0].message).toContain('90.0%');
  });

  it('fails a score that is below by one mutant, with no tolerance', () => {
    const result = check({
      report: report({ 'src/a.ts': { killed: 999, survived: 1 }, 'src/b.ts': { killed: 4, survived: 1, disabled: ['x'] } }),
      baseline: baseline({ 'src/a.ts': [100, 0], 'src/b.ts': [80, 1] }),
      expected: null,
      exists: present,
    });
    expect(result.failures.map(f => [f.kind, f.file])).toEqual([['below-baseline', 'src/a.ts']]);
  });

  describe('the single re-run', () => {
    const below = report({ 'src/a.ts': { killed: 89, survived: 11 }, 'src/b.ts': { killed: 4, survived: 1, disabled: ['x'] } });

    it('passes a file whose re-run is back at its baseline, and records that it changed the result', () => {
      const rerun = vi.fn((_file: string, _timeoutMs: number): FileStats => fileStats(mutants({ killed: 90, survived: 10 })));
      const result = check({ report: below, baseline: base, expected: null, exists: present, rerun });
      expect(result.failures).toEqual([]);
      expect(rerun).toHaveBeenCalledTimes(1);
      // The timeout is what is left of the budget on the real clock, so it can be a millisecond short.
      expect(rerun).toHaveBeenCalledWith('src/a.ts', expect.any(Number));
      expect(rerun.mock.calls[0][1]).toBeLessThanOrEqual(DEFAULT_RERUN_BUDGET.budgetMs);
      expect(result.reruns).toEqual([{ file: 'src/a.ts', first: 89, second: 90, baseline: 90, cleared: true }]);
    });

    it('fails when the re-run is still below', () => {
      const rerun = () => fileStats(mutants({ killed: 89, survived: 11 }));
      const result = check({ report: below, baseline: base, expected: null, exists: present, rerun });
      expect(result.failures.map(f => f.kind)).toEqual(['below-baseline']);
      expect(result.failures[0].message).toContain('again on a re-run');
      expect(result.reruns[0]).toMatchObject({ cleared: false, second: 89 });
    });

    it('fails when the re-run produced no score', () => {
      const result = check({ report: below, baseline: base, expected: null, exists: present, rerun: () => null });
      expect(result.failures.map(f => f.kind)).toEqual(['below-baseline']);
      expect(result.reruns[0]).toMatchObject({ cleared: false, second: null });
    });

    it('re-runs only a file that is below its baseline', () => {
      const rerun = vi.fn(() => null);
      check({
        report: report({ 'src/a.ts': { killed: 90, survived: 10 }, 'src/b.ts': { killed: 4, survived: 1, disabled: ['x'] } }),
        baseline: base,
        expected: null,
        exists: present,
        rerun,
      });
      expect(rerun).not.toHaveBeenCalled();
    });
  });

  describe('ignores', () => {
    it('fails when a file has more disable-comment ignores than the baseline', () => {
      const result = check({
        report: report({ 'src/a.ts': { killed: 95, survived: 5, disabled: ['equivalent'] }, 'src/b.ts': { killed: 4, survived: 1, disabled: ['x'] } }),
        baseline: base,
        expected: null,
        exists: present,
      });
      expect(result.failures.map(f => [f.kind, f.file])).toEqual([['ignores-up', 'src/a.ts']]);
    });

    it('does not count static-ignored mutants against the baseline', () => {
      const result = check({
        report: report({ 'src/a.ts': { killed: 95, survived: 5, staticIgnored: 40 }, 'src/b.ts': { killed: 4, survived: 1, disabled: ['x'] } }),
        baseline: base,
        expected: null,
        exists: present,
      });
      expect(result.failures).toEqual([]);
    });

    it('allows fewer ignores than the baseline', () => {
      const result = check({
        report: report({ 'src/a.ts': { killed: 95, survived: 5 }, 'src/b.ts': { killed: 4, survived: 1 } }),
        baseline: base,
        expected: null,
        exists: present,
      });
      expect(result.failures).toEqual([]);
    });

    it('fails a bare disable even when the count is within the baseline', () => {
      const result = check({
        report: report({ 'src/a.ts': { killed: 95, survived: 5 }, 'src/b.ts': { killed: 4, survived: 1, disabled: [undefined] } }),
        baseline: base,
        expected: null,
        exists: present,
      });
      expect(result.failures.map(f => [f.kind, f.file])).toEqual([['bare-disable', 'src/b.ts']]);
      expect(result.failures[0].message).toContain('line 10');
    });

    it('fails a bare disable in a new file too', () => {
      const result = check({
        report: report({ 'src/a.ts': { killed: 95, survived: 5 }, 'src/b.ts': { killed: 4, survived: 1, disabled: ['x'] }, 'src/new.ts': { killed: 9, survived: 1, disabled: [''] } }),
        baseline: base,
        expected: null,
        exists: present,
      });
      expect(result.failures.map(f => f.kind).sort()).toEqual(['bare-disable', 'new-file']);
    });
  });

  describe('new files', () => {
    const files = { 'src/a.ts': { killed: 90, survived: 10 }, 'src/b.ts': { killed: 4, survived: 1, disabled: ['x'] } };

    it('fails a file with no entry and a score over the floor, and says which line to add', () => {
      const result = check({ report: report({ ...files, 'src/new.ts': { killed: 17, survived: 3 } }), baseline: base, expected: null, exists: present });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({ kind: 'new-file', file: 'src/new.ts' });
      expect(result.failures[0].message).toContain('"src/new.ts": { "score": 85.0, "ignores": 0 }');
      expect(result.failures[0].message).not.toContain('under the');
    });

    it('passes a new file once its entry is in the baseline', () => {
      const result = check({
        report: report({ ...files, 'src/new.ts': { killed: 17, survived: 3 } }),
        baseline: baseline({ 'src/a.ts': [90, 0], 'src/b.ts': [80, 1], 'src/new.ts': [85, 0] }),
        expected: null,
        exists: present,
      });
      expect(result.failures).toEqual([]);
    });

    it(`fails a new file under the ${NEW_FILE_FLOOR} floor, and tells the author to raise it first`, () => {
      const result = check({ report: report({ ...files, 'src/new.ts': { killed: 79, survived: 21 } }), baseline: base, expected: null, exists: present });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({ kind: 'new-file', file: 'src/new.ts' });
      expect(result.failures[0].message).toContain('79.0%');
      expect(result.failures[0].message).toContain(`${NEW_FILE_FLOOR}%`);
      expect(result.failures[0].message).toContain('then add its entry');
    });

    it('passes a new file exactly at the floor', () => {
      const result = check({ report: report({ ...files, 'src/new.ts': { killed: 4, survived: 1 } }), baseline: base, expected: null, exists: present });
      expect(result.failures[0].message).not.toContain('under the');
    });

    it('does not ask for an entry for a file with nothing to score', () => {
      const result = check({ report: report({ ...files, 'src/types-only.ts': { staticIgnored: 3 } }), baseline: base, expected: null, exists: present });
      expect(result.failures).toEqual([]);
    });
  });

  describe('scope that shrank', () => {
    const files = { 'src/a.ts': { killed: 90, survived: 10 } };

    it('fails an entry with no row in the report, though the file is on disk', () => {
      const result = check({ report: report(files), baseline: base, expected: null, exists: present });
      expect(result.failures.map(f => [f.kind, f.file])).toEqual([['no-report-row', 'src/b.ts']]);
      expect(result.failures[0].message).toContain(BASELINE_LABEL);
    });

    it('fails an entry whose file is gone, and says to remove the entry', () => {
      const result = check({ report: report(files), baseline: base, expected: null, exists: p => p !== 'src/b.ts' });
      expect(result.failures.map(f => [f.kind, f.file])).toEqual([['file-deleted', 'src/b.ts']]);
    });

    it('fails a deleted file even when the run mutated only other files', () => {
      const result = check({ report: report(files), baseline: base, expected: ['src/a.ts'], exists: p => p !== 'src/b.ts' });
      expect(result.failures.map(f => f.kind)).toEqual(['file-deleted']);
    });

    it('expects a row for every entry after a whole-scope run, and only the planned files after a targeted one', () => {
      expect(check({ report: report(files), baseline: base, expected: null, exists: present }).failures).toHaveLength(1);
      expect(check({ report: report(files), baseline: base, expected: ['src/a.ts'], exists: present }).failures).toEqual([]);
      expect(check({ report: report(files), baseline: base, expected: ['src/a.ts', 'src/b.ts'], exists: present }).failures.map(f => f.kind)).toEqual([
        'no-report-row',
      ]);
    });
  });
});

describe('the base branch', () => {
  const scope = (over: Partial<MeasuredScope> = {}): MeasuredScope => ({
    baseline: baseline({ 'src/a.ts': [90, 0], 'src/b.ts': [80, 1] }),
    mutate: ['src/**/*.ts', '!src/**/*.test.ts', '!src/types.ts'],
    exclude: ['src/x.test.ts', 'src/y.test.ts'],
    ...over,
  });
  const compare = (head: Partial<MeasuredScope>, labeled = false, exists: (p: string) => boolean = present) =>
    compareToBase({ base: scope(), head: scope(head), exists, labeled });

  it('passes a PR that changes none of it', () => {
    expect(compare({})).toEqual({ failures: [], changes: [] });
  });

  it('passes a raised score and an increase in ignores', () => {
    const head = baseline({ 'src/a.ts': [95, 4], 'src/b.ts': [80, 3] });
    expect(compare({ baseline: head }).failures).toEqual([]);
  });

  it('fails a lowered score without the label', () => {
    const result = compare({ baseline: baseline({ 'src/a.ts': [89.9, 0], 'src/b.ts': [80, 1] }) });
    expect(result.failures.map(f => [f.kind, f.file])).toEqual([['baseline-lowered', 'src/a.ts']]);
    expect(result.failures[0].message).toContain(BASELINE_LABEL);
    expect(result.failures[0].message).toContain("maintainer's OK");
  });

  it('allows the same lowered score with the label, and still lists it', () => {
    const result = compare({ baseline: baseline({ 'src/a.ts': [89.9, 0], 'src/b.ts': [80, 1] }) }, true);
    expect(result.failures).toEqual([]);
    expect(result.changes).toEqual(['src/a.ts: baseline score lowered from 90.0% to 89.9%']);
  });

  it('fails a removed entry for a file that still exists, but not for one that is gone (a deletion or rename)', () => {
    const head = baseline({ 'src/a.ts': [90, 0] });
    expect(compare({ baseline: head }).failures.map(f => f.file)).toEqual(['src/b.ts']);
    expect(compare({ baseline: head }, false, p => p !== 'src/b.ts').failures).toEqual([]);
  });

  it('passes a new entry', () => {
    const head = baseline({ 'src/a.ts': [90, 0], 'src/b.ts': [80, 1], 'src/c.ts': [85, 0] });
    expect(compare({ baseline: head }).failures).toEqual([]);
  });

  it('fails an edit to the mutate globs without the label, and passes it with', () => {
    const head = { mutate: ['src/**/*.ts', '!src/**/*.test.ts'] };
    const result = compare(head);
    expect(result.failures.map(f => f.kind)).toEqual(['scope-changed']);
    expect(result.failures[0].message).toContain('stryker.config.json');
    expect(compare(head, true).failures).toEqual([]);
  });

  it('fails an edit to the guard-exclusion list, whatever its order, without the label', () => {
    const result = compare({ exclude: ['src/x.test.ts'] });
    expect(result.failures.map(f => f.kind)).toEqual(['scope-changed']);
    expect(result.failures[0].message).toContain('vitest.mutation.config.ts');
    expect(compare({ exclude: ['src/x.test.ts', 'src/y.test.ts', 'src/z.test.ts'] }).failures).toHaveLength(1);
    expect(compare({ exclude: ['src/x.test.ts', 'src/y.test.ts', 'src/z.test.ts'] }, true).failures).toEqual([]);
  });

  it('does not mind the order of the exclusion list', () => {
    expect(compare({ exclude: ['src/y.test.ts', 'src/x.test.ts'] }).failures).toEqual([]);
  });

  it('treats the mutate globs as ordered, since a negation can depend on what comes before it', () => {
    expect(compare({ mutate: ['!src/types.ts', 'src/**/*.ts', '!src/**/*.test.ts'] }).failures).toHaveLength(1);
  });

  it('passes when the base has no baseline yet (the PR that adds it)', () => {
    const result = compareToBase({ base: scope({ baseline: null }), head: scope(), exists: present, labeled: false });
    expect(result.failures).toEqual([]);
  });
});

describe('extractStringList', () => {
  const source = `
    export default mergeConfig(base, defineConfig({
      test: {
        exclude: [
          // a comment with 'quotes' and a [bracket]
          '**/.stryker-tmp/**', /* inline */ "src/adr-*.test.ts",
          'src/it\\'s.test.ts',
        ],
        include: ['src/other.ts'],
      },
    }));`;

  it('reads the strings of the named array, skipping comments', () => {
    expect(extractStringList(source, 'exclude')).toEqual(['**/.stryker-tmp/**', 'src/adr-*.test.ts', "src/it's.test.ts"]);
  });

  it('reads a JSON array', () => {
    expect(extractStringList('{ "mutate": ["src/**/*.ts", "!src/types.ts"] }', 'mutate')).toEqual(['src/**/*.ts', '!src/types.ts']);
  });

  it('returns null when the key is missing or the array never closes', () => {
    expect(extractStringList(source, 'missing')).toBeNull();
    expect(extractStringList('exclude: [ "a"', 'exclude')).toBeNull();
  });

  it('sees a change to the list but not to a comment', () => {
    const edited = source.replace('a comment with', 'a different comment with');
    expect(extractStringList(edited, 'exclude')).toEqual(extractStringList(source, 'exclude'));
    expect(extractStringList(source.replace('src/adr-*.test.ts', 'src/adr-1.test.ts'), 'exclude')).not.toEqual(extractStringList(source, 'exclude'));
  });
});

describe('baseline file', () => {
  const text = formatBaseline(baseline({ 'src/b.ts': [80, 1], 'src/a.ts': [90.5, 0] }));

  it('is written with sorted keys, one file per line, one decimal', () => {
    expect(text).toBe(
      '{\n  "stryker": "10.0.0",\n  "files": {\n    "src/a.ts": { "score": 90.5, "ignores": 0 },\n    "src/b.ts": { "score": 80.0, "ignores": 1 }\n  }\n}\n',
    );
  });

  it('round-trips', () => {
    expect(parseBaseline(text)).toEqual(baseline({ 'src/a.ts': [90.5, 0], 'src/b.ts': [80, 1] }));
  });

  it('rejects a malformed file with a message that does not quote it', () => {
    expect(() => parseBaseline('nope {')).toThrow('not valid JSON');
    expect(() => parseBaseline('{"files":{}}')).toThrow('"stryker"');
    expect(() => parseBaseline('{"stryker":"10.0.0","files":{"src/a.ts":{"score":"high","ignores":0}}}')).toThrow('src/a.ts');
    expect(() => parseBaseline('{"stryker":"10.0.0","files":{"src/a.ts":{"score":101,"ignores":0}}}')).toThrow('src/a.ts');
    expect(() => parseBaseline('{"stryker":"10.0.0","files":{"src/a.ts":{"score":90,"ignores":-1}}}')).toThrow('src/a.ts');
  });
});

describe('--update', () => {
  // 100 mutants, so one mutant is one point.
  const run = (killed: number, extra: Spec = {}) => ({ killed, survived: 100 - killed, ...extra });

  it('rounds down to a whole point, then takes off the spread in mutants', () => {
    // Lowest run 95.0, so 95; the runs differ by 2 mutants out of 100, so 93.
    const result = updateBaseline({
      baseline: baseline({ 'src/a.ts': [70, 0] }),
      reports: [report({ 'src/a.ts': run(95) }), report({ 'src/a.ts': run(97) })],
    });
    expect(result.baseline.files['src/a.ts']).toEqual({ score: 93, ignores: 0 });
  });

  it('floors a fractional score before it takes off the spread', () => {
    // 285 mutants, 270 killed is 94.7: floored to 94, not 95.
    const result = updateBaseline({
      baseline: baseline({ 'src/a.ts': [50, 0] }),
      reports: [report({ 'src/a.ts': { killed: 270, survived: 15 } }), report({ 'src/a.ts': { killed: 270, survived: 15 } })],
    });
    expect(result.baseline.files['src/a.ts'].score).toBe(94);
  });

  it('counts the spread in mutants, so a big file is not over-tolerant', () => {
    // One mutant out of 285 is 0.35 points: 94 - 0.35 = 93.6 (floored to one decimal).
    const result = updateBaseline({
      baseline: baseline({ 'src/a.ts': [50, 0] }),
      reports: [report({ 'src/a.ts': { killed: 270, survived: 15 } }), report({ 'src/a.ts': { killed: 271, survived: 14 } })],
    });
    expect(result.baseline.files['src/a.ts'].score).toBe(93.6);
  });

  it('never lowers a score', () => {
    const result = updateBaseline({
      baseline: baseline({ 'src/a.ts': [96, 0], 'src/b.ts': [60, 0] }),
      reports: [report({ 'src/a.ts': run(90), 'src/b.ts': run(60) }), report({ 'src/a.ts': run(91), 'src/b.ts': run(62) })],
    });
    expect(result.baseline.files['src/a.ts'].score).toBe(96);
    expect(result.baseline.files['src/b.ts'].score).toBe(60);
    expect(result.notes.join('\n')).not.toContain('src/a.ts');
  });

  it('keeps an entry for a file the reports do not hold', () => {
    const result = updateBaseline({ baseline: baseline({ 'src/gone.ts': [90, 2] }), reports: [report({}), report({})] });
    expect(result.baseline.files['src/gone.ts']).toEqual({ score: 90, ignores: 2 });
  });

  it('adds a new file at or over the floor, and not one under it', () => {
    const result = updateBaseline({
      baseline: baseline({}),
      reports: [report({ 'src/ok.ts': run(85), 'src/weak.ts': run(79) }), report({ 'src/ok.ts': run(85), 'src/weak.ts': run(79) })],
    });
    expect(result.baseline.files['src/ok.ts']).toEqual({ score: 85, ignores: 0 });
    expect(result.baseline.files['src/weak.ts']).toBeUndefined();
    expect(result.notes.join('\n')).toContain('src/weak.ts: no entry added');
  });

  it('records files under the floor for the first baseline only, with --init', () => {
    const reports = [report({ 'src/weak.ts': run(60) }), report({ 'src/weak.ts': run(60) })];
    expect(updateBaseline({ baseline: null, reports, init: true }).baseline).toEqual({
      stryker: '10.0.0',
      files: { 'src/weak.ts': { score: 60, ignores: 0 } },
    });
    expect(updateBaseline({ baseline: null, reports }).baseline.files).toEqual({});
  });

  it('uses the lowest run of each file, whichever run is lower', () => {
    const result = updateBaseline({
      baseline: baseline({}),
      reports: [report({ 'src/a.ts': run(92), 'src/b.ts': run(88) }), report({ 'src/a.ts': run(88), 'src/b.ts': run(92) })],
      init: true,
    });
    expect(result.baseline.files['src/a.ts'].score).toBe(84); // 88 minus a spread of 4
    expect(result.baseline.files['src/b.ts'].score).toBe(84);
  });

  it('never takes a file the runs did not all score', () => {
    const result = updateBaseline({
      baseline: baseline({}),
      reports: [report({ 'src/a.ts': run(95), 'src/only-first.ts': run(95) }), report({ 'src/a.ts': run(95) })],
    });
    expect(Object.keys(result.baseline.files)).toEqual(['src/a.ts']);
  });

  it('records the fewest ignores seen, lowers them when they dropped, and leaves a rise to the author', () => {
    const lowered = updateBaseline({
      baseline: baseline({ 'src/a.ts': [90, 3] }),
      reports: [report({ 'src/a.ts': run(90, { disabled: ['r', 'r'] }) }), report({ 'src/a.ts': run(90, { disabled: ['r', 'r'] }) })],
    });
    expect(lowered.baseline.files['src/a.ts'].ignores).toBe(2);
    const raised = updateBaseline({
      baseline: baseline({ 'src/a.ts': [90, 1] }),
      reports: [report({ 'src/a.ts': run(90, { disabled: ['r', 'r'] }) }), report({ 'src/a.ts': run(90, { disabled: ['r', 'r'] }) })],
    });
    expect(raised.baseline.files['src/a.ts'].ignores).toBe(1);
    expect(raised.notes.join('\n')).toContain('raise it by hand');
  });

  it('does not change a baseline it was given', () => {
    const given = baseline({ 'src/a.ts': [70, 0] });
    updateBaseline({ baseline: given, reports: [report({ 'src/a.ts': run(95) })] });
    expect(given.files['src/a.ts'].score).toBe(70);
  });

  it('refuses to run with no report', () => {
    expect(() => updateBaseline({ baseline: null, reports: [] })).toThrow('at least one report');
  });

  it('takes the Stryker version from the report for a first baseline, and keeps the baseline\'s own after that', () => {
    expect(updateBaseline({ baseline: null, reports: [report({}, '10.1.0')] }).baseline.stryker).toBe('10.1.0');
    expect(updateBaseline({ baseline: baseline({}), reports: [report({}, '10.1.0')] }).baseline.stryker).toBe('10.0.0');
  });
});

describe('the summary', () => {
  const clean = { failures: [], raisable: [], reruns: [], checked: 3 };

  it('says pass and how many files, for the whole scope', () => {
    expect(renderCheck(clean, null, { expected: null, labeled: false })).toContain('Pass. 3 file(s) checked');
  });

  it('says a run that mutated nothing is not a pass', () => {
    const text = renderCheck({ ...clean, checked: 0 }, null, { expected: [], labeled: false });
    expect(text).toContain('not a pass');
    expect(text).not.toContain('Pass.');
  });

  it('lists each failure, from the check and from the base comparison', () => {
    const text = renderCheck(
      { ...clean, failures: [{ kind: 'below-baseline', file: 'src/a.ts', message: 'src/a.ts too low' }] },
      { failures: [{ kind: 'scope-changed', file: null, message: 'the globs changed' }], changes: ['the globs changed'] },
      { expected: null, labeled: false },
    );
    expect(text).toContain('Fail: 2 problem(s)');
    expect(text).toContain('- src/a.ts too low');
    expect(text).toContain('- the globs changed');
  });

  it('says how often the re-run changed the result, and that the baseline can be raised', () => {
    const text = renderCheck(
      {
        ...clean,
        reruns: [
          { file: 'src/a.ts', first: 89, second: 90, baseline: 90, cleared: true },
          { file: 'src/b.ts', first: 70, second: 70, baseline: 80, cleared: false },
        ],
        raisable: [{ file: 'src/c.ts', score: 95, baseline: 90 }],
      },
      null,
      { expected: null, labeled: false },
    );
    expect(text).toContain('Re-runs from a fresh sandbox: 2, which changed the result for 1');
    expect(text).toContain('`src/c.ts`: 95.0%, baseline 90.0%');
  });

  it('says a label excused a change and that it still needs the maintainer', () => {
    const text = renderCheck(clean, { failures: [], changes: ['the globs changed'] }, { expected: null, labeled: true });
    expect(text).toContain("maintainer's OK");
    expect(text).toContain('the globs changed');
  });
});

describe('the re-run budget', () => {
  // Three files below their baseline, of 100, 200 and 300 mutants, each about a point under 90.
  const spec = (n: number): Spec => ({ killed: Math.floor(n * 0.89), survived: n - Math.floor(n * 0.89) });
  const below = report({ 'src/big.ts': spec(300), 'src/small.ts': spec(100), 'src/mid.ts': spec(200) });
  const entries = baseline({ 'src/big.ts': [90, 0], 'src/small.ts': [90, 0], 'src/mid.ts': [90, 0] });
  const clear = () => fileStats(mutants({ killed: 95, survived: 5 }));

  it('prints every failure before the first re-run starts, and lists a waiting file as below its baseline', () => {
    const order: string[] = [];
    const result = check({
      report: report({ 'src/a.ts': { killed: 90, survived: 10, disabled: [undefined] }, 'src/small.ts': spec(100) }),
      baseline: baseline({ 'src/a.ts': [90, 5], 'src/small.ts': [90, 0] }),
      expected: null,
      exists: present,
      beforeRerun: failures => order.push(`before:${failures.map(f => `${f.kind}:${f.file}`).join(',')}`),
      rerun: file => {
        order.push(`rerun:${file}`);
        return clear();
      },
    });
    expect(order).toEqual(['before:bare-disable:src/a.ts,below-baseline:src/small.ts', 'rerun:src/small.ts']);
    expect(result.failures.map(f => f.kind)).toEqual(['bare-disable']);
  });

  it('does not call beforeRerun when no file is below its baseline', () => {
    const before = vi.fn();
    check({
      report: report({ 'src/a.ts': { killed: 95, survived: 5 } }),
      baseline: baseline({ 'src/a.ts': [90, 0] }),
      expected: null,
      exists: present,
      beforeRerun: before,
      rerun: clear,
    });
    expect(before).not.toHaveBeenCalled();
  });

  it('re-runs the smallest files first', () => {
    const order: string[] = [];
    check({ report: below, baseline: entries, expected: null, exists: present, rerun: file => (order.push(file), clear()) });
    expect(order).toEqual(['src/small.ts', 'src/mid.ts', 'src/big.ts']);
  });

  it('stops at the cap, and a file it did not re-run fails and says so', () => {
    const rerun = vi.fn(clear);
    const result = check({ report: below, baseline: entries, expected: null, exists: present, rerun, rerunBudget: { maxReruns: 2, budgetMs: 1e9 } });
    expect(rerun).toHaveBeenCalledTimes(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ kind: 'below-baseline', file: 'src/big.ts' });
    expect(result.failures[0].message).toContain('not re-run (at most 2 files are re-run)');
    expect(result.failures[0].message).toContain('counts as below');
    expect(result.reruns.find(r => r.file === 'src/big.ts')).toMatchObject({ skipped: 'at most 2 files are re-run', cleared: false, second: null });
  });

  it('stops when the time budget is spent, and gives each re-run what is left as its timeout', () => {
    let clock = 0;
    const timeouts: number[] = [];
    const result = check({
      report: below,
      baseline: entries,
      expected: null,
      exists: present,
      rerunBudget: { maxReruns: 10, budgetMs: 100_000, now: () => clock },
      rerun: (_file, timeoutMs) => {
        timeouts.push(timeoutMs);
        clock += 60_000; // each re-run takes a minute
        return clear();
      },
    });
    expect(timeouts).toEqual([100_000, 40_000]);
    expect(result.failures.map(f => f.file)).toEqual(['src/big.ts']);
    expect(result.failures[0].message).toContain('the re-run time budget is spent');
  });

  it('fails a re-run that ran out of time with its own message', () => {
    const result = check({ report: below, baseline: entries, expected: null, exists: present, rerun: () => null, rerunBudget: { maxReruns: 1, budgetMs: 1e9 } });
    expect(result.failures.find(f => f.file === 'src/small.ts')?.message).toContain('the re-run did not produce a score (it failed or ran out of time)');
  });

  it('says in the summary which files were not re-run', () => {
    const result = check({ report: below, baseline: entries, expected: null, exists: present, rerun: clear, rerunBudget: { maxReruns: 2, budgetMs: 1e9 } });
    const text = renderCheck(result, null, { expected: null, labeled: false });
    expect(text).toContain('Re-runs from a fresh sandbox: 2, which changed the result for 2. 1 file(s) were not re-run');
    expect(text).toContain('not run (at most 2 files are re-run)');
  });
});

describe('a new baseline entry under the floor', () => {
  const scope = (files: Record<string, [number, number]> | null): MeasuredScope => ({
    baseline: files === null ? null : baseline(files),
    mutate: ['src/**/*.ts'],
    exclude: ['src/x.test.ts'],
  });
  const compare = (head: Record<string, [number, number]> | null, labeled = false, base: Record<string, [number, number]> | null = { 'src/a.ts': [90, 0] }) =>
    compareToBase({ base: scope(base), head: scope(head), exists: present, labeled });

  it('fails without the label, and says why', () => {
    const result = compare({ 'src/a.ts': [90, 0], 'src/new.ts': [30, 0] });
    expect(result.failures.map(f => [f.kind, f.file])).toEqual([['new-entry-under-floor', 'src/new.ts']]);
    expect(result.failures[0].message).toContain('src/new.ts is a new baseline entry at 30.0%, under the 80% floor for a new file');
    expect(result.failures[0].message).toContain(BASELINE_LABEL);
  });

  it('passes with the label, and still lists it for the maintainer', () => {
    const result = compare({ 'src/a.ts': [90, 0], 'src/new.ts': [30, 0] }, true);
    expect(result.failures).toEqual([]);
    expect(result.changes).toEqual(['src/new.ts is a new baseline entry at 30.0%, under the 80% floor for a new file']);
  });

  it('passes a new entry at or over the floor', () => {
    expect(compare({ 'src/a.ts': [90, 0], 'src/at.ts': [NEW_FILE_FLOOR, 0], 'src/over.ts': [99.9, 0] }).failures).toEqual([]);
    expect(compare({ 'src/a.ts': [90, 0], 'src/under.ts': [NEW_FILE_FLOOR - 0.1, 0] }).failures).toHaveLength(1);
  });

  it('does not flag the first baseline (the base has none), which may record files under the floor', () => {
    expect(compare({ 'src/a.ts': [90, 0], 'src/weak.ts': [30, 0] }, false, null).failures).toEqual([]);
  });

  it('does not flag an existing entry that is under the floor and unchanged', () => {
    expect(compare({ 'src/weak.ts': [30, 0] }, false, { 'src/weak.ts': [30, 0] }).failures).toEqual([]);
  });

  it('catches code moved into a new file under the floor, while the old entry going is allowed', () => {
    const result = compareToBase({ base: scope({ 'src/old.ts': [90, 0] }), head: scope({ 'src/moved.ts': [40, 0] }), exists: p => p !== 'src/old.ts', labeled: false });
    expect(result.failures.map(f => [f.kind, f.file])).toEqual([['new-entry-under-floor', 'src/moved.ts']]);
  });
});

describe('PR labels', () => {
  it('reads a JSON array and a comma list', () => {
    expect(parseLabels('["task","mutation-baseline-change"]')).toEqual(['task', 'mutation-baseline-change']);
    expect(parseLabels('task, mutation-baseline-change')).toEqual(['task', 'mutation-baseline-change']);
    expect(parseLabels('[]')).toEqual([]);
    expect(parseLabels(undefined)).toEqual([]);
    expect(parseLabels('')).toEqual([]);
  });

  it('counts the label only when a whole name matches', () => {
    expect(hasBaselineLabel(parseLabels('["mutation-baseline-change"]'))).toBe(true);
    expect(hasBaselineLabel(parseLabels('["mutation-baseline-change-2"]'))).toBe(false);
    expect(hasBaselineLabel(parseLabels('["not-mutation-baseline-change"]'))).toBe(false);
    expect(hasBaselineLabel(parseLabels('["Mutation-Baseline-Change"]'))).toBe(false);
    expect(hasBaselineLabel(parseLabels('mutation-baseline-change-2'))).toBe(false);
  });

  it('keeps a label name with a comma in it as one name, in the JSON form', () => {
    const labels = parseLabels('["x,mutation-baseline-change"]');
    expect(labels).toEqual(['x,mutation-baseline-change']);
    expect(hasBaselineLabel(labels)).toBe(false);
  });

  it('treats the "null" a push event gives as no label, and rejects malformed JSON', () => {
    expect(hasBaselineLabel(parseLabels('null'))).toBe(false);
    expect(() => parseLabels('["a"')).toThrow('not a valid JSON array');
  });
});

describe('--update arguments', () => {
  const files: Record<string, string> = { 'a.json': '{"run":1}', 'b.json': '{"run":2}', 'copy-of-a.json': '{"run":1}' };
  const io = { resolvePath: (p: string) => `/work/${p.replace(/^\.\//, '')}`, read: (p: string) => files[p.replace(/^\.\//, '')] ?? '' };
  const full = baseline({ 'src/a.ts': [90, 0] });
  const run = (over: Partial<Parameters<typeof checkUpdateArgs>[0]>) => () =>
    checkUpdateArgs({ reportPaths: ['a.json', 'b.json'], weekly: false, init: false, baseline: full, ...over }, io);

  it('accepts the lower of two runs, and one report that is the weekly run', () => {
    expect(run({})).not.toThrow();
    expect(run({ reportPaths: ['a.json'], weekly: true })).not.toThrow();
  });

  it('refuses a single report without --weekly, and no report at all', () => {
    expect(run({ reportPaths: ['a.json'] })).toThrow('never a single local run');
    expect(run({ reportPaths: [] })).toThrow('needs --report');
  });

  it('refuses --weekly with more than one report', () => {
    expect(run({ weekly: true })).toThrow('single --report');
  });

  it('refuses the same report twice, by path, however it is spelled', () => {
    expect(run({ reportPaths: ['a.json', 'a.json'] })).toThrow('same report twice');
    expect(run({ reportPaths: ['a.json', './a.json'] })).toThrow('same report twice');
    expect(run({ reportPaths: ['a.json', 'a.json'], weekly: true })).toThrow('same report twice');
  });

  it('refuses two copies of one run, by content', () => {
    expect(run({ reportPaths: ['a.json', 'copy-of-a.json'] })).toThrow('same content');
  });

  it('allows --init for the first baseline, and refuses it when the baseline has entries', () => {
    expect(run({ init: true, baseline: null })).not.toThrow();
    expect(run({ init: true, baseline: baseline({}) })).not.toThrow();
    expect(run({ init: true })).toThrow('first baseline only');
  });
});

// #223, from the #217 review: the re-run's timeout has to stop Stryker and its workers, not only `npx`.
describe('runInProcessGroup', () => {
  type Spawned = ReturnType<ProcessGroupIo['spawnSync']>;
  function fakeIo(result: Spawned, killError?: Error) {
    const spawnSync = vi.fn<ProcessGroupIo['spawnSync']>(() => result);
    const kill = vi.fn<ProcessGroupIo['kill']>(() => {
      if (killError) throw killError;
    });
    return { io: { spawnSync, kill } satisfies ProcessGroupIo, spawnSync, kill };
  }

  it('spawns the command detached, so it leads its own process group, with the timeout and a SIGKILL', () => {
    const { io, spawnSync } = fakeIo({ pid: 4242, status: 0 });
    runInProcessGroup('npx', ['stryker', 'run', 'cfg.json'], 90_000, io);
    expect(spawnSync).toHaveBeenCalledWith('npx', ['stryker', 'run', 'cfg.json'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
      timeout: 90_000,
      killSignal: 'SIGKILL',
    });
  });

  it('kills the whole process group, by negative pid, when the run times out', () => {
    const timedOut = Object.assign(new Error('spawnSync npx ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const { io, kill } = fakeIo({ pid: 4242, status: null, error: timedOut });
    expect(runInProcessGroup('npx', [], 1000, io)).toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('kills the group when the command exits non-zero, since its children may outlive it', () => {
    const { io, kill } = fakeIo({ pid: 4242, status: 1 });
    expect(runInProcessGroup('npx', [], 1000, io)).toBe(false);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('kills the group when the command was killed by a signal (no status)', () => {
    const { io, kill } = fakeIo({ pid: 4242, status: null });
    expect(runInProcessGroup('npx', [], 1000, io)).toBe(false);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('leaves a clean run alone and reports success', () => {
    const { io, kill } = fakeIo({ pid: 4242, status: 0 });
    expect(runInProcessGroup('npx', [], 1000, io)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it('signals nothing when the command never started (no pid)', () => {
    const { io, kill } = fakeIo({ status: null, error: new Error('spawnSync npx ENOENT') });
    expect(runInProcessGroup('npx', [], 1000, io)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('is not undone by a group that is already gone', () => {
    const gone = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    const { io } = fakeIo({ pid: 4242, status: 1 }, gone);
    expect(runInProcessGroup('npx', [], 1000, io)).toBe(false);
  });
});

// #223, #239: a PR with files over the mutant budget goes green, so the unchecked files have to show outside the job summary too.
describe('leftToWeeklyNotice', () => {
  const sha = 'a'.repeat(40);
  const clean: CheckResult = { failures: [], raisable: [], reruns: [], checked: 0 };

  it('is null when nothing was left to the weekly run', () => {
    expect(leftToWeeklyNotice([], sha)).toBeNull();
    expect(renderCheck(clean, null, { expected: [], labeled: false, leftToWeekly: [] })).not.toContain('weekly');
  });

  it('makes a warning annotation naming the count, the weekly workflow and the head commit', () => {
    const notice = leftToWeeklyNotice(['src/a.ts', 'src/b.ts', 'src/c.ts'], sha);
    expect(notice?.annotation).toBe(`::warning title=Mutation testing::3 file(s) over the mutant budget left to mutation-weekly.yml; run it on ${sha} before merging`);
    expect(notice?.annotation).not.toContain('\n');
  });

  it("says 'this PR's head commit' when the SHA is missing or is not a full hex SHA, so nothing odd reaches the annotation", () => {
    for (const bad of [undefined, '', 'abc123', 'x'.repeat(40), `${sha}\n::error::boom`]) {
      const notice = leftToWeeklyNotice(['src/a.ts'], bad);
      expect(notice?.annotation).toBe("::warning title=Mutation testing::1 file(s) over the mutant budget left to mutation-weekly.yml; run it on this PR's head commit before merging");
    }
  });

  it('names how many of the files are changed sources, test imports and baseline entries, leaving out empty groups', () => {
    const groups = { changedSources: ['src/a.ts'], fromTests: [], fromBaseline: ['src/b.ts', 'src/c.ts'] };
    const notice = leftToWeeklyNotice(['src/a.ts', 'src/b.ts', 'src/c.ts'], sha, groups);
    expect(notice?.annotation).toBe(
      `::warning title=Mutation testing::3 file(s) (1 changed source, 2 baseline) over the mutant budget left to mutation-weekly.yml; run it on ${sha} before merging`,
    );
    expect(notice?.line).toContain('3 file(s) (1 changed source, 2 baseline) were not mutated on this PR');
    const tests = leftToWeeklyNotice(['src/t.ts'], sha, { changedSources: [], fromTests: ['src/t.ts'], fromBaseline: [] });
    expect(tests?.annotation).toContain('(1 imported by changed tests)');
  });

  it("adds a line to the ratchet's own section, whether it passes or not, and names no file", () => {
    const passing = renderCheck(clean, null, { expected: [], labeled: false, leftToWeekly: ['src/a.ts', 'src/b.ts'], headSha: sha });
    expect(passing).toContain('2 file(s) were not mutated on this PR, over the mutant budget');
    expect(passing).toContain(`Run \`mutation-weekly.yml\` on ${sha} before merging`);
    expect(passing).not.toContain('src/a.ts');
    const failing = renderCheck(
      { ...clean, failures: [{ kind: 'below-baseline', file: 'src/z.ts', message: 'src/z.ts is low' }] },
      null,
      { expected: [], labeled: false, leftToWeekly: ['src/a.ts'] },
    );
    expect(failing).toContain('Fail: 1 problem(s)');
    expect(failing).toContain('1 file(s) were not mutated');
  });

  it('passes the groups of the plan through to the line', () => {
    const text = renderCheck(clean, null, {
      expected: [],
      labeled: false,
      leftToWeekly: ['src/a.ts'],
      leftGroups: { changedSources: ['src/a.ts'], fromTests: [], fromBaseline: [] },
    });
    expect(text).toContain('1 file(s) (1 changed source) were not mutated');
  });
});

// `detached` is not among Node's documented spawnSync options. It works because the option reaches libuv, and the
// fakes above can't tell if a Node major stops honouring it: `kill(-pid)` would then hit ESRCH, which is swallowed,
// and the orphaned workers would be back with every test still green. So once, for real, on POSIX (CI is ubuntu).
describe.skipIf(process.platform === 'win32')('runInProcessGroup, for real', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("kills the command's own children when it times out, not just the command", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'group-kill-'));
    const pidFile = join(dir, 'grandchild.pid');
    let grandchild = 0;
    try {
      const ok = runInProcessGroup('sh', ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`], 500);
      grandchild = Number(readFileSync(pidFile, 'utf8').trim());
      expect(ok).toBe(false);
      expect(Number.isInteger(grandchild) && grandchild > 1).toBe(true);
      // The kill is a signal, so give the OS a moment to reap the orphan.
      for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise(r => setTimeout(r, 20));
      expect(alive(grandchild)).toBe(false);
    } finally {
      if (grandchild > 1 && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
