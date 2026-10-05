import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

// ADR-0018 (ship-as-claude-code-plugin, #96): the repo is a Claude Code plugin and
// its own marketplace. Skills live in the real directory skills/logseq-skills/,
// .claude/skills/logseq-skills is a relative symlink to it (not the other way
// around, so a plugin install copies the real content), the MCP server is declared
// inline in plugin.json rather than in a root .mcp.json, and skills name tools by
// bare name so they work under any host prefix.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILL_DIR = join(ROOT, 'skills', 'logseq-skills');
const SKILL_LINK = join(ROOT, '.claude', 'skills', 'logseq-skills');
const readJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf-8'));

/** Every file under a directory, as paths relative to the repo root. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(ROOT, join(entry.parentPath, entry.name)));
}

/**
 * Lines that name a tool with an `mcp__` prefix. SKILL.md's "Tool names" line is
 * the one allowed place: it explains that the host may add a prefix.
 */
function hardCodedPrefixes(files: { path: string; text: string }[]): string[] {
  return files.flatMap(({ path, text }) =>
    text
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.includes('mcp__'))
      .filter(({ line }) => !(path === join('skills', 'logseq-skills', 'SKILL.md') && line.startsWith('**Tool names:**')))
      .map(({ n }) => `${path}:${n}`),
  );
}

describe('ADR-0018: skills layout', () => {
  it('skills/logseq-skills is a real directory with SKILL.md', () => {
    expect(lstatSync(SKILL_DIR).isDirectory()).toBe(true);
    expect(lstatSync(join(SKILL_DIR, 'SKILL.md')).isFile()).toBe(true);
  });

  it('.claude/skills/logseq-skills is a relative symlink to it', () => {
    expect(lstatSync(SKILL_LINK).isSymbolicLink()).toBe(true);
    expect(readlinkSync(SKILL_LINK)).toBe(join('..', '..', 'skills', 'logseq-skills'));
    expect(realpathSync(SKILL_LINK)).toBe(realpathSync(SKILL_DIR));
  });
});

describe('ADR-0018: plugin manifest', () => {
  const plugin = readJson('.claude-plugin/plugin.json');

  it('plugin.json reads skills from ./skills/', () => {
    expect(plugin.skills).toEqual(['./skills/']);
  });

  it('plugin.json declares the MCP server inline', () => {
    const servers = Object.values(plugin.mcpServers ?? {}) as { command?: unknown }[];
    expect(servers.length).toBeGreaterThan(0);
    for (const server of servers) expect(typeof server.command).toBe('string');
  });

  it('the marketplace entry points at the repo root', () => {
    const marketplace = readJson('.claude-plugin/marketplace.json');
    expect(marketplace.plugins.map((p: { name: string; source: string }) => [p.name, p.source])).toEqual([
      [plugin.name, './'],
    ]);
  });

  it('there is no root .mcp.json in the repo', () => {
    // Tracked files only, so a local untracked .mcp.json doesn't fail the test. Needs git (CI has it).
    const tracked = execFileSync('git', ['ls-files', '--', '.mcp.json'], { cwd: ROOT, encoding: 'utf-8' });
    expect(tracked.trim()).toBe('');
  });
});

describe('ADR-0018: skills name tools by bare name', () => {
  it('flags a prefixed tool name outside the explanatory line', () => {
    const skillPath = join('skills', 'logseq-skills', 'SKILL.md');
    expect(
      hardCodedPrefixes([
        { path: skillPath, text: '**Tool names:** a host may show `mcp__logseq__logseq_get_page`.\nCall `logseq_get_page`.' },
        { path: skillPath, text: 'Call `mcp__logseq__logseq_get_page`.' },
        { path: join('skills', 'logseq-skills', 'skills', 'weekly-summary.md'), text: '**Tool names:** `mcp__x`' },
      ]),
    ).toEqual([`${skillPath}:1`, join('skills', 'logseq-skills', 'skills', 'weekly-summary.md') + ':1']);
  });

  it('no skill file hard-codes an mcp__ tool prefix', () => {
    const files = filesUnder(join(ROOT, 'skills')).map(path => ({ path, text: readFileSync(join(ROOT, path), 'utf-8') }));
    expect(files.length).toBeGreaterThan(0);
    expect(hardCodedPrefixes(files)).toEqual([]);
  });

  it("SKILL.md keeps the line that explains the host's prefix", () => {
    const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8');
    expect(skill.split('\n').filter(line => line.startsWith('**Tool names:**'))).toHaveLength(1);
  });
});
