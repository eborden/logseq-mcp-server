// The parity cases and their golden results as JSON, for the cargo test (#371, rust/tests/parity.rs).
//
// cargo-mutants scores a mutant by running `cargo test` in a copy of rust/ alone (ADR-0033, #364), so the
// parity cases have to be readable from there: the test can't reach scripts/parity. This writes each case
// group (its stub answers, its MCP request, its expected call steps) with the golden result recorded for it
// into rust/tests/data/parity/<group>.json, one case per line so a re-record is a reviewable diff, and copies the
// recorded tool list and the list of cases that read today's date beside them.
//
// The command is scripts/export-parity.ts (`--check` for the guard); this file builds the content.
//
// The golden files stay the contract and the only place a result is recorded (`--record-from-rust` writes them);
// these files are generated from them, never edited, and tests/guards/parity-export.test.ts keeps them in step.
// Synthetic data only (BR-0001): the cases are the existing stub data.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CASE_GROUPS, expectedFileOf } from './case-groups.js';
import { CLOCK_CASES } from './clock-cases.js';
import { REPO_ROOT } from './server-command.js';

/** Where the cargo test reads them from. */
export const EXPORT_DIR = join(REPO_ROOT, 'rust', 'tests', 'data', 'parity');

const TOOL_LIST_FILE = join(REPO_ROOT, 'scripts', 'parity', 'expected', 'tool-list.json');

/** Every file the export writes: its path relative to {@link EXPORT_DIR}, and its content. */
export function buildExport(): Map<string, string> {
  const files = new Map<string, string>();
  for (const group of CASE_GROUPS) {
    const expected = JSON.parse(readFileSync(expectedFileOf(group), 'utf8')) as Record<string, unknown>;
    const lines = group.cases.map(c => {
      if (!(c.name in expected)) throw new Error(`no golden result for the case ${JSON.stringify(c.name)}; record it with --record-from-rust`);
      // `perturbCases` checks `'perturbed' in c`, so an explicit `perturbed: undefined` serves an empty body as the last
      // answer in the Node self-check, while JSON drops the key and the cargo self-check would suffix the strings instead
      if ('perturbed' in c && c.perturbed === undefined) throw new Error(`the case ${JSON.stringify(c.name)} has perturbed: undefined; leave the key out`);
      // A JSON file can't hold `undefined`, which the stub would have served as an empty body
      for (const call of c.steps.flat()) {
        if (call.response === undefined) throw new Error(`the case ${JSON.stringify(c.name)} has a stub answer of undefined`);
      }
      return `  ${JSON.stringify({ ...c, expected: expected[c.name] })}`;
    });
    for (const name of Object.keys(expected)) {
      if (!group.cases.some(c => c.name === name)) throw new Error(`the golden file of ${group.name} has a result for ${JSON.stringify(name)}, which is not a case`);
    }
    files.set(`${group.name}.json`, `{"group":${JSON.stringify(group.name)},"cases":[\n${lines.join(',\n')}\n]}\n`);
  }
  // The same bytes as the golden file: a copy, so the cargo test reads one place
  files.set('tool-list.json', readFileSync(TOOL_LIST_FILE, 'utf8'));
  files.set('clock-cases.json', `${JSON.stringify(CLOCK_CASES, null, 2)}\n`);
  return files;
}

/** The export files in the folder that the export doesn't write. */
export function strayFiles(files: ReadonlyMap<string, string>): string[] {
  if (!existsSync(EXPORT_DIR)) return [];
  return readdirSync(EXPORT_DIR).filter(name => !files.has(name));
}
