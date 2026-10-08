import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import {
  assertNotPersonalLogseq,
  FixtureConfigError,
  HOW_TO_RUN,
  instanceConfigPath,
  resolveFixtureConfigPath,
} from '../tests/integration/helpers/instance-config.js';

// The integration tests never contact the maintainer's personal LogSeq (#90). These guards keep it
// that way: the config resolver has no fallback to ~/.logseq-mcp/config.json and refuses port 12315,
// and every suite connects through connectFixture, which uses that resolver.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const integrationDir = join(repoRoot, 'tests', 'integration');

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return testFiles(path);
    return name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('resolveFixtureConfigPath', () => {
  const root = '/repo';
  const none = () => false;

  it('uses LOGSEQ_MCP_CONFIG when it is set', () => {
    expect(resolveFixtureConfigPath({ LOGSEQ_MCP_CONFIG: '/tmp/a.json' }, none, root)).toBe('/tmp/a.json');
    expect(resolveFixtureConfigPath({ LOGSEQ_MCP_CONFIG: ' /tmp/a.json ' }, () => true, root)).toBe('/tmp/a.json');
  });

  it('uses the instance config when the variable is unset or blank and the instance is running', () => {
    const exists = (path: string) => path === instanceConfigPath(root);
    expect(resolveFixtureConfigPath({}, exists, root)).toBe('/repo/.logseq-instance/config.json');
    expect(resolveFixtureConfigPath({ LOGSEQ_MCP_CONFIG: '  ' }, exists, root)).toBe('/repo/.logseq-instance/config.json');
  });

  it('never falls back to ~/.logseq-mcp/config.json: with neither, it throws with the run steps', () => {
    const asked: string[] = [];
    const error = (() => {
      try {
        resolveFixtureConfigPath({ HOME: '/home/alice' }, path => (asked.push(path), false), root);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(FixtureConfigError);
    expect(error!.message).toContain('never fall back to ~/.logseq-mcp/config.json');
    expect(error!.message).toContain(HOW_TO_RUN);
    expect(asked).toEqual(['/repo/.logseq-instance/config.json']);
  });

  it('rejects a relative LOGSEQ_MCP_CONFIG', () => {
    expect(() => resolveFixtureConfigPath({ LOGSEQ_MCP_CONFIG: 'config.json' }, none, root)).toThrow(FixtureConfigError);
  });
});

describe('assertNotPersonalLogseq', () => {
  it('refuses port 12315, the default port of a personal LogSeq', () => {
    for (const url of ['http://127.0.0.1:12315', 'http://localhost:12315/', 'http://127.0.0.1:12315/api']) {
      expect(() => assertNotPersonalLogseq(url), url).toThrow(/port 12315/);
    }
  });

  it('accepts the instance ports and any other port', () => {
    for (const url of ['http://127.0.0.1:12320', 'http://127.0.0.1:12391', 'http://127.0.0.1:12399', 'http://127.0.0.1:8080']) {
      expect(() => assertNotPersonalLogseq(url), url).not.toThrow();
    }
  });

  it('refuses an apiUrl that is not a URL', () => {
    expect(() => assertNotPersonalLogseq('not a url')).toThrow(FixtureConfigError);
  });
});

describe('scripts/probe-constraints.ts', () => {
  const source = readFileSync(join(repoRoot, 'scripts', 'probe-constraints.ts'), 'utf-8');
  // Comment lines hold a manual-probe snippet with a client of its own; only the code counts
  const code = source.split('\n').filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n');

  it('resolves its config with resolveFixtureConfigPath, never the default path', () => {
    expect(code).toMatch(/loadConfig\(resolveFixtureConfigPath\(\)\)/);
    expect(code).not.toMatch(/\bhomedir\b|\.logseq-mcp\b|\bresolveConfigPath\b/);
  });

  it('refuses a personal LogSeq before it builds a client', () => {
    const load = code.indexOf('loadConfig(resolveFixtureConfigPath())');
    const refuse = code.indexOf('assertNotPersonalLogseq(config.apiUrl)');
    const client = code.indexOf('new LogseqClient(');
    expect(load).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(load);
    expect(client).toBeGreaterThan(refuse);
    expect(code.split('new LogseqClient(').length - 1, 'one client, built after the check').toBe(1);
  });

  it('has a manual-probe helper that loads the same guarded config', () => {
    const start = source.indexOf('npx tsx --input-type=module');
    expect(start, 'the helper snippet (npx tsx --input-type=module) moved or was reworded').toBeGreaterThan(-1);
    const end = source.indexOf('} }"', start);
    expect(end, "the helper's closing `} }\"` is missing after its start").toBeGreaterThan(start);
    const helper = source.slice(start, end);
    const load = helper.indexOf('loadConfig(resolveFixtureConfigPath())');
    const refuse = helper.indexOf('assertNotPersonalLogseq(config.apiUrl)');
    const client = helper.indexOf('new LogseqClient(');
    expect(load, 'helper must load its config with resolveFixtureConfigPath').toBeGreaterThan(-1);
    expect(refuse, 'helper must call assertNotPersonalLogseq(config.apiUrl) after loading').toBeGreaterThan(load);
    expect(client, 'helper must build its client after the personal-LogSeq check').toBeGreaterThan(refuse);
    expect(helper, 'helper must not load the default config path').not.toMatch(/\bhomedir\b|\.logseq-mcp\b|\bresolveConfigPath\b/);
  });
});

describe('integration suites', () => {
  const files = testFiles(integrationDir);

  it('are found', () => {
    expect(files.length).toBeGreaterThanOrEqual(21);
  });

  it.each(files.map(path => [relative(repoRoot, path), path]))('%s connects through connectFixture', (_label, path) => {
    const source = readFileSync(path, 'utf-8');
    expect(source).toMatch(/import \{[^}]*\bconnectFixture\b[^}]*\} from '\.{1,2}\/(\.\.\/)?helpers\/fixture-client\.js'/);
    expect(source).toMatch(/\bawait connectFixture\(\)/);
  });

  it.each(files.map(path => [relative(repoRoot, path), path]))('%s loads no config of its own', (_label, path) => {
    const source = readFileSync(path, 'utf-8');
    for (const pattern of [/\bhomedir\b/, /\.logseq-mcp\b/, /\bloadConfig\(/, /\bresolveConfigPath\b/, /\brequireFixtureGraph\(/]) {
      expect(source, String(pattern)).not.toMatch(pattern);
    }
  });
});

// A suite that imports a tool's function from src/tools/, or createServer, runs the TypeScript server
// even when LOGSEQ_MCP_SERVER=rust, and nothing says so (#352). The helpers take the same names.
describe('integration suites reach the tools through the helpers', () => {
  const helperSource = readFileSync(join(integrationDir, 'helpers', 'tools.ts'), 'utf-8');
  const helperNames = new Set([...helperSource.matchAll(/^export const (\w+)/gm)].map(match => match[1]));
  const files = testFiles(integrationDir);

  /** Names a source imports from the module paths that match `from`, as written (`as` renames dropped). */
  function importedFrom(source: string, from: RegExp): string[] {
    return [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)]
      .filter(match => from.test(match[2]))
      .flatMap(match => match[1].split(',').map(name => name.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '')))
      .filter(Boolean);
  }

  it('finds the helper functions', () => {
    expect(helperNames.size).toBeGreaterThanOrEqual(19);
    expect(helperNames.has('getPage')).toBe(true);
  });

  it.each(files.map(path => [relative(repoRoot, path), path]))('%s imports no tool function from src/tools/', (_label, path) => {
    const source = readFileSync(path, 'utf-8');
    const direct = importedFrom(source, /\/src\/tools\/[\w-]+\.js$/).filter(name => helperNames.has(name));
    expect(direct, 'import these from helpers/tools.js').toEqual([]);
  });

  it.each(files.map(path => [relative(repoRoot, path), path]))('%s does not build the TypeScript server itself', (_label, path) => {
    const source = readFileSync(path, 'utf-8');
    expect(importedFrom(source, /\/src\/index\.js$/), 'use connectMcp from helpers/server-under-test.js').not.toContain('createServer');
  });
});
