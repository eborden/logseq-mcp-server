import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

describe('package.json publish fields (#46)', () => {
  it('exposes a bin for npx that points at the built entry', () => {
    expect(pkg.bin['logseq-mcp-server']).toBe('dist/index.js');
    expect(pkg.main).toBe('dist/index.js');
  });

  it('builds before publishing and ships the built output', () => {
    expect(pkg.scripts.prepublishOnly).toBe('npm run build');
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'README.md', 'LICENSE']));
  });

  it('declares a Node floor that matches the dev toolchain (vite 7) and has global fetch and AbortSignal.timeout', () => {
    expect(pkg.engines.node).toBe('>=22.12.0');
  });

  it('carries the metadata npm shows', () => {
    expect(pkg.license).toBe('MIT');
    const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf-8');
    expect(license.split('\n')[0]).toBe('MIT License');
    expect(pkg.repository.url).toContain('github.com/eborden/logseq-mcp-server');
    expect(pkg.keywords.length).toBeGreaterThan(0);
    expect(pkg.description).toBeTruthy();
  });
});

describe('zod pin (#60)', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf-8'));
  // Copies the server ships and loads. A devDependency may bring its own, and does: Stryker's
  // mutation-server-protocol takes zod 4 and npm nests it (#204). It is dev-only (`dev: true`
  // in the lockfile), never installed for a consumer and never loaded by the server.
  const zodCopies = Object.entries(lock.packages as Record<string, { version: string; dev?: boolean }>).filter(
    ([path, entry]) => (path === 'node_modules/zod' || path.endsWith('/node_modules/zod')) && !entry.dev
  );

  it('installs one copy of zod, shared with the MCP SDK, at the pinned version', () => {
    // zod is pinned exactly and the SDK takes a caret range. If an SDK upgrade
    // needs a zod the pin doesn't satisfy, npm nests a second copy instead of
    // failing. Bump the pin together with the SDK, then check `npm ls zod`.
    expect(zodCopies.map(([path]) => path)).toEqual(['node_modules/zod']);
    expect(zodCopies[0][1].version).toBe(pkg.dependencies.zod);
  });
});
