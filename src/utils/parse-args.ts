import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
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
 * The `inputSchema` for a tool, generated from its argument schema.
 *
 * `additionalProperties` is left out on purpose: the parser ignores unknown
 * fields, and advertising `false` would make validating clients reject the
 * unadvertised aliases (`name`, `page`, `uuid`) that `resolveParamAliases` folds.
 * `$schema` is dropped too; tools/list never carried it.
 */
export function toInputSchema(schema: z.AnyZodObject): ToolInputSchema {
  const json = zodToJsonSchema(schema, {
    $refStrategy: 'none',
    // Strip-mode objects get `allowedAdditionalProperties`, which is undefined: no key
    removeAdditionalStrategy: 'strict',
    allowedAdditionalProperties: undefined,
  });
  const { $schema: _dropped, ...rest } = json;
  if (!('type' in rest) || rest.type !== 'object' || !('properties' in rest)) {
    throw new Error('toInputSchema needs a zod object schema');
  }
  return { ...rest, type: 'object', properties: rest.properties };
}

/**
 * Parse a tool's arguments (after `resolveParamAliases`) into typed values, or
 * throw `InvalidParameterError` naming the first bad parameter.
 */
export function parseArgs<S extends z.AnyZodObject>(
  schema: S,
  args: Record<string, unknown> | undefined
): z.output<S> {
  const present = withoutNulls(args ?? {});
  const result = schema.safeParse(present, { errorMap: expectedMessage });
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const param = issue.path.length > 0 ? issue.path.join('.') : '(arguments)';
  const value = issue.path.length > 0 ? present[String(issue.path[0])] : present;
  throw new InvalidParameterError(param, value === undefined ? 'missing' : showValue(value), issue.message);
}

function withoutNulls(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null));
}

/** JSON for the error text, except numbers JSON can't show (NaN, Infinity). */
function showValue(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return JSON.stringify(value) ?? String(value);
}

const EXPECTED_TYPE: Record<string, string> = {
  string: 'a string',
  boolean: 'true or false',
  number: 'a number',
  integer: 'an integer',
  object: 'an object',
  array: 'an array',
};

/**
 * Phrase each zod issue as what was expected, the `Expected:` line of
 * InvalidParameterError. Passed as the contextual map, which in zod 3 outranks
 * a message bound in a schema, so schemas don't bind their own.
 */
const expectedMessage: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type: {
      const expected = EXPECTED_TYPE[issue.expected] ?? issue.expected;
      if (issue.received === z.ZodParsedType.undefined) return { message: `${expected} (required)` };
      if (issue.received === z.ZodParsedType.nan) return { message: `${expected}, not NaN` };
      return { message: `${expected}, not ${article(issue.received)}` };
    }
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `one of ${issue.options.map(o => JSON.stringify(o)).join(', ')}` };
    default:
      return { message: ctx.defaultError };
  }
};

function article(type: string): string {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}
