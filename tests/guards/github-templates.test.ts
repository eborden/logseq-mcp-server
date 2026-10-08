import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

// Guard for the issue and PR templates in .github/ and the pointers to them in CLAUDE.md
// and docs/architecture-foundations.md. The templates are the source of truth for what an
// issue or PR body holds, so a heading that goes missing or a dead link fails here.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

// Headings an agent or reviewer relies on, in each template.
const REQUIRED: Record<string, string[]> = {
  '.github/ISSUE_TEMPLATE/task.md': [
    'Context', 'Scope', 'Out of scope', 'Where it lands', 'Constraints that apply',
    'Acceptance', 'Verification', 'Open questions', 'Definition of Ready',
  ],
  '.github/ISSUE_TEMPLATE/bug.md': [
    'What happened', 'What you expected', 'Reproduce', 'Environment', 'Acceptance for the fix',
  ],
  '.github/ISSUE_TEMPLATE/plan.md': [
    'Goal', 'Decisions', 'Non-goals', 'Current state', 'Exit criteria', 'Open questions',
  ],
  '.github/ISSUE_TEMPLATE/proposal.md': [
    'Problem', 'Options considered', 'Recommendation', 'Consequences',
    'Mechanical enforcement', 'Acceptance',
  ],
  // The handoff sections from docs/architecture-foundations.md section 6.
  '.github/pull_request_template.md': [
    'What changed', 'Design', 'Assumptions', 'Failure behavior', 'Preserved on purpose / questions',
    'New concepts', 'Test plan', 'Roll back',
  ],
};

const headings = (text: string): string[] =>
  [...text.matchAll(/^#{2,3} (.+)$/gm)].map(m => m[1].trim());

describe('issue and PR templates', () => {
  it.each(Object.entries(REQUIRED))('%s has its required headings', (file, wanted) => {
    expect(headings(read(file))).toEqual(expect.arrayContaining(wanted));
  });

  it.each(Object.keys(REQUIRED).filter(f => f.includes('ISSUE_TEMPLATE')))(
    '%s has front matter with a name, about and label', file => {
      const fm = read(file).match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
      expect(fm).toMatch(/^name: .+/m);
      expect(fm).toMatch(/^about: .+/m);
      expect(fm).toMatch(/^labels: .+/m);
    });

  it.each(Object.keys(REQUIRED))('%s carries the privacy reminder', file => {
    expect(read(file)).toMatch(/PRIVACY|personal graph/);
  });

  it('turns blank issues off so every issue picks a template', () => {
    expect(read('.github/ISSUE_TEMPLATE/config.yml')).toMatch(/^blank_issues_enabled: false$/m);
  });

  it('keeps sub-issue and blocked-by edges out of the issue bodies', () => {
    // They live in GitHub's fields; the templates must not ask for a text copy.
    expect(read('.github/ISSUE_TEMPLATE/plan.md')).not.toMatch(/^#{2,3} (Sub-issues|Waves|Order)/m);
    expect(read('.github/ISSUE_TEMPLATE/task.md')).not.toMatch(/^#{2,3} (Order|Blocked by)/m);
  });
});

describe('pointers to the templates', () => {
  it('CLAUDE.md links to every template, and each link resolves', () => {
    const claude = read('CLAUDE.md');
    for (const file of Object.keys(REQUIRED)) {
      expect(claude, file).toContain(`(${file})`);
      expect(existsSync(join(ROOT, file)), file).toBe(true);
    }
  });

  it('architecture-foundations.md section 6 points at the PR template', () => {
    const doc = read('docs/architecture-foundations.md');
    expect(doc).toContain('(../.github/pull_request_template.md)');
  });
});
