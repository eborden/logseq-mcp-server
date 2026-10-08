import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import type { ProjectedTool } from '../../scripts/parity/tool-list-compare.js';

/**
 * Guardrails on the `tools/list` payload (#39, part of #13, kept by #356).
 *
 * Every session pays for this payload in context, so growth should be a deliberate choice. The recorded list,
 * scripts/parity/expected/tool-list.json, is the contract: the parity harness holds the Rust server's `tools/list`
 * to it by meaning (ADR-0031), and these checks hold the recorded list to the rules that outlived the TypeScript
 * server it was recorded from:
 *   1. a size budget on the whole serialized tool list (ADR-0016),
 *   2. a per-tool description length cap (ADR-0016),
 *   3. every description says what the tool can't find (ADR-0015),
 *   4. the tool count, and read-only annotations on every tool (ADR-0008, ADR-0001).
 * A change to a name, description or schema is a change to that file, and shows up in review as a JSON diff.
 */

const TOOL_LIST_FILE = new URL('../../scripts/parity/expected/tool-list.json', import.meta.url);
const tools = JSON.parse(readFileSync(TOOL_LIST_FILE, 'utf-8')) as Array<ProjectedTool & { title?: string; description?: string; annotations?: Record<string, unknown> }>;

/**
 * Budget for `JSON.stringify(tools)`, in characters (the recorded list serializes to about 18,760 across 16 tools).
 * The history of the number is in `git log -p` of `src/tool-list.test.ts` before #356: it was set when the list was
 * about 16,000 characters, raised once to 19,700 for the #61 caps, and has about 940 characters of headroom now.
 *
 * To raise it deliberately: change this constant in the PR that grows the tool list, and say in the PR
 * description why the extra tokens are worth paying for every session.
 */
const TOOL_LIST_BUDGET_CHARS = 19_700;

/** Rough token estimate. English text and JSON average about 4 characters per token. */
const CHARS_PER_TOKEN = 4;
const approxTokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);

/** Maximum length of a tool's `description` text (the input schema is not counted). */
const DESCRIPTION_CAP = 400;

/**
 * Tools whose descriptions are allowed to exceed the cap. Empty since #44 trimmed every description to fit.
 * Each value would be that tool's length when listed, as a ceiling, not a target: it may shrink but must not
 * grow. When you trim a listed tool below DESCRIPTION_CAP, delete its entry (a test below fails on stale
 * entries). New tools get no allowance, so they must fit in the cap.
 */
const DESCRIPTION_ALLOWANCES: Record<string, number> = {};

/** Tools that read what the person has open in LogSeq: read-only, but their answer changes between calls. */
const NON_IDEMPOTENT = ['logseq_get_current_context'];

describe('tools/list guardrails', () => {
  it('lists the 16 tools, once each, with the logseq_ prefix', () => {
    expect(tools).toHaveLength(16);
    expect(new Set(tools.map(t => t.name)).size).toBe(16);
    for (const tool of tools) expect(tool.name, tool.name).toMatch(/^logseq_[a-z_]+$/);
  });

  it('stays within the token budget', () => {
    const size = JSON.stringify(tools).length;
    expect(
      size,
      `The tools/list payload is ${size} characters (about ${approxTokens(size)} tokens), over the budget of ` +
        `${TOOL_LIST_BUDGET_CHARS} characters (about ${approxTokens(TOOL_LIST_BUDGET_CHARS)} tokens). ` +
        'Every session pays for this, so first try trimming descriptions or parameter docs. ' +
        'If the growth is worth it, raise TOOL_LIST_BUDGET_CHARS in tests/guards/tool-list.test.ts ' +
        'and justify the increase in the PR description.'
    ).toBeLessThanOrEqual(TOOL_LIST_BUDGET_CHARS);
  });

  it("says what each tool can't find (#44)", () => {
    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a "Can't find" line`).toMatch(/Can't find/);
    }
  });

  describe('description length', () => {
    it('keeps every description within its cap', () => {
      for (const tool of tools) {
        const length = (tool.description ?? '').length;
        const cap = DESCRIPTION_ALLOWANCES[tool.name] ?? DESCRIPTION_CAP;
        expect(
          length,
          `${tool.name} has a ${length}-character description, over its cap of ${cap}. ` +
            `New descriptions should fit in ${DESCRIPTION_CAP} characters. Move detail into parameter ` +
            'descriptions or tool output. Tools listed in DESCRIPTION_ALLOWANCES may shrink but not grow.'
        ).toBeLessThanOrEqual(cap);
      }
    });

    it('has no stale allowances', () => {
      const lengths = new Map(tools.map(t => [t.name, (t.description ?? '').length]));
      for (const name of Object.keys(DESCRIPTION_ALLOWANCES)) {
        const length = lengths.get(name);
        expect(length, `DESCRIPTION_ALLOWANCES lists ${name}, which is not a registered tool. Remove the entry.`).toBeDefined();
        expect(
          length!,
          `${name} is now ${length} characters, within the ${DESCRIPTION_CAP} cap. Remove its entry from DESCRIPTION_ALLOWANCES.`
        ).toBeGreaterThan(DESCRIPTION_CAP);
      }
    });
  });

  describe('annotations (ADR-0001, BR-0002)', () => {
    it('marks every tool read-only, with a title', () => {
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint, `${tool.name} must set readOnlyHint: true`).toBe(true);
        expect(typeof tool.annotations?.title, `${tool.name} needs a title annotation`).toBe('string');
        expect(tool.title, `${tool.name}'s title and its annotation title agree`).toBe(tool.annotations?.title);
      }
    });

    it('declares every other tool non-destructive, idempotent and closed-world, and the UI-state tool non-idempotent', () => {
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toMatchObject({
          destructiveHint: false,
          idempotentHint: !NON_IDEMPOTENT.includes(tool.name),
          openWorldHint: false,
        });
      }
    });
  });
});
