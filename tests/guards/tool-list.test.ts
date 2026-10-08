import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import type { ProjectedTool } from '../../scripts/parity/tool-list-compare.js';
import {
  approxTokens,
  DESCRIPTION_ALLOWANCES,
  DESCRIPTION_CAP,
  NON_IDEMPOTENT,
  PARAM_ALIASES,
  TOOL_LIST_BUDGET_CHARS,
} from './tool-list-limits.js';

/**
 * Guardrails on the `tools/list` payload (#39, part of #13, kept by #356).
 *
 * Every session pays for this payload in context, so growth should be a deliberate choice. The recorded list,
 * scripts/parity/expected/tool-list.json, is the contract: the parity harness holds the Rust server's `tools/list`
 * to it by meaning (ADR-0031), and these checks hold the recorded list to the rules that outlived the TypeScript
 * server it was recorded from (`tests/rust-guards/tool-list-live.test.ts` holds the live list to the budget and the cap):
 *   1. a size budget on the whole serialized tool list (ADR-0016),
 *   2. a per-tool description length cap (ADR-0016),
 *   3. every description says what the tool can't find (ADR-0015),
 *   4. the tool count, and read-only annotations on every tool (ADR-0008, ADR-0001).
 * A change to a name, description or schema is a change to that file, and shows up in review as a JSON diff.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TOOL_LIST_FILE = new URL('../../scripts/parity/expected/tool-list.json', import.meta.url);
type RecordedTool = ProjectedTool & {
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema?: { properties?: Record<string, { default?: unknown }>; required?: string[] };
};
const tools = JSON.parse(readFileSync(TOOL_LIST_FILE, 'utf-8')) as RecordedTool[];

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
  describe('what the recorded list keeps true (ADR-0010, ADR-0020, BR-0008, BR-0012)', () => {
    // A re-record from Rust (`--record-from-rust`, #299) rewrites the recorded list, and the by-meaning comparison
    // passes whatever it says. These hold what the TypeScript tests asserted directly, so a re-record that drops
    // one fails here.
    it('advertises default: true on every slim_results parameter', () => {
      const slim = tools.filter(tool => tool.inputSchema?.properties?.slim_results);
      expect(slim.length, 'some tool takes slim_results').toBeGreaterThan(0);
      for (const tool of slim) {
        expect(tool.inputSchema!.properties!.slim_results.default, `${tool.name}: slim_results defaults to true (BR-0012)`).toBe(true);
      }
    });

    it('keeps the canonical parameter required on every aliased tool, and advertises no alias', () => {
      for (const [name, { canonical, aliases }] of Object.entries(PARAM_ALIASES)) {
        const tool = tools.find(t => t.name === name);
        expect(tool, `${name} is a recorded tool`).toBeDefined();
        expect(tool!.inputSchema?.required, `${name}: ${canonical} stays required`).toContain(canonical);
        const advertised = Object.keys(tool!.inputSchema?.properties ?? {});
        expect(advertised, `${name} advertises ${canonical}`).toContain(canonical);
        for (const alias of aliases) {
          expect(advertised, `${name} must not advertise the alias ${alias} (BR-0008)`).not.toContain(alias);
          expect(tool!.inputSchema?.required ?? [], `${name}: ${alias} is not required`).not.toContain(alias);
        }
      }
    });

    it('lists, in PARAM_ALIASES, exactly the aliases the Rust tools read', () => {
      const toolsDir = join(ROOT, 'rust', 'src', 'tools');
      const found: Record<string, { canonical: string; aliases: string[] }> = {};
      for (const dir of readdirSync(toolsDir).filter(entry => statSync(join(toolsDir, entry)).isDirectory())) {
        const source = readFileSync(join(toolsDir, dir, 'mod.rs'), 'utf-8');
        const declared = /const ALIASES: ParamAliases = &\[\("([a-z_]+)", &\[([^\]]*)\]\)\];/.exec(source);
        if (!declared) continue;
        found[`logseq_${dir}`] = { canonical: declared[1], aliases: [...declared[2].matchAll(/"([a-z_]+)"/g)].map(m => m[1]) };
      }
      expect(found).toEqual(PARAM_ALIASES);
    });
  });

  describe('one module per tool (ADR-0005)', () => {
    it('has exactly one module in rust/src/tools for each recorded tool, and no other', () => {
      const toolsDir = join(ROOT, 'rust', 'src', 'tools');
      const modules = readdirSync(toolsDir).filter(entry => entry !== 'mod.rs').sort();
      // A second implementation of a tool (a `*_http` or `*_datalog` module, or any extra module) would be listed here
      expect(modules).toEqual(tools.map(tool => tool.name.replace(/^logseq_/, '')).sort());
      for (const module of modules) {
        expect(statSync(join(toolsDir, module)).isDirectory(), `${module} is a directory module`).toBe(true);
        expect(readdirSync(join(toolsDir, module)), `${module} has its mod.rs`).toContain('mod.rs');
      }
    });
  });
});
