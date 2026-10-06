import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { copyGraphDir } from '../scripts/logseq-instance/copy-graph.js';
import { InstanceError } from '../scripts/logseq-instance/instance.js';

// The real graph copy behind `start` (#151), on a temporary folder. The fake-fs tests in
// logseq-instance.test.ts reimplement copyDir, so only this file checks the fs.cp wiring.

let root: string;
let from: string;
let to: string;

async function put(path: string, data: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, data);
}

/** Every entry under `dir`, relative and `/`-separated, with its kind as lstat sees it. */
async function tree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  const kinds = await Promise.all(
    entries.map(async entry => {
      const stats = await lstat(join(dir, entry));
      const kind = stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'dir' : 'file';
      return `${entry.split('\\').join('/')} ${kind}`;
    }),
  );
  return kinds.sort();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'logseq-instance-copy-'));
  from = join(root, 'source');
  to = join(root, 'instance', 'graph');
  await mkdir(join(root, 'instance'));
  await put(join(from, 'pages', 'a.md'), '- a\n');
  await put(join(from, 'logseq', 'config.edn'), '{}\n');
  await put(join(from, 'logseq', 'bak', 'pages', 'a.md'), 'backup\n');
  await put(join(from, 'logseq', 'bakery', 'kept.md'), 'kept\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('copyGraphDir', () => {
  it('copies the graph without logseq/bak, keeping logseq/bakery', async () => {
    await copyGraphDir(from, to);

    expect(await tree(to)).toEqual([
      'logseq dir',
      'logseq/bakery dir',
      'logseq/bakery/kept.md file',
      'logseq/config.edn file',
      'pages dir',
      'pages/a.md file',
    ]);
    expect(await readFile(join(from, 'logseq', 'bak', 'pages', 'a.md'), 'utf-8')).toBe('backup\n');
  });

  it('copies a linked file and a linked directory as real ones, so nothing in the copy leads back', async () => {
    await put(join(root, 'elsewhere', 'linked.md'), '- linked\n');
    await put(join(root, 'elsewhere', 'dir', 'inner.md'), '- inner\n');
    await symlink(join(root, 'elsewhere', 'linked.md'), join(from, 'pages', 'linked.md'));
    await symlink(join(root, 'elsewhere', 'dir'), join(from, 'journals'));

    await copyGraphDir(from, to);

    const entries = await tree(to);
    expect(entries).toContain('pages/linked.md file');
    expect(entries).toContain('journals dir');
    expect(entries).toContain('journals/inner.md file');
    expect(entries.filter(entry => entry.endsWith(' link'))).toEqual([]);
    expect(await readFile(join(to, 'journals', 'inner.md'), 'utf-8')).toBe('- inner\n');
  });

  it('fails on a dangling link with an InstanceError naming the source, and leaves no partial copy', async () => {
    await symlink(join(root, 'missing.md'), join(from, 'pages', 'dangling.md'));

    const failure = copyGraphDir(from, to);
    await expect(failure).rejects.toThrow(InstanceError);
    await expect(failure).rejects.toThrow(`could not copy the graph ${from} to ${to}`);
    await expect(failure).rejects.toThrow(/dangling\.md|missing\.md/);
    await expect(lstat(to)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to copy over an existing folder and leaves it as it is', async () => {
    await put(join(to, 'pages', 'a.md'), '- old\n');
    await expect(copyGraphDir(from, to)).rejects.toThrow(`${to} already exists`);
    expect(await readFile(join(to, 'pages', 'a.md'), 'utf-8')).toBe('- old\n');
  });
});
