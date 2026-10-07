import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import {
  changedBaselineFiles,
  chooseBase,
  FALLBACK_MUTANTS,
  fileScores,
  importedSources,
  inMutateScope,
  isBlindSpot,
  MUTANT_BUDGET,
  mutantCountsFromIncremental,
  plan,
  planFromRepo,
  renderSummary,
  scopeFromConfig,
  type PlanInput,
  type PlanIo,
} from '../scripts/mutation-ci.js';
import { WEEKLY_ARTIFACT_RETENTION_DAYS, weeklyArtifactName } from '../scripts/mutation-ratchet.js';

// The decisions of the CI mutation job (ADR-0026, #204): what it mutates, when it must not trust the
// cache, and how its table counts ignores. All paths and tests below are made up except the config,
// which is read from stryker.config.json so the left-out files can't drift from the real ones.

const config = JSON.parse(readFileSync(new URL('../stryker.config.json', import.meta.url), 'utf8')) as {
  mutate: string[];
};
const scope = scopeFromConfig(config);

describe('mutate scope', () => {
  it('reads the left-out files from stryker.config.json', () => {
    expect([...scope.excluded].sort()).toEqual([
      'src/index.ts',
      'src/instructions.ts',
      'src/tool-args.ts',
      'src/tool-descriptions.ts',
      'src/types.ts',
      'src/version.ts',
    ]);
  });

  it('mutates src sources, not tests, the left-out files or anything outside src', () => {
    expect(inMutateScope('src/utils/snippet.ts', scope)).toBe(true);
    expect(inMutateScope('src/tools/get-page.ts', scope)).toBe(true);
    expect(inMutateScope('src/utils/snippet.test.ts', scope)).toBe(false);
    expect(inMutateScope('src/tool-args.ts', scope)).toBe(false);
    expect(inMutateScope('scripts/mutation-ci.ts', scope)).toBe(false);
    expect(inMutateScope('src/__snapshots__/tool-list.test.ts.snap', scope)).toBe(false);
  });
});

describe('blind spots', () => {
  it.each([
    'src/tool-args.ts',
    'src/types.ts',
    'src/index.ts',
    'src/tool-descriptions.ts',
    'src/instructions.ts',
    'src/version.ts',
    'src/__snapshots__/tool-list.test.ts.snap',
    'tests/helpers/ref-graph.ts',
    'tests/fixtures/graph/pages/example.md',
    'package-lock.json',
    'vitest.config.ts',
    'vitest.mutation.config.ts',
    'stryker.config.json',
  ])('%s is a blind spot', path => {
    expect(isBlindSpot(path, scope)).toBe(true);
  });

  it.each([
    'src/utils/snippet.ts',
    'src/utils/snippet.test.ts',
    'tests/integration/server.test.ts',
    'README.md',
    'docs/adr/0001-example.md',
    'scripts/mutation-ci.ts',
  ])('%s is not', path => {
    expect(isBlindSpot(path, scope)).toBe(false);
  });
});

describe('importedSources', () => {
  const files = new Set(['src/utils/snippet.ts', 'src/tools/get-page.ts', 'src/tool-args.ts', 'src/utils/block-tree.ts']);
  const exists = (p: string) => files.has(p);

  it('finds the mutated files a test imports, however it spells the import', () => {
    const source = [
      "import { a } from './snippet.js';",
      "import { b } from '../tools/get-page.js';",
      "import type { c } from '../tool-args.js';",
      "const d = await import('./block-tree.js');",
      "import { e } from 'vitest';",
      "import { f } from './missing.js';",
    ].join('\n');
    expect(importedSources('src/utils/x.test.ts', source, scope, exists)).toEqual([
      'src/tools/get-page.ts',
      'src/utils/block-tree.ts',
      'src/utils/snippet.ts',
    ]);
  });
});

describe('changedBaselineFiles', () => {
  it('names the source files whose entry changed, was added or was dropped', () => {
    const before = { files: { 'src/a.ts': { score: 90 }, 'src/b.ts': { score: 80 }, 'src/c.ts': { score: 70 } } };
    const after = { files: { 'src/a.ts': { score: 91 }, 'src/b.ts': { score: 80 }, 'src/d.ts': { score: 60 } } };
    expect(changedBaselineFiles(before, after)).toEqual(['src/a.ts', 'src/c.ts', 'src/d.ts']);
  });

  it('reads a flat file too, and treats a missing file as empty', () => {
    expect(changedBaselineFiles(null, { 'src/a.ts': { score: 1 }, version: '10.0.0' })).toEqual(['src/a.ts']);
    expect(changedBaselineFiles(null, null)).toEqual([]);
  });
});

describe('plan', () => {
  const base: PlanInput = {
    cacheUsable: true,
    changed: [],
    deleted: [],
    scope,
    readTest: () => null,
    exists: () => true,
    baselineChanged: [],
  };

  it('trusts the cache and runs the whole scope when nothing a result can hide behind changed', () => {
    const result = plan({ ...base, changed: ['src/utils/snippet.ts', 'src/utils/snippet.test.ts', 'README.md'] });
    expect(result).toMatchObject({ mode: 'incremental', mutate: [], reasons: [] });
  });

  it.each(['src/tool-args.ts', 'package-lock.json', 'tests/fixtures/graph/pages/x.md', 'vitest.mutation.config.ts'])(
    'takes the cache-miss path when %s changed, and mutates only the changed sources',
    blind => {
      const result = plan({ ...base, changed: [blind, 'src/utils/snippet.ts', 'docs/x.md'] });
      expect(result.mode).toBe('targeted');
      expect(result.mutate).toEqual(['src/utils/snippet.ts']);
      expect(result.reasons.join(' ')).toContain(blind);
    },
  );

  it('takes the cache-miss path with no usable cache', () => {
    const result = plan({ ...base, cacheUsable: false, changed: ['src/utils/snippet.ts'] });
    expect(result).toMatchObject({ mode: 'targeted', mutate: ['src/utils/snippet.ts'], reasons: ['no usable incremental cache'] });
  });

  it('adds the mutated files a changed test imports, and the files whose baseline entry changed', () => {
    const result = plan({
      ...base,
      cacheUsable: false,
      changed: ['src/utils/snippet.test.ts', 'src/utils/snippet.ts'],
      baselineChanged: ['src/tools/get-page.ts', 'src/tool-args.ts'],
      readTest: () => "import { x } from './snippet.js';\nimport { y } from './compact.js';",
      mutantCounts: () => ({ 'src/utils/snippet.ts': 100, 'src/utils/compact.ts': 100, 'src/tools/get-page.ts': 100 }),
    });
    expect(result.mutate).toEqual(['src/tools/get-page.ts', 'src/utils/compact.ts', 'src/utils/snippet.ts']);
    expect(result).toMatchObject({
      changedSources: ['src/utils/snippet.ts'],
      fromBaseline: ['src/tools/get-page.ts'],
      fromTests: ['src/utils/compact.ts'],
    });
  });

  it('gives a test-only change a non-empty set from the tests it changed', () => {
    const result = plan({
      ...base,
      changed: ['src/utils/snippet.test.ts', 'tests/helpers/ref-graph.ts'],
      readTest: () => "import { x } from './snippet.js';",
    });
    expect(result).toMatchObject({ mode: 'targeted', mutate: ['src/utils/snippet.ts'] });
  });

  it('reads a deleted test from the old commit and skips a deleted source', () => {
    const result = plan({
      ...base,
      cacheUsable: false,
      changed: ['src/utils/snippet.test.ts', 'src/utils/gone.ts'],
      deleted: ['src/utils/snippet.test.ts', 'src/utils/gone.ts'],
      readTest: () => "import { x } from './snippet.js';",
      exists: p => p === 'src/utils/snippet.ts',
    });
    expect(result.mutate).toEqual(['src/utils/snippet.ts']);
  });

  it('is empty, not a pass, when nothing maps to a mutated file', () => {
    const result = plan({ ...base, cacheUsable: false, changed: ['README.md', 'vitest.mutation.config.ts'] });
    expect(result).toMatchObject({ mode: 'empty', mutate: [] });
    expect(renderSummary(result, null)).toContain('not a pass');
  });

  describe('the mutant budget on the cache-miss set (ADR-0028, #239)', () => {
    /** `n` made-up source files, m00.ts, m01.ts, ... in path order. */
    const names = (n: number, prefix = 'm') => Array.from({ length: n }, (_, i) => `src/${prefix}${String(i).padStart(2, '0')}.ts`);
    /** Counts for the given files, each `size` mutants. */
    const sized = (files: string[], size: number) => Object.fromEntries(files.map(f => [f, size]));
    const miss = { ...base, cacheUsable: false };

    it('is #231\'s three largest files, and the spare time the old cap of 3 left, worked out from the measurements', () => {
      expect(MUTANT_BUDGET).toBe(1280);
      expect(510 + 420 + 350).toBe(MUTANT_BUDGET);
      // (timeout - overhead - spare) x 60 s / slowest seconds per mutant, rounded down to ten.
      const minutes = 10 - (0.3 + 0.5) - 3.0;
      expect(Math.floor((minutes * 60) / 0.29 / 10) * 10).toBe(MUTANT_BUDGET);
      // Run time at the budget, plus overhead, stays 3 minutes short of the timeout.
      expect((MUTANT_BUDGET * 0.29) / 60 + 0.8).toBeCloseTo(7.0, 1);
    });

    it('sizes an unknown file at the largest measured file, so two fit and a third does not', () => {
      expect(FALLBACK_MUTANTS).toBe(510);
      expect(FALLBACK_MUTANTS * 2).toBeLessThanOrEqual(MUTANT_BUDGET);
      expect(FALLBACK_MUTANTS * 3).toBeGreaterThan(MUTANT_BUDGET);
    });

    it('behaves as before when everything fits: every file, from all three groups, is mutated', () => {
      const result = plan({
        ...miss,
        changed: ['src/utils/snippet.ts', 'src/utils/snippet.test.ts'],
        baselineChanged: ['src/tools/get-page.ts'],
        readTest: () => "import { y } from './compact.js';",
        mutantCounts: () => ({ 'src/utils/snippet.ts': 100, 'src/utils/compact.ts': 100, 'src/tools/get-page.ts': 100 }),
      });
      expect(result).toMatchObject({
        mode: 'targeted',
        mutate: ['src/tools/get-page.ts', 'src/utils/compact.ts', 'src/utils/snippet.ts'],
        changedSources: ['src/utils/snippet.ts'],
        fromTests: ['src/utils/compact.ts'],
        fromBaseline: ['src/tools/get-page.ts'],
        baselineChanged: 1,
        leftToWeekly: [],
        leftToWeeklyByGroup: { changedSources: [], fromTests: [], fromBaseline: [] },
        estimatedMutants: 300,
        estimatedByFallback: [],
      });
    });

    it('mutates files that add up to exactly the budget, and leaves the next one out', () => {
      const [a, b, c] = names(3);
      const exact = plan({ ...miss, baselineChanged: [a, b], mutantCounts: () => ({ [a]: 1000, [b]: MUTANT_BUDGET - 1000 }) });
      expect(exact).toMatchObject({ mode: 'targeted', mutate: [a, b], estimatedMutants: MUTANT_BUDGET, leftToWeekly: [] });
      const over = plan({ ...miss, baselineChanged: [a, b, c], mutantCounts: () => ({ [a]: 1000, [b]: MUTANT_BUDGET - 1000, [c]: 1 }) });
      expect(over).toMatchObject({ mutate: [a, b], estimatedMutants: MUTANT_BUDGET, leftToWeekly: [c] });
      const oneOver = plan({ ...miss, baselineChanged: [a, b], mutantCounts: () => ({ [a]: 1000, [b]: MUTANT_BUDGET - 999 }) });
      expect(oneOver).toMatchObject({ mutate: [a], estimatedMutants: 1000, leftToWeekly: [b] });
    });

    it('fills the budget in priority order: changed sources, then test imports, then baseline entries', () => {
      // Path order is the reverse of priority order here, so a path sort alone would get this wrong.
      const result = plan({
        ...miss,
        changed: ['src/z-changed.ts', 'src/y-test.test.ts'],
        baselineChanged: ['src/a-baseline.ts'],
        readTest: () => "import { x } from './m-imported.js';",
        mutantCounts: () => ({ 'src/z-changed.ts': 600, 'src/m-imported.ts': 600, 'src/a-baseline.ts': 600 }),
      });
      expect(result.mutate).toEqual(['src/m-imported.ts', 'src/z-changed.ts']);
      expect(result).toMatchObject({
        changedSources: ['src/z-changed.ts'],
        fromTests: ['src/m-imported.ts'],
        fromBaseline: [],
        leftToWeekly: ['src/a-baseline.ts'],
        leftToWeeklyByGroup: { changedSources: [], fromTests: [], fromBaseline: ['src/a-baseline.ts'] },
        estimatedMutants: 1200,
      });
    });

    it('takes changed sources in path order inside a group, and lists the ones that miss out by group', () => {
      const files = names(5);
      const result = plan({
        ...miss,
        changed: [...files].reverse(),
        baselineChanged: ['src/x-baseline.ts'],
        mutantCounts: () => ({ ...sized(files, 400), 'src/x-baseline.ts': 10 }),
      });
      // 3 x 400 = 1,200 fits, the fourth would make 1,600. The 10-mutant baseline entry still fits after them.
      expect(result.mutate).toEqual([...files.slice(0, 3), 'src/x-baseline.ts']);
      expect(result.estimatedMutants).toBe(1210);
      expect(result.leftToWeekly).toEqual([files[3], files[4]]);
      expect(result.leftToWeeklyByGroup).toEqual({ changedSources: [files[3], files[4]], fromTests: [], fromBaseline: [] });
    });

    it('skips a file that does not fit and still takes a smaller one after it (first-fit)', () => {
      const [a, b, c] = names(3);
      const result = plan({ ...miss, changed: [a, b, c], mutantCounts: () => ({ [a]: 1000, [b]: 500, [c]: 5 }) });
      expect(result.mutate).toEqual([a, c]);
      expect(result.estimatedMutants).toBe(1005);
      expect(result.leftToWeekly).toEqual([b]);
    });

    it('keeps the higher group first: a skipped changed source does not stop the test imports and baseline entries after it', () => {
      const result = plan({
        ...miss,
        changed: ['src/c-big.ts', 'src/c-small.ts', 'src/t.test.ts'],
        readTest: () => "import { x } from './imported.js';",
        baselineChanged: ['src/baseline.ts', 'src/baseline-big.ts'],
        mutantCounts: () => ({ 'src/c-big.ts': 1200, 'src/c-small.ts': 100, 'src/imported.ts': 200, 'src/baseline.ts': 50, 'src/baseline-big.ts': 400 }),
      });
      // After c-big (1,200) neither c-small (100) nor imported (200) nor baseline-big (400) fits, and baseline (50) does.
      expect(result.mutate).toEqual(['src/baseline.ts', 'src/c-big.ts']);
      expect(result.estimatedMutants).toBe(1250);
      expect(result.leftToWeekly).toEqual(['src/c-small.ts', 'src/imported.ts', 'src/baseline-big.ts']);
    });

    it('counts a file once, in its highest group', () => {
      const result = plan({
        ...miss,
        changed: ['src/m00.ts', 'src/m00.test.ts'],
        baselineChanged: ['src/m00.ts', 'src/m01.ts'],
        readTest: () => "import { x } from './m00.js';\nimport { y } from './m01.js';",
        mutantCounts: () => ({ 'src/m00.ts': 700, 'src/m01.ts': 700 }),
      });
      expect(result).toMatchObject({
        mutate: ['src/m00.ts'],
        changedSources: ['src/m00.ts'],
        fromTests: [],
        fromBaseline: [],
        baselineChanged: 2,
        estimatedMutants: 700,
        leftToWeekly: ['src/m01.ts'],
        leftToWeeklyByGroup: { changedSources: [], fromTests: ['src/m01.ts'], fromBaseline: [] },
      });
    });

    it('leaves a changed source to the weekly run when the files before it use the budget up', () => {
      const [big, small] = names(2);
      const result = plan({ ...miss, changed: [big, small], mutantCounts: () => ({ [big]: 1200, [small]: 100 }) });
      expect(result.leftToWeeklyByGroup.changedSources).toEqual([small]);
      expect(result.changedSources).toEqual([big]);
    });

    it('is empty, and says so, when no file due for mutation fits the budget', () => {
      const result = plan({ ...miss, changed: ['src/m00.ts'], mutantCounts: () => ({ 'src/m00.ts': MUTANT_BUDGET + 1 }) });
      expect(result).toMatchObject({ mode: 'empty', mutate: [], estimatedMutants: 0, leftToWeekly: ['src/m00.ts'] });
      const text = renderSummary(result, null);
      expect(text).toContain('Nothing was checked, and this is not a pass.');
      expect(text).toContain('no file due for mutation fits the mutant budget');
      expect(text).not.toContain('none changed in the baseline');
    });

    describe('when a file has no count', () => {
      it('sizes it at the fallback: two unknown files fit and the third goes to the weekly run', () => {
        const files = names(3);
        const result = plan({ ...miss, changed: files, mutantCounts: () => ({}) });
        expect(result.mutate).toEqual(files.slice(0, 2));
        expect(result).toMatchObject({ estimatedMutants: 2 * FALLBACK_MUTANTS, leftToWeekly: [files[2]], estimatedByFallback: files });
      });

      it('does the same with no counts at all (no cache restored)', () => {
        const files = names(3);
        const result = plan({ ...miss, changed: files });
        expect(result.mutate).toEqual(files.slice(0, 2));
        expect(result.estimatedByFallback).toEqual(files);
      });

      it('uses the count for a known file and the fallback for a new one, side by side', () => {
        const [known, added] = names(2);
        const result = plan({ ...miss, changed: [known, added], mutantCounts: () => ({ [known]: 300 }) });
        expect(result).toMatchObject({ mutate: [known, added], estimatedMutants: 300 + FALLBACK_MUTANTS, estimatedByFallback: [added] });
      });

      it('treats a count of 0 as a count, not as unknown', () => {
        const [empty] = names(1);
        const result = plan({ ...miss, changed: [empty], mutantCounts: () => ({ [empty]: 0 }) });
        expect(result).toMatchObject({ estimatedMutants: 0, estimatedByFallback: [] });
      });

      it('names the files sized by the fallback in the summary', () => {
        const [known, added] = names(2);
        const text = renderSummary(plan({ ...miss, changed: [known, added], mutantCounts: () => ({ [known]: 300 }) }), null);
        expect(text).toContain(`1 file(s) had no mutant count in the cached results (new, or no cache) and were each sized at ${FALLBACK_MUTANTS} mutants: \`${added}\``);
      });
    });

    it('reads the counts only on the cache-miss path', () => {
      let reads = 0;
      const counts = () => {
        reads += 1;
        return {};
      };
      expect(plan({ ...base, changed: ['src/utils/snippet.ts'], baselineChanged: names(20), mutantCounts: counts })).toMatchObject({ mode: 'incremental', leftToWeekly: [] });
      expect(plan({ ...miss, changed: [], mutantCounts: counts }).mode).toBe('empty');
      expect(reads).toBe(0);
      plan({ ...miss, changed: ['src/utils/snippet.ts'], mutantCounts: counts });
      expect(reads).toBe(1);
    });

    it('counts only entries that exist and are mutated, and each once', () => {
      const [a] = names(1);
      const result = plan({
        ...miss,
        baselineChanged: [a, a, 'src/tool-args.ts', 'src/gone.ts'],
        exists: p => p !== 'src/gone.ts',
        mutantCounts: () => ({ [a]: 10 }),
      });
      expect(result).toMatchObject({ mode: 'targeted', mutate: [a], baselineChanged: 1, leftToWeekly: [] });
    });

    it('says in the summary the estimate, the budget, and which files were left out, by group', () => {
      const files = names(4);
      const result = plan({
        ...miss,
        changed: [files[0], files[1], files[2], 'src/m09.test.ts'],
        readTest: () => "import { x } from './m03.js';",
        baselineChanged: ['src/b00.ts'],
        mutantCounts: () => ({ ...sized(files, 500), 'src/b00.ts': 500 }),
      });
      const text = renderSummary(result, null);
      expect(text).toContain(`Mutated 2 file(s), an estimated 1000 of ${MUTANT_BUDGET} mutants: 2 changed, 0 from baseline changes, 0 imported by changed tests.`);
      expect(text).toContain(`these 3 file(s) would add pass the budget of ${MUTANT_BUDGET} (estimated 1000 used), so this run did not mutate them`);
      expect(text).toContain('changed sources first, then the files the changed tests import, then the changed baseline entries');
      expect(text).toContain('weekly full run (`mutation-weekly.yml`)');
      expect(text).toContain('head commit');
      expect(text).toContain('unchecked until then');
      expect(text).toContain('Changed sources (1):\n\n- `src/m02.ts`');
      expect(text).toContain('Imported by changed tests (1):\n\n- `src/m03.ts`');
      expect(text).toContain('Changed baseline entries (1):\n\n- `src/b00.ts`');
    });

    it('leaves out a group heading with no files, and says nothing about the budget when everything fit', () => {
      const [a, b] = names(2);
      const left = renderSummary(plan({ ...miss, changed: [a, b], mutantCounts: () => ({ [a]: 1000, [b]: 1000 }) }), null);
      expect(left).toContain('Changed sources (1):');
      expect(left).not.toContain('Imported by changed tests (');
      expect(left).not.toContain('Changed baseline entries (');
      const fit = renderSummary(plan({ ...miss, changed: [a, b], mutantCounts: () => ({ [a]: 10, [b]: 10 }) }), null);
      expect(fit).not.toContain('did not mutate them');
      expect(fit).not.toContain('weekly');
    });
  });

  describe('mutantCountsFromIncremental', () => {
    // The shape Stryker writes to stryker-incremental.json: the mutation-testing report (schema 2) with the
    // file sources and mutants, plus `testFiles`. Made-up paths and sources.
    const mutant = (id: string, status: string) => ({
      id,
      mutatorName: 'ConditionalExpression',
      replacement: 'true',
      status,
      location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } },
      coveredBy: ['0'],
      killedBy: status === 'Killed' ? ['0'] : undefined,
      testsCompleted: 1,
    });
    const incremental = {
      schemaVersion: '2',
      thresholds: { high: 80, low: 60 },
      files: {
        'src/a.ts': { language: 'typescript', source: 'export const a = 1;', mutants: [mutant('0', 'Killed'), mutant('1', 'Survived'), mutant('2', 'Ignored')] },
        'src/b.ts': { language: 'typescript', source: 'export const b = 2;', mutants: [] },
      },
      testFiles: { 'src/a.test.ts': { source: '', tests: [{ id: '0', name: 'a works' }] } },
    };

    it('counts every mutant of each file, Ignored ones included, and a file with none as 0', () => {
      expect(mutantCountsFromIncremental(incremental)).toEqual({ 'src/a.ts': 3, 'src/b.ts': 0 });
    });

    it.each([null, undefined, 'text', 7, [], {}, { files: null }, { files: 'x' }, { files: { 'src/a.ts': null } }, { files: { 'src/a.ts': { mutants: 'x' } } }])(
      'gives no counts for a file of another shape (%j)',
      doc => {
        expect(mutantCountsFromIncremental(doc)).toEqual({});
      },
    );

    it('skips the entry that is malformed and keeps the rest', () => {
      const doc = { files: { 'src/a.ts': { mutants: [{}, {}] }, 'src/b.ts': { mutants: 'x' }, 'src/c.ts': 5 } };
      expect(mutantCountsFromIncremental(doc)).toEqual({ 'src/a.ts': 2 });
    });

    it('feeds the plan: a known file takes its count, a file the cache lacks takes the fallback', () => {
      const result = plan({ ...base, cacheUsable: false, changed: ['src/a.ts', 'src/new.ts'], mutantCounts: () => mutantCountsFromIncremental(incremental) });
      expect(result).toMatchObject({ estimatedMutants: 3 + FALLBACK_MUTANTS, estimatedByFallback: ['src/new.ts'] });
    });
  });
});

describe('fileScores', () => {
  const ignored = (isStatic: boolean) => ({ status: 'Ignored', static: isStatic });
  const report = {
    files: {
      'src/b.ts': { mutants: [{ status: 'Killed' }, { status: 'Timeout' }, { status: 'Survived' }, { status: 'NoCoverage' }] },
      'src/a.ts': {
        mutants: [{ status: 'Killed' }, { status: 'Killed' }, { status: 'CompileError' }, ignored(true), ignored(true), ignored(false)],
      },
      'src/c.ts': { mutants: [ignored(true)] },
    },
  };

  it('counts the total score the way ADR-0026 defines it, and ignores only by disable comments', () => {
    expect(fileScores(report)).toEqual([
      { file: 'src/a.ts', killed: 2, timeout: 0, survived: 0, noCoverage: 0, ignores: 1, score: 100 },
      { file: 'src/b.ts', killed: 1, timeout: 1, survived: 1, noCoverage: 1, ignores: 0, score: 50 },
      { file: 'src/c.ts', killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignores: 0, score: null },
    ]);
  });

  it('floors the score to one decimal', () => {
    const mutants = [...Array(2).fill({ status: 'Killed' }), { status: 'Survived' }];
    expect(fileScores({ files: { 'src/x.ts': { mutants } } })[0].score).toBe(66.6);
  });

  it('renders one row per file with its ignores', () => {
    const table = renderSummary(null, fileScores(report));
    expect(table).toContain('| `src/a.ts` | 100.0% | 2 | 0 | 0 | 0 | 1 |');
    expect(table).toContain('| `src/c.ts` | n/a |');
    expect(table).toContain('| **All files** | 66.6% | 3 | 1 | 1 | 1 | 1 |');
  });

  it('names the mutated files on the cache-miss path', () => {
    const result = plan({ cacheUsable: false, changed: ['src/utils/snippet.ts'], deleted: [], scope, readTest: () => null, exists: () => true, baselineChanged: [] });
    const text = renderSummary(result, null);
    expect(text).toContain('`src/utils/snippet.ts`');
    expect(text).toContain('Mutated 1 file(s)');
  });
});

describe('chooseBase', () => {
  const known = (...revs: string[]) => (rev: string) => revs.includes(rev);

  it('diffs against the cache commit when the cache hit and the commit is in the checkout', () => {
    expect(chooseBase({ cache: 'hit', since: 'aaa', fallbackSince: 'bbb', lastResort: 'HEAD~1', isCommit: known('aaa', 'bbb') })).toEqual({
      since: 'aaa',
      cacheUsable: true,
      note: null,
    });
  });

  it("falls back to the PR base and distrusts the cache when the cache's commit is not in the checkout", () => {
    const choice = chooseBase({ cache: 'hit', since: 'aaa', fallbackSince: 'bbb', lastResort: 'HEAD~1', isCommit: known('bbb') });
    expect(choice).toMatchObject({ since: 'bbb', cacheUsable: false });
    expect(choice.note).toContain('not in this checkout');
  });

  it('uses the PR base on a miss, then the first parent, and says so when neither exists', () => {
    expect(chooseBase({ cache: 'miss', since: '', fallbackSince: 'bbb', lastResort: 'HEAD~1', isCommit: known('bbb') })).toMatchObject({ since: 'bbb', note: null });
    expect(chooseBase({ cache: 'miss', since: '', fallbackSince: '0'.repeat(40), lastResort: 'HEAD~1', isCommit: known('HEAD~1') })).toMatchObject({ since: 'HEAD~1' });
    expect(chooseBase({ cache: 'miss', since: '', fallbackSince: '', lastResort: 'HEAD~1', isCommit: known() })).toEqual({
      since: null,
      cacheUsable: false,
      note: 'no commit to diff against was found',
    });
  });
});

describe('planFromRepo', () => {
  /** A fake repository: the commits it knows, what `git diff` lists since each, and the files at HEAD. */
  function fakeIo(opts: { commits: string[]; diff?: Record<string, string[]>; files?: Record<string, string>; old?: Record<string, string> }) {
    const calls: string[][] = [];
    const files = opts.files ?? {};
    const io: PlanIo = {
      git: (...args) => {
        calls.push(args);
        if (args[0] === 'cat-file') {
          if (opts.commits.some(c => args[2] === `${c}^{commit}`)) return '';
          throw new Error('unknown revision');
        }
        if (args[0] === 'diff') return (opts.diff?.[args[args.length - 2]] ?? []).join('\n');
        if (args[0] === 'show') {
          const old = opts.old?.[args[1]];
          if (old === undefined) throw new Error('path does not exist');
          return old;
        }
        throw new Error(`unexpected git ${args.join(' ')}`);
      },
      exists: p => p in files,
      read: p => files[p],
    };
    return { io, calls };
  }
  const config = { mutate: ['src/**/*.ts', '!src/**/*.test.ts', '!src/tool-args.ts'] };

  it("takes the PR base when the cache's commit is missing, and still mutates what the PR changed", () => {
    const { io } = fakeIo({
      commits: ['base111'],
      diff: { base111: ['src/utils/snippet.ts', 'README.md'] },
      files: { 'src/utils/snippet.ts': '', 'README.md': '' },
    });
    const result = planFromRepo({ cache: 'hit', since: 'gone222', fallbackSince: 'base111', config }, io);
    expect(result).toMatchObject({ mode: 'targeted', mutate: ['src/utils/snippet.ts'] });
    expect(result.reasons.join(' ')).toContain('not in this checkout');
  });

  it('trusts the cache, and reads no blind spot, when its commit is in the checkout', () => {
    const { io, calls } = fakeIo({ commits: ['cache111', 'base111'], diff: { cache111: ['src/utils/snippet.ts'] }, files: { 'src/utils/snippet.ts': '' } });
    expect(planFromRepo({ cache: 'hit', since: 'cache111', fallbackSince: 'base111', config }, io).mode).toBe('incremental');
    expect(calls.find(c => c[0] === 'diff')).toContain('cache111');
  });

  it('lists both paths of a rename, so a moved blind-spot file is seen', () => {
    const { io, calls } = fakeIo({
      commits: ['base111'],
      diff: { base111: ['src/tool-args.ts', 'src/args.ts'] },
      files: { 'src/args.ts': '' },
    });
    const result = planFromRepo({ cache: 'miss', since: '', fallbackSince: 'base111', config }, io);
    expect(calls.find(c => c[0] === 'diff')).toContain('--no-renames');
    expect(result.reasons.join(' ')).toContain('src/tool-args.ts');
    expect(result.mutate).toEqual(['src/args.ts']);
  });

  it('reads a deleted test from the old commit and mutates the file it imported', () => {
    const { io } = fakeIo({
      commits: ['base111'],
      diff: { base111: ['src/utils/snippet.test.ts'] },
      files: { 'src/utils/snippet.ts': '' },
      old: { 'base111:src/utils/snippet.test.ts': "import { x } from './snippet.js';" },
    });
    expect(planFromRepo({ cache: 'miss', since: '', fallbackSince: 'base111', config }, io)).toMatchObject({
      mode: 'targeted',
      mutate: ['src/utils/snippet.ts'],
      fromTests: ['src/utils/snippet.ts'],
    });
  });

  it('adds the files whose baseline entry changed', () => {
    const { io } = fakeIo({
      commits: ['base111'],
      diff: { base111: ['mutation-baseline.json'] },
      files: { 'mutation-baseline.json': JSON.stringify({ files: { 'src/a.ts': { score: 91 } } }), 'src/a.ts': '' },
      old: { 'base111:mutation-baseline.json': JSON.stringify({ files: { 'src/a.ts': { score: 90 } } }) },
    });
    expect(planFromRepo({ cache: 'miss', since: '', fallbackSince: 'base111', config }, io)).toMatchObject({ mutate: ['src/a.ts'], fromBaseline: ['src/a.ts'] });
  });

  it("takes the baseline entries a PR changed against the PR base, not the cache's commit, which can predate the baseline", () => {
    const entry = (score: number) => ({ score, ignores: 0 });
    const baseline = (files: Record<string, { score: number; ignores: number }>) => JSON.stringify({ stryker: '10.0.0', files });
    const { io } = fakeIo({
      commits: ['cache111', 'base111'],
      // A blind-spot file changed, so the cache can't be trusted and the cache-miss path runs.
      diff: { cache111: ['vitest.config.ts', 'mutation-baseline.json'] },
      files: {
        'mutation-baseline.json': baseline({ 'src/a.ts': entry(92), 'src/b.ts': entry(80), 'src/c.ts': entry(70) }),
        'src/a.ts': '',
        'src/b.ts': '',
        'src/c.ts': '',
      },
      // The cache is older than the baseline (no file there), and the PR base differs from HEAD in a.ts only.
      old: { 'base111:mutation-baseline.json': baseline({ 'src/a.ts': entry(90), 'src/b.ts': entry(80), 'src/c.ts': entry(70) }) },
    });
    const result = planFromRepo({ cache: 'hit', since: 'cache111', fallbackSince: 'base111', config }, io);
    expect(result.mode).toBe('targeted');
    expect(result.fromBaseline).toEqual(['src/a.ts']);
    expect(result.mutate).toEqual(['src/a.ts']);
  });

  describe('the mutant budget on a re-baseline PR (ADR-0028)', () => {
    const names = Array.from({ length: 12 }, (_, i) => `src/m${String(i).padStart(2, '0')}.ts`);
    const baseline = (score: number) => JSON.stringify({ stryker: '10.0.0', files: Object.fromEntries(names.map(n => [n, { score, ignores: 0 }])) });
    const INCREMENTAL = 'reports/mutation/stryker-incremental.json';
    const withIncremental = { ...config, incrementalFile: INCREMENTAL };
    /** A Stryker incremental file: the report format, `size` mutants for each file. */
    const incrementalOf = (size: number) =>
      JSON.stringify({
        schemaVersion: '2',
        thresholds: { high: 80, low: 60 },
        files: Object.fromEntries(names.map(n => [n, { language: 'typescript', source: '', mutants: Array.from({ length: size }, (_, i) => ({ id: String(i), status: 'Killed' })) }])),
        testFiles: {},
      });
    const reBaseline = (extra: Record<string, string> = {}) =>
      fakeIo({
        commits: ['base111'],
        diff: { base111: ['package-lock.json', 'mutation-baseline.json'] },
        files: { 'mutation-baseline.json': baseline(91), ...Object.fromEntries(names.map(n => [n, ''])), ...extra },
        old: { 'base111:mutation-baseline.json': baseline(90) },
      });

    it("mutates the first files that fit by the restored file's counts, and leaves the rest to the weekly run", () => {
      const { io } = reBaseline({ [INCREMENTAL]: incrementalOf(300) });
      const result = planFromRepo({ cache: 'hit', since: 'gone222', fallbackSince: 'base111', config: withIncremental }, io);
      // 4 x 300 = 1,200 fits in 1,280, a fifth would not.
      expect(result).toMatchObject({
        mode: 'targeted',
        mutate: names.slice(0, 4),
        fromBaseline: names.slice(0, 4),
        baselineChanged: 12,
        estimatedMutants: 1200,
        estimatedByFallback: [],
        leftToWeekly: names.slice(4),
      });
    });

    it('sizes every file at the fallback when no incremental file was restored', () => {
      const { io } = reBaseline();
      const result = planFromRepo({ cache: 'miss', since: '', fallbackSince: 'base111', config: withIncremental }, io);
      expect(result).toMatchObject({ mutate: names.slice(0, 2), estimatedMutants: 2 * FALLBACK_MUTANTS, leftToWeekly: names.slice(2) });
      expect(result.estimatedByFallback).toEqual(names);
    });

    it('does the same when the config names no incremental file, or the file does not parse', () => {
      const missing = planFromRepo({ cache: 'miss', since: '', fallbackSince: 'base111', config }, reBaseline({ [INCREMENTAL]: incrementalOf(1) }).io);
      expect(missing.mutate).toEqual(names.slice(0, 2));
      const broken = planFromRepo({ cache: 'miss', since: '', fallbackSince: 'base111', config: withIncremental }, reBaseline({ [INCREMENTAL]: '{"files": ' }).io);
      expect(broken.mutate).toEqual(names.slice(0, 2));
    });

    it('does not read the incremental file when the cache is trusted', () => {
      const { io } = fakeIo({ commits: ['cache111'], diff: { cache111: ['src/utils/snippet.ts'] }, files: { 'src/utils/snippet.ts': '', [INCREMENTAL]: incrementalOf(1) } });
      const read = vi.spyOn(io, 'read');
      expect(planFromRepo({ cache: 'hit', since: 'cache111', fallbackSince: 'base111', config: withIncremental }, io).mode).toBe('incremental');
      expect(read).not.toHaveBeenCalled();
    });
  });

  it('says nothing was checked when no commit to diff against exists', () => {
    const { io, calls } = fakeIo({ commits: [] });
    const result = planFromRepo({ cache: 'hit', since: 'gone222', fallbackSince: '0'.repeat(40), config }, io);
    expect(result).toMatchObject({ mode: 'empty', mutate: [], reasons: ['no commit to diff against was found'] });
    expect(calls.some(c => c[0] === 'diff')).toBe(false);
  });
});

/** The text of every `run:` entry (inline, or a `|` or `>` block) in a workflow. */
function runBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  lines.forEach((line, i) => {
    const m = /^(\s*(?:- )?)run:\s*(.*)$/.exec(line);
    if (!m) return;
    const keyIndent = m[1].length;
    const body = /^[|>][+-]?$/.test(m[2]) ? [] : [m[2]];
    for (let j = i + 1; j < lines.length; j++) {
      const indent = lines[j].length - lines[j].trimStart().length;
      if (lines[j].trim() !== '' && indent <= keyIndent) break;
      body.push(lines[j]);
    }
    blocks.push(body.join('\n'));
  });
  return blocks;
}

/** Values a person can set from outside: a dispatch input, anything in the event payload. */
const UNTRUSTED_EXPRESSION = /\$\{\{[^}]*\b(?:inputs|github\.event)\./;

describe('run block guard', () => {
  it('finds the run blocks of a workflow, inline and block form', () => {
    const text = ['steps:', '  - run: npm ci', '  - name: x', '    run: |', '      echo "$A"', '      echo b', '    env:', '      A: 1'].join('\n');
    expect(runBlocks(text)).toEqual(['npm ci', '      echo "$A"\n      echo b']);
  });

  it('flags an input or an event field in a run block, and not one in env or with', () => {
    const bad = ['  - run: |', '      echo "${{ inputs.ref }}"'].join('\n');
    const bad2 = '  - run: echo ${{ github.event.pull_request.title }}';
    const fine = ['  - run: echo "$REF"', '    env:', '      REF: ${{ inputs.ref }}', '  - uses: x', '    with:', '      ref: ${{ inputs.ref }}'].join('\n');
    expect(runBlocks(bad).some(b => UNTRUSTED_EXPRESSION.test(b))).toBe(true);
    expect(runBlocks(bad2).some(b => UNTRUSTED_EXPRESSION.test(b))).toBe(true);
    expect(runBlocks(fine).some(b => UNTRUSTED_EXPRESSION.test(b))).toBe(false);
  });
});

// The workflow side of ADR-0026: PR jobs read the cache and never write it, and the actions are
// pinned by commit. Read as text: the plan logic above is where the decisions are.
describe('mutation workflows', () => {
  const read = (name: string) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
  const ci = read('ci.yml');
  const weekly = read('mutation-weekly.yml');
  /** The steps of a workflow, each as its text. A step starts at a `- ` at the steps' indent. */
  const steps = (text: string) => text.split(/\n      - /).slice(1);
  const mutationJob = ci.slice(ci.indexOf('\n  mutation:'));

  it('the PR mutation job restores the cache and only saves on a push', () => {
    const uses = [...mutationJob.matchAll(/uses: (actions\/cache[^@\s]*)@/g)].map(m => m[1]);
    expect(uses).toContain('actions/cache/restore');
    expect(uses.every(u => u === 'actions/cache/restore' || u === 'actions/cache/save')).toBe(true);
    const saves = steps(mutationJob).filter(s => s.includes('actions/cache/save@'));
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatch(/\bif: github\.event_name == 'push'/);
  });

  it('the mutation job is Node 24 only, enforcing and inside the 10-minute budget', () => {
    // #205 dropped continue-on-error: a ratchet failure fails the job.
    expect(mutationJob).not.toMatch(/continue-on-error/);
    expect(mutationJob).toMatch(/\n    timeout-minutes: 10\n/);
    expect(mutationJob).toMatch(/node-version: 24\n/);
    // src/adr-workflow-guards.test.ts finds the unit-test jobs by this step. The mutation job isn't one.
    expect(mutationJob).not.toMatch(/npx vitest run src/);
  });

  it('the weekly job runs on a schedule and by hand, restores nothing and saves under its own SHA', () => {
    expect(weekly).toMatch(/\n  schedule:\n/);
    expect(weekly).toMatch(/\n  workflow_dispatch:\n/);
    expect(weekly).not.toMatch(/actions\/cache\/restore|actions\/cache@/);
    expect(weekly).toMatch(/key: mutation-incremental-\$\{\{ steps\.commit\.outputs\.sha \}\}/);
  });

  it('no run: block in the mutation workflows interpolates an input or an event field', () => {
    // A dispatch input or a PR field goes through env:, so the shell never parses it as code.
    for (const [name, text] of [['ci.yml (mutation job)', mutationJob], ['mutation-weekly.yml', weekly]] as const) {
      const blocks = runBlocks(text);
      expect(blocks.length, name).toBeGreaterThan(0);
      for (const block of blocks) expect(block, name).not.toMatch(UNTRUSTED_EXPRESSION);
    }
  });

  it('the weekly job saves the cache only for a commit on main', () => {
    expect(weekly).toMatch(/fetch-depth: 0/);
    expect(weekly).toMatch(/merge-base --is-ancestor "\$SHA" origin\/main/);
    const saves = steps(weekly).filter(s => s.includes('actions/cache/save@'));
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatch(/\bif: always\(\) && steps\.stryker\.outcome == 'success' && steps\.commit\.outputs\.on_main == 'true'/);
  });

  // ADR-0026, #205: the enforcement. A job that quietly stopped running the ratchet would pass anything.
  it('the PR mutation job runs the ratchet against the base branch, with the labels, as its last step', () => {
    const all = steps(mutationJob);
    const ratchet = all.filter(s => s.includes('scripts/mutation-ratchet.ts'));
    expect(ratchet).toHaveLength(1);
    expect(all[all.length - 1]).toBe(ratchet[0]);
    // On a PR only (BASE_REF is empty on a push), against the commit the plan used (next test).
    expect(ratchet[0]).toMatch(/run: node scripts\/mutation-ratchet\.ts check \$\{BASE_REF:\+--base "\$BASE_SHA"\}/);
    // A JSON array, so a label name with a comma in it can't pass for two (parseLabels).
    expect(ratchet[0]).toMatch(/PR_LABELS: \$\{\{ toJSON\(github\.event\.pull_request\.labels\.\*\.name\) \}\}/);
    expect(ratchet[0]).not.toMatch(/continue-on-error|\bif:/);
    // The head commit for the "left to the weekly run" annotation (#223), through env: like the other event data.
    expect(ratchet[0]).toMatch(/PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  });

  // #223: two different bases (the PR base commit for the plan, a merge-base for the ratchet) can name different
  // commits when the base has moved. One value, resolved in one early step, feeds both.
  it('the plan and the ratchet use the same base commit, resolved once in an early step', () => {
    const all = steps(mutationJob);
    const resolve = all.findIndex(s => s.includes('name: Resolve the base commit'));
    const planIdx = all.findIndex(s => s.includes('mutation-ci.ts plan'));
    const ratchetIdx = all.findIndex(s => s.includes('mutation-ratchet.ts'));
    expect(resolve).toBeGreaterThanOrEqual(0);
    // Written to $GITHUB_ENV before the plan and the ratchet read it.
    expect(resolve).toBeLessThan(planIdx);
    expect(resolve).toBeLessThan(ratchetIdx);
    // On a PR: the first parent of the checked-out merge commit, the base tip HEAD was built on (the event's
    // base.sha goes stale when main moves). On a push: the commit before it. Event data goes in through env:.
    expect(all[resolve]).toMatch(/BASE_SHA="\$\(git rev-parse HEAD\^1\)"/);
    expect(all[resolve]).toMatch(/BASE_SHA="\$BEFORE"/);
    expect(all[resolve]).toMatch(/BEFORE: \$\{\{ github\.event\.before \}\}/);
    expect(all[resolve]).toMatch(/echo "BASE_SHA=\$BASE_SHA" >> "\$GITHUB_ENV"/);
    // Nothing else defines BASE_SHA, and the event's base.sha is left to the cache key.
    expect(mutationJob.match(/^ +BASE_SHA: /gm)).toBeNull();
    expect(mutationJob.match(/pull_request\.base\.sha/g)).toHaveLength(1);
    const planStep = all[planIdx];
    const ratchet = all[ratchetIdx];
    expect(planStep.match(/--fallback-since "\$BASE_SHA"/g)).toHaveLength(2); // the hit and the miss call
    expect(planStep).not.toMatch(/^ +BASE_SHA:/m);
    expect(ratchet).toMatch(/--base "\$BASE_SHA"/);
    expect(ratchet).not.toMatch(/origin\/|merge-base/);
  });

  // ADR-0028, #239: the plan sizes the cache-miss run from the restored incremental file's per-file mutant
  // counts, and the targeted step deletes that file so no result from main is reused. The plan has to run
  // after the restore and before the delete, on the path stryker.config.json names.
  it('the plan reads the restored incremental file before the targeted run drops it', () => {
    const all = steps(mutationJob);
    const incrementalFile = (config as { incrementalFile?: string }).incrementalFile;
    expect(incrementalFile).toBe('reports/mutation/stryker-incremental.json');
    const restore = all.findIndex(s => s.includes('actions/cache/restore@'));
    const planIdx = all.findIndex(s => s.includes('mutation-ci.ts plan'));
    const drop = all.findIndex(s => /\brm -f\b/.test(s) && s.includes(incrementalFile as string));
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(restore).toBeLessThan(planIdx);
    expect(planIdx).toBeLessThan(drop);
    // The file the cache restores is the file the config names, which the plan reads and the targeted step drops.
    expect(all[restore]).toContain(`path: ${incrementalFile}`);
    expect(all[planIdx]).not.toMatch(/\brm\b/);
    // Only the targeted step drops it, and it does so before Stryker starts.
    expect(all.filter(s => /\brm -f\b/.test(s))).toHaveLength(1);
    expect(all[drop]).toMatch(/if: steps\.plan\.outputs\.mode == 'targeted'/);
    expect(all[drop].indexOf('rm -f')).toBeLessThan(all[drop].indexOf('npx stryker run'));
  });

  // ADR-0028, #239: a changed source left out by the budget fails the ratchet until a weekly run succeeded on the
  // head commit. The look-up reads the Actions API, so the job needs actions: read and nothing more, and the
  // weekly run has to leave the commit it checked out where the look-up can find it.
  it('the mutation job reads Actions runs (actions: read) with the token given to the ratchet step only, and no more', () => {
    const jobHead = mutationJob.slice(0, mutationJob.indexOf('\n    steps:'));
    expect(jobHead).toMatch(/\n    permissions:\n      contents: read\n      actions: read$/);
    expect(jobHead.match(/^ {6}\w[\w-]*: \w+$/gm)).toEqual(['      contents: read', '      actions: read']);
    const all = steps(mutationJob);
    const withToken = all.filter(s => /^ +GITHUB_TOKEN:/m.test(s));
    expect(withToken).toHaveLength(1);
    expect(withToken[0]).toContain('scripts/mutation-ratchet.ts');
    expect(withToken[0]).toMatch(/GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    // The other jobs keep the workflow's contents: read.
    expect(ci.slice(0, ci.indexOf('\njobs:'))).toMatch(/\npermissions:\n  contents: read\n/);
    expect(ci.slice(ci.indexOf('\njobs:')).match(/\n {4}permissions:/g)).toHaveLength(1);
  });

  it('the weekly report artifact is named for the commit it checked out, and kept as long as the gate says', () => {
    const all = steps(weekly);
    const checkout = all.find(s => s.includes('actions/checkout@'));
    expect(checkout).toMatch(/ref: \$\{\{ inputs\.ref \}\}/);
    // The name comes from `git rev-parse HEAD` after that checkout, not from the ref input as typed.
    const resolve = all.find(s => s.includes('id: commit'));
    expect(resolve).toMatch(/SHA="\$\(git rev-parse HEAD\)"/);
    expect(resolve).toMatch(/echo "sha=\$SHA" >> "\$GITHUB_OUTPUT"/);
    expect(all.indexOf(checkout as string)).toBeLessThan(all.indexOf(resolve as string));
    const upload = all.find(s => s.includes('actions/upload-artifact@')) as string;
    expect(upload).toContain(`name: ${weeklyArtifactName('${{ steps.commit.outputs.sha }}')}`);
    expect(upload).toMatch(/if: always\(\)/);
    expect(upload).toContain(`retention-days: ${WEEKLY_ARTIFACT_RETENTION_DAYS}`);
    // The name the gate asks for is that name, for a full SHA.
    expect(weeklyArtifactName('a'.repeat(40))).toBe(`mutation-report-${'a'.repeat(40)}`);
  });

  it('a label change re-runs the pull request checks, so the label can excuse a lowered score', () => {
    expect(ci).toMatch(/pull_request:\n(?:\s+#.*\n)*\s+types: \[[^\]]*\blabeled\b[^\]]*\bunlabeled\b[^\]]*\]/);
  });

  it('the weekly job runs the ratchet on the whole scope and fails after it has saved the report and the cache', () => {
    const all = steps(weekly);
    const ratchet = all.find(s => s.includes('scripts/mutation-ratchet.ts'));
    expect(ratchet).toMatch(/continue-on-error: true/);
    expect(ratchet).not.toMatch(/--base|--plan|--no-rerun/);
    const last = all[all.length - 1];
    expect(last).toMatch(/if: steps\.ratchet\.outcome == 'failure'/);
    expect(last).toMatch(/exit 1/);
  });

  it('pins every action by a full commit SHA', () => {
    for (const text of [mutationJob, weekly]) {
      const refs = [...text.matchAll(/uses: (\S+)/g)].map(m => m[1]);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(ref, ref).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
