/**
 * The limits ADR-0016 puts on the `tools/list` payload, shared by the two tests that hold a list to them:
 * `tests/guards/tool-list.test.ts` (the recorded list, scripts/parity/expected/tool-list.json) and
 * `tests/rust-guards/tool-list-live.test.ts` (the Rust server's own list, which is what a client receives).
 */

/**
 * Budget for `JSON.stringify(tools)`, in characters. The recorded list serializes to 18,763 across 16 tools, but that
 * is not what a client receives: the Rust server spells its schemas its own way (`format: "uint32"` on every count and
 * so on, which the by-meaning comparison drops, ADR-0031), and its live list serializes to 19,383. So the real payload
 * has about 317 characters of headroom under this budget, not the 937 the recorded list leaves.
 *
 * The history of the number is in the version of `src/tool-list.test.ts` at commit `10103c8`: it was set when the list
 * was about 16,000 characters and raised once to 19,700 for the #61 caps.
 *
 * To raise it deliberately: change this constant in the PR that grows the tool list, and say in the PR
 * description why the extra tokens are worth paying for every session.
 */
export const TOOL_LIST_BUDGET_CHARS = 19_700;

/** Rough token estimate. English text and JSON average about 4 characters per token. */
export const CHARS_PER_TOKEN = 4;
export const approxTokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);

/** Maximum length of a tool's `description` text (the input schema is not counted). */
export const DESCRIPTION_CAP = 400;

/**
 * Tools whose descriptions are allowed to exceed the cap. Empty since #44 trimmed every description to fit.
 * Each value would be that tool's length when listed, as a ceiling, not a target: it may shrink but must not
 * grow. When you trim a listed tool below DESCRIPTION_CAP, delete its entry (a test fails on stale
 * entries). New tools get no allowance, so they must fit in the cap.
 */
export const DESCRIPTION_ALLOWANCES: Record<string, number> = {};

/** Tools that read what the person has open in LogSeq: read-only, but their answer changes between calls. */
export const NON_IDEMPOTENT = ['logseq_get_current_context'];

/**
 * The parameter aliases of the tools that take them (BR-0008): each tool's canonical parameter, and the other names the
 * server also reads. The canonical name stays `required` in the schema and no alias is advertised. This table is
 * checked against the `ALIASES` constants in `rust/src/tools/*\/mod.rs` by `tests/guards/tool-list.test.ts`, so it can't
 * drift from the code.
 */
export const PARAM_ALIASES: Record<string, { canonical: string; aliases: string[] }> = {
  logseq_build_context: { canonical: 'topic_name', aliases: ['name', 'page', 'page_name'] },
  logseq_get_backlinks: { canonical: 'page_name', aliases: ['name', 'page'] },
  logseq_get_block: { canonical: 'block_uuid', aliases: ['uuid'] },
  logseq_get_concept_evolution: { canonical: 'concept_name', aliases: ['name', 'page', 'page_name'] },
  logseq_get_concept_network: { canonical: 'concept_name', aliases: ['name', 'page', 'page_name'] },
  logseq_get_page: { canonical: 'page_name', aliases: ['name', 'page'] },
  logseq_get_page_outline: { canonical: 'page_name', aliases: ['name', 'page'] },
};
