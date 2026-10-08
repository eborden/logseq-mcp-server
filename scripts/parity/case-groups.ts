// The parity cases, grouped by the file they live in. Each group has its own expected-results file
// under scripts/parity/expected/, so a tool's re-record touches only its own JSON (#306). Case names
// are unique across every group (runParity refuses a duplicate).
import { join } from 'node:path';
import { getPageOutlineCases } from './cases/get-page-outline.js';
import type { ParityCase } from './harness.js';
import { REPO_ROOT } from './ts-server.js';

export interface CaseGroup {
  /** The stem of the cases file and of its expected file */
  name: string;
  cases: ParityCase[];
}

export const CASE_GROUPS: CaseGroup[] = [{ name: 'get-page-outline', cases: getPageOutlineCases }];

/** Where a group's results, recorded from the TypeScript server, are kept. */
export const expectedFileOf = (group: CaseGroup): string => join(REPO_ROOT, 'scripts', 'parity', 'expected', `${group.name}.json`);

/** Every case of every group. */
export const allCases = (groups: readonly CaseGroup[] = CASE_GROUPS): ParityCase[] => groups.flatMap(group => group.cases);
