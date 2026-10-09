import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));

// package.json is repository tooling, not a package (ADR-0035, #419): the server is the Rust binary, released on GitHub
// Releases and started by scripts/logseq-mcp-server.sh. The npm name `logseq-mcp-server` belongs to another
// maintainer, so nothing here may publish under it. The file keeps its name because ADR-0022 (engines.node) and
// ADR-0023 (licence) cite it in their enforcement lines.
describe('package.json is repository tooling (ADR-0035)', () => {
  it('is private, so an npm publish by accident fails', () => {
    expect(pkg.private).toBe(true);
  });

  it('has none of the retired TypeScript server\'s packaging: no bin, main, files, build or prepublishOnly', () => {
    for (const field of ['bin', 'main', 'files', 'exports', 'types']) {
      expect(pkg, `package.json has "${field}"`).not.toHaveProperty(field);
    }
    for (const script of ['build', 'prepublish', 'prepublishOnly', 'prepack', 'prepare', 'publish', 'postpublish']) {
      expect(pkg.scripts, `package.json has the script "${script}"`).not.toHaveProperty(script);
    }
  });

  it('names no dist path anywhere (the TypeScript build output is gone)', () => {
    expect(JSON.stringify(pkg)).not.toMatch(/\bdist\b/);
  });

  it('the lockfile root records no bin either', () => {
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf-8'));
    expect(lock.packages['']).not.toHaveProperty('bin');
  });
});

describe('package.json carries the repository metadata', () => {
  it('declares a Node floor that matches the dev toolchain (vite 7) and has global fetch and AbortSignal.timeout', () => {
    expect(pkg.engines.node).toBe('>=22.12.0');
  });

  it('is MIT, with the LICENSE file to match, and names the repository', () => {
    expect(pkg.license).toBe('MIT');
    const license = readFileSync(new URL('../../LICENSE', import.meta.url), 'utf-8');
    expect(license.split('\n')[0]).toBe('MIT License');
    expect(pkg.repository.url).toContain('github.com/eborden/logseq-mcp-server');
    expect(pkg.keywords.length).toBeGreaterThan(0);
    expect(pkg.description).toBeTruthy();
  });
});

describe('zod pin (#60)', () => {
  const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf-8'));
  // The tooling (the MCP SDK the harness and the integration suites use, and the per-worktree instance's
  // file schema) loads zod. It is a devDependency now that the TypeScript server, which shipped it, is retired (#356).
  const zodCopies = Object.entries(lock.packages as Record<string, { version: string }>).filter(
    ([path]) => path === 'node_modules/zod' || path.endsWith('/node_modules/zod')
  );

  it('installs one copy of zod, shared with the MCP SDK, at the pinned version', () => {
    // zod is pinned exactly and the SDK takes a caret range. If an SDK upgrade
    // needs a zod the pin doesn't satisfy, npm nests a second copy instead of
    // failing. Bump the pin together with the SDK, then check `npm ls zod`.
    expect(zodCopies.map(([path]) => path)).toEqual(['node_modules/zod']);
    expect(zodCopies[0][1].version).toBe(pkg.devDependencies.zod);
  });
});
