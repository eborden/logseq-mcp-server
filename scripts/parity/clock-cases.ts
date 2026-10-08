// The parity cases that read today's date, for a server that can't be given a fixed one (#359).
//
// The harness fixes "now" for every server it starts (`LOGSEQ_MCP_NOW`, PARITY_NOW_MS), so a result that
// depends on today (`last_n`, a preset, a prompt for "this week") is the same on every day. The Rust
// server honours the variable in a debug build only (rust/src/env.rs): a release build reads the system
// clock, so the recorded results of these cases can't match it. `--real-clock` leaves them out, and the
// rest of the harness runs as it does for the debug build. The debug build in CI still runs every one.
//
// Update the list when a case that depends on the date is added. A name that no case has is an error, so
// a rename can't leave one here to match nothing. src/parity-harness.test.ts runs the TypeScript server at two
// other instants and fails unless exactly these cases change, so a case missing from the list, or listed
// without reading the date, fails there and not only in the release run on main.
import type { ParityCase } from './harness.js';

export const CLOCK_CASES: readonly string[] = [
  'date range: last_n: the newest first, one query for the span between them',
  'date range: last_n with full entities: the page holds only the attributes the query pulls',
  'date range: last_n with the outline',
  'date range: last_n fewer pages than asked',
  'date range: last_n with no journal page',
  'date range: preset today',
  'date range: preset yesterday',
  'date range: preset this_week',
  'date range: preset last_week',
  'date range: preset this_month',
  'date range: preset last_month',
  'date range: preset this_year',
  'date range: preset year_to_date',
  'date range: a preset with journals in it',
  'date range: last_n cut: the way on is older days',
  'date range: a null answer to the up-to query is not a graph with no journals',
  'prompts: weekly_summary with no arguments is the week in progress',
  'prompts: weekly_summary with an empty argument object',
  'prompts: weekly_summary for this week, in capitals',
  'prompts: weekly_summary for last week',
  'prompts: weekly_summary for a later day of the week in progress',
  'prompts: weekly_summary with a padded argument',
  'prompts: weekly_summary with a blank argument is this week',
  'prompts: weekly_summary for a week that has not started',
  'prompts: weekly_summary for the Sunday of the week in progress',
  'prompts: monthly_summary with no arguments is the month in progress',
  'prompts: monthly_summary for last month',
  'prompts: monthly_summary for this month, in capitals',
  'prompts: monthly_summary for the month in progress, by name',
  'prompts: monthly_summary with a blank argument is this month',
  'prompts: monthly_summary for a month that has not started',
  'prompts: monthly_summary for a month of next year'
];

/**
 * The cases without the ones that read today's date.
 * @throws Error naming a listed case that no case has
 */
export function withoutClockCases(cases: readonly ParityCase[], clockCases: readonly string[] = CLOCK_CASES): ParityCase[] {
  const present = new Set(cases.map(c => c.name));
  const missing = clockCases.filter(name => !present.has(name));
  if (missing.length > 0) throw new Error(`scripts/parity/clock-cases.ts names case(s) that don't exist: ${missing.join('; ')}`);
  const skip = new Set(clockCases);
  return cases.filter(c => !skip.has(c.name));
}
