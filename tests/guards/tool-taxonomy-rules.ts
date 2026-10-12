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

/**
 * The v1 names for a concept that v2 gives one shared name (ADR-0037, "One parameter vocabulary"), and the three
 * guesses a model made from those names (`topic`, `concept`, `property_name`). ADR-0037 gives them no alias (BR-0008),
 * so none may appear in a schema.
 */
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
  'topic',
  'concept',
  'property_name',
];

/**
 * The v1 tools that break a rule, exempt until their rename lands (#489 to #495). A rename PR deletes the entry of each
 * tool it renames or merges away, and of each tool it leaves conforming (`get_page` and `get_block` keep their names):
 * an entry whose name is gone from the recorded list, or whose tool already passes every rule, fails the guard. The
 * tools that conform (`check_links`, since #489 `get_page`, `get_block`, `get_current` and `get_graph`, and since #490 `find_pages`) have no entry, so the
 * rules run on them now. The plan (#500) is done when this is empty and the constant is gone.
 */
export const V1_TOOL_ALLOWANCES: readonly string[] = [
  'logseq_build_context',
  'logseq_get_backlinks',
  'logseq_get_concept_evolution',
  'logseq_get_concept_network',
  'logseq_get_context_for_query',
  'logseq_query_by_date_range',
  'logseq_query_by_property',
  'logseq_search_blocks',
  'logseq_search_by_relationship',
];

/** Every way one tool breaks the three rules, ignoring any allowance. */
function toolViolations(tool: TaxonomyTool): string[] {
  const violations: string[] = [];

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

  return violations;
}

/**
 * Every way `tools` breaks the rules, one sentence each. An empty list means it conforms. A tool in `allowances` is
 * exempt, but an entry must still be needed: one whose tool is gone from the list, or whose tool already passes every
 * rule, is reported so the rename PR deletes it (the "no stale allowances" pattern of `DESCRIPTION_ALLOWANCES`).
 */
export function taxonomyViolations(tools: readonly TaxonomyTool[], allowances: readonly string[]): string[] {
  const violations: string[] = [];
  const byName = new Map(tools.map(tool => [tool.name, tool]));

  for (const entry of allowances) {
    const tool = byName.get(entry);
    if (!tool) {
      violations.push(
        `V1_TOOL_ALLOWANCES lists ${entry}, which is not in the recorded tool list. Delete the entry (the rename PR that removed the tool does it).`
      );
    } else if (toolViolations(tool).length === 0) {
      violations.push(`${entry} already conforms to ADR-0037. Delete its V1_TOOL_ALLOWANCES entry.`);
    }
  }

  for (const tool of tools) {
    if (!allowances.includes(tool.name)) violations.push(...toolViolations(tool));
  }

  return violations;
}
