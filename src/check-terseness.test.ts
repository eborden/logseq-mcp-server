import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// The summary gate (#185). check-terseness.sh is a read-only script that skills tell the agent to run before
// it reports a summary done. Besides the terseness budget it checks the page's `summary-source::` line, which records
// the roll-up of the logseq_query_by_date_range call the page was built from, so a summary written from
// journal files alone fails the workflow's own check. All pages below are made up.
const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'logseq-skills', 'scripts', 'check-terseness.sh');

const WEEKLY_SOURCE = 'summary-source:: query_by_date_range 20250106-20250110; days 5; blocks 250; top Project Atlas 12/4 | Alice 9/2';
const WEEKLY_TAGS =
  'tags:: [[Weekly Summary]], [[Jan 6th, 2025]], [[Jan 7th, 2025]], [[Jan 8th, 2025]], [[Jan 9th, 2025]], [[Jan 10th, 2025]]';
const MONTHLY_SOURCE = 'summary-source:: query_by_date_range 20250101-20250131; days 22; blocks 330; top none';

function page(tags: string, source: string | null, gist = '- **Week**: A made-up week.'): string {
  return [
    tags,
    ...(source === null ? [] : [source]),
    '',
    gist,
    '- ## Signals',
    '\t- Launch plan agreed, owner Alice, ship date moved to the 14th.',
    '\t- **Frustration:** Vendor still late, third request.',
    '- ## Unresolved',
    '\t- ((00000000-0000-4000-8000-000000000001))',
    '- ## Personal',
    '',
  ].join('\n');
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'check-terseness-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(name: string, text: string, ...flags: string[]) {
  const file = join(dir, name);
  writeFileSync(file, text);
  const r = spawnSync('bash', [script, ...flags, file], { encoding: 'utf-8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('check-terseness.sh source line (#185)', () => {
  it('passes a weekly page that records the roll-up', () => {
    const r = run('Weekly 2025-01-06.md', page(WEEKLY_TAGS, WEEKLY_SOURCE));
    expect(r.code).toBe(0);
    expect(r.out).toContain('source: query_by_date_range 20250106-20250110, 5 days, 250 blocks');
  });

  it('passes a monthly page that records the roll-up, with no top concepts', () => {
    const r = run('Monthly 2025-01.md', page('tags:: [[Monthly Summary]]', MONTHLY_SOURCE, '- **Month**: A made-up month.'));
    expect(r.code).toBe(0);
  });

  it('fails a page with no source line (a summary built from journal files alone)', () => {
    const r = run('Weekly 2025-01-06.md', page(WEEKLY_TAGS, null));
    expect(r.code).toBe(1);
    expect(r.out).toContain("no 'summary-source::' line");
    expect(r.out).toContain('logseq_query_by_date_range');
  });

  it('fails a source line that names files, and passes it only with --allow-files', () => {
    const files = page(WEEKLY_TAGS, 'summary-source:: files; tool call failed: connection refused');
    const strict = run('Weekly 2025-01-06.md', files);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain('source is journal files');
    const allowed = run('Weekly 2025-01-06.md', files, '--allow-files');
    expect(allowed.code).toBe(0);
    expect(allowed.out).toContain('WARN: source is journal files');
  });

  it('still fails an unrelated violation when --allow-files is given', () => {
    const r = run('Weekly 2025-01-06.md', page(WEEKLY_TAGS, 'summary-source:: files; x', '- **Week**: One. Two. Three.'), '--allow-files');
    expect(r.code).toBe(1);
    expect(r.out).toContain('gist is 3 sentences');
  });

  it.each([
    ['a malformed line', 'summary-source:: query_by_date_range 5 days'],
    ['no days', 'summary-source:: query_by_date_range 20250106-20250110; days 0; blocks 0; top none'],
    ['a malformed top list', 'summary-source:: query_by_date_range 20250106-20250110; days 5; blocks 250; top Project Atlas'],
    ['a range that ends before it starts', 'summary-source:: query_by_date_range 20250110-20250106; days 5; blocks 250; top none'],
  ])('fails %s', (_label, source) => {
    const r = run('Weekly 2025-01-06.md', page(WEEKLY_TAGS, source));
    expect(r.code).toBe(1);
  });

  it('fails a weekly source range that is not the page\'s week', () => {
    const r = run('Weekly 2025-01-13.md', page(WEEKLY_TAGS, WEEKLY_SOURCE));
    expect(r.code).toBe(1);
    expect(r.out).toContain('not inside the week of 20250113');
  });

  it('fails a monthly source range outside the month', () => {
    const r = run('Monthly 2025-02.md', page('tags:: [[Monthly Summary]]', MONTHLY_SOURCE, '- **Month**: A made-up month.'));
    expect(r.code).toBe(1);
    expect(r.out).toContain('not inside the month 202502');
  });

  it('passes namespaced and comma-bearing concept names in the top list', () => {
    const top = 'top Projects/Atlas 12/4 | Atlas, Inc 9/2 | Plan A/B 3/1';
    const r = run('Weekly 2025-01-06.md', page(WEEKLY_TAGS, `summary-source:: query_by_date_range 20250106-20250110; days 5; blocks 250; ${top}`));
    expect(r.code).toBe(0);
  });

  it.each([
    ['brackets', 'top [[Atlas]] 3/2'],
    ['a half bracket', 'top Atlas]] 3/2'],
    ['a hash', 'top #Atlas 3/2'],
    ['an entry with no counts', 'top Atlas 3/2 | Alice'],
  ])('fails a top list with %s', (_label, top) => {
    const r = run('Weekly 2025-01-06.md', page(WEEKLY_TAGS, `summary-source:: query_by_date_range 20250106-20250110; days 5; blocks 250; ${top}`));
    expect(r.code).toBe(1);
    expect(r.out).toContain("source 'top' must be");
  });

  it.each([['no reason', 'summary-source:: files'], ['an empty reason', 'summary-source:: files;'], ['a blank reason', 'summary-source:: files;   ']])(
    'fails a files source with %s, even with --allow-files',
    (_label, line) => {
      const r = run('Weekly 2025-01-06.md', page(WEEKLY_TAGS, line), '--allow-files');
      expect(r.code).toBe(1);
      expect(r.out).toContain("needs the reason");
    },
  );

  it.each([
    ['a range that runs past the week', '20250106-20250131'],
    ['a range that starts before the Monday', '20250105-20250110'],
    ['a range that ends in the next week', '20250106-20250113'],
    ['a month change', '20241230-20250103'],
  ])('fails a weekly page with %s', (_label, range) => {
    const r = run('Weekly 2025-01-06.md', page(WEEKLY_TAGS, `summary-source:: query_by_date_range ${range}; days 5; blocks 250; top none`));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not inside the week of 20250106|before it starts|starts/);
  });

  it('passes a partial week that ends midweek, and a Monday-to-Sunday range', () => {
    const mid = run('Weekly 2025-01-06.md', page(WEEKLY_TAGS, 'summary-source:: query_by_date_range 20250106-20250108; days 5; blocks 250; top none'));
    expect(mid.code).toBe(0);
    const sun = run('Weekly 2025-01-06.md', page(WEEKLY_TAGS, 'summary-source:: query_by_date_range 20250106-20250112; days 5; blocks 250; top none'));
    expect(sun.code).toBe(0);
  });

  it('checks a week that crosses a month boundary by date, not by string', () => {
    const tags = 'tags:: [[Weekly Summary]], [[Dec 30th, 2024]], [[Dec 31st, 2024]], [[Jan 1st, 2025]]';
    const ok = run('Weekly 2024-12-30.md', page(tags, 'summary-source:: query_by_date_range 20241230-20250103; days 3; blocks 40; top none'));
    expect(ok.code).toBe(0);
    const bad = run('Weekly 2024-12-30.md', page(tags, 'summary-source:: query_by_date_range 20241230-20250106; days 3; blocks 40; top none'));
    expect(bad.code).toBe(1);
  });

  it('fails a range with an impossible date', () => {
    const r = run('Weekly 2025-01-06.md', page(WEEKLY_TAGS, 'summary-source:: query_by_date_range 20250106-20251399; days 5; blocks 250; top none'));
    expect(r.code).toBe(1);
  });

  it('reads days and blocks as decimal, so a leading zero is not octal', () => {
    const r = run('Weekly 2025-01-06.md', page(WEEKLY_TAGS, 'summary-source:: query_by_date_range 20250106-20250110; days 08; blocks 0250; top none'));
    expect(r.out).not.toContain('value too great');
    expect(r.out).toContain('8 days, 250 blocks');
    expect(r.code).toBe(0);
  });

  it('fails a blocks count too long to be real instead of overflowing', () => {
    const r = run('Weekly 2025-01-06.md', page(WEEKLY_TAGS, 'summary-source:: query_by_date_range 20250106-20250110; days 5; blocks 99999999999999999999; top none'));
    expect(r.code).toBe(1);
    expect(r.out).toContain('malformed summary-source line');
  });

  it('does not accept the old source:: key', () => {
    const r = run('Weekly 2025-01-06.md', page(WEEKLY_TAGS, 'source:: query_by_date_range 20250106-20250110; days 5; blocks 250; top none'));
    expect(r.code).toBe(1);
    expect(r.out).toContain("no 'summary-source::' line");
  });

  it('warns, without failing, when the day links and the days disagree', () => {
    const r = run('Weekly 2025-01-06.md', page('tags:: [[Weekly Summary]], [[Jan 6th, 2025]]', WEEKLY_SOURCE));
    expect(r.code).toBe(0);
    expect(r.out).toContain('the tags line links 1 journal days but the source line says 5');
  });

  it('keeps the terseness checks: an em-dash still fails a page with a valid source line', () => {
    const text = page(WEEKLY_TAGS, WEEKLY_SOURCE).replace('Vendor still late', 'Vendor — still late');
    const r = run('Weekly 2025-01-06.md', text);
    expect(r.code).toBe(1);
    expect(r.out).toContain('em-dashes present');
  });
});
