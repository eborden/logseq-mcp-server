import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// The summary gate (#185). check-terseness.sh is a read-only script that skills tell the agent to run before
// it reports a summary done. Besides the terseness budget it checks the page's `source::` line, which records
// the roll-up of the logseq_query_by_date_range call the page was built from, so a summary written from
// journal files alone fails the workflow's own check. All pages below are made up.
const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'logseq-skills', 'scripts', 'check-terseness.sh');

const WEEKLY_SOURCE = 'source:: query_by_date_range 20250106-20250110; days 5; blocks 250; top Project Atlas 12/4, Alice 9/2';
const WEEKLY_TAGS =
  'tags:: [[Weekly Summary]], [[Jan 6th, 2025]], [[Jan 7th, 2025]], [[Jan 8th, 2025]], [[Jan 9th, 2025]], [[Jan 10th, 2025]]';
const MONTHLY_SOURCE = 'source:: query_by_date_range 20250101-20250131; days 22; blocks 330; top none';

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
    expect(r.out).toContain("no 'source::' line");
    expect(r.out).toContain('logseq_query_by_date_range');
  });

  it('fails a source line that names files, and passes it only with --allow-files', () => {
    const files = page(WEEKLY_TAGS, 'source:: files; tool call failed: connection refused');
    const strict = run('Weekly 2025-01-06.md', files);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain('source is journal files');
    const allowed = run('Weekly 2025-01-06.md', files, '--allow-files');
    expect(allowed.code).toBe(0);
    expect(allowed.out).toContain('WARN: source is journal files');
  });

  it('still fails an unrelated violation when --allow-files is given', () => {
    const r = run('Weekly 2025-01-06.md', page(WEEKLY_TAGS, 'source:: files; x', '- **Week**: One. Two. Three.'), '--allow-files');
    expect(r.code).toBe(1);
    expect(r.out).toContain('gist is 3 sentences');
  });

  it.each([
    ['a malformed line', 'source:: query_by_date_range 5 days'],
    ['no days', 'source:: query_by_date_range 20250106-20250110; days 0; blocks 0; top none'],
    ['a malformed top list', 'source:: query_by_date_range 20250106-20250110; days 5; blocks 250; top Project Atlas'],
    ['a range that ends before it starts', 'source:: query_by_date_range 20250110-20250106; days 5; blocks 250; top none'],
  ])('fails %s', (_label, source) => {
    const r = run('Weekly 2025-01-06.md', page(WEEKLY_TAGS, source));
    expect(r.code).toBe(1);
  });

  it('fails a weekly source range that is not the page\'s week', () => {
    const r = run('Weekly 2025-01-13.md', page(WEEKLY_TAGS, WEEKLY_SOURCE));
    expect(r.code).toBe(1);
    expect(r.out).toContain('page is for the week of 20250113');
  });

  it('fails a monthly source range outside the month', () => {
    const r = run('Monthly 2025-02.md', page('tags:: [[Monthly Summary]]', MONTHLY_SOURCE, '- **Month**: A made-up month.'));
    expect(r.code).toBe(1);
    expect(r.out).toContain('not inside the month 202502');
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
