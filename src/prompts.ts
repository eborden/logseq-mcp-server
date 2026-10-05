import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { GetPromptResult, Prompt } from '@modelcontextprotocol/sdk/types.js';
import { formatLogseqDate } from './utils/date-utils.js';

/**
 * MCP prompts (#46): reusable starting messages a host shows as slash commands or
 * menu entries. Each one returns a short user message that tells the model which
 * tools to call, in what order, and what to hand back. The server stays read-only:
 * a prompt never calls LogSeq itself and never asks the model to write to the graph
 * through these tools.
 *
 * The long-form guidance lives in `skills/logseq-skills/`. These prompts carry only
 * the steps and the hard limits, and say to follow the skill when the host has it,
 * so the two don't drift into two copies of the same text.
 *
 * Arguments are validated here (strings only, as MCP prompt arguments always are) and
 * a bad one is an `InvalidParams` error. Dates come from the clock passed in as `now`,
 * never read inside a builder, so tests don't depend on today's date.
 */

/** Longest topic accepted. A topic is a page name or a short phrase, not a paragraph. */
export const MAX_TOPIC_LENGTH = 200;

interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: NonNullable<Prompt['arguments']>;
  build(args: Record<string, string>, now: Date): string;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function invalid(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, message);
}

/** Reject arguments the prompt does not declare, so a typo is not silently ignored. */
function rejectUnknownArguments(def: PromptDefinition, args: Record<string, string>): void {
  const known = new Set(def.arguments.map(a => a.name));
  const unknown = Object.keys(args).filter(k => !known.has(k));
  if (unknown.length > 0) {
    invalid(
      `Prompt ${JSON.stringify(def.name)} has no argument ${unknown.map(k => JSON.stringify(k)).join(', ')}. ` +
      `Arguments: ${[...known].join(', ') || '(none)'}.`
    );
  }
}

function requiredText(promptName: string, args: Record<string, string>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.trim() === '') {
    invalid(`Prompt ${JSON.stringify(promptName)} needs a non-empty "${name}" argument.`);
  }
  const text = value.trim();
  if (text.length > MAX_TOPIC_LENGTH) {
    invalid(`"${name}" is ${text.length} characters; the limit is ${MAX_TOPIC_LENGTH}. Use a page name or a short phrase.`);
  }
  return text;
}

function optionalText(args: Record<string, string>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value.trim() === '') return undefined;
  const text = value.trim();
  if (text.length > MAX_TOPIC_LENGTH) {
    invalid(`"${name}" is ${text.length} characters; the limit is ${MAX_TOPIC_LENGTH}.`);
  }
  return text;
}

/** A real calendar day from `YYYY-MM-DD` or `YYYYMMDD`, or null. */
function parseDay(text: string): Date | null {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  const real = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  return real ? date : null;
}

const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const shiftDays = (d: Date, delta: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Monday of the ISO week containing `d`. */
const mondayOf = (d: Date): Date => shiftDays(d, -((d.getDay() + 6) % 7));

interface WeekRange {
  monday: string;
  /** Last journal day to fetch (YYYYMMDD): Friday, or today for a week still in progress */
  start: number;
  end: number;
  endIso: string;
  /** True when today falls before Friday, so the summary covers a partial week */
  partial: boolean;
}

/**
 * Work weeks run Monday to Friday. `week` is `this` (default), `last`, or any day in
 * the week as `YYYY-MM-DD` / `YYYYMMDD`. A week still under way ends today.
 */
export function resolveWeek(week: string | undefined, now: Date): WeekRange {
  const today = startOfDay(now);
  const spec = (week ?? 'this').toLowerCase();
  let anchor: Date;
  if (spec === 'this') anchor = today;
  else if (spec === 'last') anchor = shiftDays(today, -7);
  else {
    const day = parseDay(spec);
    if (!day) invalid(`"week" must be "this", "last", or a date as YYYY-MM-DD or YYYYMMDD (any day in the week); got ${JSON.stringify(week)}.`);
    anchor = day;
  }
  const monday = mondayOf(anchor);
  if (monday.getTime() > today.getTime()) {
    invalid(`The week of ${iso(monday)} has not started yet. Use "this", "last", or a date in a past or current week.`);
  }
  const friday = shiftDays(monday, 4);
  const end = friday.getTime() > today.getTime() ? today : friday;
  return {
    monday: iso(monday),
    start: formatLogseqDate(monday),
    end: formatLogseqDate(end),
    endIso: iso(end),
    partial: end.getTime() < friday.getTime(),
  };
}

interface MonthRange {
  month: string;
  start: number;
  end: number;
  endIso: string;
  partial: boolean;
}

/** `month` is `this` (default), `last`, or `YYYY-MM`. A month still under way ends today. */
export function resolveMonth(month: string | undefined, now: Date): MonthRange {
  const today = startOfDay(now);
  const spec = (month ?? 'this').toLowerCase();
  let first: Date;
  if (spec === 'this') first = new Date(today.getFullYear(), today.getMonth(), 1);
  else if (spec === 'last') first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  else {
    const match = /^(\d{4})-(\d{2})$/.exec(spec);
    const m = match ? Number(match[2]) : 0;
    if (!match || m < 1 || m > 12) {
      invalid(`"month" must be "this", "last", or YYYY-MM; got ${JSON.stringify(month)}.`);
    }
    first = new Date(Number(match[1]), m - 1, 1);
  }
  if (first.getTime() > today.getTime()) {
    invalid(`${iso(first).slice(0, 7)} has not started yet. Use "this", "last", or a past or current month.`);
  }
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const end = last.getTime() > today.getTime() ? today : last;
  return {
    month: iso(first).slice(0, 7),
    start: formatLogseqDate(first),
    end: formatLogseqDate(end),
    endIso: iso(end),
    partial: end.getTime() < last.getTime(),
  };
}

// ---------------------------------------------------------------------------
// Prompt text
// ---------------------------------------------------------------------------

const READ_ONLY_NOTE =
  'The logseq_* tools only read. Show the result here; write it into the graph only if I ask and you have file access.';

/** Summary limits shared by both granularities. Full rules: references/summary-compression.md in logseq-skills. */
function summaryRules(budget: { words: string; total: number; items: string }): string {
  return [
    'Rules (hard limits):',
    `- Signals: ${budget.items} items, ${budget.words} words each, one sentence, ${budget.total} words in total, no em-dashes.`,
    '- Each signal is the thing plus the number or the stake, then stop. Cut explanations.',
    '- Keep what cannot be rebuilt from other systems (how a person works, a boundary, a judgment call) before ticket counts or figures.',
    '- Merge related items before dropping any. Use a flat list with no theme headers.',
    '- Mark sparingly with **Win:**, **Frustration:**, **Unusual:** or **Milestone:**. Leave routine items unmarked.',
    '- [[Link]] only significant people and topics. Open items are ((block-uuid)) refs, never pasted text, and only if still open.',
    '- Output: a "tags::" line, a 2-sentence gist, then "## Signals", "## Unresolved" and "## Personal" (all three, even if empty), indented with tabs.',
  ].join('\n');
}

const SKILL_NOTE = (skill: string): string =>
  `If the logseq-skills skill is available, follow its ${skill} workflow instead of the steps below.`;

const topic = (t: string): string => JSON.stringify(t);

const PROMPT_DEFINITIONS: PromptDefinition[] = [
  {
    name: 'weekly_summary',
    title: 'Weekly summary',
    description: 'Summarize a Monday-to-Friday week of journal entries into a few short signals. Defaults to this week.',
    arguments: [
      {
        name: 'week',
        description: '"this" (default), "last", or any date in the week as YYYY-MM-DD or YYYYMMDD',
        required: false,
      },
    ],
    build(args, now) {
      const w = resolveWeek(optionalText(args, 'week'), now);
      return [
        `Write a weekly summary of my LogSeq journal for the work week starting Monday ${w.monday}, through ${w.endIso}.` +
          (w.partial ? ' The week is not over: say so in the gist.' : ''),
        SKILL_NOTE('weekly-summary'),
        '',
        'Steps:',
        `1. logseq_query_by_date_range with start_date ${w.start}, end_date ${w.end} and slim_results true. If the result has summary.topConcepts, use it to pick the threads to read closely.`,
        '2. For trend context, logseq_list_pages with name_contains "Weekly", then logseq_get_page (include_children true) on the 2 or 3 most recent. Read them for trends only, not for style.',
        '3. Find what is still open: look for TODO, DOING and NOW blocks in the week (and any closed since) with logseq_search_blocks. Report only items still open.',
        '4. Write the summary.',
        '',
        summaryRules({ words: '10-15', total: 150, items: 'at most 12' }),
        '',
        `Name it "Weekly ${w.monday}", tag it [[Weekly Summary]] and link the journal days that had content. ${READ_ONLY_NOTE}`,
      ].join('\n');
    },
  },
  {
    name: 'monthly_summary',
    title: 'Monthly summary',
    description: 'Summarize a month from its weekly summary pages, stating the trajectory of each thread. Defaults to this month.',
    arguments: [
      {
        name: 'month',
        description: '"this" (default), "last", or YYYY-MM',
        required: false,
      },
    ],
    build(args, now) {
      const m = resolveMonth(optionalText(args, 'month'), now);
      return [
        `Write a monthly summary of my LogSeq notes for ${m.month}, through ${m.endIso}.` +
          (m.partial ? ' The month is not over: say so in the gist.' : ''),
        SKILL_NOTE('monthly-summary'),
        '',
        'A monthly summary diffs weeks against earlier months. Listing what happened is the failure mode.',
        '',
        'Steps:',
        `1. logseq_list_pages with name_contains "Weekly ${m.month}", then logseq_get_page (include_children true) on each. If a week is missing, say so; do not invent it.`,
        '2. logseq_list_pages with name_contains "Monthly", then logseq_get_page on the 1 or 2 most recent, for trajectory context only.',
        `3. Spot-check the busiest days in the raw journal: logseq_query_by_date_range with start_date ${m.start}, end_date ${m.end}, include_content false and top_concepts_limit 20 for the shape, then slim_results true on a narrow range for any day a weekly flagged.`,
        '4. For each candidate signal, state its trajectory against earlier months in the text: escalating, improving, unchanged, resolved or new. A candidate with no trajectory gets merged or dropped.',
        '5. Verify open items against the journal, past the end of the month, before listing any as unresolved.',
        '',
        summaryRules({ words: '12-18', total: 200, items: 'at most 12' }),
        '',
        `Name it "Monthly ${m.month}", tag it [[Monthly Summary]] and link each [[Weekly YYYY-MM-DD]] page that had content. ${READ_ONLY_NOTE}`,
      ].join('\n');
    },
  },
  {
    name: 'continue_on',
    title: 'Continue on a topic',
    description: 'Pick up where I left off on a topic: current state, latest activity, open tasks and a suggested next step.',
    arguments: [{ name: 'topic', description: 'Page name or short phrase, e.g. "project atlas"', required: true }],
    build(args) {
      const t = topic(requiredText('continue_on', args, 'topic'));
      return [
        `Help me continue where I left off on ${t} in my LogSeq graph.`,
        '',
        'Steps:',
        `1. logseq_build_context with topic_name ${t} (include_temporal_context true). If no page matches, try logseq_list_pages with name_contains, or logseq_search_blocks for the words.`,
        `2. logseq_search_blocks for ${t}, limit 10, to catch recent mentions in journals that the page itself lacks. Results are newest first.`,
        '3. Note any TODO or DOING blocks that mention it, and how old they are.',
        '',
        'Then answer in under 200 words: where things stand, what changed most recently (with dates), what is still open, and the one or two obvious next steps. Cite page names. If a call returns hasMore or warnings, say what may be missing.',
        READ_ONLY_NOTE,
      ].join('\n');
    },
  },
  {
    name: 'what_do_i_know',
    title: 'What do I know about...',
    description: 'Research a topic across the graph: notes, connections and gaps, with sources.',
    arguments: [{ name: 'topic', description: 'Topic, page name or question', required: true }],
    build(args) {
      const t = topic(requiredText('what_do_i_know', args, 'topic'));
      return [
        `What do I know about ${t}? Research my LogSeq graph.`,
        SKILL_NOTE('research assistant'),
        '',
        'Steps:',
        `1. logseq_build_context with topic_name ${t} for the page, its blocks, related pages and references. If it reads as a question rather than a name, use logseq_get_context_for_query instead.`,
        `2. logseq_search_blocks for ${t} (limit 15) for mentions outside the main page. Search is literal, so try one or two spelling variants if it comes back thin.`,
        '3. logseq_get_backlinks on the one or two most relevant pages to find connections.',
        '',
        'Then synthesize, do not dump: the main points, how the notes connect, and gaps. Name the pages each point came from. Say if a result was cut (hasMore, warnings).',
        READ_ONLY_NOTE,
      ].join('\n');
    },
  },
  {
    name: 'prioritize_tasks',
    title: 'What should I work on',
    description: 'Find open TODO and DOING tasks, spot stale ones and suggest what to do next.',
    arguments: [{ name: 'focus', description: 'Optional topic or project to narrow the tasks to', required: false }],
    build(args) {
      const focus = optionalText(args, 'focus');
      const scope = focus ? ` Only tasks related to ${topic(focus)}.` : '';
      return [
        `What should I work on? Find my open tasks in LogSeq and recommend an order.${scope}`,
        SKILL_NOTE('task prioritization'),
        '',
        'Steps:',
        '1. logseq_search_blocks for "TODO" and for "DOING" (limit 20 each).',
        '2. logseq_query_by_property with property_key "priority" and property_value "high", and again with property_key "status" and property_value "doing".',
        focus ? `3. Keep only the tasks tied to ${topic(focus)} (check with logseq_build_context if a task is unclear).` : '3. Check unclear tasks with logseq_build_context before ranking them.',
        '',
        'Then give a short ranked list: what is in progress, what is high priority, what looks stale (no activity in weeks) and could be dropped or revisited. Cite the page for each. Say if a result was cut.',
        READ_ONLY_NOTE,
      ].join('\n');
    },
  },
];

const PROMPT_BY_NAME = new Map(PROMPT_DEFINITIONS.map(def => [def.name, def]));

/** What `prompts/list` returns. */
export function listPrompts(): Prompt[] {
  return PROMPT_DEFINITIONS.map(({ name, title, description, arguments: args }) => ({
    name,
    title,
    description,
    arguments: args,
  }));
}

/**
 * What `prompts/get` returns. Throws `McpError(InvalidParams)` for an unknown prompt,
 * an unknown or missing argument, or a value that doesn't parse.
 */
export function getPrompt(name: string, args: Record<string, string> = {}, now: Date = new Date()): GetPromptResult {
  const def = PROMPT_BY_NAME.get(name);
  if (!def) {
    invalid(`Unknown prompt ${JSON.stringify(name)}. Available: ${PROMPT_DEFINITIONS.map(d => d.name).join(', ')}.`);
  }
  rejectUnknownArguments(def, args);
  return {
    description: def.description,
    messages: [{ role: 'user', content: { type: 'text', text: def.build(args, now) } }],
  };
}

/** Wire `prompts/list` and `prompts/get` onto the server. The server must declare the `prompts` capability. */
export function registerPrompts(server: Server, clock: () => Date = () => new Date()): void {
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: listPrompts() }));
  server.setRequestHandler(GetPromptRequestSchema, async request =>
    getPrompt(request.params.name, request.params.arguments ?? {}, clock())
  );
}
