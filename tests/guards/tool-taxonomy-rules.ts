/**
 * The rules of ADR-0037 (tool-taxonomy-get-find-explore-check) that a recorded `tools/list` can be held to, shared by
 * `tests/guards/tool-taxonomy.test.ts` (the recorded list and the self-test of each rule).
 */

export type TaxonomyTool = {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown> };
};

/** The four tool types, and the verb each type's description opens with. */
export const TYPE_VERBS: Record<string, string> = {
  get: 'Get',
  find: 'Find',
  explore: 'Explore',
  check: 'Check',
};

/** `logseq_<type>_<object>`, the object being one or more lowercase words. */
export const NAME_PATTERN = /^logseq_(get|find|explore|check)_[a-z]+(_[a-z]+)*$/;

/** The v1 names for a concept that v2 gives one shared name (ADR-0037, "One parameter vocabulary"). */
export const V1_PARAMETER_NAMES = [
  'page_name',
  'topic_name',
  'concept_name',
  'topic_a',
  'topic_b',
  'block_uuid',
  'name_contains',
  'property_key',
  'property_value',
  'query',
  'search_term',
];

/**
 * The v1 tools, exempt from every rule above until their rename lands (#489 to #495). A rename PR deletes the entry of
 * each tool it renames or merges away, because a name that is no longer in the recorded list is a stale entry and
 * fails the guard. The plan (#500) is done when this is empty and the constant is gone.
 */
export const V1_TOOL_ALLOWANCES: readonly string[] = [
  'logseq_build_context',
  'logseq_check_links',
  'logseq_get_backlinks',
  'logseq_get_block',
  'logseq_get_concept_evolution',
  'logseq_get_concept_network',
  'logseq_get_context_for_query',
  'logseq_get_current_context',
  'logseq_get_graph_info',
  'logseq_get_page',
  'logseq_get_page_outline',
  'logseq_list_pages',
  'logseq_query_by_date_range',
  'logseq_query_by_property',
  'logseq_search_blocks',
  'logseq_search_by_relationship',
];

/** Every way `tools` breaks the rules, one sentence each. An empty list means it conforms. */
export function taxonomyViolations(tools: readonly TaxonomyTool[], allowances: readonly string[]): string[] {
  const violations: string[] = [];
  const names = new Set(tools.map(tool => tool.name));

  for (const entry of allowances) {
    if (!names.has(entry)) {
      violations.push(
        `V1_TOOL_ALLOWANCES lists ${entry}, which is not in the recorded tool list. Delete the entry (the rename PR that removed the tool does it).`
      );
    }
  }

  for (const tool of tools) {
    if (allowances.includes(tool.name)) continue;

    const match = NAME_PATTERN.exec(tool.name);
    if (!match) {
      violations.push(`${tool.name}: the name must match ${NAME_PATTERN} (logseq_<type>_<object>, type one of get, find, explore, check).`);
    } else {
      const verb = TYPE_VERBS[match[1]];
      const first = (tool.description ?? '').trimStart().split(/\s+/)[0];
      if (first !== verb) {
        violations.push(`${tool.name}: the description must open with "${verb}" (its type's verb), not "${first}".`);
      }
    }

    for (const parameter of Object.keys(tool.inputSchema?.properties ?? {})) {
      if (V1_PARAMETER_NAMES.includes(parameter)) {
        violations.push(`${tool.name}: the parameter ${parameter} is a v1 name. Use the shared vocabulary of ADR-0037.`);
      }
    }
  }

  return violations;
}
