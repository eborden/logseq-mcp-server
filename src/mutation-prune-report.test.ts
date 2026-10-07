import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'node:url';
import { enforcementLines, linesOutsideFences, sections } from '../scripts/docs-format.js';
import {
  CHARACTERIZATION,
  DOC_DIRS,
  enforcedTestFiles,
  globToRegExp,
  loadExclusions,
  mutationExcludes,
  pruneReport,
  renderMarkdown,
  testLines,
  type DocsReader,
  type Exclusions,
  type PruneInputReport,
} from '../scripts/mutation-prune-report.js';

// The prune report (ADR-0026, #288). Every path, test name and doc below is made up, except the
// last block, which reads the repo's own docs/ and vitest.mutation.config.ts to show the
// exclusions come from those files.

/** Docs from a map of path to text; a directory lists the files directly in it. */
const readerOf = (files: Record<string, string>): DocsReader => ({
  list: dir =>
    Object.keys(files)
      .filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .map(p => p.slice(dir.length + 1)),
  read: path => files[path],
});

const ENFORCEMENT_DOC = (lines: string[]) =>
  ['# ADR-0042: something', '', '## Mechanical enforcement', '', ...lines, '', '## Status', '', 'accepted'].join('\n');

const docsFs = readerOf({
  'docs/adr/0042-something.md': ENFORCEMENT_DOC([
    '- test: `src/guarded.test.ts` (the rule, with a second span `src/also-guarded.test.ts`)',
    '- ci: `src/ci-only.test.ts`',
    '- reviewer: `src/reviewer-only.test.ts` is read by a person',
  ]),
  'docs/adr/README.md': ENFORCEMENT_DOC(['- test: `src/readme-example.test.ts`']),
  'docs/business-rules/0007-a-rule.md': [
    '# BR-0007: a rule',
    '',
    '## Rationale',
    '',
    '- test: `src/outside-the-section.test.ts`',
    '',
    '## Mechanical enforcement',
    '',
    '```',
    '- test: `src/fenced.test.ts`',
    '```',
    '- test: `src/guarded.test.ts`',
    '- test: `.github/workflows/x.yml` and `src/rule.test.ts`',
    '',
    '## Changelog',
  ].join('\n'),
});

const CONFIG = `export default mergeConfig(base, defineConfig({
  test: {
    exclude: [
      // A comment with a 'quoted' word and a ] bracket.
      '**/.stryker-tmp/**',
      "src/snapshot.test.ts",
      'src/guard-*.test.ts',
    ],
    include: ['src/not-an-exclude.test.ts'],
  },
}));`;

const exclusions: Exclusions = { enforced: enforcedTestFiles(docsFs), mutationExcludes: mutationExcludes(CONFIG) };

describe('exclusions', () => {
  it('reads every test file from the test: lines of ADRs and business rules, and nothing else', () => {
    expect(Object.fromEntries(exclusions.enforced)).toEqual({
      'src/guarded.test.ts': ['ADR-0042', 'BR-0007'],
      'src/also-guarded.test.ts': ['ADR-0042'],
      'src/rule.test.ts': ['BR-0007'],
    });
  });

  it('reads the exclude list of the mutation config, skipping comments and other lists', () => {
    expect(exclusions.mutationExcludes).toEqual(['**/.stryker-tmp/**', 'src/snapshot.test.ts', 'src/guard-*.test.ts']);
    expect(() => mutationExcludes('export default {}')).toThrow(/no exclude/);
    expect(() => mutationExcludes("exclude: ['a'")).toThrow(/not closed/);
  });

  it('matches globs the way vitest does: * within a segment, ** across them', () => {
    expect(globToRegExp('src/guard-*.test.ts').test('src/guard-docs.test.ts')).toBe(true);
    expect(globToRegExp('src/guard-*.test.ts').test('src/guard-a/b.test.ts')).toBe(false);
    expect(globToRegExp('**/.stryker-tmp/**').test('.stryker-tmp/sandbox/src/a.test.ts')).toBe(true);
    expect(globToRegExp('**/.stryker-tmp/**').test('src/.stryker-tmp/a.test.ts')).toBe(true);
    expect(globToRegExp('src/a.test.ts').test('src/aXtest.ts')).toBe(false);
  });

  it('calls a test characterization by a marker in its full name', () => {
    expect(CHARACTERIZATION.test('parse: output pinned across the refactor (#1) keeps the order')).toBe(true);
    expect(CHARACTERIZATION.test('Characterization of the old renderer returns x')).toBe(true);
    expect(CHARACTERIZATION.test('pins the default')).toBe(false);
  });
});

// Six mutants are killed and one survives, in listed order. t1 is the sole killer of the 2nd and 5th;
// t2 kills four, all shared; t3 covers two and kills nothing; t4 covers nothing. t5 (characterization) and t6 (in
// an enforced file) and t7 (in a guard file) would be candidates if they weren't excluded.
const REPORT: PruneInputReport = {
  config: { disableBail: true },
  files: {
    'src/a.ts': {
      mutants: [
        { killedBy: ['t1', 't2'], coveredBy: ['t1', 't2', 't3'] },
        { killedBy: ['t1'], coveredBy: ['t1'] },
        { killedBy: ['t2', 't5'], coveredBy: ['t2', 't5'] },
        { killedBy: ['t2', 't6', 't6'], coveredBy: ['t2', 't6'] },
      ],
    },
    'src/b.ts': {
      mutants: [
        { killedBy: ['t1'], coveredBy: ['t1'] },
        { killedBy: ['t2', 't7'], coveredBy: ['t2', 't7'] },
        { coveredBy: ['t3', 't2'] },
      ],
    },
  },
  testFiles: {
    'src/z.test.ts': {
      tests: [
        { id: 't2', name: 'z | shares every kill' },
        { id: 't1', name: 'z kills two alone' },
        { id: 't3', name: 'z covers but never fails' },
        { id: 't4', name: 'z covers nothing' },
        { id: 't5', name: 'z: output pinned across the rewrite matches' },
      ],
    },
    'src/guarded.test.ts': { tests: [{ id: 't6', name: 'guarded shares a kill' }] },
    'src/guard-docs.test.ts': { tests: [{ id: 't7', name: 'guard shares a kill' }] },
  },
};

describe('pruneReport', () => {
  const result = pruneReport(REPORT, exclusions);
  const row = (id: string) => result.files.flatMap(f => f.tests).find(t => t.id === id)!;

  it('counts kills, sole kills and covers per test', () => {
    expect(row('t1')).toMatchObject({ kills: 3, soleKills: 2, covers: 3, status: 'sole-killer' });
    expect(row('t2')).toMatchObject({ kills: 4, soleKills: 0, covers: 5, status: 'candidate' });
    // A test named twice in one killedBy counts once, so it is not taken for a second killer.
    expect(row('t6')).toMatchObject({ kills: 1, soleKills: 0 });
  });

  it('makes a candidate of a test that kills nothing, and of one that covers nothing', () => {
    expect(row('t3')).toMatchObject({ kills: 0, covers: 2, status: 'candidate' });
    expect(row('t4')).toMatchObject({ kills: 0, covers: 0, status: 'candidate' });
  });

  it('never makes a candidate of an excluded test, and gives each its reason', () => {
    expect(row('t5')).toMatchObject({ status: 'excluded', reasons: [expect.stringMatching(/^characterization test/)] });
    expect(row('t6')).toMatchObject({ status: 'excluded', reasons: ['named in a test: enforcement line of ADR-0042, BR-0007'] });
    expect(row('t7')).toMatchObject({
      status: 'excluded',
      reasons: ['snapshot or guard test: vitest.mutation.config.ts excludes `src/guard-*.test.ts`'],
    });
    expect(result.files.find(f => f.file === 'src/guarded.test.ts')!.reasons).toHaveLength(1);
    expect(result.files.find(f => f.file === 'src/z.test.ts')!.reasons).toEqual([]);
  });

  // Stryker names no killer for a Timeout or RuntimeError mutant, though both count as detected.
  it('flags a candidate that covers a timeout or runtime-error mutant, and keeps it out of "Kill nothing"', () => {
    const report: PruneInputReport = {
      config: { disableBail: true },
      files: {
        'src/a.ts': {
          mutants: [
            { status: 'Timeout', coveredBy: ['h1', 'h2'] },
            { status: 'RuntimeError', coveredBy: ['h1'] },
            { status: 'Survived', coveredBy: ['h2', 'h3'] },
          ],
        },
      },
      testFiles: {
        'src/h.test.ts': {
          tests: [
            { id: 'h1', name: 'h may hang the loop' },
            { id: 'h2', name: 'h may hang it too' },
            { id: 'h3', name: 'h covers a survivor' },
          ],
        },
      },
    };
    const result = pruneReport(report, exclusions);
    expect(result.files[0].tests.map(t => [t.id, t.status, t.kills, t.coversTimeouts])).toEqual([
      ['h1', 'candidate', 0, 2],
      ['h2', 'candidate', 0, 1],
      ['h3', 'candidate', 0, 0],
    ]);
    expect(result.totals).toMatchObject({ candidates: 3, killNothing: 1, coverTimeouts: 2, killedMutants: 0 });
    const markdown = renderMarkdown(result);
    expect(markdown).toContain('| h may hang the loop | 0 | 2 | 2 |');
    expect(markdown).toContain('Kill nothing:\n- h covers a survivor\n');
    expect(markdown).toContain(
      [
        'Check before pruning (may be the only test that detects a timeout or runtime error):',
        '- h may hang the loop (covers 2 timeout or runtime-error mutants)',
        '- h may hang it too (covers 1 timeout or runtime-error mutants)',
      ].join('\n'),
    );
  });

  it('totals the tests, and reads disableBail from the report', () => {
    expect(result.totals).toEqual({
      testFiles: 3,
      tests: 7,
      killedMutants: 6,
      candidates: 3,
      killNothing: 2,
      coverTimeouts: 0,
      soleKillers: 1,
      excluded: 3,
    });
    expect(result.disableBail).toBe(true);
    expect(pruneReport({ files: {} }, exclusions)).toMatchObject({ disableBail: false, totals: { tests: 0 }, files: [] });
  });
});

describe('renderMarkdown', () => {
  const markdown = renderMarkdown(pruneReport(REPORT, exclusions));

  it('groups candidates by test file with their counts, and lists the tests that kill nothing again', () => {
    expect(markdown).toContain(
      [
        '### src/z.test.ts',
        '',
        '3 candidates of 5 tests.',
        '',
        '| Test | Kills | Covers | Timeouts |',
        '|---|---:|---:|---:|',
        '| z \\| shares every kill | 4 | 5 | 0 |',
        '| z covers but never fails | 0 | 2 | 0 |',
        '| z covers nothing | 0 | 0 | 0 |',
        '',
        'Kill nothing:',
        '- z covers but never fails',
        '- z covers nothing (covers no mutant)',
      ].join('\n'),
    );
    expect(markdown).toContain('| Candidates | 3 |\n| Candidates that kill nothing | 2 |');
    // No section for a file without candidates.
    expect(markdown).not.toContain('### src/guarded.test.ts');
  });

  it('lists excluded files once and characterization tests one by one', () => {
    expect(markdown).toContain(
      [
        '| File | Tests | Reason |',
        '|---|---:|---|',
        '| src/guard-docs.test.ts | 1 | snapshot or guard test: vitest.mutation.config.ts excludes `src/guard-*.test.ts` |',
        '| src/guarded.test.ts | 1 | named in a test: enforcement line of ADR-0042, BR-0007 |',
      ].join('\n'),
    );
    expect(markdown).toContain('| src/z.test.ts | z: output pinned across the rewrite matches | 1 | 0 |');
  });

  it('says a row is one full name, so two tests with the same name in a file are one row', () => {
    expect(markdown).toContain('A row is a unique full name in its file: two tests in one file with the same name are one row');
  });

  it('warns when the run had the bail on, and only then', () => {
    expect(markdown).not.toMatch(/Not a `disableBail` run/);
    expect(renderMarkdown(pruneReport({ ...REPORT, config: { disableBail: false } }, exclusions))).toMatch(/Not a `disableBail` run/);
  });

  it('keeps a test name with a line break or a backtick in one cell', () => {
    const report: PruneInputReport = { files: {}, testFiles: { 'src/x.test.ts': { tests: [{ id: 'a', name: 'a\n  `b`' }] } } };
    expect(renderMarkdown(pruneReport(report, exclusions))).toContain('| a \\`b\\` | 0 | 0 | 0 |');
  });

  it('holds test names and counts, never test source (BR-0001)', () => {
    const withSource = {
      ...REPORT,
      testFiles: { 'src/x.test.ts': { source: 'const SECRET_SOURCE = 1;', tests: [{ id: 'a', name: 'a' }] } },
    } as PruneInputReport;
    const result = pruneReport(withSource, exclusions);
    expect(renderMarkdown(result)).not.toContain('SECRET_SOURCE');
    expect(JSON.stringify(result)).not.toContain('SECRET_SOURCE');
  });
});

describe("the repo's own exclusions", () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const real = loadExclusions(root);

  it('reads the ADR-0016 guard from docs/ and the guard list from vitest.mutation.config.ts', () => {
    expect(real.enforced.get('src/tool-list.test.ts')).toContain('ADR-0016');
    expect(real.enforced.get('src/mutation-ci.test.ts')).toContain('ADR-0028');
    const config = readFileSync(new URL('../vitest.mutation.config.ts', import.meta.url), 'utf8');
    expect(real.mutationExcludes).toContain('src/tool-list.test.ts');
    expect(real.mutationExcludes).toContain('src/logseq-instance*.test.ts');
    for (const glob of real.mutationExcludes) expect(config).toContain(`'${glob}'`);
  });

  it('reads the same test: lines as scripts/docs-format.ts, in every ADR and business rule', () => {
    let lines = 0;
    for (const dir of Object.keys(DOC_DIRS)) {
      for (const name of readdirSync(new URL(`../${dir}`, import.meta.url))) {
        if (!/^[0-9]{4}-/.test(name)) continue;
        const content = readFileSync(new URL(`../${dir}/${name}`, import.meta.url), 'utf8');
        const section = sections(linesOutsideFences(content)).get('Mechanical enforcement')?.[0];
        const expected = section ? enforcementLines(section.body).valid.filter(l => l.tier === 'test').map(l => l.reference) : [];
        expect(testLines(content), name).toEqual(expected);
        lines += expected.length;
      }
    }
    expect(lines).toBeGreaterThan(10);
  });

  it('marks the characterization tests the rule documents', () => {
    const source = readFileSync(new URL('./tools/check-links.test.ts', import.meta.url), 'utf8');
    const describes = [...source.matchAll(/describe\('([^']+)'/g)].map(m => m[1]);
    expect(describes.filter(d => CHARACTERIZATION.test(d)).length).toBeGreaterThan(0);
  });
});
