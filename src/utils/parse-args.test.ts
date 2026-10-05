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
});
