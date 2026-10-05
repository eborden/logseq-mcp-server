import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync } from 'fs';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';

// ADR-0005 (datalog-only-no-feature-flags, #96): one implementation per tool and
// no rollout flags. The removed dual setup kept `<tool>-http.ts` and
// `<tool>-datalog.ts` side by side behind a router that read `features.useDatalog`
// from the config file. These tests fail if either comes back. Reversing that
// needs an ADR that supersedes ADR-0005, which would update or remove this test.

const TOOLS_DIR = fileURLToPath(new URL('./tools/', import.meta.url));

/** Files that look like one half of a dual implementation (tests included). */
function dualImplementationFiles(names: string[]): string[] {
  return names.filter(name => /-(?:http|datalog)(?:\.[a-z0-9-]+)*\.ts$/i.test(name));
}

describe('ADR-0005: one implementation per tool', () => {
  it('flags -http and -datalog variants, and their tests', () => {
    expect(
      dualImplementationFiles([
        'search-blocks.ts',
        'search-blocks.test.ts',
        'search-blocks-http.ts',
        'search-blocks-datalog.ts',
        'search-blocks-datalog.test.ts',
        'Get-Page-HTTP.ts',
      ]),
    ).toEqual([
      'search-blocks-http.ts',
      'search-blocks-datalog.ts',
      'search-blocks-datalog.test.ts',
      'Get-Page-HTTP.ts',
    ]);
  });

  it('src/tools/ has no *-http.ts or *-datalog.ts file', () => {
    const names = readdirSync(TOOLS_DIR, { recursive: true }).map(String);
    expect(names.length).toBeGreaterThan(0);
    expect(dualImplementationFiles(names)).toEqual([]);
  });
});

describe('ADR-0005: the config has no feature-flag section', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `logseq-mcp-adr-0005-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    path = join(dir, 'config.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const load = async (config: Record<string, unknown>) => {
    await writeFile(path, JSON.stringify(config));
    return loadConfig(path);
  };

  it('returns exactly apiUrl and authToken when nothing optional is set', async () => {
    const config = await load({ authToken: 'test-token' });
    expect(Object.keys(config).sort()).toEqual(['apiUrl', 'authToken']);
  });

  it('returns exactly apiUrl, authToken, timeoutMs and tips when all are set', async () => {
    const config = await load({ apiUrl: 'http://localhost:12315', authToken: 'test-token', timeoutMs: 5000, tips: false });
    expect(Object.keys(config).sort()).toEqual(['apiUrl', 'authToken', 'timeoutMs', 'tips']);
  });

  it('drops a features section and any other unknown key', async () => {
    const config = await load({
      authToken: 'test-token',
      features: { useDatalog: true },
      useDatalog: true,
      experimental: true,
    });
    expect(Object.keys(config).sort()).toEqual(['apiUrl', 'authToken']);
  });
});
