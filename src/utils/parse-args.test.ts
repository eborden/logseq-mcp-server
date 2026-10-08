import { describe, it, expect } from 'vitest';
import { z } from 'zod/v4';
import { parseArgs, toInputSchema } from './parse-args.js';
import { InvalidParameterError } from '../errors.js';

const schema = z.object({
  page_name: z.string().describe('Page name'),
  include_children: z.boolean().default(false).describe('Children too'),
  limit: z.number().optional().describe('Most results'),
  format: z.enum(['json', 'markdown']).optional().describe('Output format'),
});

function errorFor(args: Record<string, unknown> | undefined): InvalidParameterError {
  try {
    parseArgs(schema, args);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidParameterError);
    return error as InvalidParameterError;
  }
  throw new Error('expected parseArgs to throw');
}

describe('parseArgs', () => {
  it('returns typed values with defaults applied', () => {
    expect(parseArgs(schema, { page_name: 'my page' })).toEqual({ page_name: 'my page', include_children: false });
    expect(parseArgs(schema, { page_name: 'my page', include_children: true, limit: 5, format: 'markdown' })).toEqual({
      page_name: 'my page',
      include_children: true,
      limit: 5,
      format: 'markdown',
    });
  });

  it('ignores unknown fields instead of rejecting them', () => {
    expect(parseArgs(schema, { page_name: 'my page', future_option: 1 })).toEqual({ page_name: 'my page', include_children: false });
  });

  it('reads null as absent', () => {
    expect(parseArgs(schema, { page_name: 'my page', include_children: null, format: null })).toEqual({
      page_name: 'my page',
      include_children: false,
    });
  });

  it('reports a missing required field, including one sent as null or with no arguments at all', () => {
    for (const args of [{}, { page_name: null }, undefined]) {
      const error = errorFor(args);
      expect(error.message).toContain("Invalid parameter 'page_name': missing");
      expect(error.message).toContain('Expected: a string (required)');
    }
  });

  it('rejects a wrong type without coercing it', () => {
    expect(errorFor({ page_name: 42 }).message).toContain("'page_name': 42");
    expect(errorFor({ page_name: 'my page', include_children: 'true' }).message).toMatch(
      /'include_children': "true".*Expected: true or false, not a string/s
    );
    expect(errorFor({ page_name: 'my page', limit: '5' }).message).toMatch(/'limit': "5".*Expected: a number, not a string/s);
  });

  it('rejects NaN and a number where a string belongs', () => {
    expect(errorFor({ page_name: 'my page', limit: NaN }).message).toMatch(/'limit': NaN.*Expected: a number, not NaN/s);
    expect(errorFor({ page_name: -1 }).message).toMatch(/'page_name': -1.*Expected: a string, not a number/s);
  });

  it('passes a negative number through: range limits and clamps stay with the handler', () => {
    expect(parseArgs(schema, { page_name: 'my page', limit: -3 }).limit).toBe(-3);
  });

  it('lists the allowed values of an enum', () => {
    expect(errorFor({ page_name: 'my page', format: 'html' }).message).toMatch(
      /'format': "html".*Expected: one of "json", "markdown"/s
    );
  });

  it('ends with an Example: line holding a legal value', () => {
    expect(errorFor({ page_name: 'my page', format: 'html' }).message).toMatch(/\nExample: format: "markdown"$/);
    expect(errorFor({ page_name: 'my page', include_children: 'true' }).message).toMatch(/\nExample: include_children: true$/);
    expect(errorFor({ page_name: 'my page', limit: '5' }).message).toMatch(/\nExample: limit: 5$/);
    expect(errorFor({}).message).toMatch(/\nExample: page_name: "\.\.\."$/);
  });

  it('names every type of a union of plain types, without coercing', () => {
    const union = z.object({ value: z.union([z.string(), z.number(), z.boolean()]) });
    expect(parseArgs(union, { value: 1 })).toEqual({ value: 1 });
    expect(parseArgs(union, { value: true })).toEqual({ value: true });
    expect(parseArgs(union, { value: '1' })).toEqual({ value: '1' });
    const missing = () => parseArgs(union, {});
    expect(missing).toThrow(/'value': missing.*Expected: a string, a number or a boolean \(required\).*\nExample: value: "\.\.\."$/s);
    expect(() => parseArgs(union, { value: ['x'] })).toThrow(/'value': \["x"\].*a string, a number or a boolean, not an array/s);
    expect(() => parseArgs(union, { value: NaN })).toThrow(/'value': NaN.*a string, a number or a boolean, not NaN/s);
  });

  describe('the error text, in full', () => {
    function messageFor<S extends z.ZodObject>(s: S, args: Record<string, unknown>): string {
      try {
        parseArgs(s, args);
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidParameterError);
        return (error as InvalidParameterError).message;
      }
      throw new Error('expected parseArgs to throw');
    }

    /** What zod itself says about the first issue: the text parseArgs keeps when it has no wording of its own. */
    function zodMessage(s: z.ZodObject, args: Record<string, unknown>): string {
      const result = s.safeParse(args);
      if (result.success) throw new Error('expected the schema to reject the arguments');
      return result.error.issues[0].message;
    }

    it('names a failure of the whole arguments object "(arguments)" and shows the arguments', () => {
      // no field is at fault, so the issue has an empty path: the value shown is every argument, not "missing"
      const sameValues = z.object({ first: z.string(), second: z.string() }).refine(v => v.first !== v.second, 'the two must differ');

      expect(messageFor(sameValues, { first: 'x', second: 'x' })).toBe(
        'Invalid parameter \'(arguments)\': {"first":"x","second":"x"}\n\nExpected: the two must differ'
      );
    });

    it('names a nested field by its path, and shows the top-level value it sits in', () => {
      const nested = z.object({ filter: z.object({ name: z.string() }) });

      expect(messageFor(nested, { filter: {} })).toBe(
        'Invalid parameter \'filter.name\': {}\n\nExpected: a string (required)\nExample: filter.name: "..."'
      );
    });

    it('names an array element by its index', () => {
      const list = z.object({ names: z.array(z.string()) });

      expect(messageFor(list, { names: ['a', 2] })).toBe(
        'Invalid parameter \'names.1\': ["a",2]\n\nExpected: a string, not a number\nExample: names.1: "..."'
      );
    });

    it('says what a value is: an array, an object, a function or a number', () => {
      expect(messageFor(z.object({ v: z.string() }), { v: [] })).toContain('Expected: a string, not an array\n');
      expect(messageFor(z.object({ v: z.number() }), { v: { a: 1 } })).toContain('Expected: a number, not an object\n');
      expect(messageFor(z.object({ v: z.number() }), { v: () => 1 })).toContain('Expected: a number, not a function\n');
      expect(messageFor(z.object({ v: z.boolean() }), { v: 1 })).toContain('Expected: true or false, not a number\n');
    });

    it('shows Infinity as Infinity, since JSON would show null', () => {
      expect(messageFor(z.object({ v: z.number() }), { v: Infinity })).toBe(
        "Invalid parameter 'v': Infinity\n\nExpected: a number, not Infinity\nExample: v: 5"
      );
    });

    it('says an integer is expected, not a fraction, with an integer for the example', () => {
      expect(messageFor(z.object({ v: z.int() }), { v: 1.5 })).toBe(
        "Invalid parameter 'v': 1.5\n\nExpected: an integer, not a fraction\nExample: v: 5"
      );
      expect(messageFor(z.object({ v: z.int() }), { v: -0.1 })).toContain('Expected: an integer, not a fraction\n');
    });

    it('calls only a finite non-whole number a fraction', () => {
      for (const v of ['5', '2.5', NaN, Infinity, -Infinity, true]) {
        expect(messageFor(z.object({ v: z.int() }), { v }), String(v)).not.toContain('fraction');
      }
      // Only where an integer was expected: elsewhere 2.5 is just a number
      expect(messageFor(z.object({ v: z.string() }), { v: 2.5 })).toContain('Expected: a string, not a number\n');
    });

    it('gives no Example: line for a type with no sample value', () => {
      expect(messageFor(z.object({ v: z.array(z.string()) }), { v: 5 })).toBe(
        "Invalid parameter 'v': 5\n\nExpected: an array, not a number"
      );
      expect(messageFor(z.object({ v: z.object({ a: z.string() }) }), { v: 5 })).toBe(
        "Invalid parameter 'v': 5\n\nExpected: an object, not a number"
      );
    });

    it('lists a single allowed value, and gives it as the example', () => {
      expect(messageFor(z.object({ v: z.literal(1) }), { v: 2 })).toBe(
        "Invalid parameter 'v': 2\n\nExpected: one of 1\nExample: v: 1"
      );
    });

    it('gives no Example: line when there is no allowed value to show', () => {
      // An empty list is degenerate and no tool has one; it is here only to cover the branch with no last value to show
      const message = messageFor(z.object({ v: z.enum([] as never) }), { v: 5 });

      expect(message).toMatch(/^Invalid parameter 'v': 5\n\nExpected: /);
      expect(message).not.toContain('Example:');
    });

    it('keeps the zod message for an issue of another kind, and gives it no Example:', () => {
      const tooShort = z.object({ v: z.string().min(3) });

      expect(messageFor(tooShort, { v: 'a' })).toBe(`Invalid parameter 'v': "a"\n\nExpected: ${zodMessage(tooShort, { v: 'a' })}`);
    });

    describe('a union', () => {
      it('keeps the zod message when an alternative is not a plain type, and takes the example from the first one', () => {
        const stringOrList = z.object({ v: z.union([z.string(), z.array(z.string())]) });

        expect(messageFor(stringOrList, { v: 5 })).toBe(
          `Invalid parameter 'v': 5\n\nExpected: ${zodMessage(stringOrList, { v: 5 })}\nExample: v: "..."`
        );
        expect(messageFor(stringOrList, {})).toBe(
          `Invalid parameter 'v': missing\n\nExpected: ${zodMessage(stringOrList, {})}\nExample: v: "..."`
        );
      });

      it('gives no Example: line when the first alternative has no sample value', () => {
        const listOrString = z.object({ v: z.union([z.array(z.string()), z.string()]) });

        expect(messageFor(listOrString, { v: 5 })).toBe(`Invalid parameter 'v': 5\n\nExpected: ${zodMessage(listOrString, { v: 5 })}`);
      });

      it('keeps the zod message when an alternative fails on more than one field', () => {
        // the object alternative reports both missing fields, the first of them "expected string": it must not read as a plain string
        const stringOrPair = z.object({ v: z.union([z.string(), z.object({ a: z.string(), b: z.string() })]) });

        expect(messageFor(stringOrPair, { v: {} })).toBe(
          `Invalid parameter 'v': {}\n\nExpected: ${zodMessage(stringOrPair, { v: {} })}\nExample: v: "..."`
        );
      });

      it('keeps the zod message for a union of one alternative', () => {
        const single = z.object({ v: z.union([z.string()]) });

        expect(messageFor(single, { v: 5 })).toBe(`Invalid parameter 'v': 5\n\nExpected: ${zodMessage(single, { v: 5 })}\nExample: v: "..."`);
      });

      it('keeps the zod message, with no Example:, for a union of no alternatives', () => {
        const none = z.object({ v: z.union([]) });

        expect(messageFor(none, { v: 5 })).toBe(`Invalid parameter 'v': 5\n\nExpected: ${zodMessage(none, { v: 5 })}`);
        expect(messageFor(none, {})).toBe(`Invalid parameter 'v': missing\n\nExpected: ${zodMessage(none, {})}`);
      });

      it('never reads a custom check as a plain type, even when its issue carries an expected key', () => {
        const custom = z.any().superRefine((value, ctx) => {
          if (typeof value !== 'string') ctx.addIssue({ code: 'custom', expected: 'string', message: 'need a string' } as never);
        });
        const customOrNumber = z.object({ v: z.union([custom, z.number()]) });

        // a custom issue has no kind to name, so the union keeps zod's message; read as "expected string" it would say "a string or a number"
        expect(messageFor(customOrNumber, { v: true })).toBe(
          `Invalid parameter 'v': true\n\nExpected: ${zodMessage(customOrNumber, { v: true })}`
        );
        expect(messageFor(customOrNumber, { v: true })).not.toContain('a string or a number');
      });

      it('lists two alternatives with "or" and no comma', () => {
        expect(messageFor(z.object({ v: z.union([z.string(), z.number()]) }), { v: ['x'] })).toBe(
          "Invalid parameter 'v': [\"x\"]\n\nExpected: a string or a number, not an array\nExample: v: \"...\""
        );
      });
    });
  });
});

describe('toInputSchema', () => {
  it('generates the JSON Schema tools/list advertises, without $schema or additionalProperties', () => {
    expect(toInputSchema(schema)).toEqual({
      type: 'object',
      properties: {
        page_name: { type: 'string', description: 'Page name' },
        include_children: { type: 'boolean', default: false, description: 'Children too' },
        limit: { type: 'number', description: 'Most results' },
        format: { type: 'string', enum: ['json', 'markdown'], description: 'Output format' },
      },
      required: ['page_name'],
    });
  });

  it('refuses a schema that rejects unknown fields, since validating clients would then reject the aliases', () => {
    expect(() => toInputSchema(z.strictObject({ page_name: z.string() }))).toThrow(
      'toInputSchema needs a zod object schema that ignores unknown fields'
    );
  });

  it('refuses a schema that is not a plain object schema', () => {
    // .meta() overrides keys of the generated JSON Schema, which is the way to make a zod object come out as another type
    const notAnObject = z.object({ page_name: z.string() }).meta({ type: 'array' } as never);
    const noProperties = z.object({ page_name: z.string() }).meta({ properties: undefined } as never);

    expect(() => toInputSchema(notAnObject)).toThrow('toInputSchema needs a zod object schema that ignores unknown fields');
    expect(() => toInputSchema(noProperties)).toThrow('toInputSchema needs a zod object schema that ignores unknown fields');
  });

  it('accepts a schema with no fields', () => {
    expect(toInputSchema(z.object({}))).toEqual({ type: 'object', properties: {} });
  });

  it("advertises an integer without zod's safe-integer range, but keeps bounds the schema sets (#293)", () => {
    const counts = z.object({
      plain: z.int(),
      bounded: z.int().min(1).max(10),
      floored: z.int().min(0),
      fraction: z.number().min(-1),
      // A plain number bounded by the same values keeps them: only integers lose the range
      wide: z.number().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    });

    expect(toInputSchema(counts).properties).toEqual({
      plain: { type: 'integer' },
      bounded: { type: 'integer', minimum: 1, maximum: 10 },
      floored: { type: 'integer', minimum: 0 },
      fraction: { type: 'number', minimum: -1 },
      wide: { type: 'number', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
    });
  });
});
