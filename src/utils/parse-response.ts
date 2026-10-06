// zod 4's API, shipped inside the zod 3.25 package, as in src/utils/parse-args.ts.
import type { z } from 'zod/v4';
import type { LogseqClient } from '../client.js';
import { LogSeqResponseError } from '../errors.js';

/** The method the Datalog helper reports in a {@link LogSeqResponseError}. */
export const DATALOG_METHOD = 'logseq.DB.datascriptQuery';

/**
 * Check what LogSeq answered against `schema` and return it, or throw
 * {@link LogSeqResponseError} naming `method` and where the first mismatch is (#202).
 *
 * The answer comes back as it arrived, not as zod rebuilt it. zod's output reorders keys and
 * copies every object, and a tool's output has always carried LogSeq's own key order and spelling
 * (see `src/response-schemas.ts`), so `schema` must be a check without transforms or defaults:
 * what zod would return for it is then the response itself. The error names the path and the
 * expected type, never the value received, because a response is the user's graph (ADR-0004).
 *
 * @throws LogSeqResponseError when the response doesn't match `schema`
 */
export function parseResponse<S extends z.ZodType>(schema: S, response: unknown, method: string): z.output<S> {
  const result = schema.safeParse(response);
  if (result.success) {
    // `schema` has no transform or default, so its output is `response` itself
    return response as z.output<S>;
  }
  const issue = result.error.issues[0];
  throw new LogSeqResponseError(method, pathOf(issue.path), issue.message);
}

/** `[0].id` for a path of `0, 'id'`, or `(response)` for the top level. */
function pathOf(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return '(response)';
  return path.map(part => (typeof part === 'number' ? `[${part}]` : `.${String(part)}`)).join('').replace(/^\./, '');
}

/**
 * `client.callAPI`, with the answer checked against `schema` (see {@link parseResponse}).
 * Call arguments reach the client exactly as given: with no `args`, `callAPI` gets none.
 * Infrastructure errors (not running, timeout, auth) propagate from the client untouched.
 */
export async function callParsed<S extends z.ZodType>(
  client: LogseqClient,
  schema: S,
  method: string,
  args?: unknown[]
): Promise<z.output<S>> {
  const response: unknown = args === undefined ? await client.callAPI(method) : await client.callAPI(method, args);
  return parseResponse(schema, response, method);
}

/**
 * `client.executeDatalogQuery`, with the rows checked against `schema` (see {@link parseResponse}).
 * `inputs` are passed raw, as `executeDatalogQuery` takes them (it EDN-encodes them).
 */
export async function queryParsed<S extends z.ZodType>(
  client: LogseqClient,
  schema: S,
  query: string,
  ...inputs: unknown[]
): Promise<z.output<S>> {
  const rows: unknown = await client.executeDatalogQuery(query, ...inputs);
  return parseResponse(schema, rows, DATALOG_METHOD);
}
