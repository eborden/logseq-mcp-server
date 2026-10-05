import { InvalidParameterError } from '../errors.js';

/**
 * Parameter aliases (#44): alternative names the handler accepts for a
 * canonical parameter. They are NOT in the input schemas, so they cost no
 * tokens in tools/list. Models carry `name`, `page` or a neighbouring tool's
 * parameter over by habit, and this saves a failed call.
 *
 * Only alias parameters that mean exactly the same thing. `topic_a` / `topic_b`,
 * `query` / `search_term` and `block_uuid` / `page_name` mean different things
 * and are never aliased.
 */
const PAGE_ALIASES = ['name', 'page'];

export const PARAM_ALIASES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  logseq_get_page: { page_name: PAGE_ALIASES },
  logseq_get_backlinks: { page_name: PAGE_ALIASES },
  logseq_build_context: { topic_name: [...PAGE_ALIASES, 'page_name'] },
  logseq_get_concept_network: { concept_name: [...PAGE_ALIASES, 'page_name'] },
  logseq_get_concept_evolution: { concept_name: [...PAGE_ALIASES, 'page_name'] },
  logseq_get_block: { block_uuid: ['uuid'] },
};

const present = (value: unknown) => value !== undefined && value !== null;
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Return `args` with every alias folded into its canonical parameter and the
 * alias keys removed. Other arguments pass through untouched.
 *
 * An alias and the canonical name (or two aliases) may both be given if they
 * carry the same value. Different values are ambiguous, and nothing is picked
 * silently: this throws InvalidParameterError.
 */
export function resolveParamAliases(
  tool: string,
  args: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const table = PARAM_ALIASES[tool];
  if (!args || !table) return args;

  const out: Record<string, unknown> = { ...args };
  for (const [canonical, aliases] of Object.entries(table)) {
    let chosenKey = present(args[canonical]) ? canonical : undefined;
    for (const alias of aliases) {
      delete out[alias];
      if (!present(args[alias])) continue;
      if (chosenKey === undefined) {
        chosenKey = alias;
        out[canonical] = args[alias];
      } else if (!same(args[chosenKey], args[alias])) {
        throw new InvalidParameterError(
          alias,
          JSON.stringify(args[alias]),
          `the same value as '${chosenKey}' (${JSON.stringify(args[chosenKey])}), or only one of them. '${alias}' is an alias of '${canonical}'`,
          `${canonical}: ${JSON.stringify(args[chosenKey])}`
        );
      }
    }
  }
  return out;
}
