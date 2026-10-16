import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

/**
 * CLAUDE.md keeps its Skills table honest and stays small (#609, part of #598).
 *
 * CLAUDE.md is loaded every turn, so procedures moved out of it into repo skills (`.claude/skills/<name>/SKILL.md`).
 * A skill nobody knows about does nothing, and a rulebook that grows back defeats the move. Three checks:
 *   1. every directory in `.claude/skills/` has a row in the "## Skills" table of CLAUDE.md (first cell the skill's
 *      name in backticks, a non-empty "use when" cell), and every row names a skill that exists;
 *   2. every skill's `SKILL.md` description starts "Use when". Only the pinned shipped plugin skill is exempt (see
 *      SHIPPED_PLUGIN_SKILLS): it is the symlink `.claude/skills/logseq-skills` that resolves to `skills/logseq-skills`,
 *      whose description is checked by the routing eval and ADR-0018, and it says what it
 *      does before when to use it. It still needs its row. Any other skill, symlinked or not, must satisfy the rule;
 *   3. CLAUDE.md is at most CLAUDE_MD_MAX_BYTES bytes.
 *
 * The ceiling only goes down. Set it to the size rounded up modestly, and lower it when the file shrinks: the test
 * fails when the ceiling is more than CEILING_SLACK_BYTES above the size, so a shrunk file cannot keep a high ceiling.
 * Raising it needs the maintainer's OK, like loosening any guard (move the new text into a skill or `docs/` instead).
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLAUDE_MD = join(ROOT, 'CLAUDE.md');
const SKILLS_DIR = join(ROOT, '.claude/skills');

/** The most bytes CLAUDE.md may hold. Only ever lowered. */
const CLAUDE_MD_MAX_BYTES = 25_000;

/** How far above the actual size the ceiling may sit, so it follows the file down. */
const CEILING_SLACK_BYTES = 1_000;

const SKILLS_HEADING = '## Skills';

/** The shipped plugin skills (`skills/<name>`) that `.claude/skills/<name>` may symlink to. Adding one is a deliberate edit. */
const SHIPPED_PLUGIN_SKILLS: ReadonlySet<string> = new Set(['logseq-skills']);

interface Skill {
  readonly name: string;
  /** True only for a pinned shipped plugin skill, symlinked to its directory under `skills/` (see isShippedPlugin). */
  readonly shipped: boolean;
  /** The text of SKILL.md. */
  readonly text: string;
}

/** The text under a `## ` heading, up to the next `## ` heading or a `---` rule. */
function sectionOf(markdown: string, heading: string): string {
  const start = markdown.split('\n').findIndex(line => line === heading);
  if (start === -1) return '';
  const lines: string[] = [];
  for (const line of markdown.split('\n').slice(start + 1)) {
    if (line.startsWith('## ') || line === '---') break;
    lines.push(line);
  }
  return lines.join('\n');
}

/** The rows of the Skills table as [skill name, use-when text]. A row is `| `name` | use when | ... |`. */
function tableRows(section: string): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const line of section.split('\n')) {
    const cells = line.split('|').map(cell => cell.trim());
    // A row starts and ends with `|`, so the first and last cells are empty.
    if (cells.length < 4 || cells[0] !== '') continue;
    const named = cells[1].match(/^`([^`]+)`$/);
    if (named) rows.push([named[1], cells[2]]);
  }
  return rows;
}

/** The `description` of a SKILL.md frontmatter, or an error text when it is missing or in a form not read here. */
function descriptionOf(skillMd: string): { description: string } | { error: string } {
  const front = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!front) return { error: 'no frontmatter' };
  const line = front[1].split('\n').find(l => l.startsWith('description:'));
  if (line === undefined) return { error: 'no description in the frontmatter' };
  const value = line.slice('description:'.length).trim();
  if (value === '' || value === '>' || value === '|') {
    return { error: 'description is empty or a block scalar; write it on one line' };
  }
  if (value.startsWith("'")) {
    // YAML single quotes: `''` is a quote, the closing quote is the last character.
    if (!value.endsWith("'") || value.length < 2) return { error: 'unterminated single-quoted description' };
    return { description: value.slice(1, -1).replace(/''/g, "'") };
  }
  if (value.startsWith('"')) {
    try {
      return { description: JSON.parse(value) as string };
    } catch {
      return { error: 'unreadable double-quoted description' };
    }
  }
  return { description: value };
}

/** Every problem with the skills and the CLAUDE.md that names them, one line each. Empty when sound. */
function skillViolations(claudeMd: string, skills: readonly Skill[]): string[] {
  const problems: string[] = [];
  const section = sectionOf(claudeMd, SKILLS_HEADING);
  if (section === '') problems.push(`CLAUDE.md has no "${SKILLS_HEADING}" section`);
  const rows = tableRows(section);
  const names = new Set(skills.map(s => s.name));

  for (const skill of skills) {
    const row = rows.find(([name]) => name === skill.name);
    if (!row) problems.push(`skill "${skill.name}" has no row in the CLAUDE.md Skills table`);
    else if (row[1] === '') problems.push(`skill "${skill.name}" has a Skills row with no "use when" text`);

    if (skill.shipped) continue;
    const read = descriptionOf(skill.text);
    if ('error' in read) problems.push(`skill "${skill.name}": ${read.error}`);
    else if (!read.description.startsWith('Use when')) {
      problems.push(`skill "${skill.name}": the description must start "Use when", not "${read.description.slice(0, 30)}"`);
    }
  }
  for (const [name] of rows) {
    if (!names.has(name)) problems.push(`the Skills table names "${name}", which is not in .claude/skills/`);
  }
  return problems;
}

/** Whether a skill entry is the one exempt shape: a pinned name, a symlink, resolving to `skills/<name>` in the repo. */
function isShippedPlugin(name: string, isSymlink: boolean, resolved: string | undefined, shippedDir: string): boolean {
  return SHIPPED_PLUGIN_SKILLS.has(name) && isSymlink && resolved !== undefined && resolved === shippedDir;
}

const resolveOrUndefined = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

/** The skills under `.claude/skills/`, read from disk. */
function readSkills(): Skill[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => ({
      name: entry.name,
      shipped: isShippedPlugin(
        entry.name,
        entry.isSymbolicLink(),
        resolveOrUndefined(join(SKILLS_DIR, entry.name)),
        resolveOrUndefined(join(ROOT, 'skills', entry.name)) ?? '',
      ),
      text: readFileSync(join(SKILLS_DIR, entry.name, 'SKILL.md'), 'utf8'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const claudeMd = readFileSync(CLAUDE_MD, 'utf8');
const claudeBytes = Buffer.byteLength(claudeMd, 'utf8');

describe('CLAUDE.md names every skill (#609)', () => {
  it('has a Skills row for each skill, and a "Use when" description on each repo skill', () => {
    expect(skillViolations(claudeMd, readSkills())).toEqual([]);
  });

  it('finds at least the repo skills this guard was written for', () => {
    // A guard over an empty directory would pass on nothing.
    expect(readSkills().length).toBeGreaterThanOrEqual(8);
  });
});

describe('CLAUDE.md stays under its size ceiling (#609)', () => {
  it(`is at most ${CLAUDE_MD_MAX_BYTES} bytes (it is ${claudeBytes}); move new text into a skill or docs/, do not raise this`, () => {
    expect(claudeBytes).toBeLessThanOrEqual(CLAUDE_MD_MAX_BYTES);
  });

  it(`has a ceiling within ${CEILING_SLACK_BYTES} bytes of its size, so the ceiling follows the file down`, () => {
    expect(CLAUDE_MD_MAX_BYTES - claudeBytes).toBeLessThan(CEILING_SLACK_BYTES);
  });
});

describe('the skill check can fail (#609)', () => {
  const table = [
    '## Skills',
    '',
    '| Skill | Use when | Stays |',
    '|---|---|---|',
    '| `alpha` | Doing alpha | x |',
    '| `beta` | Doing beta | y |',
    '',
    '---',
  ].join('\n');
  const skill = (name: string, description: string): Skill => ({
    name,
    shipped: false,
    text: `---\nname: ${name}\ndescription: '${description}'\n---\n\nBody\n`,
  });
  const good = [skill('alpha', 'Use when doing alpha.'), skill('beta', "Use when it's beta.")];

  it('passes a sound table', () => {
    expect(skillViolations(table, good)).toEqual([]);
  });

  it('fails a skill with no row', () => {
    expect(skillViolations(table, [...good, skill('gamma', 'Use when gamma.')])).toEqual([
      'skill "gamma" has no row in the CLAUDE.md Skills table',
    ]);
  });

  it('fails a row for a skill that is gone', () => {
    expect(skillViolations(table, [good[0]])).toEqual([
      'the Skills table names "beta", which is not in .claude/skills/',
    ]);
  });

  it('fails a row with no "use when" text', () => {
    const empty = table.replace('| Doing alpha |', '|  |');
    expect(skillViolations(empty, good)).toEqual(['skill "alpha" has a Skills row with no "use when" text']);
  });

  it('fails a description that does not start "Use when"', () => {
    const bad = [skill('alpha', 'Does alpha when you want.'), good[1]];
    expect(skillViolations(table, bad)).toEqual([
      'skill "alpha": the description must start "Use when", not "Does alpha when you want."',
    ]);
  });

  it('fails a missing Skills section and a description it cannot read', () => {
    expect(skillViolations('# Title\n', [])).toEqual(['CLAUDE.md has no "## Skills" section']);
    const block: Skill = { name: 'alpha', shipped: false, text: '---\nname: alpha\ndescription: >\n  Use when x\n---\n' };
    expect(skillViolations(table, [block, good[1]])).toEqual([
      'skill "alpha": description is empty or a block scalar; write it on one line',
    ]);
  });

  it('exempts a shipped skill from the description rule', () => {
    const shipped: Skill = { name: 'alpha', shipped: true, text: "---\ndescription: 'Query things. Use when asked.'\n---\n" };
    expect(skillViolations(table, [shipped, good[1]])).toEqual([]);
  });

  it('exempts only the pinned name, as a symlink that resolves to skills/<name>', () => {
    const dir = '/repo/skills/logseq-skills';
    expect(isShippedPlugin('logseq-skills', true, dir, dir)).toBe(true);
    // Any other name, even a symlink to a directory under skills/, is held to "Use when".
    expect(isShippedPlugin('datalog-queries', true, '/repo/skills/datalog-queries', '/repo/skills/datalog-queries')).toBe(false);
    // The pinned name as a plain directory, or a symlink that resolves elsewhere or not at all, is held to it too.
    expect(isShippedPlugin('logseq-skills', false, dir, dir)).toBe(false);
    expect(isShippedPlugin('logseq-skills', true, '/elsewhere/logseq-skills', dir)).toBe(false);
    expect(isShippedPlugin('logseq-skills', true, undefined, dir)).toBe(false);
  });

  it('reads single-quoted descriptions with doubled quotes', () => {
    expect(descriptionOf("---\ndescription: 'Use when it''s there'\n---\n")).toEqual({ description: "Use when it's there" });
  });
});
