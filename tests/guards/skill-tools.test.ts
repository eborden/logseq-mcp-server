import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import {
  markdownFiles,
  schemaMismatch,
  skillViolations,
  type CheckOptions,
  type RecordedTool,
} from './skill-tools-check.js';

/**
 * The skills name only real tools, and their JSON examples validate against the tool's inputSchema (#486, part of #500).
 *
 * The server instructions (rust/src/instructions.rs) and the prompts (rust/src/prompts.rs) have tests that fail on a
 * tool name that doesn't exist. The skills in skills/logseq-skills/ had none, and their examples were positional
 * pseudo-calls that hide the parameter names, which are what models get wrong. The recorded tool list,
 * rust/tests/data/parity/tool-list.json, is the contract, so each rename of the v2 plan fails here until the skills
 * move in the same PR. Over every .md file under skills/logseq-skills/:
 *   1. every `logseq_[a-z0-9_]+` token names a recorded tool. Host-prefixed forms (`mcp__<server>__logseq_x`) count as
 *      `logseq_x`;
 *   2. every recorded tool has a section heading in the tool reference (TOOL_REFERENCE_PATHS), the heading text being exactly the tool name;
 *   3. every fenced block (``` or ~~~) whose info string is `json tool=logseq_<name>` parses as a JSON object and
 *      validates against that tool's inputSchema (a fence that says `tool=` any other way is an error, not a skip):
 *      required properties present, no property outside `properties`,
 *      and primitive types, enums, bounds and lengths matched, with any other schema keyword reported. The validator is hand-rolled (foundations 4.11, no new dependency);
 *   4. every tool has at least MIN_EXAMPLES_PER_TOOL such examples.
 * A failure names the file, the line and the bad token or argument.
 *
 * MIN_EXAMPLES_PER_TOOL is 0 here. #497 (the skills rewrite) is the switch: it raises the constant to 2, and in the
 * same PR adds the logseq_get_graph_info section and deletes its MISSING_SECTION_ALLOWANCES entry.
 * Skills aren't edited by this guard (ADR-0024), so MISSING_SECTION_ALLOWANCES lists the section gaps that exist on
 * main. An entry may only be removed: the guard fails once the heading exists, so the entry is deleted with it.
 */

const SKILLS_DIR = fileURLToPath(new URL('../../skills/logseq-skills', import.meta.url));
const TOOL_LIST_FILE = new URL('../../rust/tests/data/parity/tool-list.json', import.meta.url);

/** The skill's tool reference, relative to SKILLS_DIR. A constant so #497 can split the file by type. */
const TOOL_REFERENCE_PATHS: readonly string[] = ['references/mcp-tools-reference.md'];

/** The minimum number of `json tool=<name>` examples per tool. 0 until #497 raises it to 2. */
const MIN_EXAMPLES_PER_TOOL = 0;

/**
 * Tools the tool reference has no heading for on main (it notes `logseq_get_graph_info` in prose only). Skill edits
 * are out of scope for #486 (ADR-0024); the section lands with the skills rewrite (#497), which deletes this entry.
 */
const MISSING_SECTION_ALLOWANCES: readonly string[] = ['logseq_get_graph_info'];

describe('the skills name only real tools (#486)', () => {
  const tools = JSON.parse(readFileSync(TOOL_LIST_FILE, 'utf-8')) as RecordedTool[];
  const files = markdownFiles(SKILLS_DIR)
    .sort()
    .map(full => ({ path: relative(SKILLS_DIR, full), text: readFileSync(full, 'utf-8') }));
  const real: CheckOptions = {
    referencePaths: TOOL_REFERENCE_PATHS,
    minExamples: MIN_EXAMPLES_PER_TOOL,
    missingSectionAllowances: MISSING_SECTION_ALLOWANCES,
  };

  it('finds the skill files, the tool reference and the recorded tools', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const p of TOOL_REFERENCE_PATHS) expect(files.map(f => f.path)).toContain(p);
    expect(tools.length).toBeGreaterThan(0);
  });

  it('names only recorded tools, documents each, and validates every json tool= example', () => {
    expect(skillViolations(files, tools, real), 'skills/logseq-skills/ breaks the tool contract').toEqual([]);
  });
});

// Each rule must be able to fail, or the guard above proves nothing. These run the same checker over made-up skills.
describe('the skills guard can fail (#486 self-test)', () => {
  const tools: RecordedTool[] = [
    {
      name: 'logseq_get_thing',
      inputSchema: {
        type: 'object',
        required: ['thing_name'],
        properties: {
          thing_name: { type: 'string', minLength: 1, maxLength: 10 },
          depth: { type: 'integer', minimum: 1, maximum: 5, default: 2, description: 'Depth', format: 'uint64' },
          ratio: { type: 'number' },
          verbose: { type: 'boolean' },
          format: { type: 'string', enum: ['json', 'markdown'] },
          filter: { type: ['string', 'null'] },
          value: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
        },
      },
    },
    { name: 'logseq_get_other', inputSchema: { type: 'object', properties: {} } },
  ];
  const options: CheckOptions = { referencePaths: ['ref.md'], minExamples: 0, missingSectionAllowances: [] };
  const reference = '### logseq_get_thing\n\n### logseq_get_other\n';
  const example = (json: string, info = 'json tool=logseq_get_thing'): string => '```' + info + '\n' + json + '\n```\n';
  const run = (text: string, opts: Partial<CheckOptions> = {}) =>
    skillViolations([{ path: 'ref.md', text: reference }, { path: 'skill.md', text }], tools, { ...options, ...opts });

  it('passes a clean skill, including a nullable, an anyOf, an enum and a host-prefixed name', () => {
    const text =
      'Call `mcp__plugin_logseq_logseq__logseq_get_thing` or `logseq_get_other`.\n\n' +
      example('{"thing_name": "Alice", "depth": 2, "ratio": 0.5, "verbose": true, "format": "json", "filter": null, "value": 3}');
    expect(run(text)).toEqual([]);
  });

  it('flags an unknown tool name with its file and line', () => {
    expect(run('Intro.\nUse `logseq_get_widget` here.\n')).toEqual([
      'skill.md:2: "logseq_get_widget" is not a tool in tool-list.json',
    ]);
  });

  it('flags an unknown host-prefixed tool name as its bare name', () => {
    expect(run('`mcp__logseq__logseq_get_widget`\n')).toEqual([
      'skill.md:1: "logseq_get_widget" is not a tool in tool-list.json',
    ]);
  });

  it('reads a digit as part of a tool name, so a half-matched name is flagged whole', () => {
    expect(run('`logseq_get_thing2` and `logseq_get_thing_v2`\n')).toEqual([
      'skill.md:1: "logseq_get_thing2" is not a tool in tool-list.json',
      'skill.md:1: "logseq_get_thing_v2" is not a tool in tool-list.json',
    ]);
  });

  it('flags a tool with no section heading, and a heading only in prose', () => {
    const files = [{ path: 'ref.md', text: '### logseq_get_thing\n\nlogseq_get_other is described later.\n' }];
    expect(skillViolations(files, tools, options)).toEqual(['ref.md: no section heading for logseq_get_other']);
  });

  it('counts only a heading that is exactly the tool name, in backticks or host-prefixed', () => {
    const prose = '### logseq_get_thing\n\n## Tool Selection: when to avoid logseq_get_other\n';
    expect(skillViolations([{ path: 'ref.md', text: prose }], tools, options)).toEqual([
      'ref.md: no section heading for logseq_get_other',
    ]);
    const forms = '# `logseq_get_thing`\n\n#### mcp__plugin_logseq_logseq__logseq_get_other  \n';
    expect(skillViolations([{ path: 'ref.md', text: forms }], tools, options)).toEqual([]);
  });

  it('does not let an incidental heading expire an allowance', () => {
    const files = [{ path: 'ref.md', text: '### logseq_get_thing\n## Why to skip logseq_get_other\n' }];
    expect(skillViolations(files, tools, { ...options, missingSectionAllowances: ['logseq_get_other'] })).toEqual([]);
  });

  it('does not take a heading inside a code fence for a section', () => {
    const files = [{ path: 'ref.md', text: '### logseq_get_thing\n```\n### logseq_get_other\n```\n' }];
    expect(skillViolations(files, tools, options)).toEqual(['ref.md: no section heading for logseq_get_other']);
  });

  it('lets an allowed section gap pass, and fails once the heading exists or the name is not a tool', () => {
    const gap = [{ path: 'ref.md', text: '### logseq_get_thing\n' }];
    const allow = { ...options, missingSectionAllowances: ['logseq_get_other'] };
    expect(skillViolations(gap, tools, allow)).toEqual([]);
    expect(skillViolations([{ path: 'ref.md', text: reference }], tools, allow)).toEqual([
      'ref.md: logseq_get_other now has a heading, so delete it from MISSING_SECTION_ALLOWANCES',
    ]);
    expect(skillViolations(gap, tools, { ...allow, missingSectionAllowances: ['logseq_get_other', 'logseq_gone'] })).toEqual([
      'MISSING_SECTION_ALLOWANCES names "logseq_gone", which is not a tool in tool-list.json',
    ]);
  });

  it('flags an example with a missing required argument', () => {
    expect(run('Text\n' + example('{"depth": 2}'))).toEqual([
      'skill.md:2: the logseq_get_thing example is missing the required argument "thing_name"',
    ]);
  });

  it('flags an example with an argument outside the inputSchema, on the line that has it', () => {
    expect(run(example('{\n  "thing_name": "Alice",\n  "topic": "x"\n}'))).toEqual([
      'skill.md:4: the logseq_get_thing example has an argument "topic" that is not in its inputSchema',
    ]);
  });

  it('flags a wrong type, a fractional integer and a value outside an enum', () => {
    expect(run(example('{"thing_name": 5}'))).toEqual([
      'skill.md:2: the logseq_get_thing argument "thing_name" is wrong: expected string, got number',
    ]);
    expect(run(example('{"thing_name": "a", "depth": 1.5}'))).toEqual([
      'skill.md:2: the logseq_get_thing argument "depth" is wrong: expected integer, got number',
    ]);
    expect(run(example('{"thing_name": "a", "format": "toon"}'))).toEqual([
      'skill.md:2: the logseq_get_thing argument "format" is wrong: "toon" is not one of "json", "markdown"',
    ]);
  });

  it('blames the line where the argument is a key, not an earlier value that equals it', () => {
    expect(run(example('{\n  "thing_name": "format",\n  "format": "xml"\n}'))).toEqual([
      'skill.md:4: the logseq_get_thing argument "format" is wrong: "xml" is not one of "json", "markdown"',
    ]);
    expect(run(example('{"thing_name": "format", "format": "xml"}'))).toEqual([
      'skill.md:2: the logseq_get_thing argument "format" is wrong: "xml" is not one of "json", "markdown"',
    ]);
  });

  it('flags a value that matches none of an anyOf, and null where the type is not nullable', () => {
    expect(run(example('{"thing_name": "a", "value": null}'))[0]).toContain('matches none of the allowed types');
    expect(run(example('{"thing_name": "a", "depth": null}'))).toEqual([
      'skill.md:2: the logseq_get_thing argument "depth" is wrong: expected integer, got null',
    ]);
  });

  it('flags JSON that does not parse, and JSON that is not an object', () => {
    expect(run(example('{"thing_name": '))[0]).toMatch(/^skill\.md:1: the logseq_get_thing example is not valid JSON/);
    expect(run(example('["Alice"]'))).toEqual(['skill.md:1: the logseq_get_thing example must be a JSON object of arguments']);
  });

  it('flags an info string that names no tool, a non-tool name, an unclosed block and an unknown tool', () => {
    expect(run(example('{}', 'json tool='))).toEqual([
      'skill.md:1: the info string "json tool=" must be exactly "json tool=logseq_<name>"',
    ]);
    expect(run(example('{}', 'json tool=get_thing'))).toEqual(['skill.md:1: tool=get_thing is not a logseq_ tool name']);
    expect(run('```json tool=logseq_get_thing\n{"thing_name": "a"}\n')).toEqual([
      'skill.md:1: the logseq_get_thing example has no closing fence',
    ]);
    expect(run(example('{}', 'json tool=logseq_get_widget'))).toEqual([
      'skill.md:1: "logseq_get_widget" is not a tool in tool-list.json',
    ]);
  });

  it('treats a fence that is meant as an example but tagged slightly wrong as an error, not a skip', () => {
    const bad = '{"thing_name": "a", "topic": "x"}';
    for (const info of [
      'JSON tool=logseq_get_thing',
      'jsonc tool=logseq_get_thing',
      'tool=logseq_get_thing json',
      'json tools=logseq_get_thing',
      'text tool=logseq_get_thing',
      'json logseq_get_thing',
    ]) {
      expect(run(example(bad, info)), info).toEqual([
        `skill.md:1: the info string "${info}" must be exactly "json tool=logseq_<name>"`,
      ]);
    }
  });

  it('tracks tilde fences and longer backtick fences, for examples, closings and headings', () => {
    const bad = '{"thing_name": "a", "topic": "x"}';
    const tilde = '~~~json tool=logseq_get_thing\n' + bad + '\n~~~\n';
    expect(run(tilde)).toEqual(['skill.md:2: the logseq_get_thing example has an argument "topic" that is not in its inputSchema']);
    // A four-backtick fence holds a three-backtick line without closing, so the heading after it is still inside.
    const outer = [{ path: 'ref.md', text: '### logseq_get_thing\n````md\n```\n### logseq_get_other\n````\n' }];
    expect(skillViolations(outer, tools, options)).toEqual(['ref.md: no section heading for logseq_get_other']);
    // A heading inside a tilde fence is not a section.
    const files = [{ path: 'ref.md', text: '### logseq_get_thing\n~~~\n### logseq_get_other\n~~~\n' }];
    expect(skillViolations(files, tools, options)).toEqual(['ref.md: no section heading for logseq_get_other']);
    expect(run('~~~json tool=logseq_get_thing\n{"thing_name": "a"}\n~~~\n')).toEqual([]);
  });

  it('does not treat an untagged json block as an example', () => {
    expect(run('```json\n{"anything": true}\n```\n')).toEqual([]);
  });

  it('enforces the minimum number of examples per tool', () => {
    const one = example('{"thing_name": "a"}');
    expect(run(one, { minExamples: 1 })).toEqual(['logseq_get_other has 0 "json tool=logseq_get_other" examples, the minimum is 1']);
    expect(run(one, { minExamples: 2 })).toEqual([
      'logseq_get_thing has 1 "json tool=logseq_get_thing" examples, the minimum is 2',
      'logseq_get_other has 0 "json tool=logseq_get_other" examples, the minimum is 2',
    ]);
  });

  it('flags a number below the minimum or above the maximum, and a string outside its length bounds', () => {
    expect(run(example('{"thing_name": "a", "depth": 0}'))).toEqual([
      'skill.md:2: the logseq_get_thing argument "depth" is wrong: 0 is below the minimum of 1',
    ]);
    expect(run(example('{"thing_name": "a", "depth": 6}'))).toEqual([
      'skill.md:2: the logseq_get_thing argument "depth" is wrong: 6 is above the maximum of 5',
    ]);
    expect(run(example('{"thing_name": "a very long name"}'))[0]).toContain('above the maxLength of 10');
    expect(run(example('{"thing_name": ""}'))[0]).toContain('below the minLength of 1');
    expect(run(example('{"thing_name": "a", "depth": 1}'))).toEqual([]);
  });

  it('reports a constraint keyword it does not know instead of passing it, and ignores the descriptive ones', () => {
    expect(schemaMismatch('a', { type: 'string', pattern: '^a$' })).toBe(
      'the schema uses "pattern", which this guard cannot check',
    );
    expect(schemaMismatch('a', { type: 'string', multipleOf: 2, items: {} })).toContain('"multipleOf", "items"');
    expect(schemaMismatch(1, { type: 'integer', title: 'T', description: 'd', default: 1, format: 'uint64', $schema: 's' })).toBe(null);
  });

  it('reports a schema it cannot check instead of passing it', () => {
    expect(schemaMismatch(1, {})).toContain('cannot check');
    expect(schemaMismatch([], { type: 'array' })).toContain('cannot check');
  });
});
