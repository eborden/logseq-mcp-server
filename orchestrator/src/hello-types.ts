// Shapes shared by the hello workflow, its activities and the client. Parsed at each boundary (foundations 4.2),
// so a bad input fails before any work. Workflow code imports these as types only (workflow code stays
// deterministic and sandboxed).

export interface HelloInput {
  readonly name: string;
  /** Absolute path of the file each activity appends one line to (its side effect). */
  readonly logFile: string;
  /** Unique per run. Part of every appended line, so an activity re-run after a crash can tell it already ran. */
  readonly runKey: string;
  /** How long the second activity pretends to work, in milliseconds. */
  readonly workMs: number;
}

export interface StepResult {
  readonly step: 'greet' | 'farewell';
  /** False when a retry found this step's line already in the file. */
  readonly appended: boolean;
}

export interface HelloResult {
  readonly runKey: string;
  readonly steps: readonly StepResult[];
}

export const MAX_WORK_MS = 600_000;
const RUN_KEY = /^[A-Za-z0-9-]{1,64}$/;
const NAME = /^[A-Za-z0-9 ._-]{1,100}$/;

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

/** Parses untrusted workflow input into a HelloInput, or throws InvalidInputError naming the first bad field. */
export function parseHelloInput(raw: unknown): HelloInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new InvalidInputError('input must be an object');
  }
  const { name, logFile, runKey, workMs } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new InvalidInputError('name must be 1 to 100 letters, digits, spaces, dots, dashes or underscores');
  }
  if (typeof logFile !== 'string' || !logFile.startsWith('/') || logFile.length > 1024) {
    throw new InvalidInputError('logFile must be an absolute path');
  }
  if (typeof runKey !== 'string' || !RUN_KEY.test(runKey)) {
    throw new InvalidInputError('runKey must be 1 to 64 letters, digits or dashes');
  }
  if (typeof workMs !== 'number' || !Number.isInteger(workMs) || workMs < 0 || workMs > MAX_WORK_MS) {
    throw new InvalidInputError(`workMs must be a whole number from 0 to ${MAX_WORK_MS}`);
  }
  return { name, logFile, runKey, workMs };
}
