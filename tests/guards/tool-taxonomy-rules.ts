/**
 * The rules of ADR-0037 (tool-taxonomy-get-find-explore-check) that a recorded `tools/list` can be held to, shared by
 * `tests/guards/tool-taxonomy.test.ts` (the recorded list and the self-test of each rule).
 */

/** A JSON Schema node, as far as the parameter rules read it: its `properties` and the branches of `oneOf`, `anyOf` and `allOf`. */
export type SchemaNode = {
  properties?: Record<string, unknown>;
  oneOf?: readonly SchemaNode[];
  anyOf?: readonly SchemaNode[];
  allOf?: readonly SchemaNode[];
};

export type TaxonomyTool = {
  name: string;
  description?: string;
  inputSchema?: SchemaNode;
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

/** The period of ADR-0037 ("Period"): exactly one of `start_date` with `end_date`, `last_n` or `preset`. Shared by `find_blocks` and `explore_timeline`. */
const PERIOD = ['start_date', 'end_date', 'last_n', 'preset'];

/**
 * The positive list of ADR-0037 (#519): the parameters each tool may advertise, from the "One parameter vocabulary" and
 * "The v2 surface" table of the ADR. A name is tied to the tools the table gives it, so a shared name on a tool the table
 * does not list for it fails as well as a name outside the vocabulary. A PR that adds a parameter adds it to the ADR's
 * table first, then here. Aliases are never in the advertised schema, so none is listed (BR-0008).
 */
export const ALLOWED_PARAMETERS: Readonly<Record<string, readonly string[]>> = {
  // ADR-0038 adds `cursor` to `get_page` (for `detail: "full"` and `detail: "outline"`) and `get_block` (with `include_children`):
  // the blocks of a tree larger than the budget, and the top-level blocks of an outline past one page, are read to the end
  // with it (#552, #553). `page` and `uuid` stay, optional beside a cursor (BR-0008).
  logseq_get_page: ['page', 'detail', 'resolve_refs', 'format', 'cursor'],
  logseq_get_block: ['uuid', 'include_children', 'resolve_refs', 'format', 'cursor'],
  logseq_get_current: [],
  logseq_get_graph: [],
  // ADR-0038 (one forward-only cursor for paging) took `offset` off `find_blocks` and `find_pages` and added `cursor`:
  // ADR-0037's `limit` and `offset` vocabulary stays as written, but each paged tool moved to `limit` (the page size)
  // and `cursor` (#528). `explore_context` took `cursor` and lost `references_offset` in #555: its `max_*` caps
  // are the page size of each list, and `page` stays, optional beside a cursor (BR-0008).
  logseq_find_pages: ['text', 'names', 'property', 'value', 'limit', 'format', 'cursor'],
  logseq_find_blocks: ['text', 'page', 'links_to', 'property', 'value', ...PERIOD, 'limit', 'include_context', 'slim_results', 'cursor'],
  // `include_temporal_context` is the one toggle kept as today (#493). The ADR-0037 row says "its caps", read loosely to cover it (maintainer, #519).
  logseq_explore_context: [
    'page',
    'max_blocks',
    'max_related_pages',
    'max_references',
    'include_temporal_context',
    'resolve_refs',
    'format',
    'compact',
    'cursor',
  ],
  // ADR-0038 adds `cursor` to `explore_network` (the walk without `to`): the walk runs to 500 pages and `max_nodes` is the size of a
  // page, read to the end with it (#556). `page` stays, optional beside a cursor (BR-0008).
  logseq_explore_network: ['page', 'to', 'max_depth', 'max_nodes', 'max_fanout', 'expand_journals', 'with_snippets', 'format', 'cursor'],
  // ADR-0038 adds `cursor` to `explore_timeline`: its blocks across the days are read to the end with it, and `max_blocks`
  // is the page size (#554). `page` and the period stay, optional beside a cursor.
  logseq_explore_timeline: [
    'page',
    ...PERIOD,
    'group_by',
    'max_blocks',
    'top_concepts_limit',
    'include_content',
    'slim_results',
    'resolve_refs',
    'cursor',
  ],
  logseq_check_links: ['before', 'after'],
};

/**
 * Every parameter name a schema advertises: the top-level `properties`, and those under the branches of `oneOf`, `anyOf`
 * and `allOf`, to any depth of composition, so a schema that nests parameters in a branch cannot skirt the rules. A
 * `properties` nested inside a property is a value's shape, not a parameter, and is not read.
 */
export function schemaParameters(schema: SchemaNode | undefined): string[] {
  const names = new Set<string>();
  const walk = (node: SchemaNode | undefined): void => {
    if (!node || typeof node !== 'object') return;
    for (const name of Object.keys(node.properties ?? {})) names.add(name);
    for (const keyword of ['oneOf', 'anyOf', 'allOf'] as const) {
      for (const branch of node[keyword] ?? []) walk(branch);
    }
  };
  walk(schema);
  return [...names];
}

/** Every way one tool breaks the three rules, ignoring any allowance. */
function toolViolations(tool: TaxonomyTool, allowed: Readonly<Record<string, readonly string[]>>): string[] {
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

  const parameters = schemaParameters(tool.inputSchema);
  for (const parameter of parameters) {
    if (V1_PARAMETER_NAMES.includes(parameter)) {
      violations.push(`${tool.name}: the parameter ${parameter} is a v1 name. Use the shared vocabulary of ADR-0037.`);
    }
  }

  // The positive list. A v1 name is reported above (clearer), and a tool that fails the name rule has no entry to look up.
  if (match) {
    const permitted = allowed[tool.name];
    if (!permitted) {
      violations.push(
        `${tool.name}: the tool has no entry in ALLOWED_PARAMETERS. Add the tool and its parameters to the ADR-0037 table first, then to ALLOWED_PARAMETERS.`
      );
    } else {
      for (const parameter of parameters) {
        if (!V1_PARAMETER_NAMES.includes(parameter) && !permitted.includes(parameter)) {
          violations.push(
            `${tool.name}: the parameter ${parameter} is not in the ADR-0037 vocabulary for this tool. Add it to the ADR's parameter vocabulary and surface table first, then to ALLOWED_PARAMETERS in tests/guards/tool-taxonomy-rules.ts.`
          );
        }
      }
    }
  }

  return violations;
}

/**
 * Every way `tools` breaks the rules, one sentence each. An empty list means it conforms. A tool in `allowances` is
 * exempt, but an entry must still be needed: one whose tool is gone from the list, or whose tool already passes every
 * rule, is reported so the rename PR deletes it (the "no stale allowances" pattern of `DESCRIPTION_ALLOWANCES`).
 */
export function taxonomyViolations(
  tools: readonly TaxonomyTool[],
  allowances: readonly string[],
  allowed: Readonly<Record<string, readonly string[]>> = ALLOWED_PARAMETERS
): string[] {
  const violations: string[] = [];
  const byName = new Map(tools.map(tool => [tool.name, tool]));

  for (const entry of allowances) {
    const tool = byName.get(entry);
    if (!tool) {
      violations.push(
        `An allowance lists ${entry}, which is not in the recorded tool list. Delete the entry (the rename PR that removed the tool does it).`
      );
    } else if (toolViolations(tool, allowed).length === 0) {
      violations.push(`${entry} already conforms to ADR-0037. Delete its allowance entry.`);
    }
  }

  for (const tool of tools) {
    if (!allowances.includes(tool.name)) violations.push(...toolViolations(tool, allowed));
  }

  return violations;
}
