import { describe, it, expect } from 'vitest';
import type { z } from 'zod/v4';
import { parseArgs, toInputSchema } from './utils/parse-args.js';
import { resolveParamAliases } from './utils/param-aliases.js';
import { InvalidParameterError } from './errors.js';
import {
  buildContextArgs,
  getBacklinksArgs,
  getConceptEvolutionArgs,
  getConceptNetworkArgs,
  getContextForQueryArgs,
  listPagesArgs,
  queryByDateRangeArgs,
  queryByPropertyArgs,
  searchBlocksArgs,
  searchByRelationshipArgs,
} from './tool-args.js';
import { MAX_PAGES, MAX_BLOCKS_PER_PAGE } from './tools/get-backlinks.js';
import { MAX_SEARCH_LIMIT } from './tools/search-blocks.js';
import { MAX_PROPERTY_LIMIT } from './tools/query-by-property.js';
import { MAX_RELATIONSHIP_LIMIT } from './tools/search-by-relationship.js';
import { MAX_SEARCH_RESULTS } from './tools/get-context-for-query.js';
import { MAX_DATE_RANGE_BLOCKS } from './tools/query-by-date-range.js';
import { MAX_ENTRIES } from './tools/get-concept-evolution.js';
import { MAX_LIST_PAGES_LIMIT } from './tools/list-pages.js';

/**
 * Count, limit, offset and depth parameters are integers (#293). A fraction is
 * rejected at the boundary, never rounded. Any whole number still passes the
 * schema, and the tool clamps it to its range as before (no schema bounds).
 */

interface CountParam {
  tool: string;
  schema: z.ZodObject;
  param: string;
  required: Record<string, unknown>;
  /** The largest value the tool uses, where it caps one. */
  max?: number;
}

const PAGE = { page_name: 'my page' };
const RELATIONSHIP = { topic_a: 'Alice', topic_b: 'Bob', relationship_type: 'references' };
const PROPERTY = { property_key: 'status', property_value: 'done' };

const COUNT_PARAMS: CountParam[] = [
  { tool: 'get_backlinks', schema: getBacklinksArgs, param: 'max_pages', required: PAGE, max: MAX_PAGES },
  { tool: 'get_backlinks', schema: getBacklinksArgs, param: 'max_blocks_per_page', required: PAGE, max: MAX_BLOCKS_PER_PAGE },
  { tool: 'search_blocks', schema: searchBlocksArgs, param: 'limit', required: { query: 'x' }, max: MAX_SEARCH_LIMIT },
  { tool: 'query_by_property', schema: queryByPropertyArgs, param: 'limit', required: PROPERTY, max: MAX_PROPERTY_LIMIT },
  { tool: 'get_concept_network', schema: getConceptNetworkArgs, param: 'max_depth', required: { concept_name: 'x' }, max: 3 },
  { tool: 'get_concept_network', schema: getConceptNetworkArgs, param: 'max_nodes', required: { concept_name: 'x' }, max: 500 },
  { tool: 'get_concept_network', schema: getConceptNetworkArgs, param: 'max_fanout', required: { concept_name: 'x' }, max: 100 },
  { tool: 'search_by_relationship', schema: searchByRelationshipArgs, param: 'max_distance', required: RELATIONSHIP },
  {
    tool: 'search_by_relationship',
    schema: searchByRelationshipArgs,
    param: 'limit',
    required: RELATIONSHIP,
    max: MAX_RELATIONSHIP_LIMIT,
  },
  { tool: 'get_context_for_query', schema: getContextForQueryArgs, param: 'max_topics', required: { query: 'x' } },
  {
    tool: 'get_context_for_query',
    schema: getContextForQueryArgs,
    param: 'max_search_results',
    required: { query: 'x' },
    max: MAX_SEARCH_RESULTS,
  },
  { tool: 'build_context', schema: buildContextArgs, param: 'max_blocks', required: { topic_name: 'x' } },
  { tool: 'build_context', schema: buildContextArgs, param: 'max_related_pages', required: { topic_name: 'x' } },
  { tool: 'build_context', schema: buildContextArgs, param: 'max_references', required: { topic_name: 'x' } },
  { tool: 'query_by_date_range', schema: queryByDateRangeArgs, param: 'last_n', required: {} },
  { tool: 'query_by_date_range', schema: queryByDateRangeArgs, param: 'top_concepts_limit', required: {} },
  { tool: 'query_by_date_range', schema: queryByDateRangeArgs, param: 'max_blocks', required: {}, max: MAX_DATE_RANGE_BLOCKS },
  {
    tool: 'get_concept_evolution',
    schema: getConceptEvolutionArgs,
    param: 'max_entries',
    required: { concept_name: 'x' },
    max: MAX_ENTRIES,
  },
  { tool: 'list_pages', schema: listPagesArgs, param: 'limit', required: {}, max: MAX_LIST_PAGES_LIMIT },
  { tool: 'list_pages', schema: listPagesArgs, param: 'offset', required: {} },
];

const cases = COUNT_PARAMS.map(p => [`${p.tool} ${p.param}`, p] as const);

function errorFor(schema: z.ZodObject, args: Record<string, unknown>): InvalidParameterError {
  try {
    parseArgs(schema, args);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidParameterError);
    return error as InvalidParameterError;
  }
  throw new Error('expected parseArgs to throw');
}

describe('count and limit parameters are integers (#293)', () => {
  it('covers every numeric parameter of these tools except the YYYYMMDD dates', () => {
    const schemas = [...new Set(COUNT_PARAMS.map(p => p.schema))];
    const numeric = schemas.flatMap(schema =>
      Object.entries(toInputSchema(schema).properties)
        .filter(([, property]) => ['number', 'integer'].includes((property as { type?: string }).type ?? ''))
        .map(([name]) => name)
    );
    const dates = ['start_date', 'end_date', 'start_date', 'end_date'];

    expect(numeric.sort()).toEqual([...COUNT_PARAMS.map(p => p.param), ...dates].sort());
  });

  it.each(cases)('%s rejects a fraction, naming it', (_, p) => {
    expect(errorFor(p.schema, { ...p.required, [p.param]: 2.5 }).message).toBe(
      `Invalid parameter '${p.param}': 2.5\n\nExpected: an integer, not a number\nExample: ${p.param}: 5`
    );
  });

  it.each(cases)('%s accepts whole numbers at and past its bounds, for the tool to clamp', (_, p) => {
    const values = [0, 1, -1, Number.MAX_SAFE_INTEGER, ...(p.max === undefined ? [] : [p.max, p.max + 1])];
    for (const value of values) {
      expect(parseArgs(p.schema, { ...p.required, [p.param]: value })[p.param], `${p.param}: ${value}`).toBe(value);
    }
  });

  it.each(cases)('%s advertises an integer with no bounds', (_, p) => {
    const property = toInputSchema(p.schema).properties[p.param];

    expect(property).toMatchObject({ type: 'integer' });
    expect(property).not.toHaveProperty('minimum');
    expect(property).not.toHaveProperty('maximum');
  });

  it('rejects a whole number past the safe-integer range', () => {
    expect(errorFor(listPagesArgs, { offset: 2 ** 53 }).message).toMatch(/^Invalid parameter 'offset': 9007199254740992\n/);
  });

  it('rejects a fraction sent with a page-name alias (BR-0008), and passes a whole number', () => {
    const fraction = resolveParamAliases('logseq_get_backlinks', { page: 'my page', max_pages: 2.5 });
    expect(errorFor(getBacklinksArgs, fraction ?? {}).message).toMatch(/^Invalid parameter 'max_pages': 2\.5\n/);

    const whole = resolveParamAliases('logseq_get_backlinks', { page: 'my page', max_pages: 3 });
    expect(parseArgs(getBacklinksArgs, whole)).toMatchObject({ page_name: 'my page', max_pages: 3 });
  });

  it('leaves the YYYYMMDD dates as plain numbers', () => {
    expect(toInputSchema(queryByDateRangeArgs).properties.start_date).toMatchObject({ type: 'number' });
    expect(toInputSchema(getConceptEvolutionArgs).properties.end_date).toMatchObject({ type: 'number' });
  });
});
