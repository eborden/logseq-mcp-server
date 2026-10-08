// Parity cases for the prompts (`prompts/list` and `prompts/get`, #46, #316, ADR-0025). A prompt makes no
// LogSeq call, so no case has a step: each is held to the text the TypeScript server printed for it (byte for
// byte), or to the JSON-RPC error it answered with. Every topic and date here is made up (BR-0001).
//
// The harness fixes the clock at Tuesday 2025-03-11 in America/New_York (PARITY_NOW_MS), so "this week" is
// the week of Monday 2025-03-10, in progress, and "this month" is March 2025, in progress.
//
// Not here: an argument that is not a string, or a request with no name. The TypeScript SDK checks those
// before a prompt sees the request and answers -32603 with the zod issues; the Rust server answers an
// InvalidParams error with its own words (#316).
import type { ParityCase } from '../harness.js';

const LIST = 'prompts/list';
const GET = 'prompts/get';

const get = (label: string, name: string, args?: Record<string, string>): ParityCase => ({
  name: `prompts: ${label}`,
  tool: GET,
  arguments: {},
  getPrompt: args === undefined ? { name } : { name, arguments: args },
  steps: []
});

const longText = (length: number): string => 'a'.repeat(length);

export const promptsCases: ParityCase[] = [
  { name: 'prompts: the list', tool: LIST, arguments: {}, listPrompts: true, steps: [] },

  // ---- weekly_summary
  get('weekly_summary with no arguments is the week in progress', 'weekly_summary'),
  get('weekly_summary with an empty argument object', 'weekly_summary', {}),
  get('weekly_summary for this week, in capitals', 'weekly_summary', { week: 'THIS' }),
  get('weekly_summary for last week', 'weekly_summary', { week: 'last' }),
  get('weekly_summary for a day in a past week, with hyphens', 'weekly_summary', { week: '2025-03-05' }),
  get('weekly_summary for a day in a past week, without', 'weekly_summary', { week: '20250305' }),
  get('weekly_summary for a day with one hyphen', 'weekly_summary', { week: '2025-0305' }),
  get('weekly_summary for a Sunday, which ends the week before it', 'weekly_summary', { week: '2025-03-09' }),
  get('weekly_summary for a Monday', 'weekly_summary', { week: '2025-03-03' }),
  get('weekly_summary for a Friday', 'weekly_summary', { week: '2025-03-07' }),
  get('weekly_summary for a later day of the week in progress', 'weekly_summary', { week: '2025-03-14' }),
  get('weekly_summary across a month end', 'weekly_summary', { week: '2025-01-31' }),
  get('weekly_summary across a year end', 'weekly_summary', { week: '2024-12-31' }),
  get('weekly_summary with a padded argument', 'weekly_summary', { week: '  last  ' }),
  get('weekly_summary with a blank argument is this week', 'weekly_summary', { week: '   ' }),
  get('weekly_summary for a week that has not started', 'weekly_summary', { week: '2025-03-17' }),
  get('weekly_summary for the Sunday of the week in progress', 'weekly_summary', { week: '2025-03-16' }),
  get('weekly_summary for a word that is not a week', 'weekly_summary', { week: 'tomorrow' }),
  get('weekly_summary for a day the calendar lacks', 'weekly_summary', { week: '2025-02-30' }),
  get('weekly_summary for a leap day', 'weekly_summary', { week: '2024-02-29' }),
  get('weekly_summary for a 29th of February in a common year', 'weekly_summary', { week: '2025-02-29' }),
  get('weekly_summary for a month of 13', 'weekly_summary', { week: '2025-13-01' }),
  get('weekly_summary for a day of 0', 'weekly_summary', { week: '2025-03-00' }),
  get('weekly_summary for a date with short parts', 'weekly_summary', { week: '2025-3-5' }),
  // A year below 100 is a real year (#299; the TypeScript server read it as 19xx, and rejected the week).
  get('weekly_summary for a year below 100', 'weekly_summary', { week: '0050-03-04' }),
  get('weekly_summary for a week whose Monday is in year 99', 'weekly_summary', { week: '0100-01-01' }),
  get('weekly_summary for the first Monday of year 0', 'weekly_summary', { week: '0000-01-03' }),
  get('weekly_summary for a three-digit year', 'weekly_summary', { week: '0500-03-04' }),
  // 0000-01-01 is a Saturday: its week starts and ends in year -1, which a YYYYMMDD day cannot hold, so it is the one
  // day 0000-01-01 (#299)
  get('weekly_summary for a week that starts before year 0', 'weekly_summary', { week: '0000-01-01' }),
  get('weekly_summary with a quoted word in the error', 'weekly_summary', { week: 'the "next" one' }),
  get('weekly_summary with an argument it does not have', 'weekly_summary', { weak: 'last' }),
  get('weekly_summary with its argument and one it does not have', 'weekly_summary', { week: 'last', topic: 'atlas' }),
  get('weekly_summary names every unknown argument in the order sent', 'weekly_summary', { zeta: '1', alpha: '2', mid: '3' }),

  // ---- monthly_summary
  get('monthly_summary with no arguments is the month in progress', 'monthly_summary'),
  get('monthly_summary for last month', 'monthly_summary', { month: 'last' }),
  get('monthly_summary for this month, in capitals', 'monthly_summary', { month: 'THIS' }),
  get('monthly_summary for a past month of 31 days', 'monthly_summary', { month: '2025-01' }),
  get('monthly_summary for a leap February', 'monthly_summary', { month: '2024-02' }),
  get('monthly_summary for a common February', 'monthly_summary', { month: '2025-02' }),
  get('monthly_summary for December', 'monthly_summary', { month: '2024-12' }),
  get('monthly_summary for the month in progress, by name', 'monthly_summary', { month: '2025-03' }),
  get('monthly_summary with a padded argument', 'monthly_summary', { month: ' 2024-11 ' }),
  get('monthly_summary with a blank argument is this month', 'monthly_summary', { month: '' }),
  get('monthly_summary for a month that has not started', 'monthly_summary', { month: '2025-04' }),
  get('monthly_summary for a month of next year', 'monthly_summary', { month: '2026-01' }),
  get('monthly_summary for a word that is not a month', 'monthly_summary', { month: 'march' }),
  get('monthly_summary for month 13', 'monthly_summary', { month: '2025-13' }),
  get('monthly_summary for month 0', 'monthly_summary', { month: '2025-00' }),
  get('monthly_summary for a month of one digit', 'monthly_summary', { month: '2025-3' }),
  get('monthly_summary for a day instead of a month', 'monthly_summary', { month: '2025-03-01' }),
  // A year below 100 is a real year, written with four digits (#299; the TypeScript server read it as 19xx, and cut a
  // three-digit year to "100-03-")
  get('monthly_summary for a year below 100', 'monthly_summary', { month: '0050-03' }),
  get('monthly_summary for a three-digit year', 'monthly_summary', { month: '0100-03' }),
  get('monthly_summary for year 0', 'monthly_summary', { month: '0000-02' }),
  get('monthly_summary with an argument it does not have', 'monthly_summary', { week: 'last' }),

  // ---- continue_on
  get('continue_on with a topic', 'continue_on', { topic: 'project atlas' }),
  get('continue_on quotes and escapes the topic', 'continue_on', { topic: 'say "hi" \\ there\nsecond line\ttab' }),
  get('continue_on with a topic in other scripts', 'continue_on', { topic: 'Café \u{1F680} 中文 <b>&' }),
  get('continue_on trims the topic', 'continue_on', { topic: '  \t padded topic \n ' }),
  get('continue_on with a topic that has template-like text', 'continue_on', { topic: '${week} {0} {{x}} [[Alice]]' }),
  get('continue_on with a topic of 200 characters', 'continue_on', { topic: longText(200) }),
  get('continue_on with a topic of 201 characters', 'continue_on', { topic: longText(201) }),
  get('continue_on counts 100 rockets as 200 characters', 'continue_on', { topic: '\u{1F680}'.repeat(100) }),
  get('continue_on counts 101 rockets as 202 characters', 'continue_on', { topic: '\u{1F680}'.repeat(101) }),
  get('continue_on counts the topic after trimming', 'continue_on', { topic: ` ${longText(200)} ` }),
  get('continue_on with no arguments', 'continue_on'),
  get('continue_on with an empty argument object', 'continue_on', {}),
  get('continue_on with a blank topic', 'continue_on', { topic: ' \t\n ' }),
  get('continue_on with an argument it does not have', 'continue_on', { topic: 'atlas', tpoic: 'x' }),
  get('continue_on with only an argument it does not have', 'continue_on', { tpoic: 'atlas' }),

  // ---- what_do_i_know
  get('what_do_i_know with a topic', 'what_do_i_know', { topic: 'Project Atlas' }),
  get('what_do_i_know with a question', 'what_do_i_know', { topic: 'what did Alice decide about the schema?' }),
  get('what_do_i_know with a topic of 201 characters', 'what_do_i_know', { topic: longText(201) }),
  get('what_do_i_know with no arguments', 'what_do_i_know'),
  get('what_do_i_know with a blank topic', 'what_do_i_know', { topic: '   ' }),
  get('what_do_i_know with an argument it does not have', 'what_do_i_know', { topic: 'atlas', focus: 'x' }),

  // ---- prioritize_tasks
  get('prioritize_tasks with no arguments', 'prioritize_tasks'),
  get('prioritize_tasks with a focus', 'prioritize_tasks', { focus: 'project atlas' }),
  get('prioritize_tasks quotes the focus', 'prioritize_tasks', { focus: ' the "big" one ' }),
  get('prioritize_tasks with a blank focus', 'prioritize_tasks', { focus: '  ' }),
  get('prioritize_tasks with a focus of 200 characters', 'prioritize_tasks', { focus: longText(200) }),
  get('prioritize_tasks with a focus of 201 characters', 'prioritize_tasks', { focus: longText(201) }),
  get('prioritize_tasks with an argument it does not have', 'prioritize_tasks', { topic: 'atlas' }),

  // `__proto__` is an argument like any other (#299; the TypeScript SDK's zod `record` parse dropped it, since assigning
  // a string to it is a no-op). `JSON.parse` makes it an own key, which an object literal would not, and
  // `JSON.stringify` sends it.
  get('continue_on rejects a __proto__ argument', 'continue_on', JSON.parse('{"topic":"atlas","__proto__":"x"}') as Record<string, string>),
  get('continue_on with only a __proto__ argument', 'continue_on', JSON.parse('{"__proto__":"x"}') as Record<string, string>),
  get('continue_on rejects a constructor argument and a __proto__ one', 'continue_on', JSON.parse('{"topic":"atlas","constructor":"z","__proto__":"y"}') as Record<string, string>),

  // ---- the name
  get('an unknown prompt', 'nope'),
  get('a prompt name in capitals', 'WEEKLY_SUMMARY'),
  get('an empty prompt name', '')
];
