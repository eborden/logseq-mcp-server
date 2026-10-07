/**
 * The prune report (ADR-0026, "Pruning and strengthening"; #206, #288).
 *
 * Reads Stryker's JSON report (the mutation-testing-elements schema) from a `disableBail` run and
 * lists the tests that are nobody's sole killer: candidates for a human to review before a pruning
 * PR. It lists only. It never deletes or edits a test.
 *
 * For each test it counts the mutants it kills (`killedBy` holds it), the mutants it is the sole
 * killer of (`killedBy` holds it alone) and the mutants it covers (`coveredBy`). A candidate is the
 * sole killer of nothing, which includes a test that kills nothing; those are listed again on their
 * own. Without `disableBail`, Stryker stops at the first failing test, so `killedBy` holds one test
 * and the counts overstate redundancy: the report says so at the top when the run had the bail on.
 *
 * Never a candidate, each with its reason in the output. All three are read from files, so a new
 * guard is excluded without editing this script:
 * - a test file named in a `test:` line of the Mechanical enforcement section of any ADR or business
 *   rule (`docs/adr/`, `docs/business-rules/`), parsed as scripts/docs-format.ts parses them;
 * - a test file matched by the `exclude` list in vitest.mutation.config.ts (the snapshot and guard
 *   tests, which a mutation run doesn't collect, so they rarely appear in a report at all);
 * - a characterization test: its full name (describe blocks and test name, as the report gives it)
 *   matches CHARACTERIZATION, that is it contains "characterization" (or "characterisation") or
 *   "pinned across", in any case. Name such a test that way, for example
 *   `describe('checkProse: output pinned across the guard removal (#246)', ...)`.
 *
 * The output holds test file paths, test names and counts, nothing from a test's source (BR-0001).
 *
 * Runs on Node 24 as plain TypeScript (type stripping, like scripts/mutation-ci.ts), so it imports
 * `node:` modules only, uses `import type` for types and has no enums.
 *
 *   node scripts/mutation-prune-report.ts [--report reports/mutation/mutation.json]
 *        [--out reports/mutation/prune-report.json] [--markdown reports/mutation/prune-report.md]
 *
 * It prints the totals in one line. Unit tests: src/mutation-prune-report.test.ts.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The characterization-name rule, matched against a test's full name. */
export const CHARACTERIZATION = /characteri[sz]ation|pinned across/i;

export const MUTATION_CONFIG = 'vitest.mutation.config.ts';

// ---------------------------------------------------------------------------
// Report

export interface PruneMutant {
  killedBy?: string[];
  coveredBy?: string[];
}

/** The parts of the mutation-testing-elements report this script reads. */
export interface PruneInputReport {
  files: Record<string, { mutants: PruneMutant[] }>;
  testFiles?: Record<string, { tests: { id: string; name: string }[] }>;
  config?: { disableBail?: boolean };
}

// ---------------------------------------------------------------------------
// Exclusions

export interface Exclusions {
  /** Test file to the ADRs and business rules that name it in a `test:` line, e.g. `ADR-0016`. */
  enforced: Map<string, string[]>;
  /** The `exclude` globs of vitest.mutation.config.ts. */
  mutationExcludes: string[];
}

/** The docs this script reads: the file names in a directory, and a file's text. */
export interface DocsReader {
  list(dir: string): string[];
  read(path: string): string;
}

/** The ADR and business-rule directories, and the prefix of their IDs. */
export const DOC_DIRS: Record<string, string> = { 'docs/adr': 'ADR', 'docs/business-rules': 'BR' };

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
/** An entry's file name: `NNNN-<slug>.md`, so README.md is skipped (scripts/docs-format.ts, STEM_PATTERN). */
const ENTRY_NAME = /^([0-9]{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
/** A `test:` tier line, list marker allowed, as scripts/docs-format.ts reads it. */
const TEST_LINE = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?test: (.*\S.*)$/;

/**
 * The `test:` lines of a doc's `## Mechanical enforcement` section, outside fenced code. A small copy of
 * scripts/docs-format.ts's parsing, so this script runs as plain TypeScript with `node:` imports only;
 * src/mutation-prune-report.test.ts checks the two agree on every doc in the repo.
 */
export function testLines(content: string): string[] {
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  let inSection = false;
  for (const text of content.split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence === null) {
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        fence = { char: m[1][0], length: m[1].length };
        continue;
      }
    } else {
      if (m && m[1][0] === fence.char && m[1].length >= fence.length && m[2].trim() === '') fence = null;
      continue;
    }
    if (/^##? /.test(text)) {
      inSection = text === '## Mechanical enforcement';
      continue;
    }
    const line = inSection ? TEST_LINE.exec(text.trimEnd()) : null;
    if (line) out.push(line[1].trim());
  }
  return out;
}

/** The test files each `test:` enforcement line names: every backticked span that is a test file path. */
export function enforcedTestFiles(docs: DocsReader): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [dir, prefix] of Object.entries(DOC_DIRS)) {
    for (const name of docs.list(dir).sort()) {
      const entry = ENTRY_NAME.exec(name);
      if (!entry) continue;
      const id = `${prefix}-${entry[1]}`;
      for (const reference of testLines(docs.read(`${dir}/${name}`))) {
        for (const [, span] of reference.matchAll(/`([^`]+)`/g)) {
          const path = span.trim();
          if (!TEST_FILE.test(path)) continue;
          const ids = result.get(path) ?? [];
          if (!ids.includes(id)) ids.push(id);
          result.set(path, ids);
        }
      }
    }
  }
  return result;
}

/** The string literals of the `exclude: [...]` array in vitest.mutation.config.ts. */
export function mutationExcludes(configText: string): string[] {
  const start = configText.search(/\bexclude:\s*\[/);
  if (start < 0) throw new Error(`${MUTATION_CONFIG} has no exclude: [...] list`);
  // Up to the `]` that closes the list, skipping comments and the strings themselves.
  const token = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'([^'\n]*)'|"([^"\n]*)"|(\])|[^'"/\]]+|\//g;
  token.lastIndex = configText.indexOf('[', start) + 1;
  const globs: string[] = [];
  for (let m = token.exec(configText); m !== null; m = token.exec(configText)) {
    if (m[3] !== undefined) return globs;
    const value = m[1] ?? m[2];
    if (value !== undefined) globs.push(value);
  }
  throw new Error(`${MUTATION_CONFIG}: the exclude list is not closed`);
}

/** A vitest-style glob as a regex over a repo-relative path: `**` spans directories, `*` doesn't. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        source += '(?:.*/)?';
      } else {
        source += '.*';
      }
    } else if (c === '*') {
      source += '[^/]*';
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** Why no test in a file is ever a candidate, or none. */
export function fileExclusionReasons(file: string, exclusions: Exclusions): string[] {
  const reasons: string[] = [];
  const docs = exclusions.enforced.get(file);
  if (docs) reasons.push(`named in a test: enforcement line of ${docs.join(', ')}`);
  const glob = exclusions.mutationExcludes.find(g => globToRegExp(g).test(file));
  if (glob !== undefined) reasons.push(`snapshot or guard test: ${MUTATION_CONFIG} excludes \`${glob}\``);
  return reasons;
}

export const CHARACTERIZATION_REASON = 'characterization test: its name matches the characterization rule';

// ---------------------------------------------------------------------------
// Counting

export interface TestRow {
  id: string;
  name: string;
  /** Mutants whose killedBy holds this test. */
  kills: number;
  /** Mutants whose killedBy holds this test alone. */
  soleKills: number;
  /** Mutants whose coveredBy holds this test. */
  covers: number;
  status: 'candidate' | 'sole-killer' | 'excluded';
  /** Why it is excluded; empty unless status is excluded. */
  reasons: string[];
}

export interface FileRow {
  file: string;
  /** Why the whole file is excluded; empty when it isn't. */
  reasons: string[];
  tests: TestRow[];
  candidates: number;
}

export interface PruneReport {
  disableBail: boolean;
  totals: {
    testFiles: number;
    tests: number;
    killedMutants: number;
    candidates: number;
    /** Candidates that kill no mutant at all. */
    killNothing: number;
    soleKillers: number;
    excluded: number;
  };
  files: FileRow[];
}

export function pruneReport(report: PruneInputReport, exclusions: Exclusions): PruneReport {
  const kills = new Map<string, number>();
  const sole = new Map<string, number>();
  const covers = new Map<string, number>();
  const bump = (map: Map<string, number>, id: string) => map.set(id, (map.get(id) ?? 0) + 1);
  let killedMutants = 0;
  for (const { mutants } of Object.values(report.files)) {
    for (const mutant of mutants) {
      const killers = [...new Set(mutant.killedBy ?? [])];
      if (killers.length > 0) killedMutants++;
      for (const id of killers) bump(kills, id);
      if (killers.length === 1) bump(sole, killers[0]);
      for (const id of new Set(mutant.coveredBy ?? [])) bump(covers, id);
    }
  }

  const files: FileRow[] = Object.entries(report.testFiles ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, { tests }]) => {
      const fileReasons = fileExclusionReasons(file, exclusions);
      const rows = tests.map((test): TestRow => {
        const reasons = [...fileReasons, ...(CHARACTERIZATION.test(test.name) ? [CHARACTERIZATION_REASON] : [])];
        const soleKills = sole.get(test.id) ?? 0;
        return {
          id: test.id,
          name: test.name,
          kills: kills.get(test.id) ?? 0,
          soleKills,
          covers: covers.get(test.id) ?? 0,
          status: reasons.length > 0 ? 'excluded' : soleKills > 0 ? 'sole-killer' : 'candidate',
          reasons,
        };
      });
      return { file, reasons: fileReasons, tests: rows, candidates: rows.filter(r => r.status === 'candidate').length };
    });

  const all = files.flatMap(f => f.tests);
  return {
    disableBail: report.config?.disableBail === true,
    totals: {
      testFiles: files.length,
      tests: all.length,
      killedMutants,
      candidates: all.filter(t => t.status === 'candidate').length,
      killNothing: all.filter(t => t.status === 'candidate' && t.kills === 0).length,
      soleKillers: all.filter(t => t.status === 'sole-killer').length,
      excluded: all.filter(t => t.status === 'excluded').length,
    },
    files,
  };
}

// ---------------------------------------------------------------------------
// Markdown

/** A test name as one table cell: no line breaks, pipes and backticks escaped. */
const cell = (text: string) => text.replace(/\s*\r?\n\s*/g, ' ').replace(/([|`\\])/g, '\\$1');

export function renderMarkdown(result: PruneReport): string {
  const t = result.totals;
  const out: string[] = ['## Mutation prune report', ''];
  if (!result.disableBail) {
    out.push(
      '**Not a `disableBail` run.** Stryker stopped at the first failing test, so each killed mutant names one killer and these counts overstate redundancy. Run `.github/workflows/mutation-prune.yml` for a report to prune from.',
      '',
    );
  }
  out.push(
    'A candidate is a test that is the sole killer of no mutant (ADR-0026). This report only lists: every removal is a human decision, in its own pruning PR.',
    '',
    '| | Tests |',
    '|---|---:|',
    `| Candidates | ${t.candidates} |`,
    `| Candidates that kill nothing | ${t.killNothing} |`,
    `| Sole killers | ${t.soleKillers} |`,
    `| Excluded | ${t.excluded} |`,
    `| All, in ${t.testFiles} test files | ${t.tests} |`,
    '',
    `${t.killedMutants} mutants were killed.`,
  );

  for (const f of result.files) {
    const candidates = f.tests.filter(r => r.status === 'candidate');
    if (candidates.length === 0) continue;
    out.push('', `### ${f.file}`, '', `${f.candidates} candidates of ${f.tests.length} tests.`, '', '| Test | Kills | Covers |', '|---|---:|---:|');
    for (const r of candidates) out.push(`| ${cell(r.name)} | ${r.kills} | ${r.covers} |`);
    const nothing = candidates.filter(r => r.kills === 0);
    if (nothing.length > 0) {
      out.push('', 'Kill nothing:');
      for (const r of nothing) out.push(`- ${cell(r.name)}${r.covers === 0 ? ' (covers no mutant)' : ''}`);
    }
  }

  // A file excluded by its path takes one row. A characterization test elsewhere takes its own.
  const excludedFiles = result.files.filter(f => f.reasons.length > 0);
  if (excludedFiles.length > 0) {
    out.push('', '### Excluded files', '', 'Never candidates, whatever they kill.', '', '| File | Tests | Reason |', '|---|---:|---|');
    for (const f of excludedFiles) out.push(`| ${f.file} | ${f.tests.length} | ${f.reasons.join('; ')} |`);
  }
  const characterization = result.files
    .filter(f => f.reasons.length === 0)
    .flatMap(f => f.tests.filter(r => r.status === 'excluded').map(r => ({ file: f.file, ...r })));
  if (characterization.length > 0) {
    out.push(
      '',
      '### Characterization tests',
      '',
      `Never candidates: the full name matches \`/${CHARACTERIZATION.source}/i\`.`,
      '',
      '| File | Test | Kills | Sole |',
      '|---|---|---:|---:|',
    );
    for (const r of characterization) out.push(`| ${r.file} | ${cell(r.name)} | ${r.kills} | ${r.soleKills} |`);
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// CLI

export function loadExclusions(root: string): Exclusions {
  return {
    enforced: enforcedTestFiles({
      list: dir => readdirSync(`${root}/${dir}`),
      read: path => readFileSync(`${root}/${path}`, 'utf8'),
    }),
    mutationExcludes: mutationExcludes(readFileSync(`${root}/${MUTATION_CONFIG}`, 'utf8')),
  };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const report = JSON.parse(readFileSync(flag(args, 'report') ?? 'reports/mutation/mutation.json', 'utf8')) as PruneInputReport;
  const result = pruneReport(report, loadExclusions('.'));
  const out = flag(args, 'out') ?? 'reports/mutation/prune-report.json';
  const markdownOut = flag(args, 'markdown') ?? 'reports/mutation/prune-report.md';
  write(out, JSON.stringify(result, null, 2) + '\n');
  write(markdownOut, renderMarkdown(result));
  const t = result.totals;
  console.log(`${t.candidates} candidates (${t.killNothing} kill nothing), ${t.soleKillers} sole killers, ${t.excluded} excluded, of ${t.tests} tests. Wrote ${markdownOut} and ${out}.`);
}
