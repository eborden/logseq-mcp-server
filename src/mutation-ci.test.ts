import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  changedBaselineFiles,
  chooseBase,
  fileScores,
  importedSources,
  inMutateScope,
  isBlindSpot,
  MAX_BASELINE_FILES,
  plan,
  planFromRepo,
  renderSummary,
  scopeFromConfig,
  type PlanInput,
  type PlanIo,
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

  describe('the cap on baseline-driven files (#223)', () => {
    const entries = (n: number) => Array.from({ length: n }, (_, i) => `src/m${String(i).padStart(2, '0')}.ts`);

    it('is 8', () => {
      expect(MAX_BASELINE_FILES).toBe(8);
    });

    it('mutates every changed baseline entry at the cap, as before', () => {
      const result = plan({ ...base, cacheUsable: false, baselineChanged: entries(MAX_BASELINE_FILES) });
      expect(result).toMatchObject({ mode: 'targeted', mutate: entries(MAX_BASELINE_FILES), fromBaseline: entries(MAX_BASELINE_FILES), baselineChanged: 8, leftToWeekly: [] });
    });

    it('leaves the baseline entries to the weekly run one over the cap, and lists them', () => {
      const result = plan({ ...base, cacheUsable: false, baselineChanged: entries(MAX_BASELINE_FILES + 1) });
      expect(result).toMatchObject({ mode: 'empty', mutate: [], fromBaseline: [], baselineChanged: 9, leftToWeekly: entries(9) });
    });

    it('still mutates the changed sources and the files the changed tests import, when capped', () => {
      const result = plan({
        ...base,
        cacheUsable: false,
        changed: ['vitest.config.ts', 'src/utils/snippet.ts', 'src/utils/compact.test.ts'],
        baselineChanged: entries(12),
        readTest: () => "import { x } from './compact.js';",
      });
      expect(result).toMatchObject({
        mode: 'targeted',
        mutate: ['src/utils/compact.ts', 'src/utils/snippet.ts'],
        changedSources: ['src/utils/snippet.ts'],
        fromBaseline: [],
        fromTests: ['src/utils/compact.ts'],
        baselineChanged: 12,
        leftToWeekly: entries(12),
      });
    });

    it('does not list a capped entry as left out when a changed source brings it in anyway', () => {
      const result = plan({ ...base, cacheUsable: false, changed: ['src/m00.ts'], baselineChanged: entries(10) });
      expect(result.mutate).toEqual(['src/m00.ts']);
      expect(result.leftToWeekly).toEqual(entries(10).slice(1));
      expect(result.baselineChanged).toBe(10);
    });

    it('counts only entries that exist and are mutated, and each once', () => {
      const result = plan({
        ...base,
        cacheUsable: false,
        baselineChanged: [...entries(8), ...entries(8), 'src/tool-args.ts', 'src/gone.ts'],
        exists: p => p !== 'src/gone.ts',
      });
      expect(result).toMatchObject({ mode: 'targeted', baselineChanged: 8, leftToWeekly: [] });
    });

    it('does not apply on the incremental path', () => {
      expect(plan({ ...base, baselineChanged: entries(20) })).toMatchObject({ mode: 'incremental', leftToWeekly: [] });
    });

    it('says in the summary which entries were left out and that the weekly run checks them', () => {
      const result = plan({ ...base, cacheUsable: false, changed: ['src/utils/snippet.ts'], baselineChanged: entries(9) });
      const text = renderSummary(result, null);
      expect(text).toContain('9 baseline entries changed, over the cap of 8');
      expect(text).toContain('the 9 below');
      expect(text).toContain('weekly full run (`mutation-weekly.yml`)');
      expect(text).toContain('head commit');
      expect(text).toContain('unchecked until then');
      for (const f of entries(9)) expect(text).toContain(`- \`${f}\``);
      expect(text).toContain('Mutated 1 file(s)');
    });

    it('says so, and is not a pass, when the cap leaves nothing to mutate', () => {
      const text = renderSummary(plan({ ...base, cacheUsable: false, baselineChanged: entries(9) }), null);
      expect(text).toContain('over the cap');
      expect(text).toContain('Nothing was checked, and this is not a pass.');
      expect(text).not.toContain('none changed in the baseline');
    });

    it('says nothing about a cap when it did not bite', () => {
      const text = renderSummary(plan({ ...base, cacheUsable: false, baselineChanged: entries(3) }), null);
      expect(text).not.toContain('over the cap');
      expect(text).not.toContain('weekly');
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

  it('caps the baseline entries of a re-baseline PR, so it is not a cold full run (#223)', () => {
    const names = Array.from({ length: 12 }, (_, i) => `src/m${i}.ts`);
    const baseline = (score: number) => JSON.stringify({ stryker: '10.0.0', files: Object.fromEntries(names.map(n => [n, { score, ignores: 0 }])) });
    const { io } = fakeIo({
      commits: ['base111'],
      diff: { base111: ['package-lock.json', 'mutation-baseline.json'] },
      files: { 'mutation-baseline.json': baseline(91), ...Object.fromEntries(names.map(n => [n, ''])) },
      old: { 'base111:mutation-baseline.json': baseline(90) },
    });
    const result = planFromRepo({ cache: 'miss', since: '', fallbackSince: 'base111', config }, io);
    expect(result).toMatchObject({ mode: 'empty', mutate: [], baselineChanged: 12, leftToWeekly: [...names].sort() });
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
  });

  // #223: two different bases (the PR base commit for the plan, a merge-base for the ratchet) can name different
  // commits when the base has moved. One job-level input feeds both.
  it('the plan and the ratchet use the same base commit, from one job-level BASE_SHA', () => {
    const defs = [...mutationJob.matchAll(/^ {6}BASE_SHA: (.+)$/gm)];
    expect(defs).toHaveLength(1);
    expect(mutationJob).toMatch(/\n    env:\n(?: {6}#.*\n)*      BASE_SHA: /);
    expect(defs[0][1]).toBe('${{ github.event.pull_request.base.sha || github.event.before }}');
    // No other step spells the PR base out again: the definition and the cache key are the only two.
    expect(mutationJob.match(/pull_request\.base\.sha/g)).toHaveLength(2);
    const all = steps(mutationJob);
    const planStep = all.find(s => s.includes('mutation-ci.ts plan'));
    const ratchet = all.find(s => s.includes('mutation-ratchet.ts'));
    expect(planStep).toBeDefined();
    expect(planStep!.match(/--fallback-since "\$BASE_SHA"/g)).toHaveLength(2); // the hit and the miss call
    expect(planStep).not.toMatch(/^ +BASE_SHA:/m);
    expect(ratchet).toMatch(/--base "\$BASE_SHA"/);
    expect(ratchet).not.toMatch(/origin\/|merge-base/);
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
