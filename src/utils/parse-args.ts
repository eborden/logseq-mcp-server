// zod 4's API, shipped inside the zod 3.25 package. The MCP SDK's own zod 3
// schemas never meet these: the low-level Server takes plain JSON inputSchema.
import { z } from 'zod/v4';
import { InvalidParameterError } from '../errors.js';

/**
 * Tool arguments parsed at the MCP boundary (#60, foundations 4.2).
 *
 * Each converted tool has one zod object schema. It is both the parser for the
 * tool's arguments and the source of the `inputSchema` advertised in tools/list,
 * so the two cannot drift apart.
 *
 * Rules:
 * - Tolerant reader: unknown fields are ignored (zod's default strip), never rejected.
 * - No coercion: `"5"` is not `5`, `"true"` is not `true`, NaN is not a number.
 * - `null` means absent, as `resolveParamAliases` and `parseFormat` already treat it.
 *   A required field sent as `null` is reported as missing.
 * - Defaults are the ones the handlers always applied. A schema-level `.default()`
 *   is also advertised as `default` in the JSON Schema.
 */

/** The JSON Schema shape the MCP SDK expects for a tool's `inputSchema`. */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * The `inputSchema` for a tool, generated from its argument schema with zod's
 * own `z.toJSONSchema`. `io: 'input'` describes what a caller may send, so a
 * field with a default is optional and keeps its `default`.
 *
 * No `additionalProperties`: the parser ignores unknown fields, and advertising
 * `false` would make validating clients reject the unadvertised aliases (`name`,
 * `page`, `uuid`) that `resolveParamAliases` folds. `$schema` is dropped too;
 * tools/list never carried it.
 */
export function toInputSchema(schema: z.ZodObject): ToolInputSchema {
  const { $schema: _dropped, ...rest } = z.toJSONSchema(schema, { io: 'input' });
  if (rest.type !== 'object' || rest.properties === undefined || 'additionalProperties' in rest) {
    throw new Error('toInputSchema needs a zod object schema that ignores unknown fields');
  }
  return { ...rest, type: 'object', properties: rest.properties };
}

/**
 * Parse a tool's arguments (after `resolveParamAliases`) into typed values, or
 * throw `InvalidParameterError` naming the first bad parameter.
 */
export function parseArgs<S extends z.ZodObject>(
  schema: S,
  args: Record<string, unknown> | undefined
): z.output<S> {
  const present = withoutNulls(args ?? {});
  const result = schema.safeParse(present, { error: expectedMessage });
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const param = issue.path.length > 0 ? issue.path.map(String).join('.') : '(arguments)';
  const value = issue.path.length > 0 ? present[String(issue.path[0])] : present;
  throw new InvalidParameterError(
    param,
    value === undefined ? 'missing' : showValue(value),
    issue.message,
    exampleFor(param, issue)
  );
}

function withoutNulls(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null));
}

/** JSON for the error text, except numbers JSON can't show (NaN, Infinity). */
function showValue(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return JSON.stringify(value) ?? String(value);
}

/** What a value is, in the words of the `Expected:` line. */
function kindOf(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return article(typeof value);
}

const EXPECTED_TYPE: Record<string, string> = {
  string: 'a string',
  boolean: 'true or false',
  number: 'a number',
  int: 'an integer',
  object: 'an object',
  array: 'an array',
};

/**
 * Phrase each zod issue as what was expected, the `Expected:` line of
 * InvalidParameterError. Passed per parse, so it covers every schema; schemas
 * don't bind messages of their own.
 */
const expectedMessage: z.core.$ZodErrorMap = issue => {
  switch (issue.code) {
    case 'invalid_type': {
      const expected = EXPECTED_TYPE[issue.expected] ?? issue.expected;
      if (issue.input === undefined) return `${expected} (required)`;
      return `${expected}, not ${kindOf(issue.input)}`;
    }
    case 'invalid_value':
      return `one of ${issue.values.map(v => JSON.stringify(v)).join(', ')}`;
    default:
      return undefined; // zod's own message
  }
};

/** A legal value of each type for the `Example:` line, which the unconverted tools' errors also carry. */
const EXAMPLE_VALUE: Record<string, string> = {
  string: '"..."',
  boolean: 'true',
  number: '5',
  int: '5',
};

/** `param: value` with a legal value, or nothing when no sample fits the issue. */
function exampleFor(param: string, issue: z.core.$ZodIssue): string | undefined {
  if (issue.code === 'invalid_value') {
    const last = issue.values[issue.values.length - 1];
    return last === undefined ? undefined : `${param}: ${JSON.stringify(last)}`;
  }
  if (issue.code === 'invalid_type') {
    const sample = EXAMPLE_VALUE[issue.expected];
    return sample === undefined ? undefined : `${param}: ${sample}`;
  }
  return undefined;
}

function article(type: string): string {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}
