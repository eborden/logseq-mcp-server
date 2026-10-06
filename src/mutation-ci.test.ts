import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  changedBaselineFiles,
  fileScores,
  importedSources,
  inMutateScope,
  isBlindSpot,
  plan,
  renderSummary,
  scopeFromConfig,
  type PlanInput,
} from '../scripts/mutation-ci.js';

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
    });
    expect(result.mutate).toEqual(['src/tools/get-page.ts', 'src/utils/compact.ts', 'src/utils/snippet.ts']);
    expect(result).toMatchObject({
      changedSources: ['src/utils/snippet.ts'],
      fromBaseline: ['src/tools/get-page.ts'],
      fromTests: ['src/utils/compact.ts', 'src/utils/snippet.ts'],
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

  it('the mutation job is Node 24 only, informational and inside the 10-minute budget', () => {
    expect(mutationJob).toMatch(/\n    continue-on-error: true\n/);
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

  it('pins every action by a full commit SHA', () => {
    for (const text of [mutationJob, weekly]) {
      const refs = [...text.matchAll(/uses: (\S+)/g)].map(m => m[1]);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(ref, ref).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
