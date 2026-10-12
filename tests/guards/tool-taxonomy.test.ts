import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  taxonomyViolations,
  V1_PARAMETER_NAMES,
  V1_TOOL_ALLOWANCES,
  type TaxonomyTool,
} from './tool-taxonomy-rules.js';

/**
 * ADR-0037 (tool-taxonomy-get-find-explore-check), Mechanical enforcement (#488, part of #500).
 *
 * The recorded list, rust/tests/data/parity/tool-list.json, is held to the v2 naming rules: every name is
 * `logseq_<type>_<object>` with a type of get, find, explore or check; every description opens with its type's verb; and
 * no parameter uses a v1 name for a concept that v2 shares. The 16 v1 tools are exempt through V1_TOOL_ALLOWANCES, and
 * each rename PR (#489 to #495) deletes its own entries. A stale entry fails, so the list can only shrink to empty.
 * Follows the DESCRIPTION_ALLOWANCES pattern of ADR-0016.
 */

const TOOL_LIST_FILE = new URL('../../rust/tests/data/parity/tool-list.json', import.meta.url);
const recorded = JSON.parse(readFileSync(TOOL_LIST_FILE, 'utf-8')) as TaxonomyTool[];

describe('tool taxonomy (ADR-0037)', () => {
  it('holds the recorded tool list to the naming rules, apart from the allowlisted v1 tools', () => {
    expect(taxonomyViolations(recorded, V1_TOOL_ALLOWANCES)).toEqual([]);
  });

  it('lists each allowance once', () => {
    expect(new Set(V1_TOOL_ALLOWANCES).size).toBe(V1_TOOL_ALLOWANCES.length);
  });
});

describe('each taxonomy rule can fail', () => {
  const conforming: TaxonomyTool = {
    name: 'logseq_find_pages',
    description: 'Find pages by text. Can\'t find blocks.',
    inputSchema: { properties: { text: {}, limit: {} } },
  };
  const violations = (tool: TaxonomyTool, allowances: readonly string[] = []) => taxonomyViolations([tool], allowances);

  it('passes a conforming tool', () => {
    expect(violations(conforming)).toEqual([]);
  });

  it('fails a name without the logseq_ prefix', () => {
    expect(violations({ ...conforming, name: 'find_pages' })).toEqual([expect.stringContaining('the name must match')]);
  });

  it('fails a v1 verb as the type', () => {
    expect(violations({ ...conforming, name: 'logseq_search_blocks' })).toEqual([expect.stringContaining('the name must match')]);
  });

  it('fails a name with no object', () => {
    expect(violations({ ...conforming, name: 'logseq_find' })).toEqual([expect.stringContaining('the name must match')]);
    expect(violations({ ...conforming, name: 'logseq_find_' })).toEqual([expect.stringContaining('the name must match')]);
  });

  it('fails a description that opens with another type\'s verb', () => {
    expect(violations({ ...conforming, description: 'Explore pages by text.' })).toEqual([
      expect.stringContaining('must open with "Find"'),
    ]);
  });

  it('fails a description that opens with a v1 verb or has none', () => {
    expect(violations({ ...conforming, description: 'List pages by text.' })).toEqual([expect.stringContaining('must open with "Find"')]);
    expect(violations({ ...conforming, description: undefined })).toEqual([expect.stringContaining('must open with "Find"')]);
  });

  it.each(V1_PARAMETER_NAMES)('fails the v1 parameter name %s', parameter => {
    const tool = { ...conforming, inputSchema: { properties: { [parameter]: {} } } };
    expect(violations(tool)).toEqual([expect.stringContaining(`the parameter ${parameter} is a v1 name`)]);
  });

  it('fails a stale allowance', () => {
    expect(taxonomyViolations([conforming], ['logseq_get_backlinks'])).toEqual([
      expect.stringContaining('V1_TOOL_ALLOWANCES lists logseq_get_backlinks'),
    ]);
  });

  it('exempts an allowlisted tool from the name, description and parameter rules', () => {
    const v1: TaxonomyTool = {
      name: 'logseq_list_pages',
      description: 'List pages.',
      inputSchema: { properties: { name_contains: {} } },
    };
    expect(violations(v1)).not.toEqual([]);
    expect(violations(v1, ['logseq_list_pages'])).toEqual([]);
  });
});
