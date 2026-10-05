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

  it('declares a Node floor that has global fetch and AbortSignal.timeout', () => {
    expect(pkg.engines.node).toBe('>=18');
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
