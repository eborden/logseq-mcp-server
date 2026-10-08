// The parity cases, for the Node tooling that reuses one (the measure scripts). The cases and their golden results
// live in rust/tests/data/parity/*.json and nowhere else (#379): the cargo test (rust/tests/parity.rs) holds the server
// to them, and `PARITY_RECORD=1 cargo test --test parity_record -- --nocapture` records them. This file only reads them.
// It is not the contract's judge: `sameResult` and `sameCalls` tell a measure script that the server it timed did what
// the case says, so a number is never for a call that failed.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DATASCRIPT_QUERY, normalizeQuery, type CannedCall, type LogseqCall } from './stub-logseq.js';

/** The repository root. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where the cases, the recorded `tools/list` and the clock list are. */
export const PARITY_DATA_DIR = join(REPO_ROOT, 'rust', 'tests', 'data', 'parity');

/** A tool result as the client received it, minus the JSON-RPC framing. */
export type ToolResult = { content?: Array<Record<string, unknown>> } & Record<string, unknown>;

/** One tool call and the LogSeq traffic it should cause, with its golden result. Every value is made up (BR-0001). */
export interface ParityCase {
  name: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** Steps run in order; the calls of one step are the ones the recorded server made at once */
  steps: CannedCall[][];
  /** The golden result */
  expected: ToolResult;
}

/** The case with this name, from whichever group file holds it. */
export function loadParityCase(name: string): ParityCase {
  for (const file of readdirSync(PARITY_DATA_DIR).sort()) {
    if (!file.endsWith('.json') || file === 'tool-list.json' || file === 'clock-cases.json') continue;
    const group = JSON.parse(readFileSync(join(PARITY_DATA_DIR, file), 'utf8')) as { cases: ParityCase[] };
    const found = group.cases.find(c => c.name === name);
    if (found) return found;
  }
  throw new Error(`no parity case named ${JSON.stringify(name)} in ${PARITY_DATA_DIR}`);
}

/** Sort object keys at every depth, and read the JSON a content block's text holds, so only meaning is left. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => [key, key === 'text' && typeof v === 'string' ? canonicalText(v) : canonical(v)])
    );
  }
  return value;
}

function canonicalText(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? { json: canonical(parsed) } : text;
  } catch {
    return text;
  }
}

/** What differs between two results by meaning: a JSON text by deep equality, anything else exactly. Empty when the same. */
export function resultMismatches(expected: ToolResult, actual: ToolResult): string[] {
  return isDeepStrictEqual(canonical(expected), canonical(actual)) ? [] : ['the result differs from the golden one'];
}

/** A call in comparable form: the query text with its layout collapsed, the inputs as sent. */
const key = (call: LogseqCall): string =>
  JSON.stringify([call.method, call.method === DATASCRIPT_QUERY && typeof call.args[0] === 'string' ? [normalizeQuery(call.args[0]), ...call.args.slice(1)] : call.args]);

/**
 * What differs between the calls a case lists and the calls the server made: the same calls, in any order. Empty when
 * the same. (The parity test holds the order of a case's steps; a measure script only needs to know that the server
 * asked LogSeq what the case says.)
 */
export function callMismatches(steps: readonly CannedCall[][], actual: readonly LogseqCall[]): string[] {
  const want = steps.flat().map(key).sort();
  const got = actual.map(key).sort();
  return isDeepStrictEqual(want, got) ? [] : [`expected ${want.length} call(s), got ${got.length}, and they are not the same calls`];
}
