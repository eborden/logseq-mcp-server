// The parity cases, grouped by the file they live in. Each group has its own expected-results file
// under scripts/parity/expected/, so a tool's re-record touches only its own JSON (#306). Case names
// are unique across every group (runParity refuses a duplicate).
import { join } from 'node:path';
import { buildContextCases } from './cases/build-context.js';
import { getBacklinksCases } from './cases/get-backlinks.js';
import { getBlockCases } from './cases/get-block.js';
import { getContextForQueryCases } from './cases/get-context-for-query.js';
import { getCurrentContextCases } from './cases/get-current-context.js';
import { getGraphInfoCases } from './cases/get-graph-info.js';
import { getPageCases } from './cases/get-page.js';
import { getPageOutlineCases } from './cases/get-page-outline.js';
import { listPagesCases } from './cases/list-pages.js';
import { queryByDateRangeCases } from './cases/query-by-date-range.js';
import { markdownCases } from './cases/markdown.js';
import { pageResourceCases } from './cases/page-resource.js';
import { queryByPropertyCases } from './cases/query-by-property.js';
import { resolveRefsCases } from './cases/resolve-refs.js';
import { searchBlocksCases } from './cases/search-blocks.js';
import type { ParityCase } from './harness.js';
import { REPO_ROOT } from './ts-server.js';

export interface CaseGroup {
  /** The stem of the cases file and of its expected file */
  name: string;
  cases: ParityCase[];
}

export const CASE_GROUPS: CaseGroup[] = [
  { name: 'build-context', cases: buildContextCases },
  { name: 'get-backlinks', cases: getBacklinksCases },
  { name: 'get-block', cases: getBlockCases },
  { name: 'get-context-for-query', cases: getContextForQueryCases },
  { name: 'get-current-context', cases: getCurrentContextCases },
  { name: 'get-graph-info', cases: getGraphInfoCases },
  { name: 'get-page', cases: getPageCases },
  { name: 'get-page-outline', cases: getPageOutlineCases },
  { name: 'list-pages', cases: listPagesCases },
  { name: 'query-by-date-range', cases: queryByDateRangeCases },
  { name: 'markdown', cases: markdownCases },
  { name: 'page-resource', cases: pageResourceCases },
  { name: 'query-by-property', cases: queryByPropertyCases },
  { name: 'resolve-refs', cases: resolveRefsCases },
  { name: 'search-blocks', cases: searchBlocksCases }
];

/** Where a group's results, recorded from the TypeScript server, are kept. */
export const expectedFileOf = (group: CaseGroup): string => join(REPO_ROOT, 'scripts', 'parity', 'expected', `${group.name}.json`);

/** Every case of every group. */
export const allCases = (groups: readonly CaseGroup[] = CASE_GROUPS): ParityCase[] => groups.flatMap(group => group.cases);
