import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  ALLOWED_PARAMETERS,
  taxonomyViolations,
  V1_PARAMETER_NAMES,
  TYPE_VERBS,
  type TaxonomyTool,
} from './tool-taxonomy-rules.js';

/**
 * ADR-0037 (tool-taxonomy-get-find-explore-check), Mechanical enforcement (#488, part of #500).
 *
 * The recorded list, tests/data/parity/tool-list.json, is held to the v2 naming rules: every name is
 * `logseq_<type>_<object>` with a type of get, find, explore or check; every description opens with its type's verb; and
 * no parameter uses a v1 name for a concept that v2 shares. Since #519 a positive list holds it as well: every parameter
 * must be one ADR-0037's vocabulary and surface table gives that tool (ALLOWED_PARAMETERS), so a new name fails even when
 * the forbidden list of v1 names does not know it. The forbidden list stays, for its clearer error on a retired name. The 16 v1 tools were exempt through V1_TOOL_ALLOWANCES while the renames (#489 to #495)
 * landed; the list was empty and the constant removed with the v2.0.0 release prep (#499), so every recorded tool is held
 * to the rules. `taxonomyViolations` keeps its `allowances` argument, which the tests below use to prove each rule can
 * fail and a stale entry is reported.
 */

const TOOL_LIST_FILE = new URL('../../tests/data/parity/tool-list.json', import.meta.url);
const recorded = JSON.parse(readFileSync(TOOL_LIST_FILE, 'utf-8')) as TaxonomyTool[];

describe('tool taxonomy (ADR-0037)', () => {
  it('holds every tool of the recorded list to the naming rules', () => {
    expect(taxonomyViolations(recorded, [])).toEqual([]);
  });

  it('has an entry in the allowed parameters for every recorded tool, and for no other', () => {
    expect(Object.keys(ALLOWED_PARAMETERS).sort()).toEqual(recorded.map(tool => tool.name).sort());
  });

  it('allows no v1 parameter name on any tool', () => {
    for (const [tool, parameters] of Object.entries(ALLOWED_PARAMETERS)) {
      for (const parameter of parameters) expect(V1_PARAMETER_NAMES, `${tool} ${parameter}`).not.toContain(parameter);
    }
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

  it.each(Object.entries(TYPE_VERBS))('type %s opens with %s, and no other type\'s verb', (type, verb) => {
    const tool = (opening: string): TaxonomyTool => ({ ...conforming, name: `logseq_${type}_thing`, description: `${opening} a thing.` });
    const allowed = { [`logseq_${type}_thing`]: ['text', 'limit'] };
    expect(taxonomyViolations([tool(verb)], [], allowed)).toEqual([]);
    for (const other of Object.values(TYPE_VERBS).filter(v => v !== verb)) {
      expect(taxonomyViolations([tool(other)], [], allowed), `${type} must not accept ${other}`).toEqual([
        expect.stringContaining(`must open with "${verb}"`),
      ]);
    }
  });

  it('fails a parameter that is not in the vocabulary of any tool, naming the tool and the ADR table', () => {
    const tool = { ...conforming, inputSchema: { properties: { text: {}, sort_by: {} } } };
    expect(violations(tool)).toEqual([
      expect.stringMatching(/^logseq_find_pages: the parameter sort_by is not in the ADR-0037 vocabulary for this tool\. Add it to the ADR's parameter vocabulary and surface table first/),
    ]);
  });

  it('fails a parameter that is in the vocabulary but not listed for this tool', () => {
    // `to` is real, but only on explore_network; `uuid` only on get_block; `detail` only on get_page.
    for (const parameter of ['to', 'uuid', 'detail', 'links_to']) {
      const tool = { ...conforming, inputSchema: { properties: { text: {}, [parameter]: {} } } };
      expect(violations(tool), parameter).toEqual([expect.stringContaining(`the parameter ${parameter} is not in the ADR-0037 vocabulary`)]);
    }
  });

  it('passes a listed parameter on the tool the table gives it to', () => {
    const tool: TaxonomyTool = { name: 'logseq_explore_network', description: 'Explore a network.', inputSchema: { properties: { page: {}, to: {} } } };
    expect(violations(tool)).toEqual([]);
  });

  it('fails a tool that has no entry in the allowed parameters', () => {
    const tool: TaxonomyTool = { name: 'logseq_find_widgets', description: 'Find widgets.', inputSchema: { properties: { text: {} } } };
    expect(violations(tool)).toEqual([expect.stringContaining('logseq_find_widgets: the tool has no entry in ALLOWED_PARAMETERS')]);
  });

  it('reports a v1 name once, through the forbidden list, and not again as unlisted', () => {
    const tool = { ...conforming, inputSchema: { properties: { page_name: {} } } };
    expect(violations(tool)).toEqual([expect.stringContaining('the parameter page_name is a v1 name')]);
  });

  it('allows include_temporal_context on explore_context only', () => {
    const on = (name: string): TaxonomyTool => ({ name, description: `${name.split('_')[1][0].toUpperCase()}${name.split('_')[1].slice(1)} it.`, inputSchema: { properties: { include_temporal_context: {} } } });
    expect(violations(on('logseq_explore_context'))).toEqual([]);
    expect(violations(on('logseq_explore_network'))).toEqual([expect.stringContaining('include_temporal_context is not in the ADR-0037 vocabulary')]);
  });

  it.each(['oneOf', 'anyOf', 'allOf'])('reads the parameters under %s, so a schema shape change cannot skirt the list', keyword => {
    const tool: TaxonomyTool = {
      ...conforming,
      inputSchema: { properties: { text: {} }, [keyword]: [{ properties: { limit: {} } }, { properties: { sort_by: {} } }] },
    };
    expect(violations(tool)).toEqual([expect.stringContaining('the parameter sort_by is not in the ADR-0037 vocabulary')]);
  });

  it('reads a v1 name hidden under a nested composition', () => {
    const tool: TaxonomyTool = { ...conforming, inputSchema: { properties: { text: {} }, anyOf: [{ allOf: [{ properties: { page_name: {} } }] }] } };
    expect(violations(tool)).toEqual([expect.stringContaining('the parameter page_name is a v1 name')]);
  });

  it('does not read a properties nested inside a property, which is a value shape, not a parameter', () => {
    const tool: TaxonomyTool = { ...conforming, inputSchema: { properties: { text: { properties: { inner: {} } } } } };
    expect(violations(tool)).toEqual([]);
  });

  it('exempts an allowlisted tool whose only fault is a parameter outside the positive list', () => {
    const tool = { ...conforming, inputSchema: { properties: { text: {}, sort_by: {} } } };
    expect(violations(tool)).not.toEqual([]);
    expect(violations(tool, [conforming.name])).toEqual([]);
  });

  it('counts the positive list when judging an allowance stale: an unlisted parameter keeps it needed', () => {
    const tool = { ...conforming, inputSchema: { properties: { text: {}, sort_by: {} } } };
    // Not "already conforms": the exemption is still doing work. Dropping the list from the stale check would report it.
    expect(violations(tool, [conforming.name])).not.toContainEqual(expect.stringContaining('already conforms'));
    // With the parameter on the list the tool conforms, so the entry is reported for deletion.
    const allowed = { [conforming.name]: ['text', 'sort_by'] };
    expect(taxonomyViolations([tool], [conforming.name], allowed)).toEqual([expect.stringContaining('already conforms')]);
  });

  // #539: each call site of toolViolations in taxonomyViolations has to pass the injected list. The default list lacks
  // `sort_by` on logseq_find_pages, so a call that dropped the argument would read the default and report it.
  describe('both call sites pass the injected allowed list', () => {
    const tool = { ...conforming, inputSchema: { properties: { text: {}, sort_by: {} } } };
    const injected = { [conforming.name]: ['text', 'sort_by'] };

    it('the check of a tool that is not allowlisted reads the injected list', () => {
      expect(violations(tool), 'the default list does not allow sort_by').not.toEqual([]);
      expect(taxonomyViolations([tool], [], injected)).toEqual([]);
    });

    it('the stale check of an allowlisted tool reads the injected list', () => {
      expect(taxonomyViolations([tool], [conforming.name])).toEqual([]);
      expect(taxonomyViolations([tool], [conforming.name], injected)).toEqual([expect.stringContaining('already conforms')]);
    });
  });

  it('fails a stale allowance', () => {
    expect(taxonomyViolations([conforming], ['logseq_get_concept_evolution'])).toEqual([
      expect.stringContaining('An allowance lists logseq_get_concept_evolution'),
    ]);
  });

  it('fails an allowlisted tool that already conforms, so its entry is deleted', () => {
    expect(violations(conforming, [conforming.name])).toEqual([
      `${conforming.name} already conforms to ADR-0037. Delete its allowance entry.`,
    ]);
  });

  it('forces out a name that persists once its parameters conform', () => {
    const getPage = (parameter: string): TaxonomyTool => ({
      name: 'logseq_get_page',
      description: 'Get one page.',
      inputSchema: { properties: { [parameter]: {} } },
    });
    expect(violations(getPage('page_name'), ['logseq_get_page'])).toEqual([]);
    expect(violations(getPage('page'), ['logseq_get_page'])).toEqual([expect.stringContaining('already conforms')]);
    expect(violations(getPage('page'))).toEqual([]);
  });

  it('exempts an allowlisted tool from the name, description and parameter rules', () => {
    const v1: TaxonomyTool = {
      name: 'logseq_search_blocks',
      description: 'Search blocks.',
      inputSchema: { properties: { query: {} } },
    };
    expect(violations(v1)).not.toEqual([]);
    expect(violations(v1, ['logseq_search_blocks'])).toEqual([]);
  });
});
