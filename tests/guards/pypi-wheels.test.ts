import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

// The wheel builder of ADR-0036 (scripts/pypi/build_wheels.py). Its own tests are Python (`unittest`), and they are
// run here so the existing guard job holds them: the runner has python3, and the builder needs nothing installed.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PYPI_DIR = join(ROOT, 'scripts', 'pypi');
const BUILDER = readFileSync(join(PYPI_DIR, 'build_wheels.py'), 'utf-8');

// What build_wheels.py may import. All of it is the standard library, so the release job needs no install step, and a
// package added here is a new dependency that ADR-0036 and CLAUDE.md say to vet first. Change this list only with that.
const STANDARD_LIBRARY_IMPORTS = ['__future__', 'argparse', 'base64', 'hashlib', 're', 'struct', 'sys', 'zipfile', 'pathlib'];

/** The top-level module of every `import x` and `from x import y` line at the left margin or indented inside a function. */
function importedModules(source: string): string[] {
  const modules = new Set<string>();
  for (const line of source.split('\n')) {
    const match = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import\b|import\s+([A-Za-z_][\w., ]*))/.exec(line);
    if (!match) continue;
    for (const name of (match[1] ?? match[2]).split(',')) modules.add(name.trim().split('.')[0]);
  }
  return [...modules].sort();
}

describe('ADR-0036: the PyPI wheel builder', () => {
  it('passes its own tests (python3 -I -m unittest discover -s scripts/pypi)', () => {
    // -B: no bytecode files in the working tree
    const run = spawnSync('python3', ['-B', '-I', '-m', 'unittest', 'discover', '-s', PYPI_DIR], { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 });
    expect(run.error, 'python3 must be on PATH').toBeUndefined();
    expect(run.stderr + run.stdout).toMatch(/\nOK\b/);
    expect(run.status).toBe(0);
  });

  it('imports only the standard library, so the release job installs nothing', () => {
    expect(importedModules(BUILDER)).toEqual([...STANDARD_LIBRARY_IMPORTS].sort());
  });

  it('does not import dynamically or run other programs, which the import list above would not see', () => {
    const code = BUILDER.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
    expect(code).not.toMatch(/__import__|importlib|\bexec\s*\(|\beval\s*\(|\bsubprocess\b|\bos\.system\b|\bctypes\b/);
  });

  it('reads the imports of a source it is given', () => {
    expect(importedModules('import os, sys\nfrom pathlib import Path\n  import requests.adapters\n# import comment\nx = "import fake"\n')).toEqual(['os', 'pathlib', 'requests', 'sys']);
  });

  it('keeps the builder and its tests together in scripts/pypi', () => {
    expect(readdirSync(PYPI_DIR).filter(name => name.endsWith('.py')).sort()).toEqual(['build_wheels.py', 'test_build_wheels.py']);
  });

  it('has a long description for PyPI that points at this repository and promises no Windows wheel', () => {
    const readme = readFileSync(join(ROOT, 'pypi', 'README.md'), 'utf-8');
    expect(readme).toContain('https://github.com/eborden/logseq-mcp-server');
    expect(readme).toMatch(/no Windows wheel/);
  });
});
