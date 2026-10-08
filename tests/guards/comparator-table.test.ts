import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareResultBySuggestionRules, type ToolResult } from '../../scripts/parity/harness.js';
import { REPO_ROOT } from '../../scripts/parity/server-command.js';

// The Node harness's comparator (scripts/parity/harness.ts) and the cargo test's (rust/tests/parity_support/compare.rs)
// are two readings of one rule (#371): a JSON tool result by deep equality and minified, markdown, resources, prompts
// and the not-found frame byte for byte. This table of (expected, actual, verdict) is run by both, so a change to one
// comparator that the other doesn't follow fails here or in `cargo test --test parity`.

interface Row {
  name: string;
  expected: ToolResult;
  actual: ToolResult;
  verdict: 'same' | 'differs';
}

const table = JSON.parse(readFileSync(join(REPO_ROOT, 'rust', 'tests', 'data', 'comparator-cases.json'), 'utf8')) as Row[];

describe('the comparator table shared with rust/tests/parity.rs', () => {
  it('has rows of both verdicts, with unique names', () => {
    expect(new Set(table.map(row => row.verdict))).toEqual(new Set(['same', 'differs']));
    expect(new Set(table.map(row => row.name)).size).toBe(table.length);
  });

  it.each(table.map(row => [row.name, row] as const))('%s', (_name, row) => {
    const failures = compareResultBySuggestionRules(row.expected, row.actual, []);
    expect(failures.length === 0 ? 'same' : 'differs', failures.join('\n')).toBe(row.verdict);
  });
});
