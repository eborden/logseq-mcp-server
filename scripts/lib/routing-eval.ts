// The pure parts of the routing eval (#487): the question file, the tool-to-type map, reading a headless
// session's stream, and the aggregates. `scripts/routing-eval.ts` is the runner that spawns the sessions.
// Nothing here touches the network or a process, so tests/guards/routing-eval.test.ts can run all of it.

export const TOOL_TYPES = ['get', 'find', 'explore', 'check'] as const;
export type ToolType = (typeof TOOL_TYPES)[number];
export type Surface = 'v1' | 'v2';

/** The prefix Claude Code puts on a tool of the MCP server named `logseq` in the eval's own MCP config. */
export const MCP_TOOL_PREFIX = 'mcp__logseq__';

/** What a tool of the v1 surface (16 tools, ADR-0008) is, by the four types of #484. */
const V1_TOOL_TYPES: Record<string, ToolType> = {
  logseq_get_page: 'get',
  logseq_get_page_outline: 'get',
  logseq_get_block: 'get',
  logseq_get_current_context: 'get',
  logseq_get_graph_info: 'get',
  logseq_search_blocks: 'find',
  logseq_query_by_property: 'find',
  logseq_list_pages: 'find',
  logseq_search_by_relationship: 'find',
  logseq_build_context: 'explore',
  logseq_get_context_for_query: 'explore',
  logseq_get_backlinks: 'explore',
  logseq_get_concept_network: 'explore',
  logseq_get_concept_evolution: 'explore',
  logseq_query_by_date_range: 'explore',
  logseq_check_links: 'check',
};

/** The 10 tools of the v2 surface (#484). */
const V2_TOOL_TYPES: Record<string, ToolType> = {
  logseq_get_page: 'get',
  logseq_get_block: 'get',
  logseq_get_current: 'get',
  logseq_get_graph: 'get',
  logseq_find_pages: 'find',
  logseq_find_blocks: 'find',
  logseq_explore_context: 'explore',
  logseq_explore_network: 'explore',
  logseq_explore_timeline: 'explore',
  logseq_check_links: 'check',
};

export const SURFACE_TOOL_TYPES: Record<Surface, Record<string, ToolType>> = { v1: V1_TOOL_TYPES, v2: V2_TOOL_TYPES };

/** The type of a tool on either surface, or undefined for a name the eval doesn't know. */
export function toolType(tool: string): ToolType | undefined {
  return V1_TOOL_TYPES[tool] ?? V2_TOOL_TYPES[tool];
}

/**
 * The type of one call. Almost every tool is one type, but v1's `search_by_relationship` has a mode that is `explore`
 * work: `connected-within` finds how two pages connect (v2 moves it to `explore_network`), while its other modes find blocks.
 */
export function callType(tool: string, args: unknown): ToolType | undefined {
  if (tool === 'logseq_search_by_relationship' && isRecord(args) && args.relationship_type === 'connected-within') return 'explore';
  return toolType(tool);
}

/** A tool name without the MCP prefix, or undefined when the name is not one of the eval server's tools. */
export function logseqToolName(mcpName: string): string | undefined {
  return mcpName.startsWith(MCP_TOOL_PREFIX) ? mcpName.slice(MCP_TOOL_PREFIX.length) : undefined;
}

/**
 * Which surface a session saw, from the tool names its init event lists.
 * @throws Error when the list holds neither marker tool (a mix of v1 and v2 names, say), so the caller passes `--surface`
 */
export function detectSurface(tools: readonly string[]): Surface {
  if (tools.includes('logseq_search_blocks')) return 'v1';
  if (tools.includes('logseq_find_blocks')) return 'v2';
  throw new Error('Cannot tell the v1 surface from the v2 one: the server lists neither logseq_search_blocks nor logseq_find_blocks. Pass --surface v1 or --surface v2.');
}

export interface Question {
  id: string;
  /** What the question asks for, in words that name no tool (several questions share one) */
  intent: string;
  expected_type: ToolType;
  question: string;
  /** Tools that count as the right first call on the v1 surface */
  v1_tools: string[];
  /** Tools that count as the right first call on the v2 surface */
  v2_tools: string[];
  /**
   * Set on a question whose expected type is settled by ADR-0037's boundary test, not left to taste (#511). Such a
   * question never accepts a tool of another type, and says why in `ground_truth_reason`.
   */
  ground_truth?: true;
  ground_truth_reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string')) {
    throw new Error(`${where} must be a non-empty list of strings`);
  }
  return value as string[];
}

/**
 * Parse the question file at the boundary (foundations 4.2). Beyond the shape, it holds the file to its own rules:
 * unique ids, and every acceptable tool a tool of that surface whose type is the question's `expected_type` (or, for
 * `search_by_relationship`, whose `connected-within` mode is), so a tool-correct first call is always a type-correct one.
 * @throws Error naming the question and the rule it breaks
 */
export function parseQuestions(raw: unknown): Question[] {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.questions)) {
    throw new Error('The question file must be { "version": 1, "questions": [...] }');
  }
  const seen = new Set<string>();
  return raw.questions.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Question #${index + 1} is not an object`);
    const { id, intent, expected_type: expectedType, question } = entry;
    if (typeof id !== 'string' || id === '') throw new Error(`Question #${index + 1} has no id`);
    if (seen.has(id)) throw new Error(`Question id "${id}" is used twice`);
    seen.add(id);
    if (typeof intent !== 'string' || intent === '') throw new Error(`Question "${id}" has no intent`);
    if (typeof question !== 'string' || question.trim() === '') throw new Error(`Question "${id}" has no question text`);
    if (!TOOL_TYPES.includes(expectedType as ToolType)) throw new Error(`Question "${id}" has expected_type ${JSON.stringify(expectedType)}, not one of ${TOOL_TYPES.join(', ')}`);
    const v1 = stringList(entry.v1_tools, `Question "${id}" v1_tools`);
    const v2 = stringList(entry.v2_tools, `Question "${id}" v2_tools`);
    const groundTruth = entry.ground_truth;
    if (groundTruth !== undefined && groundTruth !== true) throw new Error(`Question "${id}" has ground_truth ${JSON.stringify(groundTruth)}; it is true or absent`);
    const reason = entry.ground_truth_reason;
    if (groundTruth === true && (typeof reason !== 'string' || reason.trim() === '')) throw new Error(`Question "${id}" is ground truth but gives no ground_truth_reason`);
    if (groundTruth === undefined && reason !== undefined) throw new Error(`Question "${id}" has a ground_truth_reason but is not marked ground_truth`);
    for (const [surface, tools] of [['v1', v1], ['v2', v2]] as const) {
      for (const tool of tools) {
        const type = SURFACE_TOOL_TYPES[surface][tool];
        if (type === undefined) throw new Error(`Question "${id}" lists ${tool}, which is not a ${surface} tool`);
        // search_by_relationship is typed by mode (callType), so a ground-truth question, whose accepted type is exactly one, can't list it
        const modeOk = tool === 'logseq_search_by_relationship' && expectedType === 'explore' && groundTruth !== true;
        if (type !== expectedType && !modeOk) throw new Error(`Question "${id}" lists ${tool} (${type}) but expects ${expectedType}`);
      }
    }
    return {
      id,
      intent,
      expected_type: expectedType as ToolType,
      question,
      v1_tools: v1,
      v2_tools: v2,
      ...(groundTruth === true ? { ground_truth: true as const, ground_truth_reason: reason as string } : {}),
    };
  });
}

/** One `logseq_*` call a session made. `arguments` is what the model sent, never what the server answered. */
export interface CallRecord {
  tool: string;
  arguments: unknown;
  /** The server answered with an error result */
  isError: boolean;
  /** The error was the server rejecting the arguments (a schema error), not a failed lookup */
  schemaError: boolean;
}

/** What the server says when it rejects arguments: `Invalid parameter '<name>': ...` (src/errors.rs). */
const SCHEMA_ERROR = /^\s*(Invalid parameter\b|InputValidationError\b|Invalid arguments\b)/;

export function isSchemaError(resultText: string): boolean {
  return SCHEMA_ERROR.test(resultText);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('\n');
}

/**
 * Reads one session's `--output-format stream-json` lines as they arrive. It keeps the tool names, the `logseq_*`
 * calls with their arguments, and whether each result was an error. It drops the result text at once: only whether
 * it was a schema error survives, so nothing a tool returned can reach the output.
 */
export class SessionTrace {
  model: string | undefined;
  toolNames: string[] = [];
  calls: CallRecord[] = [];
  costUsd: number | undefined;
  /** The session's own verdict from its `result` line */
  resultIsError: boolean | undefined;
  private readonly pending = new Map<string, CallRecord>();

  feed(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    if (event.type === 'system' && event.subtype === 'init') {
      if (typeof event.model === 'string') this.model = event.model;
      if (Array.isArray(event.tools)) {
        this.toolNames = [];
        for (const name of event.tools) {
          const tool = typeof name === 'string' ? logseqToolName(name) : undefined;
          if (tool !== undefined) this.toolNames.push(tool);
        }
      }
    } else if (event.type === 'assistant' && isRecord(event.message) && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (!isRecord(block) || block.type !== 'tool_use' || typeof block.name !== 'string' || typeof block.id !== 'string') continue;
        const tool = logseqToolName(block.name);
        if (tool === undefined) continue;
        const call: CallRecord = { tool, arguments: block.input ?? null, isError: false, schemaError: false };
        this.calls.push(call);
        this.pending.set(block.id, call);
      }
    } else if (event.type === 'user' && isRecord(event.message) && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const call = this.pending.get(block.tool_use_id);
        if (!call) continue;
        this.pending.delete(block.tool_use_id);
        call.isError = block.is_error === true;
        call.schemaError = call.isError && isSchemaError(textOf(block.content));
      }
    } else if (event.type === 'result') {
      if (typeof event.total_cost_usd === 'number') this.costUsd = event.total_cost_usd;
      if (typeof event.is_error === 'boolean') this.resultIsError = event.is_error;
    }
  }
}

/** How a session ended. `failed` is the host or the harness breaking, not the model's choice. */
export type SessionStatus = 'ok' | 'call-cap' | 'timeout' | 'failed';

export interface SessionRecord {
  questionId: string;
  run: number;
  status: SessionStatus;
  calls: CallRecord[];
  costUsd?: number;
}

export interface Rate {
  count: number;
  of: number;
}

export interface Aggregates {
  surface: Surface;
  /** Sessions that counted: every one that did not fail */
  sessions: number;
  failed: number;
  timedOut: number;
  capped: number;
  typeCorrect: Rate;
  toolCorrect: Rate;
  /** Sessions that made no `logseq_*` call at all (counted wrong in both rates above) */
  noCall: Rate;
  schemaErrors: { calls: number; sessions: number };
  errorResults: number;
  callsPerSession: { mean: number; max: number };
  byIntent: Array<{ intent: string; expected: ToolType; typeCorrect: Rate; toolCorrect: Rate; noCall: Rate }>;
  /** expected type -> type of the first call (`none` for no call) -> sessions */
  confusion: Record<string, Record<string, number>>;
  costUsd: { total: number; perSession: number } | undefined;
}

export function percent(rate: Rate): string {
  return rate.of === 0 ? 'n/a' : `${((100 * rate.count) / rate.of).toFixed(1)}%`;
}

const rate = (): Rate => ({ count: 0, of: 0 });

/** Roll sessions up against the questions. A session whose question is unknown is a harness bug and throws. */
export function aggregate(surface: Surface, questions: readonly Question[], records: readonly SessionRecord[]): Aggregates {
  const byId = new Map(questions.map(question => [question.id, question]));
  const counted = records.filter(record => record.status !== 'failed');
  const intents = new Map<string, { intent: string; expected: ToolType; typeCorrect: Rate; toolCorrect: Rate; noCall: Rate }>();
  const confusion: Record<string, Record<string, number>> = {};
  const total = { typeCorrect: rate(), toolCorrect: rate(), noCall: rate() };
  let schemaCalls = 0;
  let schemaSessions = 0;
  let errorResults = 0;
  let calls = 0;
  let maxCalls = 0;
  let cost = 0;
  let costed = 0;
  for (const record of counted) {
    const question = byId.get(record.questionId);
    if (!question) throw new Error(`A session ran question "${record.questionId}", which is not in the question file`);
    const first = record.calls[0];
    const firstType = first ? callType(first.tool, first.arguments) : undefined;
    const acceptable = surface === 'v1' ? question.v1_tools : question.v2_tools;
    const typeOk = firstType === question.expected_type;
    const toolOk = typeOk && first !== undefined && acceptable.includes(first.tool);
    const none = first === undefined;
    const entry =
      intents.get(question.intent) ??
      intents.set(question.intent, { intent: question.intent, expected: question.expected_type, typeCorrect: rate(), toolCorrect: rate(), noCall: rate() }).get(question.intent)!;
    for (const target of [total, entry]) {
      target.typeCorrect.of++;
      target.toolCorrect.of++;
      target.noCall.of++;
      if (typeOk) target.typeCorrect.count++;
      if (toolOk) target.toolCorrect.count++;
      if (none) target.noCall.count++;
    }
    const row = (confusion[question.expected_type] ??= {});
    const key = none ? 'none' : (firstType ?? 'unknown');
    row[key] = (row[key] ?? 0) + 1;
    const schema = record.calls.filter(call => call.schemaError).length;
    schemaCalls += schema;
    if (schema > 0) schemaSessions++;
    errorResults += record.calls.filter(call => call.isError).length;
    calls += record.calls.length;
    maxCalls = Math.max(maxCalls, record.calls.length);
    if (record.costUsd !== undefined) {
      cost += record.costUsd;
      costed++;
    }
  }
  return {
    surface,
    sessions: counted.length,
    failed: records.length - counted.length,
    timedOut: counted.filter(record => record.status === 'timeout').length,
    capped: counted.filter(record => record.status === 'call-cap').length,
    ...total,
    schemaErrors: { calls: schemaCalls, sessions: schemaSessions },
    errorResults,
    callsPerSession: { mean: counted.length === 0 ? 0 : calls / counted.length, max: maxCalls },
    byIntent: [...intents.values()],
    confusion,
    costUsd: costed === 0 ? undefined : { total: cost, perSession: cost / costed },
  };
}
