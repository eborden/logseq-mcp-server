import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

// The summary skill must find the graph's journal title format instead of hardcoding one (#465): a link in another
// format makes LogSeq create a stub page. These pin the text that tells the model how, so a rewrite can't drop it.
const SKILL = join(fileURLToPath(new URL('../..', import.meta.url)), 'skills', 'logseq-skills');
const read = (path: string) => readFileSync(join(SKILL, path), 'utf-8');

describe('journal day links in the summary skill (#465)', () => {
  const reference = read('references/summary-compression.md');
  const section = reference.slice(reference.indexOf('## Journal Day Links'), reference.indexOf('## Reading the Period'));

  it('has a Journal Day Links section before the reading rules', () => {
    expect(reference).toContain('## Journal Day Links');
    expect(section.length).toBeGreaterThan(200);
  });

  it('reads the format from config.edn, skips commented lines, falls back to the default, and asks when unreadable', () => {
    expect(section).toContain('<graph>/logseq/config.edn');
    expect(section).toContain(':journal/page-title-format');
    expect(section).toMatch(/Skip commented lines/);
    expect(section).toContain('`MMM do, yyyy`');
    expect(section).toMatch(/cannot be read[\s\S]*ask the user/);
  });

  it('keeps the monthly Weekly YYYY-MM-DD links out of the journal title format', () => {
    expect(reference).toMatch(/`\[\[Weekly YYYY-MM-DD\]\]`, which are page names and not journal titles/);
  });

  it('labels the hardcoded examples as the default format only', () => {
    expect(reference).toMatch(/default title format \(`MMM do, yyyy`\) only/);
  });

  it('allows the one-key config.edn read under the query-first rule', () => {
    const reading = reference.slice(reference.indexOf('## Reading the Period'));
    expect(reading).toMatch(/One read is allowed besides the query[\s\S]*config\.edn/);
  });

  it('points the weekly sub-skill at the section', () => {
    const weekly = read('skills/weekly-summary.md');
    expect(weekly).toContain('Journal Day Links');
    expect(weekly).toContain(':journal/page-title-format');
  });
});
