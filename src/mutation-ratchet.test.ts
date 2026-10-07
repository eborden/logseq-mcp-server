import { describe, it, expect, vi } from 'vitest';
import {
  BASELINE_LABEL,
  NEW_FILE_FLOOR,
  STRYKER_DEFAULT_REASON,
  check,
  compareToBase,
  extractStringList,
  fileStats,
  formatBaseline,
  isBareReason,
  parseBaseline,
  renderCheck,
  scoreOf,
  updateBaseline,
  type Baseline,
  type FileStats,
  type MeasuredScope,
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
      const rerun = vi.fn((): FileStats => fileStats(mutants({ killed: 90, survived: 10 })));
      const result = check({ report: below, baseline: base, expected: null, exists: present, rerun });
      expect(result.failures).toEqual([]);
      expect(rerun).toHaveBeenCalledTimes(1);
      expect(rerun).toHaveBeenCalledWith('src/a.ts');
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
