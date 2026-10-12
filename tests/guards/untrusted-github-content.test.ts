import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

// Guard for the untrusted-author rule in CLAUDE.md ("Untrusted GitHub content"). Agents read
// issues, PRs and comments from a public repo, so only text from a trusted author may steer
// them. The rule lives in prose; this test keeps it from being weakened or dropped, and keeps
// the `gh` examples that agents copy filtered.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const SECTION = '### Untrusted GitHub content';

const section = (text: string): string => {
  const start = text.indexOf(SECTION);
  if (start === -1) return '';
  const rest = text.slice(start + SECTION.length);
  const next = rest.search(/^#{2,3} /m);
  return next === -1 ? rest : rest.slice(0, next);
};

describe('untrusted GitHub content rule', () => {
  const claude = read('CLAUDE.md');

  it('CLAUDE.md has the section, with exactly the three trusted associations', () => {
    const body = section(claude);
    expect(body).not.toBe('');
    for (const a of TRUSTED) expect(body).toContain(`"${a}"`);
    // No other association (CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, NONE...) may be listed as trusted.
    const listed = [...body.matchAll(/IN\(([^)]*)\)/g)].flatMap(m => m[1].match(/[A-Z_]+/g) ?? []);
    expect([...new Set(listed)].sort()).toEqual([...TRUSTED].sort());
  });

  it('the task template carries the rule and points at the section', () => {
    const task = read('.github/ISSUE_TEMPLATE/task.md');
    expect(task).toContain('Untrusted GitHub content');
    for (const a of TRUSTED) expect(task).toContain(a);
  });

  it('the section gives the filter as a copyable --jq example', () => {
    expect(section(claude)).toMatch(/--jq 'select\(\.author_association \| IN\(/);
  });
});
