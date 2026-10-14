// The file `scripts/routing-eval.ts --out` writes and `--rescore` reads (#487), parsed at the boundary (foundations 4.2).
// A rescore exists to compare scoring or acceptable-tool lists on the same sessions, so the file carries two hashes of
// the question file and a rescore says what changed instead of passing quietly.
import { createHash } from 'node:crypto';
import type { CallRecord, Question, SessionRecord, SessionStatus, Surface } from './routing-eval.js';

export const SAVED_RUN_VERSION = 2;

const STATUSES: readonly SessionStatus[] = ['ok', 'call-cap', 'timeout', 'failed'];

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const byId = (questions: readonly Question[]): Question[] => [...questions].sort((a, b) => a.id.localeCompare(b.id));

/** What the sessions were asked: the ids and the question texts. A different one means the saved sessions answer other questions. */
export function textHash(questions: readonly Question[]): string {
  return sha256(byId(questions).map(question => [question.id, question.question]));
}

/** What scores a session: the intent, the expected type and both acceptable lists. A different one means a loosened or tightened score. */
export function scoringHash(questions: readonly Question[]): string {
  return sha256(byId(questions).map(question => [question.id, question.intent, question.expected_type, question.v1_tools, question.v2_tools]));
}

export interface SavedRun {
  surface: Surface;
  models: string[];
  textHash: string;
  scoringHash: string;
  /** Hash of the SKILL.md body the run was given (`--skill`); absent for a run with no skill and for files written before it was recorded */
  skillHash?: string;
  /** Sessions the run set out to make */
  planned: number;
  /** The run stopped before it made them all (the total spend cap) */
  stoppedEarly: boolean;
  sessions: SessionRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(where: string, what: string): never {
  throw new Error(`The --out file is not one routing-eval wrote: ${where} ${what}`);
}

function parseCall(raw: unknown, where: string): CallRecord {
  if (!isRecord(raw)) fail(where, 'is not an object');
  if (typeof raw.tool !== 'string') fail(where, 'has no tool name');
  if (typeof raw.isError !== 'boolean' || typeof raw.schemaError !== 'boolean') fail(where, 'has no isError and schemaError');
  return { tool: raw.tool, arguments: raw.arguments ?? null, isError: raw.isError, schemaError: raw.schemaError };
}

function parseSession(raw: unknown, index: number): SessionRecord {
  const where = `session #${index + 1}`;
  if (!isRecord(raw)) fail(where, 'is not an object');
  if (typeof raw.questionId !== 'string' || raw.questionId === '') fail(where, 'has no questionId');
  if (typeof raw.run !== 'number' || !Number.isInteger(raw.run) || raw.run < 1) fail(where, 'has no run number');
  if (!STATUSES.includes(raw.status as SessionStatus)) fail(where, `has status ${JSON.stringify(raw.status)}`);
  if (!Array.isArray(raw.calls)) fail(where, 'has no calls list');
  if (raw.costUsd !== undefined && (typeof raw.costUsd !== 'number' || !Number.isFinite(raw.costUsd))) fail(where, 'has a cost that is not a number');
  return {
    questionId: raw.questionId,
    run: raw.run,
    status: raw.status as SessionStatus,
    calls: raw.calls.map((call, i) => parseCall(call, `${where} call #${i + 1}`)),
    ...(raw.costUsd !== undefined ? { costUsd: raw.costUsd } : {}),
  };
}

/** @throws Error naming the first thing in the file that is not what `--out` writes */
export function parseSavedRun(raw: unknown): SavedRun {
  if (!isRecord(raw)) fail('the file', 'is not an object');
  if (raw.version !== SAVED_RUN_VERSION) fail('version', `is ${JSON.stringify(raw.version)}, not ${SAVED_RUN_VERSION} (rescore needs a file written by this version of the script)`);
  if (raw.surface !== 'v1' && raw.surface !== 'v2') fail('surface', 'is not v1 or v2');
  if (!Array.isArray(raw.models) || raw.models.some(model => typeof model !== 'string')) fail('models', 'is not a list of strings');
  if (typeof raw.textHash !== 'string' || typeof raw.scoringHash !== 'string') fail('the question hashes', 'are missing');
  if (raw.skillHash !== undefined && typeof raw.skillHash !== 'string') fail('skillHash', 'is not a string');
  if (typeof raw.planned !== 'number' || !Number.isInteger(raw.planned) || raw.planned < 0) fail('planned', 'is not a count');
  if (typeof raw.stoppedEarly !== 'boolean') fail('stoppedEarly', 'is not a boolean');
  if (!Array.isArray(raw.sessions)) fail('sessions', 'is not a list');
  return {
    surface: raw.surface,
    models: raw.models as string[],
    textHash: raw.textHash,
    scoringHash: raw.scoringHash,
    ...(raw.skillHash !== undefined ? { skillHash: raw.skillHash } : {}),
    planned: raw.planned,
    stoppedEarly: raw.stoppedEarly,
    sessions: raw.sessions.map(parseSession),
  };
}

export interface Reconciliation {
  /** Sessions to score: all of them, or only the selected questions' when `only` was given */
  sessions: SessionRecord[];
  /** Questions in the current file with no saved session (within the selection) */
  unanswered: string[];
  /** The scoring hash differs: the lists or expected types changed since the run, which is what a rescore is for */
  scoringChanged: boolean;
}

/**
 * Line a saved run up with the current question file.
 * @throws Error when the questions the sessions answered changed, or a session names a question the file no longer has
 *   (unless `selected` is given, which narrows both sides on purpose)
 */
export function reconcile(saved: SavedRun, questions: readonly Question[], all: readonly Question[], selected: boolean): Reconciliation {
  if (saved.textHash !== textHash(all)) {
    throw new Error('The question texts or ids changed since this run, so its sessions answered other questions. Rescore against the file the run used.');
  }
  const known = new Set(questions.map(question => question.id));
  const strays = saved.sessions.filter(session => !known.has(session.questionId));
  if (strays.length > 0 && !selected) {
    throw new Error(`The saved run has sessions for questions the file no longer has: ${[...new Set(strays.map(session => session.questionId))].join(', ')}`);
  }
  const sessions = saved.sessions.filter(session => known.has(session.questionId));
  const answered = new Set(sessions.map(session => session.questionId));
  return {
    sessions,
    unanswered: questions.filter(question => !answered.has(question.id)).map(question => question.id),
    scoringChanged: saved.scoringHash !== scoringHash(all),
  };
}
